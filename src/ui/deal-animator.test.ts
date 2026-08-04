import { describe, expect, it } from 'vitest'

import { playerKey } from '../render/cards'
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
