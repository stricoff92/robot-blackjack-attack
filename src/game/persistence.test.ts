import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RULES_VERSION, startRun } from './run'

// Back the platform storage with an in-memory map so we exercise the real save/load/version/
// validation logic without touching localStorage or the CrazyGames SDK. vi.hoisted keeps `store`
// available inside the (hoisted) mock factory.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }))
vi.mock('../platform/crazygames', () => ({
  loadValue: vi.fn((key: string) => store.get(key) ?? null),
  saveValue: vi.fn((key: string, value: string) => {
    store.set(key, value)
  }),
  removeValue: vi.fn((key: string) => {
    store.delete(key)
  }),
}))

import { clearRun, loadRun, saveRun } from './persistence'

const RUN_KEY = 'rba.run'

describe('persistence', () => {
  beforeEach(() => {
    store.clear()
  })

  it('round-trips a saved run', () => {
    const run = { ...startRun(7), chips: 500, score: 1234, shiftIndex: 2, kills: [1] }
    saveRun(run)
    expect(loadRun()).toEqual(run)
  })

  it('returns null when nothing is saved', () => {
    expect(loadRun()).toBeNull()
  })

  it('clearRun removes the save', () => {
    saveRun(startRun(1))
    clearRun()
    expect(loadRun()).toBeNull()
  })

  it('discards a save from a different RULES_VERSION', () => {
    store.set(RUN_KEY, JSON.stringify({ version: RULES_VERSION - 1, run: startRun(1) }))
    expect(loadRun()).toBeNull()
  })

  it('never resumes a finished or coda run', () => {
    saveRun({ ...startRun(1), over: true })
    expect(loadRun()).toBeNull()
    store.clear()
    saveRun({ ...startRun(1), coda: true })
    expect(loadRun()).toBeNull()
  })

  it('rejects malformed or corrupt saves', () => {
    store.set(RUN_KEY, 'not json')
    expect(loadRun()).toBeNull()
    store.set(RUN_KEY, JSON.stringify({ version: RULES_VERSION, run: { chips: 'nope' } }))
    expect(loadRun()).toBeNull()
  })
})
