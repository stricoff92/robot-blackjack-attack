// The dealer VOICE service: fully-synthesised vocal emotes for the robot dealer. Two
// emotes so far — an evil LAUGH when the house wins a showdown, and an agitated ANGRY
// growl when the player pulls something off (naturals, a winning free-double, a lucky
// stand/hit, a freeze, a nullified dealer natural — see game-view's triggers). Kept as
// its own service (own AudioContext, own master level) alongside sfx/music so the voice
// can be ducked or muted as its own category, and so the growing emote roster lives here.
//
// Nothing here is sampled. Both emotes are a glottal source (two detuned saws) shaped by
// parallel bandpass "formant" filters and carved into syllables by an amplitude envelope:
// the laugh is bright "HA HA HA" bursts with a breath transient; the growl is lower,
// rougher (an amplitude-modulated buzz + distortion) "GRR" snarls. Pure synthesis — no
// asset, no load().
//
// A dealer's identity lives in a SEED (voiceSeedFor): the same seed always yields the same
// voice, and different dealers sound different (pitch, cadence, vowel). Dealer 1 is silent
// — voiceSeedFor(1) returns null, so BOTH emotes are gated off for it.
//
// Each emote is a plain data object (VoicePattern) from evilLaughPattern / angryGrowlPattern
// (seed varies the voice, shift ramps it deeper + slower with progression). The AUDIO
// (voice.play) and the VISUAL mouth readout (render/dealer.ts, via the animator's
// voiceEnvelope) read that SAME pattern, so the mouth's waves pulse in step with what you hear.

import { createAudioContext } from './context'
import { TOTAL_DEALERS } from '../game/run'
import { smoothStart5 } from '../render/easing'

// Master level of the whole voice channel, feeding a limiter (below) so it reads
// clearly over the player-lost sting without clipping. Tune here.
const VOICE_MASTER = 1.15

// DTMF (telephone key-tone) accent layered over the growl — the robot dealer chirping
// machine codes. Each "digit" is a low+high sine pair from these standard groups; the
// sequence is seeded per dealer (its characteristic dial string). DTMF_PITCH shifts the
// whole set (0.5 = an octave down, for a deeper chirp); DTMF_GAIN is its level.
const DTMF_LOW = [697, 770, 852, 941]
const DTMF_HIGH = [1209, 1336, 1477, 1633]
const DTMF_PITCH = 0.5
const DTMF_GAIN = 0.22

// Deeper laughs read quieter (low frequencies are perceived softer at equal amplitude), so
// the laugh gets a pitch-compensation makeup gain: 1× at the top of the laugh register
// (~160Hz, dealer 2), ramping to (1 + LAUGH_LOW_BOOST)× at the deepest (~95Hz, dealer 6).
const LAUGH_LOW_BOOST = 0.8
function laughLoudness(baseHz: number): number {
  const t = clamp01((160 - baseHz) / (160 - 95))
  return 1 + LAUGH_LOW_BOOST * t
}

// --- the pattern: an emote as data, shared by the audio and the mouth visual -----

// The dealer's emote vocabulary. 'laugh' = the evil cackle on a showdown win; 'angry' =
// an agitated growl when the player pulls something off (see game-view's triggers).
export type VoiceKind = 'laugh' | 'angry'

export interface VoiceSyllable {
  /** Onset, ms from the emote start. */
  at: number
  /** Audible length of this syllable, ms (the gap to the next is silence). */
  dur: number
  /** Fundamental pitch at the onset, Hz. */
  pitch: number
  /** Pitch multiplier across the syllable (<1 falls for a "ha", >1 rises for a "mwa"/snarl). */
  bend: number
  /** Relative loudness, 0..1. */
  gain: number
}

