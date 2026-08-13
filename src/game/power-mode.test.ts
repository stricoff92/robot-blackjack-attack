import { afterEach, describe, expect, it, vi } from 'vitest'

// Stand-in for the platform key/value store (hoisted so the vi.mock factory can close over it).
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }))
vi.mock('../platform/crazygames', () => ({
  loadValue: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  saveValue: (k: string, v: string) => {
    store.set(k, v)
  },
}))

// power-mode caches the loaded value in a module var, so each scenario re-imports it fresh.
async function freshModule() {
  vi.resetModules()
  return import('./power-mode')
}

// Node test env has no window/navigator; stub the bits defaultBatterySaver()/forcedOverride() read.
function stubEnv(opts: { coarse?: boolean; reduce?: boolean; touch?: number; search?: string }): void {
  vi.stubGlobal('window', {
    matchMedia: (q: string) => ({
      matches: (q.includes('coarse') && !!opts.coarse) || (q.includes('reduced-motion') && !!opts.reduce),
    }),
    location: { search: opts.search ?? '' },
  })
  vi.stubGlobal('navigator', { maxTouchPoints: opts.touch ?? 0 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.clear()
})

describe('power-mode default (per-device, unset preference)', () => {
  it('defaults ON for a coarse-pointer (touch) device', async () => {
    stubEnv({ coarse: true })
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(true)
    expect(m.isBatterySaver()).toBe(true) // nothing stored → follows the default
  })

  it('defaults ON when the OS prefers reduced motion', async () => {
    stubEnv({ reduce: true })
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(true)
  })

  it('defaults ON when maxTouchPoints > 0 even without a coarse match', async () => {
    stubEnv({ touch: 5 })
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(true)
  })

  it('defaults OFF on a fine-pointer desktop', async () => {
    stubEnv({})
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(false)
    expect(m.isBatterySaver()).toBe(false)
  })
})

describe('power-mode explicit choice', () => {
  it('an explicit toggle persists and overrides the per-device default', async () => {
    stubEnv({ coarse: true }) // default would be ON
    const m = await freshModule()
    m.setBatterySaver(false)
    expect(m.isBatterySaver()).toBe(false) // explicit OFF beats the ON default
    expect(store.get('rba.batterySaver')).toBe('0')
    m.setBatterySaver(true)
    expect(m.isBatterySaver()).toBe(true)
    expect(store.get('rba.batterySaver')).toBe('1')
  })

  it('a stored choice survives a fresh load (read back from storage, not just cache)', async () => {
    stubEnv({}) // default OFF
    store.set('rba.batterySaver', '1')
    const m = await freshModule()
    expect(m.isBatterySaver()).toBe(true)
  })
})
