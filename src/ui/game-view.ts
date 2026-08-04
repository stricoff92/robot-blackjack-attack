import './game-view.css'

import { readDebugFlags } from '../game/debug'
import type { Card, Suit } from '../game/deck'
import { POWERUPS } from '../game/powerups'
import { canDouble, canMulligan, canSplit, handNet, type PlayerHand, type Round, type RoundRules } from '../game/round'
import { handReward } from '../game/rewards'
import { isLastCall, nextBet, TOTAL_DEALERS } from '../game/run'
import { Session, type SessionState } from '../game/session'
import type { LayeredCanvas } from '../render/canvas'
import { ANALYSIS_STRIKE_MS, drawAnalysis, drawAnalysisMask, drawHands, drawMulliganDiscard, drawShoe, drawShuffle, playerCardCenter, playerHandCenter, shoeAnchor, type RoundResult } from '../render/cards'
import { onChipImageReady } from '../render/chip-sprite'
import { drawChips, drawTableMarkings } from '../render/chips'
import { drawHealthBar } from '../render/health'
import { Scene, computeLayout, type Layout } from '../render/scene'
import { drawTokens, type Point } from '../render/tokens'
import { ChipAnimation } from './chip-animator'
import { CountTicker } from './count-ticker'
import { DealAnimation } from './deal-animator'
import { HealthAnimation } from './health-animator'
import { MulliganAnimation } from './mulligan-animator'
import { TokenAnimation } from './token-animator'
import { createStage, type Stage } from './stage'

// The token icon, imported once so Vite fingerprints the URL and the browser
// fetches it a single time on load; every <img> that references it (the token
// counter + each powerup cost pill) then serves from cache.
import powerUrl from '../assets/power.png'

// Canvas layers, bottom → top. Chips sit ABOVE cards so flying chips (deal /
// payout) pass in front of the cards; the bet chips rest in the betting circle
// well below the cards, so nothing overlaps at rest. The HUD (dealer health bar)
// sits above that, and reward tokens fly above that up to the counter. The 'mask'
// layer is on top of everything: a darkness that the Analyze projection lights
// through (the HTML button/counter overlay sits above it, so those stay bright).
const LAYERS = ['back', 'table', 'cards', 'chips', 'hud', 'tokens', 'mask'] as const

// When a reward's tokens lift off, relative to the card motion settling
// (anim.animEnd): a hit's token waits a short beat after its card lands, and a
// resolve's winning hands stagger their bursts so splits cascade.
const TOKEN_SPAWN_DELAY = 90
const TOKEN_HAND_STAGGER = 120

