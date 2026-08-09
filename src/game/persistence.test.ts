import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeSaveKeys } from './keymap'
import { pack } from './obfuscate'
import { RULES_VERSION, startRun } from './run'

// Mirror what saveRun writes: fields coded (keymap) before the pack() envelope. Used by the
// setup that seeds the store directly instead of going through saveRun.
function packed(payload: unknown): string {
  return pack(encodeSaveKeys(payload))
}

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
    store.set(RUN_KEY, packed({ version: RULES_VERSION - 1, run: startRun(1) }))
    expect(loadRun()).toBeNull()
  })

  it('stores neither readable values nor readable field names', () => {
    saveRun({ ...startRun(1), score: 424242 })
    const stored = store.get(RUN_KEY) ?? ''
    // Opaque at a glance: the base64 envelope hides the values.
    expect(stored).not.toContain('score')
    expect(stored).not.toContain('424242')
    // Opaque after decoding the envelope too: the field names are mapped to short codes, so a
    // base64-decode reveals no labelled structure to hand-edit.
    const inner = atob(stored)
    for (const field of ['chips', 'score', 'integrity', 'tokens', 'upgrades', 'kills']) {
      expect(inner, `field name leaked: ${field}`).not.toContain(field)
    }
  })

  it('never resumes a finished or coda run', () => {
    saveRun({ ...startRun(1), over: true })
    expect(loadRun()).toBeNull()
    store.clear()
    saveRun({ ...startRun(1), coda: true })
    expect(loadRun()).toBeNull()
  })

  it('rejects malformed, corrupt, or tampered saves', () => {
    store.set(RUN_KEY, 'not base64 !!!')
    expect(loadRun()).toBeNull()

    // A valid envelope but a junk run shape.
    store.set(RUN_KEY, packed({ version: RULES_VERSION, run: { chips: 'nope' } }))
    expect(loadRun()).toBeNull()

    // A save edited after packing (decode → flip a byte → re-encode) fails the checksum.
    const good = packed({ version: RULES_VERSION, run: startRun(1) })
    const decoded = atob(good)
    const corrupted = (decoded[0] === '0' ? '1' : '0') + decoded.slice(1)
    store.set(RUN_KEY, btoa(corrupted))
    expect(loadRun()).toBeNull()
  })
})