export interface VoicePattern {
  kind: VoiceKind
  seed: number
  syllables: VoiceSyllable[]
  /** Total emote length, ms (past the last syllable, leaving a short tail). */
  totalMs: number
  /** Reference fundamental, Hz — the emote's overall register. */
  baseHz: number
  /** Vowel formants (Hz): F1/F2 place the vowel colour; per-dealer variation. */
  formantF1: number
  formantF2: number
  formantF3: number
  /** Vocal warble: rate (Hz) + depth (cents) of the vibrato on the glottal source. */
  vibratoHz: number
  vibratoCents: number
  /** Visual: mouth-wave tint. 'cool' = laugh (pale light), 'hot' = angry (red/orange). */
  tint: WaveTint
  /** Visual: how many waves ripple across the mouth (1..2) and their spatial + flow rates. */
  waveCount: number
  waveCycles: number // sine cycles spanning the mouth width
  waveFlowHz: number // signed — how fast (and which way) the waves travel
}

// Mouth-wave colour family, chosen by emote so the two read apart at a glance.
export type WaveTint = 'cool' | 'hot'

// A tiny deterministic PRNG (mulberry32) so a seed reproduces the exact same laugh
// every time — no Math.random in the pattern (matches the house "pure function of a
// seed" style used for the damage-fx lattice).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// This dealer's voice seed, or null if it should stay silent. Dealer 1 is silent by
// rule; every later dealer gets a distinct, stable seed (a hash of its number, so
// adjacent dealers don't sound near-identical). `shiftIndex` is 1-based; the final
// RGB dealer (and anything past it) folds onto TOTAL_DEALERS so its voice is fixed.
export function voiceSeedFor(shiftIndex: number): number | null {
  if (shiftIndex <= 1) {
    return null
  }
  const idx = Math.min(shiftIndex, TOTAL_DEALERS)
  // Avalanche the index so 2,3,4… spread far apart in seed space.
  let h = Math.imul(idx ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

// Build the laugh for a dealer: a register, a vowel, a cadence, and a run of "ha"
// syllables that bob downward in pitch and trail off — the classic villain cackle.
// `shiftIndex` (the dealer number) drives a MENACE ramp on the same axis as the brow
// anger + board-tech progression: later dealers cackle DEEPER and SLOWER. The seed
// still jitters every dealer so the ramp isn't a bare mathematical line. Pure +
// deterministic. (Silent dealer 1 never reaches here — voiceSeedFor gates it.)
export function evilLaughPattern(seed: number, shiftIndex: number): VoicePattern {
  const r = mulberry32(seed)

  // Menace 0 (dealer 2) → 1 (final dealer). Clamped so the RGB dealer (and anything past
  // it) reads as full menace, matching voiceSeedFor's clamp.
  const idx = Math.min(Math.max(shiftIndex, 2), TOTAL_DEALERS)
  const menace = TOTAL_DEALERS > 2 ? (idx - 2) / (TOTAL_DEALERS - 2) : 0

  // Register: a deep growl that DROPS with shift (~160Hz early → ~102Hz final), seed-jittered
  // ±11Hz so it isn't a perfect line.
  const baseHz = 160 - 58 * menace + (r() - 0.5) * 22

  // Vowel colour: an /a/-ish pair, nudged per dealer, and lowered a touch with menace —
  // a bigger throat behind the deeper growl.
  const formantF1 = 600 - 70 * menace + r() * 260
  const formantF2 = 1080 - 120 * menace + r() * 460
  const formantF3 = 2500 + r() * 500 // brightness/edge

  // Warble: heavier + a little slower toward the final dealer.
  const vibratoHz = 5.6 - 1.3 * menace + r() * 2
  const vibratoCents = 12 + 16 * menace + r() * 16

  // Cadence: a SHORT cackle — a few "ha"s, slightly slower/heavier with shift but kept tight
  // so no laugh drags. Early dealers quicker; ~60% open with a "mwa".
  const count = 3 + Math.round(menace * 1.5) + Math.floor(r() * 2) // ~3..4 early → ~5..6 final
  const period = 130 + 45 * menace + r() * 25 // ~130..155 early → ~175..200 final (ms)
  const accel = Math.min(0.99, 0.9 + 0.06 * menace + r() * 0.05) // steadier heavy rhythm late
  const intro = r() < 0.6

  const syllables: VoiceSyllable[] = []
  let at = 0

  if (intro) {
    // "MWAAA" — a rising swell that launches the cackle.
    const dur = 160 + r() * 70
    syllables.push({ at, dur, pitch: baseHz * 0.82, bend: 1.22, gain: 0.85 })
    at += dur + 30 + r() * 30
  }

  let gap = period
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0
    // Pitch: a bobbing descent — a cosine bounce per syllable riding a downward drift,
    // so it reads as HA-ha-HA-ha sagging lower (menace), not a monotone.
    const bounce = 0.16 * Math.cos(i * 0.9)
    const drift = -0.17 * t
    const jitter = (r() - 0.5) * 0.05
    const pitch = baseHz * (1 + bounce + drift + jitter)
    // Each "ha" is a clipped burst; the gap after it is silence. Fall in pitch within.
    const dur = gap * (0.52 + r() * 0.12)
    // Loudness swells early then trails off at the tail (the laugh dying down); the
    // final syllable is held longer — the drawn-out "HAAA".
    const shape = 0.72 + 0.28 * Math.sin(Math.min(1, t / 0.5) * Math.PI * 0.5) - 0.35 * Math.max(0, t - 0.6)
    const last = i === count - 1
    syllables.push({
      at,
      dur: last ? dur * 1.6 : dur,
      pitch,
      bend: 0.86 - r() * 0.06,
      gain: Math.max(0.4, Math.min(1, shape)),
    })
    at += gap
    gap *= accel
  }

  const lastSyl = syllables[syllables.length - 1]
  const totalMs = lastSyl.at + lastSyl.dur + 150 // a short tail/echo to ring out

  // Visual: 1 or 2 travelling waves, a per-dealer spatial density + flow speed/dir.
  const waveCount = r() < 0.35 ? 1 : 2
  const waveCycles = 1.2 + r() * 1.5 // 1.2..2.7 cycles across the mouth
  const waveFlowHz = (1.1 + r() * 1.4) * (r() < 0.5 ? -1 : 1) // ±1.1..2.5 travel rate (visibly flowing)

  return {
    kind: 'laugh',
    seed,
    syllables,
    totalMs,
    baseHz,
    formantF1,
    formantF2,
    formantF3,
    vibratoHz,
    vibratoCents,
    tint: 'cool',
    waveCount,
    waveCycles,
    waveFlowHz,
  }
}

// Build the ANGRY growl for a dealer: a low, rough, agitated snarl — deeper and buzzier
// than the laugh, a couple of rising "GRR" swells rather than a run of bright "ha"s. Same
// per-dealer seed + shift-menace ramp (deeper/rougher later), and it drives the SAME mouth
// readout (hot-tinted, fast agitated waves). Pure + deterministic; dealer 1 never reaches
// here.
export function angryGrowlPattern(seed: number, shiftIndex: number): VoicePattern {
  const r = mulberry32(seed)
  const idx = Math.min(Math.max(shiftIndex, 2), TOTAL_DEALERS)
  const menace = TOTAL_DEALERS > 2 ? (idx - 2) / (TOTAL_DEALERS - 2) : 0

  // A SINGLE growl (no syllable run): its whole life is one sine hump — low → climax → low —
  // on both frequency and volume (see growlHump / playGrowl / voiceEnvelope). Register is DEEP
  // (a chest growl, not a whine), dropping further with shift.
  const baseHz = 82 - 22 * menace + (r() - 0.5) * 12 // ~76..88 early → ~54..66 final

  // Throaty formants (lower than the laugh's) give the voiced core its snarl colour.
  const formantF1 = 430 - 60 * menace + r() * 150
  const formantF2 = 820 - 110 * menace + r() * 300
  const formantF3 = 2100 + r() * 360

  // A subtle vocal waver (FM, not AM) for life — heavier with shift.
  const vibratoHz = 6.5 + 2 * menace + r() * 2
  const vibratoCents = 16 + 14 * menace + r() * 10

  // One short growl, 600–800ms — a touch longer/heavier toward the final dealer.
  const totalMs = 600 + 140 * menace + r() * 60 // ~600..800ms

  return {
    kind: 'angry',
    seed,
    syllables: [], // a single growl uses the sine hump, not a syllable run
    totalMs,
    baseHz,
    formantF1,
    formantF2,
    formantF3,
    vibratoHz,
    vibratoCents,
    tint: 'hot',
    waveCount: 2,
    waveCycles: 2.2 + r() * 1.3, // tight ripples
    waveFlowHz: (2.4 + r() * 1.6) * (r() < 0.5 ? -1 : 1), // fast travel = agitation
  }
}


// The shared LOUDNESS envelope of an emote at a given elapsed time (ms from start).
// Returns null before it starts / after it ends. `open` is the overall gate (fades
// the mouth glow in/out at the edges); `energy` folds the per-syllable pulse into
// that gate (never fully zero while open, surging on each syllable). The animator calls
// this to drive the mouth; the audio carves the SAME syllables so the two line up.
export function voiceEnvelope(pattern: VoicePattern, elapsedMs: number): { open: number; energy: number } | null {
  if (elapsedMs < 0 || elapsedMs > pattern.totalMs) {
    return null
  }
  // The angry growl is a SINGLE sine hump (low → climax → low), floored so it never drops too
  // quiet — the same shape the audio uses, so the mouth swells in step with what you hear.
  if (pattern.kind === 'angry') {
    const p = elapsedMs / pattern.totalMs
    const open = growlEdge(p)
    return { open, energy: open * (GROWL_VOL_FLOOR + (1 - GROWL_VOL_FLOOR) * growlHump(p)) }
  }
  const fadeIn = clamp01(elapsedMs / 70)
  const fadeOut = clamp01((pattern.totalMs - elapsedMs) / 200)
  const open = Math.min(fadeIn, fadeOut)

  // Per-syllable bump: a fast attack then a decay to zero across each syllable's life.
  // Take the strongest live syllable (they don't overlap), smoothstepped so it ramps.
  let pulse = 0
  for (const s of pattern.syllables) {
    const local = elapsedMs - s.at
    if (local < 0 || local > s.dur) {
      continue
    }
    const atk = Math.min(18, s.dur * 0.25)
    const b = local < atk ? local / atk : 1 - (local - atk) / (s.dur - atk)
    const smooth = b * b * (3 - 2 * b)
    pulse = Math.max(pulse, smooth * s.gain)
  }

  const energy = open * (0.28 + 0.72 * pulse)
  return { open, energy }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

// The single growl's shape, shared by the audio (frequency + volume) and the mouth visual so
// they swell together. `growlHump` is a sine hump over the growl's life (0 → 1 → 0 for p in
// [0,1]); the VOLUME rides it above `GROWL_VOL_FLOOR` (never too quiet), the FREQUENCY revs up
// and back with it. `growlEdge` is a tiny fade at the very ends so nothing clicks.
const GROWL_VOL_FLOOR = 0.42
function growlHump(p: number): number {
  return Math.sin(Math.PI * clamp01(p))
}
function growlEdge(p: number): number {
  return Math.min(1, p / 0.05, (1 - p) / 0.06)
}

// The growl's FREQUENCY glide (separate from the volume hump): it starts HIGH and eases DOWN
// to a lower end — a descending growl. `percentThroughDrop = smoothStart5(p)` shapes it, so the
// pitch holds high early then falls faster toward the end. Multipliers are × baseHz.
const GROWL_FREQ_HIGH = 2.4
const GROWL_FREQ_LOW = 0.6

// A soft-clip (tanh-ish) WaveShaper curve for the growl's grit — squashes the saw peaks
// into a snarling distortion. Built once and reused across every growl.
let cachedGrowlCurve: Float32Array<ArrayBuffer> | null = null
function growlCurve(): Float32Array<ArrayBuffer> {
  if (!cachedGrowlCurve) {
    const n = 1024
    const curve = new Float32Array(n)
    const k = 9 // drive amount — higher = grittier (a growl needs heavy grit)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)) // classic soft-clip
    }
    cachedGrowlCurve = curve
  }
  return cachedGrowlCurve
}

class VoiceService {
  private ctx: AudioContext | null = null
  private noise: AudioBuffer | null = null

  // Create the AudioContext now (idempotent) so the shared gesture listeners in
  // context.ts unlock it alongside sfx/music. Without this the context is born on the
  // FIRST laugh — already past the user's gesture — so it stays suspended and silent.
  // Call once at startup (main.ts), the same place sfx.load() warms the sfx context.
  prime(): void {
    this.context()
  }

  // Fire an emote from its pattern, dispatching on kind. `delaySeconds` schedules it
  // slightly after the trigger (so a laugh lands just behind the loss sting). Fully
  // synthesised — works the instant the context exists.
  play(pattern: VoicePattern, delaySeconds = 0): void {
    if (pattern.kind === 'angry') {
      this.playGrowl(pattern, delaySeconds)
    } else {
      this.playLaugh(pattern, delaySeconds)
    }
  }

  // The evil laugh: bright "HA HA HA" bursts (glottal saws → /a/ formants → syllable
  // envelope, with a breath transient + slap-back echo).
  private playLaugh(pattern: VoicePattern, delaySeconds = 0): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const t0 = ctx.currentTime + Math.max(0, delaySeconds)
    const total = pattern.totalMs / 1000
    const end = t0 + total

    // Master out for the whole laugh, into a gentle limiter: the parallel formant peaks
    // stack on the loud syllables, so the compressor catches them (no clipping) and lets
    // the laugh sit clearly + consistently loud rather than spiking then vanishing.
    const out = ctx.createGain()
    out.gain.value = VOICE_MASTER
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 12
    comp.ratio.value = 4
    comp.attack.value = 0.003
    comp.release.value = 0.18
    // Post-limiter makeup so deeper (quieter-reading) laughs come up in level — dealer 6 most.
    const makeup = ctx.createGain()
    makeup.gain.value = laughLoudness(pattern.baseHz)
    out.connect(comp).connect(makeup).connect(ctx.destination)

    // A subtle slap-back echo gives the cackle a cavernous, lair-like space. Feedback
    // stays well below 1 so it decays; the delay tap feeds `out` alongside the dry.
    const delay = ctx.createDelay(0.5)
    delay.delayTime.value = 0.11
    const feedback = ctx.createGain()
    feedback.gain.value = 0.26
    delay.connect(feedback).connect(delay)
    delay.connect(out)

    // The syllable amplitude envelope — everything voiced routes through this, so the
    // "HA HA HA" carving (and the echo send) come from one gain.
    const voiceGain = ctx.createGain()
    voiceGain.connect(out)
    const echoSend = ctx.createGain()
    echoSend.gain.value = 0.5
    voiceGain.connect(echoSend).connect(delay)

    // Tone-shape the voiced path: trim sub rumble + tame the saws' harsh top.
    const shaper = ctx.createBiquadFilter()
    shaper.type = 'lowpass'
    shaper.frequency.value = 3200
    shaper.Q.value = 0.4
    shaper.connect(voiceGain)

    // Parallel formant bandpasses turn the raw saws into a vowel. F1/F2 carry the
    // /a/; F3 adds a little edge. Their gains set the vowel's balance. Each bandpass is
    // an input the glottal source fans out to (wired after the oscillators below).
    const mix = ctx.createGain()
    mix.connect(shaper)
    const formantInputs: BiquadFilterNode[] = []
    // Wider bands (lower Q) pass more of the saw's harmonics — louder and a more natural
    // vowel than the previous pinched resonances.
    const formants: [number, number, number][] = [
      [pattern.formantF1, 5, 1.1],
      [pattern.formantF2, 7, 0.75],
      [pattern.formantF3, 9, 0.4],
    ]
    for (const [freq, q, level] of formants) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = freq
      bp.Q.value = q
      const g = ctx.createGain()
      g.gain.value = level
      bp.connect(g).connect(mix)
      formantInputs.push(bp)
    }

    // Glottal source: two detuned sawtooths for a buzzy, robotic "cord". Summed low so
    // the formant boosts don't clip (the limiter on `out` mops up the peaks).
    const src = ctx.createGain()
    src.gain.value = 0.5
    for (const bp of formantInputs) {
      src.connect(bp)
    }

    const oscs: OscillatorNode[] = []
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.detune.value = i === 0 ? -6 : 6 // a hair of chorus between the two cords
      osc.connect(src)
      oscs.push(osc)
    }

    // Vibrato: one LFO warbles both oscillators' detune for a vocal warble.
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = pattern.vibratoHz
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = pattern.vibratoCents
    lfo.connect(lfoDepth)
    for (const osc of oscs) {
      lfoDepth.connect(osc.detune)
    }

    // Breath transient: a short band-limited noise burst at each syllable onset — the
    // "h" of "ha". One looping noise source through a bandpass, gated by noiseGain.
    const noiseSrc = ctx.createBufferSource()
    noiseSrc.buffer = this.noiseBuffer(ctx)
    noiseSrc.loop = true
    const noiseBp = ctx.createBiquadFilter()
    noiseBp.type = 'bandpass'
    noiseBp.frequency.value = 1500
    noiseBp.Q.value = 0.8
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.0001
    noiseSrc.connect(noiseBp).connect(noiseGain).connect(out)

    // Schedule the syllables: pitch contour on the cords, amplitude on voiceGain, and a
    // breath blip on noiseGain — all off the shared pattern so audio + mouth agree.
    const FLOOR = 0.0009
    voiceGain.gain.setValueAtTime(FLOOR, t0)
    for (const syl of pattern.syllables) {
      const s = t0 + syl.at / 1000
      const dur = syl.dur / 1000
      const atk = Math.min(0.02, dur * 0.25)
      const f0 = Math.max(40, syl.pitch)
      const f1 = Math.max(40, syl.pitch * syl.bend)
      for (const osc of oscs) {
        osc.frequency.setValueAtTime(f0, s)
        osc.frequency.exponentialRampToValueAtTime(f1, s + dur)
      }
      voiceGain.gain.setValueAtTime(FLOOR, s)
      voiceGain.gain.linearRampToValueAtTime(syl.gain, s + atk)
      voiceGain.gain.exponentialRampToValueAtTime(FLOOR, s + dur)
      // Breath: quick in, quick out, right at the onset.
      noiseGain.gain.setValueAtTime(FLOOR, s)
      noiseGain.gain.linearRampToValueAtTime(0.05 * syl.gain, s + 0.008)
      noiseGain.gain.exponentialRampToValueAtTime(FLOOR, s + Math.min(0.06, dur))
    }
    // Final fade so nothing clicks off.
    voiceGain.gain.setValueAtTime(FLOOR, end - 0.05)
    voiceGain.gain.linearRampToValueAtTime(0, end)

    // Run + tear down. Everything stops together; the last oscillator's onended frees
    // the graph (disconnect from the top nodes cascades).
    const stopAt = end + 0.05
    for (const osc of oscs) {
      osc.start(t0)
      osc.stop(stopAt)
    }
    lfo.start(t0)
    lfo.stop(stopAt)
    noiseSrc.start(t0)
    noiseSrc.stop(stopAt)
    oscs[0].onended = () => {
      out.disconnect()
      comp.disconnect()
      makeup.disconnect()
      delay.disconnect()
      feedback.disconnect()
      voiceGain.disconnect()
      echoSend.disconnect()
      shaper.disconnect()
      mix.disconnect()
      src.disconnect()
      lfo.disconnect()
      lfoDepth.disconnect()
      noiseSrc.disconnect()
      noiseBp.disconnect()
      noiseGain.disconnect()
      for (const osc of oscs) {
        osc.disconnect()
      }
    }
  }

  // The angry growl: a SINGLE growl whose whole life is one sine HUMP — low → climax → low —
  // on both FREQUENCY (revs up + back) and VOLUME (swells, floored so it never drops too quiet).
  // A voiced sawtooth core through throaty formants + soft-clip grit gives it the pitched snarl;
  // a little band-passed noise adds breath; a subtle vibrato adds life. No periodic amplitude
  // modulation (that read as an engine). Shares the master + limiter with the laugh.
  private playGrowl(pattern: VoicePattern, delaySeconds = 0): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const t0 = ctx.currentTime + Math.max(0, delaySeconds)
    const dur = pattern.totalMs / 1000
    const end = t0 + dur

    const out = ctx.createGain()
    out.gain.value = VOICE_MASTER
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12
    comp.knee.value = 10
    comp.ratio.value = 5
    comp.attack.value = 0.003
    comp.release.value = 0.15
    out.connect(comp).connect(ctx.destination)

    // The single-growl VOLUME envelope: a sine hump (below), floored so it stays present.
    const voiceGain = ctx.createGain()
    voiceGain.connect(out)

    // Warm cap: dark + chesty (a growl has little top; brightness reads as a whine).
    const cap = ctx.createBiquadFilter()
    cap.type = 'lowpass'
    cap.frequency.value = 1400
    cap.Q.value = 0.6
    cap.connect(voiceGain)

    // Throaty formants give the voiced core its growl (vocal) colour.
    const mix = ctx.createGain()
    mix.connect(cap)
    const formantBands: BiquadFilterNode[] = []
    const formants: [number, number, number][] = [
      [pattern.formantF1, 4, 1.1],
      [pattern.formantF2, 6, 0.6],
      [pattern.formantF3, 8, 0.22],
    ]
    for (const [freq, q, level] of formants) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = freq
      bp.Q.value = q
      const g = ctx.createGain()
      g.gain.value = level
      bp.connect(g).connect(mix)
      formantBands.push(bp)
    }

    // VOICED CORE (leads): two detuned sawtooths + a prominent SUB-OCTAVE, summed then
    // soft-clipped HARD — the low, rattly snarl body. Frequency follows the sine hump (below).
    const distort = ctx.createWaveShaper()
    distort.curve = growlCurve()
    distort.oversample = '2x'
    for (const bp of formantBands) {
      distort.connect(bp)
    }
    const srcGain = ctx.createGain()
    srcGain.gain.value = 0.6
    srcGain.connect(distort)
    const oscs: OscillatorNode[] = []
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.detune.value = i === 0 ? -10 : 10 // a hair of chorus
      osc.connect(srcGain)
      oscs.push(osc)
    }
    // Sub-octave saw (an octave below, prominent): the chesty rattle a growl needs — the
    // distortion intermodulates it with the fundamental into a guttural rasp.
    const subOsc = ctx.createOscillator()
    subOsc.type = 'sawtooth'
    subOsc.detune.value = 5
    const subGain = ctx.createGain()
    subGain.gain.value = 1.4
    subOsc.connect(subGain).connect(srcGain)

    // A little band-passed noise for breath/rasp (subordinate — the voiced core leads).
    const rasp = ctx.createBufferSource()
    rasp.buffer = this.noiseBuffer(ctx)
    rasp.loop = true
    const raspBp = ctx.createBiquadFilter()
    raspBp.type = 'bandpass'
    raspBp.frequency.value = pattern.formantF1
    raspBp.Q.value = 1.5
    const raspGain = ctx.createGain()
    raspGain.gain.value = 0.3
    rasp.connect(raspBp).connect(raspGain).connect(cap)

    // ROUGHNESS: an IRREGULAR pitch flutter from low-passed noise (aperiodic FM = a vocal-fry
    // rattle, NOT a periodic engine) plus a subtle vibrato — both on every oscillator's detune.
    const jitter = ctx.createBufferSource()
    jitter.buffer = this.noiseBuffer(ctx)
    jitter.loop = true
    const jitterLp = ctx.createBiquadFilter()
    jitterLp.type = 'lowpass'
    jitterLp.frequency.value = 45
    const jitterDepth = ctx.createGain()
    jitterDepth.gain.value = 500 // cents of irregular flutter (the rattle)
    jitter.connect(jitterLp).connect(jitterDepth)
    const vib = ctx.createOscillator()
    vib.type = 'sine'
    vib.frequency.value = pattern.vibratoHz
    const vibDepth = ctx.createGain()
    vibDepth.gain.value = pattern.vibratoCents
    vib.connect(vibDepth)
    const voicedOscs = [...oscs, subOsc]
    for (const osc of voicedOscs) {
      jitterDepth.connect(osc.detune)
      vibDepth.connect(osc.detune)
    }

    // Curves over the whole growl: VOLUME rides the sine hump (floored), while FREQUENCY starts
    // HIGH and eases DOWN to a lower end via smoothStart5 (holds high, then drops faster toward
    // the end) — a descending growl. The sub tracks an octave below.
    const N = 200
    const volCurve = new Float32Array(N)
    const freqCurve = new Float32Array(N)
    const subCurve = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const p = i / (N - 1)
      volCurve[i] = Math.max(0.0009, growlEdge(p) * (GROWL_VOL_FLOOR + (1 - GROWL_VOL_FLOOR) * growlHump(p)))
      const percentThroughDrop = smoothStart5(p)
      const f = Math.max(28, pattern.baseHz * (GROWL_FREQ_HIGH + (GROWL_FREQ_LOW - GROWL_FREQ_HIGH) * percentThroughDrop))
      freqCurve[i] = f
      subCurve[i] = f * 0.5
    }
    voiceGain.gain.setValueCurveAtTime(volCurve, t0, dur)
    for (const osc of oscs) {
      osc.frequency.setValueCurveAtTime(freqCurve, t0, dur)
    }
    subOsc.frequency.setValueCurveAtTime(subCurve, t0, dur)

    // Telephone key-tones chirped over the growl (each self-cleans; the bus is freed below).
    const dtmfBus = this.scheduleDtmf(ctx, out, pattern.seed, t0, dur)

    const stopAt = end + 0.05
    const sources: AudioScheduledSourceNode[] = [rasp, jitter, vib, ...voicedOscs]
    for (const s of sources) {
      s.start(t0)
      s.stop(stopAt)
    }
    oscs[0].onended = () => {
      for (const n of [out, comp, voiceGain, cap, mix, distort, srcGain, subGain, raspBp, raspGain, jitterLp, jitterDepth, vibDepth, dtmfBus, ...formantBands]) {
        n.disconnect()
      }
      for (const s of sources) {
        s.disconnect()
      }
    }
  }

  // Schedule a short DTMF sequence (~a handful of key-tones) across the growl's life, mixed
  // into `dest`. Deterministic per dealer (seed) so each dealer "dials" its own string. Each
  // digit is two sine tones (low+high) under a quick blip envelope; the tones self-disconnect,
  // and the returned bus gain is freed by the caller's teardown.
  private scheduleDtmf(ctx: AudioContext, dest: AudioNode, seed: number, t0: number, durSec: number): GainNode {
    const rand = mulberry32((seed ^ 0x0d791f) >>> 0)
    const bus = ctx.createGain()
    bus.gain.value = DTMF_GAIN
    bus.connect(dest)

    const toneLen = 0.05 // 50ms per key-tone
    const gap = 0.035
    const end = t0 + durSec
    let at = t0 + 0.02
    while (at + toneLen <= end) {
      const lo = DTMF_LOW[Math.floor(rand() * DTMF_LOW.length)]
      const hi = DTMF_HIGH[Math.floor(rand() * DTMF_HIGH.length)]
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, at)
      g.gain.linearRampToValueAtTime(1, at + 0.005)
      g.gain.setValueAtTime(1, at + toneLen - 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, at + toneLen)
      g.connect(bus)
      const pair: OscillatorNode[] = []
      for (const freq of [lo, hi]) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq * DTMF_PITCH // dropped an octave for a deeper chirp
        osc.connect(g)
        osc.start(at)
        osc.stop(at + toneLen + 0.02)
        pair.push(osc)
      }
      pair[0].onended = () => {
        g.disconnect()
        for (const osc of pair) {
          osc.disconnect()
        }
      }
      at += toneLen + gap + (rand() - 0.5) * 0.012 // a little rhythmic jitter
    }
    return bus
  }

  // One second of white noise, generated once and looped as the breath source.
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

  // Own AudioContext via the shared factory (iOS/Android unlock plumbing), like sfx.
  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = createAudioContext()
    }
    return this.ctx
  }
}

export const voice = new VoiceService()
