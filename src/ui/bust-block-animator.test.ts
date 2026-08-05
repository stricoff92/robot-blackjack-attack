import { describe, expect, it } from 'vitest'

import { BustBlockAnimation } from './bust-block-animator'

// Phase durations mirror the animator's private constants, so the timeline below
// reads against real boundaries: fly 200, flip 170, hold 620, eject-flip 150,
// eject-fly 360 → 1500ms total.
const START = 1000
const FLY_END = START + 200
const FLIP_END = FLY_END + 170
const HOLD_END = FLIP_END + 620
const EJECT_FLIP_END = HOLD_END + 150
const END = EJECT_FLIP_END + 360

describe('BustBlockAnimation', () => {
  it('is idle until begun, then animates across the whole reveal window', () => {
    const anim = new BustBlockAnimation()
    expect(anim.isAnimating(START)).toBe(false)

    expect(anim.begin(START)).toBe(END)
    expect(anim.isAnimating(START - 1)).toBe(false) // not before its start
    expect(anim.isAnimating(START)).toBe(true)
    expect(anim.isAnimating(END - 1)).toBe(true)
    expect(anim.isAnimating(END)).toBe(false) // ends the instant the card is mucked
  })

  it('flies in face-down from the shoe, then reveals face-up', () => {
    const anim = new BustBlockAnimation()
    anim.begin(START)

    // Mid-flight: partway from the shoe, still a back, no shield yet.
    const flying = anim.frame(START + 100)
    expect(flying.flight).toBeCloseTo(0.5)
    expect(flying.flip).toBe(0)
    expect(flying.fly).toBe(0)
    expect(flying.shield).toBe(0)

    // Landed and mid-reveal: the shield ramps in with the flip.
    const revealing = anim.frame(FLY_END + 85)
    expect(revealing.flight).toBe(1)
    expect(revealing.flip).toBeCloseTo(0.5)
    expect(revealing.shield).toBeCloseTo(0.5)
    expect(revealing.fly).toBe(0)
  })

  it('holds the busting card face-up with the shield fully caught', () => {
    const anim = new BustBlockAnimation()
    anim.begin(START)

    const held = anim.frame(FLIP_END + 300)
    expect(held.flight).toBe(1)
    expect(held.flip).toBe(1)
    expect(held.fly).toBe(0)
    expect(held.shield).toBe(1)
  })

  it('flips face-down releasing the shield, then sweeps off to the muck', () => {
    const anim = new BustBlockAnimation()
    anim.begin(START)

    // Eject flip: turning face-down as the shield fades, still on its slot.
    const ejectFlip = anim.frame(HOLD_END + 60)
    expect(ejectFlip.flip).toBeCloseTo(0.6)
    expect(ejectFlip.shield).toBeCloseTo(0.6)
    expect(ejectFlip.fly).toBe(0)

    // Sweeping away: face-down, no shield, flying toward the muck.
    const sweeping = anim.frame(EJECT_FLIP_END + 180)
    expect(sweeping.flip).toBe(0)
    expect(sweeping.shield).toBe(0)
    expect(sweeping.fly).toBeCloseTo(0.5)
  })
})
