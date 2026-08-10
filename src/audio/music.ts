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
import decisionsUrl from '../assets/KevinMacLeodDecisions.ogg'

export type TrackName =
  | 'cannery'
  | 'serpentine'
  | 'maestro'
  | 'machinations'
  | 'getaway'
  | 'bust'
  | 'cashout'
  | 'decisions'

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
  decisions: { url: decisionsUrl, baseVolume: 1 },
}

const ALL_TRACKS = Object.keys(TRACKS) as TrackName[]
// Coda-only tracks, NEVER in the normal rotation — each plays only from its dedicated trigger:
//   • CODA_TRACK ("Mistake the Getaway") — the double-or-nothing theme (codaHand).
//   • BUST_TRACK (piano/violin/viola trio) — the sting for LOSING the coda (codaBust).
//   • CASHOUT_TRACK ("Enigma") — the sting for CASHING OUT of the coda (codaCashOut).
//   • DECISIONS_TRACK ("Decisions") — the Banker-approach theme, plays ONCE while the player
//     weighs double-or-nothing vs cash out (codaDecisions), then falls silent.
const CODA_TRACK: TrackName = 'getaway'
const BUST_TRACK: TrackName = 'bust'
const CASHOUT_TRACK: TrackName = 'cashout'
const DECISIONS_TRACK: TrackName = 'decisions'
// End stings: play exactly ONCE and then the soundtrack goes silent until a new run.
const END_TRACKS: TrackName[] = [BUST_TRACK, CASHOUT_TRACK]
const ROTATION_TRACKS = ALL_TRACKS.filter(
  (name) =>
    name !== CODA_TRACK && name !== BUST_TRACK && name !== CASHOUT_TRACK && name !== DECISIONS_TRACK,
)
// Coda transitions are FAST — a slow fade would mush the sharp attacks. Whatever's playing
// ducks out over CODA_FADE_OUT_MS; the coda THEME itself hard-starts (fadeIn 0) so its opening
// bang lands at full volume every deal, while the end stings fade in over CODA_FADE_IN_MS.
// (prefetchCoda decodes the buffers ahead of time, so there's no download gap behind the fade.)
const CODA_FADE_OUT_MS = 140
const CODA_FADE_IN_MS = 60
// The "Decisions" (Banker-approach) theme rises from the coda-entry silence, so it fades IN
// gently rather than hard-starting — nothing's playing under it to duck against.
const DECISIONS_FADE_IN_MS = 500
// "The Cannery" always plays first.
const OPENING_TRACK: TrackName = 'cannery'

class MusicService {
  private ctx_: AudioContext | null = null
  private master_: GainNode | null = null
  // Decoded buffers, cached so each track downloads at most once.
  private readonly buffers_ = new Map<TrackName, AudioBuffer>()
  // In-flight downloads, so overlapping requests for one track share a fetch.
  private readonly loads_ = new Map<TrackName, Promise<AudioBuffer>>()
  // Per-track base levels, seeded from TRACKS but mutable via setBaseVolume() and
  // persisting across replays of a track.
  private readonly baseVolumes_ = new Map<TrackName, number>(
    ALL_TRACKS.map((name) => [name, TRACKS[name].baseVolume]),
  )
  private current_: { source: AudioBufferSourceNode; gain: GainNode; name: TrackName } | null = null
  // Decided + prefetched when the current track starts, for a gapless hand-off.
  private queued_: TrackName | null = null
  private started_ = false
  private volume_ = 1
  // Platform mute (CrazyGames settings.muteAudio) — silences the master while set, independent of
  // `volume` so unmuting restores the level. Overrides any in-game level.
  private muted_ = false

  // --- Banker-coda (double-or-nothing) theme ---
  // True while the run is inside an active coda hand: "Mistake the Getaway" is the theme, and
  // if it runs to its natural end within one drawn-out hand it hands off to a rotation track.
  private codaActive_ = false
  // True from a coda END sting (bust or cash out) until the next run: the sting plays once
  // and then the soundtrack goes SILENT (no auto-advance). resumeAfterEnd() clears it.
  private endSilence_ = false

