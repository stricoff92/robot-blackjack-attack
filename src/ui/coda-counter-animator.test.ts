import { describe, expect, it } from 'vitest'

import { CodaCounterAnimation } from './coda-counter-animator'

// A time comfortably past any single transition (each is well under two seconds).
const SETTLED = 1_000_000

function motions(anim: CodaCounterAnimation, now: number): string[] {
  return anim.frame(now).markers.map((m) => m.motion)
}

describe('CodaCounterAnimation', () => {
  it('starts empty — nothing to draw before the coda entry', () => {
    const anim = new CodaCounterAnimation()
    expect(anim.isAnimating(0)).toBe(false)
    expect(anim.frame(0).markers).toHaveLength(0)
  })

  it('reveals the first marker (tier 0), forming it in place, then rests it', () => {
    const anim = new CodaCounterAnimation()
    const end = anim.reveal(1000)
    expect(end).toBeGreaterThan(1000)

    const mid = anim.frame(1000 + (end - 1000) / 2)
    expect(mid.markers).toHaveLength(1)
    expect(mid.markers[0].motion).toBe('form')
    expect(mid.markers[0].tier).toBe(0)
    expect(mid.markers[0].p).toBeGreaterThan(0)
    expect(mid.markers[0].p).toBeLessThan(1)

    const done = anim.frame(SETTLED)
    expect(anim.isAnimating(SETTLED)).toBe(false)
    expect(done.markers).toEqual([{ motion: 'rest', p: 1, slot: 0, count: 1, tier: 0, fromCount: 1 }])
  })

  it('grow: within a tier, existing markers reflow while the new ones fly in', () => {
    const anim = new CodaCounterAnimation()
    anim.grow(2, 4, 0, 1000)
    const view = anim.frame(1100)
    expect(view.markers).toHaveLength(4)
    expect(view.markers.slice(0, 2).map((m) => m.motion)).toEqual(['reflow', 'reflow'])
    expect(view.markers.slice(2).map((m) => m.motion)).toEqual(['flyIn', 'flyIn'])
    // The reflowing pair slides FROM the 2-grid; all belong to the new 4-grid, same tier.
    expect(view.markers[0].fromCount).toBe(2)
    expect(view.markers.every((m) => m.count === 4 && m.tier === 0)).toBe(true)

    const done = anim.frame(SETTLED)
    expect(done.markers).toHaveLength(4)
    expect(done.markers.every((m) => m.motion === 'rest' && m.tier === 0)).toBe(true)
  })

  it('colourUp: 8 first DOUBLE to a 4×4 of 16, then all 16 fuse into one higher-tier marker', () => {
    const anim = new CodaCounterAnimation()
    const end = anim.colourUp(8, 0, 1, 1000)

    // FILL phase (early): the pile doubles to 16 in a 4×4 — the 8 originals rest in the bottom
    // rows (slots 8..15) while 8 NEW markers of the SAME tier fly in to the top rows (slots 0..7).
    const fill = anim.frame(1200)
    expect(fill.markers).toHaveLength(16)
    expect(fill.markers.every((m) => m.count === 16 && m.tier === 0)).toBe(true)
    const flyIn = fill.markers.filter((m) => m.motion === 'flyIn')
    const resting = fill.markers.filter((m) => m.motion === 'rest')
    expect(flyIn).toHaveLength(8)
    expect(flyIn.every((m) => m.slot < 8)).toBe(true) // new ones fill the TOP two rows
    expect(resting).toHaveLength(8)
    expect(resting.every((m) => m.slot >= 8)).toBe(true) // originals in the BOTTOM two rows
    // Draw order is TOP-to-BOTTOM (ascending slot) so the render paints lower/front rows LAST
    // (over the upper/back rows) — the overlapping rows must not render back-over-front.
    expect(fill.markers.map((m) => m.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])

    // CONDENSE phase (just before the end): all 16 implode + one tier-1 marker blooms.
    const condense = anim.frame(end - 50)
    const fuseOut = condense.markers.filter((m) => m.motion === 'fuseOut')
    const fuseIn = condense.markers.filter((m) => m.motion === 'fuseIn')
    expect(fuseOut).toHaveLength(16)
    expect(fuseOut.every((m) => m.tier === 0)).toBe(true) // the old denomination converging
    expect(fuseIn).toHaveLength(1)
    expect(fuseIn[0].tier).toBe(1) // the new, higher denomination

    // Settles to a single tier-1 marker (the coloured-up pot).
    const done = anim.frame(SETTLED)
    expect(done.markers).toEqual([{ motion: 'rest', p: 1, slot: 0, count: 1, tier: 1, fromCount: 1 }])
  })

  it('collect: every marker flies back to the banker, then nothing remains', () => {
    const anim = new CodaCounterAnimation()
    const end = anim.collect(4, 1, 1000)
    const mid = anim.frame(1000 + (end - 1000) / 2)
    expect(mid.markers).toHaveLength(4)
    expect(mid.markers.every((m) => m.motion === 'flyOut' && m.tier === 1)).toBe(true)

    const done = anim.frame(SETTLED)
    expect(done.markers).toHaveLength(0)
    expect(anim.isAnimating(SETTLED)).toBe(false)
  })

  it('fade: a cash-out dissolves the markers in place, leaving nothing', () => {
    const anim = new CodaCounterAnimation()
    anim.fade(4, 2, 1000)
    expect(motions(anim, 1100)).toEqual(['fade', 'fade', 'fade', 'fade'])
    expect(anim.frame(SETTLED).markers).toHaveLength(0)
  })

  it('the fuse takes longer than a within-tier grow (implode + bloom)', () => {
    const a = new CodaCounterAnimation()
    const grow = a.grow(4, 8, 0, 0)
    const b = new CodaCounterAnimation()
    const fuse = b.colourUp(8, 0, 1, 0)
    expect(fuse).toBeGreaterThan(0)
    expect(grow).toBeGreaterThan(0)
  })
})
