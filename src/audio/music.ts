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

export type TrackName = 'cannery' | 'serpentine' | 'maestro' | 'machinations'

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
}

const ALL_TRACKS = Object.keys(TRACKS) as TrackName[]
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

  // Stop the soundtrack. start() can begin it again from "The Cannery".
  stop(): void {
    this.started = false
    this.queued = null
    this.stopCurrent()
  }

  private async playTrack(name: TrackName): Promise<void> {
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
    gain.gain.value = this.baseVolumes.get(name) ?? 1
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
    const next = this.queued ?? this.pickNext(justEnded)
    this.queued = null
    void this.playTrack(next)
  }

  // A random track other than the one just played (no immediate repeats).
  private pickNext(justPlayed: TrackName): TrackName {
    const options = ALL_TRACKS.filter((name) => name !== justPlayed)
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
