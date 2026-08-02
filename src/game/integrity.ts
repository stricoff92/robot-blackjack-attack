import { evaluateHand } from './hand'
import type { Round } from './round'

export const WIN_DAMAGE = 8
export const NATURAL_DAMAGE = 12
export const DEALER_BUST_DAMAGE = 25

export function damageForRound(round: Round): number {
  const anyLive = round.hands.some((hand) => !hand.busted)
  if (!anyLive) {
    return 0
  }
  let damage = 0
  for (const hand of round.hands) {
    if (hand.outcome === 'win' || hand.outcome === 'blackjack') {
      damage += WIN_DAMAGE
    }
    if (hand.outcome === 'blackjack') {
      damage += NATURAL_DAMAGE
    }
  }
  if (evaluateHand(round.dealer).total > 21) {
    damage += DEALER_BUST_DAMAGE
  }
  return damage
}
