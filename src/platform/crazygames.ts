// CrazyGames SDK v3 wrapper — the single place that touches window.CrazyGames.
//
// Scope today: client-side leaderboard score submission (encrypted) + durable key/value storage
// for the player's personal best. The SDK is loaded from CrazyGames' CDN via a <script> in
// index.html and exposed as window.CrazyGames.SDK. It reports `environment` 'local' on
// localhost, 'crazygames' in production (inside their iframe), and 'disabled' on any other host;
// it is entirely ABSENT in unit tests and can be absent during a plain `vite preview`. Every
// entry point here degrades gracefully when the SDK is missing or off-platform, so the game runs
// identically anywhere: the personal best falls back to localStorage, and submits become
// dev-only console logs.
//
// IMPORTANT: CrazyGames leaderboards are SUBMIT-ONLY. The SDK/API expose no way to read back the
// global top score or a player's rank — CrazyGames renders the leaderboard in its own widget.
// So the in-game "score to beat" is the LOCAL personal best (tracked via loadValue/saveValue),
// not a CrazyGames read. Docs: https://docs.crazygames.com/sdk/leaderboards-mvp/ (verified Aug 2026).

type CrazyEnvironment = 'local' | 'crazygames' | 'disabled'

interface CrazyDataStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface CrazySystemInfo {
  // Where the game runs: 'apple_store' / 'google_play_store' inside the native CrazyGames app (where
  // display banners can't render), else a web value. Optional — absent on older SDKs.
  readonly applicationType?: string
}

interface CrazyUserModule {
  // Client-side leaderboard submit. The score is AES-GCM encrypted with the game's Encryption
  // Key before it leaves the client; the call resolves regardless (the backend validates
  // silently, keeping anti-cheat opaque), so a returned success is not proof of a recorded score.
  submitScore(payload: { encryptedScore: string }): Promise<unknown>
  readonly systemInfo?: CrazySystemInfo
}

interface CrazyAdCallbacks {
  adStarted(): void
  adFinished(): void
  adError(error: unknown): void
}

interface CrazyAdModule {
  // Request a video ad. No app-id/key needed (the game is identified by domain). Serving is enabled
  // server-side at Full Launch; before that requests hit the no-fill (adError) path.
  requestAd(type: 'midgame' | 'rewarded', callbacks: CrazyAdCallbacks): void
}

interface CrazyBannerModule {
  // Request a display banner into an existing DOM container of the given pixel size. Rejects with
  // 'unfilled' (among others) when no ad is available.
  requestBanner(options: { id: string; width: number; height: number }): Promise<void>
  clearBanner(id: string): void
  clearAllBanners(): void
}

interface CrazyGameSettings {
  readonly muteAudio: boolean
  readonly disableChat: boolean
}

interface CrazyGameModule {
  gameplayStart(): void
  gameplayStop(): void
  loadingStart(): void
  loadingStop(): void
  reportGameCompletedPercentage(percentage: number): void
  happytime(): void
  readonly settings: CrazyGameSettings
  addSettingsChangeListener(listener: () => void): void
  removeSettingsChangeListener(listener: () => void): void
}

interface CrazySDK {
  init(): Promise<void>
  readonly environment: CrazyEnvironment
  data: CrazyDataStore
  user: CrazyUserModule
  game: CrazyGameModule
  ad: CrazyAdModule
  banner: CrazyBannerModule
}

declare global {
  interface Window {
    CrazyGames?: { SDK: CrazySDK }
  }
}

// The game's Encryption Key (a 32-byte base64 string) from the Developer Portal → Leaderboard
// tab. Injected at build time via a VITE_CG_ENCRYPTION_KEY env var so it stays out of source.
// It ships inside the client bundle (expected — the backend still validates), so this is
// convenience, not a real secret. Empty until configured: submits are skipped (logged in dev).
const ENCRYPTION_KEY = (import.meta.env.VITE_CG_ENCRYPTION_KEY ?? '').trim()

let sdkReady = false

function sdk(): CrazySDK | undefined {
  return typeof window !== 'undefined' ? window.CrazyGames?.SDK : undefined
}

function devLog(message: string): void {
  if (import.meta.env.DEV) {
    console.log(message)
  }
}

// 'absent' when the SDK script never loaded (unit tests, some previews); otherwise the SDK's own
// 'local' | 'crazygames' | 'disabled'.
export function getEnvironment(): CrazyEnvironment | 'absent' {
  return sdk()?.environment ?? 'absent'
}

