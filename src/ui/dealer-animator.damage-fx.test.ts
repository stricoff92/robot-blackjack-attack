import { describe, expect, it } from 'vitest'
import { maxHitsFor } from '../game/run'
import { DealerAnimation } from './dealer-animator'

// setLevel scales integrity by the dealer's max HIT count (maxHitsFor), so passing
// (pct/100)×maxHits sets the health fraction to exactly pct%. The damage sparks/smoke
// (damageBursts) key off that fraction: nothing at/above 75%, ramping denser toward 0.
function at(healthPct: number): DealerAnimation {
  const d = new DealerAnimation()
  d.setLevel((healthPct / 100) * maxHitsFor(1), 1)
  return d
}

describe('dealer damage FX (damageBursts)', () => {
  it('emits nothing at or above the 75% threshold', () => {
    expect(at(100).damageBursts(50_000)).toEqual([])
    expect(at(80).damageBursts(50_000)).toEqual([])
    expect(at(75).damageBursts(50_000)).toEqual([])
  })

  it('emits bursts once below the threshold', () => {
    expect(at(74).damageBursts(50_000).length).toBeGreaterThan(0)
  })

  it('fires more, stronger bursts the lower the health', () => {
    const now = 500_000 // well past the burst window, so the active count is steady
    const mid = at(50).damageBursts(now)
    const low = at(10).damageBursts(now)
    expect(mid.length).toBeGreaterThan(0)
    expect(low.length).toBeGreaterThanOrEqual(mid.length)
    expect(low[0].power).toBeGreaterThan(mid[0].power) // intensity rises as health falls
  })

  it('reports only live bursts — ages within the lifetime, distinct seeds, power in (0,1]', () => {
    const bursts = at(20).damageBursts(500_000)
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

  it('is deterministic — the same health + time reproduces the same bursts', () => {
    expect(at(30).damageBursts(123_456)).toEqual(at(30).damageBursts(123_456))
  })

  it('holds the FX at the pre-kill level until the DEFERRED laser strikes (not the click)', () => {
    // A deferred kill: the Next-hand click schedules the laser for t=1000 (startAfter), and
    // sync() jumps the model level to the incoming dealer's FULL health. But the sparks/tremor
    // must keep showing the dying dealer's low health right up until the beam lands — not blank
    // out at the click. (This regressed once: level snapped at sync-call time.)
    const d = new DealerAnimation()
    d.setLevel((10 / 100) * maxHitsFor(1), 1) // the outgoing dealer is at 10% — sparking + trembling
    // Strike scheduled well after the click (impact = startAfter + STRIKE_TRAVEL_MS), so the
    // pre-strike window comfortably spans several intermittent tremor pulses.
    const startAfter = 5000
    // A kill hands sync() the INCOMING dealer's state: shift 2, full integrity (maxHitsFor(2)) —
    // so the model level jumps to 1.0 at the click.
    d.sync((10 / 100) * maxHitsFor(1), 1, maxHitsFor(2), 2, startAfter)

    // Before the beam strikes: still sparking...
    expect(d.damageBursts(300).length).toBeGreaterThan(0)
    // ...and still trembling.
    let tremoredPreStrike = 0
    for (let t = 0; t < startAfter; t += 5) {
      const { x, y } = d.tremor(t)
      tremoredPreStrike = Math.max(tremoredPreStrike, Math.abs(x), Math.abs(y))
    }
    expect(tremoredPreStrike).toBeGreaterThan(0)

    // Once the beam lands, the level is the incoming dealer's full → the FX are gone (sampled
    // after impact but before the death animation, so this isolates the level hand-off).
    expect(d.damageBursts(startAfter + 150).length).toBe(0)
    expect(d.tremor(startAfter + 150)).toEqual({ x: 0, y: 0 })
  })
})
