// How much a single won hand is worth — both the integrity damage it deals the
// dealer and the tokens it pays the player. The two move together and scale by
// HOW the win was earned: beating a higher standing dealer total is harder, so it
// hits harder and pays more. A dealer that busts itself is the weakest win of all
// (the player didn't have to outdraw anything), below even beating a 17. Losses
// and pushes are worth nothing.
//
//   dealer bust   <  beat 17  <  beat 18  <  beat 19  <  beat 20
//
// A natural blackjack is its own premium, sitting just under the top of the
// beating-the-dealer ladder. Freeze Dealer forces the win, so it always grades as
// the floor of the standing tiers (17) — you can't pin a fat dealer to farm the
// high tiers.

import { dealerAbandonedStand, dealerSettleTotal, type PlayerHand, type Round } from './round'

export interface HandReward {
  /** Integrity damage dealt to the dealer. */
  damage: number
  /** Reward tokens paid to the player. */
  tokens: number
}

const NO_REWARD: HandReward = { damage: 0, tokens: 0 }
const DEALER_BUST_REWARD: HandReward = { damage: 12, tokens: 4 }
const BLACKJACK_REWARD: HandReward = { damage: 42, tokens: 21 }

// Regular wins, keyed by the dealer's final standing total. The dealer stands on
// 17-21, but a standing 21 can't be beaten (only pushed), so a win means the
// dealer showed 17-20.
const BY_DEALER_TOTAL: Record<number, HandReward> = {
  17: { damage: 22, tokens: 8 },
  18: { damage: 30, tokens: 12 },
  19: { damage: 40, tokens: 16 },
  20: { damage: 52, tokens: 22 },
}
const FROZEN_TIER = 17 // Freeze Dealer wins always grade as the 17 tier.

export function handReward(hand: PlayerHand, round: Round): HandReward {
  const base = baseReward(hand, round)
  // Token eco upgrade: every reward's tokens scale by the run's multiplier. Damage
  // is untouched. Kept here so both the credited total (run.ts) and the flown count
  // (the UI's winTokenFor) read the same scaled value.
  const mult = round.rules.tokenMultiplier
  return mult === 1 ? base : { damage: base.damage, tokens: Math.round(base.tokens * mult) }
}

function baseReward(hand: PlayerHand, round: Round): HandReward {
  if (hand.outcome === 'blackjack') {
    return BLACKJACK_REWARD
  }
  if (hand.outcome !== 'win') {
    return NO_REWARD
  }
  if (round.dealerFrozen) {
    return BY_DEALER_TOTAL[FROZEN_TIER]
  }
  // dealerSettleTotal folds in the Anti-dealer downgrade, so a beaten downgraded
  // dealer grades one tier weaker (matching how it was judged in round.ts).
  const dealerTotal = dealerSettleTotal(round)
  if (dealerTotal > 21) {
    // Don't punish the player for the dealer's aggression: if it busted only because
    // it hit a hand it would have stood on (a soft-17 or smart hit), grade the win as
    // beating that abandoned total — with the downgrade folded in, exactly like a stood
    // dealer. A plain draw from a stiff (<17) has no abandoned stand and pays the weak
    // bust tier as before.
    const abandoned = dealerAbandonedStand(round.dealer)
    if (abandoned < 17) {
      return DEALER_BUST_REWARD
    }
    return BY_DEALER_TOTAL[tierFor(abandoned, round.rules.dealerDowngrade)]
  }
  return BY_DEALER_TOTAL[tierFor(dealerTotal, false)]
}

// The 17-20 reward tier for a dealer total, applying the Anti-dealer downgrade (-1,
// only when active and under 21) and clamping into the band. A standing 21 never
// reaches a win and Freeze is handled separately, but the clamp keeps this total-safe.
function tierFor(dealerTotal: number, downgradeActive: boolean): number {
  const effective = downgradeActive && dealerTotal < 21 ? dealerTotal - 1 : dealerTotal
  return Math.min(20, Math.max(17, effective))
}
