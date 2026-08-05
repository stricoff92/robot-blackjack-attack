// Timing for the dealer's health bar.
//
// Two moves:
//   • a normal hit — the fill drops to the new level and the removed slice
//     flashes then fades away; and
//   • a destroy — when the dealer's health is spent it drains fully to empty,
//     pauses, then the replacement dealer's bar fills back up.
//
// Mirrors DealAnimation / ChipAnimation: this owns timing, render/health.ts owns
// geometry + paint. The change is scheduled `startAfter` a timestamp so the drop
// can wait for the card sequence to settle — damage lands with the payout.

import { FULL_INTEGRITY } from '../game/run'
import { smoothEnd3, smoothStep } from '../render/easing'
import type { Ghost, HealthView } from '../render/health'
import { KILL_ARRIVE_MS, KILL_DEATH_LEAD_MS, KILL_DYING_MS, KILL_GONE_MS } from './dealer-animator'

const DROP_MS = 640 // removed slice flashes then fades (a normal hit)
// Kill timing is locked to the dealer death choreography (dealer-animator.ts) so
// the two never drift: the bar drains as the figure breaks apart, sits empty
// through the gap while the old dealer is gone, then refills exactly as the
// replacement walks in. drain → pause → refill sums to the same 1700ms window.
const DRAIN_MS = KILL_DEATH_LEAD_MS + KILL_DYING_MS * 0.6 // empty by the time it's mostly rubble
const KILL_PAUSE = KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS - DRAIN_MS // drainEnd → arrival
const REFILL_MS = KILL_ARRIVE_MS // fills as the new dealer walks in

type Mode = 'none' | 'drop' | 'kill' | 'refill'

export class HealthAnimation implements HealthView {
  private mode: Mode = 'none'
  private from = 1 // fill fraction before the change
  private to = 1 // fill fraction after the change (the settled level)
  private start = 0 // when the change begins (may be scheduled in the future)
  private end = 0
  // Kill sub-timings.
  private drainEnd = 0
  private refillStart = 0

  isAnimating(now: number): boolean {
    return this.mode !== 'none' && now < this.end
  }

  // Register an integrity change between two run states. A rising shift index
  // means the old dealer was destroyed and a fresh one took over.
  sync(
    prevIntegrity: number,
    prevShift: number,
    nextIntegrity: number,
    nextShift: number,
    startAfter: number,
  ): void {
    const from = frac(prevIntegrity)
    const to = frac(nextIntegrity)

    if (nextShift > prevShift) {
      this.mode = 'kill'
      this.from = from
      this.to = to // FULL, for the incoming dealer
      this.start = startAfter
      this.drainEnd = startAfter + DRAIN_MS
      this.refillStart = this.drainEnd + KILL_PAUSE
      this.end = this.refillStart + REFILL_MS
      return
    }
    if (to < from) {
      this.mode = 'drop'
      this.from = from
      this.to = to
      this.start = startAfter
      this.end = startAfter + DROP_MS
      return
    }
    if (to > from) {
      this.mode = 'refill'
      this.from = from
      this.to = to
      this.start = startAfter
      this.end = startAfter + REFILL_MS
      return
    }
    this.settle(to) // no change
  }

  level(now: number): number {
    if (this.mode === 'refill') {
      if (now <= this.start) {
        return this.from
      }
      if (now >= this.end) {
        return this.to
      }
      return lerp(this.from, this.to, smoothStep((now - this.start) / REFILL_MS))
    }
    if (this.mode === 'kill') {
      if (now < this.start) {
        return this.from
      }
      if (now < this.refillStart) {
        return 0 // drained: empty through the drain + pause
      }
      if (now >= this.end) {
        return this.to
      }
      return lerp(0, this.to, smoothStep((now - this.refillStart) / REFILL_MS))
    }
    if (this.mode === 'drop') {
      return now < this.start ? this.from : this.to
    }
    return this.to
  }

  ghost(now: number): Ghost | null {
    if (this.mode === 'drop') {
      if (now < this.start || now >= this.end) {
        return null
      }
      return { lo: this.to, hi: this.from, fade: 1 - smoothStep((now - this.start) / DROP_MS) }
    }
    if (this.mode === 'kill') {
      if (now < this.start || now >= this.drainEnd) {
        return null
      }
      return { lo: 0, hi: this.from, fade: 1 - smoothEnd3((now - this.start) / DRAIN_MS) }
    }
    return null
  }

  // Snap the settled fill to a given integrity without animating — used on load so a
  // dealer that starts partway damaged (the dealerHealth dev override) shows the
  // right bar from the first frame.
  set(integrity: number): void {
    this.settle(frac(integrity))
  }

  private settle(level: number): void {
    this.mode = 'none'
    this.from = level
    this.to = level
    this.start = 0
    this.end = 0
  }
}

function frac(integrity: number): number {
  return clamp01(Math.max(0, integrity) / FULL_INTEGRITY)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
