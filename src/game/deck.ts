import type { Rng } from './random'

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades'
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'

export interface Card {
  suit: Suit
  rank: Rank
}

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades']
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank })
    }
  }
  return deck
}

export function createShoe(deckCount: number): Card[] {
  const shoe: Card[] = []
  for (let count = 0; count < deckCount; count += 1) {
    shoe.push(...createDeck())
  }
  return shoe
}

export function shuffle(cards: Card[], nextRandom: Rng): Card[] {
  const shuffled = cards.slice()
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1))
    const held = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = held
  }
  return shuffled
}
