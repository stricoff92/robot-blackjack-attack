// Turns the game's instant state changes into a timed deal sequence.
//
// The Session resolves synchronously — after `stand()` the snapshot already has
// the dealer's full hand and the outcome. This controller diffs each new state
// against what's already on the table and schedules the newly-added cards over
// time, so the view can hold the result until the motion settles.
//
// Every card flies from the shoe FACE-DOWN, lands, pauses briefly, then flips
// to reveal its face — except the dealer hole card, whose flip is deferred
// until the round reveals it. Dealer draws play out one fully at a time. When a
// hand ends the cards are gathered back into the deck, then a short riffle.

import type { Round } from '../game/round'
import type { SessionState } from '../game/session'
import { dealerKey, playerKey, type CardAnim, type CardState } from '../render/cards'
import { smoothStep } from '../render/easing'

const FLIGHT_MS = 200 // shoe → slot
const LAND_DELAY = 30 // face-down pause after landing, before the flip
const FLIP_MS = 170 // reveal flip
// Pause between one card fully finishing (landed + flipped) and the next
// starting to move — so card actions never overlap.
const ACTION_GAP = 120

const COLLECT_MS = 380 // per card: flip face-down in place, then fly to the deck top
const COLLECT_STAGGER = 55 // between cards being gathered
const SHUFFLE_GAP = 130 // pause between the last card landing and the riffle
const SLIDE_MS = 220 // deck slides out to centre (and back) for the shuffle
// Riffle shuffle (one pass). Sized so its MERGE phase — the 0.7 of the pass after
// the 0.3 split (SHUFFLE_SPLIT_FRACTION) — lasts the 0.43s of the shuffle clip, which
// fires when the merge begins: 430 / 0.7 ≈ 614. The split before it is silent.
const SHUFFLE_MS = 614

type Phase = SessionState['phase']

interface CardTiming {
  flightStart: number
  flipStart: number | null // null = face-down for now (hole card until revealed)
}

export class DealAnimation implements CardAnim {
  private readonly cards_ = new Map<string, CardTiming>()
  private readonly collectStart_ = new Map<string, number>()
  // Card keys whose shoe-draw is already accounted for (a draw sfx has fired,
  // or it's a glide that shouldn't make one). Lets drawnCards() report each
  // fresh flight exactly once. Cleared on reset; a re-placed key re-fires.
  private readonly firedFlights_ = new Set<string>()
  // End-of-hand deck sequence: slide out to centre → shuffle → slide back.
  private slideOutStart_: number | null = null
  private shuffleStart_: number | null = null
  private shuffleStop_: number | null = null
  private slideBackStart_: number | null = null
  private end_ = 0 // timestamp when all scheduled motion finishes
  private now_ = 0

  get animEnd(): number {
    return this.end_
  }

  isAnimating(now: number): boolean {
    return now < this.end_
  }

  setNow(now: number): void {
    this.now_ = now
  }

  // Schedule motion for whatever changed between the previous and new state.
  sync(prevPhase: Phase, state: SessionState, now: number): void {
    const round = state.round
    if (!round) {
      this.reset_(now)
      return
    }

    // A deal (the only action out of the betting phase) starts the table over.
    const opening = prevPhase === 'betting'
    if (opening) {
      this.reset_(now)
    }

    const reveal = state.phase !== 'playing' || state.peeked
    let cursor = Math.max(now, this.end_)

    // New cards: the opening deal alternates player/dealer; mid-round it's just
    // your fresh card(s) (hit / double / split).
    const fresh = opening ? this.freshInterleaved_(round) : this.freshPlayerCards_(round)
    for (const key of fresh) {
      const faceDown = opening && key === dealerKey(1) // hole card stays down
      cursor = this.place_(key, cursor, !faceDown) + ACTION_GAP
    }

    // Flip the hole card if this state reveals it (stand / peek / instant BJ)...
    const hole = this.cards_.get(dealerKey(1))
    if (reveal && hole && hole.flipStart === null) {
      hole.flipStart = cursor
      this.end_ = Math.max(this.end_, cursor + FLIP_MS)
      cursor += FLIP_MS + ACTION_GAP
    }

    // ...then the dealer's draws, one fully-resolved card at a time.
    for (const key of this.freshDealerCards_(round)) {
      cursor = this.place_(key, cursor, true) + ACTION_GAP
    }
  }

