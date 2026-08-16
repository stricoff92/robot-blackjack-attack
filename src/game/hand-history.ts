// The `?handhistory=11001` dev param: seed the initial run with a synthetic win/loss history for the
// dealer it opens on, so you can jump straight to "mid-fight on dealer N, hand M" with a score, a
// damaged dealer, and spent hearts — without grinding the hands. A '1' is a win, a '0' a loss; one
// char per prior hand. The history is REPLAYED through the real applyRound reducer (not shallow-set),
// so score, dealer HP, hearts, energy, inflation, and the round counter come out exactly as actually
// playing those hands would produce them — no bespoke bookkeeping to drift out of sync.
//
// Parsing (parseHandHistory) validates the string; replay (replayHandHistory) validates it against
// the dealer and rejects any history that wouldn't leave you cleanly mid-fight on that dealer (a
// kill would advance you off it, a heart-death or a full window would end the dealer). See
// docs/dev-params.md. Only ever reached under the dev server (readDebugFlags is DEV-gated).

import type { Card } from './deck'
import { DEFAULT_ROUND_RULES, type HandOutcome, type PlayerHand, type Round } from './round'
import { applyRound, getShift, type RunState } from './run'

function warn(message: string): void {
  if (import.meta.env.DEV) {
    console.warn(`[handhistory] ${message}`)
  }
}

// Parse a '1'(win)/'0'(loss) string into a boolean[] (true = win), one entry per prior hand. Returns
// null — the param is ignored — if it's empty or contains any character other than 0/1. No clamping:
// a malformed history is a typo to reject, not a value to coerce. Length-vs-dealer and still-mid-fight
// validation happen later in replayHandHistory (they need the run/dealer).
export function parseHandHistory(raw: string | null): boolean[] | null {
  if (!raw) {
    return null
  }
  if (!/^[01]+$/.test(raw)) {
    warn(`"${raw}" must contain only 1s (win) and 0s (loss) — ignoring it`)
    return null
  }
  return [...raw].map((ch) => ch === '1')
}

function card(rank: Card['rank'], suit: Card['suit'] = 'spades'): Card {
  return { rank, suit }
}

// A resolved single-hand round with the given outcome. The dealer stands on 17, so a win grades as
// beat-17 (a deterministic mid-tier energy payout) and the score is purely the cumulative win curve —
// both independent of card content. Mirrors the synthetic round the economy tests feed applyRound.
function syntheticRound(outcome: HandOutcome): Round {
  const hand: PlayerHand = {
    cards: [card('10'), card('7')],
    bet: 1,
    doubled: false,
    splitAce: false,
    finished: true,
    busted: outcome === 'bust',
    outcome,
  }
  return {
    shoe: [],
    drawIndex: 0,
    hands: [hand],
    activeIndex: 0,
    dealer: [card('10'), card('7')],
    rules: DEFAULT_ROUND_RULES,
    status: 'resolved',
    secondChanceArmed: false,
    burned: null,
    dealerFrozen: false,
    mulliganed: false,
    discarded: [],
  }
}

// Replay a win/loss history into `run` via applyRound, returning the seeded run — or null (history
// ignored) if it's invalid. Strict: the history must be non-empty, no longer than the dealer's window
// (maxHands), and the replay must leave the run STILL on the same dealer, alive, and out of the coda —
// otherwise it describes a state you couldn't actually be sitting in on this dealer (a kill advances
// you off it; too many losses drop into the coda; a full window walks the dealer off).
export function replayHandHistory(run: RunState, history: readonly boolean[]): RunState | null {
  const dealer = run.shiftIndex
  const maxHands = getShift(dealer).maxHands
  if (history.length === 0) {
    warn('history is empty — ignoring it')
    return null
  }
  if (history.length > maxHands) {
    warn(`history has ${history.length} hands but dealer ${dealer} allows at most ${maxHands} — ignoring it`)
    return null
  }

  let replayed = run
  for (const won of history) {
    replayed = applyRound(replayed, syntheticRound(won ? 'win' : 'lose'))
  }

  if (replayed.shiftIndex !== dealer || replayed.coda || replayed.over || replayed.hitPoints <= 0) {
    warn(
      `history would not leave you mid-fight on dealer ${dealer} ` +
        `(ended on dealer ${replayed.shiftIndex}, ${replayed.hitPoints} heart${replayed.hitPoints === 1 ? '' : 's'}` +
        `${replayed.coda ? ', coda' : ''}${replayed.over ? ', over' : ''}) — ignoring it`,
    )
    return null
  }
  return replayed
}
