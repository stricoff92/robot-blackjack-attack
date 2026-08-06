import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { handReward } from './rewards'
import { hit, payout, stand, startRound, type Round } from './round'
import { applyUpgrade, hasAvailableUpgrade, startRun } from './run'
import { Session } from './session'
import {
  bumpUpgrade,
  emptyUpgrades,
  inflationResistanceFor,
  MAX_UPGRADE_TIER,
  nextTierLabel,
  rulesForUpgrades,
  tokenMultiplierFor,
  UPGRADE_PATHS,
  type RunUpgrades,
} from './upgrades'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

function reward(round: Round) {
  return handReward(round.hands[0], round)
}

function rules(overrides: Partial<RunUpgrades>) {
  return rulesForUpgrades({ ...emptyUpgrades(), ...overrides })
}

describe('rulesForUpgrades', () => {
  it('maps chip-eco tiers to the blackjack payout and push-wins', () => {
    // Default: 3:2 blackjack, pushes stay pushes.
    expect(rules({}).blackjackPayoutNumerator).toBe(3)
    expect(rules({}).blackjackPayoutDenominator).toBe(2)
    expect(rules({}).pushWinsToPlayer).toBe(false)
    // T1 → 2:1, T2 → 3:1.
    expect(rules({ chipEco: 1 }).blackjackPayoutNumerator).toBe(2)
    expect(rules({ chipEco: 1 }).blackjackPayoutDenominator).toBe(1)
    expect(rules({ chipEco: 2 }).blackjackPayoutNumerator).toBe(3)
    expect(rules({ chipEco: 2 }).blackjackPayoutDenominator).toBe(1)
    // T3 → the player wins all pushes.
    expect(rules({ chipEco: 3 }).pushWinsToPlayer).toBe(true)
  })

  it('maps anti-dealer tiers to refund, void, and hijack', () => {
    expect(rules({ antiDealer: 1 }).dealerNaturalRefundRatio).toBeCloseTo(0.75)
    expect(rules({ antiDealer: 1 }).voidDealer21).toBe(false)
    expect(rules({ antiDealer: 1 }).hijackDealerNatural).toBe(false)
    expect(rules({ antiDealer: 2 }).voidDealer21).toBe(true)
    expect(rules({ antiDealer: 2 }).hijackDealerNatural).toBe(false)
    expect(rules({ antiDealer: 3 }).hijackDealerNatural).toBe(true)
  })

  it('maps token-eco tiers to the reward multiplier', () => {
    expect(tokenMultiplierFor(emptyUpgrades())).toBe(1)
    expect(rules({ tokenEco: 1 }).tokenMultiplier).toBeCloseTo(1.1)
    expect(rules({ tokenEco: 2 }).tokenMultiplier).toBeCloseTo(1.18)
    expect(rules({ tokenEco: 3 }).tokenMultiplier).toBeCloseTo(1.3)
  })
})

describe('upgrade bookkeeping', () => {
  it('bumps a path in order and caps at the max tier', () => {
    let u = emptyUpgrades()
    u = bumpUpgrade(u, 'chipEco')
    u = bumpUpgrade(u, 'chipEco')
    u = bumpUpgrade(u, 'chipEco')
    expect(u.chipEco).toBe(MAX_UPGRADE_TIER)
    expect(bumpUpgrade(u, 'chipEco').chipEco).toBe(MAX_UPGRADE_TIER) // no overflow
  })

  it('reports an available upgrade until every path is maxed', () => {
    expect(hasAvailableUpgrade(startRun(1))).toBe(true)
    const maxed = { ...startRun(1), upgrades: { antiDealer: 3, chipEco: 3, tokenEco: 3 } }
    expect(hasAvailableUpgrade(maxed)).toBe(false)
  })

  it('shows the next-tier label per path and hides a maxed path', () => {
    const info = UPGRADE_PATHS[0]
    expect(nextTierLabel(info, 0)).toBe(info.tiers[0])
    expect(nextTierLabel(info, 2)).toBe(info.tiers[2])
    expect(nextTierLabel(info, MAX_UPGRADE_TIER)).toBeNull()
  })
})

describe('chip eco — payout', () => {
  it('pays a natural blackjack 2:1 with T1', () => {
    const round = startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], 10, rules({ chipEco: 1 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(payout(round)).toBe(20) // 2:1 instead of the default 3:2 (15)
  })

  it('pays a natural blackjack 3:1 with T2', () => {
    const round = startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], 10, rules({ chipEco: 2 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(payout(round)).toBe(30) // 3:1
  })

  it('no longer lifts a made 21 to a natural — the hand plays on', () => {
    // Player 7+4 hits a 10 to make 21; without auto-blackjack the round keeps going.
    const shoe = [card('7'), card('4'), card('10', 'hearts'), card('6'), card('10', 'diamonds')]
    const round = hit(startRound(shoe, 10, rules({ chipEco: 2 })))
    expect(round.status).toBe('player-turn')
    expect(round.dealer).toHaveLength(2) // dealer drew nothing yet
  })

  it('wins a genuine push as a chips-only win with T3 (no damage)', () => {
    // Player 20 vs dealer 20 is normally a push; Payout T3 pays it to the player.
    const round = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('10', 'diamonds')], 10, rules({ chipEco: 3 })))
    expect(round.hands[0].outcome).toBe('win')
    expect(round.hands[0].chipsOnly).toBe(true)
    expect(payout(round)).toBe(10) // even money on the tie
    expect(reward(round)).toEqual({ damage: 0, tokens: 0 }) // chips only, no damage/tokens
  })

  it('leaves a genuine push a push without T3', () => {
    const round = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('10', 'diamonds')], 10, rules({})))
    expect(round.hands[0].outcome).toBe('push')
  })
})

