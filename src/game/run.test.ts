import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { hit, stand, startRound } from './round'
import { applyRound, getShift, isLastCall, nextBet, startRun } from './run'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

function standWin(bet: number) {
  return stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')], bet))
}

function hitThenWin(bet: number) {
  return stand(hit(startRound([card('9'), card('2'), card('10', 'hearts'), card('7'), card('8')], bet)))
}

function natural(bet: number) {
  return startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], bet)
}

function dealerBustWin(bet: number) {
  return stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('6'), card('10', 'hearts')], bet))
}

function pushHand(bet: number) {
  return stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('Q', 'hearts')], bet))
}

function losingHand(bet: number) {
  return stand(startRound([card('9'), card('7'), card('K'), card('Q')], bet))
}

describe('startRun', () => {
  it('opens with the documented starting resources', () => {
    const run = startRun(1)

    expect(run.chips).toBe(300)
    expect(run.tokens).toBe(0)
    expect(run.integrity).toBe(100)
    expect(run.shiftIndex).toBe(1)
  })
})

describe('getShift', () => {
  it('reads the fixed ladder for early shifts', () => {
    expect(getShift(4)).toMatchObject({ minBet: 150, maxBet: 1500, scoreMultiplier: 3 })
  })

  it('extrapolates prototype units beyond the table', () => {
    expect(getShift(7)).toMatchObject({ minBet: 2500, maxBet: 25000, scoreMultiplier: 7 })
  })
})

describe('applyRound token rewards', () => {
  it('grants ten tokens for a plain win', () => {
    expect(applyRound(startRun(1), standWin(10)).tokens).toBe(10)
  })

  it('does not re-count hits at settle, since they are credited live', () => {
    expect(applyRound(startRun(1), hitThenWin(10)).tokens).toBe(10)
  })

  it('grants twenty-one tokens for a blackjack', () => {
    expect(applyRound(startRun(1), natural(10)).tokens).toBe(21)
  })
})

describe('applyRound advancement', () => {
  it('only advances by destroying the dealer, and pays the destroy token', () => {
    let run = startRun(1)
    for (let hand = 0; hand < 4; hand += 1) {
      run = applyRound(run, dealerBustWin(10))
    }

    expect(run.shiftIndex).toBe(2)
    expect(run.integrity).toBe(100)
    expect(run.kills).toEqual([1])
    expect(run.tokens).toBe(4 * 10 + 40)
  })

  it('never advances a dealer that is not destroyed, no matter how many hands pass', () => {
    let run = startRun(1)
    for (let hand = 0; hand < 15; hand += 1) {
      run = applyRound(run, pushHand(10))
    }

    expect(run.shiftIndex).toBe(1)
    expect(run.integrity).toBe(100)
    expect(run.kills).toEqual([])
  })
})

describe('nextBet', () => {
  it('scales the fixed bet up as a dealer drags on', () => {
    const run0 = startRun(1)
    expect(nextBet(run0)).toBe(10)

    const run1 = applyRound(run0, standWin(10))
    expect(run1.handsThisDealer).toBe(1)
    expect(nextBet(run1)).toBe(15)
  })

  it('resets to the new dealer minimum after a destroy', () => {
    let run = startRun(1)
    for (let hand = 0; hand < 4; hand += 1) {
      run = applyRound(run, dealerBustWin(10))
    }

    expect(run.shiftIndex).toBe(2)
    expect(nextBet(run)).toBe(25)
  })
})

describe('applyRound bust-out', () => {
  it('ends the run when chips reach zero', () => {
    const run = applyRound({ ...startRun(1), chips: 40 }, losingHand(40))

    expect(run.over).toBe(true)
    expect(run.chips).toBe(0)
  })
})

describe('isLastCall', () => {
  it('triggers when chips fall below the table minimum', () => {
    expect(isLastCall({ ...startRun(1), chips: 5 })).toBe(true)
  })
})
