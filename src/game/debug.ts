// Dev-only switches read once from the URL query string. These are gated to the
// Vite dev server (`npm run dev`) — in a production build `import.meta.env.DEV`
// is false, so they are compiled out to a no-op and can never be triggered on
// the deployed game. Append to the dev URL:
//
//   ?forcePairs      — every deal gives the player a splittable pair
//   ?forcePairs=8    — ...specifically a pair of that rank (2-10, J, Q, K, A)
//
// Handy for exercising split (and re-split) without waiting for a natural pair.

import { RANKS, type Rank } from './deck'

export interface DebugFlags {
  /** Force the player's opening two cards to be a pair. */
  forcePairs: boolean
  /** When forcing pairs, a specific rank to pair; null = pair whatever's dealt. */
  forcePairRank: Rank | null
}

const OFF: DebugFlags = { forcePairs: false, forcePairRank: null }

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
  }
}
