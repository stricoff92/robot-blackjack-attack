import { describe, expect, it } from 'vitest'

import { TokenAnimation } from './token-animator'

const FROM = { x: 100, y: 100 }
// Any time comfortably past a flight's landing (flights are well under a second).
const LANDED = 1_000_000

describe('TokenAnimation', () => {
  it('starts idle with nothing pending', () => {
    const anim = new TokenAnimation()
    expect(anim.isAnimating(0)).toBe(false)
    expect(anim.pending(0)).toBe(0)
    expect(anim.bursts(0)).toHaveLength(0)
  })

  it('ignores non-positive amounts', () => {
    const anim = new TokenAnimation()
    anim.emit(FROM, 0, 0)
    anim.emit(FROM, -5, 0)
    expect(anim.isAnimating(0)).toBe(false)
    expect(anim.pending(0)).toBe(0)
  })

  it('withholds the amount from before liftoff until the burst lands', () => {
    const anim = new TokenAnimation()
    anim.emit(FROM, 10, 1000)

    // Owed and animating before it has even lifted off, but not yet drawable.
    expect(anim.pending(999)).toBe(10)
    expect(anim.isAnimating(999)).toBe(true)
    expect(anim.bursts(999)).toHaveLength(0)

    // In flight at liftoff: drawable, still owed, progress at the start.
    expect(anim.pending(1000)).toBe(10)
    const inFlight = anim.bursts(1000)
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0].progress).toBe(0)

    // Landed: no longer owed, no longer drawn, animation parked.
    expect(anim.pending(LANDED)).toBe(0)
    expect(anim.bursts(LANDED)).toHaveLength(0)
    expect(anim.isAnimating(LANDED)).toBe(false)
  })

  it('sums overlapping bursts (rapid hits) so the counter holds the full amount', () => {
    const anim = new TokenAnimation()
    anim.emit(FROM, 1, 1000)
    anim.emit(FROM, 1, 1050)
    anim.emit(FROM, 1, 1100)
    expect(anim.pending(1100)).toBe(3)
    expect(anim.bursts(1100).length).toBeGreaterThan(0)
  })

  it('scales the sprite count with the amount without exploding', () => {
    const anim = new TokenAnimation()
    anim.emit(FROM, 1, 0) // hit
    anim.emit(FROM, 10, 0) // win
    anim.emit(FROM, 21, 0) // blackjack
    const [hit, win, blackjack] = anim.bursts(0)
    expect(hit.icons).toBe(1)
    expect(win.icons).toBeGreaterThan(hit.icons)
    expect(blackjack.icons).toBeGreaterThanOrEqual(win.icons)
    expect(blackjack.icons).toBeLessThanOrEqual(5)
  })
})
