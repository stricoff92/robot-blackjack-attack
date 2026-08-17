import { describe, expect, it } from 'vitest'

import type { Card } from './deck'
import { hitsForRound } from './integrity'
import { DEFAULT_ROUND_RULES, type HandOutcome, type PlayerHand, type Round } from './round'

function card(rank: Card['rank'], suit: Card['suit'] = 'spades'): Card {
  return { rank, suit }
}

function hand(outcome: HandOutcome, opts: Partial<PlayerHand> = {}): PlayerHand {
  return {
    cards: [card('10'), card('7')],
    bet: 1,
    doubled: false,
    splitAce: false,
    finished: true,
    busted: outcome === 'bust',
    outcome,
    ...opts,
  }
}

function resolved(hands: PlayerHand[]): Round {
  return {
    shoe: [],
    drawIndex: 0,
    hands,
    activeIndex: 0,
    dealer: [card('10'), card('7')],
    rules: DEFAULT_ROUND_RULES,
    status: 'resolved',
    secondChanceArmed: false,
    burned: null,
    dealerFrozen: false,
    mulliganed: false,
    discarded: [],
  }
}

// Dealer health is now integer HITS: every winning hand lands 1 hit ×weight (a doubled win = 2);
// losses, pushes, and player busts land none. The old damage-by-dealer-total tiers are gone (they
// live on in the TOKEN reward instead — see rewards.ts).
describe('hitsForRound', () => {
  it('lands one hit per winning hand (a natural blackjack included)', () => {
    expect(hitsForRound(resolved([hand('win')]))).toBe(1)
    expect(hitsForRound(resolved([hand('blackjack')]))).toBe(1)
  })

  it('a doubled win lands 2 hits (its stake weight)', () => {
    expect(hitsForRound(resolved([hand('win', { doubled: true })]))).toBe(2)
  })

  it('sums across split hands, counting only the wins', () => {
    expect(hitsForRound(resolved([hand('win'), hand('lose'), hand('win')]))).toBe(2)
  })

  it('lands nothing on a loss, a push, or a player bust', () => {
    expect(hitsForRound(resolved([hand('lose')]))).toBe(0)
    expect(hitsForRound(resolved([hand('push')]))).toBe(0)
    expect(hitsForRound(resolved([hand('bust')]))).toBe(0)
  })
})
