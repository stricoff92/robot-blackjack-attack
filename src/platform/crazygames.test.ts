import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isCrazyGamesApp,
  pickBannerSize,
  requestMidgameAd,
  requestRewardedAd,
  setAudioMuteControl,
} from './crazygames'

// A minimal fake window carrying a CrazyGames SDK whose ad.requestAd is driven by `requestAd`. The
// wrappers use window.setTimeout/clearTimeout for their fallback timer, so those are provided too
// (the fake callbacks fire synchronously, so the fallback is always cleared before it can run).
function installSdk(requestAd: (type: string, cb: { adStarted(): void; adFinished(): void; adError(e: unknown): void }) => void, muteAudio = false): void {
  const sdk = {
    init: () => Promise.resolve(),
    environment: 'crazygames',
    data: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    user: { submitScore: () => Promise.resolve() },
    game: { settings: { muteAudio } },
    ad: { requestAd },
    banner: { requestBanner: () => Promise.resolve(), clearBanner: () => {}, clearAllBanners: () => {} },
  }
  vi.stubGlobal('window', {
    CrazyGames: { SDK: sdk },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  setAudioMuteControl(() => {}) // reset the module-level mute hook between tests
})

describe('pickBannerSize', () => {
  it('picks the richest banner that fits, largest screens first', () => {
    expect(pickBannerSize(1200, 800)).toEqual({ width: 300, height: 250 })
  })

  it('falls back to the wide leaderboard when the screen is wide but short', () => {
    expect(pickBannerSize(1200, 500)).toEqual({ width: 728, height: 90 })
  })

  it('uses the large mobile banner on a tall phone', () => {
    expect(pickBannerSize(390, 800)).toEqual({ width: 320, height: 100 })
  })

  it('drops to the small mobile banner on a short phone', () => {
    expect(pickBannerSize(390, 400)).toEqual({ width: 320, height: 50 })
  })

  it('returns null when even the smallest banner will not fit', () => {
    expect(pickBannerSize(300, 300)).toBeNull()
  })
})

describe('ad wrappers off-platform (no SDK)', () => {
  it('requestMidgameAd continues the game exactly once', () => {
    const onDone = vi.fn()
    requestMidgameAd(onDone)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('requestRewardedAd resolves to exactly one of onReward/onFail', () => {
    const onReward = vi.fn()
    const onFail = vi.fn()
    requestRewardedAd({ onReward, onFail })
    expect(onReward.mock.calls.length + onFail.mock.calls.length).toBe(1)
  })

  it('isCrazyGamesApp is false with no SDK', () => {
    expect(isCrazyGamesApp()).toBe(false)
  })
})

describe('ad wrappers on-platform (fake SDK)', () => {
  it('midgame mutes on start, restores to the platform mute on finish, and continues once', () => {
    const mutes: boolean[] = []
    setAudioMuteControl((m) => mutes.push(m))
    installSdk((_type, cb) => {
      cb.adStarted()
      cb.adFinished()
    })
    const onDone = vi.fn()

    requestMidgameAd(onDone)

    expect(mutes).toEqual([true, false]) // muted for the ad, then restored to the platform mute (false)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('rewarded grants the reward on a completed ad', () => {
    installSdk((_type, cb) => {
      cb.adStarted()
      cb.adFinished()
    })
    const onReward = vi.fn()
    const onFail = vi.fn()

    requestRewardedAd({ onReward, onFail })

    expect(onReward).toHaveBeenCalledTimes(1)
    expect(onFail).not.toHaveBeenCalled()
  })

  it('rewarded does NOT grant on an ad error / no-fill', () => {
    installSdk((_type, cb) => cb.adError('unfilled'))
    const onReward = vi.fn()
    const onFail = vi.fn()

    requestRewardedAd({ onReward, onFail })

    expect(onReward).not.toHaveBeenCalled()
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('requests the correct ad type for each wrapper', () => {
    const requestAd = vi.fn((_type: string, cb: { adFinished(): void }) => cb.adFinished())
    installSdk(requestAd as never)

    requestMidgameAd(() => {})
    requestRewardedAd({ onReward: () => {}, onFail: () => {} })

    expect(requestAd.mock.calls[0][0]).toBe('midgame')
    expect(requestAd.mock.calls[1][0]).toBe('rewarded')
  })

  it('detects the native CrazyGames app via systemInfo.applicationType', () => {
    vi.stubGlobal('window', { CrazyGames: { SDK: { user: { systemInfo: { applicationType: 'apple_store' } } } } })
    expect(isCrazyGamesApp()).toBe(true)
  })

  // Regression: on a DISABLED host (e.g. the dev server reached over a LAN IP from a phone) the SDK's
  // `user` module getter THROWS. Optional chaining doesn't stop a throwing getter, so isCrazyGamesApp
  // must swallow it and report false — an uncaught throw here reached the game-over frame and froze the
  // render loop (Banker walk-off + scoreboard never played, iOS-only).
  it('returns false (not throw) when the SDK user getter throws (disabled host)', () => {
    const sdk = { environment: 'disabled' }
    Object.defineProperty(sdk, 'user', {
      get() {
        throw new Error('CrazyGames SDK is disabled')
      },
    })
    vi.stubGlobal('window', { CrazyGames: { SDK: sdk } })
    expect(() => isCrazyGamesApp()).not.toThrow()
    expect(isCrazyGamesApp()).toBe(false)
  })
})
