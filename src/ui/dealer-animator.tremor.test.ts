import { describe, expect, it } from 'vitest'
import { DealerAnimation } from './dealer-animator'

// Dealer 1's max integrity is 100, so setLevel(n, 1) sets health to exactly n%. Tremors fade
// in below 50%: every shudder is the SAME noticeable magnitude, but they fire more often the
// lower the health.
function at(healthPct: number): DealerAnimation {
  const d = new DealerAnimation()
  d.setLevel(healthPct, 1)
  return d
}

// Largest shudder magnitude over a time sweep (0 if it never fires).
function peakAmp(d: DealerAnimation, until = 40_000, step = 10): number {
  let max = 0
  for (let now = 0; now <= until; now += step) {
    const { x, y } = d.tremor(now)
    max = Math.max(max, Math.abs(x), Math.abs(y))
  }
  return max
}

// Count discrete shudder pulses over a window: a run of non-zero offset, pulses separated by
// ≥100ms of exact stillness (between pulses the offset is exactly {0,0}).
function countPulses(d: DealerAnimation, windowMs: number, step = 5): number {
  let count = 0
  let zeroRun = Infinity
  let inPulse = false
  for (let now = 0; now <= windowMs; now += step) {
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

describe('dealer damage tremor', () => {
  it('is silent at or above 50% health', () => {
    expect(peakAmp(at(50))).toBe(0)
    expect(peakAmp(at(75))).toBe(0)
    expect(peakAmp(at(100))).toBe(0)
  })

  it('fires below 50%', () => {
    expect(peakAmp(at(45))).toBeGreaterThan(0)
  })

  it('shakes at a full, noticeable magnitude at every level — not scaled down near the top', () => {
    // The whole point: a 45%-health shudder is just as strong as a 10% one. Damage changes
    // how OFTEN they hit, not how hard. (The old design collapsed to ~0.004 at 45%.)
    const NOTICEABLE = 0.08 // headR-fraction units
    expect(peakAmp(at(45))).toBeGreaterThan(NOTICEABLE)
    expect(peakAmp(at(10))).toBeGreaterThan(NOTICEABLE)
  })

  it('fires more often the lower the health', () => {
    expect(countPulses(at(10), 24_000)).toBeGreaterThan(countPulses(at(40), 24_000))
  })

  it('never fires more than ~once per second, even at death', () => {
    const n = countPulses(at(2), 10_000)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(11)
  })

  it('is suppressed mid-transition (e.g. the game-over walk-off)', () => {
    const d = at(8)
    expect(peakAmp(d, 6000)).toBeGreaterThan(0) // fires while standing
    d.walkOff(0) // now striding off the screen
    let max = 0
    for (let now = 0; now < 1300; now += 20) {
      const { x, y } = d.tremor(now)
      max = Math.max(max, Math.abs(x), Math.abs(y))
    }
    expect(max).toBe(0)
  })

  it('is deterministic — same health + time reproduces the same offset', () => {
    expect(at(30).tremor(9_999)).toEqual(at(30).tremor(9_999))
  })
})
