// Card-odds for the Analyze powerup: given everything the player can see, how
// likely is the active hand to bust on one more card, and how likely is the
// dealer to beat the player's current total?
//
// The player's knowledge is whatever's face-up PLUS any cards a peek has
// revealed — the dealer's hole card (Peek Dealer) and/or the next card in the
// shoe (Peek Deck). Folding those in makes the reading strictly more accurate:
// a known hole is used directly instead of averaged over, and a known next card
// makes the bust outcome (and the dealer's first hit) certain rather than random.
//
// The bust chance is exact (a formula over the unseen deck, or a single lookup
// when the next card is known). The dealer-win chance has no clean closed form
// once the hole and an open-ended draw sequence are unknown, so it's a
// Monte-Carlo estimate — a few thousand dealer play-outs from the same deck.

import { RANKS, type Card, type Rank } from './deck'
import { evaluateHand, evaluateRanks, type HandValue } from './hand'
import type { Rng } from './random'
import { activeHand, type Round, type RoundRules } from './round'

export interface Analysis {
  /** 0..1: the active hand busts if it takes exactly one more card. */
  bustChance: number
  /** 0..1: the dealer finishes above the player's current total (player stands). */
  dealerWinChance: number
}

// Cards the player knows beyond the face-up ones, via peeks. Either may be null.
export interface Knowledge {
  /** The dealer's hole card, revealed by Peek Dealer. */
  hole: Card | null
  /** The next card in the shoe, revealed by Peek Deck. */
  nextCard: Card | null
}

export const NOTHING_KNOWN: Knowledge = { hole: null, nextCard: null }

const DEALER_STANDS_AT = 17
const DEFAULT_TRIALS = 4000

type RankCounts = Record<Rank, number>

// The cards the player can't place: the full shoe minus every card whose identity
// AND position the player knows — the face-up cards (player's own + dealer's
// up-card), any card the Bust Block burned, and any peeked card (the hole and/or
// the next card). Peeked cards are pulled out of this pool because they're no
// longer a random unknown: they get used directly where they belong. What's left
// is exactly the uncertainty the odds are computed over.
function unseenCounts(round: Round, knowledge: Knowledge): { counts: RankCounts; total: number } {
  const counts = {} as RankCounts
  for (const rank of RANKS) {
    counts[rank] = 0
  }
  for (const card of round.shoe) {
    counts[card.rank] += 1
  }
  const remove = (card: Card): void => {
    counts[card.rank] -= 1
  }
  for (const hand of round.hands) {
    hand.cards.forEach(remove)
  }
  remove(round.dealer[0])
  if (round.burned) {
    remove(round.burned)
  }
  for (const card of round.discarded) {
    remove(card) // mulligan-tossed cards are spent + seen, so out of the pool
  }
  if (knowledge.hole) {
    remove(knowledge.hole)
  }
  if (knowledge.nextCard) {
    remove(knowledge.nextCard)
  }
  let total = 0
  for (const rank of RANKS) {
    total += counts[rank]
  }
  return { counts, total }
}

// Probability the active hand busts on its next single card. If the next card is
// known (Peek Deck), the outcome is certain — 1 or 0. Otherwise it's the exact
// share of the unseen deck whose rank pushes the hand over 21.
export function bustChanceOnHit(round: Round, knowledge: Knowledge = NOTHING_KNOWN): number {
  const current = activeHand(round).cards.map((card) => card.rank)
  if (knowledge.nextCard) {
    return evaluateRanks([...current, knowledge.nextCard.rank]).total > 21 ? 1 : 0
  }
  const { counts, total } = unseenCounts(round, knowledge)
  if (total <= 0) {
    return 0
  }
  let bustWeight = 0
  for (const rank of RANKS) {
    if (counts[rank] === 0) {
      continue
    }
    if (evaluateRanks([...current, rank]).total > 21) {
      bustWeight += counts[rank]
    }
  }
  return bustWeight / total
}

// Monte-Carlo probability the dealer beats the player's current total (the player
// is assumed to stand): complete the dealer's hand `trials` times and count how
// often it lands higher than the player without busting. A dealer bust or a tie
// is NOT a dealer win. A known hole card is used as-is; a known next card is dealt
// as the dealer's first hit (since the player stands, that card is the dealer's).
export function dealerWinChance(
  round: Round,
  knowledge: Knowledge,
  rng: Rng,
  trials = DEFAULT_TRIALS,
): number {
  const playerTotal = evaluateHand(activeHand(round).cards).total
  if (playerTotal > 21) {
    return 1 // already busted — shouldn't happen mid-turn, but the dealer wins outright
  }
  const base = unseenCounts(round, knowledge)
  const holeRank = knowledge.hole ? knowledge.hole.rank : null
  const nextRank = knowledge.nextCard ? knowledge.nextCard.rank : null
  if (holeRank === null && base.total <= 0) {
    return 0 // no known hole and nothing left to draw one from
  }
  const upCard = round.dealer[0].rank
  let wins = 0
  for (let trial = 0; trial < trials; trial += 1) {
    if (dealerBeatsPlayer(upCard, holeRank, nextRank, playerTotal, base, round.rules, round.dealerFrozen, rng)) {
      wins += 1
    }
  }
  return wins / trials
}

