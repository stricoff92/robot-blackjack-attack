// Timing for the dealer: the take-damage reaction, the nexus laser strike, the
// low-health ambient sparks, and the death → walk-in choreography that plays when
// a dealer is destroyed. Also drives the eye-glow strength on the mask layer.
//
// Mirrors HealthAnimation / DealAnimation: this owns timing (absolute
// performance.now() stamps), render/dealer.ts + render/nexus.ts own the drawing.
// One entry point, sync(), is called from GameView.run alongside health.sync with
// the same startAfter, so damage/death land in step with the card reveal + the
// health bar. The kill phase durations are EXPORTED so health-animator.ts locks
// its drain/pause/refill to them (they can't drift apart).

import { FULL_INTEGRITY } from '../game/run'
import { arch2, smoothStart2 } from '../render/easing'
import type { DealerView } from '../render/dealer'
import type { StrikeView } from '../render/nexus'

// --- laser strike + take-damage (both a plain hit and the lead-in to a kill) ---
export const STRIKE_TRAVEL_MS = 110 // beam flies nexus → dealer
export const STRIKE_FADE_MS = 220 // then holds + fades (beam life = 330ms)
export const HIT_MS = 300 // body flash + shake, from the moment of impact
export const IMPACT_SPARK_MS = 340 // impact spark spray, from impact
// Full duration of a non-kill hit reaction (strike travel + the longest sub-effect).
export const HIT_TOTAL_MS = STRIKE_TRAVEL_MS + Math.max(HIT_MS, IMPACT_SPARK_MS, STRIKE_FADE_MS)

// --- kill choreography (relative to t0 = startAfter); sums to KILL_TOTAL_MS -----
export const KILL_DEATH_LEAD_MS = 260 // strike + hit reaction before the body breaks
export const KILL_DYING_MS = 640 // the figure blows apart and falls
export const KILL_GONE_MS = 150 // empty beat before the replacement appears
export const KILL_ARRIVE_MS = 650 // the new dealer walks in + eyes re-ignite
export const KILL_TOTAL_MS = KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS + KILL_ARRIVE_MS // 1700

// Below this fraction of full health the dealer sparks continuously.
export const AMBIENT_THRESHOLD = 0.3
// Steady idle eye-glow; a hit flares it to full, death dims it to zero.
const BASE_GLOW = 0.7

type Mode = 'none' | 'hit' | 'kill'

export class DealerAnimation implements DealerView, StrikeView {
  private mode: Mode = 'none'
  private final = false // the last dealer — dies but never walks back in
  private strikeStart = 0 // beam lift-off (t0)
  private hitStart = 0 // impact = t0 + STRIKE_TRAVEL_MS
  private killStart = 0 // t0 for a kill
  private seqEnd = 0 // when the active strike/hit/kill sequence is fully done
  private level = 1 // settled health fraction (drives ambient sparks)

  // Register the integrity change this action produced. A rising shift index is a
  // kill (old dealer destroyed); a fall in integrity with the same shift is a
  // plain hit; anything else is idle. `final` suppresses the walk-in (last dealer).
  sync(
    prevIntegrity: number,
    prevShift: number,
    nextIntegrity: number,
    nextShift: number,
    startAfter: number,
    final = false,
  ): void {
    this.level = clamp01(Math.max(0, nextIntegrity) / FULL_INTEGRITY)

    if (nextShift > prevShift) {
      this.mode = 'kill'
      this.final = final
      this.strikeStart = startAfter
      this.hitStart = startAfter + STRIKE_TRAVEL_MS
      this.killStart = startAfter
      this.seqEnd = startAfter + KILL_TOTAL_MS
      return
    }
    if (nextIntegrity < prevIntegrity) {
      this.mode = 'hit'
      this.strikeStart = startAfter
      this.hitStart = startAfter + STRIKE_TRAVEL_MS
      this.seqEnd = startAfter + HIT_TOTAL_MS
      return
    }
    // No damage this action (deal, loss, push): leave the figure idle.
    this.mode = 'none'
    this.seqEnd = 0
  }

  // True while any strike/hit/kill sequence is playing OR ambient sparks are
  // active — keeps the GameView loop alive.
  isAnimating(now: number): boolean {
    if (this.mode !== 'none' && now < this.seqEnd) {
      return true
    }
    return this.ambient(now) > 0
  }

  // True across the WHOLE kill (t0 → t0 + 1700), so buttons stay disabled for the
  // entire death → walk-in → recharge pause (a plain hit never blocks).
  isBlocking(now: number): boolean {
    return this.mode === 'kill' && now >= this.killStart && now < this.killStart + KILL_TOTAL_MS
  }

  // True while a strike/hit/kill sequence is playing (NOT ambient sparks). Used to
  // hold the next deal until the laser + any death choreography finishes.
  isAttacking(now: number): boolean {
    return this.mode !== 'none' && now < this.seqEnd
  }

