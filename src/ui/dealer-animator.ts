// Timing for the dealer: the take-damage reaction, the nexus laser strike, the
// low-health eye flicker, and the death → walk-in choreography that plays when
// a dealer is destroyed. Also drives the eye-glow strength on the mask layer.
//
// Mirrors HealthAnimation / DealAnimation: this owns timing (absolute
// performance.now() stamps), render/dealer.ts + render/nexus.ts own the drawing.
// One entry point, sync(), is called from GameView.run alongside health.sync with
// the same startAfter, so damage/death land in step with the card reveal + the
// health bar. The kill phase durations are EXPORTED so health-animator.ts locks
// its drain/pause/refill to them (they can't drift apart).

import { FULL_INTEGRITY } from '../game/run'
import { arch2, smoothEnd2, smoothStart2 } from '../render/easing'
import type { DealerView } from '../render/dealer'
import type { StrikeView } from '../render/nexus'

// --- laser strike + take-damage (both a plain hit and the lead-in to a kill) ---
export const STRIKE_TRAVEL_MS = 110 // beam flies nexus → dealer
export const STRIKE_FADE_MS = 220 // then holds + fades (beam life = 330ms)
export const HIT_MS = 300 // body flash + shake, from the moment of impact
export const IMPACT_SPARK_MS = 420 // impact spark spray, from impact
// Full duration of a non-kill hit reaction (strike travel + the longest sub-effect).
export const HIT_TOTAL_MS = STRIKE_TRAVEL_MS + Math.max(HIT_MS, IMPACT_SPARK_MS, STRIKE_FADE_MS)

// Brow "scared" reaction, timed off impact: snap the brows up into the worried
// pose, hold through the hit shake, then roll them back down to the resting angry
// brows. This outlasts HIT_TOTAL_MS, so it only extends the render-loop liveness
// (seqEnd), NOT the deal gate (HIT_TOTAL_MS) — gameplay pacing is unchanged.
const BROW_FEAR_RISE_MS = 90
const BROW_FEAR_HOLD_MS = 210
const BROW_FEAR_FALL_MS = 300
const BROW_FEAR_TOTAL_MS = BROW_FEAR_RISE_MS + BROW_FEAR_HOLD_MS + BROW_FEAR_FALL_MS

// --- kill choreography (relative to t0 = startAfter); sums to KILL_TOTAL_MS -----
export const KILL_DEATH_LEAD_MS = 260 // strike + hit reaction before the body breaks
export const KILL_DYING_MS = 640 // the figure blows apart and falls
export const KILL_GONE_MS = 150 // empty beat before the replacement appears
export const KILL_ARRIVE_MS = 1000 // the new dealer walks in + eyes re-ignite (also the page-load / new-run spawn walk-in)
export const KILL_TOTAL_MS = KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS + KILL_ARRIVE_MS // 2050
// A death-only kill (the replacement's walk-in is deferred while the upgrade selector
// shows): by here the figure is fully broken apart and gone. Ends the block/sequence
// early, before the walk-in that a bundled kill would run next.
export const KILL_DEATH_MS = KILL_DEATH_LEAD_MS + KILL_DYING_MS // 900

// Below this fraction of full health the dealer's eyes start to flicker; the
// closer to zero, the harder they stutter (see flicker()).
const DAMAGE_THRESHOLD = 0.33
// Steady idle eye-glow; a hit flares it to full, death dims it to zero.
const BASE_GLOW = 0.7

type Mode = 'none' | 'hit' | 'kill' | 'spawn'

