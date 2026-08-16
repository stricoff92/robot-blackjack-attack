// Timing for the dealer: the take-damage reaction, the nexus laser strike, the
// low-health eye flicker, and the death → walk-in choreography that plays when
// a dealer is destroyed. Also drives the eye-glow strength on the mask layer.
//
// Mirrors DealAnimation: this owns timing (absolute performance.now() stamps),
// render/dealer.ts + render/nexus.ts own the drawing. One entry point, sync(), is
// called from GameView.run with the deal's startAfter, so damage/death land in step
// with the card reveal. The kill phase durations are EXPORTED so GameView can
// sequence the death → walk-in beat against them (they can't drift apart).

import { maxHitsFor } from '../game/run'
import { voiceEnvelope, type VoicePattern } from '../audio/voice'
import type { DamageBurstState } from '../render/damage-fx'
import { arch2, smoothEnd2, smoothStart2 } from '../render/easing'
import { WALK_STEPS, type DealerView, type VoiceEmote } from '../render/dealer'
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

// Diegetic damage FX (sparks + smoke bursting off the figure — the diegetic stand-in
// for the removed health bar). Separate from the eye flicker: it begins EARLIER (below
// FX_THRESHOLD, not DAMAGE_THRESHOLD) and its bursts fire faster as health nears zero.
// Purely time-quantized — burst k fires at k·interval — so, like the flicker, it keeps
// no particle state: a frame's bursts are a pure function of `now` (survives a resize,
// the loop, and the frozen-clock probe).
const FX_THRESHOLD = 0.75 // no sparks/smoke at or above 75% health
const FX_MAX_INTERVAL = 1100 // ms between bursts just under the threshold (sparse)
const FX_MIN_INTERVAL = 230 // ms between bursts near death (bursts stay distinct, not a stream)
const FX_BURST_LIFE = 1200 // a burst is finished (dropped) once it ages past this

// A hit opens a BOUNDED damage-reaction window: sparks/smoke/eye-flicker/tremor play for this
// long after impact, then the dealer returns to mint condition (full eye glow) regardless of
// health. Exceeds FX_BURST_LIFE so the last spawned burst can fully fade before the window
// closes (see damageBursts's maxTs cap). Kills run their own death choreography — no window.
export const DAMAGE_ANIM_MS = 5000

// Damage tremors: intermittent whole-figure shudders that fade in below 50% health and get
// MORE FREQUENT toward death (down to ~1/sec) — but every shudder shakes at the SAME,
// always-noticeable magnitude. Damage reads through the RATE, not the strength: a faint
// shudder isn't worth showing, so instead of scaling the amplitude down near the top we just
// space the (full-strength) shudders further apart. Each fires as a short pulse on an
// interval that scales LINEARLY with damage, its time nudged by a hashed jitter so the
// cadence looks random, not metronomic. Pure function of `now` (matches the spark bursts).
const TREMOR_THRESHOLD = 0.5 // no tremors at or above 50% health
const TREMOR_MAX_INTERVAL = 4000 // ms between shudders just below 50% health (rare)
const TREMOR_MIN_INTERVAL = 1200 // ms between shudders near death (the ~1/sec floor)
const TREMOR_JITTER = 0.25 // shudder time nudged by ±TREMOR_JITTER/2 (±0.125·interval), for a random-looking cadence
const TREMOR_PULSE_MS = 350 // how long one shudder lasts (a cos hump swells it in then out)
const TREMOR_AMP = 0.11 // shudder magnitude in headR-fraction units — CONSTANT, so every one is clearly visible

type Mode = 'none' | 'hit' | 'kill' | 'spawn' | 'walkoff'

