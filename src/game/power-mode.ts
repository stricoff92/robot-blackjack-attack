// Battery-saver preference — a tiny persisted boolean that tells the render loop it may PARK
// (stop requestAnimationFrame) when the scene is idle, instead of repainting the perpetual
// ambient (nexus hover, holo projector, damage sparks) at 60fps forever. That idle repaint is
// what drains the battery + heats the phone; see the render loop in ui/game-view.ts.
//
// This is a PER-DEVICE preference (it reflects THIS phone/laptop's battery + thermal reality), so
// it is stored in the device's own localStorage — deliberately NOT the SDK.data store the rest of
// the game uses for the run/score. SDK.data syncs across every device a logged-in CrazyGames
// account plays on ("The data will also be synced on all the devices where the user plays the
// game"), which is right for a run but WRONG here: toggling saver ON on a phone must not force it ON
// on the same account's desktop. localStorage never leaves the device. Kept dependency-light (no UI
// or platform imports) so anything can read it, with an in-memory cache over the storage read.
//
// Default (when the player has NEVER touched the toggle) is derived per-device: ON for mobile-class
// touch devices (phones/tablets — where battery + heat matter) or when the OS "reduce motion"
// accessibility setting is on; OFF on desktop (incl. touchscreen laptops). The auto-default is NOT
// persisted, so an unset preference keeps re-deriving from whatever device is in hand.

const SAVER_KEY = 'rba.batterySaver'

// null = not yet loaded. The stored value is '1'/'0', or absent when the player has never
// explicitly chosen (we then fall back to defaultBatterySaver()).
let cached: boolean | null = null

// Whether battery saver is currently active: a DEV URL override (?battery=on|off) wins for
// testing, then the player's explicit stored choice, then the per-device default. Read once at
// view construction (the render loop holds it in a field, refreshed on toggle) — not per frame.
export function isBatterySaver(): boolean {
  const forced = forcedOverride()
  if (forced !== null) {
    return forced
  }
  if (cached === null) {
    const raw = loadLocal(SAVER_KEY)
    cached = raw === null ? defaultBatterySaver() : raw === '1'
  }
  return cached
}

// Persist an EXPLICIT player choice (only explicit toggles are stored — never the default, so an
// untouched preference keeps adapting per-device).
export function setBatterySaver(on: boolean): void {
  cached = on
  saveLocal(SAVER_KEY, on ? '1' : '0')
}

// Device-local storage read/write. Any failure (private mode, "Block All Cookies", a blocked
// storage partition) is swallowed: a read falls back to null → re-derive the per-device default, and
// a write is dropped but the in-memory `cached` still holds the choice for the rest of the session.
function loadLocal(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function saveLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — `cached` keeps the choice alive until the tab closes. */
  }
}

// The per-device default when nothing is stored: ON for mobile-class touch devices or when the OS
// prefers reduced motion; OFF otherwise.
export function defaultBatterySaver(): boolean {
  return mobileLikeDevice() || prefersReducedMotion()
}

// A mobile-class device: the primary pointer is coarse (touch) AND the device can't hover. The
// `hover: none` clause is what excludes touchscreen laptops/desktops — a mouse can hover, a finger
// can't — so they (and plain desktops) default OFF, while phones and tablets default ON. We do NOT
// use `navigator.maxTouchPoints > 0` as a general signal: a touchscreen desktop reports touch
// points yet is not mobile, and flagging it ON was the over-trigger this replaced.
function mobileLikeDevice(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
  }
  // Last-resort fallback only when media queries are entirely unavailable — never the case on a
  // real touchscreen desktop (those support matchMedia), so this can't re-introduce the over-trigger.
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// DEV-only URL override for testing regardless of device/stored pref: ?battery=on|off. Compiled
// out of the production build (import.meta.env.DEV is false there), so it can never fire live.
function forcedOverride(): boolean | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return null
  }
  const v = new URLSearchParams(window.location.search).get('battery')
  if (v === 'on') {
    return true
  }
  if (v === 'off') {
    return false
  }
  return null
}
