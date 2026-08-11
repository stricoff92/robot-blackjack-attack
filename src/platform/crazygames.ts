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

interface CrazyUserModule {
  // Client-side leaderboard submit. The score is AES-GCM encrypted with the game's Encryption
  // Key before it leaves the client; the call resolves regardless (the backend validates
  // silently, keeping anti-cheat opaque), so a returned success is not proof of a recorded score.
  submitScore(payload: { encryptedScore: string }): Promise<unknown>
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
