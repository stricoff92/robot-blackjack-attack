// Timing for the dealer-spawn ceremony: the previous dealer's cards are sucked
// into the new dealer's mouth and shredded (paper chunks coning off to the left),
// then a fresh shrink-wrapped deck flies from the dealer into the shoe position and
// the plastic tears off. The walk-in itself is owned by the dealer animator; this
// owns everything that happens once the new dealer has arrived.
//
// Mirrors the other animators: absolute performance.now() stamps here, the drawing
// (render/spawn.ts) reads these per-frame queries. One entry point, begin(), returns
// the timestamp the whole ceremony finishes so GameView can hold the next deal.

// One card: fly from its felt slot into the mouth (SUCK), while paper chunks spray
// out. Cards start their suck staggered so they're drawn in one after another.
const SHRED_STAGGER_MS = 70 // between successive cards starting their suck
const SHRED_SUCK_MS = 300 // one card: slot → mouth (shrinking to nothing)
const CHUNK_LEAD_MS = SHRED_SUCK_MS * 0.5 // chunks begin halfway through the suck
const SHRED_CHUNK_MS = 850 // one card's paper-chunk spray lifetime (bits fly far + linger)
// A short tail on the shred window (sfx only) so the shredder keeps chewing a beat past
// the last card before it fades — otherwise the fade-out starts feeling a touch early.
const SHRED_SFX_TAIL_MS = 200

// The previous dealer's whole DECK is shredded too — not as one lump, but card-by-card:
// 40 backs peel off the top in rapid sequence (the resting stack shrinking as each
// leaves) and fly into the mouth, starting right after the final table card and before
// the fresh deck flies in, so the shoe is empty when the replacement lands. Rapid stagger
// + short per-card suck keep it a fast flurry that only adds a few hundred ms overall.
const DECK_SHRED_CARDS = 40
const DECK_CARD_STAGGER_MS = 13 // between successive deck cards starting their suck
const DECK_CARD_SUCK_MS = 175 // one deck card: shoe top → mouth (shrinking to nothing)
const DECK_CARD_CHUNK_LEAD_MS = DECK_CARD_SUCK_MS * 0.45 // chunks begin partway through the suck
const DECK_CARD_CHUNK_MS = 600 // one deck card's paper-chunk spray lifetime (bits fly far + linger)

// The fresh deck: it emerges from the dealer as the old deck is drawn in, flies to
// the shoe, settles, then the plastic tears off over UNWRAP_MS.
const DECK_FLY_LEAD_MS = 120 // deck leaves the dealer slightly before the shoe clears
const DECK_SPAWN_DELAY_MS = 400 // beat held on the empty shoe after the old deck is shredded, before the fresh deck flies out
const DECK_FLY_MS = 400 // dealer → shoe
const DECK_SETTLE_MS = 70 // beat on the shoe before the wrap tears
const UNWRAP_MS = 860 // plastic opens in beats: edge strip peels + tosses → sheet slides off left → sheet flicks off right
// A beat held partway through the unwrap — after the edge strip has torn + tossed
// away (unwrap = UNWRAP_HOLD_AT), before the big sheet slides off left — so that
// beat (and its rustling sfx) lands a clear UNWRAP_HOLD_MS after the tear-open,
// instead of running straight into it. It stretches the unwrap's real duration by
// UNWRAP_HOLD_MS but leaves the visual beats themselves unchanged.
const UNWRAP_HOLD_AT = 0.5
const UNWRAP_HOLD_MS = 300

// The final dealer gets a grander presentation: the fresh deck's fly-in, settle, and
// unwrap all play slower and more deliberately, with a longer pause on the empty shoe
// and a longer mid-unwrap hold — so its arrival reads as the climax it is. Only the
// scaling changes; the beats themselves are the same. Applied when begin(grand=true).
const GRAND_SPAWN_DELAY_SCALE = 1.7
const GRAND_FLY_SCALE = 1.5
const GRAND_SETTLE_SCALE = 2.6
const GRAND_UNWRAP_SCALE = 1.3
const GRAND_HOLD_SCALE = 2.4

export interface DeckState {
  fly: number // 0..1 dealer → shoe (0 = at the dealer, 1 = landed)
  unwrap: number // 0..1 plastic tear-off (0 = wrapped, 1 = bare deck)
}

export class SpawnAnimation {
  private begun = false
  private t0 = 0
  private n = 0 // cards on the table to shred
  private hasOldDeck = false // whether the previous dealer's deck gets shredded too
  private deckShredStart = 0 // old deck: first card peels off the top
  private deckShredEnd = 0 // old deck: last card fully drawn in (shoe clear)
  private shredStartAt = 0 // first card begins being sucked into the mouth
  private shredEndAt = 0 // last card drawn in + a short sfx tail; 0 = nothing to shred
  private deckFlyStart = 0 // fresh deck: dealer → shoe
  private deckFlyEnd = 0
  private unwrapStart = 0
  private unwrapEnd = 0
  private endAt = 0
  // Durations for the fresh deck's fly-in + unwrap, stretched for the grand (final
  // dealer) ceremony. Held as fields so the per-frame queries scale to match begin().
  private flyMs = DECK_FLY_MS
  private unwrapMs = UNWRAP_MS
  private unwrapHoldMs = UNWRAP_HOLD_MS

