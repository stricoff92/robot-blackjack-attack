import './game-view.css'

import { readDebugFlags } from '../game/debug'
import type { Card, Suit } from '../game/deck'
import { POWERUPS } from '../game/powerups'
import { canDouble, canForcedSplit, canMulligan, canReturn, canSplit, handNet, type PlayerHand, type Round, type RoundRules } from '../game/round'
import { handReward } from '../game/rewards'
import { comboMultiplier, dealerHardHitCeiling, DESTROY_TOKEN, getShift, isLastCall, nextBet, powerupCost, tokenMultiplier, TOTAL_DEALERS } from '../game/run'
import { Session, SHOE_DECKS, type SessionState } from '../game/session'
import { nextTierLabel, rulesForUpgrades, UPGRADE_PATHS, type UpgradePath, type UpgradePathInfo } from '../game/upgrades'
import { getCardSprite, setCardBack } from '../render/card-sprite'
import type { LayeredCanvas } from '../render/canvas'
import { ANALYSIS_STRIKE_MS, drawAnalysis, drawBustBlock, drawHands, drawMulliganDiscard, drawPeekCard, drawReturnCard, drawShoe, drawShuffle, playerCardCenter, shoeAnchor, SHUFFLE_SPLIT_FRACTION, type RoundResult } from '../render/cards'
import { onChipImageReady } from '../render/chip-sprite'
import { drawChips, drawTableMarkings } from '../render/chips'
import { drawDamageFx } from '../render/damage-fx'
import { drawDealer, drawDealerEyeGlow } from '../render/dealer'
import { drawHoloRays, drawStrikeFx, nexusYellowLight, type HoloRayTarget } from '../render/nexus'
import { dealerColors, isRgbDealer } from '../render/palette'
import { Scene, computeLayout, type Layout } from '../render/scene'
import { drawSpecSheet, SPEC_STRIKE_MS, type SpecFlag, type SpecReadout } from '../render/spec-sheet'
import { drawScoreSheet, type ScoreReadout } from '../render/score-sheet'
import { drawComboProjection, type ComboProjection } from '../render/combo-projection'
import { drawOldDeckShred, drawShred, drawSpawnDeck, SHEET_SLIDE_START } from '../render/spawn'
import { drawTokens, type Point } from '../render/tokens'
import { ChipAnimation } from './chip-animator'
import { CountTicker } from './count-ticker'
import { BustBlockAnimation } from './bust-block-animator'
import { DealAnimation } from './deal-animator'
import { DealerAnimation, HIT_TOTAL_MS, KILL_ARRIVE_MS, KILL_DEATH_LEAD_MS, KILL_DEATH_MS, KILL_DYING_MS, KILL_TOTAL_MS, STRIKE_TRAVEL_MS } from './dealer-animator'
import { SpawnAnimation } from './spawn-animator'
import { MulliganAnimation } from './mulligan-animator'
import { NexusAnimation } from './nexus-animator'
import { PeekFlipAnimation, PEEK_FLIP_MS } from './peek-animator'
import { ReturnAnimation } from './return-animator'
import { FLY_MS, TokenAnimation } from './token-animator'
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
// the betting circle well below the cards, so nothing overlaps at rest. 'fx'
// carries the nexus laser strike (above the table + cards, below the reward tokens
// that fly up to the counter). The 'mask' layer is on top of everything: a darkness
// that the Analyze projection lights through, and the dealer's emissive eye glow
// (the HTML button/counter overlay sits above it, so those stay bright).
const LAYERS = ['back', 'dealer', 'table', 'cards', 'chips', 'fx', 'tokens', 'mask'] as const

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

// How long the info-button spec-sheet projection takes to flicker out when toggled off
// (mirror of the strike-on; see specRender + render/spec-sheet.ts).
const SPEC_FADE_MS = 320

// The nexus's combo-multiplier projection (middle of the felt, on a hit): how long the
// number rolls from its old value to the new one, how long it holds, and the fade-out.
const COMBO_TICK_MS = 380
const COMBO_HOLD_MS = 780
const COMBO_PROJ_FADE_MS = 340