export class DealerAnimation implements DealerView, StrikeView {
  private mode: Mode = 'none'
  private final = false // the last dealer — dies but never walks back in
  // Whether the current kill plays its replacement's walk-in as part of the same
  // sequence. False when the walk-in is deferred (a kill that grants an upgrade pick:
  // the dealer dies now, the selector shows, then a later spawn() walks the new one in).
  private killWalkIn = true
  private strikeStart = 0 // beam lift-off (t0)
  private hitStart = 0 // impact = t0 + STRIKE_TRAVEL_MS
  private killStart = 0 // t0 for a kill
  private spawnStart = 0 // t0 for a standalone walk-in (page load / new run)
  private seqEnd = 0 // when the active strike/hit/kill sequence is fully done
  private level = 1 // settled health fraction (drives the low-health eye flicker)
  // Colour identity: which dealer the settled figure is, plus the dealer it was
  // BEFORE the current kill (the one dying) — so figureShift() can flip the bowtie
  // colour to the replacement exactly when it walks in.
  private shift = 1
  private killFromShift = 1

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
    walkIn = true,
  ): void {
    this.level = clamp01(Math.max(0, nextIntegrity) / FULL_INTEGRITY)

    if (nextShift > prevShift) {
      this.mode = 'kill'
      this.final = final
      this.killWalkIn = walkIn
      this.strikeStart = startAfter
      this.hitStart = startAfter + STRIKE_TRAVEL_MS
      this.killStart = startAfter
      // A death-only kill ends when the figure is gone; a bundled kill runs on through
      // the empty beat + the replacement's walk-in.
      this.seqEnd = startAfter + (walkIn ? KILL_TOTAL_MS : KILL_DEATH_MS)
      // The dying figure keeps the outgoing colour; the arriving one takes the new.
      this.killFromShift = prevShift
      this.shift = nextShift
      return
    }
    if (nextIntegrity < prevIntegrity) {
      this.mode = 'hit'
      this.strikeStart = startAfter
      this.hitStart = startAfter + STRIKE_TRAVEL_MS
      // Keep the loop alive until the slower of the hit effects and the brow
      // roll-back finishes (the deal gate stays on HIT_TOTAL_MS — see above).
      this.seqEnd = startAfter + Math.max(HIT_TOTAL_MS, STRIKE_TRAVEL_MS + BROW_FEAR_TOTAL_MS)
      return
    }
    // No damage this action (deal, loss, push): leave the figure idle.
    this.mode = 'none'
    this.seqEnd = 0
  }

  // Snap the settled health fraction to a given integrity without playing a hit —
  // used on load so a dealer that starts partway damaged (the dealerHealth dev
  // override) flickers (or not) correctly from the first frame.
  setLevel(integrity: number): void {
    this.level = clamp01(Math.max(0, integrity) / FULL_INTEGRITY)
  }

  // Snap the figure's colour identity to a given dealer without any death/walk-in —
  // used on load and on a New run (which may start at a dev-chosen dealer).
  setShift(shiftIndex: number): void {
    this.shift = shiftIndex
    this.killFromShift = shiftIndex
  }

  // A standalone walk-in with no preceding death — the dealer slides in from the
  // right and its eyes ignite, over the same window as a kill's arrival. Used on
  // page load and on a New run, where there's no old dealer being destroyed. Set
  // the colour identity (setShift) BEFORE calling this.
  spawn(startAfter: number): void {
    this.mode = 'spawn'
    this.final = false
    this.spawnStart = startAfter
    this.seqEnd = startAfter + KILL_ARRIVE_MS
  }

  // True while a standalone spawn walk-in is still sliding in (page load / new run).
  isArriving(now: number): boolean {
    return this.arriving(now) !== null
  }

  // True while any strike/hit/kill sequence is playing OR the eyes are flickering
  // from low health — keeps the GameView loop alive so the flicker keeps ticking.
  isAnimating(now: number): boolean {
    if (this.mode !== 'none' && now < this.seqEnd) {
      return true
    }
    return this.damageIntensity() > 0
  }

  // True across the whole kill, so buttons stay disabled for the entire death →
  // walk-in → recharge pause (a plain hit never blocks). A death-only kill blocks
  // just through the death — the deferred walk-in re-blocks later on its own.
  isBlocking(now: number): boolean {
    if (this.mode !== 'kill') {
      return false
    }
    const blockEnd = this.killStart + (this.killWalkIn ? KILL_TOTAL_MS : KILL_DEATH_MS)
    return now >= this.killStart && now < blockEnd
  }

  // True while a strike/hit/kill sequence is playing (NOT the idle eye flicker).
  // Used to hold the next deal until the laser + any death choreography finishes.
  isAttacking(now: number): boolean {
    return this.mode !== 'none' && now < this.seqEnd
  }

  // --- DealerView --------------------------------------------------------------

  alive(now: number): boolean {
    if (this.mode === 'spawn') {
      // A deferred walk-in is parked/gone until it actually begins (its start may be
      // scheduled a beat ahead — e.g. while the upgrade selector is still up).
      return now >= this.spawnStart
    }
    if (this.mode !== 'kill') {
      return true
    }
    const goneStart = this.killStart + KILL_DEATH_LEAD_MS + KILL_DYING_MS
    if (this.final || !this.killWalkIn) {
      return now < goneStart // dies and stays gone (no walk-in in this sequence)
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

  // Scared-brow reaction (0 = resting angry brows, 1 = full worried tilt). Snaps up
  // at impact, holds through the shake, then rolls back over BROW_FEAR_FALL_MS. On a
  // kill it's cut short when the figure breaks apart (dying() takes over the draw).
  browFear(now: number): number {
    if (this.mode === 'none') {
      return 0
    }
    const t = now - this.hitStart
    if (t < 0 || t >= BROW_FEAR_TOTAL_MS) {
      return 0
    }
    if (t < BROW_FEAR_RISE_MS) {
      return smoothEnd2(t / BROW_FEAR_RISE_MS) // snap up into the scared pose
    }
    const held = t - BROW_FEAR_RISE_MS
    if (held < BROW_FEAR_HOLD_MS) {
      return 1 // hold the scared face through the hit reaction
    }
    return 1 - smoothStart2((held - BROW_FEAR_HOLD_MS) / BROW_FEAR_FALL_MS) // roll back
  }

  // The colour identity of the figure on screen. During a kill the outgoing dealer
  // holds its colour through the death; the replacement's colour takes over the
  // moment it starts walking in (the empty gone-beat draws nothing, so it doesn't
  // matter there). A final kill has no replacement, so it stays the dying dealer.
  figureShift(now: number): number {
    if (this.mode === 'kill' && !this.final && this.killWalkIn) {
      const arriveStart = this.killStart + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
      return now >= arriveStart ? this.shift : this.killFromShift
    }
    if (this.mode === 'kill') {
      // Final kill / death-only: the dying dealer keeps its colour (no walk-in here).
      return this.killFromShift
    }
    return this.shift
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
    if (this.mode === 'spawn') {
      if (now < this.spawnStart || now >= this.spawnStart + KILL_ARRIVE_MS) {
        return null
      }
      return (now - this.spawnStart) / KILL_ARRIVE_MS
    }
    if (this.mode !== 'kill' || this.final || !this.killWalkIn) {
      return null
    }
    const start = this.killStart + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
    if (now < start || now >= start + KILL_ARRIVE_MS) {
      return null
    }
    return (now - start) / KILL_ARRIVE_MS
  }

  // Bright red LED brightness (0..1) for the eye cores on the figure: 1 when
  // healthy, stuttering toward 0 as a low-health dealer's eyes flicker. Shares its
  // flicker signal with eyeGlow so the core and its halo blink in step.
  eyeCore(now: number): number {
    return this.flicker(now)
  }

  eyeGlow(now: number): number {
    if (this.mode === 'spawn') {
      // Ignite as the figure nears home — the same re-ignite curve a kill's
      // replacement uses (only the last 40% of the slide, by when it's ~settled).
      const ap = clamp01((now - this.spawnStart) / KILL_ARRIVE_MS)
      const ramp = ap < 0.6 ? 0 : (ap - 0.6) / 0.4
      return BASE_GLOW * ramp * this.flicker(now)
    }
    if (this.mode === 'kill') {
      const dyingStart = this.killStart + KILL_DEATH_LEAD_MS
      if (now < dyingStart) {
        return BASE_GLOW + this.hitFlare(now)
      }
      const dyingEnd = dyingStart + KILL_DYING_MS
      if (now < dyingEnd) {
        return BASE_GLOW * (1 - (now - dyingStart) / KILL_DYING_MS) // dim out as it dies
      }
      if (this.final || !this.killWalkIn) {
        return 0 // no walk-in in this kill sequence — stays dark
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
      return (BASE_GLOW + this.hitFlare(now)) * this.flicker(now)
    }
    return BASE_GLOW * this.flicker(now)
  }

  // --- StrikeView --------------------------------------------------------------

  beam(now: number): { travel: number; alpha: number } | null {
    if (!this.striking()) {
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
    if (!this.striking()) {
      return null
    }
    const dur = STRIKE_TRAVEL_MS + 120
    if (now < this.strikeStart || now >= this.strikeStart + dur) {
      return null
    }
    return arch2((now - this.strikeStart) / dur)
  }

  impactSpark(now: number): number | null {
    if (!this.striking()) {
      return null
    }
    if (now < this.hitStart || now >= this.hitStart + IMPACT_SPARK_MS) {
      return null
    }
    return (now - this.hitStart) / IMPACT_SPARK_MS
  }

  // Whether a laser strike is actually in play — only a hit or a kill fires one. A
  // 'spawn' walk-in (page load / new run) must NOT, or its stale strikeStart (0)
  // would draw a phantom beam while performance.now() is still small on load.
  private striking(): boolean {
    return this.mode === 'hit' || this.mode === 'kill'
  }

  // How badly the dealer's eyes are failing (0 = healthy, 1 = near death), from the
  // settled health fraction: 0 at/above the damage threshold, ramping to 1 as it
  // approaches empty. Drives both the flicker and whether the loop keeps ticking.
  private damageIntensity(): number {
    if (this.level <= 0 || this.level >= DAMAGE_THRESHOLD) {
      return 0
    }
    return clamp01((DAMAGE_THRESHOLD - this.level) / DAMAGE_THRESHOLD)
  }

  // Eye-flicker multiplier (0..1): 1 when healthy, an irregular on/off stutter once
  // below the damage threshold. As the dealer nears death (k → 1) the stutter runs
  // faster, dips into the "off" state more often, and cuts fully dark instead of a
  // shallow dim. The signal is summed incommensurate sines (time-driven, so it
  // flickers smoothly rather than jittering per frame).
  private flicker(now: number): number {
    const k = this.damageIntensity()
    if (k <= 0) {
      return 1
    }
    const speed = 0.008 + 0.03 * k // angular speed (rad/ms) — faster when more damaged
    const s =
      Math.sin(now * speed) + Math.sin(now * speed * 2.7 + 1.3) + Math.sin(now * speed * 6.3 + 4.1)
    const wave = (s + 3) / 6 // 0..1
    const cut = 0.32 + 0.33 * k // more of the wave falls into the "off" band as k rises
    const floor = 0.55 * (1 - k) // "off" brightness: a dim dip early, fully dark near death
    if (wave >= cut) {
      return 1
    }
    const t = clamp01((cut - wave) / 0.14) // crisp but anti-aliased on/off edge
    return 1 - (1 - floor) * t
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
