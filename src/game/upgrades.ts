// Roguelite upgrades: after destroying a dealer, the player permanently unlocks
// one tier of one of three paths (in order — tier 1, then 2, then 3). The choices
// only ever help the player; there is no cost. A run offers a pick after each of
// the first five kills (the sixth kill wins), so a single path can be maxed but
// not all three — every pick is a real trade-off.
//
// This module is the single source of truth: it maps the unlocked tiers into the
// per-round RoundRules the resolution/reward code reads (round.ts, rewards.ts,
// odds.ts), and carries the button text/colours the choose-upgrade screen shows.

import { DEFAULT_ROUND_RULES, type RoundRules } from './round'

export type UpgradePath = 'antiDealer' | 'chipEco' | 'tokenEco'

export interface RunUpgrades {
  /** Sabotage the dealer: refund → hijack naturals → downgrade the dealer's total. */
  antiDealer: number
  /** Bigger chip payouts: 3:1 blackjacks → 21 as blackjack → 20 as blackjack. */
  chipEco: number
  /** More tokens: ×1.05 → ×1.10 → ×1.20 on every reward. */
  tokenEco: number
}

export const MAX_UPGRADE_TIER = 3

// Anti-dealer T1: fraction of the bet handed back on a loss to a dealer natural.
const DEALER_NATURAL_REFUND = 0.6

// Token eco multiplier by unlocked tier (index = level 0..3). The tiers replace
// one another rather than stacking, so the top is a flat ×1.20.
const TOKEN_MULTIPLIERS = [1, 1.05, 1.1, 1.2]

export function emptyUpgrades(): RunUpgrades {
  return { antiDealer: 0, chipEco: 0, tokenEco: 0 }
}

// Unlock the next tier of a path (no-op if already maxed).
export function bumpUpgrade(upgrades: RunUpgrades, path: UpgradePath): RunUpgrades {
  if (upgrades[path] >= MAX_UPGRADE_TIER) {
    return upgrades
  }
  return { ...upgrades, [path]: upgrades[path] + 1 }
}

// Whether any path still has a tier left to unlock — false only in the (unreachable
// within a normal run) case that every path is maxed.
export function hasAvailableUpgrade(upgrades: RunUpgrades): boolean {
  return (
    upgrades.antiDealer < MAX_UPGRADE_TIER ||
    upgrades.chipEco < MAX_UPGRADE_TIER ||
    upgrades.tokenEco < MAX_UPGRADE_TIER
  )
}

export function tokenMultiplierFor(upgrades: RunUpgrades): number {
  return TOKEN_MULTIPLIERS[upgrades.tokenEco] ?? 1
}

// Fold the unlocked tiers into the RoundRules for a fresh round.
export function rulesForUpgrades(upgrades: RunUpgrades): RoundRules {
  return {
    ...DEFAULT_ROUND_RULES,
    // Chip eco T1: 3:1 instead of 3:2 on any blackjack.
    blackjackPayoutNumerator: upgrades.chipEco >= 1 ? 3 : DEFAULT_ROUND_RULES.blackjackPayoutNumerator,
    blackjackPayoutDenominator: upgrades.chipEco >= 1 ? 1 : DEFAULT_ROUND_RULES.blackjackPayoutDenominator,
    // Chip eco T2/T3: the player's 21 (then 20) instantly resolves as a natural.
    autoBlackjackAt: upgrades.chipEco >= 3 ? 20 : upgrades.chipEco >= 2 ? 21 : null,
    // Anti-dealer T1/T2/T3.
    dealerNaturalRefundRatio: upgrades.antiDealer >= 1 ? DEALER_NATURAL_REFUND : 0,
    hijackDealerNatural: upgrades.antiDealer >= 2,
    dealerDowngrade: upgrades.antiDealer >= 3,
    // Token eco.
    tokenMultiplier: tokenMultiplierFor(upgrades),
  }
}

// Choose-upgrade screen: display metadata, one entry per path. `tiers` holds the
// effect text unlocked at each tier (index 0 = tier 1); the screen shows the next
// unlocked tier's text and hides the button once the path is maxed. Colours are
// three distinct hues, kept clear of the gold action / steel powerup buttons.
export interface UpgradePathInfo {
  path: UpgradePath
  name: string
  color: string
  tiers: [string, string, string]
}

export const UPGRADE_PATHS: readonly UpgradePathInfo[] = [
  {
    path: 'antiDealer',
    name: 'Sabotage',
    color: '#d8484b',
    tiers: [
      '60% refund on dealer natural blackjack',
      "Hijack dealer's natural blackjack",
      "-1 to dealer score (excluding 21)",
    ],
  },
  {
    path: 'chipEco',
    name: 'Payout',
    color: '#4a86d8',
    tiers: [
      'Natural blackjack pays 3:1',
      'player 21s upgrade to natural blackjack',
      'Player 20s upgrade to natural blackjack',
    ],
  },
  {
    path: 'tokenEco',
    name: 'Tokens',
    color: '#49b26a',
    tiers: [
      '+5% tokens',
      '+10% tokens',
      '+20% tokens',
    ],
  },
]

// The next-tier effect text for a path at its current level, or null if maxed.
export function nextTierLabel(info: UpgradePathInfo, level: number): string | null {
  return level >= MAX_UPGRADE_TIER ? null : info.tiers[level]
}
