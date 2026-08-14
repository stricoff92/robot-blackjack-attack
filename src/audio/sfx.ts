// The sound-effects service: one WebAudio graph dedicated to short one-shot
// game sounds, kept separate from the music service (each owns its own
// AudioContext so their master levels never fight and either can be muted
// independently later).
//
// Every clip is fetched + decoded once on load() into an AudioBuffer, so a
// play() is just a fresh BufferSource → per-sound gain → destination — no
// network, no shared node to cut off a still-ringing copy. Each sound carries
// a base gain (all 1.0 for now) that setGain() can retune at runtime, and an
// optional playback-rate jitter so repeated draws/moves don't sound identical.

import { createAudioContext } from './context'

// Vite fingerprints each asset URL; fetch() then pulls it (from cache after the
// first load) for decodeAudioData.
import shuffleUrl from '../assets/oxidvideos-shuffling-deck-of-cards-522518.m4a'
import drawCardUrl from '../assets/oxidvideos-taking-playing-card-3-522513.mp3'
import upgradeMenuUrl from '../assets/upgrade-menu-open.m4a'
import upgradeSelectedUrl from '../assets/upgrade-selected.m4a'
import abilityUrl from '../assets/ability.m4a'
import playerLostUrl from '../assets/player-lost.m4a'
import playerWonUrl from '../assets/player-won.m4a'
import packagingOpeningUrl from '../assets/packaging-opening.m4a'
import packagingRustlingUrl from '../assets/packaging-rustling.m4a'
import shredderUrl from '../assets/edr-paper-shredder-02-421981.m4a'
import laserPrepareUrl from '../assets/DSGNSynth_CAST-Mecha Laser Prepare_HY_PC-005.m4a'
import laserImpactUrl from '../assets/FGHTImpt_HIT-Strong Punch_HY_PC-004.m4a'
import dealerDeathUrl from '../assets/DSGNMisc_SKILL IMPACT-Whimsimpact_HY_PC-005.m4a'
import footstepUrl from '../assets/FEETMisc_STEP-Boots on Concrete Dungeon_HY_PC-002.m4a'
import handClapUrl from '../assets/freesound_community-hand-clap-106596.m4a'

export type SfxName =
  | 'shuffle'
  | 'draw-card'
  | 'upgrade-menu'
  | 'upgrade-selected'
  | 'ability'
  | 'player-lost'
  | 'player-won'
  | 'packaging-opening'
  | 'packaging-rustling'
  | 'shredder'
  | 'laser-prepare'
  | 'laser-impact'
  | 'dealer-death'
  | 'footstep'
  | 'hand-clap'

interface SfxDef {
  url: string
  /** Base gain (1 = 100%); setGain() can override at runtime. */
  gain: number
  /**
   * Fractional playback-rate jitter: each play picks a rate in
   * [1 - variance, 1 + variance]. 0 = always play at the recorded pitch.
   */
  rateVariance: number
}

// Synthesised tones — generated on the fly with an oscillator rather than a
// decoded clip, so they ship no asset. Same base-gain + rate-jitter knobs as the
// sampled sounds (here the jitter scales the whole pitch sweep).
export type ToneName = 'token-launch' | 'token-land' | 'score-delta-land'

interface ToneDef {
  wave: OscillatorType
  fromHz: number // sweep start (med)
  toHz: number // sweep end (high) — rising reads as positive
  durationMs: number
  gain: number
  /** Fractional pitch jitter: each play scales both freqs by [1-v, 1+v]. */
  rateVariance: number
}

const TONES: Record<ToneName, ToneDef> = {
  // A short rising blip as each reward token shoots out of the nexus vent. Many
  // fire in quick succession (a split's two wins, the +40 kill burst), so it's
  // pitch-jittered to avoid a monotone machine-gun.
  'token-launch': { wave: 'triangle', fromHz: 520, toHz: 1040, durationMs: 130, gain: 0.32, rateVariance: 0.2 },
  // The answering ping as a burst reaches the counter and the count ticks up — a
  // brighter, cleaner sine a fifth above the launch's top, so launch → land reads
  // as a positive call-and-response. Jittered too, since bursts also land in bunches.
  'token-land': { wave: 'sine', fromHz: 1046, toHz: 1568, durationMs: 90, gain: 0.26, rateVariance: 0.2 },
  // A soft bell as a fly-in "+N" score delta reaches its row below the counter. A rounded triangle,
  // distinct from the token pings, with LOW jitter so a kill's ascending cash-in reads as a clean
  // rising run when each land is played at a stepped pitchScale (see GameView).
  'score-delta-land': { wave: 'triangle', fromHz: 660, toHz: 990, durationMs: 130, gain: 0.3, rateVariance: 0.05 },
}

