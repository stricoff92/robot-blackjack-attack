// Dev-only switches read once from the URL query string. These are gated to the
// Vite dev server (`npm run dev`) — in a production build `import.meta.env.DEV`
// is false, so they are compiled out to a no-op and can never be triggered on
// the deployed game. Append to the dev URL:
//
//   ?forcePairs        — every deal gives the player a splittable pair
//   ?forcePairs=8      — ...specifically a pair of that rank (2-10, J, Q, K, A)
//   ?tokens=200        — start the run with this many tokens (test powerups without grinding)
//   ?chips=5000        — start the run with this many chips (test the wealth-floor bet)
//   ?dealerHealth=50   — start the first dealer at this % health (1-100), e.g. to see the
//                        low-health eye flicker without playing a dealer down
//   ?dealer=6          — start the run at this dealer (1..TOTAL_DEALERS), to jump straight
//                        to a dealer's colour: 1 blue, 2 purple, 3 green, 4 yellow, 5 red,
//                        6 the RGB-cycling final dealer
//   ?sabotageUpgrade=3 — start with the Sabotage (anti-dealer) path unlocked through this tier (0-3)
//   ?chipUpgrade=2     — start with the Payout (chip) path unlocked through this tier (0-3)
//   ?tokenUpgrades=1   — start with the Tokens path unlocked through this tier (0-3)
//   ?dealerBlackjack   — the dealer draws a natural 21 every hand (test refund/void/hijack/push)
//   ?playerBlackjack   — the player is dealt a natural 21 every hand (test the blackjack payout)
//
// See docs/dev-params.md for the full reference (values, effects, examples). Handy
// for exercising split without waiting for a pair, buying a pricey powerup off the
// first deal, testing any upgrade combo without grinding to kills, or forcing the
// dealer-blackjack outcomes (loss/refund/void/hijack/push) on demand.

import { RANKS, type Rank } from './deck'
import { TOTAL_DEALERS } from './run'
import { MAX_UPGRADE_TIER } from './upgrades'

export interface DebugFlags {
  /** Force the player's opening two cards to be a pair. */
  forcePairs: boolean
  /** When forcing pairs, a specific rank to pair; null = pair whatever's dealt. */
  forcePairRank: Rank | null
  /** Start the run with this many tokens; null = the normal starting balance (0). */
  startTokens: number | null
  /** Start the run with this many chips; null = the normal starting balance (400). */
  startChips: number | null
  /** Start the first dealer at this % health (1-100); null = full. */
  dealerHealth: number | null
  /** Start the run at this dealer (1..TOTAL_DEALERS); null = the first dealer. */
  startDealer: number | null
  /** Start with the Sabotage (anti-dealer) path unlocked through this tier (0-3); null = none. */
  sabotageUpgrade: number | null
  /** Start with the Payout (chip) path unlocked through this tier (0-3); null = none. */
  chipUpgrade: number | null
  /** Start with the Tokens path unlocked through this tier (0-3); null = none. */
  tokenUpgrades: number | null
  /** Force the dealer's opening two cards to be a natural 21 on every deal. */
  dealerBlackjack: boolean
  /** Force the player's opening two cards to be a natural 21 on every deal. */
  playerBlackjack: boolean
}

const OFF: DebugFlags = {
  forcePairs: false,
  forcePairRank: null,
  startTokens: null,
  startChips: null,
  dealerHealth: null,
  startDealer: null,
  sabotageUpgrade: null,
  chipUpgrade: null,
  tokenUpgrades: null,
  dealerBlackjack: false,
  playerBlackjack: false,
}

export function readDebugFlags(): DebugFlags {
  // Never honor debug flags outside the dev server (deployed prod build, tests).
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return OFF
  }
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('forcePairs') // '' for a bare ?forcePairs, else the value
  const forcePairRank = raw && (RANKS as readonly string[]).includes(raw) ? (raw as Rank) : null
  return {
    forcePairs: params.has('forcePairs'),
    forcePairRank,
    startTokens: parseStartTokens(params.get('tokens')),
    startChips: parseStartChips(params.get('chips')),
    dealerHealth: parseDealerHealth(params.get('dealerHealth')),
    startDealer: parseStartDealer(params.get('dealer')),
    sabotageUpgrade: parseUpgradeTier(params.get('sabotageUpgrade')),
    chipUpgrade: parseUpgradeTier(params.get('chipUpgrade')),
    tokenUpgrades: parseUpgradeTier(params.get('tokenUpgrades')),
    dealerBlackjack: params.has('dealerBlackjack'),
    playerBlackjack: params.has('playerBlackjack'),
  }
}

// A non-negative integer token count, or null if the param is absent/empty/invalid.
function parseStartTokens(raw: string | null): number | null {
  if (!raw) {
    return null
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

// A positive integer chip count (>= 1, since 0 chips ends the run), or null if the
// param is absent/empty/invalid.
function parseStartChips(raw: string | null): number | null {
  if (!raw) {
    return null
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

// A health percentage clamped to 1..100, or null if absent/empty/invalid. Clamped
// so the opening dealer never starts already-dead (0) or over-full (>100).
function parseDealerHealth(raw: string | null): number | null {
  if (!raw) {
    return null
  }
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.floor(n))) : null
}

// A dealer index clamped to 1..TOTAL_DEALERS, or null if absent/empty/invalid — so
// the run always starts on a real dealer within the roster.
function parseStartDealer(raw: string | null): number | null {
  if (!raw) {
    return null
  }
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(TOTAL_DEALERS, Math.max(1, Math.floor(n))) : null
}

// An upgrade tier clamped to 0..MAX_UPGRADE_TIER, or null if absent/empty/invalid.
// Tier N means the path is unlocked through tier N (tiers stack in order), so 3 is
// fully maxed and 0 is the same as leaving it off.
function parseUpgradeTier(raw: string | null): number | null {
  if (!raw) {
    return null
  }
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(MAX_UPGRADE_TIER, Math.max(0, Math.floor(n))) : null
}
