// Shared WebAudio plumbing so both the music and SFX services survive the
// mobile (iOS/Android) autoplay + background/foreground quirks. Each service
// still owns its OWN AudioContext — music and effects keep independent master
// levels and can be muted/ducked separately — this module only supplies the
// context factory and the single set of gesture/visibility listeners that
// unlock and suspend/resume every context we hand out.

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

function resumeAll(): void {
  for (const ctx of contexts) {
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {})
    }
  }
}

let listenersAttached = false
function attachListeners(): void {
  if (listenersAttached) {
    return
  }
  listenersAttached = true

  // Resume synchronously inside a user gesture — the reliable iOS unlock. Kept
  // attached (NOT { once: true }) so a later tap re-unlocks after the context is
  // suspended by backgrounding. Capture + passive so we never delay the UI.
  window.addEventListener('pointerdown', resumeAll, { capture: true, passive: true })
  window.addEventListener('touchend', resumeAll, { capture: true, passive: true })
  window.addEventListener('keydown', resumeAll)

  // Suspend while the tab is hidden (saves power and avoids a backlog of
  // scheduled sounds firing at once on return); resume when it's visible again.
  // iOS won't honor resume() before the page has ever been activated, so gate
  // the resume on userActivation.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const ctx of contexts) {
        if (ctx.state === 'running') {
          void ctx.suspend().catch(() => {})
        }
      }
      return
    }
    const nav = navigator as Navigator & ActivationNavigator
    if (nav.userActivation && !nav.userActivation.hasBeenActive) {
      return
    }
    resumeAll()
  })
}

// Create an AudioContext wired into the shared iOS/Android unlock plumbing.
// Falls back to webkitAudioContext for older Safari.
export function createAudioContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
  const ctx = new Ctor()
  declarePlaybackSession()
  contexts.add(ctx)
  attachListeners()
  return ctx
}
