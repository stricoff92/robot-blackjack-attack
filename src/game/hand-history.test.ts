import { describe, expect, it } from 'vitest'
import { parseHandHistory, replayHandHistory } from './hand-history'
import { basePoints, getShift, MAX_HEARTS, startRun, type RunState } from './run'

// A fresh run seeded onto `dealer` at full health, the way Session.freshRun_ does for ?dealer=N.
function runOnDealer(dealer: number): RunState {
  const kills: number[] = []
  for (let i = 1; i < dealer; i += 1) {
    kills.push(i)
  }
  return { ...startRun(1), shiftIndex: dealer, kills, integrity: getShift(dealer).maxHits }
}

// The compounding score of the first `count` wins in a run (rounded per win, like applyRound).
function scoreForWins(count: number): number {
  let sum = 0
  for (let n = 1; n <= count; n += 1) {
    sum += Math.round(basePoints(n))
  }
  return sum
}

describe('parseHandHistory', () => {
  it('parses a 0/1 string into booleans (1 = win)', () => {
    expect(parseHandHistory('11001')).toEqual([true, true, false, false, true])
    expect(parseHandHistory('1')).toEqual([true])
    expect(parseHandHistory('0')).toEqual([false])
  })

  it('rejects absent/empty/malformed strings', () => {
    expect(parseHandHistory(null)).toBeNull()
    expect(parseHandHistory('')).toBeNull()
    expect(parseHandHistory('1102')).toBeNull() // stray 2
    expect(parseHandHistory('abc')).toBeNull()
    expect(parseHandHistory('1 1')).toBeNull() // whitespace
  })
})

describe('replayHandHistory — faithful replay', () => {
  it('scores wins off the compounding curve and lands on the next hand', () => {
    const out = replayHandHistory(runOnDealer(1), [true, true, true]) // "111"
    expect(out).not.toBeNull()
    expect(out!.shiftIndex).toBe(1) // still fighting dealer 1
    expect(out!.wins).toBe(3)
    expect(out!.score).toBe(scoreForWins(3)) // "as if 3 wins recorded"
    expect(out!.handsThisDealer).toBe(3) // loads on hand 4
    expect(out!.integrity).toBe(getShift(1).maxHits - 3) // 3 wins = 3 hits of dealer damage
    expect(out!.hitPoints).toBe(MAX_HEARTS) // no losses; heals capped at max
  })

  it('spends a heart per loss', () => {
    const out = replayHandHistory(runOnDealer(1), [false, false]) // "00"
    expect(out).not.toBeNull()
    expect(out!.shiftIndex).toBe(1)
    expect(out!.wins).toBe(0)
    expect(out!.score).toBe(0)
    expect(out!.hitPoints).toBe(MAX_HEARTS - 2)
    expect(out!.handsThisDealer).toBe(2)
  })

  it('replays the ?dealer=4&handhistory=11001 example coherently', () => {
    const out = replayHandHistory(runOnDealer(4), [true, true, false, false, true]) // "11001"
    expect(out).not.toBeNull()
    expect(out!.shiftIndex).toBe(4)
    expect(out!.wins).toBe(3)
    expect(out!.score).toBe(scoreForWins(3))
    expect(out!.handsThisDealer).toBe(5) // loads on hand 6
    expect(out!.hitPoints).toBe(MAX_HEARTS - 2) // two losses (wins can't over-heal past max)
    // 3 wins net at least one hit of damage even after any heal-on-loss; still alive.
    expect(out!.integrity).toBeGreaterThan(0)
    expect(out!.integrity).toBeLessThan(getShift(4).maxHits)
  })
})

describe('replayHandHistory — strict rejection (keeps ?dealer authoritative)', () => {
  it('rejects an empty history', () => {
    expect(replayHandHistory(runOnDealer(1), [])).toBeNull()
  })

  it('rejects a history longer than the dealer window', () => {
    const tooLong = new Array<boolean>(getShift(1).maxHands + 1).fill(false)
    expect(replayHandHistory(runOnDealer(1), tooLong)).toBeNull()
  })

  it('rejects a history that would kill the dealer (advance off it)', () => {
    const enoughToKill = new Array<boolean>(getShift(1).maxHits).fill(true) // maxHits wins
    expect(replayHandHistory(runOnDealer(1), enoughToKill)).toBeNull()
  })

  it('rejects a history that would zero the hearts (open the coda)', () => {
    const enoughToDie = new Array<boolean>(MAX_HEARTS).fill(false) // MAX_HEARTS losses
    expect(replayHandHistory(runOnDealer(1), enoughToDie)).toBeNull()
  })
})
