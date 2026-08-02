import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { evaluateHand, isBlackjack, isBust } from './hand'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

describe('evaluateHand', () => {
  it('counts an ace as eleven when it fits', () => {
    expect(evaluateHand([card('A'), card('6')])).toEqual({ total: 17, soft: true })
  })

  it('drops an ace to one to avoid busting', () => {
    expect(evaluateHand([card('A'), card('6'), card('K')])).toEqual({ total: 17, soft: false })
  })

  it('handles two aces as a soft twelve', () => {
    expect(evaluateHand([card('A'), card('A')])).toEqual({ total: 12, soft: true })
  })
})

describe('isBlackjack', () => {
  it('is true for an ace and a ten-value on the first two cards', () => {
    expect(isBlackjack([card('A'), card('K')])).toBe(true)
  })

  it('is false for a three-card twenty-one', () => {
    expect(isBlackjack([card('7'), card('7'), card('7')])).toBe(false)
  })
})

describe('isBust', () => {
  it('is true above twenty-one', () => {
    expect(isBust([card('K'), card('Q'), card('5')])).toBe(true)
  })

  it('is false at twenty-one', () => {
    expect(isBust([card('K'), card('A')])).toBe(false)
  })
})
