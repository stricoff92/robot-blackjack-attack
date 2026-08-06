import './game-view.css'

import { readDebugFlags } from '../game/debug'
import type { Card, Suit } from '../game/deck'
import { POWERUPS } from '../game/powerups'
import { canDouble, canForcedSplit, canMulligan, canReturn, canSplit, handNet, type PlayerHand, type Round, type RoundRules } from '../game/round'
import { handReward } from '../game/rewards'
import { DESTROY_TOKEN, isLastCall, nextBet, powerupCost, tokenMultiplier, TOTAL_DEALERS } from '../game/run'
import { Session, type SessionState } from '../game/session'
import { nextTierLabel, UPGRADE_PATHS, type UpgradePath, type UpgradePathInfo } from '../game/upgrades'
import { getCardSprite, setCardBack } from '../render/card-sprite'
import type { LayeredCanvas } from '../render/canvas'
import { ANALYSIS_STRIKE_MS, drawAnalysis, drawAnalysisMask, drawBustBlock, drawHands, drawMulliganDiscard, drawPeekCard, drawReturnCard, drawShoe, drawShuffle, playerCardCenter, shoeAnchor, SHUFFLE_SPLIT_FRACTION, type RoundResult } from '../render/cards'
import { onChipImageReady } from '../render/chip-sprite'
import { drawChips, drawTableMarkings } from '../render/chips'
import { drawDealer, drawDealerEyeGlow } from '../render/dealer'
import { drawHealthBar } from '../render/health'
import { drawStrikeFx, nexusYellowLight } from '../render/nexus'
import { dealerColors, isRgbDealer } from '../render/palette'
import { Scene, computeLayout, type Layout } from '../render/scene'
import { drawOldDeckShred, drawShred, drawSpawnDeck, SHEET_SLIDE_START } from '../render/spawn'
import { drawTokens, type Point } from '../render/tokens'
import { ChipAnimation } from './chip-animator'
import { CountTicker } from './count-ticker'
import { BustBlockAnimation } from './bust-block-animator'
import { DealAnimation } from './deal-animator'
import { DealerAnimation, HIT_TOTAL_MS, KILL_ARRIVE_MS, KILL_DEATH_LEAD_MS, KILL_DEATH_MS, KILL_DYING_MS, KILL_TOTAL_MS, STRIKE_TRAVEL_MS } from './dealer-animator'
import { HealthAnimation } from './health-animator'
import { SpawnAnimation } from './spawn-animator'
import { MulliganAnimation } from './mulligan-animator'
import { NexusAnimation } from './nexus-animator'
import { PeekFlipAnimation, PEEK_FLIP_MS } from './peek-animator'
import { ReturnAnimation } from './return-animator'
import { TokenAnimation } from './token-animator'
import { createStage, type Stage } from './stage'
import { sfx } from '../audio/sfx'

// The token icon, imported once so Vite fingerprints the URL and the browser
// fetches it a single time on load; every <img> that references it (the token
// counter + each powerup cost pill) then serves from cache.
import powerUrl from '../assets/power.png'
// The choose-upgrade path icons (replace the path name text on each big button).
import detectiveUrl from '../assets/detective.png'
import chipUrl from '../assets/poker-chip.png'

// Path → icon: Sabotage a detective, Payout a chip, Tokens the token icon.
const UPGRADE_ICONS: Record<UpgradePath, string> = {
  antiDealer: detectiveUrl,
  chipEco: chipUrl,
  tokenEco: powerUrl,
}

// Canvas layers, bottom → top. The dealer figure sits between the room ('back')
// and the felt/rail ('table') so the rail overlaps its lower body (and death
// debris) — it reads as standing behind the table. Chips sit ABOVE cards so
// flying chips (deal / payout) pass in front of the cards; the bet chips rest in
// the betting circle well below the cards, so nothing overlaps at rest. The HUD
// (dealer health bar) sits above that. 'fx' carries the nexus laser strike (above
// the table + cards, below the reward tokens that fly up to the counter). The
// 'mask' layer is on top of everything: a darkness that the Analyze projection
// lights through, and the dealer's emissive eye glow (the HTML button/counter
// overlay sits above it, so those stay bright).
const LAYERS = ['back', 'dealer', 'table', 'cards', 'chips', 'hud', 'fx', 'tokens', 'mask'] as const

// When a reward's tokens lift off, relative to the card motion settling
// (anim.animEnd): a hit's token waits a short beat after its card lands, and a
// resolve's winning hands stagger their bursts so splits cascade.
const TOKEN_SPAWN_DELAY = 90
const TOKEN_HAND_STAGGER = 120
// How fast the shredder bed (sample + vacuum) fades once the last card is drawn in —
// kept short so the sound doesn't trail past the visual shred.
const SHRED_FADE_MS = 130
// Spacing between a burst's per-token blips (both the launch shower from the nexus
// and the land shower at the counter) — tight, so several sprites read as a quick
// coin shower rather than a sparse trickle. The counter's roll is matched to the
// land shower's length so the number lands with the last ping (see frame()).
const TOKEN_TONE_STAGGER_MS = 45

// How long a dismissed Analyze reading takes to flicker out.
const ANALYSIS_FADE_MS = 300

// Beat after the won chips collect into the player's stack before the nexus fires
// its damage laser — so the payout finishes landing before the attack, never during.
const LASER_GAP = 180
// Beat after a lost hand's cards settle before the yellow heal beam lifts off (a
// late dealer repairing itself on a win) — so the repair reads as its own moment.
const HEAL_GAP = 220
// Beat after the nexus attack (and any death → walk-in) finishes before the spent
// cards gather back into the deck — the winning hand's final beat.
const GATHER_GAP = 220
// Beat after the returned card merges into the deck before the dealer plays out.
const RETURN_DEAL_DELAY = 220
// How much the dealer-spawn shred overlaps the tail of the walk-in, so the cards
// start being sucked in just as the new dealer arrives (no dead beat between).
const SHRED_ARRIVE_OVERLAP = 140
// A kill that grants an upgrade pick is played in two halves so the selector sits in
// the middle: the dealer is destroyed, then after this beat the upgrade card appears;
// once the player picks, the replacement's walk-in ceremony begins after this beat.
// Dealer gone → upgrade card. Sized to outlast the +40 bounty token, which lifts off
// at the death and flies to the counter (FLY_MS ≈ 665ms) — so the reward animation has
// landed and settled before the selector takes over the screen, plus a breath.
const UPGRADE_REVEAL_LEAD = 1400
const CEREMONY_LEAD = 800 // upgrade picked → new dealer walks in
// A picked upgrade plays a dismiss animation (darkness + card fade, chosen button
// scales up) before the pick commits. Kept in sync with .upgrade-panel.is-dismissing.
const UPGRADE_DISMISS_MS = 350

const SUIT_SYMBOLS: Record<Suit, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
}

interface ButtonDef {
  key: string
  label: string
  group: 'action' | 'power'
  /** Token price, shown as a cost pill on the button (powerups only). */
  cost?: number
  act: () => void
  visible: (s: SessionState) => boolean
  enabled: (s: SessionState) => boolean
  /** When true, the button glows to show the powerup is currently armed. */
  active?: (s: SessionState) => boolean
  /** When true, the move is legal but disabled purely for lack of chips to cover
   *  the extra bet — flags a red "not enough chips" badge (Double/Split only). */
  shortFunds?: (s: SessionState) => boolean
}

export function mountGameView(root: HTMLElement): void {
  new GameView(root)
}

