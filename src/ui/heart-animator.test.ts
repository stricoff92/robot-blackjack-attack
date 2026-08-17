import { describe, expect, it } from 'vitest'

import { MAX_HEARTS } from '../game/run'
import { HeartAnimation } from './heart-animator'

describe('HeartAnimation', () => {
  it('starts full with nothing animating', () => {
    const h = new HeartAnimation()
    expect(h.isAnimating(0)).toBe(false)
    expect(h.view(0)).toEqual({ filled: MAX_HEARTS, max: MAX_HEARTS, transients: [], beam: null, spark: null })
  })

  it('sync adopts a count with no animation', () => {
    const h = new HeartAnimation()
    h.sync(3)
    expect(h.view(0).filled).toBe(3)
    expect(h.isAnimating(100)).toBe(false)
  })

  it('a pop keeps the doomed chip until the beam lands, then empties it with a departing glyph', () => {
    const h = new HeartAnimation()
    h.sync(3)
    const start = 1000
    h.pop(start)

    // Beam in flight, chip still intact (3 filled) so the player sees what's about to be lost.
    const pre = h.view(start + 10)
    expect(pre.filled).toBe(3)
    expect(pre.beam?.kind).toBe('pop')
    expect(pre.transients).toEqual([])

    // Beam landed (past the ~120ms travel): the chip is now empty (2 filled) with a popping glyph.
    const mid = h.view(start + 140)
    expect(mid.filled).toBe(2)
    expect(mid.transients).toHaveLength(1)
    expect(mid.transients[0]).toMatchObject({ kind: 'pop', slot: 2 }) // the emptied slot (= new count)

    // Settled.
    const done = h.view(start + 5000)
    expect(done.filled).toBe(2)
    expect(done.transients).toEqual([])
    expect(done.beam).toBeNull()
    expect(h.isAnimating(start + 5000)).toBe(false)
  })

  it('a pop throws a spark shower off the struck chip from the moment the laser lands', () => {
    const h = new HeartAnimation()
    h.sync(3)
    const start = 1000
    h.pop(start)

    // No sparks while the beam is still travelling to the chip.
    expect(h.view(start + 10).spark).toBeNull()

    // Once it lands (past the ~120ms travel) the struck slot sparks, progress climbing from 0.
    const mid = h.view(start + 140)
    expect(mid.spark).toMatchObject({ slot: 2 })
    expect(mid.spark!.progress).toBeGreaterThan(0)
    expect(mid.spark!.progress).toBeLessThan(1)

    // Sparks are spent by the time everything settles.
    expect(h.view(start + 5000).spark).toBeNull()
  })

  it('a heal never sparks (only a loss strikes a chip)', () => {
    const h = new HeartAnimation()
    h.sync(3)
    h.heal(1, 1000)
    for (const now of [1010, 1340, 1600, 6000]) {
      expect(h.view(now).spark).toBeNull()
    }
  })

  it('a single heal keeps the socket empty until the incoming heart has fully faded in', () => {
    const h = new HeartAnimation()
    h.sync(3)
    const start = 1000
    h.heal(1, start)

    // The new heart rides as a fading-in glyph on the first empty slot; the solid count still reads 3.
    const mid = h.view(start + 340) // past the ~300ms heal travel, into the fade-in glyph
    expect(mid.filled).toBe(3)
    expect(mid.transients).toHaveLength(1)
    expect(mid.transients[0]).toMatchObject({ kind: 'heal', slot: 3 }) // the filling slot (= old count)

    // Only once it settles does the solid count commit to 4.
    expect(h.view(start + 5000).filled).toBe(4)
  })

  it('a kill heals two hearts one after another — the first socket fills before the second starts', () => {
    const h = new HeartAnimation()
    h.sync(3)
    const start = 1000
    h.heal(2, start) // beating a dealer restores up to two

    // Early: only the first socket (index 3) is filling; the second (index 4) hasn't started.
    const first = h.view(start + 450) // partway into the first heart's fade-in
    expect(first.filled).toBe(3)
    expect(first.transients.map((t) => t.slot)).toEqual([3])

    // The first socket commits (count → 4) while the beam glides to the second — no heart filling yet.
    const between = h.view(start + 800)
    expect(between.filled).toBe(4)
    expect(between.transients).toHaveLength(0)

    // Later the second socket is the one filling, and the count is still 4 until it commits.
    const second = h.view(start + 1100)
    expect(second.filled).toBe(4)
    expect(second.transients.map((t) => t.slot)).toEqual([4])

    // Settles to 5.
    expect(h.view(start + 5000).filled).toBe(5)
  })

  it('the heal beam revives the first socket, then glides to and revives the second', () => {
    const h = new HeartAnimation()
    h.sync(3)
    const start = 0
    h.heal(2, start)

    // While the first chip fills, the beam head sits on socket 3.
    expect(h.view(start + 500).beam?.slot).toBe(3)

    // Between the two fills the head is gliding — a fractional position between the sockets.
    const gliding = h.view(start + 800).beam
    expect(gliding?.slot).toBeGreaterThan(3)
    expect(gliding?.slot).toBeLessThan(4)

    // While the second chip fills, the head has arrived on socket 4.
    expect(h.view(start + 1100).beam?.slot).toBe(4)
  })

  it('pop is a no-op at zero hearts and heal a no-op at full', () => {
    const h = new HeartAnimation()
    h.sync(0)
    h.pop(0)
    expect(h.view(5000).filled).toBe(0)

    h.sync(MAX_HEARTS)
    h.heal(1, 0)
    expect(h.view(5000).filled).toBe(MAX_HEARTS)
  })

  it('a heal is clamped to MAX_HEARTS even when asked for more', () => {
    const h = new HeartAnimation()
    h.sync(MAX_HEARTS - 1)
    h.heal(3, 0)
    expect(h.view(5000).filled).toBe(MAX_HEARTS)
  })

  it('a new effect settles the previous one before building off the right count', () => {
    const h = new HeartAnimation()
    h.sync(3)
    h.pop(1000) // 3 → 2
    h.pop(1000) // settle to 2, then 2 → 1 (not off the stale 3)
    expect(h.view(5000).filled).toBe(1)
  })

  it('animEndAfter reports the running effect end, else the passed-in now', () => {
    const h = new HeartAnimation()
    expect(h.animEndAfter(500)).toBe(500) // idle → now
    h.sync(3)
    h.pop(1000)
    expect(h.animEndAfter(0)).toBeGreaterThan(1000)
  })
})
