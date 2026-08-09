// The music service: a second, independent WebAudio graph for background
// music, separate from the SFX service so the two carry their own master level
// and can be muted or ducked independently. It shares only the iOS/Android
// unlock plumbing in ./context (see createAudioContext).
//
// Tracks download + decode lazily — each one the first time it is about to
// play, and only once (cached thereafter). "The Cannery" always opens the set;
// when a track finishes a different random track follows (never an immediate
// repeat). The follow-up is chosen and prefetched while the current track is
// still playing, so the hand-off is gapless.

import { createAudioContext } from './context'

// Vite fingerprints each asset URL; fetch() then pulls it (from cache after the
// first load) for decodeAudioData. The filenames contain spaces — Vite handles it.
import canneryUrl from '../assets/Kevin MacLeod-The Cannery.ogg'
import serpentineUrl from '../assets/Kevin MacLeod-Serpentine-Trek.ogg'
import maestroUrl from '../assets/Kevin MacLeod-One-eyed-Maestro.ogg'
import machinationsUrl from '../assets/Kevin-MacLeod-Machinations.ogg'
import getawayUrl from '../assets/Kevin MacLeod-Mistake the Getaway.ogg'
import bustUrl from '../assets/Kevin MacLeod Trio for Piano Violin and Viola.ogg'
import cashoutUrl from '../assets/Kevin MacLeod-Enigma.ogg'

export type TrackName =
  | 'cannery'
  | 'serpentine'
  | 'maestro'
  | 'machinations'
  | 'getaway'
  | 'bust'
  | 'cashout'

interface TrackDef {
  url: string
  /**
   * Per-track base level (1 = 100%), applied before the shared master volume —
   * so a track that was mastered hotter than the others can be pulled down to
   * sit level with them. Tune these to balance the set; setBaseVolume() can also
   * change one at runtime.
   */
  baseVolume: number
}

const TRACKS: Record<TrackName, TrackDef> = {
  cannery: { url: canneryUrl, baseVolume: 0.4 },
  serpentine: { url: serpentineUrl, baseVolume: 1 },
  maestro: { url: maestroUrl, baseVolume: 1 },
  machinations: { url: machinationsUrl, baseVolume: 1 },
  getaway: { url: getawayUrl, baseVolume: 1 },
  bust: { url: bustUrl, baseVolume: 1 },
  cashout: { url: cashoutUrl, baseVolume: 1 },
}

const ALL_TRACKS = Object.keys(TRACKS) as TrackName[]
// Coda-only tracks, NEVER in the normal rotation — each plays only from its dedicated trigger:
//   • CODA_TRACK ("Mistake the Getaway") — the double-or-nothing theme (codaHand).
//   • BUST_TRACK (piano/violin/viola trio) — the sting for LOSING the coda (codaBust).
//   • CASHOUT_TRACK ("Enigma") — the sting for CASHING OUT of the coda (codaCashOut).
const CODA_TRACK: TrackName = 'getaway'
const BUST_TRACK: TrackName = 'bust'
const CASHOUT_TRACK: TrackName = 'cashout'
// End stings: play exactly ONCE and then the soundtrack goes silent until a new run.
const END_TRACKS: TrackName[] = [BUST_TRACK, CASHOUT_TRACK]
const ROTATION_TRACKS = ALL_TRACKS.filter(
  (name) => name !== CODA_TRACK && name !== BUST_TRACK && name !== CASHOUT_TRACK,
)
// Coda transitions are FAST — a slow fade would mush the sharp attacks. Whatever's playing
// ducks out over CODA_FADE_OUT_MS; the coda THEME itself hard-starts (fadeIn 0) so its opening
// bang lands at full volume every deal, while the end stings fade in over CODA_FADE_IN_MS.
// (prefetchCoda decodes the buffers ahead of time, so there's no download gap behind the fade.)
const CODA_FADE_OUT_MS = 140
const CODA_FADE_IN_MS = 60
// "The Cannery" always plays first.
const OPENING_TRACK: TrackName = 'cannery'

class MusicService {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  // Decoded buffers, cached so each track downloads at most once.
  private readonly buffers = new Map<TrackName, AudioBuffer>()
  // In-flight downloads, so overlapping requests for one track share a fetch.
  private readonly loads = new Map<TrackName, Promise<AudioBuffer>>()
  // Per-track base levels, seeded from TRACKS but mutable via setBaseVolume() and
  // persisting across replays of a track.
  private readonly baseVolumes = new Map<TrackName, number>(
    ALL_TRACKS.map((name) => [name, TRACKS[name].baseVolume]),
  )
  private current: { source: AudioBufferSourceNode; gain: GainNode; name: TrackName } | null = null
  // Decided + prefetched when the current track starts, for a gapless hand-off.
  private queued: TrackName | null = null
  private started = false
  private volume = 1

  // --- Banker-coda (double-or-nothing) theme ---
  // True while the run is inside an active coda hand: "Mistake the Getaway" is the theme, and
  // if it runs to its natural end within one drawn-out hand it hands off to a rotation track.
  private codaActive = false
  // True from a coda END sting (bust or cash out) until the next run: the sting plays once
  // and then the soundtrack goes SILENT (no auto-advance). resumeAfterEnd() clears it.
  private endSilence = false