class GameView {
  private readonly session: Session
  private state: SessionState
  // The payout is deferred: `run.chips` updates the instant the round settles,
  // but the chips don't move until the next hand is called. While a payout is
  // pending, the bankroll shows the frozen pre-settle value (`heldChips`) and is
  // released to the real total once the chips finish flying in/out (`clearEnd`).
  private heldChips: number | null = null
  private clearEnd = 0
  private clearPending = false
  private readonly scene = new Scene()
  private readonly anim = new DealAnimation()
  private readonly chips = new ChipAnimation()
  private readonly health = new HealthAnimation()
  private readonly dealer = new DealerAnimation()
  private readonly tokens = new TokenAnimation()
  private readonly mulligan = new MulliganAnimation()
  private readonly returnAnim = new ReturnAnimation()
  // The Bust Block shield's reveal: the caught busting card is shown, then swept
  // off, before any replacement is dealt.
  private readonly bustBlock = new BustBlockAnimation()
  private readonly peekFlip = new PeekFlipAnimation()
  // The dealer-spawn ceremony: shred the previous dealer's cards into the new
  // dealer's mouth, then fly in a fresh shrink-wrapped deck + tear off the plastic.
  private readonly spawn = new SpawnAnimation()
  // The table nexus's twin emitter lights: dim at rest, glowing while the nexus
  // pays out its reward tokens and fires its damage laser (see run()).
  private readonly nexus = new NexusAnimation()
  // The two number readouts roll from their old value to the new one (ticking
  // through the integers) and swell while they roll, rather than snapping: the
  // token count as rewards land, the bankroll as a payout merges into the pile.
  // The token counter rolls in BOTH directions (rewards tick up, spends tick down);
  // the bankroll snaps on a decrease (a bet/loss is an instant cost).
  private readonly tokenTicker = new CountTicker(0, true)
  private readonly bankrollTicker = new CountTicker()
  private readonly stage: Stage
  private raf = 0
  private lastAnimating = false
  // Edge tracker for the dealer-death pause: when it clears, buttons re-enable.
  private lastDealerBlocking = false
  // The card being returned (flips + flies back to the deck) and where it set off.
  private returnCardData: { card: Card; from: Point } | null = null
  // The busting card the Bust Block shield caught, with the hand + slot it's shown
  // on. Drawn (over the settled hand) while `bustBlock` animates.
  private bustBlockData: { handIndex: number; cardIndex: number; card: Card } | null = null
  // The Peek Deck card, retained so it can keep drawing through its flip-DOWN
  // (which plays after `foresightCard` has already cleared on the next move).
  private peekCard: Card | null = null
  // Damage/kill deferred from the resolve to the Next-hand click: the laser fires
  // AFTER the token reward flies, and the cards gather back into the deck only once
  // it's done. `dealAfter` is the timestamp the next deal waits for while the laser
  // (and any death → walk-in), then the card gather + shuffle, play out.
  private pendingAttack: { fromIntegrity: number; fromShift: number; toIntegrity: number; toShift: number } | null = null
  private dealAfter = 0
  // A kill that grants an upgrade pick splits the ceremony around the selector: the
  // dealer dies on the Next-hand click, and the replacement's arrival (walk-in + shred
  // + fresh deck) is deferred until the player picks. This holds what that deferred
  // arrival needs — the round to shred + the incoming dealer — set on the death, cleared
  // when the arrival fires. `upgradeRevealAt` is when the selector may surface (a beat
  // after the death), gating syncUpgradePanel so it doesn't pop up mid-death.
  private pendingCeremony: { prevRound: Round; incomingShift: number; incomingIntegrity: number } | null = null
  private upgradeRevealAt = 0
  // True while a picked upgrade's dismiss animation plays (before the pick commits);
  // syncUpgradePanel yields the panel to the animation during this window.
  private upgradeDismissing = false
  // Edge tracker: fire the upgrade-menu sfx the frame the choose-upgrade buttons
  // first surface (hidden → shown), then again only after they've hidden.
  private upgradeShown = false
  // When the current Analyze reading first appeared, so its flicker can ramp in
  // from that moment (the projection stutters on over the first few hundred ms).
  private analysisStart = 0
  // A dismissed reading, retained so it can flicker OUT (mirror of the strike-on)
  // over ANALYSIS_FADE_MS instead of vanishing; null once faded.
  private analysisFadeOut: SessionState['analysis'] = null
  private analysisFadeStart = 0
  // The ending hand's round, retained so its cards can be gathered back into
  // the deck after the Session has already cleared `state.round`.
  private collectRound: Round | null = null
  // The pre-split (single-hand) round, retained across the split's glide so
  // drawHands can tween the two originals out of their old slots. Set on a split,
  // cleared on the next action.
  private splitPrev: Round | null = null
  // While gathering + shuffling, the deck is drawn on the cards layer (so it can
  // split/move) and hidden on the static table layer.
  private deckOnCards = false
  // Which dealer's colour the deck is currently painted in (marks progression). On a
  // kill this stays the OUTGOING colour until the riffle finishes, then commits to
  // `deckColorIncoming` — so the reshuffle IS the deck swap, cross-fading old → new.
  private deckColorShift = 1
  private deckColorIncoming: number | null = null
  // Edge tracker for that commit: the riffle just ended (shuffle() went non-null → null).
  private shufflingLast = false
  // Edge tracker for the shuffle sfx: true once the riffle passes its split phase
  // and the piles start merging (where the clip's cascade actually sounds).
  private shuffleMergingLast = false
  // Previous frame's deck-unwrap progress (0..1), for firing the packaging sfx as
  // the wrap tears open (unwrap leaves 0) and the sheet slides off left (crosses
  // SHEET_SLIDE_START).
  private prevUnwrap = 0
  // Edge tracker for the shredder bed: true while the dealer is shredding cards, so
  // the loop starts on the leading edge and fast-fades on the trailing one.
  private shreddingLast = false
  // Edge tracker: play the win/loss sting once, the frame the resolved hand's
  // cards settle and the result is revealed. Reset when the round leaves resolved/over.
  private resultRevealed = false
  // A dealer-spawn ceremony's incoming deck colour, committed to `deckColorShift`
  // (and handed back to the static table) once the new wrapped deck lands + unwraps.
  private spawnIncomingShift: number | null = null
  // True while a ceremony is shredding the PREVIOUS dealer's resting deck (a kill / New
  // run) — drawn on the cards layer (resting → sucked into the mouth) with the static
  // table deck hidden. False on the opening intro (no old deck exists yet).
  private spawnHasOldDeck = false
  // True only during the opening intro, before the very first deck has flown in —
  // suppresses the static resting deck until the ceremony delivers it.
  private deckHidden = false
  // The opening walk-in is HELD (dealer parked off-screen, invisible) from construction
  // until the render loop is producing steady frames — so the post-load settling stall
  // (a single ~250ms first frame after the Vite dev module load, from JIT/GC/first
  // composite) is spent during the invisible hold, not as a teleport across the visible
  // slide-in. Released in frame() → startIntroNow once frames are steady.
  private introHold = false
  private introHoldStart = 0
  private introPrevFrame = 0
  private introSteadyFrames = 0

  private readonly defs: ButtonDef[]
  private tokensEl!: HTMLElement
  private tokenCountEl!: HTMLElement
  // Win/blackjack tokens are credited to run.tokens the instant a hand resolves,
  // but held out of the counter (no flight, no number bump) until the player
  // calls the next hand — the same deferral the payout chips use.
  private heldTokens = 0
  private messageEl!: HTMLElement
  private hintEl!: HTMLElement
  private buttons!: Record<string, HTMLButtonElement>
  // Per-button "not enough chips" badges (Double/Split), toggled in syncOverlay.
  private nsfBadges!: Record<string, HTMLElement>
  // Per-powerup cost-pill number spans, rewritten each frame to the inflated price.
  private costPills!: Record<string, HTMLElement>
  // The "prices +X%" token-inflation readout (hidden while inflation is 0).
  private inflationEl!: HTMLElement
  // The powerup + action button columns, hidden while the choose-upgrade card is up.
  private powersEl!: HTMLElement
  private actionsEl!: HTMLElement
  // The choose-upgrade card (shown after a non-final kill) and its three path buttons.
  private upgradeEl!: HTMLElement
  private upgradeButtons!: { info: UpgradePathInfo; btn: HTMLButtonElement; effectEl: HTMLElement }[]

  constructor(root: HTMLElement) {
    const debug = readDebugFlags()
    // Any of the three upgrade-path flags seeds the run with those unlocked tiers.
    const startUpgrades =
      debug.sabotageUpgrade !== null || debug.chipUpgrade !== null || debug.tokenUpgrades !== null
        ? { antiDealer: debug.sabotageUpgrade ?? 0, chipEco: debug.chipUpgrade ?? 0, tokenEco: debug.tokenUpgrades ?? 0 }
        : null
    this.session = new Session(generateSeed(), {
      forcePairs: debug.forcePairs,
      forcePairRank: debug.forcePairRank,
      startTokens: debug.startTokens,
      startChips: debug.startChips,
      dealerHealth: debug.dealerHealth,
      startDealer: debug.startDealer,
      startUpgrades,
      forceDealerNatural: debug.dealerBlackjack,
    })
    this.state = this.session.snapshot()
    // Show the opening balances immediately (no roll up from zero on load).
    this.tokenTicker.set(this.displayedTokens(now()))
    this.bankrollTicker.set(this.displayedBankroll())
    // Seed the health bar + dealer to the opening integrity so a dealer that starts
    // partway damaged (the dealerHealth dev override) shows the right fill and eye
    // flicker from the first frame — the first deal doesn't sync them (no damage yet).
    this.health.set(this.state.run.integrity, this.state.run.shiftIndex)
    this.dealer.setLevel(this.state.run.integrity, this.state.run.shiftIndex)
    // Seed the dealer's colour identity + the deck colour to the opening dealer (which
    // may be a later one via the `dealer` dev override), so the bowtie and card backs
    // wear that dealer's colour from the first paint.
    this.deckColorShift = this.state.run.shiftIndex
    this.dealer.setShift(this.state.run.shiftIndex)
    setCardBack(dealerColors(this.deckColorShift, now()).back)
    // Arm the opening ceremony BEFORE createStage's first (synchronous) paint, so the
    // very first frame already shows the dealer walking in + the deck hidden — never a
    // settled figure that then pops off-screen to walk back.
    this.armIntro()
    this.defs = this.makeButtons()
    this.stage = createStage(root, LAYERS, (canvas) => this.onResize(canvas))
    this.prewarmDeckSprite() // so the deck's fly-in doesn't hitch mid walk-in
    this.buildOverlay()
    this.syncOverlay(now())
    // Repaint the chips once the shared chip image loads, so it swaps in over the
    // vector fallback even if the table has already settled (slow network).
    onChipImageReady(() => {
      const canvas = this.stage.canvas
      this.drawChips(canvas, computeLayout(canvas.width, canvas.height), now())
    })
    this.ensureLoop() // drive the opening ceremony, then auto-deal the first hand
  }

  // Arm the opening ceremony but hold it: park the dealer off-screen (so the initial
  // paint + the warm-up frames show it off-screen) and wait for steady frames before
  // starting the visible slide-in (see the hold gate in frame() → startIntroNow). Runs
  // before the stage exists: no paint.
  private armIntro(): void {
    this.deckHidden = true // no resting deck until the ceremony flies one in
    const t = now()
    this.dealer.spawn(t) // park the figure off-screen
    this.introHold = true
    this.introHoldStart = t
    this.introPrevFrame = t
  }

  // Begin the opening ceremony on a warm frame `t`: base the walk-in + deck timeline
  // here so the slide-in starts from off-screen on steady frames, never mid-jank.
  private startIntroNow(t: number): void {
    this.dealer.spawn(t)
    this.spawnIncomingShift = this.state.run.shiftIndex
    const shredStart = t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP
    this.dealAfter = this.spawn.begin(shredStart, 0)
    this.lastAnimating = true // so the settle edge fires when the ceremony ends
  }

  // Build the deck-back sprite up front so the deck's fly-in during the opening
  // ceremony doesn't hitch while it's rendered (PCB pattern + all) for the first time.
  private prewarmDeckSprite(): void {
    const c = this.stage.canvas
    const a = shoeAnchor(computeLayout(c.width, c.height))
    getCardSprite(null, a.w, a.h, window.devicePixelRatio || 1)
  }

  // Repaint every layer. Static layers (back, table) only change here — on
  // resize (and the initial paint). The cards layer is redrawn per frame too.
  private onResize(canvas: LayeredCanvas): void {
    const layout = computeLayout(canvas.width, canvas.height)
    const t = now()
    this.anim.setNow(t)
    this.scene.drawBackground(canvas.layers.back.ctx, layout)
    this.paintTable(canvas, layout, this.tableHasDeck())
    // Repaint the dealer + strike fx at their CURRENT animated state, so a resize
    // mid-death/mid-strike doesn't blank the figure or the beam.
    this.drawDealerFigure(canvas, layout, t)
    this.drawCards(canvas, layout, t)
    this.drawChips(canvas, layout, t)
    this.drawHealth(canvas, layout, t)
    this.drawTokens(canvas, layout, t)
    this.drawMask(canvas, layout, t)
    this.drawFx(canvas, layout, t)
  }

  // Repaint the table layer (felt + rail + betting-spot markings), optionally
  // with the static deck.
  private paintTable(canvas: LayeredCanvas, layout: Layout, withDeck: boolean): void {
    const ctx = canvas.layers.table.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    this.scene.drawTable(ctx, layout)
    drawTableMarkings(ctx, layout)
    // The nexus device (damage + tokens originate from it) floats in a hover, so it's
    // NOT drawn here on the static table — it rides the per-frame fx layer (drawFx).
    if (withDeck) {
      this.applyDeckColor(now()) // paint the shoe in the current dealer's colour
      const a = shoeAnchor(layout)
      drawShoe(ctx, a.x, a.y, a.w, a.h)
    }
  }

  // Point the shared card-back palette at the current dealer's deck colour, so every
  // back drawn this frame (shoe, deal, discard/return/peek flips) matches. `now`
  // advances the RGB dealer's hue.
  private applyDeckColor(now: number): void {
    setCardBack(dealerColors(this.deckColorShift, now).back)
  }