export class DealerAnimation implements DealerView, StrikeView {
  private mode_: Mode = 'none'
  private final_ = false // the last dealer — dies but never walks back in
  // Whether the current kill plays its replacement's walk-in as part of the same
  // sequence. False when the walk-in is deferred (a kill that grants an upgrade pick:
  // the dealer dies now, the selector shows, then a later spawn() walks the new one in).
  private killWalkIn_ = true
  private strikeStart_ = 0 // beam lift-off (t0)
  private hitStart_ = 0 // impact = t0 + STRIKE_TRAVEL_MS
  private killStart_ = 0 // t0 for a kill
  private spawnStart_ = 0 // t0 for a standalone walk-in (page load / new run)
  private walkoffStart_ = 0 // t0 for the game-over walk-off (a loss: the dealer leaves)
  private seqEnd_ = 0 // when the active strike/hit/kill sequence is fully done
  private level_ = 1 // health fraction AFTER the pending strike lands (drives flicker/sparks/tremor)
  // The FX show `prevLevel` until `levelAt`, then `level`: a deferred laser's health drop must
  // NOT blank the sparks/tremor/flicker at the button click — they hold the old level right up
  // until the beam strikes (`levelAt` = impact). See sync() / currentLevel().
  private prevLevel_ = 1
  private levelAt_ = 0
  // Colour identity: which dealer the settled figure is, plus the dealer it was
  // BEFORE the current kill (the one dying) — so figureShift() can flip the bowtie
  // colour to the replacement exactly when it walks in.
  private shift_ = 1
  private killFromShift_ = 1
  // Walk-in footstep tracking (edge-detected, mirrors the token launch/land sfx):
  // the absolute start of the walk-in we're currently reporting steps for, and how
  // many of its WALK_STEPS footfalls have been reported. Reset when a new walk-in
  // begins (a different start).
  private walkStart_ = -1
  private stepsFired_ = 0
  // The active voice emote (an evil laugh on a house win): the absolute start stamp
  // and the laugh pattern that shapes both the audio and this mouth readout. Purely
  // cosmetic — it never gates deals or blocks buttons (the render loop never parks, so
  // the mouth animates without being in isAnimating). Overwritten by the next emote.
  private emoteStart_ = 0
  private emotePattern_: VoicePattern | null = null

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
    // Hold whatever level is showing now until the strike lands (levelAt), so a deferred
    // laser doesn't blank the sparks/tremor/flicker the instant it's scheduled at the click.
    this.prevLevel_ = this.level_
    this.level_ = clamp01(Math.max(0, nextIntegrity) / maxHitsFor(nextShift))

