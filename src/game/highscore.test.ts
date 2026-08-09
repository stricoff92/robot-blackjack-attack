import { describe, expect, it } from 'vitest'

import { nextBest } from './highscore'

describe('nextBest', () => {
  it('sets a new best when the score is strictly higher', () => {
    expect(nextBest(1000, 1500)).toEqual({ best: 1500, isNewBest: true })
  })

  it('sets the first best from zero', () => {
    expect(nextBest(0, 420)).toEqual({ best: 420, isNewBest: true })
  })

  it('holds the existing best when the score is lower', () => {
    expect(nextBest(1500, 900)).toEqual({ best: 1500, isNewBest: false })
  })

  it('holds on a tie (only strictly higher counts)', () => {
    expect(nextBest(1500, 1500)).toEqual({ best: 1500, isNewBest: false })
  })

  it('a coda bust (score 0) never becomes a best', () => {
    expect(nextBest(1500, 0)).toEqual({ best: 1500, isNewBest: false })
    expect(nextBest(0, 0)).toEqual({ best: 0, isNewBest: false })
  })

  it('floors fractional scores and stored bests', () => {
    expect(nextBest(0, 12.9)).toEqual({ best: 12, isNewBest: true })
    expect(nextBest(12.9, 12.1)).toEqual({ best: 12, isNewBest: false })
  })

  it('treats non-finite or negative inputs as zero', () => {
    expect(nextBest(Number.NaN, 500)).toEqual({ best: 500, isNewBest: true })
    expect(nextBest(500, Number.POSITIVE_INFINITY)).toEqual({ best: 500, isNewBest: false })
    expect(nextBest(-5, -10)).toEqual({ best: 0, isNewBest: false })
  })
})
