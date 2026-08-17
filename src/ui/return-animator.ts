// The Return ability's card toss: the most-recently-drawn card flips face-down
// and flies back onto the deck (the shoe). After it lands, a short beat, then the
// dealer reveals its hole and plays out (scheduled by GameView off this end time).
//
// Owns timing only (mirrors MulliganAnimation); render/cards.ts `drawReturnCard`
// does the drawing. One card, so no per-card stagger.

const FLIP_MS = 150 // face-up → face-down
const FLY_MS = 380 // slot → deck (eased, fades into the shoe near the end)

export class ReturnAnimation {
  private start_ = 0
  private end_ = 0
  private active_ = false

  // Begin the toss; returns when the card has merged into the deck.
  begin(now: number): number {
    this.start_ = now
    this.end_ = now + FLIP_MS + FLY_MS
    this.active_ = true
    return this.end_
  }

  isAnimating(now: number): boolean {
    return this.active_ && now < this.end_
  }

  // {flip: 1→0, fly: 0→1} at `now`: flip face-down first, then fly to the deck.
  frame(now: number): { flip: number; fly: number } {
    const local = now - this.start_
    if (local <= 0) {
      return { flip: 1, fly: 0 }
    }
    const flip = local < FLIP_MS ? 1 - local / FLIP_MS : 0
    const fly = local < FLIP_MS ? 0 : Math.min(1, (local - FLIP_MS) / FLY_MS)
    return { flip, fly }
  }
}
