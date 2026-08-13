import { describe, expect, it } from 'vitest'
import { DELTA_FADE_MS, DELTA_FLY_MS } from '../render/score-deltas'
import { ScoreDeltaFly } from './score-delta-animator'

const FROM = { x: 0, y: 0 }

// isMoving (battery saver's "is anything actually moving") must distinguish a delta that's arcing in
// or fading out from one that has LANDED and is merely HELD on screen — a held "+N" list is static
// and must NOT keep the render loop awake (that was the "dealer damage plays continuously" bug).
describe('ScoreDeltaFly.isMoving vs isAnimating', () => {
  it('is moving while a "+N" is still arcing in, then NOT once it lands and holds', () => {
    const d = new ScoreDeltaFly()
    d.emit(100, FROM, 0, 1000) // lands at 1000 + DELTA_FLY_MS
    expect(d.isMoving(1000)).toBe(true) // just launched — arcing
    expect(d.isMoving(1000 + DELTA_FLY_MS - 1)).toBe(true) // still in the air
    // Landed and holding (waiting for the next hand): drawn but static → not moving.
    expect(d.isMoving(1000 + DELTA_FLY_MS + 5000)).toBe(false)
    // isAnimating still reports true while held (it means "something to draw"), which is why busy_
    // must use isMoving instead.
    expect(d.isAnimating(1000 + DELTA_FLY_MS + 5000)).toBe(true)
  })

  it('is moving again while fading out after the next hand clears it', () => {
    const d = new ScoreDeltaFly()
    d.emit(100, FROM, 0, 1000)
    const held = 1000 + DELTA_FLY_MS + 5000
    expect(d.isMoving(held)).toBe(false) // held, static
    d.clear(held) // next hand → begin fade-out
    expect(d.isMoving(held + DELTA_FADE_MS - 1)).toBe(true) // fading = moving
    expect(d.isMoving(held + DELTA_FADE_MS + 1)).toBe(false) // fade done
  })

  it('is not moving with no flights', () => {
    expect(new ScoreDeltaFly().isMoving(5000)).toBe(false)
  })
})
