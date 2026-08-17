import type { Card, Rank } from './deck'

export interface HandValue {
  total: number
  soft: boolean
}

const CARD_POINTS: Record<Rank, number> = {
  A: 11,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 10,
  Q: 10,
  K: 10,
}

export function cardValue(card: Card): number {
  return CARD_POINTS[card.rank]
}

export function evaluateHand(cards: Card[]): HandValue {
  let total = 0
  let aces = 0
  for (const card of cards) {
    total += CARD_POINTS[card.rank]
    if (card.rank === 'A') {
      aces += 1
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }
  return { total, soft: aces > 0 }
}

// Evaluate a hand described by ranks alone — used by the odds simulator, which
// deals from a rank multiset and never materializes suited cards. Same ace logic
// as evaluateHand (aces drop from 11 to 1 while the total is over 21).
export function evaluateRanks(ranks: readonly Rank[]): HandValue {
  let total = 0
  let aces = 0
  for (const rank of ranks) {
    total += CARD_POINTS[rank]
    if (rank === 'A') {
      aces += 1
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }
  return { total, soft: aces > 0 }
}

export function isBust(cards: Card[]): boolean {
  return evaluateHand(cards).total > 21
}

export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && evaluateHand(cards).total === 21
}
