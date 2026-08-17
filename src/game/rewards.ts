// How many TOKENS a single won hand pays. Scales by HOW the win was earned: beating a higher
// standing dealer total is harder, so it pays more. A dealer that busts itself is the weakest win
// of all, below even beating a 17. A natural blackjack is its own premium. Freeze Dealer and
// push-converted wins (Payout T3) grade at the floor tier (17). Losses and pushes pay nothing.
//
//   dealer bust  <  beat 17  <  beat 18  <  beat 19  <  beat 20
//
// (Hits landed on the dealer are counted separately in run.ts / round.roundTally — every win lands
// 1 hit ×weight regardless of this token tier.)

import { dealerAbandonedStand, dealerSettleTotal, type PlayerHand, type Round } from './round'

export interface HandReward {
  /** Reward tokens paid to the player. */
  tokens: number
}

const NO_REWARD: HandReward = { tokens: 0 }
const DEALER_BUST_REWARD: HandReward = { tokens: 4 }
const BLACKJACK_REWARD: HandReward = { tokens: 21 }

// Regular wins, keyed by the dealer's final standing total (17-20; a standing 21 can't be beaten).
const BY_DEALER_TOTAL: Record<number, HandReward> = {
  17: { tokens: 8 },
  18: { tokens: 12 },
  19: { tokens: 16 },
  20: { tokens: 22 },
}
const FROZEN_TIER = 17 // Freeze Dealer / push-converted wins grade as the 17 tier.

export function handReward(hand: PlayerHand, round: Round): HandReward {
  const base = baseReward(hand, round)
  // Token eco upgrade: every reward's tokens scale by the run's multiplier.
  const mult = round.rules.tokenMultiplier
  return mult === 1 ? base : { tokens: Math.round(base.tokens * mult) }
}

function baseReward(hand: PlayerHand, round: Round): HandReward {
  // A push or Sabotage-voided dealer 21 converted to a win by Payout T3: it scores + lands a hit
  // like any win, but there was no dealer total to beat, so grade its tokens at the floor tier.
  if (hand.chipsOnly) {
    return BY_DEALER_TOTAL[FROZEN_TIER]
  }
  if (hand.outcome === 'blackjack') {
    return BLACKJACK_REWARD
  }
  if (hand.outcome !== 'win') {
    return NO_REWARD
  }
  if (round.dealerFrozen) {
    return BY_DEALER_TOTAL[FROZEN_TIER]
  }
  const dealerTotal = dealerSettleTotal(round)
  if (dealerTotal > 21) {
    // Don't punish the player for the dealer's aggression: if it busted only because it hit a hand it
    // would have stood on, grade the win as beating that abandoned total, like a stood dealer.
    const abandoned = dealerAbandonedStand(round.dealer)
    if (abandoned < 17) {
      return DEALER_BUST_REWARD
    }
    return BY_DEALER_TOTAL[tierFor(abandoned)]
  }
  return BY_DEALER_TOTAL[tierFor(dealerTotal)]
}

// The 17-20 reward tier for a dealer total, clamped into the band.
function tierFor(dealerTotal: number): number {
  return Math.min(20, Math.max(17, dealerTotal))
}
