import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { handReward } from './rewards'
import { hit, stand, startRound, type Round } from './round'
import { applyUpgrade, hasAvailableUpgrade, startRun } from './run'
import { Session } from './session'
import {
  blackjackPointBonusFor,
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
  it('maps chip-eco (Payout) tiers to the blackjack point bonus and push-wins', () => {
    // Default: no point bonus, pushes stay pushes.
    expect(blackjackPointBonusFor(emptyUpgrades())).toBe(0)
    expect(rules({}).pushWinsToPlayer).toBe(false)
    // T1 → +50%, T2 → +100% points on a natural blackjack (a scoring effect, not a settlement rule).
    expect(blackjackPointBonusFor({ ...emptyUpgrades(), chipEco: 1 })).toBe(0.5)
    expect(blackjackPointBonusFor({ ...emptyUpgrades(), chipEco: 2 })).toBe(1)
    // T3 → the player wins all pushes.
    expect(rules({ chipEco: 3 }).pushWinsToPlayer).toBe(true)
  })

  it('maps anti-dealer (Sabotage) tiers to dealer-21 energy, redeal, and hijack', () => {
    // T1's +20-energy flag stays on at every tier (the energy pays at all three).
    expect(rules({ antiDealer: 1 }).dealer21Energy).toBe(true)
    expect(rules({ antiDealer: 1 }).voidDealer21).toBe(false)
    expect(rules({ antiDealer: 1 }).hijackDealerNatural).toBe(false)
    expect(rules({ antiDealer: 2 }).dealer21Energy).toBe(true)
    expect(rules({ antiDealer: 2 }).voidDealer21).toBe(true)
    expect(rules({ antiDealer: 2 }).hijackDealerNatural).toBe(false)
    expect(rules({ antiDealer: 3 }).dealer21Energy).toBe(true)
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

describe('chip eco — Payout settlement', () => {
  it('does not lift a made 21 to a natural — the hand plays on', () => {
    // Player 7+4 hits a 10 to make 21; without auto-blackjack the round keeps going.
    const shoe = [card('7'), card('4'), card('10', 'hearts'), card('6'), card('10', 'diamonds')]
    const round = hit(startRound(shoe, rules({ chipEco: 2 })))
    expect(round.status).toBe('player-turn')
    expect(round.dealer).toHaveLength(2) // dealer drew nothing yet
  })

  it('wins a genuine push as a chips-only win with T3, graded at the floor token tier', () => {
    // Player 20 vs dealer 20 is normally a push; Payout T3 pays it to the player as a win.
    const round = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('10', 'diamonds')], rules({ chipEco: 3 })))
    expect(round.hands[0].outcome).toBe('win')
    expect(round.hands[0].chipsOnly).toBe(true)
    expect(reward(round)).toEqual({ tokens: 8 }) // floor tier — no dealer total was beaten
  })

  it('leaves a genuine push a push without T3', () => {
    const round = stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('10', 'diamonds')], rules({})))
    expect(round.hands[0].outcome).toBe('push')
  })
})

describe('anti-dealer — Sabotage settlement', () => {
  it('leaves a loss to a dealer natural a plain loss at T1 (energy is credited by the Session, not here)', () => {
    // The +20-energy bonus fires on the dealer's 21 in Session.settle_ (see session.test.ts); the pure
    // round resolution just settles the loss — no settlement flag, no window/redeal change.
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], rules({ antiDealer: 1 }))
    expect(round.hands[0].outcome).toBe('lose')
  })

  it('voids a dealt dealer natural into a wash (T2)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], rules({ antiDealer: 2 }))
    expect(round.hands[0].outcome).toBe('voided')
    expect(reward(round)).toEqual({ tokens: 0 })
  })

  it('voids a dealer that hits to 21 (T2)', () => {
    // Player stands on 16; dealer 10+6 draws the 5 to make 21.
    const round = stand(startRound([card('9'), card('7'), card('10', 'hearts'), card('6'), card('5')], rules({ antiDealer: 2 })))
    expect(round.dealer.map((c) => c.rank)).toEqual(['10', '6', '5'])
    expect(round.hands[0].outcome).toBe('voided')
  })

  it('pays a voided dealer 21 out as a chips-only win with Payout T3 (T2 + chip T3)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], rules({ antiDealer: 2, chipEco: 3 }))
    expect(round.hands[0].outcome).toBe('win')
    expect(round.hands[0].chipsOnly).toBe(true)
    expect(reward(round)).toEqual({ tokens: 8 }) // floor tier
  })

  it('hijacks a dealer natural into a player blackjack (T3)', () => {
    const round = startRound([card('9'), card('7'), card('A'), card('K', 'hearts')], rules({ antiDealer: 3 }))
    expect(round.hands[0].outcome).toBe('blackjack')
    expect(reward(round)).toEqual({ tokens: 21 }) // a real blackjack — top token tier
  })

  it('turns a natural-vs-natural push into a player win under hijack (T3)', () => {
    const round = startRound([card('A'), card('K'), card('A', 'hearts'), card('K', 'hearts')], rules({ antiDealer: 3 }))
    expect(round.hands[0].outcome).toBe('blackjack')
  })
})

describe('token eco', () => {
  it('scales a win reward by the token multiplier', () => {
    const shoe = [card('K'), card('Q'), card('10', 'hearts'), card('7')] // player 20 beats dealer 17
    expect(reward(stand(startRound(shoe, rules({ tokenEco: 2 }))))).toEqual({ tokens: 9 }) // 8 * 1.18
    expect(reward(stand(startRound(shoe, rules({ tokenEco: 3 }))))).toEqual({ tokens: 10 }) // 8 * 1.30
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
      // The pick threads into the run (Payout T1 → a +50% blackjack point bonus).
      expect(blackjackPointBonusFor(session.snapshot().run.upgrades)).toBe(0.5)
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