const SFX: Record<SfxName, SfxDef> = {
  // The deck riffle at the end of a hand.
  shuffle: { url: shuffleUrl, gain: 1, rateVariance: 0 },
  // A single card flying out of the shoe — jittered so a full deal doesn't machine-gun.
  'draw-card': { url: drawCardUrl, gain: 0.6, rateVariance: 0.25 },
  // The choose-upgrade buttons surfacing after a kill.
  'upgrade-menu': { url: upgradeMenuUrl, gain: 1, rateVariance: 0 },
  // An upgrade path being picked.
  'upgrade-selected': { url: upgradeSelectedUrl, gain: 1, rateVariance: 0 },
  // A powerup / ability fired (peek, return, freeze…).
  ability: { url: abilityUrl, gain: 0.6, rateVariance: 0.25 },
  // The hand result revealed against the player — the source is hot (louder than the rest at full
  // gain) so it's still trimmed, but raised from 0.5 so the loss sting reads clearly on the summary.
  'player-lost': { url: playerLostUrl, gain: 0.8, rateVariance: 0.25 },
  // The hand result revealed in the player's favour — turned down to match.
  'player-won': { url: playerWonUrl, gain: 0.5, rateVariance: 0.25 },
  // The fresh deck's shrink-wrap tearing open (the edge strip peeling off).
  'packaging-opening': { url: packagingOpeningUrl, gain: 1, rateVariance: 0 },
  // The big plastic sheet rustling off to the left, uncovering the deck.
  'packaging-rustling': { url: packagingRustlingUrl, gain: 1, rateVariance: 0 },
  // The paper shredder chewing cards. Not a one-shot — startShredding() loops it and
  // fades it out (see below); loaded here so it's decoded up front like the rest.
  shredder: { url: shredderUrl, gain: 0.9, rateVariance: 0 },
  // The nexus laser firing at the dealer — turned down; the attack was overbearing.
  'laser-prepare': { url: laserPrepareUrl, gain: 0.5, rateVariance: 0 },
  // The beam impacting the dealer as damage is dealt (a heavy hit) — turned down too.
  'laser-impact': { url: laserImpactUrl, gain: 0.43, rateVariance: 0 },
  // The dealer figure blowing apart when killed.
  'dealer-death': { url: dealerDeathUrl, gain: 0.9, rateVariance: 0 },
  // A boot landing as the dealer walks in — fired once per footfall (see the walk-in
  // bob). Rate-jittered ±25% so the three steps of a single walk-in don't sound
  // machine-stamped identical.
  footstep: { url: footstepUrl, gain: 0.6, rateVariance: 0.25 },
  // A slow hand-clap the Banker gives when the player wins a coda hand — fired as the
  // banker-hand-win scoreboard appears. Played through playHandClap (a robotic re-voicing,
  // see HAND_CLAP_*), NOT the plain play() path — this def just gets the sample decoded up
  // front. gain/rateVariance here only apply if play('hand-clap') is used for A/B comparison.
  'hand-clap': { url: handClapUrl, gain: 0.7, rateVariance: 0 },
}

// Peak level of the synth vacuum drone that accompanies the shredder.
const VACUUM_GAIN = 0.16

// Master level of the synth "repair beam" (playHeal) — kept gentle so the dealer's
// heal reads as soft restorative light, not a second blast.
const HEAL_GAIN = 0.2

// Master level of the synth "points roll" (playPointsRoll) — the ticking flutter under
// the score counter as it climbs. Sustained, so kept quiet under the token-land pings.
const POINTS_ROLL_GAIN = 0.12

