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

import { maxIntegrityFor } from '../game/run'
import { arch2, smoothEnd2, smoothStart2 } from '../render/easing'
import { WALK_STEPS, type DealerView } from '../render/dealer'
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
export const KILL_ARRIVE_MS = 1300 // the new dealer walks in (WALK_STEPS strides) + eyes re-ignite (also the page-load / new-run spawn walk-in)
export const KILL_TOTAL_MS = KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS + KILL_ARRIVE_MS // 2350
// A death-only kill (the replacement's walk-in is deferred while the upgrade selector
// shows): by here the figure is fully broken apart and gone. Ends the block/sequence
// early, before the walk-in that a bundled kill would run next.
export const KILL_DEATH_MS = KILL_DEATH_LEAD_MS + KILL_DYING_MS // 900

// Below this fraction of full health the dealer's eyes start to flicker; the
// closer to zero, the harder they stutter (see flicker()).
const DAMAGE_THRESHOLD = 0.33
// Steady idle eye-glow; a hit flares it to full, death dims it to zero.
const BASE_GLOW = 0.7

type Mode = 'none' | 'hit' | 'kill' | 'spawn' | 'walkoff'

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
  private walkoffStart = 0 // t0 for the game-over walk-off (a loss: the dealer leaves)
  private seqEnd = 0 // when the active strike/hit/kill sequence is fully done
  private level = 1 // settled health fraction (drives the low-health eye flicker)
  // Colour identity: which dealer the settled figure is, plus the dealer it was
  // BEFORE the current kill (the one dying) — so figureShift() can flip the bowtie
  // colour to the replacement exactly when it walks in.
  private shift = 1
  private killFromShift = 1
  // Walk-in footstep tracking (edge-detected, mirrors the token launch/land sfx):
  // the absolute start of the walk-in we're currently reporting steps for, and how
  // many of its WALK_STEPS footfalls have been reported. Reset when a new walk-in
  // begins (a different start).
  private walkStart = -1
  private stepsFired = 0

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
    this.level = clamp01(Math.max(0, nextIntegrity) / maxIntegrityFor(nextShift))

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
  // override) flickers (or not) correctly from the first frame. `shift` scales it to
  // that dealer's max.
  setLevel(integrity: number, shift: number): void {
    this.level = clamp01(Math.max(0, integrity) / maxIntegrityFor(shift))
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

  // The dealer strides OFF to the right and leaves the screen — the game-over exit when
  // the house wins (the mirror of the walk-in, over the same window). It stands in place
  // until `startAfter`, then walks off. Set the colour identity (setShift) beforehand.
  walkOff(startAfter: number): void {
    this.mode = 'walkoff'
    this.final = false
    this.walkoffStart = startAfter
    this.seqEnd = startAfter + KILL_ARRIVE_MS
  }

  // Walk-off progress (0..1) as the dealer leaves to the right, or null when it's still
  // standing (before `walkoffStart`) or already gone.
  leaving(now: number): number | null {
    if (this.mode !== 'walkoff') {
      return null
    }
    const p = (now - this.walkoffStart) / KILL_ARRIVE_MS
    if (p < 0 || p >= 1) {
      return null
    }
    return p
  }

  // True while a standalone spawn walk-in is still sliding in (page load / new run).
  isArriving(now: number): boolean {
    return this.arriving(now) !== null
  }

  // Footfalls that have occurred since the last call, for the walk-in step sfx: each
  // of the WALK_STEPS bob-down beats is reported once, the frame `now` first reaches
  // it, so the caller fires one boot-thud per step. Returns how many landed this frame
  // (0 outside a walk-in). Resets when a fresh walk-in begins. Mirrors the token
  // launch/land edge-tracking — call it exactly once per frame.
  footsteps(now: number): number {
    const start = this.walkClock()
    if (start === null) {
      return 0
    }
    if (start !== this.walkStart) {
      this.walkStart = start
      this.stepsFired = 0
    }
    let fired = 0
    // Footfall i (0-based) lands at (i + 0.5)/WALK_STEPS of the arrival — the same
    // fractions the |sin| walk bob dips down at (render/dealer.ts).
    while (this.stepsFired < WALK_STEPS && now >= start + ((this.stepsFired + 0.5) / WALK_STEPS) * KILL_ARRIVE_MS) {
      this.stepsFired += 1
      fired += 1
    }
    return fired
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
    if (this.mode === 'walkoff') {
      // Standing (before the walk-off) or striding off; gone once it clears the edge.
      return now < this.walkoffStart + KILL_ARRIVE_MS
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
    const start = this.walkInStart()
    if (start === null || now < start || now >= start + KILL_ARRIVE_MS) {
      return null
    }
    return (now - start) / KILL_ARRIVE_MS
  }

  // The absolute timestamp the current walk-in slide begins — a standalone spawn, or
  // a kill's replacement arrival — or null when no walk-in is in play (final / death-
  // only kills have none). Shared by arriving() and the footstep tracker so the bob
  // and its step sfx key off one clock.
  private walkInStart(): number | null {
    if (this.mode === 'spawn') {
      return this.spawnStart
    }
    if (this.mode === 'kill' && !this.final && this.killWalkIn) {
      return this.killStart + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
    }
    return null
  }

  // The absolute start of the current WALK (in OR off) for footstep timing — both stride
  // WALK_STEPS times over KILL_ARRIVE_MS. null when neither is in play.
  private walkClock(): number | null {
    return this.mode === 'walkoff' ? this.walkoffStart : this.walkInStart()
  }

  // Bright red LED brightness (0..1) for the eye cores on the figure: 1 when
  // healthy, stuttering toward 0 as a low-health dealer's eyes flicker. Shares its
  // flicker signal with eyeGlow so the core and its halo blink in step.
  eyeCore(now: number): number {
    return this.flicker(now)
  }

  eyeGlow(now: number): number {
    if (this.mode === 'walkoff') {
      // The glow sits at the FIXED eye position (drawn on the mask, which doesn't
      // follow the figure's translate), so dim it out over the first 30% of the walk-off
      // — before the figure has strode far — rather than leaving a glow behind at centre.
      const lp = clamp01((now - this.walkoffStart) / KILL_ARRIVE_MS)
      const ramp = lp < 0.3 ? 1 - lp / 0.3 : 0
      return BASE_GLOW * ramp * this.flicker(now)
    }
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
