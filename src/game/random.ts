export type Rng = () => number

// A seeded RNG (mulberry32) that also exposes its live internal state. mulberry32's whole state is
// a single 32-bit integer, so `.state` fully captures the stream position: snapshot it into a save
// and call createRng(savedState) later to resume the EXACT same sequence. Assignable to Rng — the
// `.state` getter is extra, so any consumer that only wants `() => number` still accepts it.
export interface SeededRng {
  (): number
  /** The RNG's current internal state (a 32-bit uint). Persist it to reproduce the stream. */
  readonly state: number
}

// The initial state IS the argument (a seed for a fresh run, or a previously snapshotted `.state`
// to resume a stream mid-flight — the two are the same operation, since state is all there is).
export function createRng(seed: number): SeededRng {
  let state = seed >>> 0
  const rng = function nextRandom(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  } as SeededRng
  Object.defineProperty(rng, 'state', { get: () => state })
  return rng
}
