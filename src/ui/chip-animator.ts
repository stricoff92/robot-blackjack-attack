// Timing for the hand-settle beat — the "money half" of the deal/resolve sequence that
// used to slide chip stacks around. The chips themselves are gone (removed with the whole
// bankroll economy); this survives as the pure CLOCK the rest of the view still paces off
// — the laser, the token release, and the coda ceremonies all key their start off `animEnd`.
// The durations are kept byte-for-byte on the old chip beats so that choreography timing is
// unchanged. Nothing here is drawn.
//
//   • the deal "places the bet" — a short settle beat before the cards come to rest;
//   • resolving flies winnings in for winning hands, staggered so split hands cascade;
//   • the next hand settles the table.
//
// Mirrors DealAnimation: this class owns the timings.

import type { HandOutcome, Round } from '../game/round'

const PLACE_MS = 380 // deal beat before the hand settles
const FLY_MS = 420 // winnings settle in on a win (per hand)
const COLLECT_MS = 442 // the table clears on the next hand
const HAND_STAGGER = 90 // offset between hands settling, so splits cascade

// A pure timing clock (formerly the chip-stack animator): tracks when the current settle beat
// ends, so the post-hand choreography can pace off `animEnd`.
export class ChipAnimation {
  private end_ = 0

  get animEnd(): number {
    return this.end_
  }

  isAnimating(now: number): boolean {
    return now < this.end_
  }

  // Deal: a short place beat. Resets the clock.
  placeBets(_round: Round, now: number): void {
    this.end_ = now + PLACE_MS
  }

  // Resolution: winnings settle in for winning hands, starting once the cards have settled.
  resolve(round: Round, startAfter: number): void {
    let maxDur = 0
    round.hands.forEach((hand, i) => {
      if (isWin(hand.outcome)) {
        maxDur = Math.max(maxDur, i * HAND_STAGGER + FLY_MS)
      }
    })
    this.end_ = Math.max(this.end_, startAfter + maxDur)
  }

  // Next hand: settle the table (winners collect, losers clear).
  clear(round: Round, startAfter: number): void {
    let maxDur = 0
    round.hands.forEach((hand, i) => {
      maxDur = Math.max(maxDur, i * HAND_STAGGER + clearDuration(hand.outcome))
    })
    this.end_ = Math.max(this.end_, startAfter + maxDur)
  }
}

function clearDuration(outcome: HandOutcome | null): number {
  return outcome === 'lose' || outcome === 'bust' ? FLY_MS : COLLECT_MS
}

function isWin(outcome: HandOutcome | null): boolean {
  return outcome === 'win' || outcome === 'blackjack'
}
