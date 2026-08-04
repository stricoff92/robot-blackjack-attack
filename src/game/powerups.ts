export type PowerupId = 'peek' | 'late-double' | 'foresight' | 'second-chance' | 'freeze' | 'mulligan' | 'analyze'

export interface Powerup {
  id: PowerupId
  name: string
  cost: number
  description: string
}

export const POWERUPS: Record<PowerupId, Powerup> = {
  peek: {
    id: 'peek',
    name: 'Peek Dealer',
    cost: 10,
    description: "Reveal the dealer's hole card.",
  },
  'late-double': {
    id: 'late-double',
    name: 'Late double',
    cost: 30,
    description: "Double down after you've already taken hits.",
  },
  foresight: {
    id: 'foresight',
    name: 'Peek Deck',
    cost: 150,
    description: 'See the next card in the shoe.',
  },
  'second-chance': {
    id: 'second-chance',
    name: 'Bust Block',
    cost: 90,
    description: 'One expendable shield against busting.',
  },
  freeze: {
    id: 'freeze',
    name: 'Freeze Dealer',
    cost: 70,
    description: 'Force the dealer to stand on its current total.',
  },
  mulligan: {
    id: 'mulligan',
    name: 'Mulligan',
    cost: 100,
    description: 'Discard your opening hand and redeal once.',
  },
  analyze: {
    id: 'analyze',
    name: 'Analyze',
    cost: 4,
    description: 'Read your bust-on-hit odds and the dealer-win odds. Folds in any peeked cards. Clears the moment you act.',
  },
}