  // Begin the soundtrack: "The Cannery" first, then random non-repeating tracks
  // forever. Idempotent — after the first call it just makes sure the context is
  // resumed. Safe to call before any user gesture; the shared unlock plumbing
  // resumes the context (and the already-scheduled track) once a gesture arrives.
  start(): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    if (this.started) {
      return
    }
    this.started = true
    void this.playTrack(OPENING_TRACK)
  }

  // Master music level (1 = 100%), applied to every track. Persists across tracks.
  setVolume(volume: number): void {
    this.volume = volume
    if (this.master) {
      this.master.gain.value = volume
    }
  }

  // Set one track's base level (1 = 100%), independent of the master volume.
  // Persists across replays; takes effect immediately if that track is playing.
  setBaseVolume(track: TrackName, volume: number): void {
    this.baseVolumes.set(track, volume)
    if (this.current?.name === track) {
      this.current.gain.gain.value = volume
    }
  }

  // Crossfade to a fresh (non-repeating) track: fade the current one OUT while a new one
  // fades IN over `fadeMs`. Used when a new dealer starts so the soundtrack turns over. If
  // nothing is playing yet, just begins the set.
  advanceTrack(fadeMs = 2000): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    if (!this.started) {
      this.start()
      return
    }
    // Detach the current track and fade it out independently, so the incoming one crossfades
    // over it instead of being cut off (playTrack's stopCurrent then finds nothing to stop).
    const outgoing = this.current
    this.current = null
    if (outgoing) {
      this.fadeOutAndStop(outgoing, fadeMs)
    }
    // Prefer the already-prefetched follow-up (decoded, so the fade-in is gapless).
    const next = this.queued ?? this.pickNext(outgoing?.name ?? OPENING_TRACK)
    this.queued = null
    void this.playTrack(next, fadeMs)
  }

  // A double-or-nothing round has begun — call once per coda hand (each codaGamble). (Re)starts
  // the coda theme ("Mistake the Getaway") from the beginning, EVERY hand, so its opening bang
  // lands on each deal. This is the ONLY place the coda track is ever started — it never joins
  // the normal rotation.
  codaHand(): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.started = true
    this.codaActive = true
    // Restart the theme from the BEGINNING on every deal — its opening BANG should land each
    // hand, so a prior round's playback never runs on. Whatever's up (a prior getaway, or the
    // coda-entry silence) ducks out fast while the theme HARD-starts at full volume (fadeIn 0)
    // so the bang isn't softened. prefetchCoda has the buffer decoded, so no download gap.
    const outgoing = this.current
    this.current = null
    this.queued = null
    if (outgoing) {
      this.fadeOutAndStop(outgoing, CODA_FADE_OUT_MS)
    }
    void this.playTrack(CODA_TRACK, 0)
  }

  // Warm the coda buffers ahead of time (call at coda entry) so the quick fades of
  // codaHand()/codaBust()/codaCashOut() have decoded buffers ready and expose no download gap.
  // Download only — none starts playback (that stays exclusive to their triggers).
  prefetchCoda(): void {
    void this.getBuffer(CODA_TRACK).catch(() => {})
    void this.getBuffer(BUST_TRACK).catch(() => {})
    void this.getBuffer(CASHOUT_TRACK).catch(() => {})
  }

  // Dealer 6 has been defeated (the winning hand is revealed): fade the fight music out to
  // SILENCE and hold there. Nothing plays through the Banker's walk-in / the prompt — the
  // soundtrack only resumes when the player chooses double-or-nothing (codaHand → the coda
  // theme) or cash out (codaCashOut → the cash-out sting).
  enterCodaSilence(fadeMs = 1500): void {
    this.codaActive = false
    this.endSilence = false
    const outgoing = this.current
    this.current = null
    this.queued = null
    if (outgoing) {
      this.fadeOutAndStop(outgoing, fadeMs)
    }
  }

  // The player BUSTED out of the coda (lost the double-or-nothing, score zeroed): play the
  // bust sting once, then silence until a new run.
  codaBust(): void {
    this.playEndSting(BUST_TRACK)
  }

  // The player CASHED OUT of the coda (banked the score, run ended): play the cash-out sting
  // once, then silence until a new run.
  codaCashOut(): void {
    this.playEndSting(CASHOUT_TRACK)
  }

  // Snap whatever's playing out and play a one-shot END sting; when it finishes advance() sees
  // an END_TRACK and goes SILENT (endSilence held) until resumeAfterEnd() on the next run.
  private playEndSting(track: TrackName): void {
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.started = true
    this.codaActive = false
    this.endSilence = true
    const outgoing = this.current
    this.current = null
    if (outgoing) {
      this.fadeOutAndStop(outgoing, CODA_FADE_OUT_MS)
    }
    this.queued = null
    void this.playTrack(track, outgoing ? CODA_FADE_IN_MS : 0)
  }

  // A fresh run started after a coda end sting: fade the sting out (or break its trailing
  // silence) and bring a normal dealer track back in. No-op unless we're in the post-end
  // silence, so an ordinary game-over → new run keeps whatever's already playing.
  resumeAfterEnd(): void {
    if (!this.endSilence) {
      return
    }
    this.endSilence = false
    this.advanceTrack()
  }

  // Stop the soundtrack. start() can begin it again from "The Cannery".
  stop(): void {
    this.started = false
    this.queued = null
    this.codaActive = false
    this.endSilence = false
    this.stopCurrent()
  }

  // Play `name`, optionally FADING IN over `fadeInMs` (0 = start at full) so it can
  // crossfade over a track that advanceTrack() is fading out.
  private async playTrack(name: TrackName, fadeInMs = 0): Promise<void> {
    const buffer = await this.getBuffer(name)
    // Bailed out (stop()) while the track was still downloading.
    if (!this.started) {
      return
    }
    const ctx = this.context()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.stopCurrent()

    // source → per-track base gain → master → destination, so each track's
    // level is independently tunable (setBaseVolume) beneath the shared volume.
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    const base = this.baseVolumes.get(name) ?? 1
    if (fadeInMs > 0) {
      const t = ctx.currentTime
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(base, t + fadeInMs / 1000)
    } else {
      gain.gain.value = base
    }
    source.connect(gain).connect(this.master as GainNode)
    this.current = { source, gain, name }
    source.onended = () => {
      // Ignore the ended event from a source we deliberately replaced.
      if (this.current?.source !== source) {
        return
      }
      this.advance(name)
    }
    source.start()

    // Decide + prefetch the follow-up now (while this one plays) so the next
    // track is already decoded at hand-off time — no silent gap mid-set.
    this.queued = this.pickNext(name)
    void this.getBuffer(this.queued).catch(() => {})
  }

  private advance(justEnded: TrackName): void {
    if (!this.started) {
      return
    }
    // An END sting (bust / cash out) plays exactly ONCE — when it ends the soundtrack falls
    // silent (no auto-advance) until a new run calls resumeAfterEnd().
    if (END_TRACKS.includes(justEnded)) {
      this.stopCurrent()
      return
    }
    // The coda theme ran to its natural end INSIDE a single drawn-out hand (the theme restarts
    // on every deal, so it only ends naturally when one hand/prompt outlasts it, ~64.5s) — hand
    // off to a different rotation track rather than restarting its bang on a hand the player is
    // still sitting on. The next deal restarts the theme via codaHand().
    if (justEnded === CODA_TRACK && this.codaActive) {
      const next = this.queued ?? this.pickNext(CODA_TRACK)
      this.queued = null
      void this.playTrack(next)
      return
    }
    const next = this.queued ?? this.pickNext(justEnded)
    this.queued = null
    void this.playTrack(next)
  }

  // A random rotation track other than the one just played (no immediate repeats). The
  // coda theme is never in the pool, so this can never surface it outside the coda.
  private pickNext(justPlayed: TrackName): TrackName {
    const options = ROTATION_TRACKS.filter((name) => name !== justPlayed)
    return options[Math.floor(Math.random() * options.length)]
  }

  private stopCurrent(): void {
    if (!this.current) {
      return
    }
    const { source, gain } = this.current
    source.onended = null
    try {
      source.stop()
    } catch {
      // Already stopped / never started — nothing to do.
    }
    source.disconnect()
    gain.disconnect()
    this.current = null
  }

  // Ramp a (detached) track's gain to 0 over `fadeMs`, then stop + free it. Its onended is
  // repurposed to a plain cleanup (NOT advance()), so fading it out doesn't queue a next track.
  private fadeOutAndStop(track: { source: AudioBufferSourceNode; gain: GainNode }, fadeMs: number): void {
    const ctx = this.context()
    const { source, gain } = track
    const t0 = ctx.currentTime
    const end = t0 + Math.max(0.02, fadeMs / 1000)
    gain.gain.cancelScheduledValues(t0)
    gain.gain.setValueAtTime(gain.gain.value, t0)
    gain.gain.linearRampToValueAtTime(0, end)
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
    }
    try {
      source.stop(end + 0.05)
    } catch {
      // Already stopped — nothing to do.
    }
  }

  // Lazily download + decode a track, at most once. Concurrent callers share the
  // same in-flight promise; a failed download isn't cached, so it can retry.
  private getBuffer(name: TrackName): Promise<AudioBuffer> {
    const cached = this.buffers.get(name)
    if (cached) {
      return Promise.resolve(cached)
    }
    let pending = this.loads.get(name)
    if (!pending) {
      pending = this.download(name)
      this.loads.set(name, pending)
    }
    return pending
  }

  private async download(name: TrackName): Promise<AudioBuffer> {
    try {
      const ctx = this.context()
      const res = await fetch(TRACKS[name].url)
      const data = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(data)
      this.buffers.set(name, buffer)
      return buffer
    } catch (err) {
      // Drop the cached promise so a later play() can retry the download.
      this.loads.delete(name)
      throw err
    }
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = createAudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }
}

export const music = new MusicService()
