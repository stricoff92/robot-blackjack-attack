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
  /** Sabotage the dealer: +20 energy on any dealer 21 → redeal any dealer 21 → hijack naturals. */
  antiDealer: number
  /** Payout: +50% → +100% points on a natural blackjack → win all pushes. */
  chipEco: number
  /** The economy path: more tokens (×1.10 → ×1.30 on every reward) AND slower token
   *  inflation (accrue ×0.75 → ×0.35 per shift — see inflationResistanceFor). */
  tokenEco: number
}

export const MAX_UPGRADE_TIER = 3

// Payout T1/T2: bonus fraction added to a natural blackjack's points, by chipEco tier (index 0..3).
const BJ_POINT_BONUS = [0, 0.5, 1, 1]

// Token eco multiplier by unlocked tier (index = level 0..3). The tiers replace
// one another rather than stacking, so the top is a flat ×1.30.
const TOKEN_MULTIPLIERS = [1, 1.1, 1.18, 1.3]

// Token eco inflation resistance by unlocked tier (index = level 0..3): the factor
// applied to each shift's token-inflation add (run.ts). Since the Tokens path earns
// more tokens — which would otherwise inflate faster — this resistance both cancels
// that and turns the path into the run's economy/anti-inflation identity. At max the
// player inflates at ~a third rate.
const INFLATION_RESISTANCE = [1, 0.75, 0.55, 0.35]

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

// Payout T1/T2: the bonus fraction added to a natural blackjack's points at the current chipEco tier.
export function blackjackPointBonusFor(upgrades: RunUpgrades): number {
  return BJ_POINT_BONUS[upgrades.chipEco] ?? BJ_POINT_BONUS[BJ_POINT_BONUS.length - 1]
}

// The factor applied to each shift's token-inflation add for the run's Token eco
// tier — 1 (no path) down to 0.35 (maxed), so a maxed Tokens build inflates at ~a
// third the rate. See run.ts's inflationIncrement.
export function inflationResistanceFor(upgrades: RunUpgrades): number {
  return INFLATION_RESISTANCE[upgrades.tokenEco] ?? INFLATION_RESISTANCE[INFLATION_RESISTANCE.length - 1]
}

// Fold the unlocked tiers into the RoundRules for a fresh round.
export function rulesForUpgrades(upgrades: RunUpgrades): RoundRules {
  return {
    ...DEFAULT_ROUND_RULES,
    // Payout T3: genuine pushes (and Sabotage-voided dealer 21s) resolve as a win (a hit + points)
    // instead of redealing. (T1/T2 add points to naturals via blackjackPointBonusFor, applied in
    // run.ts — a scoring effect, not a settlement rule.)
    pushWinsToPlayer: upgrades.chipEco >= 3,
    // Sabotage T1: any dealer 21 (dealt natural OR a hit-to-21) pays a flat energy bonus (credited
    // in Session.settle_, see SABOTAGE_DEALER21_ENERGY). T2: any dealer 21 redeals the hand (voided →
    // Session redeals). T3: hijack the dealer's natural. All three key on the dealer reaching 21.
    dealer21Energy: upgrades.antiDealer >= 1,
    voidDealer21: upgrades.antiDealer >= 2,
    hijackDealerNatural: upgrades.antiDealer >= 3,
    // Token eco.
    tokenMultiplier: tokenMultiplierFor(upgrades),
  }
}

// Choose-upgrade screen: display metadata, one entry per path. `tiers` holds the
// effect text unlocked at each tier (index 0 = tier 1); the screen shows the next
// unlocked tier's text and hides the button once the path is maxed. Colours are
// three distinct NEON hues (each with a matching outer-glow tint) that sit in the
// game's world, kept clear of the gold action buttons and the teal-glass abilities.
export interface UpgradePathInfo {
  path: UpgradePath
  name: string
  color: string
  // Outer-glow tint (rgba) for the choose-upgrade button's neon halo, applied via --upgrade-glow.
  glow: string
  tiers: [string, string, string]
}

export const UPGRADE_PATHS: readonly UpgradePathInfo[] = [
  {
    path: 'antiDealer',
    name: 'Sabotage',
    color: '#ff4d55',
    glow: 'rgba(255, 77, 85, 0.5)',
    tiers: [
      '+20 energy on dealer 21',
      'Redeals hand on dealer 21',
      "Hijack dealer's natural blackjack",
    ],
  },
  {
    path: 'chipEco',
    name: 'Payout',
    color: '#3d9bff',
    glow: 'rgba(61, 155, 255, 0.5)',
    tiers: [
      'Natural blackjack pays +50%',
      'Natural blackjack pays +100%',
      'Win all pushes',
    ],
  },
  {
    path: 'tokenEco',
    name: 'Energy',
    color: '#3fd07a',
    glow: 'rgba(63, 208, 122, 0.5)',
    tiers: [
      '+10% energy, +25% inflation resist',
      '+18% energy, +45% inflation resist',
      '+30% energy, +65% inflation resist',
    ],
  },
]

// The next-tier effect text for a path at its current level, or null if maxed.
export function nextTierLabel(info: UpgradePathInfo, level: number): string | null {
  return level >= MAX_UPGRADE_TIER ? null : info.tiers[level]
}
