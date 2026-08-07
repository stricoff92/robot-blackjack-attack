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
import shuffleUrl from '../assets/oxidvideos-shuffling-deck-of-cards-522518.ogg'
import drawCardUrl from '../assets/oxidvideos-taking-playing-card-3-522513.mp3'
import upgradeMenuUrl from '../assets/upgrade-menu-open.ogg'
import upgradeSelectedUrl from '../assets/upgrade-selected.ogg'
import abilityUrl from '../assets/ability.ogg'
import playerLostUrl from '../assets/player-lost.ogg'
import playerWonUrl from '../assets/player-won.ogg'
import packagingOpeningUrl from '../assets/packaging-opening.ogg'
import packagingRustlingUrl from '../assets/packaging-rustling.ogg'
import shredderUrl from '../assets/edr-paper-shredder-02-421981.ogg'
import laserPrepareUrl from '../assets/DSGNSynth_CAST-Mecha Laser Prepare_HY_PC-005.ogg'
import laserImpactUrl from '../assets/FGHTImpt_HIT-Strong Punch_HY_PC-004.ogg'
import dealerDeathUrl from '../assets/DSGNMisc_SKILL IMPACT-Whimsimpact_HY_PC-005.ogg'
import footstepUrl from '../assets/FEETMisc_STEP-Boots on Concrete Dungeon_HY_PC-002.ogg'

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
export type ToneName = 'token-launch' | 'token-land'

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
}

const SFX: Record<SfxName, SfxDef> = {
  // The deck riffle at the end of a hand.
  shuffle: { url: shuffleUrl, gain: 1, rateVariance: 0 },
  // A single card flying out of the shoe — jittered so a full deal doesn't machine-gun.
  'draw-card': { url: drawCardUrl, gain: 1, rateVariance: 0.25 },
  // The choose-upgrade buttons surfacing after a kill.
  'upgrade-menu': { url: upgradeMenuUrl, gain: 1, rateVariance: 0 },
  // An upgrade path being picked.
  'upgrade-selected': { url: upgradeSelectedUrl, gain: 1, rateVariance: 0 },
  // A powerup / ability fired (peek, return, freeze…).
  ability: { url: abilityUrl, gain: 1, rateVariance: 0.25 },
  // The hand result revealed against the player — turned down; louder than the
  // rest at full gain.
  'player-lost': { url: playerLostUrl, gain: 0.5, rateVariance: 0.25 },
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
  'laser-impact': { url: laserImpactUrl, gain: 0.5, rateVariance: 0 },
  // The dealer figure blowing apart when killed.
  'dealer-death': { url: dealerDeathUrl, gain: 0.9, rateVariance: 0 },
  // A boot landing as the dealer walks in — fired once per footfall (see the walk-in
  // bob). Rate-jittered ±25% so the three steps of a single walk-in don't sound
  // machine-stamped identical.
  footstep: { url: footstepUrl, gain: 0.6, rateVariance: 0.25 },
}

// Peak level of the synth vacuum drone that accompanies the shredder.
const VACUUM_GAIN = 0.16

// Master level of the synth "repair beam" (playHeal) — kept gentle so the dealer's
// heal reads as soft restorative light, not a second blast.
const HEAL_GAIN = 0.2

// Master level of the synth "points roll" (playPointsRoll) — the ticking flutter under
// the score counter as it climbs. Sustained, so kept quiet under the token-land pings.
const POINTS_ROLL_GAIN = 0.15

class SfxService {
  private ctx: AudioContext | null = null
  private readonly buffers = new Map<SfxName, AudioBuffer>()
  private readonly gains = new Map<SfxName, number>()
  private loadPromise: Promise<void> | null = null
  // Sustained "shredding bed" voices (looping shredder sample + synth vacuum drone),
  // held live so they can be ramped down — unlike the fire-and-forget one-shots.
  private shredVoices: { gain: GainNode; sources: AudioScheduledSourceNode[] }[] = []
  private noise: AudioBuffer | null = null

  constructor() {
    for (const name of Object.keys(SFX) as SfxName[]) {
      this.gains.set(name, SFX[name].gain)
    }
  }

