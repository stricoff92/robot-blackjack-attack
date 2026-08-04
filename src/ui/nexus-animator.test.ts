import { describe, expect, it } from 'vitest'

import { CHARGE_MAX_LIFE_MS } from '../render/nexus'
import { NexusAnimation } from './nexus-animator'

describe('NexusAnimation', () => {
  it('starts dim and idle', () => {
    const nexus = new NexusAnimation()
    expect(nexus.isAnimating(0)).toBe(false)
    expect(nexus.redLight(0)).toBe(0)
    expect(nexus.yellowLight(0)).toBe(0)
    expect(nexus.ventAge(0)).toBeNull()
    expect(nexus.chargeUp(0)).toBeNull()
  })

  it('holds an anticipation glow on both lights and keeps the loop alive to power up', () => {
    const nexus = new NexusAnimation()
    nexus.anticipate(1000)

    const early = nexus.redLight(1050)
    const settled = nexus.redLight(1400) // past the ramp-in
    expect(early).toBeGreaterThan(0)
    expect(settled).toBeGreaterThan(early)
    expect(settled).toBeGreaterThan(0.4)
    expect(settled).toBeLessThan(1)
    expect(nexus.yellowLight(1400)).toBeCloseTo(settled) // both glow equally

    // The powering-up VFX runs continuously, so the loop stays alive through the
    // whole wait (it does not park), and keeps holding until fired.
    expect(nexus.isAnimating(1400)).toBe(true)
    expect(nexus.isAnimating(50_000)).toBe(true)
    expect(nexus.redLight(50_000)).toBeCloseTo(settled)
  })

  it('spawns the charge-up stream while waiting, then caps it at the click', () => {
    const nexus = new NexusAnimation()
    nexus.anticipate(1000)

    // Spawning continuously — the cap advances with `now`.
    expect(nexus.chargeUp(1400)).toEqual({ start: 1000, cap: 1400 })
    expect(nexus.chargeUp(3000)).toEqual({ start: 1000, cap: 3000 })

    // Next hand: stop spawning (cap freezes at the click), but keep animating the
    // in-flight balls for one more ball-lifetime.
    nexus.fire(3000, 3500, 4000, 3300)
    expect(nexus.chargeUp(3100)).toEqual({ start: 1000, cap: 3000 })
    expect(nexus.isAnimating(3000 + CHARGE_MAX_LIFE_MS - 1)).toBe(true)
    expect(nexus.chargeUp(3000 + CHARGE_MAX_LIFE_MS + 1)).toBeNull()
  })

  it('stays dim until the anticipation start, so it can wait for the cards to land', () => {
    const nexus = new NexusAnimation()
    // Charging is scheduled for when the cards settle (2000), not the action time.
    // A natural blackjack resolves right off the deal, so that moment is still ahead.
    nexus.anticipate(2000)

    // Before the start: fully dim, and the charge-up window spawns nothing (cap < start).
    expect(nexus.redLight(1500)).toBe(0)
    expect(nexus.yellowLight(1500)).toBe(0)
    expect(nexus.chargeUp(1500)).toEqual({ start: 2000, cap: 1500 })

    // From the start on: it lights up and the energy stream begins.
    expect(nexus.redLight(2200)).toBeGreaterThan(0)
    expect(nexus.chargeUp(2200)).toEqual({ start: 2000, cap: 2200 })
  })

  it('does not power up on a final blow (no prior anticipation)', () => {
    const nexus = new NexusAnimation()
    nexus.fire(2000, 2500, 3000, null) // 'over' path — fired without anticipate()
    expect(nexus.chargeUp(2100)).toBeNull()
  })

  it('fades the two lights independently — yellow with the tokens, red with the laser', () => {
    const nexus = new NexusAnimation()
    nexus.anticipate(1000)
    // Click at 2000: tokens land 2300, laser 2500..3000.
    nexus.fire(2000, 2500, 3000, 2300)

    // While tokens distribute, yellow is FULL but red is still only its charge glow.
    expect(nexus.yellowLight(2299)).toBeCloseTo(1)
    expect(nexus.redLight(2299)).toBeLessThan(0.75)

    // Once tokens land, yellow drops out — while the red muzzle blasts to full.
    expect(nexus.yellowLight(2550)).toBeLessThan(0.2)
    expect(nexus.redLight(2650)).toBeCloseTo(1)
    expect(nexus.redLight(2999)).toBeCloseTo(1)

    // The red then winds down after the strike, back to dim.
    expect(nexus.redLight(3200)).toBeGreaterThan(0)
    expect(nexus.redLight(3200)).toBeLessThan(1)
    expect(nexus.redLight(4000)).toBe(0)
    expect(nexus.yellowLight(4000)).toBe(0)
  })

  it('eases the yellow glow out when fired with no token flare (reward already flew)', () => {
    const nexus = new NexusAnimation()
    nexus.anticipate(1000)
    const held = nexus.yellowLight(1400) // steady anticipation glow
    expect(held).toBeGreaterThan(0.4)

    // Next hand with tokensEnd = null: the reward already flew on the resolve, so
    // the yellow just eases down from the glow — no flare-to-full, no snap-off.
    nexus.fire(2000, 2200, 2700, null)
    expect(nexus.yellowLight(2000)).toBeCloseTo(held)
    expect(nexus.yellowLight(2100)).toBeLessThan(held)
    expect(nexus.yellowLight(2100)).toBeGreaterThan(0)
    expect(nexus.yellowLight(2600)).toBe(0)

    // ...while the red still blasts for the laser.
    expect(nexus.redLight(2400)).toBeGreaterThan(0.9)
  })

  it('vents cooling steam for ~1s after the laser, then goes idle', () => {
    const nexus = new NexusAnimation()
    nexus.fire(2000, 2500, 3000, 2300)

    expect(nexus.ventAge(2900)).toBeNull()
    expect(nexus.ventAge(3000)).toBe(0)
    expect(nexus.ventAge(3500)).toBeCloseTo(500)

    expect(nexus.ventAge(4000)).toBeGreaterThan(0)
    expect(nexus.isAnimating(4000)).toBe(true)
    expect(nexus.ventAge(4300)).toBeNull()
    expect(nexus.isAnimating(4300)).toBe(false)
  })

  it('pulses only the yellow light on a hit token, leaving the red light dim', () => {
    const nexus = new NexusAnimation()
    nexus.pulseYellow(1000)

    const y = nexus.yellowLight(1260)
    expect(y).toBeGreaterThan(0.5)
    expect(nexus.redLight(1260)).toBe(0)
    expect(nexus.isAnimating(1260)).toBe(true)

    expect(nexus.yellowLight(1000)).toBeCloseTo(0)
    expect(nexus.yellowLight(20_000)).toBe(0)
    expect(nexus.isAnimating(20_000)).toBe(false)
  })
})
