import { afterEach, describe, expect, it } from 'vitest'

import { clearRun, loadRun } from './persistence'
import { Session } from './session'

// End-to-end, NO mocks: a real Session writes through real persistence (backed by the in-memory
// store in the node test env, since window/localStorage/SDK are absent), and a fresh Session
// resumes it. This is the full save → load → adopt path behind the title's "Continue" button.
describe('resume (integration)', () => {
  afterEach(() => {
    clearRun()
  })

  it('saves an in-progress run and resumes it in a fresh session', () => {
    // Play the first hand to resolution (skip any seed that would bankrupt on hand one).
    let session!: Session
    for (let seed = 1; seed < 50; seed += 1) {
      clearRun()
      session = new Session(seed)
      session.deal()
      while (session.snapshot().phase === 'playing') {
        session.stand()
      }
      if (session.snapshot().phase === 'resolved') {
        break
      }
    }
    const snap = session.snapshot()
    expect(snap.phase).toBe('resolved')

    // The settle checkpoint persisted the finished hand.
    const saved = loadRun()
    expect(saved).not.toBeNull()
    expect(saved!.handsPlayed).toBe(1)
    expect(saved!.chips).toBe(snap.run.chips)
    expect(saved!.score).toBe(snap.run.score)

    // A brand-new session (as on page reload) adopts the saved run and reopens at betting.
    const resumed = new Session(999)
    resumed.adoptRun(saved!)
    const r = resumed.snapshot()
    expect(r.phase).toBe('betting')
    expect(r.run.chips).toBe(snap.run.chips)
    expect(r.run.score).toBe(snap.run.score)
    expect(r.run.handsPlayed).toBe(1)
  })

  it('clearRun wipes a saved run so it no longer resumes', () => {
    const session = new Session(7)
    session.deal()
    while (session.snapshot().phase === 'playing') {
      session.stand()
    }
    clearRun()
    expect(loadRun()).toBeNull()
  })
})
