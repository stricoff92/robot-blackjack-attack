import { describe, expect, it } from 'vitest'

import { pack, unpack } from './obfuscate'

describe('obfuscate', () => {
  it('round-trips a value', () => {
    const value = { a: 1, b: [2, 3], c: { d: 4 }, e: true }
    expect(unpack(pack(value))).toEqual(value)
  })

  it('does not expose the value as readable text', () => {
    const packed = pack({ chips: 12345, secret: 'sentinel' })
    expect(packed).not.toContain('chips')
    expect(packed).not.toContain('12345')
    expect(packed).not.toContain('sentinel')
  })

  it('rejects a tampered payload (decode → edit the JSON → re-encode, stale checksum)', () => {
    const packed = pack({ chips: 100 })
    const inner = atob(packed) // "<checksum>|<json>"
    const sep = inner.indexOf('|')
    const editedJson = inner.slice(sep + 1).replace('100', '999999')
    const forged = btoa(inner.slice(0, sep + 1) + editedJson)
    expect(unpack(forged)).toBeNull()
  })

  it('returns null for non-envelope garbage', () => {
    expect(unpack('not base64 !!!')).toBeNull()
    expect(unpack('')).toBeNull()
    expect(unpack(btoa('no-separator-here'))).toBeNull()
  })
})
