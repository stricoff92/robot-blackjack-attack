// The fly-in SCORE DELTAS: when a hand's green checks land in the dealer hand-summary, each winning
// check launches a "+N" that arcs up to a stacked row below the top-right score counter, ticks the
// counter as it arrives, pings a tone, then holds in an ascending list until the next hand clears it.
// A dealer kill spawns one per green check (the win + every cash-in bonus). This is a pure clock +
// bookkeeping; render/score-deltas.ts draws it, GameView drives the counter tick + tone off landed().

import { DELTA_FADE_MS, DELTA_FLY_MS } from '../render/score-deltas'
import type { Point } from '../render/tokens'

export interface DeltaFlight {
  /** The points this check banked (the "+N" shown). */
  value: number
  /** Launch point (the green check's centre) in canvas coords. */
  from: Point
  /** Stack position below the counter — 0 is the top row, growing downward (an ascending list). */
  rowIndex: number
  launchAt: number
  landAt: number
  /** Set once landed() has reported this flight (so the counter ticks + tone ping once each). */
  reported: boolean
}

export class ScoreDeltaFly {
  private flights_: DeltaFlight[] = []
  private clearAt_ = 0

  // Launch a delta from `from` at `launchAt`, landing in row `rowIndex`.
  emit(value: number, from: Point, rowIndex: number, launchAt: number): void {
    this.flights_.push({ value, from, rowIndex, launchAt, landAt: launchAt + DELTA_FLY_MS, reported: false })
  }

  hasFlights(): boolean {
    return this.flights_.length > 0
  }

  // Something to draw: any flight in the air, or the settled list still fading in/holding.
  isAnimating(now: number): boolean {
    if (this.flights_.length === 0) {
      return false
    }
    return this.clearAt_ === 0 || now < this.clearAt_ + DELTA_FADE_MS
  }

  // Every flight that hasn't landed yet (before its landAt) — the consent gate waits these out so the
  // last "+N" reaches the counter before the next hand can clear the list.
  lastLandAt(): number {
    return this.flights_.reduce((max, f) => Math.max(max, f.landAt), 0)
  }

  // The values that reached their row since the last call, in landing order — the caller ticks the
  // counter up by each and pings the arrival tone once per entry.
  landed(now: number): number[] {
    const out: number[] = []
    for (const f of this.flights_) {
      if (!f.reported && now >= f.landAt) {
        f.reported = true
        out.push(f.value)
      }
    }
    return out
  }

  // The next hand was called: start fading the whole settled list out.
  clear(now: number): void {
    if (this.flights_.length > 0 && this.clearAt_ === 0) {
      this.clearAt_ = now
    }
  }

  // Wipe immediately with no fade — a fresh resolve (new deltas incoming) or a new run.
  reset(): void {
    this.flights_ = []
    this.clearAt_ = 0
  }

  clearAt(): number {
    return this.clearAt_
  }

  flights(): readonly DeltaFlight[] {
    return this.flights_
  }
}
