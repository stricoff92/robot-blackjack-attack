// The Bust Block reveal: when the shield catches a busting draw, that card is
// still shown so the player sees the bust they hit — and that it was blocked.
// The card flies in from the shoe face-down, flips up to reveal the bust, holds
// while the gold shield ring catches it, then flips face-down and is swept off
// to the dealer's muck. Any replacement card is dealt only AFTER that, scheduled
// by GameView off the returned end time.
//
// Owns timing only (mirrors ReturnAnimation); render/cards.ts `drawBustBlock`
// does the drawing.

import type { BustBlockFrame } from '../render/cards'

const FLY_MS = 200 // shoe → slot (face-down)
const FLIP_MS = 170 // reveal flip up
const HOLD_MS = 620 // dwell face-up so the bust registers + the shield catches it
const EJECT_FLIP_MS = 150 // flip face-down before it's swept away
const EJECT_FLY_MS = 360 // slot → dealer muck (fades out near the end)

export class BustBlockAnimation {
  private start_ = 0
  private end_ = 0
  private active_ = false

  // Begin the reveal at `now`; returns when the busting card has left for the
  // muck — the moment a replacement + the dealer's play can be scheduled to
  // follow. `now` may be a short beat ahead of the action (e.g. behind a Peek
  // Deck card flipping back down first).
  begin(now: number): number {
    this.start_ = now
    this.end_ = now + FLY_MS + FLIP_MS + HOLD_MS + EJECT_FLIP_MS + EJECT_FLY_MS
    this.active_ = true
    return this.end_
  }

  isAnimating(now: number): boolean {
    return this.active_ && now >= this.start_ && now < this.end_
  }

  // The card's flight/flip/eject progress + shield-flash intensity at `now`.
  frame(now: number): BustBlockFrame {
    let local = now - this.start_
    // Fly in from the shoe, face-down.
    if (local < FLY_MS) {
      return { flight: Math.max(0, local) / FLY_MS, flip: 0, fly: 0, shield: 0 }
    }
    local -= FLY_MS
    // Reveal flip — the shield ramps in as the face turns up.
    if (local < FLIP_MS) {
      const flip = local / FLIP_MS
      return { flight: 1, flip, fly: 0, shield: flip }
    }
    local -= FLIP_MS
    // Hold face-up, shield fully caught.
    if (local < HOLD_MS) {
      return { flight: 1, flip: 1, fly: 0, shield: 1 }
    }
    local -= HOLD_MS
    // Flip face-down, shield releasing.
    if (local < EJECT_FLIP_MS) {
      const t = local / EJECT_FLIP_MS
      return { flight: 1, flip: 1 - t, fly: 0, shield: 1 - t }
    }
    local -= EJECT_FLIP_MS
    // Sweep off to the muck.
    return { flight: 1, flip: 0, fly: Math.min(1, local / EJECT_FLY_MS), shield: 0 }
  }
}