describe('anti-dealer — sabotage', () => {
  it('refunds 75% of the bet on a loss to a dealer natural (T1)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 1 }))
    expect(round.hands[0].outcome).toBe('lose')
    expect(payout(round)).toBe(-3) // lose only 25% of the 10 bet
  })

  it('voids a dealt dealer natural into a wash (T2)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 2 }))
    expect(round.hands[0].outcome).toBe('voided')
    expect(payout(round)).toBe(0)
    expect(reward(round)).toEqual({ damage: 0, tokens: 0 })
  })

  it('voids a dealer that hits to 21 (T2)', () => {
    // Player stands on 16; dealer 10+6 draws the 5 to make 21.
    const round = stand(startRound([card('9'), card('7'), card('10', 'hearts'), card('6'), card('5')], 10, rules({ antiDealer: 2 })))
    expect(round.dealer.map((c) => c.rank)).toEqual(['10', '6', '5'])
    expect(round.hands[0].outcome).toBe('voided')
    expect(payout(round)).toBe(0)
  })

  it('pays a voided dealer 21 out as a chips-only win with Payout T3 (T2 + chip T3)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 2, chipEco: 3 }))
    expect(round.hands[0].outcome).toBe('win')
    expect(round.hands[0].chipsOnly).toBe(true)
    expect(payout(round)).toBe(10)
    expect(reward(round)).toEqual({ damage: 0, tokens: 0 })
  })

  it('hijacks a dealer natural into a player blackjack (T3)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 3 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(payout(round)).toBe(15) // paid as a blackjack — 3:2 without the Payout upgrade
    expect(reward(round)).toEqual({ damage: 42, tokens: 21 }) // hijack deals real blackjack damage
  })

  it('turns a natural-vs-natural push into a player win under hijack (T3)', () => {
    const round = startRound([card('A'), card('K'), card('A', 'hearts'), card('K', 'hearts')], 10, rules({ antiDealer: 3 }))
    expect(round.hands[0].outcome).toBe('blackjack')
  })
})

describe('token eco', () => {
  it('scales a win reward by the token multiplier, leaving damage untouched', () => {
    const shoe = [card('K'), card('Q'), card('10', 'hearts'), card('7')] // player 20 beats dealer 17
    expect(reward(stand(startRound(shoe, 10, rules({ tokenEco: 2 }))))).toEqual({ damage: 22, tokens: 9 }) // 8 * 1.18
    expect(reward(stand(startRound(shoe, 10, rules({ tokenEco: 3 }))))).toEqual({ damage: 22, tokens: 10 }) // 8 * 1.30
  })

  it('resists token inflation, hardening across the tiers', () => {
    const at = (tokenEco: number): RunUpgrades => ({ antiDealer: 0, chipEco: 0, tokenEco })
    expect(inflationResistanceFor(at(0))).toBe(1)
    expect(inflationResistanceFor(at(1))).toBe(0.75)
    expect(inflationResistanceFor(at(2))).toBe(0.55)
    expect(inflationResistanceFor(at(3))).toBe(0.35)
  })
})

describe('Session choose-upgrade flow', () => {
  it('holds on choosing-upgrade after a kill, then applies the pick to the next round', () => {
    // A near-dead first dealer so the first win destroys it and offers a pick.
    for (let seed = 1; seed < 400; seed += 1) {
      const session = new Session(seed, { dealerHealth: 1 })
      let guard = 0
      while (guard++ < 300) {
        const s = session.snapshot()
        if (s.phase === 'choosing-upgrade') break
        if (s.phase === 'over') break
        if (s.phase === 'betting') session.deal()
        else if (s.phase === 'playing') session.stand()
        else if (s.phase === 'resolved') session.nextHand()
      }
      const atChoice = session.snapshot()
      if (atChoice.phase !== 'choosing-upgrade') continue // seed busted out first

      expect(atChoice.run.upgrades).toEqual({ antiDealer: 0, chipEco: 0, tokenEco: 0 })
      expect(atChoice.run.shiftIndex).toBe(2) // dealer 1 destroyed

      session.chooseUpgrade('chipEco')
      expect(session.snapshot().phase).toBe('betting')
      expect(session.snapshot().run.upgrades.chipEco).toBe(1)

      session.deal()
      // The pick threads into the next round's rules (2:1 blackjack payout at T1).
      expect(session.snapshot().round!.rules.blackjackPayoutDenominator).toBe(1)
      return
    }
    throw new Error('no seed reached a first-kill upgrade choice')
  })

  it('ignores an upgrade pick outside the choose screen', () => {
    const session = new Session(1)
    session.deal()
    session.chooseUpgrade('chipEco')
    expect(session.snapshot().run.upgrades.chipEco).toBe(0)
  })
})

describe('applyUpgrade on the run', () => {
  it('unlocks the next tier of the chosen path', () => {
    const run = applyUpgrade(applyUpgrade(startRun(7), 'antiDealer'), 'tokenEco')
    expect(run.upgrades).toEqual({ antiDealer: 1, chipEco: 0, tokenEco: 1 })
  })
})
