import { describe, expect, it } from 'vitest'

import { CountTicker } from './count-ticker'

describe('CountTicker', () => {
  it('shows its initial value and is idle', () => {
    const t = new CountTicker(7)
    expect(t.value(0)).toBe(7)
    expect(t.isAnimating(0)).toBe(false)
    expect(t.scale(0)).toBe(1)
  })

  it('rolls up through the integers to the target', () => {
    const t = new CountTicker(0)
    t.retarget(10, 1000)
    expect(t.isAnimating(1000)).toBe(true)
    expect(t.value(1000)).toBe(0) // start
    const mid = t.value(1180) // halfway through the (10 * 16 + 200 = 360ms) roll
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(10)
    expect(t.value(1360)).toBe(10) // landed
    expect(t.isAnimating(1360)).toBe(false)
  })

  it('swells in scale mid-roll and returns to rest at both ends', () => {
    const t = new CountTicker(0)
    t.retarget(40, 0)
    expect(t.scale(0)).toBe(1)
    const peak = t.scale(260) // mid-roll (40 capped at 520ms)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(1.2 + 1e-9)
    expect(t.scale(520)).toBe(1)
  })

  it('caps a big jump so the roll never drags on', () => {
    const t = new CountTicker(0)
    t.retarget(1000, 0)
    // MIN_MS + jump * MS_PER_UNIT would be huge; it clamps to MAX_MS (520).
    expect(t.isAnimating(519)).toBe(true)
    expect(t.isAnimating(520)).toBe(false)
  })

  it('snaps down instead of rolling — a cost should read instantly', () => {
    const t = new CountTicker(30)
    t.retarget(10, 1000)
    expect(t.value(1000)).toBe(10)
    expect(t.isAnimating(1000)).toBe(false)
    expect(t.scale(1000)).toBe(1)
  })

  it('retargets from the value shown mid-roll, not the old origin', () => {
    const t = new CountTicker(0)
    t.retarget(100, 0)
    const shown = t.value(200)
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(100)
    // A second reward arrives mid-roll: keep climbing from where it is now.
    t.retarget(140, 200)
    expect(t.value(200)).toBe(shown)
    expect(t.value(10_000)).toBe(140)
  })

  it('set() jumps with no animation', () => {
    const t = new CountTicker(5)
    t.retarget(50, 0)
    expect(t.isAnimating(10)).toBe(true)
    t.set(50)
    expect(t.value(10)).toBe(50)
    expect(t.isAnimating(10)).toBe(false)
    expect(t.scale(10)).toBe(1)
  })
})