    if (nextShift > prevShift) {
      this.mode_ = 'kill'
      this.final_ = final
      this.killWalkIn_ = walkIn
      this.strikeStart_ = startAfter
      this.hitStart_ = startAfter + STRIKE_TRAVEL_MS
      this.killStart_ = startAfter
      this.levelAt_ = this.hitStart_ // FX keep the old low level right up until the beam strikes
      // A death-only kill ends when the figure is gone; a bundled kill runs on through
      // the empty beat + the replacement's walk-in.
      this.seqEnd_ = startAfter + (walkIn ? KILL_TOTAL_MS : KILL_DEATH_MS)
      // The dying figure keeps the outgoing colour; the arriving one takes the new.
      this.killFromShift_ = prevShift
      this.shift_ = nextShift
      return
    }
    if (nextIntegrity < prevIntegrity) {
      this.mode_ = 'hit'
      this.strikeStart_ = startAfter
      this.hitStart_ = startAfter + STRIKE_TRAVEL_MS
      this.levelAt_ = this.hitStart_ // the added damage shows when the beam lands, not at the click
      // Open the bounded damage-reaction window: the sparks/smoke/flicker/tremor (and the shorter
      // flash/shake/beam/brow sub-effects, which run in their own windows off hitStart_) play for
      // DAMAGE_ANIM_MS after impact, then the figure settles back to mint. seqEnd_ IS that window —
      // it keeps the render loop alive across it in BOTH battery modes. Deal pacing is unaffected
      // (the deal gate uses HIT_TOTAL_MS directly, not seqEnd_).
      this.seqEnd_ = this.hitStart_ + DAMAGE_ANIM_MS
      return
    }
    // No damage this action (deal, loss, push): leave the figure idle.
    this.mode_ = 'none'
    this.seqEnd_ = 0
    this.levelAt_ = 0 // no strike scheduled; prevLevel == level anyway
  }

  // Snap the settled health fraction to a given integrity without playing a hit —
  // used on load so a dealer that starts partway damaged (the dealerHealth dev
  // override) flickers (or not) correctly from the first frame. `shift` scales it to
  // that dealer's max.
  setLevel(integrity: number, shift: number): void {
    this.level_ = clamp01(Math.max(0, integrity) / maxHitsFor(shift))
    // An instant set (load / new run / heal / arrival): no strike to wait for.
    this.prevLevel_ = this.level_
    this.levelAt_ = 0
  }

  // Snap the figure's colour identity to a given dealer without any death/walk-in —
  // used on load and on a New run (which may start at a dev-chosen dealer).
  setShift(shiftIndex: number): void {
    this.shift_ = shiftIndex
    this.killFromShift_ = shiftIndex
  }

  // Place the settled figure at its mark with NO walk-in — used when RESUMING a saved run
  // mid-hand / mid-coda: the dealer is already present, so there's no arrival ceremony to play.
  // The constructor's opening armIntro_ leaves the figure in 'spawn' (parked off-screen); this
  // cancels that so the first resumed frame paints it upright at its spot. Colour + level come
  // from setShift / setLevel, called alongside.
  standAtMark(): void {
    this.mode_ = 'none'
    this.seqEnd_ = 0
    this.levelAt_ = 0
  }

  // A standalone walk-in with no preceding death — the dealer slides in from the
  // right and its eyes ignite, over the same window as a kill's arrival. Used on
  // page load and on a New run, where there's no old dealer being destroyed. Set
  // the colour identity (setShift) BEFORE calling this.
  spawn(startAfter: number): void {
    this.mode_ = 'spawn'
    this.final_ = false
    this.spawnStart_ = startAfter
    this.seqEnd_ = startAfter + KILL_ARRIVE_MS
  }

  // The dealer strides OFF to the right and leaves the screen — the game-over exit when
  // the house wins (the mirror of the walk-in, over the same window). It stands in place
  // until `startAfter`, then walks off. Set the colour identity (setShift) beforehand.
  walkOff(startAfter: number): void {
    this.mode_ = 'walkoff'
    this.final_ = false
    this.walkoffStart_ = startAfter
    this.seqEnd_ = startAfter + KILL_ARRIVE_MS
  }

  // Begin a voice emote (the evil laugh) at `startAfter`, shaped by `pattern` — the
  // SAME pattern handed to voice.play, so the mouth's waves pulse in step with the
  // syllables. Independent of mode (the dealer stands, emotes, and may even walk off still
  // emoting at game over); overwriting simply restarts. Silent dealers never call this
  // (game-view skips them via voiceSeedFor).
  emote(startAfter: number, pattern: VoicePattern): void {
    this.emoteStart_ = startAfter
    this.emotePattern_ = pattern
  }

  // The emote currently armed (its absolute start stamp + pattern), or null if the dealer
  // has never emoted. Exposed so a companion (the dealer-6 clown) can mirror the dealer's
  // laughs onto its own mouth on a slight delay — it edge-detects a change in `start`.
  currentEmote(): { start: number; pattern: VoicePattern } | null {
    return this.emotePattern_ ? { start: this.emoteStart_, pattern: this.emotePattern_ } : null
  }

  // Walk-off progress (0..1) as the dealer leaves to the right, or null when it's still
  // standing (before `walkoffStart`) or already gone.
  leaving(now: number): number | null {
    if (this.mode_ !== 'walkoff') {
      return null
    }
    const p = (now - this.walkoffStart_) / KILL_ARRIVE_MS
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
    const start = this.walkClock_()
    if (start === null) {
      return 0
    }
    if (start !== this.walkStart_) {
      this.walkStart_ = start
      this.stepsFired_ = 0
    }
    // The WALK_STEPS visible strides on the felt (each on a |sin| bob dip, render/dealer.ts), plus
    // ONE extra footfall at the OFF-SCREEN edge of the walk — a first thud as a walk-in enters from
    // the edge, or a last thud as a walk-off clears it off-screen.
    const fractions = this.footstepFractions_()
    let fired = 0
    while (this.stepsFired_ < fractions.length && now >= start + fractions[this.stepsFired_] * KILL_ARRIVE_MS) {
      this.stepsFired_ += 1
      fired += 1
    }
    return fired
  }

  // Footfall timings (fractions of KILL_ARRIVE_MS): the WALK_STEPS on-felt strides, plus one at the
  // OFF-SCREEN edge — prepended for a walk-in (entering from the edge), appended for a walk-off
  // (stepping off past it). Kept in time order so they fire sequentially.
  private footstepFractions_(): number[] {
    const steps: number[] = []
    for (let i = 0; i < WALK_STEPS; i += 1) {
      steps.push((i + 0.5) / WALK_STEPS)
    }
    // A walk-OFF keeps striding off past the edge: one more footfall a FULL beat after the last
    // on-felt stride (so the rhythm stays even), landing once it's fully off-screen. A walk-in's
    // first stride already lands as it enters from the edge, so it needs no extra one.
    if (this.mode_ === 'walkoff') {
      steps.push((WALK_STEPS + 0.5) / WALK_STEPS)
    }
    return steps
  }

  // True while a strike/hit/kill/walk sequence is playing — keeps the GameView loop alive across
  // it. For a HIT this now spans the whole bounded damage window (DAMAGE_ANIM_MS): the sparks/
  // smoke/flicker/tremor all fire inside it, so this single signal drives the loop-liveness and
  // cast repaint for the entire damage reaction, identically in both battery modes. Outside any
  // sequence the dealer is mint and static, so the loop parks (in saver) as before.
  isSequencing(now: number): boolean {
    return this.mode_ !== 'none' && now < this.seqEnd_
  }

  // True while the mouth is mid-emote (an evil laugh). This animation is driven purely
  // by the voice envelope and is NOT reported by isSequencing() (see emoteStart_ note) — battery
  // saver queries it so it never parks the loop and freezes the mouth mid-laugh.
  isEmoting(now: number): boolean {
    return this.voice(now) !== null
  }

  // True across the whole kill, so buttons stay disabled for the entire death →
  // walk-in → recharge pause (a plain hit never blocks). A death-only kill blocks
  // just through the death — the deferred walk-in re-blocks later on its own.
  isBlocking(now: number): boolean {
    if (this.mode_ !== 'kill') {
      return false
    }
    const blockEnd = this.killStart_ + (this.killWalkIn_ ? KILL_TOTAL_MS : KILL_DEATH_MS)
    return now >= this.killStart_ && now < blockEnd
  }

  // The damage bursts (sparks + smoke) erupting off the figure this frame: empty outside the
  // bounded damage window (damageFxIntensity_ is 0 there), otherwise one entry per burst still
  // within its life window, firing faster as health nears zero. Time-quantized off `now` (no
  // persisted state); the renderer draws each from its age + seed. `maxTs` is the window end
  // (damageWindowEnd): a burst is only spawned if it can FULLY fade (≈FX_BURST_LIFE) before then,
  // so the effect thins out and finishes clean — no half-born spark cut off when the window ends.
  // The CALLER also gates drawing on the figure standing at its home spot (not dying/arriving/
  // leaving), so bursts never show detached during a transition.
  damageBursts(now: number, maxTs: number): DamageBurstState[] {
    const power = this.damageFxIntensity_(now)
    if (power <= 0) {
      return []
    }
    const interval = FX_MIN_INTERVAL + (FX_MAX_INTERVAL - FX_MIN_INTERVAL) * (1 - power)
    const first = Math.max(0, Math.ceil((now - FX_BURST_LIFE) / interval))
    // Stop spawning once a fresh burst couldn't finish before the window closes (fade-out cap).
    const last = Math.min(Math.floor(now / interval), Math.floor((maxTs - FX_BURST_LIFE) / interval))
    const bursts: DamageBurstState[] = []
    for (let k = first; k <= last; k++) {
      bursts.push({ age: now - k * interval, power, seed: k })
    }
    return bursts
  }

  // End of the active hit's damage window — the maxTs the spark spawner caps its fade-out against.
  // 0 when no hit window is open (idle / kill / walk), where damageBursts returns [] anyway.
  damageWindowEnd(): number {
    return this.mode_ === 'hit' ? this.seqEnd_ : 0
  }

  // --- DealerView --------------------------------------------------------------

  alive(now: number): boolean {
    if (this.mode_ === 'spawn') {
      // A deferred walk-in is parked/gone until it actually begins (its start may be
      // scheduled a beat ahead — e.g. while the upgrade selector is still up).
      return now >= this.spawnStart_
    }
    if (this.mode_ === 'walkoff') {
      // Standing (before the walk-off) or striding off; gone once it clears the edge.
      return now < this.walkoffStart_ + KILL_ARRIVE_MS
    }
    if (this.mode_ !== 'kill') {
      return true
    }
    const goneStart = this.killStart_ + KILL_DEATH_LEAD_MS + KILL_DYING_MS
    if (this.final_ || !this.killWalkIn_) {
      return now < goneStart // dies and stays gone (no walk-in in this sequence)
    }
    const goneEnd = goneStart + KILL_GONE_MS
    return !(now >= goneStart && now < goneEnd)
  }

  hit(now: number): { flash: number; shakeX: number; shakeY: number } {
    if (this.mode_ === 'none') {
      return NO_HIT
    }
    const start = this.hitStart_
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

  // The ambient low-health tremor offset for this frame (headR-fraction units, summed with
  // the hit shake by the renderer). Fires as discrete, always-noticeable pulses whose spacing
  // shrinks with damage. Off above 50% health and mid-transition (death / walk-in / walk-off
  // — the figure is moving as a whole then).
  tremor(now: number): { x: number; y: number } {
    if (this.dying(now) !== null || this.arriving(now) !== null || this.leaving(now) !== null) {
      return NO_TREMOR
    }
    const power = this.tremorIntensity_(now)
    if (power <= 0) {
      return NO_TREMOR
    }
    // Shudders fire as discrete pulses spaced by an interval that shrinks LINEARLY with
    // damage. Each slot's pulse is nudged off `k·interval` by a hashed jitter, so check the
    // nearest few slots to see whether one's pulse is live right now (they never overlap —
    // the pulse is far shorter than the smallest interval).
    const interval = TREMOR_MAX_INTERVAL + (TREMOR_MIN_INTERVAL - TREMOR_MAX_INTERVAL) * power
    const k = Math.round(now / interval)
    for (let kk = k - 1; kk <= k + 1; kk++) {
      const center = (kk + TREMOR_JITTER * (latticeHash(kk) - 0.5)) * interval
      const dt = now - center
      if (Math.abs(dt) >= TREMOR_PULSE_MS / 2) {
        continue
      }
      // Swell in then out over the pulse (a cos hump: 0 at the edges → 1 at the centre) so it
      // ramps rather than popping on. The peak magnitude is CONSTANT — never scaled by health.
      const env = 0.5 * (1 + Math.cos((dt / (TREMOR_PULSE_MS / 2)) * Math.PI))
      const amp = TREMOR_AMP * env
      // A fast rattle: two incommensurate sines per axis at different phases, so the figure
      // shudders in a little Lissajous scribble rather than sliding along one line. y is
      // damped (it rocks more side-to-side than up-down).
      const rx = 0.5 * (Math.sin(now * 0.13) + Math.sin(now * 0.207 + 1.3))
      const ry = 0.5 * (Math.sin(now * 0.11 + 2.1) + Math.sin(now * 0.233 + 4.7))
      return { x: rx * amp, y: ry * amp * 0.7 }
    }
    return NO_TREMOR
  }

  // Tremor intensity, 0..1: 0 at/above 50% health, ramping linearly to 1 as it empties. Sets
  // how far the shudder interval is compressed toward its ~1/sec floor (NOT the magnitude).
  private tremorIntensity_(now: number): number {
    if (!this.inDamageWindow_(now)) {
      return 0 // outside the damage window the figure is steady (mint)
    }
    const level = this.currentLevel_(now)
    if (level >= TREMOR_THRESHOLD) {
      return 0
    }
    return clamp01((TREMOR_THRESHOLD - level) / TREMOR_THRESHOLD)
  }

  // Scared-brow reaction (0 = resting angry brows, 1 = full worried tilt). Snaps up
  // at impact, holds through the shake, then rolls back over BROW_FEAR_FALL_MS. On a
  // kill it's cut short when the figure breaks apart (dying() takes over the draw).
  browFear(now: number): number {
    if (this.mode_ === 'none') {
      return 0
    }
    const t = now - this.hitStart_
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
    if (this.mode_ === 'kill' && !this.final_ && this.killWalkIn_) {
      const arriveStart = this.killStart_ + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
      return now >= arriveStart ? this.shift_ : this.killFromShift_
    }
    if (this.mode_ === 'kill') {
      // Final kill / death-only: the dying dealer keeps its colour (no walk-in here).
      return this.killFromShift_
    }
    return this.shift_
  }

  // The mouth readout for this frame, or null when the dealer isn't emoting. Reads the
  // shared laugh envelope so the panel's glow + wave amplitude track the syllables, and
  // hands the renderer the pattern's per-dealer wave look.
  voice(now: number): VoiceEmote | null {
    const pattern = this.emotePattern_
    if (!pattern) {
      return null
    }
    const env = voiceEnvelope(pattern, now - this.emoteStart_)
    if (!env) {
      return null
    }
    return {
      open: env.open,
      energy: env.energy,
      waveCount: pattern.waveCount,
      cycles: pattern.waveCycles,
      flowHz: pattern.waveFlowHz,
    }
  }

  dying(now: number): number | null {
    if (this.mode_ !== 'kill') {
      return null
    }
    const start = this.killStart_ + KILL_DEATH_LEAD_MS
    if (now < start || now >= start + KILL_DYING_MS) {
      return null
    }
    return (now - start) / KILL_DYING_MS
  }

  arriving(now: number): number | null {
    const start = this.walkInStart_()
    if (start === null || now < start || now >= start + KILL_ARRIVE_MS) {
      return null
    }
    return (now - start) / KILL_ARRIVE_MS
  }

  // The absolute timestamp the current walk-in slide begins — a standalone spawn, or
  // a kill's replacement arrival — or null when no walk-in is in play (final / death-
  // only kills have none). Shared by arriving() and the footstep tracker so the bob
  // and its step sfx key off one clock.
  private walkInStart_(): number | null {
    if (this.mode_ === 'spawn') {
      return this.spawnStart_
    }
    if (this.mode_ === 'kill' && !this.final_ && this.killWalkIn_) {
      return this.killStart_ + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
    }
    return null
  }

  // The absolute start of the current WALK (in OR off) for footstep timing — both stride
  // WALK_STEPS times over KILL_ARRIVE_MS. null when neither is in play.
  private walkClock_(): number | null {
    return this.mode_ === 'walkoff' ? this.walkoffStart_ : this.walkInStart_()
  }

  // Bright red LED brightness (0..1) for the eye cores on the figure: 1 when
  // healthy, stuttering toward 0 as a low-health dealer's eyes flicker. Shares its
  // flicker signal with eyeGlow so the core and its halo blink in step.
  eyeCore(now: number): number {
    return this.flicker_(now)
  }

  eyeGlow(now: number): number {
    if (this.mode_ === 'walkoff') {
      // The glow sits at the FIXED eye position (drawn on the mask, which doesn't
      // follow the figure's translate), so dim it out over the first 30% of the walk-off
      // — before the figure has strode far — rather than leaving a glow behind at centre.
      const lp = clamp01((now - this.walkoffStart_) / KILL_ARRIVE_MS)
      const ramp = lp < 0.3 ? 1 - lp / 0.3 : 0
      return BASE_GLOW * ramp * this.flicker_(now)
    }
    if (this.mode_ === 'spawn') {
      // Ignite as the figure nears home — the same re-ignite curve a kill's
      // replacement uses (only the last 40% of the slide, by when it's ~settled).
      const ap = clamp01((now - this.spawnStart_) / KILL_ARRIVE_MS)
      const ramp = ap < 0.6 ? 0 : (ap - 0.6) / 0.4
      return BASE_GLOW * ramp * this.flicker_(now)
    }
    if (this.mode_ === 'kill') {
      const dyingStart = this.killStart_ + KILL_DEATH_LEAD_MS
      if (now < dyingStart) {
        return BASE_GLOW + this.hitFlare_(now)
      }
      const dyingEnd = dyingStart + KILL_DYING_MS
      if (now < dyingEnd) {
        return BASE_GLOW * (1 - (now - dyingStart) / KILL_DYING_MS) // dim out as it dies
      }
      if (this.final_ || !this.killWalkIn_) {
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
    if (this.mode_ === 'hit') {
      return (BASE_GLOW + this.hitFlare_(now)) * this.flicker_(now)
    }
    return BASE_GLOW * this.flicker_(now)
  }

  // --- StrikeView --------------------------------------------------------------

  beam(now: number): { travel: number; alpha: number } | null {
    if (!this.striking_()) {
      return null
    }
    const travelEnd = this.strikeStart_ + STRIKE_TRAVEL_MS
    const fadeEnd = travelEnd + STRIKE_FADE_MS
    if (now < this.strikeStart_ || now >= fadeEnd) {
      return null
    }
    if (now < travelEnd) {
      return { travel: (now - this.strikeStart_) / STRIKE_TRAVEL_MS, alpha: 1 }
    }
    return { travel: 1, alpha: 1 - smoothStart2((now - travelEnd) / STRIKE_FADE_MS) }
  }

  muzzle(now: number): number | null {
    if (!this.striking_()) {
      return null
    }
    const dur = STRIKE_TRAVEL_MS + 120
    if (now < this.strikeStart_ || now >= this.strikeStart_ + dur) {
      return null
    }
    return arch2((now - this.strikeStart_) / dur)
  }

  impactSpark(now: number): number | null {
    if (!this.striking_()) {
      return null
    }
    if (now < this.hitStart_ || now >= this.hitStart_ + IMPACT_SPARK_MS) {
      return null
    }
    return (now - this.hitStart_) / IMPACT_SPARK_MS
  }

  // Whether a laser strike is actually in play — only a hit or a kill fires one. A
  // 'spawn' walk-in (page load / new run) must NOT, or its stale strikeStart (0)
  // would draw a phantom beam while performance.now() is still small on load.
  private striking_(): boolean {
    return this.mode_ === 'hit' || this.mode_ === 'kill'
  }

  // The bounded post-hit damage window [impact, impact + DAMAGE_ANIM_MS). Only a HIT opens one;
  // outside it (idle, or during a kill / walk-in / walk-off) all four damage visuals are off and
  // the dealer reads as mint — full eye glow, no sparks/smoke/flicker/tremor. This is what turns
  // the old unbounded low-health ambient into a self-contained reaction that ends after DAMAGE_ANIM_MS.
  private inDamageWindow_(now: number): boolean {
    return this.mode_ === 'hit' && now >= this.hitStart_ && now < this.seqEnd_
  }

  // The health fraction the damage FX should reflect right now: the previously-shown level
  // until a scheduled strike lands (`levelAt`), then the new level. Within the damage window
  // now >= levelAt_ (== hitStart_) always holds, so this returns the post-hit level_; the
  // prevLevel_ hold only matters at the click, before the window opens.
  private currentLevel_(now: number): number {
    return now >= this.levelAt_ ? this.level_ : this.prevLevel_
  }

  // How badly the dealer's eyes are failing (0 = healthy, 1 = near death), from the health
  // fraction currently in effect: 0 at/above the damage threshold, ramping to 1 as it
  // approaches empty. Drives both the flicker and whether the loop keeps ticking.
  private damageIntensity_(now: number): number {
    if (!this.inDamageWindow_(now)) {
      return 0 // outside the damage window the eyes glow steady (mint)
    }
    const level = this.currentLevel_(now)
    if (level <= 0 || level >= DAMAGE_THRESHOLD) {
      return 0
    }
    return clamp01((DAMAGE_THRESHOLD - level) / DAMAGE_THRESHOLD)
  }

  // Damage-FX intensity, 0..1: 0 at/above FX_THRESHOLD, ramping to 1 as health empties.
  // Sets the spark/smoke burst frequency + density. Unlike damageIntensity() (the eye
  // flicker) it does NOT zero out at level 0 — a near-dead standing dealer sparks hardest.
  private damageFxIntensity_(now: number): number {
    if (!this.inDamageWindow_(now)) {
      return 0 // outside the damage window no sparks/smoke fire (mint)
    }
    const level = this.currentLevel_(now)
    if (level >= FX_THRESHOLD) {
      return 0
    }
    return clamp01((FX_THRESHOLD - level) / FX_THRESHOLD)
  }

  // Eye-flicker multiplier (0..1): 1 when healthy, an irregular on/off stutter once
  // below the damage threshold. As the dealer nears death (k → 1) the stutter runs
  // faster, dips into the "off" state more often, and cuts fully dark instead of a
  // shallow dim. The signal is summed incommensurate sines (time-driven, so it
  // flickers smoothly rather than jittering per frame).
  private flicker_(now: number): number {
    const k = this.damageIntensity_(now)
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
  private hitFlare_(now: number): number {
    const start = this.hitStart_
    if (now < start || now >= start + HIT_MS) {
      return 0
    }
    const u = 1 - (now - start) / HIT_MS
    return 0.6 * u * u
  }
}

const NO_HIT = { flash: 0, shakeX: 0, shakeY: 0 }
const NO_TREMOR = { x: 0, y: 0 }

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

// Deterministic [0,1] hash of an integer slot — jitters each tremor pulse off its `k·interval`
// slot so the cadence looks random rather than metronomic. `Math.sin` hashing (never
// Math.random), a pure function of the slot index, matching the house effect style.
function latticeHash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}
