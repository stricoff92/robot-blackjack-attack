import { afterEach, describe, expect, it, vi } from 'vitest'

// Device-local storage stand-in: music-mute persists straight to window.localStorage (NOT the
// SDK.data facade — a music-mute toggle is per-device and must never sync across an account's
// devices), so the tests back a fake localStorage with this map.
const store = new Map<string, string>()

// music-mute caches the loaded value in a module var, so each scenario re-imports it fresh.
async function freshModule() {
  vi.resetModules()
  return import('./music-mute')
}

// Node test env has no window; stub a localStorage backed by `store` plus a location for the
// ?music=on|off override path.
function stubEnv(opts: { search?: string } = {}): void {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
      removeItem: (k: string) => {
        store.delete(k)
      },
    },
    location: { search: opts.search ?? '' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.clear()
})

describe('music-mute default (unset preference)', () => {
  it('defaults to NOT muted (music plays) with nothing stored', async () => {
    stubEnv()
    const m = await freshModule()
    expect(m.isMusicMuted()).toBe(false)
  })
})

describe('music-mute explicit choice', () => {
  it('an explicit mute persists and reads back', async () => {
    stubEnv()
    const m = await freshModule()
    m.setMusicMuted(true)
    expect(m.isMusicMuted()).toBe(true)
    expect(store.get('rba.musicMuted')).toBe('1')
    m.setMusicMuted(false)
    expect(m.isMusicMuted()).toBe(false)
    expect(store.get('rba.musicMuted')).toBe('0')
  })

  it('a stored choice survives a fresh load (read back from storage, not just cache)', async () => {
    stubEnv()
    store.set('rba.musicMuted', '1')
    const m = await freshModule()
    expect(m.isMusicMuted()).toBe(true)
  })
})
