import { handReward } from './rewards'
import type { Round } from './round'

// Integrity the dealer loses this round: the sum of each won hand's damage, which
// scales with how the win was earned (see rewards.ts — a dealer bust is the
// weakest win, beating a standing 20 the strongest). Losses and pushes deal none.
export function damageForRound(round: Round): number {
  return round.hands.reduce((total, hand) => total + handReward(hand, round).damage, 0)
}