// The Banker's slow clap — a ROBOTIC re-voicing (playHandClap). The raw sample reads as a cheap
// soundboard clap that doesn't fit the game, so each slap is run through a filter chain into a
// metallic, servo-driven CLANK that matches the robot dealers. Every value is tunable — nudge to
// taste (there's no way to A/B this by ear from code):
//   RATE     — playback speed; < 1 pitches DOWN → heavier, slower, more mechanical.
//   HP_HZ    — highpass cutoff; raise to strip the organic "boxy" body, lower to keep weight.
//   BAND_HZ  — centre of the resonant metal body; BAND_Q — its ring (higher = more tin/clank).
//   RING_HZ  — ring-modulator carrier, i.e. the robot timbre. Low (~120) = deep clank, high (~400) = buzzy.
//   RING_MIX — 0 = filtered clap only, 1 = fully ring-modulated (most alien). ~0.5 keeps it a readable clap.
//   DRIVE    — soft-clip grit for a digital edge; 0 = clean.
//   BODY_MS / TAIL_MS / FLOOR — a per-clap "de-reverb" gate. The sample is a slow sarcastic clap
//     (several slaps ~1s apart, each trailing a long room tail — that tail IS the "echo"). After each
//     detected slap the level holds full for BODY_MS, then ramps down to FLOOR over TAIL_MS and stays
//     there through the gap until the next slap — so every clap still sounds but its reverb is dried.
//     FLOOR 1 = no drying (raw echo); lower = drier. TAIL_MS = 0 disables the gate (raw sample plays).
//   ONSET_THRESH / ONSET_GAP_MS — slap detection over the decoded buffer: a sample starts a new slap
//     when |amp| ≥ THRESH and ≥ GAP_MS have passed since the last (debounce; claps are ~1s apart and
//     the reverb between them stays under THRESH). Found once and cached (clapOnsets_).
// To hear the untreated sample for comparison, call sfx.play('hand-clap') instead of playHandClap().
const HAND_CLAP_GAIN = 0.85
const HAND_CLAP_RATE = 0.82
const HAND_CLAP_HP_HZ = 320
const HAND_CLAP_BAND_HZ = 1250
const HAND_CLAP_BAND_Q = 6
const HAND_CLAP_RING_HZ = 200
const HAND_CLAP_RING_MIX = 0.42
const HAND_CLAP_DRIVE = 0.1
const HAND_CLAP_BODY_MS = 120
const HAND_CLAP_TAIL_MS = 140
const HAND_CLAP_FLOOR = 0.12
const HAND_CLAP_ONSET_THRESH = 0.2
const HAND_CLAP_ONSET_GAP_MS = 400

// The Banker's hand actuators winding in and out around each clap — a synthesised servo whine
// choreographed onto the detected slaps (see playServoWhine_). Per clap: a RISING "hands closing"
// whine that climbs to a peak landing right on the slap, then (after a short delay) a FALLING
// "hands separating" whine as they retract. The clap timing is untouched — the whines hang off it.
//   GAIN        — peak level; sits under the clap. 0 disables the whine entirely.
//   CLOSE_MS    — the closing whine's length; it ENDS on the slap, so it starts CLOSE_MS before it.
//   SEP_MS      — the separating whine's length.
//   SEP_DELAY_MS— the short gap between the clap and the separating whine starting.
//   WAVE        — motor timbre: 'sawtooth' is buzzy/mechanical, 'triangle'/'sine' softer (but purer =
//                 more flute-like, so lean buzzy and let GAIN keep it subtle).
//   HZ_LO/HZ_HI — the pitch glide range. Keep it NARROW: a wide smooth glide reads as a slide-whistle,
//                 not a servo. Closing sweeps LO→HI (winds up into the slap), separating HI→LO.
//   NOISE_MIX   — level of a band-limited noise grind mixed under the tone (motor friction/gear). This
//                 is the main "it's a motor, not a whistle" cue, and it adds character without volume.
//   FORMANT_HZ / FORMANT_Q — a gentle bandpass shaping both tone and grind to the whine's register.
//   BUZZ_HZ / BUZZ_DEPTH   — a fast tremolo chopping the sound for the mechanical motor buzz (0 = smooth).
const SERVO_WAVE: OscillatorType = 'sawtooth'
const SERVO_GAIN = 0.15
const SERVO_CLOSE_MS = 280
const SERVO_SEP_MS = 240
const SERVO_SEP_DELAY_MS = 110
const SERVO_HZ_LO = 480
const SERVO_HZ_HI = 660
const SERVO_NOISE_MIX = 0.3
const SERVO_FORMANT_HZ = 1200
const SERVO_FORMANT_Q = 1.2
const SERVO_BUZZ_HZ = 70
const SERVO_BUZZ_DEPTH = 0.3

class SfxService {
  private ctx_: AudioContext | null = null
  // A master gain every sound routes through, so the platform mute (CrazyGames settings.muteAudio)
  // can silence all SFX at once. Created alongside the context.
  private master_: GainNode | null = null
  private muted_ = false
  private readonly buffers_ = new Map<SfxName, AudioBuffer>()
  private readonly gains_ = new Map<SfxName, number>()
  private loadPromise_: Promise<void> | null = null
  // Sustained "shredding bed" voices (looping shredder sample + synth vacuum drone),
  // held live so they can be ramped down — unlike the fire-and-forget one-shots.
  private shredVoices_: { gain: GainNode; sources: AudioScheduledSourceNode[] }[] = []
  private noise_: AudioBuffer | null = null
  // Cached soft-clip curve for the robotic hand-clap's grit stage (HAND_CLAP_DRIVE is constant).
  // Typed over ArrayBuffer (not ArrayBufferLike) to satisfy WaveShaperNode.curve's signature.
  private clapCurve_: Float32Array<ArrayBuffer> | null = null
  // Slap onset times (seconds into the raw sample) for the slow clap, found once so the per-clap
  // de-reverb gate can hold full at each slap and dry the room tail between them. null until computed
  // (see clapOnsets_).
  private clapOnsetsSec_: number[] | null = null