  // The RGB (final) dealer's deck shimmers, so its resting deck lives on the per-frame
  // cards layer and the render loop is kept alive while it's in play.
  private rgbActive(): boolean {
    return isRgbDealer(this.deckColorShift)
  }

  // Whether the resting deck belongs on the static table layer this repaint. It moves
  // to the cards layer while gathering/shuffling (deckOnCards) and while the RGB
  // dealer is in play (so its colour can cycle) — in both cases the table omits it.
  private tableHasDeck(): boolean {
    return !this.deckOnCards && !this.deckHidden && !this.rgbActive()
  }

  // The dealer layer: the animated robot figure, below the rail so its lower body
  // and death debris tuck behind the table.
  private drawDealerFigure(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    drawDealer(canvas.layers.dealer.ctx, layout, this.dealer, timestamp)
  }

  // The fx layer: the floating nexus device body (hovering with the frame clock),
  // its emitter-light charge glow, and the laser strike (beam + muzzle flash +
  // impact sparks) — all drawn together since they share the device's bobbing muzzle.
  private drawFx(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const charge = {
      red: this.nexus.redLight(timestamp),
      yellow: this.nexus.yellowLight(timestamp),
      chargeUp: this.nexus.chargeUp(timestamp),
      healBeam: this.nexus.healBeam(timestamp),
    }
    drawStrikeFx(canvas.layers.fx.ctx, layout, this.dealer, charge, timestamp)
  }

  // The only per-frame work: clear + repaint the cards layer.
  private drawCards(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.cards.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    // Every back drawn this frame uses the current dealer's deck colour.
    this.applyDeckColor(timestamp)

    // A dealer-spawn ceremony: the fresh shrink-wrapped deck flies in from the
    // dealer and unwraps here (in the incoming dealer's colour), instead of the
    // same-dealer riffle below. The static table deck is untouched (kept as the old
    // deck, or hidden on the opening intro) until this one lands + commits.
    if (this.spawn.isAnimating(timestamp)) {
      const shift = this.spawnIncomingShift ?? this.deckColorShift
      // The outgoing dealer's deck is shredded into the mouth first (drawn resting on the
      // shoe until the shred reaches it), then the fresh wrapped deck flies in over the
      // emptied shoe — instead of just landing on top of the old one.
      if (this.spawnHasOldDeck) {
        drawOldDeckShred(ctx, layout, dealerColors(this.deckColorShift, timestamp).back, this.spawn, timestamp)
      }
      drawSpawnDeck(ctx, layout, dealerColors(shift, timestamp).back, this.spawn, timestamp)
    } else if (this.deckOnCards) {
      // While gathering/shuffling, the deck lives on this layer so it can slide
      // out to the centre (in front of the dealer) and split for the riffle.
      const rest = shoeAnchor(layout)
      const centerX = layout.width / 2 - rest.w / 2
      const x = rest.x + (centerX - rest.x) * this.anim.deckShift()
      const shuffle = this.anim.shuffle()
      if (shuffle !== null) {
        // On a dealer change the riffle cross-fades the outgoing deck out and the
        // new dealer's deck in; on a same-dealer reshuffle there's no incoming.
        const incoming = this.deckColorIncoming !== null ? dealerColors(this.deckColorIncoming, timestamp).back : undefined
        drawShuffle(ctx, x, rest.y, rest.w, rest.h, shuffle, incoming)
      } else {
        drawShoe(ctx, x, rest.y, rest.w, rest.h)
      }
    } else if (this.rgbActive()) {
      // The RGB dealer's resting deck stays on this per-frame layer so its colour
      // keeps cycling (the static table layer would freeze it between repaints).
      const rest = shoeAnchor(layout)
      drawShoe(ctx, rest.x, rest.y, rest.w, rest.h)
    }

    // Peek Deck: the shoe's top card flipped up in place. It stays face-up while
    // the peek is live (`foresightCard`), then flips back down on the next move —
    // by which point `foresightCard` has cleared, so the retained `peekCard`
    // carries it through the flip-down. Only over the static deck (never mid-shuffle).
    if (!this.deckOnCards && this.peekCard && (this.state.foresightCard || this.peekFlip.isAnimating(timestamp))) {
      drawPeekCard(ctx, layout, this.peekCard, this.peekFlip.progress(timestamp))
    }

    // During a dealer-spawn ceremony the ending round's cards are being sucked into
    // the new dealer's mouth + shredded (drawn here), not laid out settled.
    if (this.spawn.isAnimating(timestamp) && this.collectRound) {
      drawShred(ctx, layout, this.collectRound, this.spawn, timestamp)
    } else {
      // Fall back to the retained ending round while its cards are gathering.
      const round = this.state.round ?? this.collectRound
      if (round) {
        const revealHole = this.state.phase !== 'playing' || this.state.peeked
        drawHands(ctx, layout, round, revealHole, this.anim, this.handResults(timestamp), this.splitPrev ?? undefined)
      }
    }

    // Mulligan: the tossed opening cards flip down and fly back to the deck while
    // the fresh pair (already in `round`, but not yet scheduled) waits to fly in.
    if (this.mulligan.isAnimating(timestamp)) {
      drawMulliganDiscard(ctx, layout, this.mulligan.frames(timestamp))
    }

    // Return: the returned card flips face-down and flies back onto the deck,
    // just before the dealer reveals + plays out.
    if (this.returnCardData && this.returnAnim.isAnimating(timestamp)) {
      const f = this.returnAnim.frame(timestamp)
      const { card, from } = this.returnCardData
      drawReturnCard(ctx, layout, card, from.x, from.y, f.flip, f.fly)
    }

    // Bust Block: the shield caught a busting draw — reveal that card (the bust the
    // player hit) on its slot, catch it in the gold ring, then sweep it off. The
    // replacement, if any, is held back until this finishes (scheduled in run()).
    if (this.bustBlockData && this.bustBlock.isAnimating(timestamp)) {
      const round = this.state.round ?? this.collectRound
      if (round) {
        const { handIndex, cardIndex, card } = this.bustBlockData
        drawBustBlock(ctx, layout, round, handIndex, cardIndex, card, this.bustBlock.frame(timestamp))
      }
    }

    // The Analyze readout sits in the band between the two hands. Only while a
    // reading is live and the table is settled — never over cards in flight. It
    // shimmers, so `timestamp` drives it and the loop is kept alive below.
    const ar = this.analysisRender(timestamp)
    if (ar) {
      drawAnalysis(ctx, layout, ar.a, ar.age, ar.fade)
    }
  }

  // The top 'mask' layer: darkens the world while a reading is up and lets the
  // projection punch light back through. Cleared (transparent) otherwise.
  private drawMask(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.mask.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    const ar = this.analysisRender(timestamp)
    if (ar) {
      drawAnalysisMask(ctx, layout, ar.a, ar.age, ar.fade)
    }
    // The dealer's emissive red eye glow, added on top (so it also shows through
    // the Analyze darkness). Drawn every frame the loop runs and on resize; at
    // rest the last frame's glow persists on this otherwise-clear layer.
    drawDealerEyeGlow(ctx, layout, this.dealer.eyeGlow(timestamp))
  }

  // The Analyze projection to paint this frame (live or flickering out), with the
  // age + fade its beams/text/mask all share, or null when nothing's showing.
  private analysisRender(
    timestamp: number,
  ): { a: NonNullable<SessionState['analysis']>; age: number; fade: number } | null {
    if (this.showingAnalysis(timestamp)) {
      return { a: this.state.analysis!, age: timestamp - this.analysisStart, fade: 1 }
    }
    const fading = this.analysisFade(timestamp)
    // Rewind the strike age (mirror flicker) and fade to nothing on dismiss.
    return fading ? { a: fading.a, age: ANALYSIS_STRIKE_MS * fading.fade, fade: fading.fade } : null
  }

  // Whether the shimmering Analyze projection should be painting right now.
  private showingAnalysis(timestamp: number): boolean {
    return this.state.phase === 'playing' && this.state.analysis !== null && !this.anim.isAnimating(timestamp)
  }

  // A dismissed reading still flickering out, with its remaining life (1 → 0).
  private analysisFade(timestamp: number): { a: NonNullable<SessionState['analysis']>; fade: number } | null {
    if (!this.analysisFadeOut) {
      return null
    }
    const life = 1 - (timestamp - this.analysisFadeStart) / ANALYSIS_FADE_MS
    return life > 0 ? { a: this.analysisFadeOut, fade: life } : null
  }

  // Each hand's outcome (Win/Lose/Push/Bust + amount), one entry per player hand,
  // shown beside that hand's count — so both halves of a split report their own
  // result. Withheld until the card motion settles, so it never spoils the reveal.
  private handResults(timestamp: number): (RoundResult | undefined)[] | undefined {
    const { phase, round } = this.state
    if (phase !== 'resolved' || !round) {
      return undefined // 'over' uses the centered game-over banner instead
    }
    if (this.anim.isAnimating(timestamp)) {
      return undefined
    }
    return round.hands.map((hand) => handResultLabel(hand, round.rules))
  }

  // The win/loss reveal sting. A finished run ('over') keys off run.won; a normal
  // resolve sums the hands' net chips so a split reports its overall outcome — a
  // net gain wins, a net loss loses, an exact push stays silent.
  private playResultSting(): void {
    const { phase, run, round } = this.state
    if (phase === 'over') {
      sfx.play(run.won ? 'player-won' : 'player-lost')
      return
    }
    if (phase === 'resolved' && round) {
      const net = round.hands.reduce((sum, hand) => sum + handNet(hand, round.rules), 0)
      if (net > 0) {
        sfx.play('player-won')
      } else if (net < 0) {
        sfx.play('player-lost')
      }
    }
  }

  // The chips layer: house + player bankroll stacks (always) plus the current
  // hand's bet chips and any in-flight payout. Uses the retained ending round
  // while the table is settling, and the frozen bankroll while a payout waits.
  private drawChips(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.chips.ctx
    const round = this.state.round ?? this.collectRound
    // Roll the bankroll number toward its true value (it jumps when a payout is
    // released) so it ticks up as the chips settle instead of snapping.
    this.bankrollTicker.retarget(this.displayedBankroll(), timestamp)
    const chips = this.bankrollTicker.value(timestamp)
    const chipsScale = this.bankrollTicker.scale(timestamp)
    drawChips(ctx, layout, { chips, chipsScale, round }, this.chips, timestamp)
  }

  // The HUD layer: the dealer's vertical health bar, with the dealer-remaining
  // pip column beside it. It's static at rest, so it only repaints on resize, on
  // the animation loop, and once when things settle.
  private drawHealth(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.hud.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    // Dealers left to defeat, counting the one in front of the player — so the
    // final dealer shows a single pip. (shiftIndex is 1-based and runs one past
    // TOTAL_DEALERS on a win, hence the clamp to zero.)
    const dealersLeft = Math.max(0, TOTAL_DEALERS - this.state.run.shiftIndex + 1)
    drawHealthBar(ctx, layout, this.health, timestamp, dealersLeft, TOTAL_DEALERS)
  }