  // Begin the soundtrack: "The Cannery" first, then random non-repeating tracks
  // forever. Idempotent — after the first call it just makes sure the context is
  // resumed. Safe to call before any user gesture; the shared unlock plumbing
  // resumes the context (and the already-scheduled track) once a gesture arrives.
  start(): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    if (this.started_) {
      return
    }
    this.started_ = true
    void this.playTrack_(OPENING_TRACK)
  }

  // Master music level (1 = 100%), applied to every track. Persists across tracks.
  setVolume(volume: number): void {
    this.volume_ = volume
    if (this.master_) {
      this.master_.gain.value = this.muted_ ? 0 : volume
    }
  }

  // Platform mute toggle (CrazyGames settings.muteAudio). Silences the master; restores `volume`
  // on unmute.
  setMuted(muted: boolean): void {
    this.muted_ = muted
    if (this.master_) {
      this.master_.gain.value = muted ? 0 : this.volume_
    }
  }

  // Set one track's base level (1 = 100%), independent of the master volume.
  // Persists across replays; takes effect immediately if that track is playing.
  setBaseVolume(track: TrackName, volume: number): void {
    this.baseVolumes_.set(track, volume)
    if (this.current_?.name === track) {
      this.current_.gain.gain.value = volume
    }
  }

  // Crossfade to a fresh (non-repeating) track: fade the current one OUT while a new one
  // fades IN over `fadeMs`. Used when a new dealer starts so the soundtrack turns over. If
  // nothing is playing yet, just begins the set.
  advanceTrack(fadeMs = 2000): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    if (!this.started_) {
      this.start()
      return
    }
    // Detach the current track and fade it out independently, so the incoming one crossfades
    // over it instead of being cut off (playTrack's stopCurrent then finds nothing to stop).
    const outgoing = this.current_
    this.current_ = null
    if (outgoing) {
      this.fadeOutAndStop_(outgoing, fadeMs)
    }
    // Prefer the already-prefetched follow-up (decoded, so the fade-in is gapless).
    const next = this.queued_ ?? this.pickNext_(outgoing?.name ?? OPENING_TRACK)
    this.queued_ = null
    void this.playTrack_(next, fadeMs)
  }

  // A double-or-nothing round has begun — call once per coda hand (each codaGamble). (Re)starts
  // the coda theme ("Mistake the Getaway") from the beginning, EVERY hand, so its opening bang
  // lands on each deal. This is the ONLY place the coda track is ever started — it never joins
  // the normal rotation.
  codaHand(): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.started_ = true
    this.codaActive_ = true
    // Restart the theme from the BEGINNING on every deal — its opening BANG should land each
    // hand, so a prior round's playback never runs on. Whatever's up (a prior getaway, or the
    // coda-entry silence) ducks out fast while the theme HARD-starts at full volume (fadeIn 0)
    // so the bang isn't softened. prefetchCoda has the buffer decoded, so no download gap.
    const outgoing = this.current_
    this.current_ = null
    this.queued_ = null
    if (outgoing) {
      this.fadeOutAndStop_(outgoing, CODA_FADE_OUT_MS)
    }
    void this.playTrack_(CODA_TRACK, 0)
  }

  // Warm the coda buffers ahead of time (call at coda entry) so the quick fades of
  // codaHand()/codaBust()/codaCashOut() have decoded buffers ready and expose no download gap.
  // Download only — none starts playback (that stays exclusive to their triggers).
  prefetchCoda(): void {
    void this.getBuffer_(CODA_TRACK).catch(() => {})
    void this.getBuffer_(BUST_TRACK).catch(() => {})
    void this.getBuffer_(CASHOUT_TRACK).catch(() => {})
    void this.getBuffer_(DECISIONS_TRACK).catch(() => {})
  }

  // The Banker's entry shred has just finished (fired from game-view once the shred completes):
  // play the "Decisions" theme ONCE while the player weighs double-or-nothing vs cash out,
  // filling what used to be the coda-entry silence. It never loops or auto-advances — when it
  // ends the soundtrack simply falls silent again, and the player's choice starts the coda theme
  // (codaHand) or an end sting (codaCashOut). prefetchCoda has the buffer decoded, so no gap.
  codaDecisions(): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.started_ = true
    this.codaActive_ = false
    this.endSilence_ = false
    // Fade out whatever remains of the coda-entry fade-to-silence (usually already gone) and
    // bring "Decisions" up gently from underneath.
    const outgoing = this.current_
    this.current_ = null
    this.queued_ = null
    if (outgoing) {
      this.fadeOutAndStop_(outgoing, CODA_FADE_OUT_MS)
    }
    void this.playTrack_(DECISIONS_TRACK, DECISIONS_FADE_IN_MS)
  }

  // Dealer 6 has been defeated (the winning hand is revealed): fade the fight music out to
  // SILENCE and hold there. The quiet holds through the Banker's walk-in + entry shred — the
  // "Decisions" theme (codaDecisions) rises once the shred completes — until the player chooses
  // double-or-nothing (codaHand → the coda theme) or cash out (codaCashOut → the cash-out sting).
  enterCodaSilence(fadeMs = 1500): void {
    this.codaActive_ = false
    this.endSilence_ = false
    const outgoing = this.current_
    this.current_ = null
    this.queued_ = null
    if (outgoing) {
      this.fadeOutAndStop_(outgoing, fadeMs)
    }
  }

  // The player BUSTED out of the coda (lost the double-or-nothing, score zeroed): play the
  // bust sting once, then silence until a new run.
  codaBust(): void {
    this.playEndSting_(BUST_TRACK)
  }

  // The player CASHED OUT of the coda (banked the score, run ended): play the cash-out sting
  // once, then silence until a new run.
  codaCashOut(): void {
    this.playEndSting_(CASHOUT_TRACK)
  }

  // Snap whatever's playing out and play a one-shot END sting; when it finishes advance() sees
  // an END_TRACK and goes SILENT (endSilence held) until resumeAfterEnd() on the next run.
  private playEndSting_(track: TrackName): void {
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.started_ = true
    this.codaActive_ = false
    this.endSilence_ = true
    const outgoing = this.current_
    this.current_ = null
    if (outgoing) {
      this.fadeOutAndStop_(outgoing, CODA_FADE_OUT_MS)
    }
    this.queued_ = null
    void this.playTrack_(track, outgoing ? CODA_FADE_IN_MS : 0)
  }

  // A fresh run started after a coda end sting: fade the sting out (or break its trailing
  // silence) and bring a normal dealer track back in. No-op unless we're in the post-end
  // silence, so an ordinary game-over → new run keeps whatever's already playing.
  resumeAfterEnd(): void {
    if (!this.endSilence_) {
      return
    }
    this.endSilence_ = false
    this.advanceTrack()
  }

  // Stop the soundtrack. start() can begin it again from "The Cannery".
  stop(): void {
    this.started_ = false
    this.queued_ = null
    this.codaActive_ = false
    this.endSilence_ = false
    this.stopCurrent_()
  }

  // Play `name`, optionally FADING IN over `fadeInMs` (0 = start at full) so it can
  // crossfade over a track that advanceTrack() is fading out.
  private async playTrack_(name: TrackName, fadeInMs = 0): Promise<void> {
    const buffer = await this.getBuffer_(name)
    // Bailed out (stop()) while the track was still downloading.
    if (!this.started_) {
      return
    }
    const ctx = this.context_()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.stopCurrent_()

    // source → per-track base gain → master → destination, so each track's
    // level is independently tunable (setBaseVolume) beneath the shared volume.
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    const base = this.baseVolumes_.get(name) ?? 1
    if (fadeInMs > 0) {
      const t = ctx.currentTime
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(base, t + fadeInMs / 1000)
    } else {
      gain.gain.value = base
    }
    source.connect(gain).connect(this.master_ as GainNode)
    this.current_ = { source, gain, name }
    source.onended = () => {
      // Ignore the ended event from a source we deliberately replaced.
      if (this.current_?.source !== source) {
        return
      }
      this.advance_(name)
    }
    source.start()

    // Decide + prefetch the follow-up now (while this one plays) so the next
    // track is already decoded at hand-off time — no silent gap mid-set.
    this.queued_ = this.pickNext_(name)
    void this.getBuffer_(this.queued_).catch(() => {})
  }

  private advance_(justEnded: TrackName): void {
    if (!this.started_) {
      return
    }
    // An END sting (bust / cash out) plays exactly ONCE — when it ends the soundtrack falls
    // silent (no auto-advance) until a new run calls resumeAfterEnd().
    if (END_TRACKS.includes(justEnded)) {
      this.stopCurrent_()
      return
    }
    // The Banker-approach "Decisions" theme also plays exactly ONCE — if the player is still
    // weighing the coda when it ends, fall silent (no rotation track) until their choice starts
    // the next music. No endSilence latch: this is mid-coda, not a run-end sting.
    if (justEnded === DECISIONS_TRACK) {
      this.stopCurrent_()
      return
    }
    // The coda theme ran to its natural end INSIDE a single drawn-out hand (the theme restarts
    // on every deal, so it only ends naturally when one hand/prompt outlasts it, ~64.5s) — hand
    // off to a different rotation track rather than restarting its bang on a hand the player is
    // still sitting on. The next deal restarts the theme via codaHand().
    if (justEnded === CODA_TRACK && this.codaActive_) {
      const next = this.queued_ ?? this.pickNext_(CODA_TRACK)
      this.queued_ = null
      void this.playTrack_(next)
      return
    }
    const next = this.queued_ ?? this.pickNext_(justEnded)
    this.queued_ = null
    void this.playTrack_(next)
  }

  // A random rotation track other than the one just played (no immediate repeats). The
  // coda theme is never in the pool, so this can never surface it outside the coda.
  private pickNext_(justPlayed: TrackName): TrackName {
    const options = ROTATION_TRACKS.filter((name) => name !== justPlayed)
    return options[Math.floor(Math.random() * options.length)]
  }

  private stopCurrent_(): void {
    if (!this.current_) {
      return
    }
    const { source, gain } = this.current_
    source.onended = null
    try {
      source.stop()
    } catch {
      // Already stopped / never started — nothing to do.
    }
    source.disconnect()
    gain.disconnect()
    this.current_ = null
  }

  // Ramp a (detached) track's gain to 0 over `fadeMs`, then stop + free it. Its onended is
  // repurposed to a plain cleanup (NOT advance()), so fading it out doesn't queue a next track.
  private fadeOutAndStop_(track: { source: AudioBufferSourceNode; gain: GainNode }, fadeMs: number): void {
    const ctx = this.context_()
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
  private getBuffer_(name: TrackName): Promise<AudioBuffer> {
    const cached = this.buffers_.get(name)
    if (cached) {
      return Promise.resolve(cached)
    }
    let pending = this.loads_.get(name)
    if (!pending) {
      pending = this.download_(name)
      this.loads_.set(name, pending)
    }
    return pending
  }

  private async download_(name: TrackName): Promise<AudioBuffer> {
    try {
      const ctx = this.context_()
      const res = await fetch(TRACKS[name].url)
      const data = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(data)
      this.buffers_.set(name, buffer)
      return buffer
    } catch (err) {
      // Drop the cached promise so a later play() can retry the download.
      this.loads_.delete(name)
      throw err
    }
  }

  private context_(): AudioContext {
    if (!this.ctx_) {
      this.ctx_ = createAudioContext()
      this.master_ = this.ctx_.createGain()
      this.master_.gain.value = this.muted_ ? 0 : this.volume_
      this.master_.connect(this.ctx_.destination)
    }
    return this.ctx_
  }
}

export const music = new MusicService()
