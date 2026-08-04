import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { damageForRound } from './integrity'
import { freezeDealer, hit, stand, startRound } from './round'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

describe('damageForRound', () => {
  it('scales with the standing dealer total the player beat', () => {
    // Player 20 over a standing dealer 17 — the lowest standing tier.
    const beat17 = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')], 10))
    expect(damageForRound(beat17)).toBe(22)
  })

  it('hits hardest when the player beats a dealer 20', () => {
    // Player 7+7, hit a 7 → a non-natural 21 over a standing dealer 20.
    const shoe = [card('7'), card('7'), card('10'), card('10', 'hearts'), card('7', 'hearts')]
    const beat20 = stand(hit(startRound(shoe, 10)))
    expect(damageForRound(beat20)).toBe(52)
  })

  it('deals the least when the dealer busts itself', () => {
    const shoe = [card('K'), card('Q'), card('K', 'hearts'), card('6'), card('10', 'hearts')]
    const dealerBust = stand(startRound(shoe, 10)) // dealer 16 draws a ten → 26
    expect(damageForRound(dealerBust)).toBe(12)
  })

  it('grades a frozen-dealer win as the 17 tier, however high the frozen total', () => {
    // Dealer frozen on 19; the player's 20 still only earns the 17-tier damage.
    const round = stand(freezeDealer(startRound([card('K'), card('Q'), card('10'), card('9')], 10)))
    expect(round.dealerFrozen).toBe(true)
    expect(damageForRound(round)).toBe(22)
  })

  it('treats a natural blackjack as its own premium', () => {
    const natural = startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], 10)
    expect(damageForRound(natural)).toBe(42)
  })

  it('lands nothing when the player busts, since the dealer never draws', () => {
    const playerBust = hit(startRound([card('K'), card('6'), card('9'), card('7'), card('Q')], 10))
    expect(damageForRound(playerBust)).toBe(0)
  })
})
