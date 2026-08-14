// Music-mute preference — a tiny persisted boolean that silences the background MUSIC only (the
// SFX + dealer voice keep playing), so a player running their own playlist can kill the game's
// soundtrack without losing the gameplay sound. The mute is applied by dropping the music master
// gain to 0 (never by stopping the source — the always-playing music is what keeps the shared
// AudioContext alive for iOS/Android interruption recovery; see src/audio/context.ts).
//
// This is a PER-DEVICE preference (a listening choice for THIS phone/laptop — which speaker/room,
// whose playlist), so it is stored in the device's own localStorage — deliberately NOT the SDK.data
// store the rest of the game uses for the run/score. SDK.data syncs across every device a logged-in
// CrazyGames account plays on, which is right for a run but WRONG here: muting music on a phone must
// not force it muted on the same account's desktop. localStorage never leaves the device. Kept
// dependency-light (no UI or platform imports), with an in-memory cache over the storage read.
//
// Default (when the player has NEVER touched the toggle) is OFF — music plays — the same everywhere;
// unlike the battery-saver default this needs no per-device derivation.

const MUSIC_MUTE_KEY = 'rba.musicMuted'

// null = not yet loaded. The stored value is '1'/'0', or absent when the player has never
// explicitly chosen (we then fall back to the default: not muted).
let cached: boolean | null = null

// Whether the music is currently muted by the player: a DEV URL override (?music=on|off) wins for
// testing, then the player's explicit stored choice, then the default (false = music plays). Read
// once and cached; the view holds it in a field refreshed on toggle.
export function isMusicMuted(): boolean {
  const forced = forcedOverride()
  if (forced !== null) {
    return forced
  }
  if (cached === null) {
    const raw = loadLocal(MUSIC_MUTE_KEY)
    cached = raw === null ? false : raw === '1'
  }
  return cached
}

// Persist an EXPLICIT player choice.
export function setMusicMuted(muted: boolean): void {
  cached = muted
  saveLocal(MUSIC_MUTE_KEY, muted ? '1' : '0')
}

// Device-local storage read/write. Any failure (private mode, "Block All Cookies", a blocked
// storage partition) is swallowed: a read falls back to null → the default, and a write is dropped
// but the in-memory `cached` still holds the choice for the rest of the session.
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

// DEV-only URL override for testing regardless of stored pref: ?music=on|off, where `on` = music
// plays (not muted) and `off` = muted. Compiled out of the production build (import.meta.env.DEV is
// false there), so it can never fire live.
function forcedOverride(): boolean | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return null
  }
  const v = new URLSearchParams(window.location.search).get('music')
  if (v === 'on') {
    return false // music on → not muted
  }
  if (v === 'off') {
    return true // music off → muted
  }
  return null
}
