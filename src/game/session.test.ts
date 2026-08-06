import { describe, expect, it } from 'vitest'

import { bustChanceOnHit } from './odds'
import { POWERUPS } from './powerups'
import { canForcedSplit, canSplit } from './round'
import { getShift, hitTokens, powerupCost } from './run'
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

describe('Session.buyReturn', () => {
  it('spends the cost, pops the last-drawn card, and auto-stands the hand', () => {
    const cost = POWERUPS.return.cost
    // Drive a real session (the exact path the Return button fires) until it has
    // banked the cost and holds a single, live three-card hand — then Return.
    for (let seed = 1; seed < 3000; seed += 1) {
      const session = new Session(seed)
      for (let guard = 0; guard < 200; guard += 1) {
        const snap = session.snapshot()
        if (snap.phase === 'over') break
        if (snap.phase === 'betting') {
          session.deal()
          continue
        }
        if (snap.phase === 'resolved') {
          session.nextHand()
          continue
        }
        if (snap.phase === 'choosing-upgrade') {
          // A kill parked us on the choose-upgrade screen; pick one (tokens-only, so
          // it doesn't change hand resolution) and carry on hunting for the scenario.
          session.chooseUpgrade('tokenEco')
          continue
        }
        // phase === 'playing': once we can afford Return, take a single hand to
        // three cards; if it survives, that's our scenario.
        const round = snap.round!
        const affordableCleanStart =
          snap.run.tokens >= powerupCost(cost, snap.run) &&
          round.hands.length === 1 &&
          round.hands[0].cards.length === 2
        if (affordableCleanStart) {
          session.hit()
          const mid = session.snapshot()
          const active = mid.round ? mid.round.hands[mid.round.activeIndex] : null
          if (mid.phase === 'playing' && active && active.cards.length > 2 && !active.busted) {
            const tokensBefore = mid.run.tokens
            const cardsBefore = active.cards.length
            session.buyReturn()
            const after = session.snapshot()
            const returned = after.round!.hands[0]
            // Structural effects hold regardless of how the resolution lands.
            expect(returned.cards.length).toBe(cardsBefore - 1) // last card popped off
            expect(returned.finished).toBe(true) // auto-stood
            expect(['resolved', 'over']).toContain(after.phase) // turn handed to the dealer
            // Isolate the spend on a non-winning return: a win would credit its
            // own reward tokens on settle and mask the deduction. A loss/push/bust
            // credits nothing, so the balance is exactly the pre-cast total minus cost.
            if (returned.outcome !== 'win' && returned.outcome !== 'blackjack') {
              // The charge is the inflated price (token inflation may have risen if a
              // kill happened earlier in the loop), so measure against that, not the base.
              expect(after.run.tokens).toBe(tokensBefore - powerupCost(cost, mid.run))
              return
            }
          }
          continue // hit busted, resolved, or won (reward masks the spend) — try again
        }
        session.stand() // not affordable yet — resolve this hand to bank its reward
      }
    }
    throw new Error('no seed reached an affordable Return scenario')
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
      } else if (phase === 'choosing-upgrade') {
        session.chooseUpgrade('tokenEco') // a kill's upgrade pick; tokens-only, keep going
      } else {
        break // run is over — try another seed
      }
    }
  }
  throw new Error('no funded playing session found in the seed range')
}

describe('Session.buyForcedSplit', () => {
  it('splits a non-pair opening hand into two hands and spends the cost', () => {
    const cost = POWERUPS['forced-split'].cost
    for (let seed = 1; seed < 3000; seed += 1) {
      const session = new Session(seed, { startTokens: cost + 5 })
      session.deal()
      const snap = session.snapshot()
      if (snap.phase !== 'playing') continue
      const round = snap.round!
      // The pre-hit phase on a single non-pair hand: force-splittable, but not a
      // free split — exactly when the Forced split button is enabled.
      if (round.hands.length !== 1 || !canForcedSplit(round) || canSplit(round)) continue
      const tokensBefore = snap.run.tokens

      session.buyForcedSplit()

      const after = session.snapshot()
      expect(after.round!.hands.length).toBe(2)
      expect(after.run.tokens).toBe(tokensBefore - cost)
      return
    }
    throw new Error('no seed produced a non-pair opening hand')
  })

  it('refuses (no split, no spend) once the hand has taken a hit', () => {
    const cost = POWERUPS['forced-split'].cost
    for (let seed = 1; seed < 3000; seed += 1) {
      const session = new Session(seed, { startTokens: cost + 5 })
      session.deal()
      if (session.snapshot().phase !== 'playing') continue
      session.hit()
      const snap = session.snapshot()
      // Need a single live hand that has grown past two cards (a survived hit).
      if (snap.phase !== 'playing') continue
      const round = snap.round!
      if (round.hands.length !== 1 || round.hands[0].cards.length <= 2) continue
      expect(canForcedSplit(round)).toBe(false)
      const tokensBefore = snap.run.tokens

      session.buyForcedSplit()

      const after = session.snapshot()
      expect(after.round!.hands.length).toBe(1) // no split happened
      expect(after.run.tokens).toBe(tokensBefore) // and nothing was charged
      return
    }
    throw new Error('no seed produced a post-hit single hand')
  })
})

describe('Session startDealer dev override', () => {
  it('defaults to the first dealer with no kills', () => {
    const run = new Session(1).snapshot().run
    expect(run.shiftIndex).toBe(1)
    expect(run.kills).toEqual([])
  })

  it('jumps to a later dealer, seeding the skipped dealers as kills', () => {
    // Starting at dealer 4 means 3 dealers were already beaten — so the win-at-6
    // count and the "dealers left" pips stay consistent with fighting up to here.
    const run = new Session(1, { startDealer: 4 }).snapshot().run
    expect(run.shiftIndex).toBe(4)
    expect(run.kills).toEqual([1, 2, 3])
  })

  it('opens the jumped-to dealer at its own full health', () => {
    // Regression: a jump used to leave integrity at Dealer 1's 100, so Dealer 6
    // (max 220) opened at ~45% instead of full.
    expect(new Session(1, { startDealer: 6 }).snapshot().run.integrity).toBe(getShift(6).maxIntegrity)
  })

  it('re-applies the override on a New run', () => {
    const session = new Session(1, { startDealer: 3 })
    session.restart()
    const run = session.snapshot().run
    expect(run.shiftIndex).toBe(3)
    expect(run.kills).toEqual([1, 2])
  })
})