  constructor() {
    for (const name of Object.keys(SFX) as SfxName[]) {
      this.gains_.set(name, SFX[name].gain)
    }
  }

  // Download + decode every clip. Idempotent: repeated calls share one load.
  load(): Promise<void> {
    if (!this.loadPromise_) {
      this.loadPromise_ = this.loadAll_()
    }
    return this.loadPromise_
  }

  // Retune a sound's base level (1 = 100%). Applies to subsequent plays.
  setGain(name: SfxName, gain: number): void {
    this.gains_.set(name, gain)
  }

  // Platform mute toggle (CrazyGames settings.muteAudio). Silences the master gain; already-
  // scheduled one-shots ring out but nothing new is audible, and continuous beds (shredder) mute too.
  setMuted(muted: boolean): void {
    this.muted_ = muted
    if (this.master_) {
      this.master_.gain.value = muted ? 0 : 1
    }
  }

  // Fire a one-shot. No-op until the clip has finished decoding (so early
  // calls during load simply drop rather than throw). `delaySeconds` schedules it
  // into the future — used to lead a charge-up sound into the event it precedes.
  play(name: SfxName, delaySeconds = 0): void {
    const ctx = this.ctx_
    const buffer = this.buffers_.get(name)
    if (!ctx || !buffer) {
      return
    }
    // Browsers hand back a suspended context until a user gesture; nudge it
    // awake so sounds that follow the first interaction actually play.
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const variance = SFX[name].rateVariance
    if (variance > 0) {
      source.playbackRate.value = 1 + (Math.random() * 2 - 1) * variance
    }
    const gain = ctx.createGain()
    gain.gain.value = this.gains_.get(name) ?? 1
    source.connect(gain).connect(this.master_ ?? ctx.destination)
    source.start(ctx.currentTime + Math.max(0, delaySeconds))
  }

  // Fire a synthesised tone: an oscillator sweeping fromHz → toHz under a quick
  // attack + exponential decay, pitch-jittered per play. No buffer needed, so it
  // works the instant the context exists (no wait on load()). `delaySeconds`
  // schedules it into the future — used to cascade a burst's per-token blips.
  // `pitchScale` multiplies the whole sweep on top of the jitter — 1 = the tone's natural pitch; the
  // caller can step it up across a run (e.g. a kill's ascending cash-in) for a rising arpeggio.
  playTone(name: ToneName, delaySeconds = 0, pitchScale = 1): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const def = TONES[name]
    const t0 = ctx.currentTime + Math.max(0, delaySeconds)
    const dur = def.durationMs / 1000
    // ±rateVariance around 1 scales the whole sweep (a pitch shift, like a
    // playback-rate change), so consecutive blips don't sound identical.
    const scale = pitchScale * (1 + (Math.random() * 2 - 1) * def.rateVariance)

    const osc = ctx.createOscillator()
    osc.type = def.wave
    osc.frequency.setValueAtTime(def.fromHz * scale, t0)
    osc.frequency.exponentialRampToValueAtTime(def.toHz * scale, t0 + dur)

    const gain = ctx.createGain()
    // Fast attack, then decay toward silence (exponential can't reach 0, so a tiny
    // floor). Keeps the blip click-free even when several overlap.
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(def.gain, t0 + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(gain).connect(this.master_ ?? ctx.destination)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
    }
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  // A synthesised "points roll": the sound the score counter makes while it ticks up.
  // A bright tone glides up an octave (tracking the number climbing) while a fast square
  // LFO gates it into a run of rapid ticks — a slot-machine-style count-up flutter. Lasts
  // `durationMs` so it covers exactly the visible roll. Fully synthesised (no buffer), and
  // distinct from the token blips so the score reads as its own reward.
  playPointsRoll(durationMs: number): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const t0 = ctx.currentTime
    const dur = Math.max(0.12, durationMs / 1000) // floor so a tiny roll still sounds

    // Master envelope: quick attack, hold, quick release — click-free start and stop.
    const out = ctx.createGain()
    out.gain.setValueAtTime(0, t0)
    out.gain.linearRampToValueAtTime(POINTS_ROLL_GAIN, t0 + 0.02)
    out.gain.setValueAtTime(POINTS_ROLL_GAIN, t0 + Math.max(0.02, dur - 0.05))
    out.gain.linearRampToValueAtTime(0, t0 + dur)
    out.connect(this.master_ ?? ctx.destination)

