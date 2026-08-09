// The mulligan discard: the tossed opening hand flips face-down and is swept up
// to the dealer (who mucks it) before the fresh cards are dealt. The cards are
// gone from play (spent + known — the odds already exclude them), so this is pure
// showmanship; it owns only the discard's timing, and the deal animator handles
// the redeal.

import type { Card } from '../game/deck'
import type { DiscardFrame } from '../render/cards'

const FLIP_MS = 160 // face-up → face-down
const FLY_MS = 420 // slot → dealer (eased in-out, fades into the muck near the end)
const STAGGER = 70 // between the two cards leaving

export class MulliganAnimation {
  private cards_: Card[] = []
  private start_ = 0
  private end_ = 0

  // Start discarding the tossed cards; returns when the last one finishes merging
  // into the deck, so the fresh cards can be scheduled to fly in right after.
  begin(cards: Card[], now: number): number {
    this.cards_ = cards.slice()
    this.start_ = now
    this.end_ = now + FLIP_MS + FLY_MS + STAGGER * Math.max(0, cards.length - 1)
    return this.end_
  }

  isAnimating(now: number): boolean {
    return this.cards_.length > 0 && now < this.end_
  }

  // Per-card flip + fly progress at `now`. A card waits in its slot until its
  // staggered start, flips face-down, then flies to the deck.
  frames(now: number): DiscardFrame[] {
    return this.cards_.map((card, i) => {
      const local = now - (this.start_ + i * STAGGER)
      if (local <= 0) {
        return { card, flip: 1, fly: 0 }
      }
      const flip = local < FLIP_MS ? 1 - local / FLIP_MS : 0
      const fly = local < FLIP_MS ? 0 : Math.min(1, (local - FLIP_MS) / FLY_MS)
      return { card, flip, fly }
    })
  }
}
