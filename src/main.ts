import { sfx } from './audio/sfx'
import { music } from './audio/music'
import { voice } from './audio/voice'
import { getAudioDebugSnapshot } from './audio/context'
import { getMuteSetting, initCrazyGames, loadingStart, loadingStop, logStorageHealth, onMuteChange, setAudioMuteControl } from './platform/crazygames'
import { bootAllowed, renderLock } from './platform/sitelock'
import { isBatterySaver } from './game/power-mode'
import { isMusicMuted } from './game/music-mute'
import { setSaverDpr } from './render/canvas'
import { mountGameView } from './ui/game-view'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('missing #app mount element')
}

// Boot failsafe. The splash (index.html) is removed on the normal path once the game view mounts,
// and by renderLock on a sitelocked host — but nothing covers a boot that never finishes: a throw
// anywhere in this module, a hung SDK, or an exception inside mountGameView all leave it pulsing
// forever. In production there is no error overlay, so an endless spinner is indistinguishable from
// a slow load and reads as "still loading" rather than "broken". Armed FIRST, before any await, so
// it survives a failure at any point below; the normal removal beats it by seconds, making this a
// no-op in every healthy boot. Deliberately generous — it must never cut a slow-but-working load.
const BOOT_SPLASH_FAILSAFE_MS = 12000
window.setTimeout(() => document.getElementById('boot-splash')?.remove(), BOOT_SPLASH_FAILSAFE_MS)

// DEV-only on-screen error overlay. iOS Safari has no visible console, and an uncaught error inside
// the requestAnimationFrame loop silently kills it — the game just freezes mid-cinematic with no
// clue why. This surfaces any uncaught error / promise rejection ON SCREEN (message + stack) so a
// device without Web Inspector can still read + screenshot the exact throwing line. Compiled out of
// production (import.meta.env.DEV). Tap to dismiss.
if (import.meta.env.DEV) {
  const showError = (label: string, err: unknown): void => {
    const e = err as { message?: string; stack?: string } | undefined
    const text = `${label}: ${(e && (e.stack || e.message)) || String(err)}`
    let box = document.getElementById('dev-error-overlay')
    if (!box) {
      box = document.createElement('div')
      box.id = 'dev-error-overlay'
      box.setAttribute(
        'style',
        'position:fixed;left:0;right:0;bottom:0;max-height:55vh;overflow:auto;z-index:2147483647;' +
          'background:rgba(120,0,0,0.95);color:#fff;font:12px/1.4 ui-monospace,Menlo,monospace;' +
          'padding:10px 12px;white-space:pre-wrap;word-break:break-word;-webkit-user-select:text;user-select:text;',
      )
      box.addEventListener('pointerdown', () => box && box.remove())
      document.body.appendChild(box)
    }
    box.textContent = `⚠️ TAP TO DISMISS\n\n${text}\n\n${box.textContent ?? ''}`
    // Also log, in case Web Inspector IS attached.
    console.error(label, err)
  }
  window.addEventListener('error', (ev) => showError('error', ev.error ?? ev.message))
  window.addEventListener('unhandledrejection', (ev) => showError('unhandledrejection', ev.reason))
}

// On-device audio diagnostics (?audiodebug). iOS has no visible console, so render the
// audio lifecycle state on screen. The two independent tick counters are the key datum:
// raf (requestAnimationFrame) vs int (setInterval) — after backgrounding and returning,
// whichever one KEEPS ADVANCING is the timer that recovers on this device. `hb` is the
// audio module's own setInterval heartbeat; if it stalls on return while `raf` climbs,
// the poll cadence is the bug. The event log shows the resume/suspend outcomes. Compiled
// out of production (import.meta.env.DEV), so no debug surface ships with the release.
if (import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('audiodebug')) {
  const panel = document.createElement('div')
  panel.id = 'audio-debug-overlay'
  panel.setAttribute(
    'style',
    'position:fixed;left:0;top:0;z-index:2147483646;max-width:100vw;max-height:72vh;overflow:auto;' +
      'background:rgba(0,0,0,0.82);color:#3f6;font:11px/1.35 ui-monospace,Menlo,monospace;' +
      'padding:6px 8px;white-space:pre-wrap;word-break:break-word;pointer-events:none;',
  )
  const attach = (): void => {
    if (document.body) {
      document.body.appendChild(panel)
    } else {
      requestAnimationFrame(attach)
    }
  }
  attach()
  let rafTicks = 0
  let intTicks = 0
  const render = (): void => {
    const s = getAudioDebugSnapshot()
    panel.textContent =
      `raf:${rafTicks}  int:${intTicks}  hb:${s.hbTicks}\n` +
      `hidden:${s.hidden}  active:${s.active}\n` +
      `ctx: ${s.ctxs.join('   ')}\n` +
      `--- events ---\n` +
      s.events.join('\n')
  }
  const rafLoop = (): void => {
    rafTicks++
    render()
    requestAnimationFrame(rafLoop)
  }
  requestAnimationFrame(rafLoop)
  window.setInterval(() => {
    intTicks++
    render()
  }, 500)
}

// Download + decode every sound effect up front so a play() is instant. The
// context stays suspended until the first user gesture (autoplay policy); the
// SFX service resumes it then. Fire-and-forget — plays before it settles no-op.
void sfx.load()

// The dealer voice is fully synthesised (no assets to load), but its AudioContext must
// exist BEFORE the first user gesture so the shared unlock plumbing (context.ts) resumes
// it — otherwise the first laugh is born on a suspended context and never sounds.
voice.prime()

