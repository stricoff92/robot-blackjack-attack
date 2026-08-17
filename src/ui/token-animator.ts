// Timing for the reward tokens that fly up to the counter.
//
// Generic on purpose: `emit(from, amount, startAfter)` knows nothing about WHY
// the tokens were earned, so the same flight serves hits (+1 from the fresh
// card), wins (+10 from the hand), blackjacks (+21) and the dealer kill burst
// (+40 from the dealer).
//
// Mirrors DealAnimation / ChipAnimation: this owns timing,
// render/tokens.ts owns geometry. Each flight captures its source POINT at emit
// time (rather than a card identity), so overlapping bursts — rapid hits, a
// split's two winning hands — never interfere, and the round can move on
// underneath a token that's still in the air.

import type { Point, TokenBurst, TokenView } from '../render/tokens'

export const FLY_MS = 665 // source → counter

// How many sprites make up a burst of `amount` tokens — a small, readable puff,
// never one-per-token (a 21-token blackjack would be a blizzard).
function burstIcons(amount: number): number {
  if (amount <= 1) {
    return 1
  }
  if (amount <= 5) {
    return 2
  }
  if (amount <= 12) {
    return 3
  }
  if (amount <= 25) {
    return 4
  }
  return 5
}

interface Flight {
  from: Point
  amount: number // credited to the displayed count once the burst lands
  icons: number
  start: number
  end: number
  spin: number
  launchReported: boolean // its lift-off sfx has been reported (see launched())
  landReported: boolean // its arrival sfx has been reported (see landed())
}

export class TokenAnimation implements TokenView {
  private flights_: Flight[] = []
  private end_ = 0

  isAnimating(now: number): boolean {
    return now < this.end_
  }

  // Schedule `amount` tokens flying from `from`, lifting off at `startAfter`.
  emit(from: Point, amount: number, startAfter: number): void {
    if (amount <= 0) {
      return
    }
    this.prune_(startAfter)
    const end = startAfter + FLY_MS
    this.flights_.push({
      from: { x: from.x, y: from.y },
      amount,
      icons: burstIcons(amount),
      start: startAfter,
      end,
      spin: Math.random(),
      launchReported: false,
      landReported: false,
    })
    this.end_ = Math.max(this.end_, end)
  }

  // How many token SPRITES have lifted off from the nexus since the last call —
  // summed across newly-launched bursts (a burst shows `icons` sprites), so the
  // launch sfx fires once per visible token, not once per burst. Reports each
  // burst exactly once, the frame `now` first reaches its lift-off.
  launched(now: number): number {
    let sprites = 0
    for (const flight of this.flights_) {
      if (!flight.launchReported && now >= flight.start) {
        flight.launchReported = true
        sprites += flight.icons
      }
    }
    return sprites
  }

  // The bursts that reached the counter since the last call — each as its sprite
  // count, so the caller can fire one increment ping per visible token and size the
  // counter's roll to that shower. Reports each burst once; a landed flight is held
  // (prune) until reported so a click can't drop it unheard.
  landed(now: number): number[] {
    const arrived: number[] = []
    for (const flight of this.flights_) {
      if (!flight.landReported && now >= flight.end) {
        flight.landReported = true
        arrived.push(flight.icons)
      }
    }
    return arrived
  }

  // Tokens still on their way to the counter (started or not) — the amount the
  // displayed count must withhold until each burst arrives.
  pending(now: number): number {
    let sum = 0
    for (const flight of this.flights_) {
      if (now < flight.end) {
        sum += flight.amount
      }
    }
    return sum
  }

  // The bursts currently visible (lifted off, not yet landed), for the renderer.
  bursts(now: number): readonly TokenBurst[] {
    const out: TokenBurst[] = []
    for (const flight of this.flights_) {
      if (now < flight.start || now >= flight.end) {
        continue
      }
      out.push({
        from: flight.from,
        progress: (now - flight.start) / FLY_MS,
        icons: flight.icons,
        spin: flight.spin,
      })
    }
    return out
  }

  // Drop flights that have already landed AND had their arrival reported, so the
  // list can't grow without bound but no landing sfx is pruned before it fires.
  private prune_(now: number): void {
    if (this.flights_.length > 0) {
      this.flights_ = this.flights_.filter((flight) => now < flight.end || !flight.landReported)
    }
  }
}