  // The top layer: reward tokens flying up to the counter. Cleared and left blank
  // whenever nothing is in the air (which is most of the time).
  private drawTokens(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.tokens.ctx
    if (!this.tokens.isAnimating(timestamp)) {
      ctx.clearRect(0, 0, layout.width, layout.height)
      return
    }
    drawTokens(ctx, layout, this.tokens, timestamp, this.tokenTarget())
  }

  // The token counter's centre in canvas space. The overlay and the canvas layers
  // share the stage's box and CSS-pixel coordinates, so the counter's position
  // relative to the stage IS its canvas coordinate — the point tokens fly into.
  private tokenTarget(): Point {
    const host = this.stage.container.getBoundingClientRect()
    const box = this.tokensEl.getBoundingClientRect()
    return { x: box.left - host.left + box.width / 2, y: box.top - host.top + box.height / 2 }
  }

  // The bankroll shown in the stack + status line: `run.chips` minus whatever is
  // committed on the table as the live bet (so the count never double-shows the
  // bet). While a payout is settling it holds the frozen pre-settle value.
  private displayedBankroll(): number {
    if (this.heldChips !== null) {
      return this.heldChips
    }
    const round = this.state.round
    const bet = round ? round.hands.reduce((sum, hand) => sum + hand.bet, 0) : 0
    return this.state.run.chips - bet
  }

  // The count to show: the run total minus whatever is still flying toward the
  // counter (pending) AND whatever a resolve is withholding until the next hand
  // (heldTokens) — so a win only registers once its tokens are released and land.
  private displayedTokens(now: number): number {
    return this.state.run.tokens - this.tokens.pending(now) - this.heldTokens
  }

  // Point the token counter at what should be shown now (bursts still in the air
  // are withheld), then paint the ticker's current value + swell. As each burst
  // lands the target jumps up and the counter rolls up to meet it. Called every
  // frame while anything is in motion, and on each state sync.
  private updateTokenCounter(now: number): void {
    this.tokenTicker.retarget(this.displayedTokens(now), now)
    this.tokenCountEl.textContent = String(this.tokenTicker.value(now))
    const scale = this.tokenTicker.scale(now)
    this.tokensEl.style.transform = scale === 1 ? '' : `scale(${scale})`
  }

  // Animation loop: runs while cards are in motion, then parks itself. Only the
  // cards layer is touched; the overlay is synced only on the animate→idle edge.
  private readonly frame = (timestamp: number): void => {
    this.anim.setNow(timestamp)
    // A card just launched from the shoe (one entry per fresh flight this frame) —
    // fire the draw sfx for each. Glides (split originals) are excluded upstream.
    const drawn = this.anim.drawnCards(timestamp).length
    for (let i = 0; i < drawn; i += 1) {
      sfx.play('draw-card')
    }
    // Reward tokens just shot out of the nexus vent — one rising tone per visible
    // token sprite, staggered into a quick cascade (a kill's 5-sprite burst reads
    // as a coin shower, not a single stacked blip).
    const launched = this.tokens.launched(timestamp)
    for (let i = 0; i < launched; i += 1) {
      sfx.playTone('token-launch', (i * TOKEN_TONE_STAGGER_MS) / 1000)
    }
    // ...and the answering shower as each burst reaches the counter: one ping per
    // visible token, tight like the launch (so it reads as a dense shower, not a
    // sparse trickle). The counter then rolls the number up over that SAME window,
    // so it finishes climbing exactly as the last ping lands — audio and number in
    // step, both a quick punch rather than a long tail.
    for (const icons of this.tokens.landed(timestamp)) {
      for (let i = 0; i < icons; i += 1) {
        sfx.playTone('token-land', (i * TOKEN_TONE_STAGGER_MS) / 1000)
      }
      const showerMs = Math.max(1, icons - 1) * TOKEN_TONE_STAGGER_MS
      this.tokenTicker.retarget(this.displayedTokens(timestamp), timestamp, showerMs)
    }
    // The fresh deck's shrink-wrap: read the same unwrap fraction the renderer uses
    // and fire the tear-open sfx as it begins peeling (unwrap leaves 0), then the
    // rustling sfx as the big sheet starts sliding off to the left.
    const unwrap = this.spawn.deckState(timestamp)?.unwrap ?? 0
    if (unwrap > 0 && this.prevUnwrap <= 0) {
      sfx.play('packaging-opening')
    }
    if (unwrap >= SHEET_SLIDE_START && this.prevUnwrap < SHEET_SLIDE_START) {
      sfx.play('packaging-rustling')
    }
    this.prevUnwrap = unwrap
    // The dealer's shredder: start the looping bed (shredder + vacuum) as the first
    // card is sucked in, fast-fade it once the last is gone.
    const shredding = this.spawn.isShredding(timestamp)
    if (shredding && !this.shreddingLast) {
      sfx.startShredding()
    } else if (!shredding && this.shreddingLast) {
      sfx.stopShredding(SHRED_FADE_MS)
    }
    this.shreddingLast = shredding
    // Opening walk-in hold: keep the dealer parked off-screen until the loop settles
    // into steady (~60fps) frames, THEN start the slide-in — so the one big post-load
    // frame (JIT/GC/first composite) is absorbed by the invisible hold instead of
    // teleporting the visible walk-in. Released after two consecutive steady frames,
    // or a 600ms safety cap so it can't stall forever on a slow device.
    if (this.introHold) {
      const dt = timestamp - this.introPrevFrame
      this.introPrevFrame = timestamp
      this.introSteadyFrames = dt > 0 && dt < 40 ? this.introSteadyFrames + 1 : 0
      if (this.introSteadyFrames >= 2 || timestamp - this.introHoldStart > 600) {
        this.introHold = false
        this.startIntroNow(timestamp)
      } else {
        this.dealer.spawn(timestamp) // hold the figure off-screen this frame
      }
    }
    // The dealer's walk-in footsteps: one boot-thud per bob-down beat as the figure
    // strides to its spot (page load, New run, or a replacement after a kill). Fired
    // off the animator's step tracker so each thud lands exactly on a visible dip;
    // the sfx is rate-jittered per play so the strides don't sound stamped identical.
    const steps = this.dealer.footsteps(timestamp)
    for (let i = 0; i < steps; i += 1) {
      sfx.play('footstep')
    }
    // Release the frozen bankroll the moment the settling chips land (which is
    // well before the longer card gather + shuffle finishes), so the stack grows
    // or shrinks as the chips arrive.
    if (this.clearPending && timestamp >= this.clearEnd) {
      this.heldChips = null
      this.clearPending = false
    }
    // Commit the deck's new colour the instant the riffle finishes reforming it
    // (shuffle went non-null → null): the new deck is fully riffled in, so the rest
    // of the choreography (slide-back, next deal) uses the incoming dealer's colour.
    const shuffleT = this.anim.shuffle()
    const shufflingNow = shuffleT !== null
    // Fire the shuffle sfx the frame the riffle passes its split phase and the
    // piles start merging — that's where the clip's cascade sound sits (it has no
    // silent lead-in), and the merge is sized to the clip so they end together.
    const merging = shuffleT !== null && shuffleT >= SHUFFLE_SPLIT_FRACTION
    if (merging && !this.shuffleMergingLast) {
      sfx.play('shuffle')
    }
    this.shuffleMergingLast = merging
    if (this.shufflingLast && !shufflingNow && this.deckColorIncoming !== null) {
      this.deckColorShift = this.deckColorIncoming
      this.deckColorIncoming = null
    }
    this.shufflingLast = shufflingNow
    // The result just became visible — the resolved/over hand's cards have
    // settled (same gate the Win/Lose label uses). Play the win or loss sting
    // once; the flag resets when the round leaves the resolved/over phases.
    const resolved = this.state.phase === 'resolved' || this.state.phase === 'over'
    const revealed = resolved && !this.anim.isAnimating(timestamp)
    if (revealed && !this.resultRevealed) {
      this.resultRevealed = true
      this.playResultSting()
    }
    if (!resolved) {
      this.resultRevealed = false
    }
    const canvas = this.stage.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    this.drawCards(canvas, layout, timestamp)
    this.drawChips(canvas, layout, timestamp)
    this.drawHealth(canvas, layout, timestamp)
    this.drawTokens(canvas, layout, timestamp)
    this.drawMask(canvas, layout, timestamp)
    this.drawDealerFigure(canvas, layout, timestamp)
    this.drawFx(canvas, layout, timestamp)
    // Roll the counter up toward any tokens that just landed (ticks per burst).
    this.updateTokenCounter(timestamp)

    const sequenceAnimating =
      this.anim.isAnimating(timestamp) ||
      this.chips.isAnimating(timestamp) ||
      this.spawn.isAnimating(timestamp) ||
      this.bustBlock.isAnimating(timestamp) ||
      // A dealer's heal beam holds the settle (buttons + result) until it finishes,
      // so the repair always reads in full before the player can call the next hand.
      this.nexus.isHealing(timestamp)

    // The card + chip sequence just finished: run the one-time settle. The health
    // bar may keep animating past this point (its drop lands after the reveal) —
    // that's handled by the loop-alive check below and must NOT hold up the
    // settle, or the buttons and next deal would stall behind it.
    if (!sequenceAnimating && this.lastAnimating) {
      this.raf = 0 // let a re-deal's run() → ensureLoop reschedule cleanly
      this.lastAnimating = false

      if (this.deckOnCards) {
        // Gather + shuffle finished: hand the deck back to the static table layer
        // (unless the RGB dealer keeps it on the cards layer to keep shimmering).
        this.deckOnCards = false
        this.paintTable(canvas, layout, this.tableHasDeck())
      }
      if (this.spawnIncomingShift !== null) {
        // Spawn ceremony finished: the fresh deck has landed + unwrapped. Commit its
        // colour and hand it back to the static table layer (the old deck it flew in
        // over is replaced right where they register, so the swap is unseen).
        this.deckColorShift = this.spawnIncomingShift
        this.spawnIncomingShift = null
        this.spawnHasOldDeck = false
        this.deckHidden = false
        this.paintTable(canvas, layout, this.tableHasDeck())
      }
      // Keep the ending round's cards on the felt while a deferred arrival is pending —
      // the dealer's dead and the upgrade selector is up, and those cards are what the
      // new dealer will shred when it finally walks in (playArrival).
      if (!this.pendingCeremony) {
        this.collectRound = null
      }
      // Release the frozen bankroll only when a next-hand CLEAR just finished (the
      // payout chips have moved) — NOT when a resolve animation settles, so the
      // count stays put through the resolved-waiting state until next hand.
      if (this.clearPending) {
        this.heldChips = null
        this.clearPending = false
      }
      this.drawCards(canvas, layout, timestamp)
      this.drawChips(canvas, layout, timestamp)
      this.drawTokens(canvas, layout, timestamp)
      this.syncOverlay(timestamp)

      // No Deal button — once the deck is ready, deal the next hand automatically,
      // UNLESS a deferred laser/death is still to play (dealAfter) — then wait.
      if (this.state.phase === 'betting' && this.dealAfter <= timestamp) {
        this.run(() => this.session.deal())
        return
      }
    }

    // Deferred deal: the token reward + nexus laser (and any death → walk-in) play
    // after the Next-hand click; only once that finishes do the next cards deal.
    if (this.dealAfter > 0 && timestamp >= this.dealAfter && this.state.phase === 'betting' && !sequenceAnimating) {
      this.dealAfter = 0
      // Zero the raf first (like the settle block) so run() → ensureLoop reschedules
      // the loop — the `return` below skips this frame's own reschedule.
      this.raf = 0
      this.run(() => this.session.deal())
      return
    }

    // The dealer-death pause blocks the buttons via syncOverlay's `animating`, but
    // syncOverlay only runs per-action + on the settle edge — so detect the moment
    // the block clears and re-sync to re-enable the buttons + show the result.
    const dealerBlocking = this.dealer.isBlocking(timestamp)
    if (this.lastDealerBlocking && !dealerBlocking) {
      this.syncOverlay(timestamp)
    }
    this.lastDealerBlocking = dealerBlocking

    // While the choose-upgrade pick is pending, keep the overlay synced every frame
    // so the card surfaces the instant the death settles + its reveal beat passes (and
    // clears the moment a pick releases the deal). The loop already runs for the hover.
    if (this.state.phase === 'choosing-upgrade') {
      this.syncOverlay(timestamp)
    }

    // The table nexus floats in a perpetual hover (render/nexus.ts), so its bob +
    // contact shadow always need repainting: the loop never fully parks. Every
    // other system (sequence, health, tokens, counters, dealer, Analyze, the RGB
    // dealer's shimmer…) still animates as before — it just no longer has to gate
    // liveness here, since the hover keeps us running regardless. The one-shot
    // settle/edge handling above has already consumed what it needs this frame.
    this.raf = requestAnimationFrame(this.frame)
  }

