import { describe, expect, it } from 'vitest'

import { SpawnAnimation } from './spawn-animator'

// Any time comfortably past the whole ceremony (well under a few seconds).
const DONE = 1_000_000

describe('SpawnAnimation', () => {
  it('starts idle before it has begun', () => {
    const anim = new SpawnAnimation()
    expect(anim.isAnimating(0)).toBe(false)
    expect(anim.cardSuck(0, 0)).toBeNull()
    expect(anim.deckCardSuck(0, 0)).toBeNull()
    expect(anim.deckCardChunk(0, 0)).toBeNull()
    expect(anim.deckState(0)).toBeNull()
  })

  it('animates from begin() until the returned end and no later', () => {
    const anim = new SpawnAnimation()
    const end = anim.begin(0, 5)
    expect(end).toBeGreaterThan(0)
    expect(anim.isAnimating(0)).toBe(true)
    expect(anim.isAnimating(end - 1)).toBe(true)
    expect(anim.isAnimating(end)).toBe(false)
  })

  it('sucks each card in on its own staggered schedule', () => {
    const anim = new SpawnAnimation()
    anim.begin(0, 3)

    // Card 0 starts immediately; a later card is still resting (null) at t=0.
    expect(anim.cardSuck(0, 0)).toBe(0)
    expect(anim.cardSuck(2, 0)).toBeNull()

    // Each card's suck runs 0 → 1 and clamps.
    expect(anim.cardSuck(0, DONE)).toBe(1)
  })

  it('holds the deck back until the cards are drawn in, then flies + unwraps it', () => {
    const anim = new SpawnAnimation()
    anim.begin(0, 6)

    // While the shred is still going, the fresh deck hasn't emerged yet.
    expect(anim.deckState(0)).toBeNull()

    // By the end it has landed and fully unwrapped.
    const st = anim.deckState(DONE)
    expect(st).not.toBeNull()
    expect(st?.fly).toBe(1)
    expect(st?.unwrap).toBe(1)
  })

  it('with no cards to shred (page load) the deck flies in right away', () => {
    const anim = new SpawnAnimation()
    anim.begin(0, 0)

    // No cards means the deck emerges at t0 rather than waiting on a shred. (The
    // renderer iterates only the real cards, so per-card queries go unused here.)
    const st = anim.deckState(0)
    expect(st).not.toBeNull()
    expect(st?.fly).toBe(0)
  })

  it('leaves the old deck out of the shred unless asked (intro)', () => {
    const anim = new SpawnAnimation()
    anim.begin(0, 3) // no shredOldDeck flag
    expect(anim.deckCardSuck(0, 0)).toBeNull()
    expect(anim.deckCardSuck(0, DONE)).toBeNull()
    expect(anim.deckCardChunk(0, DONE)).toBeNull()
    expect(anim.deckRemaining(DONE)).toBe(1) // no old deck: nothing depletes
  })

  it('shreds the old deck card-by-card after the cards, then flies the fresh deck in', () => {
    const anim = new SpawnAnimation()
    anim.begin(0, 3, true)

    // The deck rests full on the shoe until the table cards are drawn in, then sheds its
    // cards off the top: each back sucks 0 → 1 into the mouth on its own staggered
    // schedule, throwing paper chunks, and the resting stack depletes to empty.
    expect(anim.deckCardSuck(0, 0)).toBeNull()
    expect(anim.deckRemaining(0)).toBe(1)
    expect(anim.deckCardSuck(0, DONE)).toBe(1)
    expect(anim.deckCardSuck(anim.deckCardCount() - 1, DONE)).toBe(1)
    expect(anim.deckRemaining(DONE)).toBe(0)
    // A chunk sprays partway through a card's suck (chunks lead in behind it), gone by end.
    expect(anim.deckCardChunk(0, 450)).not.toBeNull()
    expect(anim.deckCardChunk(0, DONE)).toBeNull()

    // The fresh deck hasn't emerged while the old one is still being drawn in.
    expect(anim.deckState(0)).toBeNull()
    // …but it has landed + fully unwrapped by the end.
    const st = anim.deckState(DONE)
    expect(st?.fly).toBe(1)
    expect(st?.unwrap).toBe(1)
  })

  it('delays the fresh deck (and the finish) when it also shreds the old deck', () => {
    const withDeck = new SpawnAnimation().begin(0, 3, true)
    const withoutDeck = new SpawnAnimation().begin(0, 3, false)
    // Sucking the old deck in first pushes the fresh-deck fly — and the whole
    // ceremony's end — later than shredding the cards alone.
    expect(withDeck).toBeGreaterThan(withoutDeck)
  })

  it('exposes the shred end (cards chewed) at or before the full ceremony end', () => {
    // shredEnd is the moment the shredding finishes (last card chewed + sfx tail); the Banker's
    // laugh is timed off it. It lands at or before endAt, which also waits on the lingering chunks.
    const anim = new SpawnAnimation()
    const end = anim.begin(0, 3, true, true) // shredOnly: cards + old deck, no fresh deck (Banker entry)
    expect(anim.shredEnd).toBeGreaterThan(0)
    expect(anim.shredEnd).toBeLessThanOrEqual(end)
  })
})