  // Gather the ending hand's cards back into the deck, then (unless `shuffle` is false) slide
  // the deck out in front of the dealer, riffle it, and slide it back to rest. A game-over
  // gather passes shuffle=false — the cards return to the deck with no riffle (no next hand).
  collect(round: Round, now: number, shuffle = true): void {
    this.collectStart_.clear()
    let cursor = now
    for (const key of this.allKeys_(round)) {
      this.collectStart_.set(key, cursor)
      this.end_ = Math.max(this.end_, cursor + COLLECT_MS)
      cursor += COLLECT_STAGGER
    }
    if (!shuffle) {
      // No riffle: the deck stays at its rest spot (no slide-out / shuffle / slide-back).
      this.slideOutStart_ = null
      this.shuffleStart_ = null
      this.shuffleStop_ = null
      this.slideBackStart_ = null
      return
    }
    this.slideOutStart_ = this.end_ + SHUFFLE_GAP
    this.shuffleStart_ = this.slideOutStart_ + SLIDE_MS
    this.shuffleStop_ = this.shuffleStart_ + SHUFFLE_MS
    this.slideBackStart_ = this.shuffleStop_
    this.end_ = this.slideBackStart_ + SLIDE_MS
  }

  // Split: the two originally-dealt cards glide (staying face-up) from the
  // single-hand layout into the two new hands, then a fresh card deals into each
  // hand from the shoe. The glide's from-position is resolved in the render layer
  // (drawHands via splitPrev); here we only re-time the cards. The glide reuses the
  // flight track, so drawDealt tweens it from the render-supplied origin.
  splitHands(now: number): void {
    for (const key of [playerKey(0, 0), playerKey(1, 0)]) {
      // Flight runs now → now + FLIGHT_MS; flipStart in the past pins flip at 1 so
      // the card stays face-up through the glide (no re-flip).
      this.cards_.set(key, { flightStart: now, flipStart: now - FLIP_MS })
      // A glide of an already-dealt card, not a shoe draw — suppress its draw sfx.
      this.firedFlights_.add(key)
      this.end_ = Math.max(this.end_, now + FLIGHT_MS)
    }
    let cursor = now + FLIGHT_MS + ACTION_GAP
    for (const key of [playerKey(0, 1), playerKey(1, 1)]) {
      this.cards_.delete(key) // was the old hand-0 second card / brand new — deal fresh
      cursor = this.place_(key, cursor, true) + ACTION_GAP
    }
  }

  // Re-deal a hand's cards from scratch (mulligan): forget their existing timings
  // and schedule them to fly in + flip up starting at `startAt` — after the tossed
  // cards have finished their discard.
  redealHand(handIndex: number, cardCount: number, startAt: number): void {
    let cursor = startAt
    for (let ci = 0; ci < cardCount; ci += 1) {
      const key = playerKey(handIndex, ci)
      this.cards_.delete(key)
      cursor = this.place_(key, cursor, true) + ACTION_GAP
    }
  }

  // 0..1 position of the deck: 0 = resting spot, 1 = shuffle spot (centre).
  deckShift(): number {
    if (this.slideOutStart_ === null || this.shuffleStart_ === null || this.slideBackStart_ === null) {
      return 0
    }
    if (this.now_ < this.slideOutStart_) {
      return 0
    }
    if (this.now_ < this.shuffleStart_) {
      return smoothStep((this.now_ - this.slideOutStart_) / SLIDE_MS)
    }
    if (this.now_ < this.slideBackStart_) {
      return 1
    }
    if (this.now_ < this.slideBackStart_ + SLIDE_MS) {
      return 1 - smoothStep((this.now_ - this.slideBackStart_) / SLIDE_MS)
    }
    return 0
  }

  // --- CardAnim ---