// Start the soundtrack on the first user gesture (autoplay policy blocks audio
// until then). "The Cannery" opens; the other tracks download lazily as each
// becomes the next to play. start() is idempotent, so the extra listener that
// doesn't fire is harmless — we remove both once music is going.
// Overall music loudness ceiling — a single master multiplier over every track (the per-track
// baseVolumes in music.ts already sit the tracks at one equal loudness beneath this). Kept under
// the SFX so music stays a bed, not a wall. Tune by ear with `music.setVolume(x)` in the console
// (see the dev hook below) and bake the value you land on in here.
const MUSIC_LEVEL = 0.4
music.setVolume(MUSIC_LEVEL)
// Apply the player's per-device music-mute choice (the HUD music toggle) before playback starts.
// Independent of the platform mute wired below — both are OR'd inside the music service.
music.setUserMuted(isMusicMuted())

const startMusic = (): void => {
  music.start()
  window.removeEventListener('pointerdown', startMusic)
  window.removeEventListener('keydown', startMusic)
}
window.addEventListener('pointerdown', startMusic)
window.addEventListener('keydown', startMusic)

// Bring up the CrazyGames SDK BEFORE mounting: init preloads the player's saved data (the
// data-module docs say to initialize during loading), so the title screen can offer Continue / New
// game from a resumable run and the personal best reads from the account rather than an empty
// iframe localStorage. Bounded by a timeout so a slow or blocked SDK can't hang boot — if it
// doesn't resolve in time we mount anyway (reads fall back to localStorage). Instant off-platform.
const SDK_INIT_TIMEOUT_MS = 3000
await Promise.race([
  initCrazyGames(),
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, SDK_INIT_TIMEOUT_MS)
  }),
])

// Dev-only: report whether the run-persistence store actually persists. iOS Safari can make
// localStorage throw or go ephemeral (Private tab / Block All Cookies / in-app webview), which
// otherwise silently drops every save — this surfaces it in Web Inspector at startup.
logStorageHealth()

// Production sitelock: only boot on a genuine CrazyGames host. Runs after SDK init so the hybrid
// check can consult the SDK's environment. A no-op in dev / preview-unlock builds; on a foreign
// prod host it blanks the screen and halts here (before any loading event or game mount) with a
// never-resolving await — no thrown error, nothing for a thief to see. See platform/sitelock.ts.
if (!bootAllowed()) {
  renderLock(root)
  await new Promise<never>(() => {})
}

// Signal the loading window to CrazyGames (must be after init). Our assets are small and mostly
// lazy, so this brackets the synchronous mount; the first gameplayStart (the first deal) closes the
// initial-download size-budget window.
loadingStart()

// Honor the platform mute setting (CrazyGames settings.muteAudio) across all three audio services,
// and react to live changes — it overrides any in-game level.
const applyMute = (muted: boolean): void => {
  music.setMuted(muted)
  sfx.setMuted(muted)
  voice.setMuted(muted)
}
applyMute(getMuteSetting())
onMuteChange(applyMute)
// Let the ad wrappers mute all audio while an ad plays and restore it afterward (to the platform
// mute, which they read themselves) — required by CrazyGames for every ad.
setAudioMuteControl(applyMute)

// Battery saver renders the canvas at a lower dpr — must be set BEFORE mounting, so the layers size
// and the offscreen sprite caches bake at the reduced scale (no live rebuild). Read after SDK init
// so the stored preference (SDK.data) is available; a mid-session toggle applies on next launch.
// DEV-only ?dpr=<n> overrides the saver dpr cap so the crispness/heat trade can be A/B'd on-device
// (e.g. ?battery=on&dpr=1.0); compiled out of production, where the SAVER_MAX_DPR constant rules.
const saverDprOverride = import.meta.env.DEV
  ? Number(new URLSearchParams(window.location.search).get('dpr')) || undefined
  : undefined
setSaverDpr(isBatterySaver(), saverDprOverride)

// Canvas-first UI (hybrid): the scene + cards render on the canvas layer, the
// action buttons and HUD live in the stage overlay.
mountGameView(root)
loadingStop()

// The game view is mounted — fade out and remove the instant boot splash (index.html) so it
// hands off to the tap-to-start screen. Waiting one frame lets the first canvas frame paint
// before the splash's opacity transition starts, so there's no dark flash in the gap.
const bootSplash = document.getElementById('boot-splash')
if (bootSplash) {
  requestAnimationFrame(() => {
    bootSplash.classList.add('is-hidden')
    const removeSplash = (): void => bootSplash.remove()
    bootSplash.addEventListener('transitionend', removeSplash, { once: true })
    window.setTimeout(removeSplash, 600) // fallback if transitionend never fires
  })
}

// Dev-only audio audition hooks. `window.sfx` fires a sound straight from the console so tweaks
// can be heard without playing to their trigger (A/B `sfx.playHandClap()` vs the raw
// `sfx.play('hand-clap')`, edit the HAND_CLAP_* constants in audio/sfx.ts, HMR reloads them live).
// `window.music` dials the mix live: `music.setVolume(0.5)` for the overall level, `music.setBaseVolume('maestro', 0.4)`
// for one track's balance, `music.advanceTrack()` to jump to the next track and A/B them. Land on
// values by ear, then bake MUSIC_LEVEL (above) and the TRACKS baseVolumes (audio/music.ts) in.
// Compiled out of the production build.
if (import.meta.env.DEV) {
  ;(window as unknown as { sfx: typeof sfx }).sfx = sfx
  ;(window as unknown as { music: typeof music }).music = music
}
