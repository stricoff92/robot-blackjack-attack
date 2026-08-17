import { describe, expect, it } from 'vitest'

import { CHARGE_MAX_LIFE_MS } from '../render/nexus'
import { NexusAnimation } from './nexus-animator'

describe('NexusAnimation', () => {
  it('starts dim and idle', () => {
    const nexus = new NexusAnimation()
    expect(nexus.isAnimating(0)).toBe(false)
    expect(nexus.redLight(0)).toBe(0)
    expect(nexus.yellowLight(0)).toBe(0)
    expect(nexus.chargeUp(0)).toBeNull()
  })

  it('holds a RED anticipation glow (only) and keeps the loop alive to power up', () => {
    const nexus = new NexusAnimation()
    nexus.anticipate(1000)

    const early = nexus.redLight(1050)
    const settled = nexus.redLight(1400) // past the ramp-in
    expect(early).toBeGreaterThan(0)
    expect(settled).toBeGreaterThan(early)
    expect(settled).toBeGreaterThan(0.4)
    expect(settled).toBeLessThan(1)
    // The anticipation is RED only now — the yellow channel stays dark (it's just the
    // token pulse), so the one shared lens never mixes red + yellow.
    expect(nexus.yellowLight(1400)).toBe(0)

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
    nexus.fire(3000, 3500, 4000)
    expect(nexus.chargeUp(3100)).toEqual({ start: 1000, cap: 3000 })
    expect(nexus.isAnimating(3000 + CHARGE_MAX_LIFE_MS - 1)).toBe(true)
    expect(nexus.chargeUp(3000 + CHARGE_MAX_LIFE_MS + 1)).toBeNull()
  })

  it('stays dim until the anticipation start, so it can wait out the token flight', () => {
    const nexus = new NexusAnimation()
    // The red charge is scheduled for AFTER the reward tokens land (2000), not the
    // resolve — so the one lens shows yellow tokens first, then red.
    nexus.anticipate(2000)

    // Before the start: fully dim, and the charge-up window spawns nothing (cap < start).
    expect(nexus.redLight(1500)).toBe(0)
    expect(nexus.yellowLight(1500)).toBe(0)
    expect(nexus.chargeUp(1500)).toEqual({ start: 2000, cap: 1500 })

    // From the start on: it lights up red and the energy stream begins.
    expect(nexus.redLight(2200)).toBeGreaterThan(0)
    expect(nexus.chargeUp(2200)).toEqual({ start: 2000, cap: 2200 })
  })

  it('does not power up on a final blow (no prior anticipation)', () => {
    const nexus = new NexusAnimation()
    nexus.fire(2000, 2500, 3000) // 'over' path — fired without anticipate()
    expect(nexus.chargeUp(2100)).toBeNull()
  })

  it('fires the red laser: holds its charge, blasts to full, then winds down', () => {
    const nexus = new NexusAnimation()
    nexus.anticipate(1000)
    // Click at 2000: laser fires 2500..3000.
    nexus.fire(2000, 2500, 3000)

    // Holds the charge glow until the laser fires...
    expect(nexus.redLight(2400)).toBeGreaterThan(0.4)
    expect(nexus.redLight(2400)).toBeLessThan(1)
    // ...then blasts to full while it strikes...
    expect(nexus.redLight(2650)).toBeCloseTo(1)
    expect(nexus.redLight(2999)).toBeCloseTo(1)
    // ...then winds down after the strike, back to dim.
    expect(nexus.redLight(3200)).toBeGreaterThan(0)
    expect(nexus.redLight(3200)).toBeLessThan(1)
    expect(nexus.redLight(4000)).toBe(0)

    // Yellow never lights during the laser — it's the token pulse's channel only.
    expect(nexus.yellowLight(2650)).toBe(0)
    expect(nexus.yellowLight(4000)).toBe(0)
  })

  it('winds down to idle after the laser fades', () => {
    const nexus = new NexusAnimation()
    nexus.fire(2000, 2500, 3000)

    // Still fading just after the strike...
    expect(nexus.isAnimating(3200)).toBe(true)
    // ...then fully idle once the red fade completes.
    expect(nexus.redLight(3500)).toBe(0)
    expect(nexus.isAnimating(3500)).toBe(false)
  })

  it('pulses only the yellow (token) light on a hit token, leaving the red light dim', () => {
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

  it('sequences the shared lens: yellow tokens first, then the red charge — never both', () => {
    const nexus = new NexusAnimation()
    // Tokens shoot on the resolve; the red charge is scheduled for after they land.
    nexus.pulseYellow(1000) // pulse window ~[1000, 1520]
    nexus.anticipate(1600) // red charge begins only once the tokens have flown

    // While the tokens pulse, the lens is YELLOW and the red charge hasn't begun.
    expect(nexus.yellowLight(1200)).toBeGreaterThan(0)
    expect(nexus.redLight(1200)).toBe(0)

    // Once the pulse is done and the charge has begun, the lens is RED and yellow is dark.
    expect(nexus.redLight(1900)).toBeGreaterThan(0)
    expect(nexus.yellowLight(1900)).toBe(0)
  })
})
