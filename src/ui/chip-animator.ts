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
const COLLECT_MS = 520 // bet (+ winnings) fly into the player's bankroll
const HAND_STAGGER = 90 // offset between hands settling, so splits cascade

export class ChipAnimation implements ChipView {
  private placeStart: number | null = null
  private resolveStart: number | null = null
  private clearStart: number | null = null
  private outcomes: (HandOutcome | null)[] = []
  private end = 0

  get animEnd(): number {
    return this.end
  }

  isAnimating(now: number): boolean {
    return now < this.end
  }

  // Deal: the new hand's bet chips fly out of the bankroll. Clears prior state.
  placeBets(_round: Round, now: number): void {
    this.placeStart = now
    this.resolveStart = null
    this.clearStart = null
    this.outcomes = []
    this.end = now + PLACE_MS
  }

  // Resolution: winnings fly in from the dealer for winning hands, starting once
  // the card sequence has settled. Nothing else moves — everything then rests.
  resolve(round: Round, startAfter: number): void {
    this.resolveStart = startAfter
    this.clearStart = null
    this.outcomes = round.hands.map((hand) => hand.outcome)
    let maxDur = 0
    round.hands.forEach((hand, i) => {
      if (isWin(hand.outcome)) {
        maxDur = Math.max(maxDur, i * HAND_STAGGER + FLY_MS)
      }
    })
    this.end = Math.max(this.end, startAfter + maxDur)
  }

  // Next hand: settle the table. Winners' bet + winnings fly into the bankroll;
  // losers' bets fly to the dealer.
  clear(round: Round, startAfter: number): void {
    this.clearStart = startAfter
    this.outcomes = round.hands.map((hand) => hand.outcome)
    let maxDur = 0
    round.hands.forEach((hand, i) => {
      maxDur = Math.max(maxDur, i * HAND_STAGGER + clearDuration(hand.outcome))
    })
    this.end = Math.max(this.end, startAfter + maxDur)
  }

  betChip(handIndex: number, now: number): BetChipState {
    const outcome = this.outcomes[handIndex] ?? null

    if (this.clearStart !== null) {
      const elapsed = now - (this.clearStart + handIndex * HAND_STAGGER)
      if (elapsed >= 0) {
        return clearPhase(outcome, elapsed)
      }
      return restingState(outcome) // waiting its turn: hold the resolved rest
    }

    if (this.resolveStart !== null) {
      if (isWin(outcome)) {
        const elapsed = now - (this.resolveStart + handIndex * HAND_STAGGER)
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

    if (this.placeStart !== null) {
      const elapsed = now - this.placeStart
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

function clearPhase(outcome: HandOutcome | null, elapsed: number): BetChipState {
  if (outcome === 'lose' || outcome === 'bust') {
    if (elapsed < FLY_MS) {
      return { phase: 'toDealer', progress: elapsed / FLY_MS, outcome }
    }
    return { phase: 'done', progress: 1, outcome }
  }
  // win / blackjack / push: bet (+ winnings) fly into the player's bankroll
  if (elapsed < COLLECT_MS) {
    return { phase: 'collect', progress: elapsed / COLLECT_MS, outcome }
  }
  return { phase: 'done', progress: 1, outcome }
}

function clearDuration(outcome: HandOutcome | null): number {
  return outcome === 'lose' || outcome === 'bust' ? FLY_MS : COLLECT_MS
}

function isWin(outcome: HandOutcome | null): boolean {
  return outcome === 'win' || outcome === 'blackjack'
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