// Mirrors render/spawn.ts SHEET_SLIDE_START — the unwrap fraction the rustling sfx fires
// at. The exact value doesn't matter to these tests (any threshold in (0, 1) exercises the
// same single-fire property), but keep it in step with the renderer.
const SHEET_SLIDE_START = 0.54

// Walk `now` across the whole ceremony (a bit past `end`) in small steps, calling `fn`.
function sweep(t0: number, end: number, fn: (now: number) => void): void {
  for (let t = t0; t <= end + 2000; t += 5) {
    fn(t)
  }
}

describe('SpawnAnimation.unwrap (packaging sfx timing)', () => {
  it('is monotonic and holds at 1 through the riffle — no false edge to re-fire the tear sfx', () => {
    // Regression: deckState() returns null during the riffle (the shuffle renderer owns the
    // draw then), so its .unwrap dipped 1 → 0 → 1 and re-fired the packaging sfx late. unwrap()
    // is the monotonic value the sfx must read instead — it must never dip back down.
    const anim = new SpawnAnimation()
    const end = anim.begin(1000, 4, true) // a kill ceremony: shred cards + old deck, fly a fresh deck
    let prev = -1
    let reachedOne = false
    sweep(1000, end, (now) => {
      const u = anim.unwrap(now)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      expect(u).toBeGreaterThanOrEqual(prev - 1e-9) // never decreases
      if (u >= 1) {
        reachedOne = true
      }
      if (reachedOne) {
        expect(u).toBe(1) // once bare it stays bare — including all through the riffle
      }
      prev = u
    })
    expect(reachedOne).toBe(true)
  })

  it('fires the tear-open and rustling sfx exactly once each across the whole ceremony', () => {
    const anim = new SpawnAnimation()
    const end = anim.begin(1000, 4, true)
    let prev = 0
    let opening = 0
    let rustling = 0
    sweep(1000, end, (now) => {
      const u = anim.unwrap(now)
      if (u > 0 && prev <= 0) {
        opening += 1
      }
      if (u >= SHEET_SLIDE_START && prev < SHEET_SLIDE_START) {
        rustling += 1
      }
      prev = u
    })
    expect(opening).toBe(1)
    expect(rustling).toBe(1)
  })

  it('fires no packaging sfx on a game-over shred (no fresh deck unwraps)', () => {
    const anim = new SpawnAnimation()
    const end = anim.begin(1000, 4, true, true) // shredOnly: chew the table cards, fly NO deck
    let prev = 0
    let opening = 0
    sweep(1000, end, (now) => {
      const u = anim.unwrap(now)
      if (u > 0 && prev <= 0) {
        opening += 1
      }
      prev = u
    })
    expect(opening).toBe(0)
  })
})
