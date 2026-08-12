import { describe, expect, it } from 'vitest'

import { createShoe, shuffle } from './deck'
import { decodeSaveKeys, encodeSaveKeys } from './keymap'
import { createRng } from './random'
import { startRound } from './round'
import { applyUpgrade, RULES_VERSION, startRun } from './run'

// A representative full save payload: a real RunState (so every serialized field is present) AND a
// real in-progress Round (so every Round/PlayerHand/RoundRules/Card key is present too), with the
// array + nested-object fields made non-trivial (kills populated, an upgrade unlocked) so the
// recursion — and every code in the dictionary — is exercised end-to-end.
function sampleSave() {
  const run = { ...applyUpgrade(startRun(7), 'antiDealer'), score: 1234, kills: [1, 2] }
  const round = startRound(shuffle(createShoe(6), createRng(7)))
  return { version: RULES_VERSION, run, phase: 'playing', round, peeked: true, codaRedeal: false, upgradePending: false }
}

// Every object key reachable in `value` (array elements recursed, numeric indices excluded).
function allKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => allKeys(item, acc))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      acc.add(key)
      allKeys(inner, acc)
    }
  }
  return acc
}

describe('keymap', () => {
  it('round-trips a full save payload (nested upgrades + kills array)', () => {
    const save = sampleSave()
    expect(decodeSaveKeys(encodeSaveKeys(save))).toEqual(save)
  })

  it('leaves no readable field name in the encoded payload', () => {
    const save = sampleSave()
    const json = JSON.stringify(encodeSaveKeys(save))
    // If a serialized field isn't mapped, encode leaves it readable and "field" appears here.
    for (const key of allKeys(save)) {
      expect(json, `unmapped save key: ${key}`).not.toContain(`"${key}"`)
    }
  })

  it('does not mangle array contents (kills stays an ordered number list)', () => {
    const encoded = encodeSaveKeys({ kills: [3, 1, 2] }) as { kl: number[] }
    expect(encoded.kl).toEqual([3, 1, 2])
    expect(decodeSaveKeys(encoded)).toEqual({ kills: [3, 1, 2] })
  })

  it('passes primitives and null straight through', () => {
    expect(encodeSaveKeys(null)).toBeNull()
    expect(decodeSaveKeys(null)).toBeNull()
    expect(encodeSaveKeys(42)).toBe(42)
    expect(decodeSaveKeys('x')).toBe('x')
  })

  it('keeps unmapped keys as-is (forward tolerance for legacy/foreign keys)', () => {
    expect(encodeSaveKeys({ mystery: 1 })).toEqual({ mystery: 1 })
    expect(decodeSaveKeys({ mystery: 1 })).toEqual({ mystery: 1 })
  })

  it('does not mutate its input', () => {
    const save = sampleSave()
    const before = JSON.stringify(save)
    encodeSaveKeys(save)
    expect(JSON.stringify(save)).toBe(before)
  })
})
