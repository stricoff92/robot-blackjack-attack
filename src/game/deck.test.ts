import { describe, expect, it } from 'vitest'

import { createDeck, createShoe, shuffle } from './deck'
import { createRng } from './random'

describe('createDeck', () => {
  it('builds a standard 52-card deck', () => {
    expect(createDeck()).toHaveLength(52)
  })

  it('contains no duplicate cards', () => {
    const unique = new Set(createDeck().map((card) => `${card.rank}-${card.suit}`))

    expect(unique.size).toBe(52)
  })
})

describe('createShoe', () => {
  it('stacks the requested number of decks', () => {
    expect(createShoe(6)).toHaveLength(312)
  })
})

describe('shuffle', () => {
  it('is deterministic for a given seed', () => {
    const first = shuffle(createShoe(1), createRng(7))
    const second = shuffle(createShoe(1), createRng(7))

    expect(first).toEqual(second)
  })

  it('preserves every card', () => {
    const shuffled = shuffle(createDeck(), createRng(7))

    const unique = new Set(shuffled.map((card) => `${card.rank}-${card.suit}`))
    expect(unique.size).toBe(52)
  })

  it('reorders the cards', () => {
    const original = createDeck()

    expect(shuffle(original, createRng(7))).not.toEqual(original)
  })
})
