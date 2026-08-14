import { describe, expect, it } from 'vitest'
import { maxHitsFor } from '../game/run'
import { DAMAGE_ANIM_MS, DealerAnimation, STRIKE_TRAVEL_MS } from './dealer-animator'

// Tremors are now bounded to the post-hit damage window [IMPACT, WINDOW_END): they fade in below
// 50% health and fire more often the lower it is, every shudder at the SAME noticeable magnitude.
// (Because the window (3200ms) is comparable to the shudder interval, a light hit near the top of
// the band may fire only 0-1 pulses — the cadence is unchanged, just observed over a short window.)
const IMPACT = STRIKE_TRAVEL_MS
const WINDOW_END = IMPACT + DAMAGE_ANIM_MS

// A plain hit (same shift, integrity drops) leaving the dealer at healthPct% health.
function hitAt(healthPct: number): DealerAnimation {
  const d = new DealerAnimation()
  const max = maxHitsFor(1)
  d.sync(max, 1, (healthPct / 100) * max, 1, 0)
  return d
}

// Largest shudder magnitude over the damage window (0 if it never fires).
function peakAmp(d: DealerAnimation, until = WINDOW_END, step = 10): number {
  let max = 0
  for (let now = 0; now <= until; now += step) {
    const { x, y } = d.tremor(now)
    max = Math.max(max, Math.abs(x), Math.abs(y))
  }
  return max
}

// Count discrete shudder pulses over the window: a run of non-zero offset, pulses separated by
// ≥100ms of exact stillness (between pulses the offset is exactly {0,0}).
function countPulses(d: DealerAnimation, until = WINDOW_END, step = 5): number {
  let count = 0
  let zeroRun = Infinity
  let inPulse = false
  for (let now = 0; now <= until; now += step) {
    const { x, y } = d.tremor(now)
    if (x === 0 && y === 0) {
      zeroRun += step
      if (zeroRun >= 100) inPulse = false
    } else {
      if (!inPulse) { count++; inPulse = true }
      zeroRun = 0
    }
  }
  return count
}

describe('dealer damage tremor (bounded to the post-hit window)', () => {
  it('is silent when the hit leaves the dealer at or above 50% health', () => {
    expect(peakAmp(hitAt(50))).toBe(0)
    expect(peakAmp(hitAt(75))).toBe(0)
  })

  it('is silent for an idle (un-hit) dealer, even a badly damaged one', () => {
    const d = new DealerAnimation()
    d.setLevel((8 / 100) * maxHitsFor(1), 1)
    expect(peakAmp(d)).toBe(0)
  })

  it('is silent once the window has closed', () => {
    const d = hitAt(8)
    let max = 0
    for (let now = WINDOW_END + 10; now <= WINDOW_END + 6000; now += 10) {
      const { x, y } = d.tremor(now)
      max = Math.max(max, Math.abs(x), Math.abs(y))
    }
    expect(max).toBe(0)
  })

  it('fires below 50%, at a full, noticeable magnitude — not scaled down near the top', () => {
    // Damage changes how OFTEN shudders hit, not how hard: a near-death shudder is full-strength.
    const NOTICEABLE = 0.08 // headR-fraction units
    expect(peakAmp(hitAt(8))).toBeGreaterThan(NOTICEABLE)
  })

  it('fires more often the lower the post-hit health', () => {
    expect(countPulses(hitAt(2))).toBeGreaterThan(countPulses(hitAt(40)))
  })

  it('is suppressed mid-transition (e.g. the game-over walk-off)', () => {
    const d = hitAt(8)
    expect(peakAmp(d)).toBeGreaterThan(0) // fires while standing inside the window
    d.walkOff(0) // now striding off the screen
    let max = 0
    for (let now = 0; now < 1300; now += 20) {
      const { x, y } = d.tremor(now)
      max = Math.max(max, Math.abs(x), Math.abs(y))
    }
    expect(max).toBe(0)
  })

  it('is deterministic — same hit + time reproduces the same offset', () => {
    expect(hitAt(8).tremor(1_700)).toEqual(hitAt(8).tremor(1_700))
  })
})
