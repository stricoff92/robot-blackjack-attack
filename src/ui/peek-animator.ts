// Peek Deck's top-card flip. Buying the peek flips the shoe's top card face-up
// in place so the player can read the next card; their next move flips it back
// face-down, after which the normal deal takes over (the drawn card flies from
// the shoe + flips up as usual, so no deal-animator change is needed).
//
// Owns timing only (mirrors ReturnAnimation); render/cards.ts `drawPeekCard`
// does the drawing.

export const PEEK_FLIP_MS = 160

export class PeekFlipAnimation {
  private start = 0
  private end = 0
  private up = true

  // Flip the top card face-up (on buy) or face-down (on the next move). Returns
  // the time the flip completes, so a following deal can be delayed behind it.
  flip(now: number, faceUp: boolean): number {
    this.start = now
    this.end = now + PEEK_FLIP_MS
    this.up = faceUp
    return this.end
  }

  isAnimating(now: number): boolean {
    return now < this.end
  }

  // Flip progress at `now`: 0 = back, 1 = face. Holds at its end value once the
  // flip completes — 1 after a face-up flip (the card rests face-up while the
  // peek is live), 0 after a face-down one.
  progress(now: number): number {
    const p = Math.min(1, Math.max(0, (now - this.start) / PEEK_FLIP_MS))
    return this.up ? p : 1 - p
  }
}
