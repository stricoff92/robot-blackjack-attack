import { roundTally, type Round } from './round'

// Hits the dealer takes this round: the weighted count of the player's winning hands — each win
// lands 1 hit, a doubled win 2 (see round.roundTally / run.handWeight). Losses and pushes land none.
export function hitsForRound(round: Round): number {
  return roundTally(round).hits
}
