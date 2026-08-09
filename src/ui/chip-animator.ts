// Timing for the chip stacks — the money-half of the deal sequence.
//
// The payout is split across two beats so chips settle only when the player
// moves on:
//   • the deal places the hand's bet(s), which fly out of the bankroll;
//   • the round resolving flies the WINNINGS in from the dealer for winning
//     hands (loss/push chips just stay put); and
//   • calling the next hand settles the table — winners' bet + winnings fly into
//     the bankroll, losers' bets fly to the dealer.
//
// Mirrors DealAnimation: this class owns timings, chips.ts owns geometry.

import type { HandOutcome, Round } from '../game/round'
import type { BetChipState, ChipView } from '../render/chips'

const PLACE_MS = 380 // bet flies from the player's stack to the bet spot on the deal
const FLY_MS = 420 // winnings dealer → beside the bet (win), or bet → dealer (loss)
const COLLECT_MS = 442 // bet (+ winnings) fly into the player's bankroll
const HAND_STAGGER = 90 // offset between hands settling, so splits cascade

export class ChipAnimation implements ChipView {
  private placeStart_: number | null = null
  private resolveStart_: number | null = null
  private clearStart_: number | null = null
  private outcomes_: (HandOutcome | null)[] = []
  // Per hand: a loss the Anti-dealer refund partly hands back — after the bet flies
  // to the dealer, a refund stack slides back to the bankroll (see clearPhase).
  private refunded_: boolean[] = []
  private end_ = 0

  get animEnd(): number {
    return this.end_
  }

  isAnimating(now: number): boolean {
    return now < this.end_
  }

  // Deal: the new hand's bet chips fly out of the bankroll. Clears prior state.
  placeBets(_round: Round, now: number): void {
    this.placeStart_ = now
    this.resolveStart_ = null
    this.clearStart_ = null
    this.outcomes_ = []
    this.refunded_ = []
    this.end_ = now + PLACE_MS
  }

  // Resolution: winnings fly in from the dealer for winning hands, starting once
  // the card sequence has settled. Nothing else moves — everything then rests.
  resolve(round: Round, startAfter: number): void {
    this.resolveStart_ = startAfter
    this.clearStart_ = null
    this.outcomes_ = round.hands.map((hand) => hand.outcome)
    let maxDur = 0
    round.hands.forEach((hand, i) => {
      if (isWin(hand.outcome)) {
        maxDur = Math.max(maxDur, i * HAND_STAGGER + FLY_MS)
      }
    })
    this.end_ = Math.max(this.end_, startAfter + maxDur)
  }

  // Next hand: settle the table. Winners' bet + winnings fly into the bankroll;
  // losers' bets fly to the dealer.
  clear(round: Round, startAfter: number): void {
    this.clearStart_ = startAfter
    this.outcomes_ = round.hands.map((hand) => hand.outcome)
    this.refunded_ = round.hands.map((hand) => isRefundedLoss(hand, round))
    let maxDur = 0
    round.hands.forEach((hand, i) => {
      maxDur = Math.max(maxDur, i * HAND_STAGGER + clearDuration(hand.outcome, this.refunded_[i]))
    })
    this.end_ = Math.max(this.end_, startAfter + maxDur)
  }

  betChip(handIndex: number, now: number): BetChipState {
    const outcome = this.outcomes_[handIndex] ?? null

    if (this.clearStart_ !== null) {
      const elapsed = now - (this.clearStart_ + handIndex * HAND_STAGGER)
      if (elapsed >= 0) {
        return clearPhase(outcome, this.refunded_[handIndex] ?? false, elapsed)
      }
      return restingState(outcome) // waiting its turn: hold the resolved rest
    }

    if (this.resolveStart_ !== null) {
      if (isWin(outcome)) {
        const elapsed = now - (this.resolveStart_ + handIndex * HAND_STAGGER)
        if (elapsed < 0) {
          return { phase: 'idle', progress: 1, outcome } // bet resting, winnings not in yet
        }
        if (elapsed < FLY_MS) {
          return { phase: 'winIn', progress: elapsed / FLY_MS, outcome }
        }
        return { phase: 'restWin', progress: 1, outcome }
      }
      return { phase: 'idle', progress: 1, outcome } // loss / push: bet resting
    }

    if (this.placeStart_ !== null) {
      const elapsed = now - this.placeStart_
      if (elapsed < PLACE_MS) {
        return { phase: 'placing', progress: clamp01(elapsed / PLACE_MS), outcome: null }
      }
    }
    return { phase: 'idle', progress: 1, outcome: null }
  }
}

function restingState(outcome: HandOutcome | null): BetChipState {
  return isWin(outcome)
    ? { phase: 'restWin', progress: 1, outcome }
    : { phase: 'idle', progress: 1, outcome }
}

function clearPhase(outcome: HandOutcome | null, refunded: boolean, elapsed: number): BetChipState {
  if (outcome === 'lose' || outcome === 'bust') {
    if (elapsed < FLY_MS) {
      return { phase: 'toDealer', progress: elapsed / FLY_MS, outcome }
    }
    // Anti-dealer refund: after the bet reaches the dealer, part of it slides back
    // to the player's bankroll.
    if (refunded && elapsed < FLY_MS + COLLECT_MS) {
      return { phase: 'refundBack', progress: (elapsed - FLY_MS) / COLLECT_MS, outcome }
    }
    return { phase: 'done', progress: 1, outcome }
  }
  // win / blackjack / push: bet (+ winnings) fly into the player's bankroll
  if (elapsed < COLLECT_MS) {
    return { phase: 'collect', progress: elapsed / COLLECT_MS, outcome }
  }
  return { phase: 'done', progress: 1, outcome }
}

function clearDuration(outcome: HandOutcome | null, refunded: boolean): number {
  if (outcome === 'lose' || outcome === 'bust') {
    return refunded ? FLY_MS + COLLECT_MS : FLY_MS
  }
  return COLLECT_MS
}

// A loss the Anti-dealer T1 refund partly returns: a dealer-natural loss while the
// refund rule is active. Only these get the second (refund-back) chip beat.
function isRefundedLoss(hand: { outcome: HandOutcome | null; lostToDealerNatural?: boolean }, round: Round): boolean {
  return hand.outcome === 'lose' && !!hand.lostToDealerNatural && round.rules.dealerNaturalRefundRatio > 0
}

function isWin(outcome: HandOutcome | null): boolean {
  return outcome === 'win' || outcome === 'blackjack'
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
