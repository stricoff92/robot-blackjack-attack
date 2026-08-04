import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import {
  armSecondChance,
  canMulligan,
  canSplit,
  DEFAULT_ROUND_RULES,
  doubleDown,
  freezeDealer,
  handNet,
  hit,
  lateDouble,
  mulligan,
  payout,
  type PlayerHand,
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

  it('splits any two ten-value cards, not just identical ranks (standard US casino rule)', () => {
    // 10, J, Q, K are all worth ten, so any two of them form a splittable pair.
    expect(canSplit(startRound([card('10'), card('K'), card('9'), card('7')], 50))).toBe(true)
    expect(canSplit(startRound([card('Q'), card('J'), card('9'), card('7')], 50))).toBe(true)
    expect(canSplit(startRound([card('A'), card('A', 'hearts'), card('9'), card('7')], 50))).toBe(true)
    // ...but a ten and a nine are not equal value, so they are not a pair.
    expect(canSplit(startRound([card('10'), card('9'), card('9', 'hearts'), card('7')], 50))).toBe(false)
  })

  it('cannot split after taking a hit, or a hand that is not two cards', () => {
    const round = hit(startRound([card('8'), card('8', 'hearts'), card('9'), card('7'), card('2')], 50))
    expect(round.hands[0].cards).toHaveLength(3)
    expect(canSplit(round)).toBe(false)
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

  it('scores 21 after splitting aces as a plain win, not a 3:2 blackjack (US casino rule)', () => {
    // Split aces each draw a ten → 21, but a post-split 21 is a normal win at
    // even money, never a blackjack.
    const shoe = [card('A'), card('A', 'hearts'), card('10'), card('7'), card('K'), card('Q')]
    const round = split(startRound(shoe, 50))

    expect(round.hands.map((hand) => hand.outcome)).toEqual(['win', 'win'])
    expect(round.hands.some((hand) => hand.outcome === 'blackjack')).toBe(false)
    expect(payout(round)).toBe(100) // 50 + 50 even money, NOT 75 + 75 at 3:2
  })
})

describe('handNet', () => {
  function settled(outcome: PlayerHand['outcome'], bet: number, patch: Partial<PlayerHand> = {}): PlayerHand {
    return { cards: [], bet, doubled: false, splitAce: false, finished: true, busted: false, outcome, ...patch }
  }

  it('reports each hand its own win/loss/push (so both halves of a split settle)', () => {
    expect(handNet(settled('win', 50), DEFAULT_ROUND_RULES)).toBe(50)
    expect(handNet(settled('lose', 50), DEFAULT_ROUND_RULES)).toBe(-50)
    expect(handNet(settled('push', 50), DEFAULT_ROUND_RULES)).toBe(0)
    expect(handNet(settled('bust', 50, { busted: true }), DEFAULT_ROUND_RULES)).toBe(-50)
    expect(handNet(settled('blackjack', 50), DEFAULT_ROUND_RULES)).toBe(75)
  })

  it('sums to payout across a multi-hand round', () => {
    // Player splits 8s → hands [8,10]=18 and [8,3]=11; both stand; dealer 9,7,5 = 21.
    const shoe = [card('8'), card('8'), card('9'), card('7'), card('10'), card('3'), card('5'), card('2')]
    const played = stand(stand(split(startRound(shoe, 50))))
    expect(played.status).toBe('resolved')
    expect(played.hands).toHaveLength(2)
    const perHand = played.hands.reduce((total, hand) => total + handNet(hand, played.rules), 0)
    expect(perHand).toBe(payout(played))
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

  it('never busts even when the replacement also busts — stands on the current total', () => {
    // [10,6]=16; first draw 10 -> 26 (burned); replacement 9 -> 25 also busts, so
    // the shield stands the hand on 16 rather than busting.
    const shoe = [card('10'), card('6'), card('9'), card('8'), card('10', 'hearts'), card('9', 'hearts')]
    const round = hit(armSecondChance(startRound(shoe, 50)))

    expect(round.hands[0].busted).toBe(false)
    expect(outcomeOf(round)).not.toBe('bust')
    expect(round.hands[0].cards).toEqual([card('10'), card('6')]) // stood on 16, no card added
    expect(round.secondChanceArmed).toBe(false) // shield still spent
    expect(round.burned).toEqual(card('10', 'hearts'))
  })
})

describe('freezeDealer', () => {
  it('makes the dealer stand on its current total instead of drawing', () => {
    // Dealer holds 6,6 = 12 and would normally draw. Frozen, it stands on 12 with
    // no card added, so the player's 20 wins.
    const shoe = [card('K'), card('Q'), card('6'), card('6', 'hearts'), card('K', 'hearts')]
    const round = stand(freezeDealer(startRound(shoe, 50)))

    expect(round.dealer).toEqual([card('6'), card('6', 'hearts')])
    expect(outcomeOf(round)).toBe('win')
    expect(payout(round)).toBe(50)
  })

  it('turns a would-be dealer draw-out into a win', () => {
    // Dealer 10,6 = 16 would hit and draw a 5 to reach 21 (beating the player's
    // 20). Frozen, it stands on 16 and loses to the 20.
    const shoe = [card('K'), card('Q'), card('10', 'hearts'), card('6'), card('5')]

    expect(outcomeOf(stand(startRound(shoe, 50)))).toBe('lose') // unfrozen: draws to 21
    expect(outcomeOf(stand(freezeDealer(startRound(shoe, 50))))).toBe('win') // frozen: stands on 16
  })
})

describe('mulligan', () => {
  it('discards the opening hand and deals a fresh one from the shoe', () => {
    // Opening 10,6 = 16 is thrown away; the next two cards (K,5) become the hand.
    const shoe = [card('10'), card('6'), card('9'), card('7'), card('K'), card('5'), card('4')]
    const round = mulligan(startRound(shoe, 50))

    expect(round.hands[0].cards).toEqual([card('K'), card('5')])
    expect(round.mulliganed).toBe(true)
    expect(round.status).toBe('player-turn')
  })

  it('records the tossed cards as discarded (spent + known, out of the odds pool)', () => {
    const shoe = [card('10'), card('6'), card('9'), card('7'), card('K'), card('5'), card('4')]
    const round = mulligan(startRound(shoe, 50))

    expect(round.discarded).toEqual([card('10'), card('6')])
  })

  it('can only be used once per round', () => {
    const shoe = [card('10'), card('6'), card('9'), card('7'), card('K'), card('5'), card('4'), card('3')]
    const round = mulligan(startRound(shoe, 50))

    expect(canMulligan(round)).toBe(false)
    expect(() => mulligan(round)).toThrow()
  })

  it('cannot mulligan after taking a hit', () => {
    // 10,6 -> hit a 2 = 18 (three cards), so the opening-hand window has closed.
    const shoe = [card('10'), card('6'), card('9'), card('7'), card('2'), card('5')]
    const round = hit(startRound(shoe, 50))

    expect(round.hands[0].cards).toHaveLength(3)
    expect(canMulligan(round)).toBe(false)
  })

  it('cannot mulligan after splitting', () => {
    const shoe = [card('8'), card('8', 'hearts'), card('9'), card('7'), card('K'), card('Q'), card('4')]
    const round = split(startRound(shoe, 50))

    expect(round.hands).toHaveLength(2)
    expect(canMulligan(round)).toBe(false)
  })

  it('pays a redealt blackjack as a natural', () => {
    // Fresh hand A,K = 21 resolves immediately at 3:2.
    const shoe = [card('10'), card('6'), card('9'), card('7'), card('A'), card('K')]
    const round = mulligan(startRound(shoe, 50))

    expect(outcomeOf(round)).toBe('blackjack')
    expect(payout(round)).toBe(75)
  })
})