// Initialise the SDK once at startup. Fire-and-forget from main.ts: our score reads/writes happen
// deep into a session (the coda / game-over), long after this resolves, and fall back to
// localStorage until it does, so nothing blocks on it.
export async function initCrazyGames(): Promise<void> {
  const s = sdk()
  if (!s) {
    devLog('[crazygames] SDK not present — running off-platform (localStorage + dev logs)')
    return
  }
  try {
    await s.init()
    sdkReady = true
    devLog(`[crazygames] SDK ready (environment=${s.environment})`)
  } catch (e) {
    devLog(`[crazygames] SDK init failed: ${String(e)}`)
  }
}

// --- Gameplay + loading lifecycle (SDK.game). Required for a Full Launch. gameplayStart/Stop
// bracket ACTIVE play — they gate ad eligibility, but an ad only ever fires when we explicitly
// request one, never as a side effect of these, so a gameplayStop between hands can't pop an ad
// mid-hand. loadingStart/Stop wrap the initial load. All no-op off-platform / when disabled. ---

export function gameplayStart(): void {
  callGame((game) => game.gameplayStart(), 'gameplayStart')
}

export function gameplayStop(): void {
  callGame((game) => game.gameplayStop(), 'gameplayStop')
}

export function loadingStart(): void {
  callGame((game) => game.loadingStart(), 'loadingStart')
}

export function loadingStop(): void {
  callGame((game) => game.loadingStop(), 'loadingStop')
}

// Report overall progression (0–100) so CrazyGames can surface completion milestones. We emit it as
// dealers fall — each of the 6 kills is a milestone, arriving at the Banker (the 6th) is 100%.
// Clamped/rounded defensively.
export function reportGameCompletedPercentage(percentage: number): void {
  const pct = Math.max(0, Math.min(100, Math.round(percentage)))
  callGame((game) => game.reportGameCompletedPercentage(pct), 'reportGameCompletedPercentage')
}

// A "positive moment" hint — we fire it when the player beats an existing personal best. Lets
// CrazyGames time an interstitial at a genuinely good moment. No-ops off-platform / when disabled,
// like the other SDK.game calls.
export function happytime(): void {
  callGame((game) => game.happytime(), 'happytime')
}

function callGame(fn: (game: CrazyGameModule) => void, label: string): void {
  const s = sdk()
  if (!s || getEnvironment() === 'disabled') {
    return
  }
  try {
    fn(s.game)
  } catch (e) {
    devLog(`[crazygames] ${label} failed: ${String(e)}`)
  }
}

// --- Platform audio mute (SDK.game.settings.muteAudio). Required: the platform's mute must
// override in-game audio (it takes priority over any in-game toggle). ---

export function getMuteSetting(): boolean {
  const s = sdk()
  if (!s || getEnvironment() === 'disabled') {
    return false
  }
  try {
    return s.game.settings.muteAudio === true
  } catch {
    return false
  }
}

// Register a listener for platform settings changes; it's invoked with the current mute state.
export function onMuteChange(listener: (muted: boolean) => void): void {
  const s = sdk()
  if (!s || getEnvironment() === 'disabled') {
    return
  }
  try {
    s.game.addSettingsChangeListener(() => listener(getMuteSetting()))
  } catch (e) {
    devLog(`[crazygames] addSettingsChangeListener failed: ${String(e)}`)
  }
}

// --- Video ads (midgame + rewarded) + display banners. Ads need no app-id/key — CrazyGames
// identifies the game by domain and turns serving on server-side once the game reaches Full Launch;
// until then (Basic Launch / review) requests just hit the no-fill path, so the SAME code monetizes
// automatically at launch with no change. Every entry point degrades off-platform so dev/tests run
// identically: midgame continues, rewarded grants in dev (so the flow is testable) but never on a
// foreign prod host, and banners paint a dev placeholder. ---

// Fallback if the SDK fires neither adFinished nor adError (a broken ad unit must never leave the
// game paused forever). Longer than any served ad (~30s) so it can't cut a real one short.
const AD_FALLBACK_MS = 40000

// How long the DEV placeholder ad stays up before auto-continuing (a tap skips it sooner).
const DEV_AD_PLACEHOLDER_MS = 2500

// Registered by main.ts: mutes/unmutes all three audio services at once. Ads mute on start and
// restore on end — to the PLATFORM mute (getMuteSetting), NOT force-unmute, so an ad never clobbers
// the player's own CrazyGames mute.
let audioMuteControl: ((muted: boolean) => void) | null = null