  state(key: string): CardState | null {
    const timing = this.cards_.get(key)
    if (!timing || this.now_ < timing.flightStart) {
      return null // not scheduled, or hasn't started flying yet
    }
    const flight = clamp01((this.now_ - timing.flightStart) / FLIGHT_MS)
    let flip = 0
    if (timing.flipStart !== null && this.now_ >= timing.flipStart) {
      flip = clamp01((this.now_ - timing.flipStart) / FLIP_MS)
    }
    let collect = 0
    const started = this.collectStart_.get(key)
    if (started !== undefined && this.now_ >= started) {
      collect = clamp01((this.now_ - started) / COLLECT_MS)
    }
    return { flight, flip, collect }
  }

  // Card keys whose flight has just begun since the last call — one entry per
  // card newly launched from the shoe, for firing the draw sfx. Glides (split
  // originals) are pre-marked, so only genuine shoe draws are reported.
  drawnCards(now: number): string[] {
    const started: string[] = []
    for (const [key, timing] of this.cards_) {
      if (!this.firedFlights_.has(key) && now >= timing.flightStart) {
        this.firedFlights_.add(key)
        started.push(key)
      }
    }
    return started
  }

  // 0..1 progress of the deck riffle, or null when not shuffling.
  shuffle(): number | null {
    if (this.shuffleStart_ === null || this.shuffleStop_ === null) {
      return null
    }
    if (this.now_ < this.shuffleStart_ || this.now_ >= this.shuffleStop_) {
      return null
    }
    return (this.now_ - this.shuffleStart_) / (this.shuffleStop_ - this.shuffleStart_)
  }

  // --- internals ---

  private reset_(now: number): void {
    this.cards_.clear()
    this.collectStart_.clear()
    this.firedFlights_.clear()
    this.slideOutStart_ = null
    this.shuffleStart_ = null
    this.shuffleStop_ = null
    this.slideBackStart_ = null
    this.end_ = now
  }

  // Record a card's timing; returns the moment it finishes (for sequencing).
  private place_(key: string, flightStart: number, autoFlip: boolean): number {
    const flipStart = autoFlip ? flightStart + FLIGHT_MS + LAND_DELAY : null
    this.cards_.set(key, { flightStart, flipStart })
    // A freshly placed card is a new shoe draw — clear any prior fire so its
    // flight re-triggers the draw sfx (re-deals: split, mulligan).
    this.firedFlights_.delete(key)
    const finish = flipStart !== null ? flipStart + FLIP_MS : flightStart + FLIGHT_MS
    this.end_ = Math.max(this.end_, finish)
    return finish
  }

  private allKeys_(round: Round): string[] {
    const keys: string[] = []
    round.dealer.forEach((_, i) => keys.push(dealerKey(i)))
    round.hands.forEach((hand, hi) => hand.cards.forEach((_, ci) => keys.push(playerKey(hi, ci))))
    return keys
  }

  private freshInterleaved_(round: Round): string[] {
    const entries: Array<{ key: string; index: number; lane: number }> = []
    round.dealer.forEach((_, i) => {
      const key = dealerKey(i)
      if (!this.cards_.has(key)) {
        entries.push({ key, index: i, lane: 1 })
      }
    })
    round.hands.forEach((hand, hi) => {
      hand.cards.forEach((_, ci) => {
        const key = playerKey(hi, ci)
        if (!this.cards_.has(key)) {
          entries.push({ key, index: ci, lane: 0 })
        }
      })
    })
    entries.sort((a, b) => a.index - b.index || a.lane - b.lane)
    return entries.map((e) => e.key)
  }

  private freshPlayerCards_(round: Round): string[] {
    const keys: string[] = []
    round.hands.forEach((hand, hi) => {
      hand.cards.forEach((_, ci) => {
        const key = playerKey(hi, ci)
        if (!this.cards_.has(key)) {
          keys.push(key)
        }
      })
    })
    return keys
  }

  private freshDealerCards_(round: Round): string[] {
    const keys: string[] = []
    round.dealer.forEach((_, i) => {
      const key = dealerKey(i)
      if (!this.cards_.has(key)) {
        keys.push(key)
      }
    })
    return keys
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
