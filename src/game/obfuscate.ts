// Lightweight tamper-resistance for locally-stored saves — deliberately NOT encryption.
//
// Goal: raise the effort for a casual localStorage editor. The payload is base64-wrapped (so it
// doesn't read as plain JSON you can eyeball and bump a number in) AND carries a salted checksum,
// so a decode → edit → re-encode is DETECTED and the save rejected, rather than silently trusted.
//
// This is a speed bump, not a lock. The salt lives in the shipped bundle, so a determined attacker
// can read this file, recompute the checksum, and forge a save — client-side saves can't be truly
// secured (a cheater can equally edit live game memory, or extract the leaderboard encryption key
// and submit directly). The real exposure is the leaderboard, which CrazyGames validates
// server-side. See [[run-persistence]] / [[crazygames-leaderboard]].

// An arbitrary constant baked into the bundle. Mixed into the checksum so a tamperer must reproduce
// this (and the hash) to forge a valid save, not just re-base64 their edit.
const SALT = 'rba::x7Qk29$mZ::save-v1'

// Wrap a value as base64("<checksum>|<json>"). The whole thing is opaque at a glance.
export function pack(value: unknown): string {
  const json = JSON.stringify(value)
  return toBase64(`${checksum(SALT + json)}|${json}`)
}

// Reverse pack(). Returns null on anything off: not our base64 envelope, a bad/absent checksum
// (tampered), or invalid JSON. Callers treat null as "no valid save".
export function unpack(raw: string): unknown | null {
  try {
    const inner = fromBase64(raw)
    const sep = inner.indexOf('|')
    if (sep < 0) {
      return null
    }
    const sig = inner.slice(0, sep)
    const json = inner.slice(sep + 1)
    if (checksum(SALT + json) !== sig) {
      return null // checksum mismatch → the payload was edited
    }
    return JSON.parse(json)
  } catch {
    return null
  }
}

// cyrb53 — a fast, deterministic, synchronous non-crypto 53-bit hash (the browser has no sync
// crypto digest, and persistence saves synchronously). Not secure or collision-proof; it's just an
// integrity tag for tamper-detection. Returned base36 to keep the envelope compact.
function checksum(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(36)
}

// The save JSON is ASCII (numeric fields + ASCII keys), so btoa/atob are safe as-is; the try/catch
// in unpack handles any non-base64 garbage in storage.
function toBase64(str: string): string {
  return btoa(str)
}

function fromBase64(b64: string): string {
  return atob(b64)
}
