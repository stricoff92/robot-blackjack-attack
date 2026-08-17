import { describe, expect, it } from 'vitest'

import { Session } from '../game/session'
import { dealerKey, playerKey } from '../render/cards'
import { DealAnimation } from './deal-animator'

describe('DealAnimation.splitHands', () => {
  it('glides the two originals face-up, then deals a fresh card into each hand', () => {
    const anim = new DealAnimation()
    anim.splitHands(0)

    // The two originals begin their glide immediately and stay face-up (no re-flip).
    anim.setNow(0)
    for (const key of [playerKey(0, 0), playerKey(1, 0)]) {
      const st = anim.state(key)
      expect(st).not.toBeNull()
      expect(st!.flip).toBe(1) // already revealed — glides face-up
      expect(st!.flight).toBeLessThan(1) // still moving into its new hand
    }

    // The two fresh second cards haven't started yet — they deal after the glide.
    expect(anim.state(playerKey(0, 1))).toBeNull()
    expect(anim.state(playerKey(1, 1))).toBeNull()

    // Once the whole sequence finishes, all four cards have landed face-up.
    anim.setNow(anim.animEnd)
    for (const key of [playerKey(0, 0), playerKey(1, 0), playerKey(0, 1), playerKey(1, 1)]) {
      const st = anim.state(key)
      expect(st).not.toBeNull()
      expect(st!.flight).toBe(1)
      expect(st!.flip).toBe(1)
    }
  })
})

describe('DealAnimation.settle (resume)', () => {
  it('snaps a restored hand to landed + revealed so the renderer draws it (empty-table bug)', () => {
    // A fresh animator (as on page reload) knows NONE of a resumed hand's cards, so drawHands would
    // skip them all — an empty felt. settle() must make every card read as landed.
    const session = new Session(9)
    session.deal()
    const state = session.snapshot()
    expect(state.phase).toBe('playing')

    const anim = new DealAnimation() // fresh, like a reloaded page
    anim.setNow(1000)
    anim.settle(state, 1000)

    const round = state.round!
    // Every player card: landed and face-up.
    round.hands.forEach((hand, hi) =>
      hand.cards.forEach((_, ci) => {
        const st = anim.state(playerKey(hi, ci))
        expect(st, `player ${hi},${ci} should be drawn`).not.toBeNull()
        expect(st!.flight).toBe(1)
        expect(st!.flip).toBe(1)
      }),
    )
    // Dealer up-card landed + face-up; the hole card landed but stays face-down mid-hand.
    expect(anim.state(dealerKey(0))!.flip).toBe(1)
    expect(anim.state(dealerKey(1))!.flight).toBe(1)
    expect(anim.state(dealerKey(1))!.flip).toBe(0) // hole hidden while playing (not peeked)
    // Settled, not animating.
    expect(anim.isAnimating(1000)).toBe(false)
  })

  it('reveals the hole when the resumed state has already peeked / resolved', () => {
    const session = new Session(9)
    session.deal()
    const anim = new DealAnimation()
    anim.setNow(1000)
    anim.settle({ ...session.snapshot(), peeked: true }, 1000)
    expect(anim.state(dealerKey(1))!.flip).toBe(1) // peeked → hole shown
  })

  it('keeps the Banker hole DOWN on a resumed in-progress coda gamble (phase=coda, player-turn)', () => {
    // The coda is phase 'coda' throughout, so keying hole-reveal off phase would expose the hole on a
    // resumed gamble. It must key off round.status: an in-progress (player-turn) hand hides the hole.
    const session = new Session(9)
    session.deal()
    const snap = session.snapshot()
    expect(snap.round!.status).toBe('player-turn')
    const anim = new DealAnimation()
    anim.setNow(1000)
    anim.settle({ ...snap, phase: 'coda' }, 1000)
    expect(anim.state(dealerKey(1))!.flip).toBe(0) // hole hidden mid-gamble, even in the coda
    expect(anim.state(dealerKey(0))!.flip).toBe(1) // up-card still shown
  })
})
