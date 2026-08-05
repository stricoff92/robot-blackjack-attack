import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from '../game/deck'
import { startRound } from '../game/round'
import { rulesForUpgrades } from '../game/upgrades'
import { ChipAnimation } from './chip-animator'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

// A player 16 losing to the dealer's natural blackjack — resolved right at the deal.
// With the Anti-dealer T1 upgrade the loss is partly refunded; without it, it isn't.
function dealerNaturalLoss(antiDealerTier: number) {
  const rules = rulesForUpgrades({ antiDealer: antiDealerTier, chipEco: 0, tokenEco: 0 })
  return startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules)
}

describe('ChipAnimation — Anti-dealer refund', () => {
  it('marks a dealer-natural loss as refunded only with the T1 upgrade', () => {
    expect(dealerNaturalLoss(1).hands[0].lostToDealerNatural).toBe(true)
    expect(dealerNaturalLoss(0).hands[0].lostToDealerNatural).toBeFalsy()
  })

  it('flies the bet to the dealer, then slides a refund back toward the bankroll', () => {
    const anim = new ChipAnimation()
    anim.clear(dealerNaturalLoss(1), 0)
    expect(anim.betChip(0, 5).phase).toBe('toDealer') // beat 1: the bet flies to the dealer
    expect(anim.betChip(0, anim.animEnd - 5).phase).toBe('refundBack') // beat 2: the refund slides back
    expect(anim.betChip(0, anim.animEnd + 1).phase).toBe('done')
  })

  it('settles a plain dealer-natural loss in a single beat, so a refund runs longer', () => {
    const plain = new ChipAnimation()
    plain.clear(dealerNaturalLoss(0), 0)
    expect(plain.betChip(0, plain.animEnd - 5).phase).toBe('toDealer') // no refund beat
    expect(plain.betChip(0, plain.animEnd + 1).phase).toBe('done')

    const refunded = new ChipAnimation()
    refunded.clear(dealerNaturalLoss(1), 0)
    expect(refunded.animEnd).toBeGreaterThan(plain.animEnd)
  })
})
