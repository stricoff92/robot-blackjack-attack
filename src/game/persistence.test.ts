import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createShoe, shuffle } from './deck'
import { encodeSaveKeys } from './keymap'
import { pack } from './obfuscate'
import { createRng } from './random'
import { startRound, type Round } from './round'
import { RULES_VERSION, startRun } from './run'

// Mirror what saveSession writes: fields coded (keymap) before the pack() envelope. Used by the
// setup that seeds the store directly instead of going through saveSession.
function packed(payload: unknown): string {
  return pack(encodeSaveKeys(payload))
}

// A real, deterministic in-progress round (with its full shoe) for the mid-hand save fixtures.
function sampleRound(): Round {
  return startRound(shuffle(createShoe(6), createRng(7)), 20)
}

function sampleSession(overrides: Partial<import('./persistence').PersistedSession> = {}) {
  return {
    run: startRun(7),
    phase: 'playing' as const,
    round: sampleRound(),
    peeked: false,
    codaRedeal: false,
    upgradePending: false,
    ...overrides,
  }
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

import { clearRun, loadSession, saveSession } from './persistence'

const RUN_KEY = 'rba.run'

describe('persistence', () => {
  beforeEach(() => {
    store.clear()
  })

  it('round-trips a full mid-hand session (run + phase + round + flags)', () => {
    const session = sampleSession({ run: { ...startRun(7), chips: 500, score: 1234, shiftIndex: 2, kills: [1] }, peeked: true })
    saveSession(session)
    expect(loadSession()).toEqual(session)
  })

  it('round-trips a betting session (no round)', () => {
    const session = sampleSession({ phase: 'betting', round: null })
    saveSession(session)
    expect(loadSession()).toEqual(session)
  })

  it('round-trips the deal-stream position (deckState)', () => {
    const session = sampleSession({ run: { ...startRun(7), deckState: 0xabcdef12 } })
    saveSession(session)
    expect(loadSession()!.run.deckState).toBe(0xabcdef12)
  })

  it('backfills deckState from the seed for a save missing it', () => {
    const run = { ...startRun(7) } as Record<string, unknown>
    delete run.deckState
    store.set(RUN_KEY, packed({ version: RULES_VERSION, run, phase: 'betting', round: null }))
    const loaded = loadSession()
    expect(loaded).not.toBeNull()
    expect(loaded!.run.deckState).toBe(7) // resumed from the run's origin seed — never undefined/NaN
  })

  it('returns null when nothing is saved', () => {
    expect(loadSession()).toBeNull()
  })

  it('clearRun removes the save', () => {
    saveSession(sampleSession())
    clearRun()
    expect(loadSession()).toBeNull()
  })

  it('discards a save from a different RULES_VERSION (incl. the old RunState-only shape)', () => {
    store.set(RUN_KEY, packed({ version: RULES_VERSION - 1, run: startRun(1), phase: 'betting', round: null }))
    expect(loadSession()).toBeNull()
  })

  it('stores neither readable values nor readable field names (incl. round fields)', () => {
    saveSession(sampleSession({ run: { ...startRun(1), score: 424242 } }))
    const stored = store.get(RUN_KEY) ?? ''
    expect(stored).not.toContain('score')
    expect(stored).not.toContain('424242')
    const inner = atob(stored)
    for (const field of ['chips', 'score', 'integrity', 'tokens', 'upgrades', 'kills', 'phase', 'round', 'shoe', 'cards', 'dealer', 'rules']) {
      expect(inner, `field name leaked: ${field}`).not.toContain(field)
    }
  })

  it('RESUMES a coda save (the bankruptcy/victory coda fix — coda is no longer rejected)', () => {
    const session = sampleSession({ phase: 'coda', round: null, run: { ...startRun(1), coda: true, bankruptcyCoda: true } })
    saveSession(session)
    const loaded = loadSession()
    expect(loaded).not.toBeNull()
    expect(loaded!.phase).toBe('coda')
    expect(loaded!.run.coda).toBe(true)
  })

  it('never resumes a finished (over) run', () => {
    saveSession(sampleSession({ phase: 'resolved', run: { ...startRun(1), over: true } }))
    expect(loadSession()).toBeNull()
  })

  it('rejects an unresumable phase (over / choosing-upgrade / bogus)', () => {
    for (const phase of ['over', 'choosing-upgrade', 'nonsense']) {
      store.clear()
      store.set(RUN_KEY, packed({ version: RULES_VERSION, run: startRun(1), phase, round: null }))
      expect(loadSession(), `phase ${phase} should not resume`).toBeNull()
    }
  })

  it('rejects a mid-hand (playing) save with no round', () => {
    store.set(RUN_KEY, packed({ version: RULES_VERSION, run: startRun(1), phase: 'playing', round: null }))
    expect(loadSession()).toBeNull()
  })

  it('rejects malformed, corrupt, or tampered saves', () => {
    store.set(RUN_KEY, 'not base64 !!!')
    expect(loadSession()).toBeNull()

    store.set(RUN_KEY, packed({ version: RULES_VERSION, run: { chips: 'nope' }, phase: 'betting', round: null }))
    expect(loadSession()).toBeNull()

    const good = packed({ version: RULES_VERSION, run: startRun(1), phase: 'betting', round: null })
    const decoded = atob(good)
    const corrupted = (decoded[0] === '0' ? '1' : '0') + decoded.slice(1)
    store.set(RUN_KEY, btoa(corrupted))
    expect(loadSession()).toBeNull()
  })
})
