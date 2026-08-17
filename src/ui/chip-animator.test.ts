import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from '../game/deck'
import { stand, startRound } from '../game/round'
import { ChipAnimation } from './chip-animator'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

// A resolved single-hand round the player won (20 over a standing 17).
function wonRound() {
  return stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')]))
}

// The ChipAnimation is now a pure SETTLE-TIMING clock — the chip visuals were removed with the
// bankroll economy, but the laser / token / coda choreography still paces off its `animEnd`.
describe('ChipAnimation — settle timing clock', () => {
  it('placeBets ends a short beat after now, and isAnimating tracks the window', () => {
    const clock = new ChipAnimation()
    clock.placeBets(wonRound(), 1000)
    expect(clock.animEnd).toBeGreaterThan(1000)
    expect(clock.isAnimating(1000)).toBe(true)
    expect(clock.isAnimating(clock.animEnd + 1)).toBe(false)
  })

  it('resolve extends the clock to settle a winning hand after the given start', () => {
    const clock = new ChipAnimation()
    clock.placeBets(wonRound(), 0)
    clock.resolve(wonRound(), 500)
    expect(clock.animEnd).toBeGreaterThan(500)
  })

  it('clear settles the table after the given start', () => {
    const clock = new ChipAnimation()
    clock.clear(wonRound(), 800)
    expect(clock.animEnd).toBeGreaterThan(800)
  })
})