  // Start the ceremony at `now`, shredding `cardCount` table cards (0 on page load,
  // where there are no previous cards). `shredOldDeck` also sucks the previous dealer's
  // resting deck into the mouth before the fresh one flies in (a kill / New run — false
  // on the opening intro, which has no old deck). Returns the timestamp the deck is
  // fully unwrapped and ready — the moment the next hand may deal.
  // `shredOnly` (game over): shred the table cards but fly NO fresh deck in — the run is
  // over, so there's no replacement. endAt is just the shred (+ its lingering chunks).
  begin(now: number, cardCount: number, shredOldDeck = false, grand = false, shredOnly = false, deckShredDelay = 0): number {
    this.begun = true
    this.t0 = now
    this.n = Math.max(0, cardCount)
    this.hasOldDeck = shredOldDeck

    // Stretch the fresh-deck beats for the grand (final dealer) ceremony; identity
    // scales (×1) otherwise, so every other spawn is unchanged.
    const spawnDelayMs = DECK_SPAWN_DELAY_MS * (grand ? GRAND_SPAWN_DELAY_SCALE : 1)
    const settleMs = DECK_SETTLE_MS * (grand ? GRAND_SETTLE_SCALE : 1)
    this.flyMs = DECK_FLY_MS * (grand ? GRAND_FLY_SCALE : 1)
    this.unwrapMs = UNWRAP_MS * (grand ? GRAND_UNWRAP_SCALE : 1)
    this.unwrapHoldMs = UNWRAP_HOLD_MS * (grand ? GRAND_HOLD_SCALE : 1)

    const lastCardSuckStart = this.n > 0 ? (this.n - 1) * SHRED_STAGGER_MS : 0
    const lastCardSuckEnd = this.n > 0 ? lastCardSuckStart + SHRED_SUCK_MS : 0

    // The old deck starts shredding one stagger step after the last table card starts, so its
    // cards are drawn in last; the fresh deck then flies once the shoe is clear. `deckShredDelay`
    // inserts a pause between the table cards and the deck (the Banker's entry uses it).
    this.deckShredStart = now + this.n * SHRED_STAGGER_MS + deckShredDelay
    const lastDeckCardStart = this.deckShredStart + (DECK_SHRED_CARDS - 1) * DECK_CARD_STAGGER_MS
    this.deckShredEnd = lastDeckCardStart + DECK_CARD_SUCK_MS

    // The shred window (for the shredder sfx): the cards being sucked into the mouth,
    // ending a short tail past the last one being fully drawn in — the lingering paper
    // chunks aren't part of it. Empty on the opening intro (nothing to shred).
    const hasCards = this.n > 0 || this.hasOldDeck
    this.shredStartAt = hasCards ? now : 0
    const lastCardIn = this.hasOldDeck ? this.deckShredEnd : now + lastCardSuckEnd
    this.shredEndAt = hasCards ? lastCardIn + SHRED_SFX_TAIL_MS : 0

    // The fresh deck flies out once the shoe is clear. With an old deck shredded, hold a
    // DECK_SPAWN_DELAY_MS beat on the empty shoe first (a clear gap between the old deck
    // vanishing and the new one arriving); on the intro (no old deck) it instead leaves the
    // dealer DECK_FLY_LEAD_MS before the last table card lands, as before.
    const deckFlyBase = this.hasOldDeck
      ? this.deckShredEnd + spawnDelayMs
      : now + lastCardSuckEnd - DECK_FLY_LEAD_MS
    this.deckFlyStart = Math.max(now, deckFlyBase)
    this.deckFlyEnd = this.deckFlyStart + this.flyMs
    this.unwrapStart = this.deckFlyEnd + settleMs
    this.unwrapEnd = this.unwrapStart + this.unwrapMs + this.unwrapHoldMs

    const lastCardChunkEnd =
      this.n > 0 ? now + lastCardSuckStart + CHUNK_LEAD_MS + SHRED_CHUNK_MS : 0
    const deckChunkEnd = this.hasOldDeck
      ? lastDeckCardStart + DECK_CARD_CHUNK_LEAD_MS + DECK_CARD_CHUNK_MS
      : 0
    if (shredOnly) {
      // No fresh deck: park the deck timeline past the end so deckState() never fires,
      // and finish once the shred + its chunks have settled.
      this.deckFlyStart = Number.POSITIVE_INFINITY
      this.deckFlyEnd = Number.POSITIVE_INFINITY
      this.unwrapStart = Number.POSITIVE_INFINITY
      this.unwrapEnd = Number.POSITIVE_INFINITY
      this.endAt = Math.max(this.shredEndAt, lastCardChunkEnd, deckChunkEnd)
      return this.endAt
    }
    this.endAt = Math.max(this.unwrapEnd, lastCardChunkEnd, deckChunkEnd)
    return this.endAt
  }

