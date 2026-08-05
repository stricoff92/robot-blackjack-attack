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
const SHRED_CHUNK_MS = 650 // one card's paper-chunk spray lifetime

// The fresh deck: it emerges from the dealer as the last card is drawn in, flies to
// the shoe, settles, then the plastic tears off over UNWRAP_MS.
const DECK_FLY_LEAD_MS = 120 // deck leaves the dealer slightly before the last card lands
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
  private deckFlyStart = 0
  private deckFlyEnd = 0
  private unwrapStart = 0
  private unwrapEnd = 0
  private endAt = 0

  // Start the ceremony at `now`, shredding `cardCount` table cards (0 on page load /
  // a fresh run, where there are no previous cards). Returns the timestamp the deck
  // is fully unwrapped and ready — the moment the next hand may deal.
  begin(now: number, cardCount: number): number {
    this.begun = true
    this.t0 = now
    this.n = Math.max(0, cardCount)

    const lastSuckEnd = this.n > 0 ? (this.n - 1) * SHRED_STAGGER_MS + SHRED_SUCK_MS : 0
    this.deckFlyStart = now + Math.max(0, lastSuckEnd - DECK_FLY_LEAD_MS)
    this.deckFlyEnd = this.deckFlyStart + DECK_FLY_MS
    this.unwrapStart = this.deckFlyEnd + DECK_SETTLE_MS
    this.unwrapEnd = this.unwrapStart + UNWRAP_MS

    const lastChunkEnd =
      this.n > 0 ? now + (this.n - 1) * SHRED_STAGGER_MS + CHUNK_LEAD_MS + SHRED_CHUNK_MS : 0
    this.endAt = Math.max(this.unwrapEnd, lastChunkEnd)
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
