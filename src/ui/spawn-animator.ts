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
  private deckFlyStart = 0 // fresh deck: dealer → shoe
  private deckFlyEnd = 0
  private unwrapStart = 0
  private unwrapEnd = 0
  private endAt = 0

  // Start the ceremony at `now`, shredding `cardCount` table cards (0 on page load,
  // where there are no previous cards). `shredOldDeck` also sucks the previous dealer's
  // resting deck into the mouth before the fresh one flies in (a kill / New run — false
  // on the opening intro, which has no old deck). Returns the timestamp the deck is
  // fully unwrapped and ready — the moment the next hand may deal.
  begin(now: number, cardCount: number, shredOldDeck = false): number {
    this.begun = true
    this.t0 = now
    this.n = Math.max(0, cardCount)
    this.hasOldDeck = shredOldDeck

    const lastCardSuckStart = this.n > 0 ? (this.n - 1) * SHRED_STAGGER_MS : 0
    const lastCardSuckEnd = this.n > 0 ? lastCardSuckStart + SHRED_SUCK_MS : 0

    // The old deck starts shredding one stagger step after the last table card starts, so
    // its cards are drawn in last; the fresh deck then flies once the shoe is clear.
    this.deckShredStart = now + this.n * SHRED_STAGGER_MS
    const lastDeckCardStart = this.deckShredStart + (DECK_SHRED_CARDS - 1) * DECK_CARD_STAGGER_MS
    this.deckShredEnd = lastDeckCardStart + DECK_CARD_SUCK_MS

    // The fresh deck flies out once the shoe is clear. With an old deck shredded, hold a
    // DECK_SPAWN_DELAY_MS beat on the empty shoe first (a clear gap between the old deck
    // vanishing and the new one arriving); on the intro (no old deck) it instead leaves the
    // dealer DECK_FLY_LEAD_MS before the last table card lands, as before.
    const deckFlyBase = this.hasOldDeck
      ? this.deckShredEnd + DECK_SPAWN_DELAY_MS
      : now + lastCardSuckEnd - DECK_FLY_LEAD_MS
    this.deckFlyStart = Math.max(now, deckFlyBase)
    this.deckFlyEnd = this.deckFlyStart + DECK_FLY_MS
    this.unwrapStart = this.deckFlyEnd + DECK_SETTLE_MS
    this.unwrapEnd = this.unwrapStart + UNWRAP_MS

    const lastCardChunkEnd =
      this.n > 0 ? now + lastCardSuckStart + CHUNK_LEAD_MS + SHRED_CHUNK_MS : 0
    const deckChunkEnd = this.hasOldDeck
      ? lastDeckCardStart + DECK_CARD_CHUNK_LEAD_MS + DECK_CARD_CHUNK_MS
      : 0
    this.endAt = Math.max(this.unwrapEnd, lastCardChunkEnd, deckChunkEnd)
    return this.endAt
  }

  isAnimating(now: number): boolean {
    return this.begun && now < this.endAt
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
      return { fly: (now - this.deckFlyStart) / DECK_FLY_MS, unwrap: 0 }
    }
    if (now < this.unwrapStart) {
      return { fly: 1, unwrap: 0 }
    }
    if (now < this.unwrapEnd) {
      return { fly: 1, unwrap: (now - this.unwrapStart) / UNWRAP_MS }
    }
    return { fly: 1, unwrap: 1 }
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