  isAnimating(now: number): boolean {
    return this.begun && now < this.endAt
  }

  // The moment the previous dealer's DECK starts being shredded (after every table card has begun
  // its own suck) — for effects that should land as the deck goes in, not the cards.
  get oldDeckShredStart(): number {
    return this.deckShredStart
  }

  // True while cards are being sucked into the mouth + shredded — drives the shredder
  // sfx. False before it starts, once the last card is in, and on the intro (nothing
  // to shred).
  isShredding(now: number): boolean {
    return this.begun && this.shredEndAt > this.shredStartAt && now >= this.shredStartAt && now < this.shredEndAt
  }

  // Card `i`'s suck-in progress: null while it's still resting on the felt (draw it
  // settled), else 0..1 as it flies into the mouth (1 = fully drawn in / gone).
  cardSuck(i: number, now: number): number | null {
    if (!this.begun) {
      return null
    }
    const start = this.t0 + i * SHRED_STAGGER_MS
    if (now < start) {
      return null
    }
    return clamp01((now - start) / SHRED_SUCK_MS)
  }

  // Card `i`'s paper-chunk spray life (0..1), or null when nothing is spraying for it.
  chunk(i: number, now: number): number | null {
    if (!this.begun) {
      return null
    }
    const start = this.t0 + i * SHRED_STAGGER_MS + CHUNK_LEAD_MS
    if (now < start) {
      return null
    }
    const p = (now - start) / SHRED_CHUNK_MS
    return p >= 1 ? null : p
  }

  // How many backs the outgoing deck sheds in its shred (fixed count the renderer loops).
  deckCardCount(): number {
    return DECK_SHRED_CARDS
  }

  // Fraction of the outgoing deck still resting on the shoe (1 = full, 0 = spent) — drives
  // the shrinking resting stack. Full until the shred reaches it; then depletes as each
  // card begins its peel-off, reaching 0 once the last card has left the top.
  deckRemaining(now: number): number {
    if (!this.begun || !this.hasOldDeck || now < this.deckShredStart) {
      return 1
    }
    const head = (now - this.deckShredStart) / DECK_CARD_STAGGER_MS // cards that have begun leaving
    return clamp01(1 - head / DECK_SHRED_CARDS)
  }

  // Old-deck card `k`'s suck-in progress: null while it's still resting on the shoe (no
  // old deck, or its stagger hasn't come up yet), else 0..1 as it flies into the mouth
  // (1 = fully drawn in / gone).
  deckCardSuck(k: number, now: number): number | null {
    if (!this.begun || !this.hasOldDeck) {
      return null
    }
    const start = this.deckShredStart + k * DECK_CARD_STAGGER_MS
    if (now < start) {
      return null
    }
    return clamp01((now - start) / DECK_CARD_SUCK_MS)
  }

  // Old-deck card `k`'s paper-chunk spray life (0..1), or null when it isn't spraying.
  deckCardChunk(k: number, now: number): number | null {
    if (!this.begun || !this.hasOldDeck) {
      return null
    }
    const start = this.deckShredStart + k * DECK_CARD_STAGGER_MS + DECK_CARD_CHUNK_LEAD_MS
    if (now < start) {
      return null
    }
    const p = (now - start) / DECK_CARD_CHUNK_MS
    return p >= 1 ? null : p
  }

  // The fresh deck's fly-in + unwrap state, or null before it emerges (during the
  // shred). Once past the unwrap it holds at { fly: 1, unwrap: 1 } — a bare resting
  // deck — until the ceremony ends and it's handed back to the static table layer.
  deckState(now: number): DeckState | null {
    if (!this.begun || now < this.deckFlyStart) {
      return null
    }
    if (now < this.deckFlyEnd) {
      return { fly: (now - this.deckFlyStart) / this.flyMs, unwrap: 0 }
    }
    if (now < this.unwrapStart) {
      return { fly: 1, unwrap: 0 }
    }
    if (now < this.unwrapEnd) {
      return { fly: 1, unwrap: this.unwrapProgress(now - this.unwrapStart) }
    }
    return { fly: 1, unwrap: 1 }
  }

  // Real elapsed unwrap time → unwrap fraction (0..1), with a plateau at
  // UNWRAP_HOLD_AT: the fraction climbs at the base rate, freezes there for
  // UNWRAP_HOLD_MS (the strip is gone, the sheet not yet sliding), then resumes —
  // so the slide-left beat is pushed UNWRAP_HOLD_MS later without altering its shape.
  private unwrapProgress(elapsed: number): number {
    const holdStart = UNWRAP_HOLD_AT * this.unwrapMs
    if (elapsed < holdStart) {
      return elapsed / this.unwrapMs
    }
    if (elapsed < holdStart + this.unwrapHoldMs) {
      return UNWRAP_HOLD_AT
    }
    return (elapsed - this.unwrapHoldMs) / this.unwrapMs
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
