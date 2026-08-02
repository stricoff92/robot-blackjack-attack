import { describe, expect, it } from 'vitest'

import { Session } from './session'

describe('Session', () => {
  it('opens in the betting phase with the starting bankroll', () => {
    const snapshot = new Session(12345).snapshot()

    expect(snapshot.phase).toBe('betting')
    expect(snapshot.run.chips).toBe(300)
    expect(snapshot.run.tokens).toBe(0)
  })

  it('deals a hand and plays it through to resolution', () => {
    const session = new Session(12345)
    session.deal()

    expect(['playing', 'resolved']).toContain(session.snapshot().phase)

    while (session.snapshot().phase === 'playing') {
      session.stand()
    }

    expect(['resolved', 'over']).toContain(session.snapshot().phase)
    expect(session.snapshot().run.handsPlayed).toBe(1)
  })

  it('credits a token the moment the player hits', () => {
    const session = new Session(12345)
    session.deal()

    expect(session.snapshot().phase).toBe('playing')
    const before = session.snapshot().run.tokens

    session.hit()

    expect(session.snapshot().run.tokens).toBe(before + 1)
  })

  it('ignores actions taken out of turn', () => {
    const session = new Session(12345)

    session.hit()

    expect(session.snapshot().run.tokens).toBe(0)
    expect(session.snapshot().run.handsPlayed).toBe(0)
    expect(session.snapshot().phase).toBe('betting')
  })
})
