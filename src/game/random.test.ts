import { describe, expect, it } from 'vitest'

import { createRng } from './random'

describe('createRng', () => {
  it('reproduces the same sequence for the same seed', () => {
    const first = createRng(123)
    const second = createRng(123)

    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })

  it('produces different sequences for different seeds', () => {
    expect(createRng(1)()).not.toBe(createRng(2)())
  })

  it('stays within the unit interval', () => {
    const nextRandom = createRng(999)

    for (let draw = 0; draw < 1000; draw += 1) {
      const value = nextRandom()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
