export type PowerupId =
  | 'peek'
  | 'late-double'
  | 'forced-split'
  | 'second-chance'
  | 'freeze'
  | 'mulligan'
  | 'analyze'
  | 'return'

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
    cost: 90,
    description: "Reveal the dealer's hole card.",
  },
  'late-double': {
    id: 'late-double',
    name: 'Late double',
    cost: 30,
    description: "Double down after you've already taken hits.",
  },
  'forced-split': {
    id: 'forced-split',
    name: 'Forced split',
    cost: 30,
    description: 'Split your opening two cards even when they are not a matching pair.',
  },
  'second-chance': {
    id: 'second-chance',
    name: 'Bust Block',
    cost: 70,
    description: 'One expendable shield against busting.',
  },
  freeze: {
    id: 'freeze',
    name: 'Freeze Dealer',
    cost: 60,
    description: 'Force the dealer to stand on its current total.',
  },
  mulligan: {
    id: 'mulligan',
    name: 'Mulligan',
    cost: 80,
    description: 'Discard your opening hand and redeal once.',
  },
  analyze: {
    id: 'analyze',
    name: 'Analyze',
    cost: 4,
    description: 'Read your bust-on-hit odds and the dealer-win odds. Folds in any peeked cards. Clears the moment you act.',
  },
  return: {
    id: 'return',
    name: 'Return',
    cost: 50,
    description: 'Push your most recent card back onto the shoe for the dealer to draw, then stand.',
  },
}
