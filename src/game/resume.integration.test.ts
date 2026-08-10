import { afterEach, describe, expect, it } from 'vitest'

import { createShoe, shuffle } from './deck'
import { clearRun, loadSession, type PersistedSession } from './persistence'
import { createRng } from './random'
import { startRound } from './round'
import { startRun } from './run'
import { Session } from './session'

// A resolved-hand session snapshot (the between-hands checkpoint), with a pending upgrade or not.
function resolvedSave(upgradePending: boolean, run = startRun(3)): PersistedSession {
  return {
    run,
    phase: 'resolved',
    round: startRound(shuffle(createShoe(6), createRng(3)), 20),
    peeked: false,
    codaRedeal: false,
    upgradePending,
  }
}

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

// One "page reload": a brand-new session (fresh construction seed) resumes the given save, advances
// past the resolved hand it restored, and deals the next one. Takes the captured save explicitly —
// each resume writes its own checkpoint, so we must NOT re-read the store between reloads.
function openingCardsAfterResume(saved: PersistedSession, seed: number): { player: string[]; dealer: string[] } {
  const session = new Session(seed)
  session.adoptSession(saved)
  session.nextHand() // resume restores the exact 'resolved' phase — advance to betting
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

  it('saves an in-progress run and resumes it at the exact phase in a fresh session', () => {
    const session = playToFirstCheckpoint()
    const snap = session.snapshot()
    expect(snap.phase).toBe('resolved')

    // The settle checkpoint persisted the finished hand — the whole session, not just the run.
    const saved = loadSession()
    expect(saved).not.toBeNull()
    expect(saved!.phase).toBe('resolved')
    expect(saved!.run.handsPlayed).toBe(1)
    expect(saved!.run.chips).toBe(snap.run.chips)
    expect(saved!.run.score).toBe(snap.run.score)

    // A brand-new session (as on page reload) adopts the saved session and reopens at the SAME
    // phase — resume-exact, not rewound to betting.
    const resumed = new Session(999)
    resumed.adoptSession(saved!)
    const r = resumed.snapshot()
    expect(r.phase).toBe('resolved')
    expect(r.run.chips).toBe(snap.run.chips)
    expect(r.run.score).toBe(snap.run.score)
    expect(r.run.handsPlayed).toBe(1)
  })

  it('resumes the identical upcoming shoe regardless of the reload seed (no deal reroll)', () => {
    const session = playToFirstCheckpoint()
    // Capture the resolved checkpoint BEFORE the honest continuation overwrites it (each action
    // now checkpoints), so both reloads resume from that same point.
    const saved = loadSession()
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

  // The UI advances a resumed 'resolved' checkpoint past the (already-settled) resolved screen
  // instead of re-showing it — re-showing it would re-run the gather/kill/walk-in ceremonies that a
  // fresh resume can't reconstruct. These assert the engine lands in the right next phase.
  it('resolved + pending upgrade → resume advances to the upgrade pick (choosing-upgrade)', () => {
    const s = new Session(0)
    s.adoptSession(resolvedSave(true, { ...startRun(3), shiftIndex: 2, kills: [1] }))
    expect(s.snapshot().phase).toBe('resolved')
    s.nextHand() // what the UI does on a resolved resume
    expect(s.snapshot().phase).toBe('choosing-upgrade')
  })

  it('resolved + no pending upgrade → resume advances to betting (next hand)', () => {
    const s = new Session(0)
    s.adoptSession(resolvedSave(false))
    s.nextHand()
    expect(s.snapshot().phase).toBe('betting')
    expect(s.snapshot().round).toBeNull()
  })

  it('clearRun wipes a saved run so it no longer resumes', () => {
    const session = new Session(7)
    session.deal()
    while (session.snapshot().phase === 'playing') {
      session.stand()
    }
    clearRun()
    expect(loadSession()).toBeNull()
  })
})
