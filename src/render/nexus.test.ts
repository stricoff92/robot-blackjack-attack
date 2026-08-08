import { describe, expect, it } from 'vitest'

import { nexusHoloLight, nexusUtilityLight } from './nexus'
import { computeLayout } from './scene'

describe('nexus hover geometry', () => {
  const l = computeLayout(1200, 800)

  it('bobs the utility muzzle up and down over time', () => {
    const ys = [0, 400, 800, 1200, 1600, 2000, 2400].map((t) => nexusUtilityLight(l, t).y)
    const range = Math.max(...ys) - Math.min(...ys)
    expect(range).toBeGreaterThan(1) // the muzzle visibly floats, not pinned
  })

  it('holds the muzzle at a fixed x — only its height bobs', () => {
    expect(nexusUtilityLight(l, 0).x).toBeCloseTo(nexusUtilityLight(l, 900).x)
  })

  it('lifts the utility light and holo projector together (one shared bob)', () => {
    // The two lenses sit on different rows — utility on top, holo below — but the hover
    // lifts them by the same amount, so the vertical gap between them stays fixed.
    const gaps = [0, 500, 1234, 2600].map((t) => nexusHoloLight(l, t).y - nexusUtilityLight(l, t).y)
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(gaps[0])
    }
    expect(gaps[0]).toBeGreaterThan(1) // the holo lens sits below the utility lens
  })

  it('shares one x column for both lenses', () => {
    expect(nexusHoloLight(l, 300).x).toBeCloseTo(nexusUtilityLight(l, 300).x)
  })
})
