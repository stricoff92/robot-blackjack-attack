export type PowerupId = 'peek' | 'late-double' | 'foresight' | 'second-chance'

export interface Powerup {
  id: PowerupId
  name: string
  cost: number
  description: string
}

export const POWERUPS: Record<PowerupId, Powerup> = {
  peek: {
    id: 'peek',
    name: 'Peek',
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
    name: 'Foresight',
    cost: 150,
    description: 'See the next card in the shoe.',
  },
  'second-chance': {
    id: 'second-chance',
    name: 'Second chance',
    cost: 90,
    description: 'One expendable shield against busting.',
  },
}
