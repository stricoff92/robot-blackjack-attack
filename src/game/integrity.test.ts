import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { damageForRound } from './integrity'
import { hit, stand, startRound } from './round'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

describe('damageForRound', () => {
  it('deals eight for a plain win', () => {
    const win = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')], 10))

    expect(damageForRound(win)).toBe(8)
  })

  it('adds the dealer-bust bonus on top of the win', () => {
    const shoe = [card('K'), card('Q'), card('K', 'hearts'), card('6'), card('10', 'hearts')]
    const bust = stand(startRound(shoe, 10))

    expect(damageForRound(bust)).toBe(8 + 25)
  })

  it('stacks the natural bonus onto the win', () => {
    const natural = startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], 10)

    expect(damageForRound(natural)).toBe(8 + 12)
  })

  it('lands nothing when the player busts, since the dealer never draws', () => {
    const playerBust = hit(startRound([card('K'), card('6'), card('9'), card('7'), card('Q')], 10))

    expect(damageForRound(playerBust)).toBe(0)
  })
})
