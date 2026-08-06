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
  it('maps chip-eco tiers to blackjack payout and the auto-blackjack total', () => {
    expect(rules({}).autoBlackjackAt).toBeNull()
    expect(rules({ chipEco: 1 }).blackjackPayoutNumerator).toBe(3)
    expect(rules({ chipEco: 1 }).blackjackPayoutDenominator).toBe(1)
    expect(rules({ chipEco: 2 }).autoBlackjackAt).toBe(21)
    expect(rules({ chipEco: 3 }).autoBlackjackAt).toBe(20)
    // Default (no chip eco) keeps the 3:2 payout.
    expect(rules({}).blackjackPayoutDenominator).toBe(2)
  })

  it('maps anti-dealer tiers to refund, hijack, and downgrade', () => {
    expect(rules({ antiDealer: 1 }).dealerNaturalRefundRatio).toBeCloseTo(0.6)
    expect(rules({ antiDealer: 1 }).hijackDealerNatural).toBe(false)
    expect(rules({ antiDealer: 2 }).hijackDealerNatural).toBe(true)
    expect(rules({ antiDealer: 2 }).dealerDowngrade).toBe(false)
    expect(rules({ antiDealer: 3 }).dealerDowngrade).toBe(true)
  })

  it('maps token-eco tiers to the reward multiplier', () => {
    expect(tokenMultiplierFor(emptyUpgrades())).toBe(1)
    expect(rules({ tokenEco: 1 }).tokenMultiplier).toBeCloseTo(1.05)
    expect(rules({ tokenEco: 2 }).tokenMultiplier).toBeCloseTo(1.1)
    expect(rules({ tokenEco: 3 }).tokenMultiplier).toBeCloseTo(1.2)
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

describe('chip eco — player 20/21 upgrades to natural blackjack', () => {
  it('resolves a hit to 21 instantly as a blackjack, with no dealer draw (T2)', () => {
    // Player 7+4 hits a 10 to make 21; the dealer sits on 16 and would otherwise
    // draw the 5 at the tail — the extra cards prove it takes none.
    const shoe = [card('7'), card('4'), card('10', 'hearts'), card('6'), card('10', 'diamonds'), card('5')]
    const round = hit(startRound(shoe, 10, rules({ chipEco: 2 })))
    expect(round.status).toBe('resolved')
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(round.dealer).toHaveLength(2) // dealer drew nothing
    expect(reward(round)).toEqual({ damage: 42, tokens: 21 })
  })

  it('resolves an opening 20 as a blackjack (T3)', () => {
    const round = startRound([card('K'), card('Q'), card('10', 'hearts'), card('5')], 10, rules({ chipEco: 3 }))
    expect(round.status).toBe('resolved')
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(round.dealer).toHaveLength(2)
    // chipEco 3 implies T1 too (tiers unlock in order), so the blackjack pays 3:1.
    expect(payout(round)).toBe(30)
  })

  it('pushes a player 20 against a dealt dealer natural (T3)', () => {
    const round = startRound([card('K'), card('Q'), card('A'), card('K', 'hearts')], 10, rules({ chipEco: 3 }))
    expect(round.hands[0].outcome).toBe('push')
  })

  it('does not touch a 20 without the T3 upgrade', () => {
    // With only T2 (auto at 21), an opening 20 still plays out normally.
    const round = startRound([card('K'), card('Q'), card('10', 'hearts'), card('5')], 10, rules({ chipEco: 2 }))
    expect(round.status).toBe('player-turn')
  })
})

describe('chip eco — payout', () => {
  it('pays a blackjack 3:1 with T1', () => {
    const round = startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], 10, rules({ chipEco: 1 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(payout(round)).toBe(30) // 3:1 instead of the default 3:2 (15)
  })
})

describe('anti-dealer — sabotage', () => {
  it('hijacks a dealer natural into a player blackjack (T2)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 2 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(payout(round)).toBe(15) // paid as a blackjack — 3:2 without the Payout upgrade
    expect(reward(round)).toEqual({ damage: 42, tokens: 21 }) // the blackjack reward
  })

  it('pays a hijacked blackjack at 3:1 with the Payout upgrade (T2 + chip T1)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 2, chipEco: 1 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(payout(round)).toBe(30) // the hijacked blackjack respects the 3:1 payout
  })

  it('turns a natural-vs-natural push into a player win under hijack (T2)', () => {
    const round = startRound([card('A'), card('K'), card('A', 'hearts'), card('K', 'hearts')], 10, rules({ antiDealer: 2 }))
    expect(round.hands[0].outcome).toBe('blackjack')
  })

  it('refunds 60% of the bet on a loss to a dealer natural (T1)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], 10, rules({ antiDealer: 1 }))
    expect(round.hands[0].outcome).toBe('lose')
    expect(payout(round)).toBe(-4) // lose only 40% of the 10 bet
  })

  it('downgrades the dealer total by 1 under 21, flipping a push to a win (T3)', () => {
    // Player 18 vs dealer 18 is normally a push; the downgrade makes the dealer 17.
    const round = stand(startRound([card('10'), card('8'), card('10', 'hearts'), card('8', 'hearts')], 10, rules({ antiDealer: 3 })))
    expect(round.hands[0].outcome).toBe('win')
    expect(reward(round)).toEqual({ damage: 22, tokens: 8 }) // beat-17 tier, the weaker grade
  })

  it('leaves the same hand a push without the downgrade', () => {
    const round = stand(startRound([card('10'), card('8'), card('10', 'hearts'), card('8', 'hearts')], 10, rules({})))
    expect(round.hands[0].outcome).toBe('push')
  })
})

describe('token eco', () => {
  it('scales a win reward by the token multiplier, leaving damage untouched', () => {
    const shoe = [card('K'), card('Q'), card('10', 'hearts'), card('7')] // player 20 beats dealer 17
    expect(reward(stand(startRound(shoe, 10, rules({ tokenEco: 2 }))))).toEqual({ damage: 22, tokens: 9 }) // 8 * 1.10
    expect(reward(stand(startRound(shoe, 10, rules({ tokenEco: 3 }))))).toEqual({ damage: 22, tokens: 10 }) // 8 * 1.20
  })

  it('resists token inflation, from full to half across the tiers', () => {
    const at = (tokenEco: number): RunUpgrades => ({ antiDealer: 0, chipEco: 0, tokenEco })
    expect(inflationResistanceFor(at(0))).toBe(1)
    expect(inflationResistanceFor(at(1))).toBe(0.85)
    expect(inflationResistanceFor(at(2))).toBe(0.7)
    expect(inflationResistanceFor(at(3))).toBe(0.5)
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
      // The pick threads into the next round's rules (3:1 blackjack payout).
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
