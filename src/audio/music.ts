// The music service: a second, independent WebAudio graph for background
// tracks. It owns its own AudioContext (separate from the SFX service) so
// music and effects carry their own master level and can be muted or ducked
// independently.
//
// Scaffold only for now — no tracks are wired yet. It preloads/decodes track
// buffers the same way the SFX service does and plays one looping track at a
// time through a master gain, so tracks can be added later without reworking
// the plumbing.

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext }

// Register track name → asset URL here as music is added.
const TRACKS: Record<string, string> = {}

export type MusicTrack = keyof typeof TRACKS

class MusicService {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buffers = new Map<string, AudioBuffer>()
  private current: AudioBufferSourceNode | null = null
  private volume = 1
  private loadPromise: Promise<void> | null = null

  // Download + decode every registered track. Idempotent.
  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadAll()
    }
    return this.loadPromise
  }

  // Master music level (1 = 100%).
  setVolume(volume: number): void {
    this.volume = volume
    if (this.master) {
      this.master.gain.value = volume
    }
  }

  // Loop a track, replacing whatever is playing. No-op until decoded.
  play(track: MusicTrack, loop = true): void {
    const ctx = this.ctx
    const buffer = this.buffers.get(track)
    if (!ctx || !this.master || !buffer) {
      return
    }
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    this.stop()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = loop
    source.connect(this.master)
    source.start()
    this.current = source
  }

  stop(): void {
    if (this.current) {
      this.current.stop()
      this.current.disconnect()
      this.current = null
    }
  }

  private async loadAll(): Promise<void> {
    const ctx = this.context()
    await Promise.all(
      Object.entries(TRACKS).map(async ([name, url]) => {
        const res = await fetch(url)
        const data = await res.arrayBuffer()
        this.buffers.set(name, await ctx.decodeAudioData(data))
      }),
    )
  }

  private context(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }
}

export const music = new MusicService()
