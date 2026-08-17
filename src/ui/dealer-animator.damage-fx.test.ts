import { describe, expect, it } from 'vitest'
import { maxHitsFor } from '../game/run'
import { DAMAGE_ANIM_MS, DealerAnimation, STRIKE_TRAVEL_MS } from './dealer-animator'

// The damage sparks/smoke are now a BOUNDED per-hit reaction, not a persistent low-health readout:
// a hit opens a DAMAGE_ANIM_MS window, and the burst density inside it still keys off the post-hit
// health fraction (nothing at/above 75%, ramping denser toward 0). Drive a real hit and sample
// inside the window; `maxTs` (damageWindowEnd) caps the spawn so nothing is cut off at the edge.
const IMPACT = STRIKE_TRAVEL_MS // impact time for a hit scheduled at startAfter = 0
const WINDOW_END = IMPACT + DAMAGE_ANIM_MS // the hit's seqEnd_ / damageWindowEnd

// A plain hit (same shift, integrity drops) leaving the dealer at healthPct% health.
function hitAt(healthPct: number): DealerAnimation {
  const d = new DealerAnimation()
  const max = maxHitsFor(1)
  d.sync(max, 1, (healthPct / 100) * max, 1, 0)
  return d
}

describe('dealer damage FX (damageBursts)', () => {
  const IN = IMPACT + 500 // comfortably inside the window
  const STEADY = 1600 // far enough in that a full FX_BURST_LIFE of bursts is live, before the fade cap

  it('emits nothing when a hit leaves the dealer at or above the 75% threshold', () => {
    expect(hitAt(80).damageBursts(IN, WINDOW_END)).toEqual([])
    expect(hitAt(75).damageBursts(IN, WINDOW_END)).toEqual([])
  })

  it('emits nothing outside a damage window (a damaged but un-hit / idle dealer reads mint)', () => {
    const d = new DealerAnimation()
    d.setLevel((20 / 100) * maxHitsFor(1), 1) // low health, but no hit → no window
    expect(d.damageBursts(50_000, d.damageWindowEnd())).toEqual([])
  })

  it('emits bursts once a hit drops below the threshold', () => {
    expect(hitAt(74).damageBursts(IN, WINDOW_END).length).toBeGreaterThan(0)
  })

  it('fires more, stronger bursts the lower the post-hit health', () => {
    const mid = hitAt(50).damageBursts(STEADY, WINDOW_END)
    const low = hitAt(10).damageBursts(STEADY, WINDOW_END)
    expect(mid.length).toBeGreaterThan(0)
    expect(low.length).toBeGreaterThanOrEqual(mid.length)
    expect(low[0].power).toBeGreaterThan(mid[0].power) // intensity rises as health falls
  })

  it('reports only live bursts — ages within the lifetime, distinct seeds, power in (0,1]', () => {
    const bursts = hitAt(20).damageBursts(STEADY, WINDOW_END)
    expect(bursts.length).toBeGreaterThan(0)
    for (const b of bursts) {
      expect(b.age).toBeGreaterThanOrEqual(0)
      expect(b.age).toBeLessThanOrEqual(1200) // FX_BURST_LIFE
      expect(b.power).toBeGreaterThan(0)
      expect(b.power).toBeLessThanOrEqual(1)
    }
    const seeds = bursts.map((b) => b.seed)
    expect(new Set(seeds).size).toBe(seeds.length)
  })

  it('caps the spawn near the window edge so no half-born burst is cut off', () => {
    const d = hitAt(20)
    const full = d.damageBursts(STEADY, WINDOW_END) // whole window still ahead
    const soon = d.damageBursts(STEADY, STEADY + 500) // window closing in 500ms
    const closing = d.damageBursts(STEADY, STEADY) // window closing right now
    expect(soon.length).toBeLessThan(full.length)
    expect(closing.length).toBe(0) // no burst could fully fade → none spawned
  })

  it('is deterministic — the same hit + time reproduces the same bursts', () => {
    expect(hitAt(30).damageBursts(STEADY, WINDOW_END)).toEqual(hitAt(30).damageBursts(STEADY, WINDOW_END))
  })
})
