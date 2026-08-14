import { afterEach, describe, expect, it, vi } from 'vitest'

// Device-local storage stand-in: power-mode persists straight to window.localStorage (NOT the
// SDK.data facade — a battery-saver toggle is per-device and must never sync across an account's
// devices), so the tests back a fake localStorage with this map.
const store = new Map<string, string>()

// power-mode caches the loaded value in a module var, so each scenario re-imports it fresh.
async function freshModule() {
  vi.resetModules()
  return import('./power-mode')
}

// Node test env has no window/navigator; stub the bits defaultBatterySaver()/forcedOverride() read,
// plus a localStorage backed by `store`. `mobile` models a phone/tablet: the '(hover: none) and
// (pointer: coarse)' query matches only when the device is coarse-pointer AND can't hover.
// `noMatchMedia` drops matchMedia entirely to exercise the maxTouchPoints fallback path.
function stubEnv(opts: {
  mobile?: boolean
  reduce?: boolean
  touch?: number
  search?: string
  noMatchMedia?: boolean
}): void {
  vi.stubGlobal('window', {
    matchMedia: opts.noMatchMedia
      ? undefined
      : (q: string) => ({
          matches:
            (q.includes('hover: none') && q.includes('coarse') && !!opts.mobile) ||
            (q.includes('reduced-motion') && !!opts.reduce),
        }),
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
  vi.stubGlobal('navigator', { maxTouchPoints: opts.touch ?? 0 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.clear()
})

describe('power-mode default (per-device, unset preference)', () => {
  it('defaults ON for a mobile-class touch device (phone/tablet)', async () => {
    stubEnv({ mobile: true })
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(true)
    expect(m.isBatterySaver()).toBe(true) // nothing stored → follows the default
  })

  it('defaults ON when the OS prefers reduced motion', async () => {
    stubEnv({ reduce: true })
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(true)
  })

  it('defaults OFF on a touchscreen desktop (touch points but can hover — not mobile)', async () => {
    stubEnv({ touch: 5 }) // mobile: false → '(hover: none) and (pointer: coarse)' does not match
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(false)
    expect(m.isBatterySaver()).toBe(false)
  })

  it('defaults OFF on a fine-pointer desktop', async () => {
    stubEnv({})
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(false)
    expect(m.isBatterySaver()).toBe(false)
  })

  it('falls back to maxTouchPoints only when matchMedia is unavailable', async () => {
    stubEnv({ noMatchMedia: true, touch: 5 })
    const m = await freshModule()
    expect(m.defaultBatterySaver()).toBe(true)
  })
})

describe('power-mode explicit choice', () => {
  it('an explicit toggle persists and overrides the per-device default', async () => {
    stubEnv({ mobile: true }) // default would be ON
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
