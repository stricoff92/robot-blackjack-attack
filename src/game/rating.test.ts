import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { DEFAULT_ROUND_RULES, type HandOutcome, type PlayerHand, type Round } from './round'
import { ratePlayerHand, startRun, tallyPerformance, tallyWash, type HandDecision } from './run'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

// A resolved player hand with the given outcome. Cards default to a plain non-natural 19 — only
// a genuine two-card natural (A + ten-value) trips ratePlayerHand's blackjack special case.
function hand(outcome: HandOutcome, cards: Card[] = [card('K'), card('9')]): PlayerHand {
  return { cards, bet: 10, doubled: false, splitAce: false, finished: true, busted: outcome === 'bust', outcome }
}

function decision(action: 'hit' | 'stand', bustChance: number, standLoseChance: number): HandDecision {
  return { action, bustChance, standLoseChance }
}

// A resolved round wrapping the given player hands (the only field tallyPerformance reads).
function roundOf(hands: PlayerHand[]): Round {
  return {
    shoe: [],
    drawIndex: 0,
    hands,
    activeIndex: hands.length - 1,
    dealer: [card('K'), card('8')],
    rules: DEFAULT_ROUND_RULES,
    status: 'resolved',
    secondChanceArmed: false,
    burned: null,
    dealerFrozen: false,
    mulliganed: false,
    discarded: [],
  }
}

// The six worked examples from the design, each phrased as (right call?, outcome) → star.
describe('ratePlayerHand', () => {
  it('rewards a winning hand on a correct call with 5 stars', () => {
    // Hit a stiff whose bust risk (0.45) is below the risk of losing by standing (0.6) — right, and won.
    expect(ratePlayerHand(hand('win'), decision('hit', 0.45, 0.6))).toBe(5)
  })

  it('does not punish a correct call that still lost (hit a 16 vs a dealer 17, busted) — 3 stars', () => {
    // Standing loses (0.7) more often than hitting busts (0.3): hitting is right; the unlucky bust is a 3.
    expect(ratePlayerHand(hand('bust'), decision('hit', 0.3, 0.7))).toBe(3)
  })

  it('punishes a reckless bust (hit a pat 17+ and busted) with 1 star', () => {
    // Bust risk (0.7) dwarfs the stand-loss risk (0.3): hitting was wrong, and it busted.
    expect(ratePlayerHand(hand('bust'), decision('hit', 0.7, 0.3))).toBe(1)
  })

  it('punishes playing too safe into a loss (stood when hitting was clearly right) with 1 star', () => {
    // Low bust risk (0.3), high stand-loss risk (0.8): should have hit; stood and lost.
    expect(ratePlayerHand(hand('lose'), decision('stand', 0.3, 0.8))).toBe(1)
  })

  it('only middlingly credits a lucky unnecessary risk (hit a pat 18 and won) with 3 stars', () => {
    expect(ratePlayerHand(hand('win'), decision('hit', 0.7, 0.2))).toBe(3)
  })

  it('grades a correct stand: right + loss = 3, right + win = 5', () => {
    // Standing is right when the bust risk (0.85) exceeds the stand-loss risk (0.4).
    expect(ratePlayerHand(hand('lose'), decision('stand', 0.85, 0.4))).toBe(3)
    expect(ratePlayerHand(hand('win'), decision('stand', 0.85, 0.4))).toBe(5)
  })

  it('grades a push between a win and a loss (4 on a right call, 2 on a wrong one)', () => {
    expect(ratePlayerHand(hand('push'), decision('stand', 0.85, 0.4))).toBe(4)
    expect(ratePlayerHand(hand('push'), decision('hit', 0.7, 0.2))).toBe(2)
  })

  it('gives a genuine two-card natural a flat 5, with no decision to judge', () => {
    expect(ratePlayerHand(hand('blackjack', [card('A'), card('K')]), undefined)).toBe(5)
  })

  it('returns null for an unrateable hand — the player never acted (a dealer natural off the deal)', () => {
    expect(ratePlayerHand(hand('lose'), undefined)).toBeNull()
  })

  it('treats a hijacked dealer 21 (blackjack outcome, non-natural cards) by its decision, not as a natural', () => {
    // A win graded through the grid...
    expect(ratePlayerHand(hand('blackjack', [card('K'), card('9')]), decision('stand', 0.85, 0.4))).toBe(5)
    // ...and unrateable (not an automatic 5) when it resolved before any decision.
    expect(ratePlayerHand(hand('blackjack', [card('K'), card('9')]), undefined)).toBeNull()
  })
})

describe('tallyPerformance', () => {
  const base = startRun(1)

  it('counts a busted round toward busts and folds in its 1-star rating', () => {
    const run = tallyPerformance(base, roundOf([hand('bust')]), [decision('hit', 0.7, 0.3)])
    expect(run.busts).toBe(1)
    expect(run.blackjackWins).toBe(0)
    expect(run.ratedHands).toBe(1)
    expect(run.ratingSum).toBe(1)
  })

  it('counts a blackjack round — including a hijacked dealer 21', () => {
    const round = roundOf([hand('blackjack', [card('K'), card('9')])]) // 'blackjack' outcome on a 19 = a hijack
    const run = tallyPerformance(base, round, [decision('stand', 0.9, 0.3)]) // right stand + win = 5
    expect(run.blackjackWins).toBe(1)
    expect(run.busts).toBe(0)
    expect(run.ratedHands).toBe(1)
    expect(run.ratingSum).toBe(5)
  })

  it('averages a split round into ONE hand rating', () => {
    // Hand A: right call + win = 5. Hand B: wrong call + loss = 1. Mean 3, counted as one hand.
    const round = roundOf([hand('win'), hand('lose')])
    const run = tallyPerformance(base, round, [decision('hit', 0.4, 0.6), decision('stand', 0.3, 0.8)])
    expect(run.ratedHands).toBe(1)
    expect(run.ratingSum).toBe(3)
  })

  it('skips the rating when no hand had a decision, but still tallies the outcomes', () => {
    const run = tallyPerformance(base, roundOf([hand('lose')]), [])
    expect(run.ratedHands).toBe(0)
    expect(run.ratingSum).toBe(0)
    expect(run.busts).toBe(0)
  })

  it('accumulates ratings across rounds', () => {
    const r1 = tallyPerformance(base, roundOf([hand('win')]), [decision('hit', 0.4, 0.6)]) // 5
    const r2 = tallyPerformance(r1, roundOf([hand('lose')]), [decision('stand', 0.3, 0.8)]) // 1
    expect(r2.ratedHands).toBe(2)
    expect(r2.ratingSum).toBe(6)
  })

  it('leaves the wash tally alone — only tallyWash counts a push', () => {
    const run = tallyPerformance(base, roundOf([hand('lose')]), [decision('stand', 0.3, 0.8)])
    expect(run.pushes).toBe(0)
    expect(tallyWash(tallyWash(run)).pushes).toBe(2)
    // The score screen derives push % from this counter precisely because a SCORED round is always
    // exactly one of won/lost — handsPlayed − handsWon − handsLost is a constant 0.
    expect(run.handsPlayed - run.handsWon - run.handsLost).toBe(0)
  })
})
