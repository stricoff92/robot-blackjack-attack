import { describe, expect, it } from 'vitest'

import { createShoe, type Card, type Rank, type Suit } from './deck'
import { bustChanceOnHit, computeAnalysis, dealerWinChance, NOTHING_KNOWN, type Knowledge } from './odds'
import { createRng } from './random'
import { hit, startRound, type Round } from './round'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

// A real 6-deck shoe (correct composition) with specific ranks seated at the
// front, so startRound deals a known opening: [player, player, dealerUp,
// dealerHole, ...upcoming draws].
function craftShoe(front: Rank[]): Card[] {
  const shoe = createShoe(6)
  for (let i = 0; i < front.length; i += 1) {
    const j = shoe.findIndex((c, k) => k >= i && c.rank === front[i])
    const held = shoe[i]
    shoe[i] = shoe[j]
    shoe[j] = held
  }
  return shoe
}

function roundOf(front: Rank[]): Round {
  return startRound(craftShoe(front), 10)
}

// The dealer's hole card as a peek would reveal it.
function peekedHole(round: Round): Knowledge {
  return { hole: round.dealer[1] }
}

describe('bustChanceOnHit', () => {
  it('is zero when no single card can bust the hand', () => {
    // Player 2+3 = 5; even an ace only reaches 16.
    expect(bustChanceOnHit(roundOf(['2', '3', '9', '7']))).toBe(0)
  })

  it('is one when every remaining card busts a hard 21', () => {
    // 10+6, hit a 5 → hard 21; any further card busts.
    const round = hit(roundOf(['10', '6', '9', '7', '5']))
    expect(round.hands[0].cards.map((c) => c.rank)).toEqual(['10', '6', '5'])
    expect(bustChanceOnHit(round)).toBe(1)
  })

  it('reflects the deck composition on a hard 20 (only an ace survives)', () => {
    // 10+10 = 20: every rank but an ace busts, and aces are ~1/13 of the shoe.
    const chance = bustChanceOnHit(roundOf(['10', '10', '9', '7']))
    expect(chance).toBeGreaterThan(0.9)
    expect(chance).toBeLessThan(1)
    expect(chance).toBeCloseTo(285 / 309, 5) // 309 unseen, 24 of them aces
  })

  it('excludes discarded (mulligan-spent) cards from the pool', () => {
    const base = roundOf(['10', '6', '9', '7']) // hard 16: cards 6-10 bust it
    const baseChance = bustChanceOnHit(base)
    // Tossing busting cards out of the shoe lowers the bust odds...
    const fewerTens = { ...base, discarded: [card('K'), card('Q'), card('J'), card('10', 'hearts')] }
    expect(bustChanceOnHit(fewerTens)).toBeLessThan(baseChance)
    // ...and tossing safe low cards raises them.
    const fewerLows = { ...base, discarded: [card('A'), card('2'), card('3'), card('4')] }
    expect(bustChanceOnHit(fewerLows)).toBeGreaterThan(baseChance)
  })
})

describe('dealerWinChance', () => {
  it('is zero against a player 21 (the dealer can only tie or bust)', () => {
    const round = hit(roundOf(['10', '6', '9', '7', '5'])) // player 21
    expect(dealerWinChance(round, NOTHING_KNOWN, createRng(1), 2000)).toBe(0)
  })

  it('is high when the dealer shows a ten against a weak player total', () => {
    // Player 12 vs a dealer 10-up: the dealer stands 17+ (> 12) unless it busts,
    // so the win rate tracks the ~77% the dealer avoids busting on a ten.
    const chance = dealerWinChance(roundOf(['10', '2', '10', '5']), NOTHING_KNOWN, createRng(7), 4000)
    expect(chance).toBeGreaterThan(0.6)
    expect(chance).toBeLessThan(0.95)
  })

  it('is deterministic for a fixed seed', () => {
    const round = roundOf(['10', '2', '10', '5'])
    const a = dealerWinChance(round, NOTHING_KNOWN, createRng(3), 1000)
    const b = dealerWinChance(round, NOTHING_KNOWN, createRng(3), 1000)
    expect(a).toBe(b)
  })

  it('uses a peeked hole card instead of averaging over it', () => {
    // Player 18; dealer shows a king with a hole 9 → a standing 19 that always
    // beats 18. Known, the answer is a certain 1; blind, it's the hole-averaged
    // mix (the dealer often busts or makes 17/18), which is well below 1.
    const round = roundOf(['10', '8', 'K', '9'])
    expect(round.dealer[1].rank).toBe('9')
    expect(dealerWinChance(round, peekedHole(round), createRng(2), 500)).toBe(1)

    const blind = dealerWinChance(round, NOTHING_KNOWN, createRng(2), 4000)
    expect(blind).toBeLessThan(0.9)
  })
})

describe('computeAnalysis', () => {
  it('returns both odds inside [0, 1]', () => {
    const round = roundOf(['8', '7', '6', '10'])
    const a = computeAnalysis(round, NOTHING_KNOWN, createRng(9), 1000)
    for (const value of [a.bustChance, a.dealerWinChance]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }

    // A peek can only sharpen the reading — still valid probabilities.
    const withPeek = computeAnalysis(round, { hole: round.dealer[1] }, createRng(9), 1000)
    for (const value of [withPeek.bustChance, withPeek.dealerWinChance]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})
