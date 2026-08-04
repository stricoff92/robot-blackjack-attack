// A numeric readout that ROLLS from one value to the next instead of snapping —
// ticking through the integers between and swelling in scale while it runs, so a
// reward counts up into place (tokens landing at the counter, a payout merging
// into the bankroll). It owns only timing and the current display value; the
// caller reads value()/scale() each frame and paints it however it likes — DOM
// text for the token counter, a canvas label for the bankroll. Mirrors the *View
// split the deal/chip/token animators use: state lives here, rendering outside.

import { arch2, smoothStep } from '../render/easing'

// A roll's length scales with how far it has to travel — a +1 hit is a quick
// pop, a +40 kill rolls a beat longer — but never past MAX_MS.
const MIN_MS = 200
const MAX_MS = 520
const MS_PER_UNIT = 16
// Extra scale at the peak of the swell (1.2×), eased up and back down over the
// roll so the counter breathes rather than jerking to a fixed keyframe.
const SWELL = 0.2

export class CountTicker {
  private from: number
  private target: number
  private start = 0
  private end = 0

  constructor(initial = 0) {
    this.from = initial
    this.target = initial
  }

  // Jump straight to `value`, no roll — for the initial sync and resets (a New
  // run zeroing the count shouldn't dramatically count down).
  set(value: number): void {
    this.from = value
    this.target = value
    this.start = 0
    this.end = 0
  }

  // Aim at `value`, rolling up from whatever shows right now. A decrease snaps
  // (spending tokens, paying the house) — only rewards roll; instant is the right
  // feedback for a cost. A no-op when already headed there.
  retarget(value: number, now: number): void {
    if (value === this.target) {
      return
    }
    if (value < this.target) {
      this.set(value)
      return
    }
    this.from = this.value(now)
    this.target = value
    this.start = now
    const jump = value - this.from
    this.end = now + clamp(MIN_MS + jump * MS_PER_UNIT, MIN_MS, MAX_MS)
  }

  isAnimating(now: number): boolean {
    return now < this.end
  }

  // The integer to show this frame.
  value(now: number): number {
    return Math.round(this.from + (this.target - this.from) * this.progress(now))
  }

  // 1 at rest, swelling to 1 + SWELL mid-roll and easing back — a pop that tracks
  // the roll, so a bigger reward swells for a touch longer.
  scale(now: number): number {
    if (now >= this.end || now < this.start) {
      return 1
    }
    return 1 + SWELL * arch2(this.progress(now))
  }

  private progress(now: number): number {
    if (now >= this.end) {
      return 1
    }
    if (now <= this.start || this.end <= this.start) {
      return 0
    }
    return smoothStep((now - this.start) / (this.end - this.start))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
