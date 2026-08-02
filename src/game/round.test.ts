import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import {
  armSecondChance,
  canSplit,
  doubleDown,
  hit,
  lateDouble,
  payout,
  split,
  stand,
  startRound,
  type Round,
} from './round'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

function outcomeOf(round: Round, index = 0) {
  return round.hands[index].outcome
}

describe('startRound', () => {
  it('pays three-to-two on a natural blackjack', () => {
    const round = startRound([card('A'), card('K'), card('9'), card('7')], 100)

    expect(outcomeOf(round)).toBe('blackjack')
    expect(payout(round)).toBe(150)
  })

  it('pushes when both sides hold a natural', () => {
    const round = startRound([card('A'), card('K'), card('A', 'hearts'), card('K', 'hearts')], 100)

    expect(outcomeOf(round)).toBe('push')
    expect(payout(round)).toBe(0)
  })
})

describe('stand', () => {
  it('wins when the player beats the dealer', () => {
    const round = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')], 50))

    expect(outcomeOf(round)).toBe('win')
    expect(payout(round)).toBe(50)
  })

  it('keeps the dealer standing on a soft seventeen', () => {
    const round = stand(startRound([card('K'), card('Q'), card('A'), card('6')], 50))

    expect(round.dealer).toHaveLength(2)
    expect(outcomeOf(round)).toBe('win')
  })

  it('wins when the dealer draws into a bust', () => {
    const shoe = [card('K'), card('Q'), card('K', 'hearts'), card('6'), card('10', 'hearts')]
    const round = stand(startRound(shoe, 50))

    expect(outcomeOf(round)).toBe('win')
  })
})

describe('hit', () => {
  it('loses immediately when the player busts, before the dealer draws', () => {
    const round = hit(startRound([card('K'), card('6'), card('9'), card('7'), card('Q')], 40))

    expect(outcomeOf(round)).toBe('bust')
    expect(round.dealer).toHaveLength(2)
    expect(payout(round)).toBe(-40)
  })
})

describe('doubleDown', () => {
  it('doubles the stake and draws exactly one card', () => {
    const shoe = [card('6'), card('5'), card('K'), card('7'), card('10', 'hearts')]
    const round = doubleDown(startRound(shoe, 30))

    expect(round.hands[0].cards).toHaveLength(3)
    expect(round.hands[0].bet).toBe(60)
    expect(outcomeOf(round)).toBe('win')
    expect(payout(round)).toBe(60)
  })
})

describe('lateDouble', () => {
  it('doubles a hand after it has already taken a hit', () => {
    const shoe = [card('5'), card('3'), card('K'), card('7'), card('3', 'hearts'), card('10')]
    const round = lateDouble(hit(startRound(shoe, 20)))

    expect(round.hands[0].cards).toHaveLength(4)
    expect(round.hands[0].bet).toBe(40)
    expect(outcomeOf(round)).toBe('win')
    expect(payout(round)).toBe(40)
  })
})

describe('split', () => {
  it('can only split a pair of equal value', () => {
    expect(canSplit(startRound([card('8'), card('8', 'hearts'), card('9'), card('7')], 50))).toBe(true)
    expect(canSplit(startRound([card('8'), card('9'), card('9', 'hearts'), card('7')], 50))).toBe(false)
  })

  it('creates two hands from a pair and settles each against the dealer', () => {
    const shoe = [
      card('8'),
      card('8', 'hearts'),
      card('9'),
      card('7'),
      card('K'),
      card('Q'),
      card('10', 'hearts'),
    ]
    let round = split(startRound(shoe, 50))
    expect(round.hands).toHaveLength(2)

    round = stand(round)
    round = stand(round)

    expect(round.hands.map((hand) => hand.outcome)).toEqual(['win', 'win'])
    expect(payout(round)).toBe(100)
  })

  it('gives split aces one card each and resolves with no further actions', () => {
    const shoe = [card('A'), card('A', 'hearts'), card('9'), card('8'), card('K'), card('Q')]
    const round = split(startRound(shoe, 50))

    expect(round.status).toBe('resolved')
    expect(round.hands).toHaveLength(2)
    expect(round.hands.every((hand) => hand.cards.length === 2)).toBe(true)
  })
})

describe('armSecondChance', () => {
  it('burns a busting draw and stands on the replacement', () => {
    const shoe = [card('10'), card('6'), card('9'), card('8'), card('K'), card('4')]
    const round = hit(armSecondChance(startRound(shoe, 50)))

    expect(round.burned).toEqual(card('K'))
    expect(round.hands[0].cards).toEqual([card('10'), card('6'), card('4')])
    expect(outcomeOf(round)).toBe('win')
  })
})
