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
  private from_: number
  private target_: number
  private start_ = 0
  private end_ = 0

  // When true, decreases roll (tick + swell) the same as increases instead of
  // snapping — used by the token counter, whose spends should count down.
  constructor(initial = 0, private readonly rollDown_ = false) {
    this.from_ = initial
    this.target_ = initial
  }

  // The roll length (ms) for a given jump — exposed so a caller can time other
  // effects to finish exactly when the counter does (the token-land sfx spreads
  // its per-token pings across this window so the last lands as the number settles).
  static rollDurationMs(jump: number): number {
    return clamp(MIN_MS + Math.abs(jump) * MS_PER_UNIT, MIN_MS, MAX_MS)
  }

  // Jump straight to `value`, no roll — for the initial sync and resets (a New
  // run zeroing the count shouldn't dramatically count down).
  set(value: number): void {
    this.from_ = value
    this.target_ = value
    this.start_ = 0
    this.end_ = 0
  }

  // Aim at `value`, rolling from whatever shows right now. By default a decrease
  // snaps — instant is the right feedback for a cost (a bet placed, the house paid);
  // a `rollDown` ticker instead counts DOWN, ticking + swelling just like a rise.
  // A no-op when already headed there. Pass `durationMs` to override the auto length
  // — e.g. to match the roll to a sfx cascade so the number lands with the last tone.
  retarget(value: number, now: number, durationMs?: number): void {
    if (value === this.target_) {
      return
    }
    if (value < this.target_ && !this.rollDown_) {
      this.set(value)
      return
    }
    this.from_ = this.value(now)
    this.target_ = value
    this.start_ = now
    this.end_ = now + (durationMs ?? CountTicker.rollDurationMs(value - this.from_))
  }

  isAnimating(now: number): boolean {
    return now < this.end_
  }

  // Milliseconds until the current roll settles (0 at rest) — lets a caller run a
  // sound for exactly as long as the number is visibly ticking.
  remainingMs(now: number): number {
    return Math.max(0, this.end_ - now)
  }

  // The integer to show this frame.
  value(now: number): number {
    return Math.round(this.from_ + (this.target_ - this.from_) * this.progress_(now))
  }

  // 1 at rest, swelling to 1 + SWELL mid-roll and easing back — a pop that tracks
  // the roll, so a bigger reward swells for a touch longer.
  scale(now: number): number {
    if (now >= this.end_ || now < this.start_) {
      return 1
    }
    return 1 + SWELL * arch2(this.progress_(now))
  }

  private progress_(now: number): number {
    if (now >= this.end_) {
      return 1
    }
    if (now <= this.start_ || this.end_ <= this.start_) {
      return 0
    }
    return smoothStep((now - this.start_) / (this.end_ - this.start_))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
