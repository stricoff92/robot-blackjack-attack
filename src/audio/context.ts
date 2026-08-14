// Shared WebAudio plumbing so the music, SFX and voice services survive the
// mobile (iOS/Android) autoplay + background/foreground quirks. All three services
// share ONE AudioContext (see createAudioContext); this module supplies the factory,
// the gesture/visibility unlock, a polling heartbeat, and a statechange handler that
// suspend the context while hidden and resume it on return.
//
// What actually makes iOS recover (learned from on-device logs):
//   1. ONE shared context. WebKit only reliably brings a context back out of the
//      app-switch 'interrupted' state if it has an active source; the always-playing
//      music keeps the shared context alive, so all audio rides the one that recovers.
//   2. Resume on the ctx's `statechange` event — the moment WebKit ends the
//      interruption. A blind resume() mid-interruption rejects with InvalidStateError;
//      the 500ms poll + gesture are backups, but the statechange handler is what lands.
// Mirrors the proven BaseAudioService approach from the ioubs.com project.
// Deliberately minimal — no master ducking, no deferred suspend, no event-suppression
// window: this game parks its render loop while hidden, so there is no backlog.

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext }

// iOS routes WebAudio through the ringer/mute switch unless the page declares a
// "playback" audio session, so a flipped mute switch silences the game. This is
// a navigator-wide flag (not per-context), so declare it once.
interface AudioSessionNavigator {
  audioSession?: { type: string }
}

// navigator.userActivation isn't in every TS DOM lib version; read it defensively.
interface ActivationNavigator {
  userActivation?: { hasBeenActive: boolean }
}

let audioSessionDeclared = false
function declarePlaybackSession(): void {
  if (audioSessionDeclared) {
    return
  }
  audioSessionDeclared = true
  // ?npb (no playback) disables the hint so device testing can A/B whether the
  // playback session itself is implicated in a background/return glitch.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('npb')) {
    return
  }
  const nav = navigator as Navigator & AudioSessionNavigator
  if (nav.audioSession) {
    try {
      nav.audioSession.type = 'playback'
    } catch {
      // Non-critical hint; ignore if the platform rejects it.
    }
  }
}

// Every context we've created. The shared listeners iterate this set so the DOM
// handlers are attached only once, however many services exist.
const contexts = new Set<AudioContext>()

// Contexts with an in-flight suspend()/resume(). iOS never resolves suspend() on
// an already-suspended context, so guard against overlapping calls that jam it.
const inFlight = new WeakSet<AudioContext>()

const HEARTBEAT_MS = 500

// ---- On-device diagnostics (?audiodebug) --------------------------------------
// iOS has no visible console, so we keep a tiny in-memory event log + a snapshot
// the overlay in main.ts renders. Guarded so it costs ~nothing when the flag is off.
const AUDIO_DEBUG =
  typeof window !== 'undefined' &&
  typeof window.location !== 'undefined' &&
  new URLSearchParams(window.location.search).has('audiodebug')
const ctxLabels = new WeakMap<AudioContext, string>()
const dbgEvents: string[] = []
let heartbeatTicks = 0
let dbgT0 = 0
function dlbl(ctx: AudioContext): string {
  return ctxLabels.get(ctx) ?? '?'
}
let dbgLastMsg = ''
let dbgLastCount = 0
function dlog(msg: string): void {
  if (!AUDIO_DEBUG) {
    return
  }
  if (dbgT0 === 0) {
    dbgT0 = performance.now()
  }
  // Collapse a run of identical messages (the 500ms resume-retry spams the same
  // line) so the log stays readable and the interesting events don't scroll away.
  if (msg === dbgLastMsg && dbgEvents.length > 0) {
    dbgLastCount++
    dbgEvents[dbgEvents.length - 1] = `${Math.round(performance.now() - dbgT0)} ${msg} x${dbgLastCount}`
    return
  }
  dbgLastMsg = msg
  dbgLastCount = 1
  dbgEvents.push(`${Math.round(performance.now() - dbgT0)} ${msg}`)
  if (dbgEvents.length > 60) {
    dbgEvents.shift()
  }
}
export function getAudioDebugSnapshot(): {
  hidden: boolean
  active: boolean | string
  hbTicks: number
  ctxs: string[]
  events: string[]
} {
  const nav = navigator as Navigator & ActivationNavigator
  const ctxs: string[] = []
  for (const c of contexts) {
    ctxs.push(`${dlbl(c)}:${c.state}`)
  }
  return {
    hidden: typeof document !== 'undefined' ? document.hidden : false,
    active: nav.userActivation ? nav.userActivation.hasBeenActive : 'n/a',
    hbTicks: heartbeatTicks,
    ctxs,
    events: dbgEvents.slice(-20),
  }
}

function errName(e: unknown): string {
  const err = e as { name?: string; message?: string } | undefined
  return (err && (err.name || err.message)) || String(e)
}