  private ensureLoop(): void {
    if (!this.raf) {
      this.raf = requestAnimationFrame(this.frame)
    }
  }

  private makeButtons(): ButtonDef[] {
    const playing = (s: SessionState) => s.phase === 'playing'
    // Powerups stay put — always visible, just enabled/disabled — so the column
    // never collapses and reflows between hands. Their "only during play"
    // condition lives in `enabled` (via playing()), not `visible`. The contextual
    // ACTION buttons (Hit/Stand/Next/…) still appear per phase.
    return [
      { key: 'hit', label: 'Hit', group: 'action', act: () => this.session.hit(), visible: playing, enabled: yes },
      { key: 'stand', label: 'Stand', group: 'action', act: () => this.session.stand(), visible: playing, enabled: yes },
      {
        key: 'double',
        label: 'Double',
        group: 'action',
        act: () => this.session.double(),
        visible: playing,
        enabled: (s) => !!s.round && canDouble(s.round) && affordsExtra(s),
        shortFunds: (s) => !!s.round && canDouble(s.round) && !affordsExtra(s),
      },
      {
        key: 'split',
        label: 'Split',
        group: 'action',
        act: () => this.session.split(),
        visible: playing,
        enabled: (s) => !!s.round && canSplit(s.round) && affordsExtra(s),
        shortFunds: (s) => !!s.round && canSplit(s.round) && !affordsExtra(s),
      },
      { key: 'next', label: 'Next hand', group: 'action', act: () => this.session.nextHand(), visible: (s) => s.phase === 'resolved', enabled: yes },
      { key: 'restart', label: 'New run', group: 'action', act: () => this.session.restart(), visible: (s) => s.phase === 'over', enabled: yes },
      {
        key: 'analyze',
        label: 'Analyze',
        group: 'power',
        cost: POWERUPS.analyze.cost,
        act: () => this.session.buyAnalyze(),
        visible: yes,
        // Disabled while a reading is already up (it can't be paid for twice); the
        // button glows via `active` until the player acts and the reading clears.
        enabled: (s) => playing(s) && affords(POWERUPS.analyze.cost, s) && s.analysis === null,
        active: (s) => playing(s) && s.analysis !== null,
      },
      {
        key: 'peek',
        label: 'Peek Dealer',
        group: 'power',
        cost: POWERUPS.peek.cost,
        act: () => this.session.buyPeek(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.peek.cost, s) && !s.peeked,
      },
      {
        key: 'forced-split',
        label: 'Forced split',
        group: 'power',
        cost: POWERUPS['forced-split'].cost,
        act: () => this.session.buyForcedSplit(),
        // Shares one slot with Late double to save space: shown only in the pre-hit
        // phase (while a free Double is still on the table), hidden the moment the
        // player hits. Disabled — but still shown — when the hand can already be
        // split for free, since paying to force it would be pointless.
        visible: (s) => !!s.round && canDouble(s.round),
        enabled: (s) =>
          playing(s) &&
          affords(POWERUPS['forced-split'].cost, s) &&
          !!s.round &&
          canForcedSplit(s.round) &&
          !canSplit(s.round) &&
          affordsExtra(s),
      },
      {
        key: 'late-double',
        label: 'Late double',
        group: 'power',
        cost: POWERUPS['late-double'].cost,
        act: () => this.session.buyLateDouble(),
        // Hidden while a free Double is still on the table (first two cards) — that
        // slot shows Forced split instead. Appears once the player has hit and the
        // free Double has lapsed.
        visible: (s) => !(s.round && canDouble(s.round)),
        enabled: (s) =>
          playing(s) && affords(POWERUPS['late-double'].cost, s) && !!s.round && !canDouble(s.round) && affordsExtra(s),
      },
      {
        key: 'return',
        label: 'Return',
        group: 'power',
        cost: POWERUPS.return.cost,
        act: () => this.session.buyReturn(),
        visible: yes,
        // Only once the hand has taken a hit (more than two cards) is there a
        // drawn card to push back. Auto-stands, so it also ends the turn.
        enabled: (s) => playing(s) && affords(POWERUPS.return.cost, s) && !!s.round && canReturn(s.round),
      },
      {
        key: 'freeze',
        label: 'Freeze Dealer',
        group: 'power',
        cost: POWERUPS.freeze.cost,
        act: () => this.session.buyFreezeDealer(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.freeze.cost, s) && !!s.round && !s.round.dealerFrozen,
        active: (s) => playing(s) && !!s.round && s.round.dealerFrozen,
      },
      {
        key: 'second-chance',
        label: 'Bust Block',
        group: 'power',
        cost: POWERUPS['second-chance'].cost,
        act: () => this.session.buySecondChance(),
        visible: yes,
        enabled: (s) =>
          playing(s) && affords(POWERUPS['second-chance'].cost, s) && !!s.round && !s.round.secondChanceArmed,
        active: (s) => playing(s) && !!s.round && s.round.secondChanceArmed,
      },
      {
        key: 'mulligan',
        label: 'Mulligan',
        group: 'power',
        cost: POWERUPS.mulligan.cost,
        act: () => this.session.buyMulligan(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.mulligan.cost, s) && !!s.round && canMulligan(s.round),
      },
      {
        key: 'foresight',
        label: 'Peek Deck',
        group: 'power',
        cost: POWERUPS.foresight.cost,
        act: () => this.session.buyForesight(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.foresight.cost, s) && s.foresightCard === null,
      },
    ]
  }

  private buildOverlay(): void {
    const tokens = this.buildTokenCounter()
    this.inflationEl = element('div', 'hud-inflation is-hidden')
    this.messageEl = element('div', 'hud-message')
    this.hintEl = element('div', 'hud-powerhint')
    const powers = element('div', 'hud-powerups')
    const actions = element('div', 'hud-actions')
    this.powersEl = powers
    this.actionsEl = actions
    powers.appendChild(this.hintEl) // hint sits atop the powerup stack

    this.buttons = {}
    this.nsfBadges = {}
    this.costPills = {}
    for (const def of this.defs) {
      const button = document.createElement('button')
      button.classList.add(`hud-btn-${def.key}`) // per-button hook for CSS (e.g. a wide Next hand)
      if (def.cost === undefined) {
        button.textContent = def.label
      } else {
        // Powerups: the name on the button, the token cost in a pill pinned to
        // the bottom-right corner. Track the number span so syncOverlay can rewrite
        // it to the inflated price each frame.
        const label = element('span', 'power-label')
        label.textContent = def.label
        const pill = costPill(def.cost)
        // A lock pill (red ✕) sits in the same corner, hidden until the Dealer 6 duel
        // locks abilities — CSS swaps it in for the cost pill via the button's is-locked.
        button.append(label, pill, lockPill())
        const num = pill.querySelector('.cost-pill__num')
        if (num) {
          this.costPills[def.key] = num as HTMLElement
        }
      }
      // A move that can be priced out (Double/Split) carries a hidden "not enough
      // chips" badge in the opposite (bottom-left) corner, revealed in syncOverlay.
      if (def.shortFunds) {
        const badge = nsfBadge()
        button.appendChild(badge)
        this.nsfBadges[def.key] = badge
      }
      button.addEventListener('click', () => {
        // A powerup click fires the ability cue (and, as the first user gesture,
        // resumes the audio context). Move buttons make no sound — it's masked by
        // the card-draw sfx anyway.
        if (def.group === 'power') {
          sfx.play('ability')
        }
        this.run(def.act)
      })
      this.buttons[def.key] = button
      ;(def.group === 'power' ? powers : actions).appendChild(button)
    }

    // The choose-upgrade card sits above the columns (appended last), shown only
    // during the choosing-upgrade phase once the dealer's death settles.
    this.stage.overlay.append(tokens, this.inflationEl, this.messageEl, powers, actions, this.buildUpgradePanel())
  }

  // The choose-upgrade card: a title and one big coloured button per upgrade path,
  // each showing the effect it would unlock next. A maxed path's button is hidden.
  // Clicking picks the upgrade (session.chooseUpgrade) and releases the held deal.
  private buildUpgradePanel(): HTMLElement {
    const panel = element('div', 'upgrade-panel is-hidden')
    const title = element('div', 'upgrade-panel__title')
    title.textContent = 'Choose an upgrade'
    const row = element('div', 'upgrade-panel__row')
    this.upgradeButtons = UPGRADE_PATHS.map((info) => {
      const btn = document.createElement('button')
      btn.className = `upgrade-btn upgrade-btn--${info.path}`
      btn.style.setProperty('--upgrade-color', info.color)
      const icon = document.createElement('img')
      icon.className = 'upgrade-btn__icon'
      icon.src = UPGRADE_ICONS[info.path]
      icon.alt = info.name // the path name still reaches screen readers
      const effectEl = element('span', 'upgrade-btn__effect')
      btn.append(icon, effectEl)
      btn.addEventListener('click', () => this.pickUpgrade(info, btn))
      row.appendChild(btn)
      return { info, btn, effectEl }
    })
    panel.append(title, row)
    this.upgradeEl = panel
    return panel
  }

