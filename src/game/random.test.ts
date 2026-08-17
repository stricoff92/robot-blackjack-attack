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

  it('exposes a 32-bit-uint state that advances as the stream is drawn', () => {
    const rng = createRng(1)
    const before = rng.state
    rng()
    expect(rng.state).not.toBe(before) // a draw moved the state on
    expect(Number.isInteger(rng.state)).toBe(true)
    expect(rng.state).toBeGreaterThanOrEqual(0)
    expect(rng.state).toBeLessThanOrEqual(0xffffffff)
  })

  it('reconstructs the exact continuation from a snapshotted state (persist/resume)', () => {
    const rng = createRng(42)
    rng()
    rng()
    rng() // advance a few draws
    const saved = rng.state
    const continuation = [rng(), rng(), rng(), rng()]

    // A fresh RNG built from the snapshot resumes the identical sequence — the property the save
    // relies on to make a resumed deal deterministic (see game/session adoptSession).
    const restored = createRng(saved)
    expect([restored(), restored(), restored(), restored()]).toEqual(continuation)
  })
})
