// Battery-saver preference — a tiny persisted boolean that tells the render loop it may PARK
// (stop requestAnimationFrame) when the scene is idle, instead of repainting the perpetual
// ambient (nexus hover, holo projector, damage sparks) at 60fps forever. That idle repaint is
// what drains the battery + heats the phone; see the render loop in ui/game-view.ts.
//
// Modelled on leaderboard.ts: a thin facade over the platform key/value store (SDK.data
// on-platform, else localStorage — see ../platform/crazygames) with an in-memory cache. Kept
// dependency-light (no UI imports) so anything can read it.
//
// Default (when the player has NEVER touched the toggle) is derived per-device: ON for touch /
// coarse-pointer devices (phones/tablets — where battery + heat matter) or when the OS "reduce
// motion" accessibility setting is on; OFF on desktop. The auto-default is NOT persisted, so an
// unset preference adapts to whatever device the account plays on (SDK.data syncs the EXPLICIT
// choice across devices, but not the absence of one).
import { loadValue, saveValue } from '../platform/crazygames'

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
    const raw = loadValue(SAVER_KEY)
    cached = raw === null ? defaultBatterySaver() : raw === '1'
  }
  return cached
}

// Persist an EXPLICIT player choice (only explicit toggles are stored — never the default, so an
// untouched preference keeps adapting per-device).
export function setBatterySaver(on: boolean): void {
  cached = on
  saveValue(SAVER_KEY, on ? '1' : '0')
}

// The per-device default when nothing is stored: ON for touch / coarse-pointer devices or when
// the OS prefers reduced motion; OFF otherwise.
export function defaultBatterySaver(): boolean {
  return coarsePointer() || prefersReducedMotion()
}

function coarsePointer(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
    return true
  }
  return (navigator.maxTouchPoints ?? 0) > 0
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
