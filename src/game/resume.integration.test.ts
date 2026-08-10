import { afterEach, describe, expect, it } from 'vitest'

import type { RunState } from './run'
import { clearRun, loadRun } from './persistence'
import { Session } from './session'

// The opening cards a session just dealt — player's two + the dealer's two. Fully characterizes the
// shoe the deal drew, so two deals with the same cards came from the same RNG position.
function openingCards(session: Session): { player: string[]; dealer: string[] } {
  const round = session.snapshot().round
  if (!round) {
    throw new Error('no round dealt')
  }
  const label = (c: { rank: string; suit: string }): string => `${c.rank}${c.suit[0]}`
  return { player: round.hands[0].cards.map(label), dealer: round.dealer.map(label) }
}

// One "page reload": a brand-new session (fresh construction seed) resumes the save and deals.
function openingCardsAfterResume(saved: RunState, seed: number): { player: string[]; dealer: string[] } {
  const session = new Session(seed)
  session.adoptRun(saved)
  session.deal()
  return openingCards(session)
}

// Play the first hand of a fresh seed to its stable resolved checkpoint, skipping any seed that
// bankrupts on hand one. Returns the session sitting at 'resolved' with a save written.
function playToFirstCheckpoint(): Session {
  for (let seed = 1; seed < 50; seed += 1) {
    clearRun()
    const session = new Session(seed)
    session.deal()
    while (session.snapshot().phase === 'playing') {
      session.stand()
    }
    if (session.snapshot().phase === 'resolved') {
      return session
    }
  }
  throw new Error('no seed reached a resolved first hand')
}

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

  it('resumes the identical upcoming shoe regardless of the reload seed (no deal reroll)', () => {
    const session = playToFirstCheckpoint()
    const saved = loadRun()
    expect(saved).not.toBeNull()

    // The honest continuation: the saving session deals its NEXT hand. Its deal RNG sits exactly
    // where the checkpoint captured it, so this is the deal the player would have gotten.
    session.nextHand()
    session.deal()
    const expected = openingCards(session)

    // Two independent "reloads" with DIFFERENT fresh construction seeds each resume the same save
    // and deal. Both must reproduce `expected` — the construction seed (a new Math.random per page
    // load) no longer touches the deal, so reload-spamming CONTINUE can't reroll the opening cards.
    expect(openingCardsAfterResume(saved!, 111)).toEqual(expected)
    expect(openingCardsAfterResume(saved!, 987654)).toEqual(expected)
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