  // A path button was clicked: play the dismiss animation (darkness + title fade,
  // the unselected buttons snap away, the chosen button fades while scaling up) and
  // only commit the pick — which releases the held deal and starts the next dealer's
  // walk-in — once it finishes. Guarded so a second click mid-animation is ignored.
  private pickUpgrade(info: UpgradePathInfo, btn: HTMLButtonElement): void {
    if (this.upgradeDismissing) {
      return
    }
    sfx.play('upgrade-selected')
    this.upgradeDismissing = true
    btn.classList.add('is-chosen')
    this.upgradeEl.classList.add('is-dismissing')
    window.setTimeout(() => {
      // Commit first: this flips to `betting`, and syncOverlay hides the card
      // (is-hidden → visibility:hidden), so dropping the animation classes next is
      // invisible. Clearing the flag before run() lets syncUpgradePanel hide it.
      this.upgradeDismissing = false
      this.run(() => this.session.chooseUpgrade(info.path))
      this.upgradeEl.classList.remove('is-dismissing')
      btn.classList.remove('is-chosen')
    }, UPGRADE_DISMISS_MS)
  }

  // The player's token counter (icon + count), pinned top-left. The icon <img>
  // is created once here so it loads a single time; syncOverlay only rewrites the
  // count text.
  private buildTokenCounter(): HTMLElement {
    const el = element('div', 'hud-tokens')
    this.tokensEl = el // measured each frame so reward tokens can fly into it
    this.tokenCountEl = element('span', 'hud-tokens__count')
    el.append(powerIcon('hud-tokens__icon'), this.tokenCountEl)
    return el
  }

  private run(mutate: () => void): void {
    const prevPhase = this.state.phase
    const prevRound = this.state.round
    const prevChips = this.state.run.chips
    const prevTokens = this.state.run.tokens
    const prevIntegrity = this.state.run.integrity
    const prevShift = this.state.run.shiftIndex
    const prevAnalysis = this.state.analysis
    const prevForesight = this.state.foresightCard
    mutate()
    this.state = this.session.snapshot()
    const { integrity, shiftIndex } = this.state.run

    const t = now()
    // Peek Deck's top-card flip: face-up when the peek is bought, face-down when it
    // clears on the next move. A peek that was showing leads the deal by the
    // flip-down so the card visibly flips down BEFORE it's drawn (see `dealLead`).
    if (this.state.foresightCard && !prevForesight) {
      this.peekCard = this.state.foresightCard
      this.peekFlip.flip(t, true)
    } else if (!this.state.foresightCard && prevForesight) {
      this.peekFlip.flip(t, false)
    }
    const dealLead = prevForesight && !this.state.foresightCard ? PEEK_FLIP_MS : 0
    // Stamp when a fresh reading appears (flicker ramps in from here), or start the
    // flicker-out when one is dismissed (retain it so it can die gracefully).
    if (this.state.analysis && !prevAnalysis) {
      this.analysisStart = t
      this.analysisFadeOut = null
    } else if (!this.state.analysis && prevAnalysis) {
      this.analysisFadeOut = prevAnalysis
      this.analysisFadeStart = t
    }
    // The upgrade was just chosen (choosing-upgrade → betting): the dealer's already
    // dead and gone; now the deferred arrival ceremony — walk-in + shred + fresh deck —
    // plays, then the next hand deals. Handled on its own since there's no round change.
    if (prevPhase === 'choosing-upgrade' && this.pendingCeremony) {
      this.playArrival(t)
      this.syncOverlay(t)
      this.lastAnimating = this.anim.isAnimating(t) || this.chips.isAnimating(t) || this.spawn.isAnimating(t)
      this.ensureLoop()
      return
    }
    if (prevRound && !this.state.round) {
      // Next hand called: settle the deferred chips now (winners collect, losers pay
      // the house). What follows depends on whether the DEALER CHANGES. A same-dealer
      // hand gathers the spent cards back into the deck + riffles; a dealer SPAWN — a
      // kill, or a New run's reset — instead shreds the old cards into the new
      // dealer's mouth and flies in a fresh shrink-wrapped deck (the ceremony).
      this.collectRound = prevRound
      this.chips.clear(prevRound, t)
      this.clearEnd = this.chips.animEnd
      this.clearPending = true
      // The win tokens were already awarded on the resolve (they flew in behind the
      // won chips). A New run (from 'over') just drops the withheld final reward.
      this.heldTokens = 0

      const isKill =
        !!this.pendingAttack && prevPhase === 'resolved' && this.pendingAttack.toShift > this.pendingAttack.fromShift
      const newRun = prevPhase === 'over'
      const ceremony = isKill || newRun

      if (!ceremony) {
        // Same dealer: move the deck onto the cards layer so the gather + riffle can
        // slide + split it. A ceremony instead keeps the old deck on the static table
        // until the fresh one lands over it, so its colour swap stays hidden.
        this.deckOnCards = true
        const canvas = this.stage.canvas
        this.paintTable(canvas, computeLayout(canvas.width, canvas.height), false)
      }
      // A New run zeroes the count: snap it rather than dramatically rolling the whole
      // balance down (a full reset isn't a "spend").
      if (newRun) {
        this.tokenTicker.set(this.displayedTokens(t))
      }

      if (this.pendingAttack && prevPhase === 'resolved') {
        // A win: the won chips first collect from the bet area into the player's stack
        // (chips.clear, above), THEN the laser fires — and only after that does the
        // deck reset play, so the payout never animates during the attack.
        const pa = this.pendingAttack
        this.pendingAttack = null
        const attackStart = this.chips.animEnd + LASER_GAP
        this.deckColorIncoming = null
        if (isKill && this.state.phase === 'choosing-upgrade') {
          // The kill grants an upgrade pick: play only the DEATH now (the figure breaks
          // apart, the bar drains). The replacement's walk-in + shred + fresh deck are
          // deferred until the pick (playArrival) — so the selector shows over an empty
          // table with the old cards still resting. The old cards + round are held in
          // `pendingCeremony` (and `collectRound`) for that later shred.
          const deathEnd = this.playDeath(pa.fromIntegrity, pa.fromShift, pa.toIntegrity, pa.toShift, attackStart)
          this.pendingCeremony = { prevRound, incomingShift: pa.toShift, incomingIntegrity: pa.toIntegrity }
          this.upgradeRevealAt = deathEnd + UPGRADE_REVEAL_LEAD
          this.dealAfter = 0 // the deal waits for the pick, not a timestamp
        } else {
          const attackEnd = this.playAttack(pa.fromIntegrity, pa.fromShift, pa.toIntegrity, pa.toShift, attackStart)
          if (isKill) {
            // A kill with no upgrade to pick (every path maxed): the replacement walks
            // in (part of playAttack), its mouth shreds the old cards while a fresh
            // wrapped deck flies in — no riffle. The next hand waits for the ceremony.
            this.dealAfter = this.beginSpawn(prevRound, pa.toShift, attackEnd - SHRED_ARRIVE_OVERLAP)
          } else {
            // Same dealer, just damaged: gather the cards back + riffle after the laser.
            this.anim.collect(prevRound, attackEnd + GATHER_GAP)
            this.dealAfter = this.anim.animEnd
          }
        }
        // The red muzzle blasts for the laser, then fades. No yellow flare — the
        // tokens already flew on the resolve; the yellow just eases out of its glow.
        this.fireLaser(t, attackStart, isKill)
      } else if (newRun) {
        // A New run: the fresh run's opening dealer walks in and presents a new deck,
        // shredding whatever cards the old run left on the table. No laser (no attack).
        this.pendingAttack = null
        this.deckColorIncoming = null
        this.health.set(integrity, shiftIndex)
        this.dealer.setLevel(integrity, shiftIndex)
        this.dealer.setShift(shiftIndex)
        this.dealer.spawn(t) // a standalone walk-in (no preceding death)
        this.dealAfter = this.beginSpawn(prevRound, shiftIndex, t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP)
      } else {
        // No deferred damage (a losing/pushing hand): gather the cards right away and
        // refresh the health + dealer state now.
        this.anim.collect(prevRound, t)
        this.pendingAttack = null
        this.deckColorIncoming = null
        this.dealAfter = 0
        this.health.sync(prevIntegrity, prevShift, integrity, shiftIndex, t)
        this.dealer.sync(prevIntegrity, prevShift, integrity, shiftIndex, t)
      }
    } else {
      if (this.state.round) {
        this.collectRound = null
      }
      const round = this.state.round
      const ai = prevRound ? prevRound.activeIndex : 0
      // Return pops the most-recently-drawn card off the active hand (one fewer
      // card than before) and auto-stands — the only action that REMOVES a card.
      const returned =
        prevPhase === 'playing' &&
        !!prevRound &&
        !!round &&
        prevRound.hands.length === round.hands.length && // not a split (which also drops a card)
        !!prevRound.hands[ai] &&
        !!round.hands[ai] &&
        round.hands[ai].cards.length === prevRound.hands[ai].cards.length - 1
      const mulliganed = !!prevRound && !prevRound.mulliganed && !!round && round.mulliganed
      const split =
        prevPhase === 'playing' && !!prevRound && prevRound.hands.length === 1 && !!round && round.hands.length === 2
      // Bust Block fired: the shield spends by recording the busting draw it caught
      // in `round.burned`, which is null until then — so a freshly-set `burned` is
      // the shield triggering on this hit.
      const bustBlocked = prevPhase === 'playing' && !!prevRound && !!round && !prevRound.burned && !!round.burned
      this.splitPrev = null // stale after any action; the split branch re-sets it
      this.returnCardData = null
      this.bustBlockData = null
      if (returned && prevRound && round) {
        // Flip the returned card face-down + fly it back onto the deck, THEN a
        // short beat, THEN the dealer reveals its hole and plays out.
        const li = prevRound.hands[ai].cards.length - 1
        const canvas = this.stage.canvas
        const layout = computeLayout(canvas.width, canvas.height)
        this.returnCardData = { card: prevRound.hands[ai].cards[li], from: playerCardCenter(layout, prevRound, ai, li) }
        const returnEnd = this.returnAnim.begin(t)
        this.anim.sync(prevPhase, this.state, returnEnd + RETURN_DEAL_DELAY)
      } else if (mulliganed && prevRound && round) {
        // Toss the old opening cards to the dealer, then deal the fresh pair once
        // they've been swept away.
        const discardEnd = this.mulligan.begin(prevRound.hands[0].cards, t)
        this.anim.redealHand(0, round.hands[0].cards.length, discardEnd)
        // A fresh natural resolves at once — reveal the dealer after the redeal.
        if (this.state.phase !== 'playing') {
          this.anim.sync(prevPhase, this.state, this.anim.animEnd)
        }
      } else if (split && prevRound) {
        // Glide the two originals into the two new hands, then deal each its card.
        this.splitPrev = prevRound
        this.anim.splitHands(t)
        // Split aces resolve at the deal (each hand stands on one card) — schedule
        // the hole flip + dealer draws to follow the glide.
        if (this.state.phase !== 'playing') {
          this.anim.sync(prevPhase, this.state, this.anim.animEnd)
        }
      } else if (bustBlocked && prevRound && round && round.burned) {
        // Reveal the busting card on the active hand's next slot, catch it in the
        // shield, then sweep it off — and only THEN deal any replacement + play the
        // dealer out (anim.sync scheduled from the reveal's end). A Peek Deck card
        // showing (the very card that busted) flips down first, so lead by dealLead.
        const cardIndex = prevRound.hands[ai].cards.length
        this.bustBlockData = { handIndex: ai, cardIndex, card: round.burned }
        const ejectEnd = this.bustBlock.begin(t + dealLead)
        this.anim.sync(prevPhase, this.state, ejectEnd)
      } else {
        // A hit/stand/double: if a Peek Deck card was showing, hold the deal back
        // by the flip-down so the top card flips face-down before it's drawn.
        this.anim.sync(prevPhase, this.state, t + dealLead)
      }
      // A winning hand damages the dealer, but the nexus LASER doesn't fire yet:
      // it's deferred to the Next-hand click, after the token reward (see the
      // Next-hand branch above). The exception is the final kill / game end
      // (phase 'over'), where there's no Next hand — so the attack plays now.
      const damaged = integrity < prevIntegrity || shiftIndex > prevShift
      if (damaged) {
        if (this.state.phase === 'over') {
          const attackStart = this.anim.animEnd
          this.playAttack(prevIntegrity, prevShift, integrity, shiftIndex, attackStart)
          // No Next hand (and no reward tokens) on the final blow: the red muzzle
          // blasts for the laser, then fades. No yellow flare. The last dealer dies,
          // so this is always a kill (shift advanced) — the explosion sound plays.
          this.fireLaser(t, attackStart, shiftIndex > prevShift)
        } else {
          this.pendingAttack = { fromIntegrity: prevIntegrity, fromShift: prevShift, toIntegrity: integrity, toShift: shiftIndex }
          // The nexus now holds a reward + strike to deliver: light both emitters in
          // anticipation and hold the glow until the player calls the next hand. It
          // starts only once the cards have SETTLED (anim.animEnd), not at the
          // action — otherwise a natural blackjack, which resolves right off the
          // deal, would have the nexus charging before the cards even land.
          this.nexus.anticipate(this.anim.animEnd)
        }
      }
      // A late dealer that BEAT the player repairs itself (heal-on-win): integrity
      // rose with no shift change. The YELLOW emitter fires a heal beam and the bar
      // climbs under it, timed just after the lost hand's cards settle — the gentle
      // counterpart to the player's red laser. Skipped on the final hand ('over'):
      // the run is ending, so there's no repair to show.
      const healed = integrity > prevIntegrity && shiftIndex === prevShift
      if (healed && this.state.phase === 'resolved') {
        const healStart = this.anim.animEnd + HEAL_GAP
        this.nexus.heal(healStart)
        this.health.heal(prevIntegrity, prevShift, integrity, shiftIndex, healStart)
        // Steady the eye-flicker to the repaired level (a no-op unless it was low).
        this.dealer.setLevel(integrity, shiftIndex)
        sfx.playHeal(Math.max(0, healStart - t) / 1000)
      }
      // Reward tokens for a surviving hit fly up right away; the win reward is
      // handled below, timed to the chips.
      this.scheduleTokens(prevPhase, prevTokens)
      // On resolve, freeze the bankroll at its pre-settle *available* value (the
      // live bet is on the table); it releases to the new total once the payout
      // chips land on the next hand.
      if (this.syncChips(prevPhase, t)) {
        const bet = this.state.round ? this.state.round.hands.reduce((sum, hand) => sum + hand.bet, 0) : 0
        this.heldChips = prevChips - bet
        // Award the win reward the moment the won chips finish sliding into place
        // beside the bet (chips.animEnd) — no longer deferred to the Next-hand click.
        // Only a normal resolve pays the counter; a final blow ('over') ends the run.
        if (this.state.phase === 'resolved' && this.state.round) {
          this.awardWinTokens(this.state.round, this.chips.animEnd + TOKEN_SPAWN_DELAY)
        }
      } else if (prevPhase === 'betting') {
        this.heldChips = null
      }
    }

    this.syncOverlay(t) // reflect the new state immediately (disable while animating)
    this.lastAnimating =
      this.anim.isAnimating(t) ||
      this.chips.isAnimating(t) ||
      this.spawn.isAnimating(t) ||
      this.bustBlock.isAnimating(t) ||
      this.nexus.isHealing(t)
    this.ensureLoop()
  }

