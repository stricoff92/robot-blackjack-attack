import { describe, expect, it } from 'vitest'

import { bustChanceOnHit } from './odds'
import { canSplit } from './round'
import { hitTokens } from './run'
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

  it('credits risk-scaled tokens when a hit keeps the hand alive', () => {
    const session = new Session(1)
    session.deal()

    expect(session.snapshot().phase).toBe('playing')
    const snap = session.snapshot()
    const before = snap.run.tokens
    // The award is the pre-hit bust odds mapped through hitTokens (base 1..max 10).
    const expected = hitTokens(bustChanceOnHit(snap.round!))
    expect(expected).toBeGreaterThanOrEqual(1)

    session.hit()

    const after = session.snapshot()
    expect(after.round!.hands.some((hand) => hand.busted)).toBe(false)
    expect(after.run.tokens).toBe(before + expected)
  })

  it('awards no token when a hit busts the hand', () => {
    const session = new Session(3)
    session.deal()

    expect(session.snapshot().phase).toBe('playing')
    const before = session.snapshot().run.tokens

    session.hit()

    expect(session.snapshot().round!.hands.some((hand) => hand.busted)).toBe(true)
    expect(session.snapshot().run.tokens).toBe(before)
  })

  it('ignores powerup buys the player cannot afford', () => {
    const session = new Session(1)
    session.deal()
    expect(session.snapshot().phase).toBe('playing')

    session.buyFreezeDealer()
    session.buyMulligan()

    const snap = session.snapshot()
    expect(snap.run.tokens).toBe(0) // nothing spent — both cost more than the 0 on hand
    expect(snap.round!.dealerFrozen).toBe(false)
    expect(snap.round!.mulliganed).toBe(false)
  })

  it('ignores actions taken out of turn', () => {
    const session = new Session(12345)

    session.hit()

    expect(session.snapshot().run.tokens).toBe(0)
    expect(session.snapshot().run.handsPlayed).toBe(0)
    expect(session.snapshot().phase).toBe('betting')
  })

  describe('Analyze powerup', () => {
    it('does nothing when the player cannot afford it', () => {
      const session = new Session(1)
      session.deal()
      expect(session.snapshot().phase).toBe('playing')
      expect(session.snapshot().run.tokens).toBe(0)

      session.buyAnalyze()

      expect(session.snapshot().analysis).toBeNull()
      expect(session.snapshot().run.tokens).toBe(0)
    })

    it('spends four tokens for a reading that clears on the next move', () => {
      const session = playingSessionWithTokens(4)
      const before = session.snapshot().run.tokens

      session.buyAnalyze()

      const shown = session.snapshot()
      expect(shown.analysis).not.toBeNull()
      expect(shown.run.tokens).toBe(before - 4)
      expect(shown.analysis!.bustChance).toBeGreaterThanOrEqual(0)
      expect(shown.analysis!.bustChance).toBeLessThanOrEqual(1)
      expect(shown.analysis!.dealerWinChance).toBeGreaterThanOrEqual(0)
      expect(shown.analysis!.dealerWinChance).toBeLessThanOrEqual(1)

      // A second buy while the reading is up can't pay twice.
      session.buyAnalyze()
      expect(session.snapshot().run.tokens).toBe(before - 4)

      // Any move dismisses the reading.
      session.stand()
      expect(session.snapshot().analysis).toBeNull()
    })
  })

  describe('forcePairs (dev switch)', () => {
    it('deals the player a matching pair on every seed', () => {
      for (const seed of [1, 2, 3, 12345, 99999]) {
        const session = new Session(seed, { forcePairs: true })
        session.deal()
        const hand = session.snapshot().round!.hands[0]
        expect(hand.cards[0].rank).toBe(hand.cards[1].rank)
      }
    })

    it('honors a requested pair rank', () => {
      const session = new Session(12345, { forcePairs: true, forcePairRank: '8' })
      session.deal()
      const hand = session.snapshot().round!.hands[0]
      expect(hand.cards.map((c) => c.rank)).toEqual(['8', '8'])
    })

    it('leaves the deal untouched when off', () => {
      const rigged = new Session(12345, { forcePairs: false })
      const plain = new Session(12345)
      rigged.deal()
      plain.deal()
      expect(rigged.snapshot().round!.hands[0].cards).toEqual(plain.snapshot().round!.hands[0].cards)
    })

    it('makes the opening hand splittable (pair of 8s is never a natural)', () => {
      const session = new Session(12345, { forcePairs: true, forcePairRank: '8' })
      session.deal()
      const snap = session.snapshot()
      // A pair of 8s can't be a player blackjack; it's in play unless the dealer
      // drew a natural, in which case the round resolves before any split.
      if (snap.phase === 'playing') {
        expect(canSplit(snap.round!)).toBe(true)
      }
    })
  })
})

// A session parked mid-hand with at least `min` tokens banked — funded by playing
// hands until enough tokens accumulate (a win pays 10, blackjack 21, each
// surviving hit 1). Tokens carry across hands, so it stops at the start of the
// first playing phase where the balance is high enough. Deterministic per seed.
function playingSessionWithTokens(min: number): Session {
  for (let seed = 1; seed < 3000; seed += 1) {
    const session = new Session(seed)
    let guard = 0
    while (guard < 60) {
      guard += 1
      const phase = session.snapshot().phase
      if (phase === 'playing' && session.snapshot().run.tokens >= min) {
        return session // parked mid-hand with the tokens to spend
      }
      if (phase === 'betting') {
        session.deal()
      } else if (phase === 'playing') {
        session.stand() // resolve this hand to try to bank its reward
      } else if (phase === 'resolved') {
        session.nextHand()
      } else {
        break // run is over — try another seed
      }
    }
  }
  throw new Error('no funded playing session found in the seed range')
}
