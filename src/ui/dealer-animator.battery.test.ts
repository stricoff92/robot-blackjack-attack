import { describe, expect, it } from 'vitest'
import { maxHitsFor } from '../game/run'
import { evilLaughPattern } from '../audio/voice'
import { DealerAnimation } from './dealer-animator'

// Health fraction pct% via setLevel (integrity = pct% × maxHits), mirroring damage-fx.test.ts.
function at(healthPct: number): DealerAnimation {
  const d = new DealerAnimation()
  d.setLevel((healthPct / 100) * maxHitsFor(1), 1)
  return d
}

// These three queries are what battery saver's frame loop reads to decide park vs. pulse vs.
// full-speed (see game-view busy_ / ambientPulse_). They split what isAnimating() conflates.
describe('dealer battery-saver queries', () => {
  describe('ambientDamageActive (drives the pulse-vs-park choice)', () => {
    it('is false at or above the 75% damage-FX threshold', () => {
      expect(at(100).ambientDamageActive(50_000)).toBe(false)
      expect(at(75).ambientDamageActive(50_000)).toBe(false)
    })

    it('is true across the whole damaged band, including the 33–75% gap isAnimating misses', () => {
      expect(at(74).ambientDamageActive(50_000)).toBe(true)
      expect(at(50).ambientDamageActive(50_000)).toBe(true)
      expect(at(20).ambientDamageActive(50_000)).toBe(true)
    })

    it('at 50% health isAnimating is false but ambientDamageActive is true (the mid-band trap)', () => {
      // This is exactly why parking must NOT gate on isAnimating: a mid-damaged idle dealer would
      // otherwise be parked mid-spark. The pulse path keys off ambientDamageActive instead.
      const d = at(50)
      expect(d.isAnimating(50_000)).toBe(false)
      expect(d.ambientDamageActive(50_000)).toBe(true)
    })
  })

  describe('isSequencing (transient choreography only, not ambient)', () => {
    it('is false for an idle standing dealer, even a badly damaged one', () => {
      expect(at(100).isSequencing(50_000)).toBe(false)
      expect(at(10).isSequencing(50_000)).toBe(false) // low-health flicker is NOT a sequence
    })

    it('is true while a hit reaction plays, then false once it ends', () => {
      const d = new DealerAnimation()
      d.sync(maxHitsFor(1), 1, maxHitsFor(1) - 1, 1, 0) // a plain hit at t=0 (same shift, integrity drops)
      expect(d.isSequencing(0)).toBe(true)
      expect(d.isSequencing(10_000)).toBe(false) // well past the hit reaction
    })
  })

  describe('isEmoting (the laugh mouth that isAnimating does not cover)', () => {
    it('is true within the emote envelope and false after it', () => {
      const d = new DealerAnimation()
      const pattern = evilLaughPattern(1, 1)
      d.emote(0, pattern)
      expect(d.isEmoting(0)).toBe(true)
      expect(d.isEmoting(pattern.totalMs + 1)).toBe(false)
    })

    it('is false before any emote', () => {
      expect(new DealerAnimation().isEmoting(0)).toBe(false)
    })
  })
})