  // Schedule chip motion for whatever the state change implies: a deal places
  // the bet(s); a round resolving flies the winnings in from the house (after
  // the cards settle) but leaves everything resting until the next hand. Returns
  // whether the round resolved (so the bankroll can freeze until the payout moves).
  private syncChips(prevPhase: SessionState['phase'], t: number): boolean {
    const round = this.state.round
    if (!round) {
      return false
    }
    if (prevPhase === 'betting') {
      this.chips.placeBets(round, t)
    }
    const resolvedNow = this.state.phase === 'resolved' || this.state.phase === 'over'
    const wasResolved = prevPhase === 'resolved' || prevPhase === 'over'
    if (resolvedNow && !wasResolved) {
      this.chips.resolve(round, this.anim.animEnd)
      return true
    }
    return false
  }

  // React to the tokens this action just earned. Every token flies from the table
  // nexus (the device damage + rewards originate from). A surviving hit credits +1
  // while play continues, so its token flies right away. A winning resolve's reward
  // is flown by awardWinTokens (timed to the chips), not here. The +40 dealer-kill
  // token is emitted from the nexus in run() (timed to the dealer's destruction).
  private scheduleTokens(prevPhase: SessionState['phase'], prevTokens: number): void {
    const round = this.state.round
    if (!round) {
      return
    }
    const phase = this.state.phase

    // Surviving hit: the only token credited while the hand plays on. It flies
    // from the card that was just dealt (the active hand's last card).
    if (phase === 'playing' && this.state.run.tokens > prevTokens) {
      const canvas = this.stage.canvas
      const layout = computeLayout(canvas.width, canvas.height)
      const amount = this.state.run.tokens - prevTokens
      const liftoff = this.anim.animEnd + TOKEN_SPAWN_DELAY
      // Launch from where the vent floats at liftoff (the device is always bobbing).
      this.tokens.emit(nexusYellowLight(layout, liftoff), amount, liftoff)
      // Pulse the yellow vent as the reward token shoots out of it.
      this.nexus.pulseYellow(liftoff)
      return
    }

    // Final blow: the run is ending, so the last hand's reward is withheld from the
    // count and simply dropped when it resets — never flown to the counter.
    if (phase === 'over' && prevPhase !== 'over') {
      this.heldTokens = winTokensTotal(round)
    }
  }

  // Fly the win/blackjack tokens up to the counter, from the nexus yellow vent,
  // staggered per winning hand so a split's two wins cascade. Called on the resolve
  // once the won chips have slid into place (startAfter = chips settle), so the
  // reward lands right behind the money — no waiting for the Next-hand click.
  private awardWinTokens(round: Round, startAfter: number): void {
    const canvas = this.stage.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    round.hands.forEach((hand, hi) => {
      const amount = winTokenFor(hand, round)
      if (amount > 0) {
        const liftoff = startAfter + hi * TOKEN_HAND_STAGGER
        // From where the vent floats at liftoff (the device bobs continuously).
        this.tokens.emit(nexusYellowLight(layout, liftoff), amount, liftoff)
        // Pulse the yellow vent as the reward shoots out of it.
        this.nexus.pulseYellow(liftoff)
      }
    })
  }

  // Kick off the dealer-spawn ceremony: shred `prevRound`'s table cards into the new
  // dealer's mouth starting at `shredStart`, then fly in a fresh wrapped deck in the
  // incoming dealer's colour (committed to the static table when it lands — see the
  // frame loop). Returns the timestamp the deck is ready, so the next deal can wait.
  private beginSpawn(prevRound: Round, incomingShift: number, shredStart: number): number {
    this.spawnIncomingShift = incomingShift
    // The previous dealer's resting deck moves off the static table onto the cards layer
    // so it can be sucked into the new dealer's mouth; the static deck stays hidden until
    // the fresh one lands + commits (frame settle). Draw it resting there right away.
    this.spawnHasOldDeck = true
    this.deckHidden = true
    const canvas = this.stage.canvas
    this.paintTable(canvas, computeLayout(canvas.width, canvas.height), false)
    const cardCount = prevRound.dealer.length + prevRound.hands.reduce((sum, hand) => sum + hand.cards.length, 0)
    // The final dealer gets the grander, slower deck ceremony.
    return this.spawn.begin(shredStart, cardCount, true, incomingShift >= TOTAL_DEALERS)
  }

  // The front half of an upgrade-granting kill: the laser fires, the dealer breaks
  // apart (no walk-in), the health bar drains, and the +40 bounty flies from the nexus —
  // but the replacement is held back for playArrival. Returns when the figure is gone.
  private playDeath(fromI: number, fromS: number, toI: number, toS: number, startAfter: number): number {
    this.health.drain(startAfter)
    this.dealer.sync(fromI, fromS, toI, toS, startAfter, false, false) // death only, no walk-in
    const canvas = this.stage.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    const liftoff = startAfter + KILL_DEATH_MS
    const bounty = Math.round(DESTROY_TOKEN * tokenMultiplier(this.state.run))
    this.tokens.emit(nexusYellowLight(layout, liftoff), bounty, liftoff)
    return startAfter + KILL_DEATH_MS
  }

  // The back half of an upgrade-granting kill, run when the player picks: after a beat
  // the replacement dealer walks in (its bar refilling), its mouth shreds the old cards
  // + resting deck, and a fresh wrapped deck flies in. The next deal waits for it all.
  private playArrival(t: number): void {
    const c = this.pendingCeremony!
    this.pendingCeremony = null
    this.collectRound = c.prevRound // re-anchor the cards to shred (kept resting till now)
    const walkInStart = t + CEREMONY_LEAD
    this.dealer.setLevel(c.incomingIntegrity, c.incomingShift)
    this.dealer.setShift(c.incomingShift)
    this.dealer.spawn(walkInStart)
    this.health.refill(c.incomingIntegrity, c.incomingShift, walkInStart)
    this.deckColorIncoming = null
    this.dealAfter = this.beginSpawn(c.prevRound, c.incomingShift, walkInStart + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP)
  }