function suspendContext(ctx: AudioContext): void {
  if (ctx.state !== 'running' || inFlight.has(ctx)) {
    return
  }
  inFlight.add(ctx)
  dlog(`suspend call ${dlbl(ctx)}`)
  void ctx.suspend()
    .then(() => {
      dlog(`suspend ok ${dlbl(ctx)}`)
    })
    .catch((e) => {
      dlog(`suspend ERR ${dlbl(ctx)} ${errName(e)}`)
    })
    .finally(() => {
      inFlight.delete(ctx)
    })
}

function resumeContext(ctx: AudioContext): void {
  if (ctx.state === 'running' || inFlight.has(ctx)) {
    return
  }
  inFlight.add(ctx)
  dlog(`resume call ${dlbl(ctx)} (${ctx.state})`)
  void ctx.resume()
    .then(() => {
      dlog(`resume ok ${dlbl(ctx)} (${ctx.state})`)
    })
    .catch((e) => {
      dlog(`resume ERR ${dlbl(ctx)} ${errName(e)}`)
    })
    .finally(() => {
      inFlight.delete(ctx)
    })
}

// The reconciler: suspend every running context while hidden; resume every
// non-running context when visible + activated. Runs on a timer (and on
// visibilitychange) so a rejected iOS resume is retried until it lands. iOS won't
// honor resume() before the page has ever been activated, so gate on
// userActivation; the gesture unlock below is the reliable first unlock.
function heartbeat(): void {
  heartbeatTicks++
  if (typeof document !== 'undefined' && document.hidden) {
    for (const ctx of contexts) {
      suspendContext(ctx)
    }
    return
  }
  const nav = navigator as Navigator & ActivationNavigator
  if (nav.userActivation && !nav.userActivation.hasBeenActive) {
    return
  }
  for (const ctx of contexts) {
    resumeContext(ctx)
  }
}

// Resume synchronously inside a user gesture — the reliable iOS unlock,
// independent of the flaky userActivation timing. Kept attached (NOT
// { once: true }) so a later tap re-unlocks after backgrounding suspended us.
function gestureUnlock(): void {
  dlog('gesture')
  for (const ctx of contexts) {
    resumeContext(ctx)
  }
}

let listenersAttached = false
function attachListeners(): void {
  if (listenersAttached) {
    return
  }
  listenersAttached = true

  // Capture + passive so we never delay the UI.
  window.addEventListener('pointerdown', gestureUnlock, { capture: true, passive: true })
  window.addEventListener('touchend', gestureUnlock, { capture: true, passive: true })
  window.addEventListener('keydown', gestureUnlock)

  // Immediate reaction to a visibility flip, plus a steady poll that retries a
  // rejected resume(). setInterval (not rAF) so it stays independent of the
  // battery-saver parking the render loop; twice a second is ample and cheap.
  document.addEventListener('visibilitychange', heartbeat)
  setInterval(heartbeat, HEARTBEAT_MS)
}

// A SINGLE shared AudioContext for every service (music/sfx/voice each build their
// own master gain on it and mix at its destination). This is the crux of iOS
// recovery: WebKit only reliably brings a context back out of an app-switch
// 'interrupted' state if that context has an ACTIVE source — device logs showed
// the music context (always playing) resuming while the idle sfx/voice contexts
// threw InvalidStateError and stayed stuck. One context, kept live by the music,
// means all audio rides the context that recovers. It also matches the proven
// BaseAudioService (one context) and stays under iOS's AudioContext count limits.
let sharedCtx: AudioContext | null = null

// Return the shared AudioContext, wired into the iOS/Android unlock plumbing.
// Falls back to webkitAudioContext for older Safari. `label` is diagnostics-only.
export function createAudioContext(label = '?'): AudioContext {
  if (sharedCtx) {
    ctxLabels.set(sharedCtx, `${ctxLabels.get(sharedCtx) ?? ''}+${label}`)
    return sharedCtx
  }
  const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
  sharedCtx = new Ctor()
  ctxLabels.set(sharedCtx, label)
  declarePlaybackSession()
  contexts.add(sharedCtx)
  attachListeners()
  // WebKit fires statechange when it ENTERS and LEAVES the app-switch 'interrupted'
  // state. Resuming right here — the moment iOS says the state changed — lands where
  // a blind 500ms poll throws InvalidStateError mid-interruption. Also our clearest
  // window into what the device actually does.
  const ctx = sharedCtx
  if (typeof ctx.addEventListener === 'function') {
    ctx.addEventListener('statechange', () => {
      dlog(`statechange → ${ctx.state}`)
      if (typeof document !== 'undefined' && !document.hidden) {
        heartbeat()
      }
    })
  }
  dlog(`ctx created ${label} (${sharedCtx.state})`)
  return sharedCtx
}