// How long a dismissed Analyze reading takes to flicker out.
const ANALYSIS_FADE_MS = 300

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
  private readonly tokens = new TokenAnimation()
  private readonly mulligan = new MulliganAnimation()
  // The two number readouts roll from their old value to the new one (ticking
  // through the integers) and swell while they roll, rather than snapping: the
  // token count as rewards land, the bankroll as a payout merges into the pile.
  private readonly tokenTicker = new CountTicker()
  private readonly bankrollTicker = new CountTicker()
  private readonly stage: Stage
  private raf = 0
  private lastAnimating = false
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
  // While gathering + shuffling, the deck is drawn on the cards layer (so it can
  // split/move) and hidden on the static table layer.
  private deckOnCards = false

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

  constructor(root: HTMLElement) {
    const debug = readDebugFlags()
    this.session = new Session(generateSeed(), {
      forcePairs: debug.forcePairs,
      forcePairRank: debug.forcePairRank,
    })
    this.state = this.session.snapshot()
    // Show the opening balances immediately (no roll up from zero on load).
    this.tokenTicker.set(this.displayedTokens(now()))
    this.bankrollTicker.set(this.displayedBankroll())
    this.defs = this.makeButtons()
    this.stage = createStage(root, LAYERS, (canvas) => this.onResize(canvas))
    this.buildOverlay()
    this.syncOverlay(now())
    // Repaint the chips once the shared chip image loads, so it swaps in over the
    // vector fallback even if the table has already settled (slow network).
    onChipImageReady(() => {
      const canvas = this.stage.canvas
      this.drawChips(canvas, computeLayout(canvas.width, canvas.height), now())
    })
    this.run(() => this.session.deal()) // deal the first hand on load
  }

  // Repaint every layer. Static layers (back, table) only change here — on
  // resize (and the initial paint). The cards layer is redrawn per frame too.
  private onResize(canvas: LayeredCanvas): void {
    const layout = computeLayout(canvas.width, canvas.height)
    this.scene.drawBackground(canvas.layers.back.ctx, layout)
    this.paintTable(canvas, layout, !this.deckOnCards)
    const t = now()
    this.anim.setNow(t)
    this.drawCards(canvas, layout, t)
    this.drawChips(canvas, layout, t)
    this.drawHealth(canvas, layout, t)
    this.drawTokens(canvas, layout, t)
    this.drawMask(canvas, layout, t)
  }

  // Repaint the table layer (felt + rail + betting-spot markings), optionally
  // with the static deck.
  private paintTable(canvas: LayeredCanvas, layout: Layout, withDeck: boolean): void {
    const ctx = canvas.layers.table.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)
    this.scene.drawTable(ctx, layout)
    drawTableMarkings(ctx, layout)
    if (withDeck) {
      const a = shoeAnchor(layout)
      drawShoe(ctx, a.x, a.y, a.w, a.h)
    }
  }

  // The only per-frame work: clear + repaint the cards layer.
  private drawCards(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.cards.ctx
    ctx.clearRect(0, 0, layout.width, layout.height)

    // While gathering/shuffling, the deck lives on this layer so it can slide
    // out to the centre (in front of the dealer) and split for the riffle.
    if (this.deckOnCards) {
      const rest = shoeAnchor(layout)
      const centerX = layout.width / 2 - rest.w / 2
      const x = rest.x + (centerX - rest.x) * this.anim.deckShift()
      const shuffle = this.anim.shuffle()
      if (shuffle !== null) {
        drawShuffle(ctx, x, rest.y, rest.w, rest.h, shuffle)
      } else {
        drawShoe(ctx, x, rest.y, rest.w, rest.h)
      }
    }

    // Fall back to the retained ending round while its cards are gathering.
    const round = this.state.round ?? this.collectRound
    if (round) {
      const revealHole = this.state.phase !== 'playing' || this.state.peeked
      drawHands(ctx, layout, round, revealHole, this.anim, this.handResults(timestamp))
    }

    // Mulligan: the tossed opening cards flip down and fly back to the deck while
    // the fresh pair (already in `round`, but not yet scheduled) waits to fly in.
    if (this.mulligan.isAnimating(timestamp)) {
      drawMulliganDiscard(ctx, layout, this.mulligan.frames(timestamp))
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
    // Release the frozen bankroll the moment the settling chips land (which is
    // well before the longer card gather + shuffle finishes), so the stack grows
    // or shrinks as the chips arrive.
    if (this.clearPending && timestamp >= this.clearEnd) {
      this.heldChips = null
      this.clearPending = false
    }
    const canvas = this.stage.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    this.drawCards(canvas, layout, timestamp)
    this.drawChips(canvas, layout, timestamp)
    this.drawHealth(canvas, layout, timestamp)
    this.drawTokens(canvas, layout, timestamp)
    this.drawMask(canvas, layout, timestamp)
    // Roll the counter up toward any tokens that just landed (ticks per burst).
    this.updateTokenCounter(timestamp)

    const sequenceAnimating = this.anim.isAnimating(timestamp) || this.chips.isAnimating(timestamp)

    // The card + chip sequence just finished: run the one-time settle. The health
    // bar may keep animating past this point (its drop lands after the reveal) —
    // that's handled by the loop-alive check below and must NOT hold up the
    // settle, or the buttons and next deal would stall behind it.
    if (!sequenceAnimating && this.lastAnimating) {
      this.raf = 0 // let a re-deal's run() → ensureLoop reschedule cleanly
      this.lastAnimating = false

      if (this.deckOnCards) {
        // Gather + shuffle finished: hand the deck back to the static table layer.
        this.deckOnCards = false
        this.paintTable(canvas, layout, true)
      }
      this.collectRound = null
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

      // No Deal button — once the deck is ready, deal the next hand automatically.
      if (this.state.phase === 'betting') {
        this.run(() => this.session.deal())
        return
      }
    }

    // Keep the loop alive while the sequence, the health bar, a reward token, or
    // a still-rolling counter is moving. Like the health bar, tokens fly on past
    // the settle (they don't gate the buttons), and the counters keep rolling for
    // a beat after their last burst lands — so all are checked here to finish
    // smoothly.
    if (
      sequenceAnimating ||
      this.health.isAnimating(timestamp) ||
      this.tokens.isAnimating(timestamp) ||
      this.tokenTicker.isAnimating(timestamp) ||
      this.bankrollTicker.isAnimating(timestamp) ||
      this.mulligan.isAnimating(timestamp) ||
      this.showingAnalysis(timestamp) || // the Analyze projection shimmers until dismissed
      this.analysisFade(timestamp) !== null // ...then flickers out
    ) {
      this.raf = requestAnimationFrame(this.frame)
      return
    }
    this.raf = 0
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
      },
      {
        key: 'split',
        label: 'Split',
        group: 'action',
        act: () => this.session.split(),
        visible: playing,
        enabled: (s) => !!s.round && canSplit(s.round) && affordsExtra(s),
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
        enabled: (s) => playing(s) && s.run.tokens >= POWERUPS.analyze.cost && s.analysis === null,
        active: (s) => playing(s) && s.analysis !== null,
      },
      {
        key: 'peek',
        label: 'Peek Dealer',
        group: 'power',
        cost: POWERUPS.peek.cost,
        act: () => this.session.buyPeek(),
        visible: yes,
        enabled: (s) => playing(s) && s.run.tokens >= POWERUPS.peek.cost && !s.peeked,
      },
      {
        key: 'late-double',
        label: 'Late double',
        group: 'power',
        cost: POWERUPS['late-double'].cost,
        act: () => this.session.buyLateDouble(),
        visible: yes,
        // Redundant while a free Double is still on the table (first two cards) —
        // only worth buying once the player has hit and canDouble has lapsed.
        enabled: (s) =>
          playing(s) && s.run.tokens >= POWERUPS['late-double'].cost && !!s.round && !canDouble(s.round) && affordsExtra(s),
      },
      {
        key: 'freeze',
        label: 'Freeze Dealer',
        group: 'power',
        cost: POWERUPS.freeze.cost,
        act: () => this.session.buyFreezeDealer(),
        visible: yes,
        enabled: (s) => playing(s) && s.run.tokens >= POWERUPS.freeze.cost && !!s.round && !s.round.dealerFrozen,
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
          playing(s) && s.run.tokens >= POWERUPS['second-chance'].cost && !!s.round && !s.round.secondChanceArmed,
        active: (s) => playing(s) && !!s.round && s.round.secondChanceArmed,
      },
      {
        key: 'mulligan',
        label: 'Mulligan',
        group: 'power',
        cost: POWERUPS.mulligan.cost,
        act: () => this.session.buyMulligan(),
        visible: yes,
        enabled: (s) => playing(s) && s.run.tokens >= POWERUPS.mulligan.cost && !!s.round && canMulligan(s.round),
      },
      {
        key: 'foresight',
        label: 'Peek Deck',
        group: 'power',
        cost: POWERUPS.foresight.cost,
        act: () => this.session.buyForesight(),
        visible: yes,
        enabled: (s) => playing(s) && s.run.tokens >= POWERUPS.foresight.cost && s.foresightCard === null,
      },
    ]
  }

  private buildOverlay(): void {
    const tokens = this.buildTokenCounter()
    this.messageEl = element('div', 'hud-message')
    this.hintEl = element('div', 'hud-powerhint')
    const powers = element('div', 'hud-powerups')
    const actions = element('div', 'hud-actions')
    powers.appendChild(this.hintEl) // hint sits atop the powerup stack

    this.buttons = {}
    for (const def of this.defs) {
      const button = document.createElement('button')
      if (def.cost === undefined) {
        button.textContent = def.label
      } else {
        // Powerups: the name on the button, the token cost in a pill pinned to
        // the bottom-right corner.
        const label = element('span', 'power-label')
        label.textContent = def.label
        button.append(label, costPill(def.cost))
      }
      button.addEventListener('click', () => this.run(def.act))
      this.buttons[def.key] = button
      ;(def.group === 'power' ? powers : actions).appendChild(button)
    }

    this.stage.overlay.append(tokens, this.messageEl, powers, actions)
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
    mutate()
    this.state = this.session.snapshot()
    const { integrity, shiftIndex } = this.state.run

    const t = now()
    // Stamp when a fresh reading appears (flicker ramps in from here), or start the
    // flicker-out when one is dismissed (retain it so it can die gracefully).
    if (this.state.analysis && !prevAnalysis) {
      this.analysisStart = t
      this.analysisFadeOut = null
    } else if (!this.state.analysis && prevAnalysis) {
      this.analysisFadeOut = prevAnalysis
      this.analysisFadeStart = t
    }
    if (prevRound && !this.state.round) {
      // Next hand called: gather the cards back into the deck + shuffle, AND
      // settle the deferred chips now (winners collect, losers pay the house).
      // Move the deck onto the cards layer so the shuffle can split it.
      this.collectRound = prevRound
      this.anim.collect(prevRound, t)
      this.chips.clear(prevRound, t)
      this.clearEnd = this.chips.animEnd
      this.clearPending = true
      this.deckOnCards = true
      const canvas = this.stage.canvas
      this.paintTable(canvas, computeLayout(canvas.width, canvas.height), false)
      // Only a New-run resets health here (a plain next hand leaves it untouched).
      this.health.sync(prevIntegrity, prevShift, integrity, shiftIndex, t)
      // A plain next hand (from 'resolved') now flies the withheld win tokens up
      // to the counter; a New run (from 'over') just drops them — the count is
      // resetting to zero anyway.
      if (prevPhase === 'resolved' && prevRound) {
        this.releaseWinTokens(prevRound, t)
      }
      this.heldTokens = 0
    } else {
      if (this.state.round) {
        this.collectRound = null
      }
      const round = this.state.round
      const mulliganed = !!prevRound && !prevRound.mulliganed && !!round && round.mulliganed
      if (mulliganed && prevRound && round) {
        // Toss the old opening cards back to the deck, then deal the fresh pair
        // once they've merged in.
        const discardEnd = this.mulligan.begin(prevRound.hands[0].cards, t)
        this.anim.redealHand(0, round.hands[0].cards.length, discardEnd)
        // A fresh natural resolves at once — reveal the dealer after the redeal.
        if (this.state.phase !== 'playing') {
          this.anim.sync(prevPhase, this.state, this.anim.animEnd)
        }
      } else {
        this.anim.sync(prevPhase, this.state, t)
      }
      // Damage lands once the cards settle, in sync with the payout.
      this.health.sync(prevIntegrity, prevShift, integrity, shiftIndex, this.anim.animEnd)
      // Reward tokens fly up to the counter once the cards settle.
      this.scheduleTokens(prevPhase, prevTokens)
      // On resolve, freeze the bankroll at its pre-settle *available* value (the
      // live bet is on the table); it releases to the new total once the payout
      // chips land on the next hand.
      if (this.syncChips(prevPhase, t)) {
        const bet = this.state.round ? this.state.round.hands.reduce((sum, hand) => sum + hand.bet, 0) : 0
        this.heldChips = prevChips - bet
      } else if (prevPhase === 'betting') {
        this.heldChips = null
      }
    }

    this.syncOverlay(t) // reflect the new state immediately (disable while animating)
    this.lastAnimating = this.anim.isAnimating(t) || this.chips.isAnimating(t)
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

  // React to the tokens this action just earned. A surviving hit credits +1
  // while play continues, so its token flies from the fresh card right away. A
  // resolve's winning hands are WITHHELD instead of flown: the reward waits at
  // the counter (frozen out of the count) until the player calls the next hand,
  // then flies in from the hands — the same deferral the payout chips use. The
  // +40 dealer-kill token is not handled here at all; it belongs with the
  // dealer-death animation, so for now it just lands in the count at resolve.
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
      const hi = round.activeIndex
      const ci = round.hands[hi].cards.length - 1
      const amount = this.state.run.tokens - prevTokens
      this.tokens.emit(playerCardCenter(layout, round, hi, ci), amount, this.anim.animEnd + TOKEN_SPAWN_DELAY)
      return
    }

    // Resolve: withhold the winning hands' reward from the count; it flies on the
    // next hand (see releaseWinTokens).
    const resolvedNow = phase === 'resolved' || phase === 'over'
    const wasResolved = prevPhase === 'resolved' || prevPhase === 'over'
    if (resolvedNow && !wasResolved) {
      this.heldTokens = winTokensTotal(round)
    }
  }

  // Fly the withheld win/blackjack tokens up to the counter when the next hand is
  // called, from each winning hand, staggered so a split's two wins cascade.
  private releaseWinTokens(round: Round, t: number): void {
    const canvas = this.stage.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    round.hands.forEach((hand, hi) => {
      const amount = winTokenFor(hand, round)
      if (amount > 0) {
        this.tokens.emit(playerHandCenter(layout, round, hi), amount, t + hi * TOKEN_HAND_STAGGER)
      }
    })
  }

  // Sync overlay text + button state. While cards are in motion, buttons are
  // disabled and the result message is withheld until the sequence settles.
  private syncOverlay(timestamp: number): void {
    const s = this.state
    const animating = this.anim.isAnimating(timestamp)

    // Point the counter at its current value (tokens still flying are withheld);
    // the frame loop rolls it up as they land.
    this.updateTokenCounter(timestamp)
    this.messageEl.textContent = animating ? '' : this.buildMessage()
    this.hintEl.textContent = animating ? '' : this.buildHint()

    for (const def of this.defs) {
      const button = this.buttons[def.key]
      const visible = def.visible(s)
      button.classList.toggle('is-hidden', !visible)
      // Armed powerups glow; using the shield clears the armed flag, which drops
      // the class here on the next sync and returns the button to normal.
      button.classList.toggle('is-active', visible && !!def.active?.(s))
      button.disabled = animating || (visible && !def.enabled(s))
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

// A powerup's cost pill: "<cost> <icon>", pinned to the button's bottom-right.
function costPill(cost: number): HTMLElement {
  const pill = element('span', 'cost-pill')
  const num = element('span', 'cost-pill__num')
  num.textContent = String(cost)
  pill.append(num, powerIcon('cost-pill__icon'))
  return pill
}

function generateSeed(): number {
  return Math.floor(Math.random() * 0x100000000)
}