export function setAudioMuteControl(fn: (muted: boolean) => void): void {
  audioMuteControl = fn
}

// Request a midgame (interstitial) ad, then run onDone once it's over — whether it played, errored,
// or no-filled (the game always continues after a midgame). Exactly-once via runAd_.
export function requestMidgameAd(onDone: () => void): void {
  runAd_('midgame', onDone, onDone)
}

// Request a rewarded ad. onReward runs ONLY on a completed ad (adFinished); onFail on any error/no-
// fill — never reward there. In dev (no real ad serves) onReward fires so the button is testable;
// on a genuine foreign/disabled prod host onFail fires (no free reward).
export function requestRewardedAd(callbacks: { onReward: () => void; onFail: () => void }): void {
  runAd_('rewarded', callbacks.onReward, callbacks.onFail)
}

function runAd_(type: 'midgame' | 'rewarded', onFinish: () => void, onError: () => void): void {
  const s = sdk()
  const env = getEnvironment()
  if (!s || env === 'disabled' || env === 'absent') {
    // No SDK / off-platform (this includes a 'disabled' host — e.g. the dev server opened by LAN IP on
    // a phone — where the SDK serves NOTHING, so the real ad UI never appears). In DEV paint a visible
    // placeholder so the full pause→ad→resume flow is testable on ANY device, THEN complete (rewarded
    // grants on completion, matching the prior dev behaviour). In PROD there's no placeholder: a
    // rewarded ad on a genuine foreign host must NOT pay out, and a midgame just continues.
    if (import.meta.env.DEV) {
      showDevAdPlaceholder_(type, onFinish)
    } else if (type === 'rewarded') {
      onError()
    } else {
      onFinish()
    }
    return
  }
  let settled = false
  const settle = (fn: () => void): void => {
    if (settled) {
      return
    }
    settled = true
    window.clearTimeout(timer)
    audioMuteControl?.(getMuteSetting()) // restore to the platform mute, not a force-unmute
    fn()
  }
  const timer = window.setTimeout(() => settle(onError), AD_FALLBACK_MS)
  try {
    s.ad.requestAd(type, {
      adStarted: () => audioMuteControl?.(true),
      adFinished: () => settle(onFinish),
      adError: () => settle(onError),
    })
  } catch (e) {
    devLog(`[crazygames] requestAd(${type}) threw: ${String(e)}`)
    settle(onError)
  }
}

// DEV-only stand-in for the full-screen ad when the SDK serves nothing (an off-platform / 'disabled'
// host, e.g. the dev server reached by LAN IP on a phone — the real ad UI never appears there). Mutes
// game audio like a real ad, auto-continues after a beat (tap skips), then runs `done`. With no
// document (unit tests) `done` fires SYNCHRONOUSLY, so the ad wrappers keep their existing timing.
// Compiled out of production (callers only reach this under import.meta.env.DEV).
function showDevAdPlaceholder_(type: 'midgame' | 'rewarded', done: () => void): void {
  if (typeof document === 'undefined' || !document.body) {
    done()
    return
  }
  audioMuteControl?.(true) // an ad silences game audio while it plays
  const overlay = document.createElement('div')
  overlay.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
      'flex-direction:column;gap:10px;background:rgba(8,8,10,0.94);color:#fff;text-align:center;padding:24px;' +
      'white-space:pre-line;font:600 20px/1.4 ui-sans-serif,system-ui,sans-serif;-webkit-user-select:none;user-select:none;',
  )
  overlay.textContent =
    `${type === 'rewarded' ? 'Rewarded' : 'Interstitial'} ad\n\nDEV PLACEHOLDER — no real ad off-platform\ntap to continue`
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    window.clearTimeout(timer)
    overlay.remove()
    audioMuteControl?.(getMuteSetting()) // restore to the platform mute, not a force-unmute
    done()
  }
  overlay.addEventListener('pointerdown', close)
  const timer = window.setTimeout(close, DEV_AD_PLACEHOLDER_MS)
  document.body.appendChild(overlay)
}

// Whether to offer the rewarded-ad button: on a genuine CrazyGames environment (real ads) or in dev
// (testable + grants locally). Never on a foreign/disabled prod host, where it'd be a dead button.
export function rewardedAdsSupported(): boolean {
  if (import.meta.env.DEV) {
    return true
  }
  const env = getEnvironment()
  return env === 'crazygames' || env === 'local'
}