  // Download + decode every clip. Idempotent: repeated calls share one load.
  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadAll()
    }
    return this.loadPromise
  }

  // Retune a sound's base level (1 = 100%). Applies to subsequent plays.
  setGain(name: SfxName, gain: number): void {
    this.gains.set(name, gain)
  }

  // Fire a one-shot. No-op until the clip has finished decoding (so early
  // calls during load simply drop rather than throw). `delaySeconds` schedules it
  // into the future — used to lead a charge-up sound into the event it precedes.
  play(name: SfxName, delaySeconds = 0): void {
    const ctx = this.ctx
    const buffer = this.buffers.get(name)
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
    gain.gain.value = this.gains.get(name) ?? 1
    source.connect(gain).connect(ctx.destination)
    source.start(ctx.currentTime + Math.max(0, delaySeconds))
  }

  // Fire a synthesised tone: an oscillator sweeping fromHz → toHz under a quick
  // attack + exponential decay, pitch-jittered per play. No buffer needed, so it
  // works the instant the context exists (no wait on load()). `delaySeconds`
  // schedules it into the future — used to cascade a burst's per-token blips.
  playTone(name: ToneName, delaySeconds = 0): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const def = TONES[name]
    const t0 = ctx.currentTime + Math.max(0, delaySeconds)
    const dur = def.durationMs / 1000
    // ±rateVariance around 1 scales the whole sweep (a pitch shift, like a
    // playback-rate change), so consecutive blips don't sound identical.
    const scale = 1 + (Math.random() * 2 - 1) * def.rateVariance

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

    osc.connect(gain).connect(ctx.destination)
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
    const ctx = this.context()
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
    out.connect(ctx.destination)

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
    const ctx = this.context()
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
    out.connect(ctx.destination)

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

  // Begin the shredding bed: the shredder clip on a loop (so it covers a shred of any
  // length) plus a synth vacuum drone. No-op if already running; stopShredding() ends it.
  startShredding(): void {
    if (this.shredVoices.length > 0) {
      return
    }
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const buffer = this.buffers.get('shredder')
    if (buffer) {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      const gain = ctx.createGain()
      gain.gain.value = this.gains.get('shredder') ?? 1
      source.connect(gain).connect(ctx.destination)
      source.start()
      this.shredVoices.push({ gain, sources: [source] })
    }
    this.shredVoices.push(this.buildVacuum(ctx))
  }

  // Fade the shredding bed out over `fadeMs` (kept fast so it doesn't trail past the
  // last card) and stop its sources.
  stopShredding(fadeMs: number): void {
    const ctx = this.ctx
    if (!ctx || this.shredVoices.length === 0) {
      this.shredVoices = []
      return
    }
    const t0 = ctx.currentTime
    const end = t0 + Math.max(0, fadeMs) / 1000
    for (const voice of this.shredVoices) {
      const g = voice.gain.gain
      g.cancelScheduledValues(t0)
      g.setValueAtTime(g.value, t0)
      g.linearRampToValueAtTime(0, end) // linear → 0 is click-free even when fast
      for (const source of voice.sources) {
        source.onended = () => source.disconnect()
        source.stop(end + 0.03)
      }
    }
    this.shredVoices = []
  }

  // A synth vacuum drone: a sawtooth "motor" (quickly spun up) + band-limited white
  // noise "airflow", both through a lowpass — a rough mimic of a vacuum sucking the
  // cards in, to sit under the shredder.
  private buildVacuum(ctx: AudioContext): { gain: GainNode; sources: AudioScheduledSourceNode[] } {
    const t0 = ctx.currentTime
    const out = ctx.createGain()
    out.gain.value = VACUUM_GAIN
    out.connect(ctx.destination)

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
    air.buffer = this.noiseBuffer(ctx)
    air.loop = true
    const airGain = ctx.createGain()
    airGain.gain.value = 0.35
    air.connect(airGain).connect(lowpass)
    air.start(t0)
    sources.push(air)

    return { gain: out, sources }
  }

  // One second of white noise, generated once and reused (looped) as the vacuum airflow.
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      const length = Math.floor(ctx.sampleRate)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < length; i += 1) {
        data[i] = Math.random() * 2 - 1
      }
      this.noise = buffer
    }
    return this.noise
  }

  private async loadAll(): Promise<void> {
    const ctx = this.context()
    await Promise.all(
      (Object.keys(SFX) as SfxName[]).map(async (name) => {
        const res = await fetch(SFX[name].url)
        const data = await res.arrayBuffer()
        this.buffers.set(name, await ctx.decodeAudioData(data))
      }),
    )
  }

  // The context is created through the shared factory, which wires in the
  // iOS/Android unlock plumbing (gesture-resume kept live across backgrounding,
  // the "playback" audio-session hint, and hidden/visible suspend/resume) — see
  // ./context. play() still nudges resume() as a belt-and-braces for the first
  // automatic sound (e.g. the end-of-hand riffle).
  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = createAudioContext()
    }
    return this.ctx
  }
}

export const sfx = new SfxService()