export function computeAnalysis(
  round: Round,
  knowledge: Knowledge,
  rng: Rng,
  trials = DEFAULT_TRIALS,
): Analysis {
  return {
    bustChance: bustChanceOnHit(round, knowledge),
    dealerWinChance: dealerWinChance(round, knowledge, rng, trials),
  }
}

// One dealer play-out from the up-card: take the hole card (known, or drawn from
// the unseen deck), then hit per the rules (unless Freeze Dealer has pinned the
// dealer to its two cards). A known next card is the first hit; further draws come
// without replacement from a private copy of the unseen deck. Returns whether the
// dealer finishes above the player without busting.
function dealerBeatsPlayer(
  upCard: Rank,
  holeRank: Rank | null,
  nextRank: Rank | null,
  playerTotal: number,
  base: { counts: RankCounts; total: number },
  rules: RoundRules,
  frozen: boolean,
  rng: Rng,
): boolean {
  const counts = { ...base.counts }
  let remaining = base.total
  // The hole: known cards are already excluded from the pool; an unknown hole is
  // drawn from it.
  let hole: Rank
  if (holeRank !== null) {
    hole = holeRank
  } else {
    hole = drawRank(counts, remaining, rng)
    remaining -= 1
  }
  const ranks: Rank[] = [upCard, hole]
  // Anti-dealer T2 (hijack): a dealt dealer natural is stolen as a player win, so
  // the dealer never beats you — mirror round.ts' resolveOpeningNaturals.
  if (rules.hijackDealerNatural && evaluateRanks(ranks).total === 21) {
    return false
  }
  if (!frozen) {
    let usedNext = false
    while (dealerHits(evaluateRanks(ranks), rules, playerTotal)) {
      if (nextRank !== null && !usedNext) {
        ranks.push(nextRank) // known top-of-shoe card, already excluded from the pool
        usedNext = true
        continue
      }
      if (remaining <= 0) {
        break
      }
      ranks.push(drawRank(counts, remaining, rng))
      remaining -= 1
    }
  }
  let dealerTotal = evaluateRanks(ranks).total
  // Anti-dealer T3 (downgrade): the dealer's standing total counts as 1 lower when
  // under 21 — mirror round.ts' dealerSettleTotal.
  if (rules.dealerDowngrade && dealerTotal < 21) {
    dealerTotal -= 1
  }
  return dealerTotal <= 21 && dealerTotal > playerTotal
}

// The dealer's play rule: hit below 17, stand on 21, and follow rules.dealerSoft17 at
// 17-20. Mirrors round.ts' dealerShouldHit exactly (the 'smart' rule's soft-vs-hard
// split, the desperation hard-hit ceiling, and the downgraded settling total), so the
// odds reflect how the dealer really plays. `playerTotal` is the standing player total.
function dealerHits(value: HandValue, rules: RoundRules, playerTotal: number): boolean {
  if (value.total < DEALER_STANDS_AT) {
    return true
  }
  if (value.total >= 21) {
    return false
  }
  if (rules.dealerSoft17 === 'hit') {
    return value.total === DEALER_STANDS_AT && value.soft
  }
  if (rules.dealerSoft17 === 'smart') {
    const effective = rules.dealerDowngrade && value.total < 21 ? value.total - 1 : value.total
    if (value.soft) {
      return value.total === DEALER_STANDS_AT && effective <= playerTotal
    }
    return value.total <= rules.dealerHardHitCeiling && effective < playerTotal
  }
  return false
}

// Pick a rank from the multiset weighted by its remaining count and decrement it
// (sampling without replacement). `total` must equal the current sum of `counts`.
function drawRank(counts: RankCounts, total: number, rng: Rng): Rank {
  let roll = rng() * total
  for (const rank of RANKS) {
    roll -= counts[rank]
    if (roll < 0) {
      counts[rank] -= 1
      return rank
    }
  }
  // Float rounding ran off the end: hand back the last rank still in the deck.
  for (let i = RANKS.length - 1; i >= 0; i -= 1) {
    if (counts[RANKS[i]] > 0) {
      counts[RANKS[i]] -= 1
      return RANKS[i]
    }
  }
  return RANKS[0]
}