// The five CrazyGames display-banner sizes, richest first (300×250 fills + earns best, then the wide
// leaderboard, then the mobile sizes; 468×60 is dropped — weak demand). `pickBannerSize` returns the
// best that fits the given CSS box, or null if even the smallest won't (skip the banner then).
export interface BannerSize {
  width: number
  height: number
}

// Every threshold is at LEAST the banner's own footprint plus the container's 12px top / 14px left
// inset (game-view.css .hud-score-banner): CrazyGames rejects a container that isn't fully inside the
// game window ('notVisible'), so a size that physically can't fit must never be picked — it would
// just burn a request and the 30s cooldown. The roomier numbers above that floor are editorial (air
// around the score art).
const BANNER_SIZES: readonly { size: BannerSize; minW: number; minH: number }[] = [
  { size: { width: 300, height: 250 }, minW: 640, minH: 700 },
  { size: { width: 728, height: 90 }, minW: 1000, minH: 102 },
  { size: { width: 320, height: 100 }, minW: 380, minH: 480 },
  { size: { width: 320, height: 50 }, minW: 360, minH: 62 },
]

export function pickBannerSize(cssWidth: number, cssHeight: number): BannerSize | null {
  for (const { size, minW, minH } of BANNER_SIZES) {
    if (cssWidth >= minW && cssHeight >= minH) {
      return size
    }
  }
  return null
}

// Whether the game is running inside the native CrazyGames app (iOS/Android), where display banners
// can't render — callers skip the banner there. (Video ads still work in the app.)
//
// The SDK's `user` module getter THROWS when the SDK is disabled (any non-crazygames, non-local host
// — e.g. the dev server reached over a LAN IP from a phone, which the SDK reports as `disabled`).
// Optional chaining doesn't protect against a throwing getter, so this must catch: an uncaught throw
// here reaches showScoreBanner_ on the game-over frame and used to kill the render loop (freezing the
// Banker walk-off + scoreboard, iOS-only). Off a real host we're never in the native app anyway.
export function isCrazyGamesApp(): boolean {
  try {
    const type = sdk()?.user?.systemInfo?.applicationType
    return type === 'apple_store' || type === 'google_play_store'
  } catch {
    return false
  }
}

// Container ids we've asked the SDK for a banner in — added on request, dropped on a clear or a
// failed request. `clearBanner` on a container the SDK never filled is an error on its side (console
// noise that buries the real ad logs), so clearScoreBanner consults this instead of clearing blind.
// An IN-FLIGHT request counts as live: a clear that races the promise must still tear the banner
// down, or it would paint itself into an empty container after the score screen is gone.
const liveBanners = new Set<string>()

// Request a display banner into an existing DOM container (already sized to width×height). On a real
// CrazyGames host this asks the SDK and calls onUnfilled on any no-fill/error so the caller hides the
// empty box. In dev (off the real host) it paints a plain "AD" placeholder so banner placement/sizing
// is visible while developing — no real ad, and never in production.
export function requestScoreBanner(id: string, width: number, height: number, onUnfilled: () => void): void {
  const s = sdk()
  if (s && getEnvironment() === 'crazygames') {
    liveBanners.add(id)
    try {
      s.banner.requestBanner({ id, width, height }).catch((e) => {
        liveBanners.delete(id) // nothing was filled — don't clear a container the SDK never created
        devLog(`[crazygames] requestBanner failed: ${String(e)}`)
        onUnfilled()
      })
    } catch (e) {
      liveBanners.delete(id)
      devLog(`[crazygames] requestBanner threw: ${String(e)}`)
      onUnfilled()
    }
    return
  }
  if (import.meta.env.DEV) {
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null
    if (el) {
      el.classList.add('is-dev-placeholder')
      el.textContent = `AD ${width}×${height}`
    }
    return
  }
  onUnfilled()
}

// Clear a banner container: drop the SDK banner (real host only) and remove any dev placeholder.
export function clearScoreBanner(id: string): void {
  const s = sdk()
  if (s && getEnvironment() === 'crazygames' && liveBanners.has(id)) {
    liveBanners.delete(id)
    try {
      s.banner.clearBanner(id)
    } catch (e) {
      devLog(`[crazygames] clearBanner failed: ${String(e)}`)
    }
  }
  if (import.meta.env.DEV) {
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null
    if (el) {
      el.classList.remove('is-dev-placeholder')
      el.textContent = ''
    }
  }
}