// How many light rays the holo projector fans onto each number it projects.
const HOLO_RAYS_PER = 5

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
// Game over: beat after the ending hand's cards settle before the dealer sucks them up
// and shreds them (a win → laser death; a loss → walk-off), then projects the score.
const END_SHRED_GAP = 200
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
  // The points counter rolls UP only. It's held at its pre-resolve value (heldScore)
  // from the moment a hand resolves until that hand's reward tokens land at the token
  // counter, then released to run.score — so points always rise AFTER the token reward,
  // never before. `pendingScoreDelta` is the "+N" flashed underneath on release;
  // `scoreReleaseAt` is a fallback so a token-less win (a chips-only push) still ticks.
  private readonly scoreTicker = new CountTicker()
  private heldScore: number | null = null
  private pendingScoreDelta = 0
  // The combo multiplier that produced this reward — carried to the release so the middle-
  // of-felt projection can show "base +N / ×mult" as the effective points tick into the
  // total top-right. 1 = no combo (projection just shows the base).
  private pendingMult = 1
  private scoreReleaseAt = 0
  // The combo multiplier the nexus is projecting into the middle of the felt on a HIT, or
  // null when nothing is up. It ticks `from`→`to` up (tone 'up') on a survived hit, or back
  // to ×1.00 ('down') on a bust. Nothing shows until `startAt` — the drawn card's settle
  // (anim.animEnd) — so it never reveals the outcome before the flip. From startAt it ticks
  // over COMBO_TICK_MS, holds to `hideAt`, then fades COMBO_PROJ_FADE_MS. (Hand-end points
  // are NOT projected — that read as chips; they show as the top-right "+base ×mult" delta.)
  private comboProj: {
    from: number
    to: number
    tone: ComboProjection['tone']
    startAt: number
    hideAt: number
  } | null = null
  // Edge tracker: true while the points counter is mid-roll, so the ticking sound fires
  // once when a roll starts (not every frame it runs).
  private pointsRolling = false
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
  // The info-button spec sheet the nexus projects onto the felt (token inflation + the
  // active ruleset). `specShownAt` is when it was toggled on (drives the flicker-in);
  // `specHideStart` when it was toggled off (drives the mirror flicker-out). At most one
  // is non-null — both null means nothing is projected. See toggleSpec / specRender.
  private specShownAt: number | null = null
  private specHideStart: number | null = null
  // Game-over score screen: `scoreRevealAt` is when the nexus starts projecting the run
  // summary (once the ending cards are sucked up) — 0 until scheduled; `scoreRevealed`
  // latches true at that moment (edge → re-sync so the New-run button appears). See
  // beginEndGame / scoreRender. `endShredDone` suppresses the settled-card redraw so the
  // shredded cards stay gone. `spawnShredOnly` marks a shred with no fresh deck flying in.
  private scoreRevealAt = 0
  private scoreRevealed = false
  private endShredDone = false
  private spawnShredOnly = false
  // Every projected-number box actually drawn this frame (counts, chip amounts, analysis
  // rows). The number-drawing calls append here, and drawHoloProjection fires a ray fan at
  // each — so a ray exists iff its number is on screen, at exactly its position. Cleared at
  // the top of drawCards (the first draw of the frame); read in drawMask (after drawChips).
  private frameProjections: HoloRayTarget[] = []
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
  // Last values written to the token counter's DOM, so updateTokenCounter can skip the
  // write when nothing changed (it's called every frame).
  private lastTokenText = ''
  private lastTokenTransform = ''
  private messageEl!: HTMLElement
  private hintEl!: HTMLElement
  private buttons!: Record<string, HTMLButtonElement>
  // Per-button "not enough chips" badges (Double/Split), toggled in syncOverlay.
  private nsfBadges!: Record<string, HTMLElement>
  // Per-powerup cost-pill number spans, rewritten each frame to the inflated price.
  private costPills!: Record<string, HTMLElement>
  // The arcade points counter (top-right): the number span (swelled as it rolls), the
  // "+N" delta that flashes underneath each time it starts ticking, and a caption below
  // that that fades in/out with the delta ("Double!", risk taunts…).
  private pointsCountEl!: HTMLElement
  private pointsDeltaEl!: HTMLElement
  private pointsCommentEl!: HTMLElement
  // Last values written to the points counter's DOM, so updatePointsCounter can skip the
  // write when nothing changed (it's called every frame, like the token counter).
  private lastPointsText = ''
  private lastPointsTransform = ''
  // The info button beside the dealer's head: toggles the nexus's spec-sheet projection.
  private infoBtnEl!: HTMLButtonElement
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
    this.scoreTicker.set(this.displayedScore())
    // Seed the dealer to the opening integrity so a dealer that starts partway damaged
    // (the dealerHealth dev override) shows the right eye flicker + damage sparks from the
    // first frame — the first deal doesn't sync it (no damage yet).
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
  // and death debris tuck behind the table. A wounded dealer (< 75% health) also sparks
  // and smokes here — the diegetic replacement for the old health bar — over the figure
  // but still behind the rail, so downward sparks tuck away like the lower body does.
  private drawDealerFigure(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.dealer.ctx
    drawDealer(ctx, layout, this.dealer, timestamp)
    // Only while the figure is STANDING at its home spot — the burst origins are the
    // resting figure, so sparks must not show while it's dying, walking in, or off.
    if (this.dealerStanding(timestamp)) {
      drawDamageFx(ctx, layout, this.dealer.damageBursts(timestamp))
    }
  }

  // The dealer is upright at its mark (not mid-death, walk-in, or walk-off) — the only
  // time the health-driven damage sparks track the figure, so the only time they draw.
  private dealerStanding(now: number): boolean {
    return (
      this.dealer.alive(now) &&
      this.dealer.dying(now) === null &&
      this.dealer.arriving(now) === null &&
      this.dealer.leaving(now) === null
    )
  }

  // The fx layer: the floating nexus device body (hovering with the frame clock),
  // its emitter-light charge glow, and the laser strike (beam + muzzle flash +
  // impact sparks) — all drawn together since they share the device's bobbing muzzle.
  private drawFx(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const charge = {
      red: this.nexus.redLight(timestamp),
      heal: this.nexus.healLight(timestamp),
      yellow: this.nexus.yellowLight(timestamp),
      holo: 1, // the holo projector is always on
      chargeUp: this.nexus.chargeUp(timestamp),
      healBeam: this.nexus.healBeam(timestamp),
    }
    drawStrikeFx(canvas.layers.fx.ctx, layout, this.dealer, charge, timestamp)
  }

  // The only per-frame work: clear + repaint the cards layer.
  private drawCards(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.cards.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    // Start the frame's projected-number collection fresh; drawHands / drawAnalysis (here)
    // and drawChips (next) append to it, and drawMask fires the ray fans at it. Reuse the
    // array (truncate, don't reallocate) so a settled frame produces no garbage here.
    this.frameProjections.length = 0
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
      // A game-over shred flies no fresh deck in — it just chews the table cards.
      if (!this.spawnShredOnly) {
        drawSpawnDeck(ctx, layout, dealerColors(shift, timestamp).back, this.spawn, timestamp)
      }
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
    } else if (this.rgbActive() && !this.deckHidden) {
      // The RGB dealer's resting deck stays on this per-frame layer so its colour keeps
      // cycling (the static table layer would freeze it between repaints). Suppressed while
      // the deck is hidden (a ceremony flew/shredded it) — otherwise at game over, once the
      // shred finishes, this branch would redraw the just-shredded RGB deck (it reappears).
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

    // During a dealer-spawn ceremony the ending round's cards are being sucked into the new
    // dealer's mouth + shredded (drawn here), not laid out settled. But NOT while the deal
    // animator is still flying cards in: at game over `beginEndGame` schedules the shred the
    // same frame the final hand resolves, so `spawn.isAnimating` goes true before those cards
    // (the dealer's draw-out, or a busting card) have flown from the deck. Keep drawing them
    // via drawHands until they settle (anim idle), then the shred takes over — same card
    // positions (tableCards ≡ drawHands), so no pop. (Normal ceremonies run with anim idle.)
    if (this.spawn.isAnimating(timestamp) && this.collectRound && !this.anim.isAnimating(timestamp)) {
      drawShred(ctx, layout, this.collectRound, this.spawn, timestamp)
    } else if (!this.endShredDone) {
      // Fall back to the retained ending round while its cards are gathering / flying in.
      // Skipped once a game-over shred has finished — those cards were sucked up and stay gone.
      const round = this.state.round ?? this.collectRound
      if (round) {
        const revealHole = this.state.phase !== 'playing' || this.state.peeked
        this.frameProjections.push(
          ...drawHands(ctx, layout, round, revealHole, timestamp, this.anim, this.handResults(timestamp), this.splitPrev ?? undefined),
        )
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
      this.frameProjections.push(...drawAnalysis(ctx, layout, ar.a, ar.age, ar.fade, timestamp))
    }

    // The info-button spec sheet the nexus projects: the ruleset + token inflation,
    // centred on the felt, flickering in like the Analyze readout. Its panel box goes
    // into frameProjections so the holo lens fans its rays onto it (drawMask).
    const sr = this.specRender(timestamp)
    if (sr) {
      this.frameProjections.push(...drawSpecSheet(ctx, layout, sr.spec, sr.age, sr.fade, timestamp))
    }

    // The game-over score screen the nexus projects once the cards are sucked up. Its box
    // joins frameProjections so the holo lens fans its rays onto it, like the spec sheet.
    const scr = this.scoreRender(timestamp)
    if (scr) {
      this.frameProjections.push(...drawScoreSheet(ctx, layout, scr.readout, scr.age, 1, timestamp))
    }

    // The combo multiplier the nexus projects big in the middle of the felt — ticking up on
    // a hit, down on a bust, or holding a hand's "base +N / ×mult" payout.
    const cp = this.comboProjRender(timestamp)
    if (cp) {
      this.frameProjections.push(...drawComboProjection(ctx, layout, cp.proj, cp.age, cp.fade, timestamp))
    }
  }

  // The top overlay layer (additive light, no scene dimming): the dealer's emissive
  // eye glow, plus the 5-ray fans the always-on holo projector casts onto every readout.
  // (The holo lens's own glow lives on the fx layer, drawn by drawStrikeFx.)
  private drawMask(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.mask.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    drawDealerEyeGlow(ctx, layout, this.dealer.eyeGlow(timestamp))
    this.drawHoloProjection(ctx, layout, timestamp)
  }

  // The holo projector casts a fan of HOLO_RAYS_PER white rays onto every projected
  // number that was ACTUALLY drawn this frame — `frameProjections` is the single source
  // of truth (populated by drawHands / drawChips / drawAnalysis as they draw each number),
  // so a ray fan exists iff its number is on screen, at exactly its position. No ray can
  // lead or lag its number. Each fan gets its own seed so their flicker stays independent.
  private drawHoloProjection(ctx: CanvasRenderingContext2D, layout: Layout, timestamp: number): void {
    this.frameProjections.forEach((box, i) => drawHoloRays(ctx, layout, box, HOLO_RAYS_PER, timestamp, i * 1000))
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

  // The spec sheet to paint this frame (flickering in, or out on dismiss), with the age
  // + fade the panel/text share — or null when nothing's projected. The data is rebuilt
  // each frame (cheap: it's only up when toggled, and the state is static meanwhile).
  private specRender(timestamp: number): { spec: SpecReadout; age: number; fade: number } | null {
    if (this.specShownAt !== null) {
      return { spec: this.buildSpec(), age: timestamp - this.specShownAt, fade: 1 }
    }
    if (this.specHideStart !== null) {
      const life = 1 - (timestamp - this.specHideStart) / SPEC_FADE_MS
      if (life <= 0) {
        this.specHideStart = null
        return null
      }
      // Rewind the strike age (mirror flicker) and fade to nothing on dismiss.
      return { spec: this.buildSpec(), age: SPEC_STRIKE_MS * life, fade: life }
    }
    return null
  }

  // The game-over score screen to project this frame, or null until the ending cards have
  // been sucked up (scoreRevealAt). It only flickers IN — it stays up until the New run
  // resets the phase, so there's no dismiss/fade-out to mirror.
  private scoreRender(timestamp: number): { readout: ScoreReadout; age: number } | null {
    if (this.state.phase !== 'over' || this.scoreRevealAt <= 0 || timestamp < this.scoreRevealAt) {
      return null
    }
    return { readout: this.buildScore(), age: timestamp - this.scoreRevealAt }
  }

  // The run summary the score screen shows: the outcome heading (VICTORY on a win — every
  // dealer beaten — else BANKRUPT), the final points, hands played, the win/loss tally
  // (pushes count as neither), and tokens spent on powerups.
  private buildScore(): ScoreReadout {
    const run = this.state.run
    return {
      title: run.won ? 'VICTORY' : 'BANKRUPT',
      rows: [
        { label: 'POINTS', value: String(run.score) },
        { label: 'HANDS PLAYED', value: String(run.handsPlayed) },
        { label: 'WIN / LOSS', value: `${run.handsWon} / ${run.handsLost}` },
        { label: 'TOKENS SPENT', value: String(run.tokensSpent) },
      ],
    }
  }

  // Build the projected ruleset: the token inflation plus the dealer's active house
  // rules and the player's roguelite mods, as abbreviated feature flags (CPU-style).
  // Uses the live round's rules when a hand is up, else the rules the next deal will
  // apply (so it reads correctly at the betting screen too).
  private buildSpec(): SpecReadout {
    const { run, round } = this.state
    const shiftIndex = Math.min(run.shiftIndex, TOTAL_DEALERS)
    const shift = getShift(shiftIndex)
    const rules =
      round?.rules ??
      ({
        ...rulesForUpgrades(run.upgrades),
        dealerSoft17: shift.dealerSoft17,
        dealerHardHitCeiling: dealerHardHitCeiling(run),
      } as RoundRules)

    const flags: SpecFlag[] = []
    const house = (text: string): void => void flags.push({ text, kind: 'house' })
    const player = (text: string): void => void flags.push({ text, kind: 'player' })

    // Table baseline + the dealer's draw rules.
    house(`${SHOE_DECKS}DECK`)
    house('H16') // the dealer always hits a hard 16 or below
    if (rules.dealerSoft17 === 'hit') {
      house('H17')
    } else if (rules.dealerSoft17 === 'smart') {
      house('H17_when_behind')
    } else {
      house('S17')
    }
    // The final dealer's desperation hard-hit ceiling (17 normally; rises as it's wounded).
    if (rules.dealerHardHitCeiling > 17) {
      house(`H${rules.dealerHardHitCeiling}_when_behind`)
    }
    // Blackjack payout — a house baseline unless a Payout upgrade lifts it in the
    // player's favour (then it reads as a green player mod).
    const bj = `BJ_${rules.blackjackPayoutNumerator}:${rules.blackjackPayoutDenominator}`
    if (rules.blackjackPayoutNumerator / rules.blackjackPayoutDenominator > 1.5) {
      player(bj)
    } else {
      house(bj)
    }
    if (rules.allowSplit) {
      house('SPLIT_TO_4') // may split/resplit up to 4 hands (round.ts MAX_HANDS)
    }
    // Heal-on-win: a late dealer repairs this HP range whenever it beats the player.
    if (shift.healOnWin[1] > 0) {
      house(`HEAL_ON_WIN_${shift.healOnWin[0]}-${shift.healOnWin[1]}`)
    }
    if (shift.minBetPct > 0) {
      house(`BET_FLOOR_${Math.round(shift.minBetPct * 100)}%`)
    }
    if (this.state.abilitiesLocked) {
      house('NO_ABILITIES')
    }

    // Player roguelite mods (Sabotage / Payout / Tokens), all working in the player's
    // favour — drawn in green.
    if (rules.dealerNaturalRefundRatio > 0) {
      player(`REFUND_${Math.round(rules.dealerNaturalRefundRatio * 100)}%`)
    }
    if (rules.voidDealer21) {
      player('VOID_D21')
    }
    if (rules.hijackDealerNatural) {
      player('HIJACK_BJ')
    }
    if (rules.pushWinsToPlayer) {
      player('PUSH_WINS')
    }
    if (rules.tokenMultiplier > 1) {
      // ×1.10 → "TOKEN_x1.1", ×1.18 → "TOKEN_x1.18" (drop a trailing zero).
      player(`TOKEN_x${rules.tokenMultiplier.toFixed(2).replace(/0$/, '')}`)
    }
    if (run.upgrades.tokenEco > 0) {
      player('INFLATION_RESIST')
    }

    return { inflation: `+${Math.round(run.tokenInflation * 100)}%`, flags }
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
    this.frameProjections.push(...drawChips(ctx, layout, { chips, chipsScale, round }, this.chips, timestamp))
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
    // This runs every frame (even at rest). Only touch the DOM when the value or swell
    // actually changes, so a settled counter isn't rewriting its text node + transform
    // 60×/sec (each write invalidates style/layout).
    const text = String(this.tokenTicker.value(now))
    if (text !== this.lastTokenText) {
      this.tokenCountEl.textContent = text
      this.lastTokenText = text
    }
    const scale = this.tokenTicker.scale(now)
    const transform = scale === 1 ? '' : `scale(${scale})`
    if (transform !== this.lastTokenTransform) {
      this.tokensEl.style.transform = transform
      this.lastTokenTransform = transform
    }
  }

  // The points to show: the pre-resolve value while a reward is still landing (heldScore),
  // otherwise the live run total. The ticker rolls up to whatever this returns.
  private displayedScore(): number {
    return this.heldScore ?? this.state.run.score
  }

  // Point the score counter at what should be shown now, then paint the ticker's value +
  // swell — mirrors updateTokenCounter. Called every frame and on each state sync.
  private updatePointsCounter(now: number): void {
    this.scoreTicker.retarget(this.displayedScore(), now)
    // A roll just began — play the ticking flutter for exactly as long as it runs. The
    // edge flag keeps it to one play per roll (this runs every frame + on each sync).
    const rolling = this.scoreTicker.isAnimating(now)
    if (rolling && !this.pointsRolling) {
      sfx.playPointsRoll(this.scoreTicker.remainingMs(now))
    }
    this.pointsRolling = rolling
    const text = String(this.scoreTicker.value(now))
    if (text !== this.lastPointsText) {
      this.pointsCountEl.textContent = text
      this.lastPointsText = text
    }
    const scale = this.scoreTicker.scale(now)
    const transform = scale === 1 ? '' : `scale(${scale})`
    if (transform !== this.lastPointsTransform) {
      this.pointsCountEl.style.transform = transform
      this.lastPointsTransform = transform
    }
  }

  // Hold the points counter frozen at `prevScore` until the reward tokens land, then it
  // releases to run.score with a "+delta" flash (the EFFECTIVE, already-multiplied points).
  // `mult` is the combo that produced it — carried for the middle-of-felt reward projection,
  // NOT the top-right (which shows total + effective delta only). `releaseAt` is a fallback
  // in case no token ever lands to trigger the release (a chips-only win).
  private holdScoreReward(prevScore: number, delta: number, mult: number, releaseAt: number): void {
    this.heldScore = prevScore
    this.pendingScoreDelta = delta
    this.pendingMult = mult
    this.scoreReleaseAt = releaseAt
  }

  // Release the held score: the reward tokens have landed, so let the counter roll up to
  // run.score (the effective total) and flash the "+base ×mult" breakdown top-right.
  private releaseHeldScore(): void {
    const delta = this.pendingScoreDelta
    const mult = this.pendingMult
    this.heldScore = null
    this.pendingScoreDelta = 0
    this.pendingMult = 1
    this.scoreReleaseAt = 0
    if (delta > 0) {
      this.flashPointsDelta(delta, mult)
    }
  }

  // Flash the reward top-right: the BASE points (white) with the combo "×mult" (yellow) that
  // multiplied them — "+200 ×1.5" — while the counter above ticks up by the effective total
  // (base × mult). `delta` is the effective gain, so base = round(delta / mult). Fades + pops
  // via the .is-flashing keyframes; restart the animation (drop class → reflow → re-add) so
  // back-to-back rewards replay instead of freezing.
  private flashPointsDelta(delta: number, mult: number): void {
    const base = mult > 1 ? Math.round(delta / mult) : delta
    this.pointsDeltaEl.textContent = `+${base}`
    if (mult > 1) {
      const mx = element('span', 'hud-points__mult')
      mx.textContent = `  ×${mult.toFixed(2)}`
      this.pointsDeltaEl.appendChild(mx)
    }
    restartAnimation(this.pointsDeltaEl, 'is-flashing')
    // The old risk/Double caption line is retired — keep it clear if a prior one lingers.
    this.pointsCommentEl.classList.remove('is-flashing')
  }

  // Project a hit's combo tick into the middle of the felt: the multiplier rolls `from`→`to`
  // ('up' on a survived hit, 'down' to ×1.00 on a bust). Held back until `startAt` — the
  // drawn card's settle — so it never spoils the outcome before the flip. Then holds + fades.
  private showComboTick(from: number, to: number, tone: 'up' | 'down', startAt: number): void {
    this.comboProj = { from, to, tone, startAt, hideAt: startAt + COMBO_TICK_MS + COMBO_HOLD_MS }
  }

  // Trigger a combo tick from a state change: a surviving hit grew the combo (tick up), or a
  // bust reset it (tick down to ×1.00). Held back to the card's settle (anim.animEnd, or now
  // if already settled) so it doesn't reveal survived/busted before the card flips. Skips
  // New-run/game-over transitions (prevPhase/phase 'over'), which zero the combo silently.
  private updateComboProjection(prevCombo: number, prevPhase: SessionState['phase'], now: number): void {
    const combo = this.state.run.combo
    const startAt = Math.max(now, this.anim.animEnd) // after the drawn card is revealed
    if (combo > prevCombo) {
      this.showComboTick(comboMultiplier(prevCombo), comboMultiplier(combo), 'up', startAt)
    } else if (combo < prevCombo && prevPhase !== 'over' && this.state.phase !== 'over') {
      this.showComboTick(comboMultiplier(prevCombo), comboMultiplier(0), 'down', startAt)
    }
  }

  // The combo projection to paint this frame (multiplier ticked toward its target, plus the
  // strike-in age + fade), or null when it hasn't appeared yet (before startAt), nothing is
  // up, or the game-over score sheet owns the felt. Clears itself once the fade-out completes.
  private comboProjRender(now: number): { proj: ComboProjection; age: number; fade: number } | null {
    const p = this.comboProj
    if (!p || this.state.phase === 'over' || now < p.startAt) {
      return null
    }
    let fade = 1
    if (now >= p.hideAt) {
      fade = 1 - (now - p.hideAt) / COMBO_PROJ_FADE_MS
      if (fade <= 0) {
        this.comboProj = null
        return null
      }
    }
    const tickT = Math.min(1, Math.max(0, (now - p.startAt) / COMBO_TICK_MS))
    const eased = 1 - (1 - tickT) * (1 - tickT) * (1 - tickT) // smoothEnd3 (ease-out)
    const mult = p.from + (p.to - p.from) * eased
    return { proj: { mult, tone: p.tone }, age: now - p.startAt, fade }
  }

  // Animation loop: runs while cards are in motion, then parks itself. Only the
  // cards layer is touched; the overlay is synced only on the animate→idle edge.
  private readonly frame = (timestamp: number): void => {
    this.anim.setNow(timestamp)
    // Game over: the ending cards have just finished being sucked up. Latch the reveal
    // (before drawCards, so the shredded cards stay gone this frame), start projecting
    // the score screen, and re-sync so the New-run button appears.
    if (this.scoreRevealAt > 0 && !this.scoreRevealed && timestamp >= this.scoreRevealAt) {
      this.scoreRevealed = true
      this.endShredDone = true
      this.syncOverlay(timestamp)
    }
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
      // The hand's reward tokens have reached the counter — now let the points catch up
      // (they were held at the pre-resolve value so they rise AFTER the reward, per spec).
      if (this.heldScore !== null) {
        this.releaseHeldScore()
      }
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
    this.drawTokens(canvas, layout, timestamp)
    this.drawMask(canvas, layout, timestamp)
    this.drawDealerFigure(canvas, layout, timestamp)
    this.drawFx(canvas, layout, timestamp)
    // Roll the counter up toward any tokens that just landed (ticks per burst).
    this.updateTokenCounter(timestamp)
    // Fallback release: a token-less win (a chips-only push earns points but flies no
    // tokens, so nothing lands to trigger the tick above) still ticks once its reward
    // would have arrived.
    if (this.heldScore !== null && this.scoreReleaseAt > 0 && timestamp >= this.scoreReleaseAt) {
      this.releaseHeldScore()
    }
    this.updatePointsCounter(timestamp)

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
    const defs: ButtonDef[] = [
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
      // Also shown (disabled) through the game-over draw-out/shred, so the bottom row looks
      // exactly like any resolving hand — an EMPTY row (no Next hand) would spoil that this
      // was the final hand. It swaps to New run once the score screen shows (scoreRevealed).
      { key: 'next', label: 'Next hand', group: 'action', act: () => this.session.nextHand(), visible: (s) => s.phase === 'resolved' || (this.state.phase === 'over' && !this.scoreRevealed), enabled: (s) => s.phase === 'resolved' },
      // Shown only once the game-over sequence has projected the score screen (the cards
      // are sucked up, the dealer destroyed / gone) — not the instant the run ends.
      { key: 'restart', label: 'New run', group: 'action', act: () => this.session.restart(), visible: () => this.state.phase === 'over' && this.scoreRevealed, enabled: yes },
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
    // The powerup column reads top-to-bottom in ascending token cost. Array.sort is
    // stable, so the action buttons (no cost → 0) keep their defined order and their
    // own column, and equal-cost powerups (e.g. Peek Deck & Peek Dealer at 150) hold
    // source order. Dispatch to columns is by `group`, so sorting the flat list is safe.
    return defs.sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))
  }

  private buildOverlay(): void {
    const tokens = this.buildTokenCounter()
    const points = this.buildPointsCounter()
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

    // The info button sits in the bottom-left corner (fixed via CSS); pressing it toggles
    // the nexus's spec-sheet projection.
    this.infoBtnEl = this.buildInfoButton()

    // The choose-upgrade card sits above the columns (appended last), shown only
    // during the choosing-upgrade phase once the dealer's death settles.
    this.stage.overlay.append(tokens, points, this.infoBtnEl, this.messageEl, powers, actions, this.buildUpgradePanel())

    // While the spec sheet is projected, a click or touch ANYWHERE dismisses it — except
    // on the info button itself, whose own click handler toggles it. pointerdown fires
    // before the button's click, and specShownAt is only set on that click, so the tap
    // that OPENS the sheet never immediately closes it.
    this.stage.container.addEventListener('pointerdown', (e) => {
      if (this.specShownAt !== null && e.target instanceof Node && !this.infoBtnEl.contains(e.target)) {
        this.dismissSpec()
      }
    })
  }

  // The info button: a small circular "i" pinned to the left of the dealer's head. A
  // click toggles the nexus spec-sheet projection (the ruleset + token inflation).
  private buildInfoButton(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'hud-info'
    btn.textContent = 'i'
    btn.title = 'Show the dealer ruleset + token inflation'
    btn.setAttribute('aria-label', 'Show the dealer ruleset and token inflation')
    btn.addEventListener('click', () => this.toggleSpec())
    return btn
  }

  // Pin the info button just left of the dealer's head, vertically centred on it, and
  // size it to the head so it tracks the figure across screen sizes. Coordinates are in
  // CSS pixels — the overlay shares the canvas's box (see tokenTarget).
  // Toggle the nexus spec-sheet projection on or off, arming its flicker-in / -out.
  private toggleSpec(): void {
    const t = now()
    if (this.specShownAt !== null) {
      this.specHideStart = t // flicker out from full
      this.specShownAt = null
    } else {
      this.specShownAt = t // flicker in
      this.specHideStart = null
    }
    this.infoBtnEl.classList.toggle('is-active', this.specShownAt !== null)
    // Give the readout the whole felt: hide the powerup + action columns while it's up
    // (they'd otherwise crowd it on narrow/mobile layouts). Restored when it's dismissed.
    this.applyHudColumns(this.state)
    sfx.play('ability') // the nexus powering up its projector
    this.ensureLoop()
  }

  // Fade the spec sheet out if it's up — any real game action dismisses it, so it never
  // lingers over a live hand.
  private dismissSpec(): void {
    if (this.specShownAt !== null) {
      this.specHideStart = now()
      this.specShownAt = null
      this.infoBtnEl.classList.remove('is-active')
      this.applyHudColumns(this.state) // bring the button columns back
    }
  }

  // Show/hide the powerup + action button columns and the info button. Both columns hide
  // while the choose-upgrade card is up (its modal owns the screen) or the spec sheet is
  // projected (the readout wants the full felt). On the GAME-OVER SCREEN the powerups + info
  // button hide too (no abilities to use, nothing to inspect) — but NOT until the score
  // screen actually shows (`scoreRevealed`): the phase flips to 'over' the instant the final
  // hand resolves, and hiding then would drop the buttons while the dealer is still drawing
  // out (spoiling the outcome). Until then they stay visible-but-disabled, like any resolving
  // hand. The actions column always stays so the New-run button can appear.
  private applyHudColumns(s: SessionState): void {
    // Gate on the card being SHOWN (`upgradeShown`), not the raw `choosing-upgrade` phase:
    // the phase flips the instant a kill resolves, but the card is deferred until the
    // dealer's death settles — hiding on the phase would yank the columns away mid-death
    // (jarring), so instead they stay visible-but-disabled through the death and vanish as
    // the card slides in.
    const modal = this.upgradeShown || this.specShownAt !== null
    const over = s.phase === 'over' && this.scoreRevealed
    this.powersEl.classList.toggle('is-hidden', modal || over)
    this.actionsEl.classList.toggle('is-hidden', modal)
    this.infoBtnEl.classList.toggle('is-hidden', over)
  }

  // The choose-upgrade card: a title and one big coloured button per upgrade path,
  // each showing the effect it would unlock next. A maxed path's button is hidden.
  // Clicking picks the upgrade (session.chooseUpgrade) and releases the held deal.
  private buildUpgradePanel(): HTMLElement {
    const panel = element('div', 'upgrade-panel is-hidden')
    const title = element('div', 'upgrade-panel__title')
    title.textContent = 'Choose:'
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

  // The arcade points counter, pinned top-right: the rolling number (swelled while it
  // ticks) with the "+N" reward delta flashing just beneath it. Only the number swells;
  // the delta is a sibling, so it isn't dragged by the count's swell transform.
  private buildPointsCounter(): HTMLElement {
    const el = element('div', 'hud-points')
    this.pointsCountEl = element('div', 'hud-points__count')
    this.pointsDeltaEl = element('div', 'hud-points__delta')
    this.pointsCommentEl = element('div', 'hud-points__comment')
    el.append(this.pointsCountEl, this.pointsDeltaEl, this.pointsCommentEl)
    return el
  }

  private run(mutate: () => void): void {
    // Any game action closes the spec projection so it never hangs over a live hand.
    this.dismissSpec()
    const prevPhase = this.state.phase
    const prevRound = this.state.round
    const prevChips = this.state.run.chips
    const prevTokens = this.state.run.tokens
    const prevScore = this.state.run.score
    const prevCombo = this.state.run.combo
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
      // The reward "+base ×mult" delta holds (no fade) until THIS moment — the player
      // clicked Next hand — so clear it now. Also drop any reward that hadn't flashed yet
      // (a fast click before its tokens landed): release the held score to the total so the
      // counter isn't stuck, without a late flash bleeding into the next hand.
      this.pointsDeltaEl.classList.remove('is-flashing')
      this.heldScore = null
      this.pendingScoreDelta = 0
      this.pendingMult = 1
      this.scoreReleaseAt = 0

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
        // The fresh run zeroes the score: clear any held reward + flash and snap the
        // counter to 0 rather than rolling the whole total down.
        this.heldScore = null
        this.pendingScoreDelta = 0
        this.pendingMult = 1
        this.scoreReleaseAt = 0
        this.comboProj = null // drop any lingering combo projection
        this.pointsDeltaEl.classList.remove('is-flashing')
        this.pointsCommentEl.classList.remove('is-flashing')
        this.scoreTicker.set(this.displayedScore())
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
            this.dealAfter = this.beginSpawn(pa.toShift, attackEnd - SHRED_ARRIVE_OVERLAP)
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
        // A New run: the fresh run's opening dealer walks in and presents a new deck. The
        // old run's table cards were already shredded at game over, so there are none left
        // to chew — clear collectRound (beginSpawn then shreds only the resting deck), and
        // reset the game-over state so the fresh run starts clean. No laser (no attack).
        this.pendingAttack = null
        this.deckColorIncoming = null
        this.collectRound = null
        this.endShredDone = false
        this.scoreRevealAt = 0
        this.scoreRevealed = false
        this.dealer.setLevel(integrity, shiftIndex)
        this.dealer.setShift(shiftIndex)
        this.dealer.spawn(t) // a standalone walk-in (no preceding death)
        // The old run's cards + deck were already shredded at game over — shred nothing,
        // just fly the fresh deck in.
        this.dealAfter = this.beginSpawn(shiftIndex, t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP, false)
      } else {
        // No deferred damage (a losing/pushing hand): gather the cards right away and
        // refresh the health + dealer state now.
        this.anim.collect(prevRound, t)
        this.pendingAttack = null
        this.deckColorIncoming = null
        this.dealAfter = 0
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
      // A winning hand damages the dealer, but the nexus LASER doesn't fire yet: it's
      // deferred to the Next-hand click, after the token reward (see the Next-hand branch
      // above). The exception is the final blow ('over'), which ends the run — its
      // shred → laser death is run by beginEndGame below, not deferred to a Next hand.
      const enteringOver = this.state.phase === 'over' && prevPhase !== 'over'
      const damaged = integrity < prevIntegrity || shiftIndex > prevShift
      if (damaged && !enteringOver) {
        this.pendingAttack = { fromIntegrity: prevIntegrity, fromShift: prevShift, toIntegrity: integrity, toShift: shiftIndex }
        // The nexus now holds a reward + strike to deliver: light both emitters in
        // anticipation and hold the glow until the player calls the next hand. It
        // starts only once the cards have SETTLED (anim.animEnd), not at the
        // action — otherwise a natural blackjack, which resolves right off the
        // deal, would have the nexus charging before the cards even land.
        this.nexus.anticipate(this.anim.animEnd)
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
        // Steady the eye-flicker + damage sparks to the repaired level (fewer/none as the
        // dealer climbs back above the FX threshold).
        this.dealer.setLevel(integrity, shiftIndex)
        sfx.playHeal(Math.max(0, healStart - t) / 1000)
      }
      // Reward tokens for a surviving hit fly up right away; the win reward is
      // handled below, timed to the chips.
      this.scheduleTokens(prevPhase, prevTokens)
      // A surviving hit earns NO score now — it just grew the combo, projected as a tick in
      // the middle of the felt (updateComboProjection, at the end of run()).
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
          // Hold the points counter at its pre-resolve value; it releases and ticks up
          // once those reward tokens land (see the landed() loop), so points rise right
          // behind the reward. scoreReleaseAt is a fallback for a token-less win.
          const gained = this.state.run.score - prevScore
          if (gained > 0) {
            // The combo multiplier that boosted this win + any kill — carried for the felt
            // reward projection (base +N / ×mult); the top-right shows the effective +N.
            const mult = comboMultiplier(this.state.run.combo)
            const releaseAt = this.chips.animEnd + TOKEN_SPAWN_DELAY + FLY_MS + 200
            this.holdScoreReward(prevScore, gained, mult, releaseAt)
          }
        }
      } else if (prevPhase === 'betting') {
        this.heldChips = null
      }
      // Game over: once the ending hand's cards settle, the dealer sucks them up + shreds
      // them, then is destroyed (a win: laser death) or walks off (a loss), and the nexus
      // projects the score screen. Fires for a bust-out loss too (no damage this hand).
      if (enteringOver) {
        this.beginEndGame(prevScore, prevIntegrity, prevShift, integrity, shiftIndex, t)
      }
    }

    this.syncOverlay(t) // reflect the new state immediately (disable while animating)
    // A hit grew the combo → project the multiplier ticking up in the middle of the felt; a
    // bust → tick it back to ×1.00. (No-op when the combo didn't change.)
    this.updateComboProjection(prevCombo, prevPhase, t)
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

    // Final blow: the run is ending, so the last hand's reward is withheld from the count and
    // simply dropped when it resets — never flown to the counter. On a WIN that includes the
    // +40 kill bounty (already in run.tokens), so withhold it too — otherwise the top-left
    // count ticks up by 40 during the draw-out, spoiling the win.
    if (phase === 'over' && prevPhase !== 'over') {
      const killBounty = this.state.run.won ? Math.round(DESTROY_TOKEN * tokenMultiplier(this.state.run)) : 0
      this.heldTokens = winTokensTotal(round) + killBounty
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
  // `shredOldDeck` is true for a kill (the beaten dealer's resting deck is chewed too),
  // false for a New run after game over (the old run's deck was already shredded at game
  // over, so there's nothing resting to chew — only the fresh deck flies in).
  private beginSpawn(incomingShift: number, shredStart: number, shredOldDeck = true): number {
    this.spawnIncomingShift = incomingShift
    this.spawnShredOnly = false // a real ceremony: the fresh deck flies in
    // The previous dealer's resting deck moves off the static table onto the cards layer
    // so it can be sucked into the new dealer's mouth; the static deck stays hidden until
    // the fresh one lands + commits (frame settle). Draw it resting there right away.
    this.spawnHasOldDeck = shredOldDeck
    this.deckHidden = true
    const canvas = this.stage.canvas
    this.paintTable(canvas, computeLayout(canvas.width, canvas.height), false)
    // The table cards to shred are whatever `collectRound` holds (null on a game-over New
    // run — they were already shredded at game over, so nothing is chewed there).
    const src = this.collectRound
    const cardCount = src ? src.dealer.length + src.hands.reduce((sum, hand) => sum + hand.cards.length, 0) : 0
    // The final dealer gets the grander, slower deck ceremony.
    return this.spawn.begin(shredStart, cardCount, shredOldDeck, incomingShift >= TOTAL_DEALERS)
  }

  // The front half of an upgrade-granting kill: the laser fires, the dealer breaks
  // apart (no walk-in), and the +40 bounty flies from the nexus — but the replacement is
  // held back for playArrival. Returns when the figure is gone.
  private playDeath(fromI: number, fromS: number, toI: number, toS: number, startAfter: number): number {
    this.dealer.sync(fromI, fromS, toI, toS, startAfter, false, false) // death only, no walk-in
    const canvas = this.stage.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    const liftoff = startAfter + KILL_DEATH_MS
    const bounty = Math.round(DESTROY_TOKEN * tokenMultiplier(this.state.run))
    this.tokens.emit(nexusYellowLight(layout, liftoff), bounty, liftoff)
    return startAfter + KILL_DEATH_MS
  }

  // The back half of an upgrade-granting kill, run when the player picks: after a beat
  // the replacement dealer walks in, its mouth shreds the old cards + resting deck, and a
  // fresh wrapped deck flies in. The next deal waits for it all.
  private playArrival(t: number): void {
    const c = this.pendingCeremony!
    this.pendingCeremony = null
    this.collectRound = c.prevRound // re-anchor the cards to shred (kept resting till now)
    const walkInStart = t + CEREMONY_LEAD
    this.dealer.setLevel(c.incomingIntegrity, c.incomingShift)
    this.dealer.setShift(c.incomingShift)
    this.dealer.spawn(walkInStart)
    this.deckColorIncoming = null
    this.dealAfter = this.beginSpawn(c.incomingShift, walkInStart + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP)
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
  // `emitBounty` flies the +40 kill token from the nexus (default). At GAME OVER it's false:
  // the run is ending, so the bounty is withheld from the count (see scheduleTokens) and the
  // counter never shows it — flying it would double-count against that withholding.
  private playAttack(fromI: number, fromS: number, toI: number, toS: number, startAfter: number, emitBounty = true): number {
    const final = this.state.run.won || toS > TOTAL_DEALERS
    this.dealer.sync(fromI, fromS, toI, toS, startAfter, final)
    if (toS > fromS) {
      if (emitBounty) {
        const canvas = this.stage.canvas
        const layout = computeLayout(canvas.width, canvas.height)
        const liftoff = startAfter + KILL_DEATH_LEAD_MS + KILL_DYING_MS
        // The kill bounty flies scaled by the Token eco multiplier, matching the
        // credited amount (run.ts). The upgrade pick comes after this, so the current
        // run's multiplier is the one that applied to this bounty.
        const bounty = Math.round(DESTROY_TOKEN * tokenMultiplier(this.state.run))
        this.tokens.emit(nexusYellowLight(layout, liftoff), bounty, liftoff)
      }
      return startAfter + KILL_TOTAL_MS
    }
    return startAfter + HIT_TOTAL_MS
  }

  // The game-over sequence. Once the ending hand's cards settle, the dealer sucks BOTH the
  // table cards AND its resting deck into its mouth and shreds them — exactly the shred a
  // beaten dealer's ceremony plays, but with NO fresh deck flying in (the run is over).
  // Then — a win: the nexus laser fires and the final dealer breaks apart; a loss: the
  // dealer strides off to the right (footsteps). The instant everything is shredded the
  // nexus starts projecting the score screen and the New-run button appears (scoreRevealAt
  // / the frame loop's reveal edge).
  private beginEndGame(prevScore: number, prevIntegrity: number, prevShift: number, integrity: number, shiftIndex: number, t: number): void {
    const round = this.state.round
    if (!round) {
      return
    }
    this.collectRound = round // the cards drawShred sucks into the mouth
    this.endShredDone = false
    this.spawnShredOnly = true
    this.spawnIncomingShift = null
    // Shred the resting deck too (like a kill ceremony): move it off the static table onto
    // the cards layer (deckHidden + repaint) so drawOldDeckShred can suck it into the mouth.
    this.spawnHasOldDeck = true
    this.deckHidden = true
    const canvas = this.stage.canvas
    this.paintTable(canvas, computeLayout(canvas.width, canvas.height), false)

    // Settle the table chips FIRST: a loss flies the bet to the house (beside the dealer), a
    // win collects the winnings to the bankroll. Everything else waits for them — so on a
    // loss the bet reaches the dealer before it shreds + walks off. Start once the cards have
    // landed AND any resolve animation (the winnings flying in on a win) has finished. The
    // bankroll count stays frozen at its resolve value (heldChips) — there's no next hand.
    const chipStart = Math.max(this.anim.animEnd, this.chips.animEnd)
    this.chips.clear(round, chipStart)

    const cardCount = round.dealer.length + round.hands.reduce((sum, hand) => sum + hand.cards.length, 0)
    const shredStart = this.chips.animEnd + END_SHRED_GAP
    // shredOldDeck=true (chew the deck), shredOnly=true (no fresh deck flies in).
    const shredEnd = this.spawn.begin(shredStart, cardCount, true, false, true)
    if (this.state.run.won) {
      // The final boss is destroyed the moment its own shredder finishes with the cards:
      // the laser fires and the figure breaks apart (final → no walk-in). The +40 bounty is
      // NOT flown (emitBounty=false) — it's withheld from the count (scheduleTokens), so the
      // run-ending count stays frozen and the token counter can't spoil the win.
      this.playAttack(prevIntegrity, prevShift, integrity, shiftIndex, shredEnd, false)
      this.fireLaser(t, shredEnd, true)
    } else {
      // The house won: the dealer turns and strides off to the right once the cards are gone.
      this.dealer.walkOff(shredEnd)
    }
    // Freeze the score counter at its pre-kill value until the score screen shows (shredEnd):
    // the win's chip score + kill bounty are already in run.score, and letting the top-right
    // counter roll up during the dealer's draw-out would spoil the win. releaseAt = shredEnd
    // rolls it up (and flashes the +delta) exactly as the score screen appears.
    const gained = this.state.run.score - prevScore
    if (gained > 0) {
      this.holdScoreReward(prevScore, gained, comboMultiplier(this.state.run.combo), shredEnd)
    }
    // Once the cards are sucked up, project the score screen + reveal the New-run button.
    this.scoreRevealAt = shredEnd
    this.scoreRevealed = false
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

    // Point the counters at their current values (rewards still flying are withheld);
    // the frame loop rolls them up as they land.
    this.updateTokenCounter(timestamp)
    this.updatePointsCounter(timestamp)
    this.messageEl.textContent = animating ? '' : this.buildMessage()
    this.hintEl.textContent = animating ? '' : this.buildHint()
    this.syncUpgradePanel(s, animating, timestamp)

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
    // The columns hide for the upgrade card OR the spec sheet (centralised so the two
    // never fight over is-hidden).
    this.applyHudColumns(s)
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
    // Game over: the summary is projected onto the felt (the nexus score screen), not
    // shown as a banner — so no message here.
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
// Returns undefined when the hand shows no player-side label — a voided hand is
// tagged beside the dealer's total instead (see cards.ts dealerNote).
function handResultLabel(hand: PlayerHand, rules: RoundRules): RoundResult | undefined {
  const net = handNet(hand, rules)
  if (hand.outcome === 'blackjack') {
    return { label: `Blackjack +${net}`, tone: 'win' }
  }
  if (hand.outcome === 'voided') {
    return undefined
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

// Restart a one-shot CSS animation on `el`: drop the class, force a reflow so the animation
// resets, then re-add it — lets the same element replay its keyframes back-to-back instead
// of freezing after the first play.
function restartAnimation(el: HTMLElement, className: string): void {
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)
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
