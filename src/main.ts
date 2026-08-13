import { sfx } from './audio/sfx'
import { music } from './audio/music'
import { voice } from './audio/voice'
import { getMuteSetting, initCrazyGames, loadingStart, loadingStop, logStorageHealth, onMuteChange } from './platform/crazygames'
import { bootAllowed, renderLock } from './platform/sitelock'
import { isBatterySaver } from './game/power-mode'
import { setSaverDpr } from './render/canvas'
import { mountGameView } from './ui/game-view'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('missing #app mount element')
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

// Dev-only audio audition hook: `window.sfx` lets you fire a sound straight from the console so
// tweaks can be heard without playing to their trigger. Handy for the robotic Banker clap — A/B
// `sfx.playHandClap()` against the raw `sfx.play('hand-clap')`, edit the HAND_CLAP_* constants in
// audio/sfx.ts, and HMR reloads them live. Compiled out of the production build.
if (import.meta.env.DEV) {
  ;(window as unknown as { sfx: typeof sfx }).sfx = sfx
}