// --- Durable key/value storage: SDK.data on-platform (iframe-partition-safe), else localStorage. ---

const memoryStore = new Map<string, string>()

// One-time guard so the "localStorage blew up" warning doesn't spam (saveValue runs every action).
let storageWarned = false

function warnStorageLost(op: string, e: unknown): void {
  if (storageWarned) {
    return
  }
  storageWarned = true
  devLog(
    `[crazygames] localStorage ${op} threw (${String(e)}) — falling back to an in-memory store, so the ` +
      `in-progress run will NOT survive a reload. On iOS this is usually a Private Browsing tab, ` +
      `Settings→Safari→Block All Cookies being ON, or opening the page in an in-app/webview browser ` +
      `instead of Safari itself.`,
  )
}

// Dev diagnostic: confirm the durable store actually persists, logged once at startup so a device
// that silently drops saves (see warnStorageLost) is obvious in Web Inspector rather than presenting
// as a mysterious missing Continue button. No-op in the production build.
export function logStorageHealth(): void {
  if (!import.meta.env.DEV) {
    return
  }
  if (platformStore()) {
    devLog('[crazygames] durable storage = SDK.data (on-platform)')
    return
  }
  const probeKey = 'rba.__probe'
  try {
    window.localStorage.setItem(probeKey, '1')
    const ok = window.localStorage.getItem(probeKey) === '1'
    window.localStorage.removeItem(probeKey)
    devLog(
      ok
        ? '[crazygames] durable storage = localStorage (OK — runs will persist across reloads)'
        : '[crazygames] localStorage readback FAILED — saves will NOT persist (in-memory fallback)',
    )
  } catch (e) {
    warnStorageLost('probe', e)
  }
}

function platformStore(): CrazyDataStore | null {
  const s = sdk()
  return sdkReady && s?.environment === 'crazygames' ? s.data : null
}

export function loadValue(key: string): string | null {
  const store = platformStore()
  if (store) {
    try {
      return store.getItem(key)
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    return window.localStorage.getItem(key)
  } catch (e) {
    warnStorageLost('getItem', e)
    return memoryStore.get(key) ?? null
  }
}

export function saveValue(key: string, value: string): void {
  const store = platformStore()
  if (store) {
    try {
      store.setItem(key, value)
      return
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    window.localStorage.setItem(key, value)
  } catch (e) {
    warnStorageLost('setItem', e)
    memoryStore.set(key, value)
  }
}

export function removeValue(key: string): void {
  const store = platformStore()
  if (store) {
    try {
      store.removeItem(key)
      return
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    window.localStorage.removeItem(key)
  } catch (e) {
    warnStorageLost('removeItem', e)
    memoryStore.delete(key)
  }
}

// --- Leaderboard submit (encrypted, fire-and-forget). ---

// Submit a final score to the CrazyGames leaderboard. Fire-and-forget: encryption is async but
// the caller (run-end) is synchronous and doesn't care about the result (it's opaque anyway).
export function submitToCrazyGames(score: number): void {
  void submitAsync(score)
}

async function submitAsync(score: number): Promise<void> {
  const s = sdk()
  const env = getEnvironment()
  if (!s || env === 'disabled' || env === 'absent') {
    devLog(`[crazygames] leaderboard submit skipped (environment=${env}): score=${score}`)
    return
  }
  if (!ENCRYPTION_KEY) {
    devLog(`[crazygames] no VITE_CG_ENCRYPTION_KEY configured — would submit score=${score}`)
    return
  }
  try {
    const encryptedScore = await encryptScore(score, base64ToBytes(ENCRYPTION_KEY))
    await s.user.submitScore({ encryptedScore })
    devLog(`[crazygames] submitted score=${score}`)
  } catch (e) {
    devLog(`[crazygames] leaderboard submit failed: ${String(e)}`)
  }
}

// AES-GCM per the CrazyGames client leaderboard spec: a random 12-byte IV, encrypt the score
// string, then base64(IV ++ ciphertext).
async function encryptScore(score: number, keyBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  // Copy into a fresh ArrayBuffer-backed array: TextEncoder.encode returns Uint8Array<ArrayBufferLike>,
  // which the DOM crypto types (TS 5.7+) reject as a BufferSource.
  const plaintext = new Uint8Array(new TextEncoder().encode(String(score)))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  const combined = new Uint8Array(iv.length + ciphertext.length)
  combined.set(iv, 0)
  combined.set(ciphertext, iv.length)
  return bytesToBase64(combined)
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