    // A fast square LFO drives a gain between 0 and 1, chopping the tone into the ticks
    // (32/sec) that read as the counter rattling upward.
    const trem = ctx.createGain()
    trem.gain.value = 0.5
    trem.connect(out)
    const lfo = ctx.createOscillator()
    lfo.type = 'square'
    lfo.frequency.value = 32
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 0.5
    lfo.connect(lfoDepth).connect(trem.gain)
    lfo.start(t0)
    lfo.stop(t0 + dur + 0.02)
    lfo.onended = () => {
      lfo.disconnect()
      lfoDepth.disconnect()
      trem.disconnect()
      out.disconnect()
    }

    // The tone: a bright triangle gliding up an octave as the number climbs, with a
    // quiet fifth above for a little sparkle.
    const voices: { hz: number; wave: OscillatorType; level: number }[] = [
      { hz: 660, wave: 'triangle', level: 1 },
      { hz: 990, wave: 'sine', level: 0.4 },
    ]
    for (const { hz, wave, level } of voices) {
      const osc = ctx.createOscillator()
      osc.type = wave
      osc.frequency.setValueAtTime(hz, t0)
      osc.frequency.exponentialRampToValueAtTime(hz * 2, t0 + dur)
      const v = ctx.createGain()
      v.gain.value = level
      osc.connect(v).connect(trem)
      osc.onended = () => {
        osc.disconnect()
        v.disconnect()
      }
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    }
  }

  // A synthesised "repair beam": a warm major-chord swell that glides gently upward
  // — a hopeful, restorative rise, the wholesome counterpart to the laser's blast —
  // topped with a faint high shimmer as the beam lands. All sine/triangle voices
  // under soft gain envelopes (through a warming lowpass), so it reads as gentle
  // light rather than an impact. `delaySeconds` schedules it to lead the beam. Like
  // playTone it's fully synthesised, so it needs no buffer / load().
  playHeal(delaySeconds = 0): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const t0 = ctx.currentTime + Math.max(0, delaySeconds)
    const dur = 0.9

    // Master swell for the whole heal: eased up, held, then back to silence so
    // nothing clicks on/off.
    const out = ctx.createGain()
    out.gain.setValueAtTime(0, t0)
    out.gain.linearRampToValueAtTime(HEAL_GAIN, t0 + 0.12)
    out.gain.setValueAtTime(HEAL_GAIN, t0 + dur * 0.62)
    out.gain.linearRampToValueAtTime(0, t0 + dur)
    out.connect(this.master_ ?? ctx.destination)

    // A soft lowpass keeps the chord warm (no harsh upper partials); the sparkle
    // layer below bypasses it so its twinkle still reads bright.
    const warm = ctx.createBiquadFilter()
    warm.type = 'lowpass'
    warm.frequency.value = 2600
    warm.Q.value = 0.6
    warm.connect(out)

    // The chord — G major (root, third, fifth, octave) — each voice gliding up ~a
    // semitone across the swell so the whole tone lifts (the "restore" rise). Upper
    // voices are quieter so it reads as one warm chord, not four stacked beeps.
    const chord = [392.0, 493.9, 587.3, 784.0]
    const glide = 1.06
    chord.forEach((hz, i) => {
      const osc = ctx.createOscillator()
      osc.type = i === 0 ? 'triangle' : 'sine' // a touch of body on the root
      osc.frequency.setValueAtTime(hz, t0)
      osc.frequency.linearRampToValueAtTime(hz * glide, t0 + dur)
      const v = ctx.createGain()
      v.gain.value = 0.6 / (i + 1.6)
      osc.connect(v).connect(warm)
      osc.onended = () => {
        osc.disconnect()
        v.disconnect()
      }
      osc.start(t0)
      osc.stop(t0 + dur + 0.05)
    })

    // A faint high shimmer: two quick sine pings an octave-plus up, staggered, to
    // twinkle as the beam lands — the little "heal" sparkle. Bypasses the lowpass so
    // it stays crisp; very quiet, quick exponential decay.
    const shimmer = [1568.0, 2093.0]
    shimmer.forEach((hz, i) => {
      const at = t0 + 0.2 + i * 0.12
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = hz
      const v = ctx.createGain()
      v.gain.setValueAtTime(0, at)
      v.gain.linearRampToValueAtTime(0.12, at + 0.01)
      v.gain.exponentialRampToValueAtTime(0.0001, at + 0.3)
      osc.connect(v).connect(out)
      osc.onended = () => {
        osc.disconnect()
        v.disconnect()
      }
      osc.start(at)
      osc.stop(at + 0.34)
    })
  }

  // The Banker's slow clap, re-voiced ROBOTIC. Plays the decoded sample through a filter chain
  // (see HAND_CLAP_*) so each slap lands as a metallic, servo-driven clank rather than the cheap
  // organic clap of the raw file: pitched down for weight, high-passed + band-passed to a resonant
  // metal body, part of it RING-MODULATED (multiply by a sine carrier — the classic robot timbre),
  // with a touch of soft-clip grit. No-op until the sample has decoded. `delaySeconds` leads it.
  playHandClap(delaySeconds = 0): void {
    const ctx = this.ctx_
    const buffer = this.buffers_.get('hand-clap')
    if (!ctx || !buffer) {
      return
    }
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const t0 = ctx.currentTime + Math.max(0, delaySeconds)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = HAND_CLAP_RATE // < 1 → pitched down, heavier + more mechanical

    // Strip the organic low "boxy" body, then band to a resonant metallic ring.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = HAND_CLAP_HP_HZ
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = HAND_CLAP_BAND_HZ
    band.Q.value = HAND_CLAP_BAND_Q

    // A mild soft-clip for a harsh, digital edge (skipped when DRIVE = 0).
    const shaper = ctx.createWaveShaper()
    shaper.curve = this.clapDriveCurve_()
    shaper.oversample = '2x'

    // Output bus (mute-aware via master), with a per-clap de-reverb gate. This is a slow clap of
    // several slaps ~1s apart; each trails a long room tail (the "echo"). For every detected slap we
    // hold full through BODY_MS then ramp down to FLOOR over TAIL_MS, staying at FLOOR across the gap
    // until the next slap — so all the claps still sound but their reverb is dried. Onset times are in
    // the source domain, so divide by RATE for output time. TAIL_MS = 0 (or no onsets) plays raw.
    const out = ctx.createGain()
    const onsets = this.clapOnsets_(buffer)
    if (HAND_CLAP_TAIL_MS > 0 && onsets.length > 0) {
      const body = HAND_CLAP_BODY_MS / 1000
      const tail = HAND_CLAP_TAIL_MS / 1000
      out.gain.setValueAtTime(HAND_CLAP_GAIN, t0)
      for (const onset of onsets) {
        const slap = t0 + onset / HAND_CLAP_RATE
        out.gain.setValueAtTime(HAND_CLAP_GAIN, slap) // step back up to full for this slap
        out.gain.setValueAtTime(HAND_CLAP_GAIN, slap + body) // hold the clap body
        out.gain.exponentialRampToValueAtTime(HAND_CLAP_FLOOR, slap + body + tail) // dry the tail to FLOOR
      }
    } else {
      out.gain.value = HAND_CLAP_GAIN
    }
    out.connect(this.master_ ?? ctx.destination)

    // Servo actuator whine choreographed onto the claps: a rising "hands closing" whine that lands
    // on each slap, then a falling "hands separating" whine just after it (onsets are source-domain,
    // so divide by RATE for output time). Fully synthesised, mixed alongside the clap — SERVO_GAIN 0
    // disables it. The clap interval itself is untouched.
    if (SERVO_GAIN > 0) {
      for (const onset of onsets) {
        const slap = t0 + onset / HAND_CLAP_RATE
        this.playServoWhine_(slap - SERVO_CLOSE_MS / 1000, SERVO_CLOSE_MS, true) // closing → into the slap
        this.playServoWhine_(slap + SERVO_SEP_DELAY_MS / 1000, SERVO_SEP_MS, false) // separating → after it
      }
    }

    // Parallel dry + ring-modulated paths, crossfaded by RING_MIX. Ring modulation multiplies
    // the signal by a sine carrier — implemented as a gain node whose gain (base 0) is driven by
    // the oscillator's ±1 output, so its output = signal × carrier. That inharmonic product is the
    // metallic "robot" timbre; the dry path keeps enough of the clap that it still reads as one.
    const dry = ctx.createGain()
    dry.gain.value = 1 - HAND_CLAP_RING_MIX
    dry.connect(out)

    const ring = ctx.createGain()
    ring.gain.value = 0
    const carrier = ctx.createOscillator()
    carrier.type = 'sine'
    carrier.frequency.value = HAND_CLAP_RING_HZ
    carrier.connect(ring.gain)
    const ringLevel = ctx.createGain()
    ringLevel.gain.value = HAND_CLAP_RING_MIX
    ring.connect(ringLevel).connect(out)

    source.connect(hp)
    hp.connect(band)
    band.connect(shaper)
    shaper.connect(dry)
    shaper.connect(ring)

    const stopAt = t0 + buffer.duration / HAND_CLAP_RATE + 0.05
    carrier.start(t0)
    carrier.stop(stopAt)
    carrier.onended = () => carrier.disconnect()
    source.start(t0)
    source.onended = () => {
      source.disconnect()
      hp.disconnect()
      band.disconnect()
      shaper.disconnect()
      dry.disconnect()
      ring.disconnect()
      ringLevel.disconnect()
      out.disconnect()
    }
  }

  // One servo whine for the Banker's hand actuators (see the SERVO_* block), scheduled to start at
  // absolute context time `at`. A buzzy sawtooth "motor" glides in pitch — rising (winds up into a
  // clap) when `rising`, falling (retracts) otherwise — through a resonant bandpass that gives the
  // thin electric whine, with a fast tremolo for the mechanical buzz, under a click-free envelope.
  private playServoWhine_(at: number, durationMs: number, rising: boolean): void {
    const ctx = this.ctx_
    if (!ctx) {
      return
    }
    const t = Math.max(ctx.currentTime, at)
    const dur = durationMs / 1000
    const fStart = rising ? SERVO_HZ_LO : SERVO_HZ_HI
    const fEnd = rising ? SERVO_HZ_HI : SERVO_HZ_LO

    // The motor tone: WAVE gliding across a NARROW pitch range (a wide smooth glide reads as a
    // slide-whistle; the servo character comes from the buzz + grind, not a dramatic sweep). Rises
    // winding into a slap, falls retracting.
    const osc = ctx.createOscillator()
    osc.type = SERVO_WAVE
    osc.frequency.setValueAtTime(fStart, t)
    osc.frequency.exponentialRampToValueAtTime(fEnd, t + dur)

    // A bed of band-limited noise under the tone — the motor's friction/gear grind, which is what
    // separates a servo from a pure whistle. Shares the formant + buzz with the tone below.
    const noise = ctx.createBufferSource()
    noise.buffer = this.noiseBuffer_(ctx)
    noise.loop = true
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = SERVO_NOISE_MIX

    // Bandpass — shapes both tone and grind to the whine's register.
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = SERVO_FORMANT_HZ
    band.Q.value = SERVO_FORMANT_Q

    // Fast square-LFO tremolo → mechanical buzz. trem.gain rides between (1 - depth) and 1.
    const trem = ctx.createGain()
    trem.gain.value = 1 - SERVO_BUZZ_DEPTH
    const lfo = ctx.createOscillator()
    lfo.type = 'square'
    lfo.frequency.value = SERVO_BUZZ_HZ
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = SERVO_BUZZ_DEPTH
    lfo.connect(lfoDepth).connect(trem.gain)

    // Master envelope: quick attack, hold, quick release so it never clicks.
    const out = ctx.createGain()
    out.gain.setValueAtTime(0, t)
    out.gain.linearRampToValueAtTime(SERVO_GAIN, t + 0.015)
    out.gain.setValueAtTime(SERVO_GAIN, t + Math.max(0.015, dur - 0.03))
    out.gain.linearRampToValueAtTime(0, t + dur)
    out.connect(this.master_ ?? ctx.destination)

    // tone + grind → buzz → formant → envelope
    osc.connect(trem)
    noise.connect(noiseGain).connect(trem)
    trem.connect(band).connect(out)

    const stop = t + dur + 0.02
    lfo.start(t)
    lfo.stop(stop)
    noise.start(t)
    noise.stop(stop)
    osc.start(t)
    osc.stop(stop)
    osc.onended = () => {
      osc.disconnect()
      noise.disconnect()
      noiseGain.disconnect()
      band.disconnect()
      trem.disconnect()
      lfo.disconnect()
      lfoDepth.disconnect()
      out.disconnect()
    }
  }

  // The slap onset times (seconds into the sample) of the slow clap, found once and cached by
  // scanning the decoded buffer: a sample opens a new slap when it crosses ONSET_THRESH and enough
  // time (ONSET_GAP_MS) has passed since the last, so the quieter reverb between claps is skipped.
  // Drives the per-clap de-reverb gate in playHandClap.
  private clapOnsets_(buffer: AudioBuffer): number[] {
    if (!this.clapOnsetsSec_) {
      const data = buffer.getChannelData(0)
      const sr = buffer.sampleRate
      const minGap = Math.floor((HAND_CLAP_ONSET_GAP_MS / 1000) * sr)
      const onsets: number[] = []
      let last = -minGap
      for (let i = 0; i < data.length; i += 1) {
        if (Math.abs(data[i]) >= HAND_CLAP_ONSET_THRESH && i - last >= minGap) {
          onsets.push(i / sr)
          last = i
        }
      }
      this.clapOnsetsSec_ = onsets
    }
    return this.clapOnsetsSec_
  }

  // The waveshaper curve for the hand-clap's grit, built once and reused. A standard soft-clip:
  // DRIVE 0 → effectively linear (no colour), higher → harder saturation.
  private clapDriveCurve_(): Float32Array<ArrayBuffer> {
    if (!this.clapCurve_) {
      const n = 1024
      const curve = new Float32Array(n)
      const k = HAND_CLAP_DRIVE * 100
      for (let i = 0; i < n; i += 1) {
        const x = (i / (n - 1)) * 2 - 1
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
      }
      this.clapCurve_ = curve
    }
    return this.clapCurve_
  }

  // Begin the shredding bed: the shredder clip on a loop (so it covers a shred of any
  // length) plus a synth vacuum drone. No-op if already running; stopShredding() ends it.
  startShredding(): void {
    if (this.shredVoices_.length > 0) {
      return
    }
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const buffer = this.buffers_.get('shredder')
    if (buffer) {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      const gain = ctx.createGain()
      gain.gain.value = this.gains_.get('shredder') ?? 1
      source.connect(gain).connect(this.master_ ?? ctx.destination)
      source.start()
      this.shredVoices_.push({ gain, sources: [source] })
    }
    this.shredVoices_.push(this.buildVacuum_(ctx))
  }

  // Fade the shredding bed out over `fadeMs` (kept fast so it doesn't trail past the
  // last card) and stop its sources.
  stopShredding(fadeMs: number): void {
    const ctx = this.ctx_
    if (!ctx || this.shredVoices_.length === 0) {
      this.shredVoices_ = []
      return
    }
    const t0 = ctx.currentTime
    const end = t0 + Math.max(0, fadeMs) / 1000
    for (const voice of this.shredVoices_) {
      const g = voice.gain.gain
      g.cancelScheduledValues(t0)
      g.setValueAtTime(g.value, t0)
      g.linearRampToValueAtTime(0, end) // linear → 0 is click-free even when fast
      for (const source of voice.sources) {
        source.onended = () => source.disconnect()
        source.stop(end + 0.03)
      }
    }
    this.shredVoices_ = []
  }

  // A synth vacuum drone: a sawtooth "motor" (quickly spun up) + band-limited white
  // noise "airflow", both through a lowpass — a rough mimic of a vacuum sucking the
  // cards in, to sit under the shredder.
  private buildVacuum_(ctx: AudioContext): { gain: GainNode; sources: AudioScheduledSourceNode[] } {
    const t0 = ctx.currentTime
    const out = ctx.createGain()
    out.gain.value = VACUUM_GAIN
    out.connect(this.master_ ?? ctx.destination)

    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 1200
    lowpass.Q.value = 0.7
    lowpass.connect(out)

    const sources: AudioScheduledSourceNode[] = []

    const motor = ctx.createOscillator()
    motor.type = 'sawtooth'
    motor.frequency.setValueAtTime(70, t0)
    motor.frequency.exponentialRampToValueAtTime(150, t0 + 0.18) // spin up
    motor.connect(lowpass)
    motor.start(t0)
    sources.push(motor)

    const air = ctx.createBufferSource()
    air.buffer = this.noiseBuffer_(ctx)
    air.loop = true
    const airGain = ctx.createGain()
    airGain.gain.value = 0.35
    air.connect(airGain).connect(lowpass)
    air.start(t0)
    sources.push(air)

    return { gain: out, sources }
  }

  // One second of white noise, generated once and reused (looped) as the vacuum airflow.
  private noiseBuffer_(ctx: AudioContext): AudioBuffer {
    if (!this.noise_) {
      const length = Math.floor(ctx.sampleRate)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < length; i += 1) {
        data[i] = Math.random() * 2 - 1
      }
      this.noise_ = buffer
    }
    return this.noise_
  }

  private async loadAll_(): Promise<void> {
    const ctx = this.context_()
    await Promise.all(
      (Object.keys(SFX) as SfxName[]).map(async (name) => {
        const res = await fetch(SFX[name].url)
        const data = await res.arrayBuffer()
        this.buffers_.set(name, await ctx.decodeAudioData(data))
      }),
    )
  }

  // The context is created through the shared factory, which wires in the
  // iOS/Android unlock plumbing (gesture-resume kept live across backgrounding,
  // the "playback" audio-session hint, and hidden/visible suspend/resume) — see
  // ./context. play() still nudges resume() as a belt-and-braces for the first
  // automatic sound (e.g. the end-of-hand riffle).
  private context_(): AudioContext {
    if (!this.ctx_) {
      this.ctx_ = createAudioContext('sfx')
      this.master_ = this.ctx_.createGain()
      this.master_.gain.value = this.muted_ ? 0 : 1
      this.master_.connect(this.ctx_.destination)
    }
    return this.ctx_
  }
}

export const sfx = new SfxService()