  // Blast the nexus's red muzzle for the laser beam at `attackStart` (from `t`, the
  // action) and fire the attack sounds at their true moments: the laser as it fires,
  // the impact as the beam reaches the dealer (STRIKE_TRAVEL_MS later, damage dealt),
  // and — on a kill — the explosion as the figure blows apart (KILL_DEATH_LEAD_MS in).
  // Centralised so every laser — deferred damage/kill and the final blow — is in step.
  private fireLaser(t: number, attackStart: number, kill: boolean): void {
    this.nexus.fire(t, attackStart, attackStart + HIT_TOTAL_MS, null)
    sfx.play('laser-prepare', Math.max(0, attackStart - t) / 1000)
    sfx.play('laser-impact', Math.max(0, attackStart + STRIKE_TRAVEL_MS - t) / 1000)
    if (kill) {
      sfx.play('dealer-death', Math.max(0, attackStart + KILL_DEATH_LEAD_MS - t) / 1000)
    }
  }

  // Fire the nexus laser at the dealer for a damage/kill, starting at `startAfter`.
  // Returns when the sequence finishes — a plain hit, or the full death → walk-in
  // → recharge on a kill — so the next deal can wait for it. The +40 kill token
  // flies from the nexus once the old dealer is fully destroyed.
  private playAttack(fromI: number, fromS: number, toI: number, toS: number, startAfter: number): number {
    const final = this.state.run.won || toS > TOTAL_DEALERS
    this.health.sync(fromI, fromS, toI, toS, startAfter)
    this.dealer.sync(fromI, fromS, toI, toS, startAfter, final)
    if (toS > fromS) {
      const canvas = this.stage.canvas
      const layout = computeLayout(canvas.width, canvas.height)
      const liftoff = startAfter + KILL_DEATH_LEAD_MS + KILL_DYING_MS
      // The kill bounty flies scaled by the Token eco multiplier, matching the
      // credited amount (run.ts). The upgrade pick comes after this, so the current
      // run's multiplier is the one that applied to this bounty.
      const bounty = Math.round(DESTROY_TOKEN * tokenMultiplier(this.state.run))
      this.tokens.emit(nexusYellowLight(layout, liftoff), bounty, liftoff)
      return startAfter + KILL_TOTAL_MS
    }
    return startAfter + HIT_TOTAL_MS
  }

  // Sync overlay text + button state. While cards are in motion, buttons are
  // disabled and the result message is withheld until the sequence settles.
  private syncOverlay(timestamp: number): void {
    const s = this.state
    // The dealer-death pause + spawn ceremony (walk-in, shred, fresh deck) block
    // input the same way card motion does: all buttons disabled and the result
    // message withheld until the sequence ends.
    const animating =
      this.anim.isAnimating(timestamp) ||
      this.dealer.isBlocking(timestamp) ||
      this.dealer.isArriving(timestamp) ||
      this.spawn.isAnimating(timestamp) ||
      this.bustBlock.isAnimating(timestamp) ||
      this.nexus.isHealing(timestamp)

    // Point the counter at its current value (tokens still flying are withheld);
    // the frame loop rolls it up as they land.
    this.updateTokenCounter(timestamp)
    this.messageEl.textContent = animating ? '' : this.buildMessage()
    this.hintEl.textContent = animating ? '' : this.buildHint()
    this.syncUpgradePanel(s, animating, timestamp)

    // Token inflation: show the running "prices +X%" (only once it has risen), and
    // let the cost pills below reflect it.
    const inflationPct = Math.round(s.run.tokenInflation * 100)
    this.inflationEl.textContent = `prices +${inflationPct}%`
    this.inflationEl.classList.toggle('is-hidden', inflationPct <= 0)

    for (const def of this.defs) {
      const button = this.buttons[def.key]
      const visible = def.visible(s)
      button.classList.toggle('is-hidden', !visible)
      // Armed powerups glow; using the shield clears the armed flag, which drops
      // the class here on the next sync and returns the button to normal.
      button.classList.toggle('is-active', visible && !!def.active?.(s))
      // Powerups are locked during the Dealer 6 duel (< 20% health): disable them and
      // swap the cost pill for a red ✕ (via the is-locked class, styled in CSS).
      const duelLocked = def.group === 'power' && s.abilitiesLocked
      button.classList.toggle('is-locked', duelLocked)
      button.disabled = animating || duelLocked || (visible && !def.enabled(s))
      // Flag a priced-out move (Double/Split disabled only for lack of chips). Hidden
      // while animating, or when the move is illegal for any other reason.
      const badge = this.nsfBadges[def.key]
      if (badge) {
        badge.classList.toggle('is-hidden', animating || !visible || !def.shortFunds?.(s))
      }
      // Powerup cost pills show the live (inflated) price the spend path will charge.
      const pill = this.costPills[def.key]
      if (pill && def.cost !== undefined) {
        pill.textContent = String(powerupCost(def.cost, s.run))
      }
    }
  }

  // Show/hide the choose-upgrade card and swap the normal HUD columns out while it's
  // up. The card appears once the dealer's death settles and its reveal beat passes;
  // each path button shows the effect it would unlock next, and a maxed path's
  // button is hidden. No indication of what's already been picked — by design.
  private syncUpgradePanel(s: SessionState, animating: boolean, timestamp: number): void {
    // While a pick's dismiss animation is playing, let it own the panel — don't
    // re-toggle is-hidden / the buttons out from under the fade + scale. The columns
    // stay hidden too (still choosing-upgrade until pickUpgrade commits the pick).
    if (this.upgradeDismissing) {
      return
    }
    const choosing = s.phase === 'choosing-upgrade'
    // The card surfaces only once the death has finished AND a beat has passed
    // (upgradeRevealAt) — so it doesn't pop up over the dealer breaking apart.
    const reveal = choosing && !animating && timestamp >= this.upgradeRevealAt
    if (reveal && !this.upgradeShown) {
      sfx.play('upgrade-menu')
    }
    this.upgradeShown = reveal
    this.upgradeEl.classList.toggle('is-hidden', !reveal)
    this.powersEl.classList.toggle('is-hidden', choosing)
    this.actionsEl.classList.toggle('is-hidden', choosing)
    if (!choosing) {
      return
    }
    for (const { info, btn, effectEl } of this.upgradeButtons) {
      const label = nextTierLabel(info, s.run.upgrades[info.path])
      btn.classList.toggle('is-hidden', label === null)
      if (label !== null) {
        effectEl.textContent = label
      }
    }
  }

  private buildMessage(): string {
    const { phase, run } = this.state
    if (phase === 'betting') {
      const bet = nextBet(run)
      return isLastCall(run) ? `Last call — all in (${bet})` : `Bet ${bet}`
    }
    // The win/loss/push result is drawn on the canvas beside the winning count.
    if (phase === 'over') {
      return run.won
        ? `You dismantled all ${TOTAL_DEALERS} dealers — score ${run.score}`
        : `The house shuts you down — score ${run.score}`
    }
    return ''
  }

  private buildHint(): string {
    const { phase, round, foresightCard } = this.state
    if (phase !== 'playing' || !round) {
      return ''
    }
    const parts: string[] = []
    if (foresightCard) {
      parts.push(`Next: ${cardLabel(foresightCard)}`)
    }
    if (round.secondChanceArmed) {
      parts.push('Bust Block armed')
    }
    if (round.dealerFrozen) {
      parts.push('Dealer frozen')
    }
    if (round.burned) {
      parts.push(`Burned: ${cardLabel(round.burned)}`)
    }
    return parts.join(' · ')
  }
}

// A single hand's result label + tone, from its settled outcome and net chips.
function handResultLabel(hand: PlayerHand, rules: RoundRules): RoundResult {
  const net = handNet(hand, rules)
  if (hand.outcome === 'blackjack') {
    return { label: `Blackjack +${net}`, tone: 'win' }
  }
  if (net > 0) {
    return { label: `Win +${net}`, tone: 'win' }
  }
  if (net < 0) {
    return { label: hand.outcome === 'bust' ? `Bust ${net}` : `Lose ${net}`, tone: 'lose' }
  }
  return { label: 'Push', tone: 'push' }
}

// The reward tokens a settled hand earns (0 for a loss/push), scaled by how it
// won (see rewards.ts) — so the flown count matches what run.ts actually credits.
// The +40 dealer-kill token isn't counted here — it isn't part of the flown,
// withheld reward (see scheduleTokens).
function winTokenFor(hand: PlayerHand, round: Round): number {
  return handReward(hand, round).tokens
}

function winTokensTotal(round: Round): number {
  return round.hands.reduce((total, hand) => total + winTokenFor(hand, round), 0)
}

function affordsExtra(s: SessionState): boolean {
  const round = s.round
  if (!round) {
    return false
  }
  const exposure = round.hands.reduce((total, hand) => total + hand.bet, 0)
  const activeBet = round.hands[round.activeIndex].bet
  return s.run.chips >= exposure + activeBet
}

function cardLabel(card: Card): string {
  return `${card.rank}${SUIT_SYMBOLS[card.suit]}`
}

function now(): number {
  return performance.now()
}

function yes(): boolean {
  return true
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

// A fresh <img> for the token icon. Every instance shares the one imported
// (fingerprinted) URL, so the browser downloads the asset a single time no
// matter how many pills/counters reference it.
function powerIcon(className: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = powerUrl
  img.className = className
  img.alt = ''
  img.setAttribute('aria-hidden', 'true')
  return img
}

// Whether the player can afford a powerup at its current (inflated) price.
function affords(baseCost: number, s: SessionState): boolean {
  return s.run.tokens >= powerupCost(baseCost, s.run)
}

// A powerup's "locked" pill: a red ✕ in the same bottom-right corner as the cost pill,
// hidden until the Dealer 6 duel (< 20% health) locks abilities. CSS shows it — and
// hides the cost pill — while the button carries the is-locked class.
function lockPill(): HTMLElement {
  const pill = element('span', 'lock-pill')
  pill.textContent = '✕'
  pill.title = 'Locked — final duel'
  return pill
}

// A powerup's cost pill: "<cost> <icon>", pinned to the button's bottom-right. The
// number starts at the base price and is rewritten to the inflated price each frame.
function costPill(cost: number): HTMLElement {
  const pill = element('span', 'cost-pill')
  const num = element('span', 'cost-pill__num')
  num.textContent = String(cost)
  pill.append(num, powerIcon('cost-pill__icon'))
  return pill
}

// A "not enough chips" badge: a white ✕ on red, tucked into a move button's
// bottom-left corner. Starts hidden; syncOverlay reveals it when Double/Split is
// disabled purely because the bankroll can't cover the extra bet.
function nsfBadge(): HTMLElement {
  const badge = element('span', 'nsf-badge is-hidden')
  badge.textContent = '✕'
  badge.title = 'Not enough chips'
  return badge
}

function generateSeed(): number {
  return Math.floor(Math.random() * 0x100000000)
}
