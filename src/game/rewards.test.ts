import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { handReward } from './rewards'
import { DEFAULT_ROUND_RULES, freezeDealer, hit, stand, startRound, type Round } from './round'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

// The reward for the round's first (here, only) hand.
function reward(round: Round) {
  return handReward(round.hands[0], round)
}

describe('handReward', () => {
  it('climbs with the standing dealer total the player beat', () => {
    // Player 20 over dealer 17 / 18 / 19, then a 21 over dealer 20.
    expect(reward(stand(startRound([card('K'), card('Q'), card('10'), card('7')])))).toEqual({ tokens: 8 })
    expect(reward(stand(startRound([card('K'), card('Q'), card('10'), card('8')])))).toEqual({ tokens: 12 })
    expect(reward(stand(startRound([card('K'), card('Q'), card('10'), card('9')])))).toEqual({ tokens: 16 })

    const beat20 = stand(hit(startRound([card('7'), card('7'), card('10'), card('10', 'hearts'), card('7', 'hearts')])))
    expect(beat20.hands[0].outcome).toBe('win')
    expect(reward(beat20)).toEqual({ tokens: 22 })
  })

  it('pays the least for a dealer that busts from a stiff (no abandoned stand)', () => {
    // Dealer 16 was forced to draw, so the bust earns nothing more than the bust tier.
    const dealerBust = stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('6'), card('10', 'hearts')]))
    expect(reward(dealerBust)).toEqual({ tokens: 4 })
  })

  it('does not punish the player when the dealer busts from a hand it would have stood on', () => {
    // Player 20; dealer 10+9 = hard 19, hits it (desperation ceiling 19) and busts on a 5.
    // Grade as beating the abandoned 19, not the weak bust tier.
    const desperate = { ...DEFAULT_ROUND_RULES, dealerSoft17: 'smart' as const, dealerHardHitCeiling: 19 }
    const shoe = [card('K'), card('K', 'hearts'), card('10'), card('9'), card('5')]
    const round = stand(startRound(shoe, desperate))
    expect(round.dealer.length).toBeGreaterThan(2) // it hit the 19
    expect(reward(round)).toEqual({ tokens: 16 }) // beat-19, not { 12, 4 }
  })

  it('credits an abandoned soft 17 (H17 dealer) as beat-17 on a bust', () => {
    // Dealer A+6 = soft 17, hits per H17 → 6 → 13 → K → bust. Player 18 wins.
    const hitRules = { ...DEFAULT_ROUND_RULES, dealerSoft17: 'hit' as const }
    const shoe = [card('K'), card('8'), card('A'), card('6'), card('6', 'hearts'), card('K', 'hearts')]
    expect(reward(stand(startRound(shoe, hitRules)))).toEqual({ tokens: 8 })
  })

  it('grades every frozen-dealer win as the 17 tier', () => {
    // Frozen on 19, which would otherwise be the 40/16 tier.
    const frozen = stand(freezeDealer(startRound([card('K'), card('Q'), card('10'), card('9')])))
    expect(frozen.dealerFrozen).toBe(true)
    expect(reward(frozen)).toEqual({ tokens: 8 })
  })

  it('gives a natural blackjack its own premium', () => {
    const natural = startRound([card('A'), card('K'), card('10', 'hearts'), card('7')])
    expect(natural.hands[0].outcome).toBe('blackjack')
    expect(reward(natural)).toEqual({ tokens: 21 })
  })

  it('is nothing on a loss or a push', () => {
    const loss = stand(startRound([card('9'), card('7'), card('K'), card('Q')]))
    expect(loss.hands[0].outcome).toBe('lose')
    expect(reward(loss)).toEqual({ tokens: 0 })

    const push = stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('Q', 'hearts')]))
    expect(push.hands[0].outcome).toBe('push')
    expect(reward(push)).toEqual({ tokens: 0 })
  })

  it('grades a chips-only push-win (Payout T3) at the floor token tier', () => {
    // A push resolved to the player as a win lands a hit + scores like any win, but there was no
    // dealer total to beat, so its tokens grade at the floor (17) tier.
    const round = stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('Q', 'hearts')], { ...DEFAULT_ROUND_RULES, pushWinsToPlayer: true }))
    expect(round.hands[0].outcome).toBe('win')
    expect(round.hands[0].chipsOnly).toBe(true)
    expect(reward(round)).toEqual({ tokens: 8 })
  })

  it('is nothing when the player busts', () => {
    const playerBust = hit(startRound([card('K'), card('6'), card('9'), card('7'), card('Q')]))
    expect(playerBust.hands[0].busted).toBe(true)
    expect(reward(playerBust)).toEqual({ tokens: 0 })
  })
})