  // --- DealerView --------------------------------------------------------------

  alive(now: number): boolean {
    if (this.mode !== 'kill') {
      return true
    }
    const goneStart = this.killStart + KILL_DEATH_LEAD_MS + KILL_DYING_MS
    if (this.final) {
      return now < goneStart // dies and stays gone
    }
    const goneEnd = goneStart + KILL_GONE_MS
    return !(now >= goneStart && now < goneEnd)
  }

  hit(now: number): { flash: number; shakeX: number; shakeY: number } {
    if (this.mode === 'none') {
      return NO_HIT
    }
    const start = this.hitStart
    if (now < start || now >= start + HIT_MS) {
      return NO_HIT
    }
    const p = (now - start) / HIT_MS
    const u = 1 - p
    // Shake amplitude in headR-fraction units (the renderer scales by headR); a
    // decaying wobble on both axes.
    const amp = 0.06 * u
    return {
      flash: u * u,
      shakeX: Math.sin(p * Math.PI * 8) * amp,
      shakeY: Math.cos(p * Math.PI * 6) * amp * 0.6,
    }
  }

  dying(now: number): number | null {
    if (this.mode !== 'kill') {
      return null
    }
    const start = this.killStart + KILL_DEATH_LEAD_MS
    if (now < start || now >= start + KILL_DYING_MS) {
      return null
    }
    return (now - start) / KILL_DYING_MS
  }

  arriving(now: number): number | null {
    if (this.mode !== 'kill' || this.final) {
      return null
    }
    const start = this.killStart + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
    if (now < start || now >= start + KILL_ARRIVE_MS) {
      return null
    }
    return (now - start) / KILL_ARRIVE_MS
  }

  ambient(_now: number): number {
    if (this.level <= 0 || this.level >= AMBIENT_THRESHOLD) {
      return 0
    }
    return clamp01((AMBIENT_THRESHOLD - this.level) / AMBIENT_THRESHOLD)
  }

  eyeGlow(now: number): number {
    if (this.mode === 'kill') {
      const dyingStart = this.killStart + KILL_DEATH_LEAD_MS
      if (now < dyingStart) {
        return BASE_GLOW + this.hitFlare(now)
      }
      const dyingEnd = dyingStart + KILL_DYING_MS
      if (now < dyingEnd) {
        return BASE_GLOW * (1 - (now - dyingStart) / KILL_DYING_MS) // dim out as it dies
      }
      if (this.final) {
        return 0
      }
      const arriveStart = dyingEnd + KILL_GONE_MS
      if (now < arriveStart) {
        return 0 // gone
      }
      const ap = (now - arriveStart) / KILL_ARRIVE_MS
      if (ap >= 1) {
        return BASE_GLOW
      }
      // Re-ignite only in the last 40% of the walk-in, by when the figure is ~home
      // (its slide uses smoothEnd3), so the glow on the fixed mask lines up.
      return ap < 0.6 ? 0 : BASE_GLOW * ((ap - 0.6) / 0.4)
    }
    if (this.mode === 'hit') {
      return BASE_GLOW + this.hitFlare(now)
    }
    return BASE_GLOW
  }

  // --- StrikeView --------------------------------------------------------------

  beam(now: number): { travel: number; alpha: number } | null {
    if (this.mode === 'none') {
      return null
    }
    const travelEnd = this.strikeStart + STRIKE_TRAVEL_MS
    const fadeEnd = travelEnd + STRIKE_FADE_MS
    if (now < this.strikeStart || now >= fadeEnd) {
      return null
    }
    if (now < travelEnd) {
      return { travel: (now - this.strikeStart) / STRIKE_TRAVEL_MS, alpha: 1 }
    }
    return { travel: 1, alpha: 1 - smoothStart2((now - travelEnd) / STRIKE_FADE_MS) }
  }

  muzzle(now: number): number | null {
    if (this.mode === 'none') {
      return null
    }
    const dur = STRIKE_TRAVEL_MS + 120
    if (now < this.strikeStart || now >= this.strikeStart + dur) {
      return null
    }
    return arch2((now - this.strikeStart) / dur)
  }

  impactSpark(now: number): number | null {
    if (this.mode === 'none') {
      return null
    }
    if (now < this.hitStart || now >= this.hitStart + IMPACT_SPARK_MS) {
      return null
    }
    return (now - this.hitStart) / IMPACT_SPARK_MS
  }

  // A brief upward bump on the eye glow at impact (fades over the hit reaction).
  private hitFlare(now: number): number {
    const start = this.hitStart
    if (now < start || now >= start + HIT_MS) {
      return 0
    }
    const u = 1 - (now - start) / HIT_MS
    return 0.6 * u * u
  }
}

const NO_HIT = { flash: 0, shakeX: 0, shakeY: 0 }

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
