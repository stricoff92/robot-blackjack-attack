import { describe, expect, it } from 'vitest'

import { nexusRedLight, nexusYellowLight } from './nexus'
import { computeLayout } from './scene'

describe('nexus hover geometry', () => {
  const l = computeLayout(1200, 800)

  it('bobs the laser muzzle up and down over time', () => {
    const ys = [0, 400, 800, 1200, 1600, 2000, 2400].map((t) => nexusRedLight(l, t).y)
    const range = Math.max(...ys) - Math.min(...ys)
    expect(range).toBeGreaterThan(1) // the muzzle visibly floats, not pinned
  })

  it('holds the muzzle at a fixed x — only its height bobs', () => {
    expect(nexusRedLight(l, 0).x).toBeCloseTo(nexusRedLight(l, 900).x)
  })

  it('lifts the red muzzle and yellow vent together (one shared bob)', () => {
    for (const t of [0, 500, 1234, 2600]) {
      expect(nexusRedLight(l, t).y).toBeCloseTo(nexusYellowLight(l, t).y)
    }
  })
})
