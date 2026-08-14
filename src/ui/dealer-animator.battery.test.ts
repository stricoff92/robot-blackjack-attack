import { describe, expect, it } from 'vitest'
import { maxHitsFor } from '../game/run'
import { evilLaughPattern } from '../audio/voice'
import { DAMAGE_ANIM_MS, DealerAnimation, STRIKE_TRAVEL_MS } from './dealer-animator'

// An idle dealer parked at a given health (no hit) — mode stays 'none', so nothing is sequencing.
function at(healthPct: number): DealerAnimation {
  const d = new DealerAnimation()
  d.setLevel((healthPct / 100) * maxHitsFor(1), 1)
  return d
}

// These queries are what battery saver's frame loop reads to decide park vs. full-speed (see
// game-view busy_ / drawSparks). The dealer's damage reaction is now a BOUNDED window that
// isSequencing spans in full, so isSequencing + isEmoting are the whole "keep the loop live"
// signal — identically in both battery modes. There is no ambient / low-health repaint band.
describe('dealer battery-saver queries', () => {
  describe('isSequencing (spans the whole bounded damage window)', () => {
    it('is false for an idle standing dealer, even a badly damaged one', () => {
      expect(at(100).isSequencing(50_000)).toBe(false)
      expect(at(10).isSequencing(50_000)).toBe(false) // a damaged-but-idle dealer is mint + static now
    })

    it('stays true across the whole DAMAGE_ANIM_MS reaction, then false once it ends', () => {
      const d = new DealerAnimation()
      d.sync(maxHitsFor(1), 1, maxHitsFor(1) - 1, 1, 0) // a plain hit at t=0, impact at STRIKE_TRAVEL_MS
      const end = STRIKE_TRAVEL_MS + DAMAGE_ANIM_MS
      expect(d.isSequencing(0)).toBe(true)
      expect(d.isSequencing(1000)).toBe(true) // deep inside the 3200ms window (was false pre-refactor)
      expect(d.isSequencing(end - 1)).toBe(true)
      expect(d.isSequencing(end + 1)).toBe(false)
    })
  })

  describe('isEmoting (the laugh mouth that keeps the loop live on its own)', () => {
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
