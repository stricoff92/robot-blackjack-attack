import { describe, expect, it } from 'vitest'

import { isBlackjack } from './hand'
import { bustChanceOnHit } from './odds'
import { POWERUPS } from './powerups'
import { canForcedSplit, canSplit } from './round'
import { comboGain, getShift, hitTokens, powerupCost } from './run'
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

  it('grows the combo by the hit risk (not the score) and records the risk when a hit survives', () => {
    const session = new Session(1)
    session.deal()

    const snap = session.snapshot()
    expect(snap.lastHitRisk).toBeNull()
    const risk = bustChanceOnHit(snap.round!)
    const beforeScore = snap.run.score
    const beforeCombo = snap.run.combo

    session.hit()

    const after = session.snapshot()
    expect(after.round!.hands.some((hand) => hand.busted)).toBe(false)
    expect(after.run.score).toBe(beforeScore) // hits earn NO score
    expect(after.run.combo).toBeCloseTo(beforeCombo + comboGain(risk)) // ...only combo
    expect(after.lastHitRisk).toBe(risk)
  })

  it('resets the combo and leaves the score untouched when a hit busts', () => {
    const session = new Session(3)
    session.deal()
    const before = session.snapshot().run.score

    session.hit()

    const after = session.snapshot()
    expect(after.round!.hands.some((hand) => hand.busted)).toBe(true)
    expect(after.run.score).toBe(before)
    expect(after.run.combo).toBe(0) // the busting hit wiped the streak
    expect(after.lastHitRisk).toBeNull()
  })

  it('builds the combo by each hit risk-gain and resets it on a bust', () => {
    // Seed 1's opening hand survives several hits before busting — walk it up, watching the
    // combo climb by comboGain(risk) each time, then bust and confirm it snaps back to 0.
    const session = new Session(1)
    session.deal()
    expect(session.snapshot().run.combo).toBe(0)

    let last = 0
    while (session.snapshot().phase === 'playing') {
      const risk = bustChanceOnHit(session.snapshot().round!)
      const before = session.snapshot().run.combo
      session.hit()
      const snap = session.snapshot()
      if (snap.round!.hands.some((h) => h.busted)) {
        expect(snap.run.combo).toBe(0) // the busting hit reset it
        break
      }
      expect(snap.run.combo).toBeCloseTo(before + comboGain(risk)) // grows by the hit's risk gain
      last = snap.run.combo
    }
    expect(last).toBeGreaterThan(0) // at least one surviving hit built the combo before the bust
  })

  it('carries the combo across a non-losing hand into the next hand', () => {
    const session = new Session(1)
    session.deal()
    // Build some combo with one surviving hit, then stand it out.
    session.hit()
    const combo = session.snapshot().run.combo
    expect(combo).toBeGreaterThan(0)

    while (session.snapshot().phase === 'playing') {
      session.stand()
    }
    // Seed 1's hand isn't a total loss, so resolution keeps the combo (a LOST hand would
    // wipe it — that reset path is covered deterministically in run.test).
    const resolved = session.snapshot()
    expect(resolved.round!.hands.every((h) => h.outcome === 'lose' || h.outcome === 'bust')).toBe(false)
    expect(resolved.run.combo).toBe(combo)

    // ...and across the next hand.
    session.nextHand()
    if (session.snapshot().phase === 'betting') {
      session.deal()
    }
    expect(session.snapshot().run.combo).toBe(combo)
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

  describe('Dealer 1 natural-blackjack guard rail', () => {
    // The dealer's opening two cards; startRound seeds round.dealer as [shoe[2], shoe[3]]
    // and only appends to it when the dealer draws, so the first two are always the deal.
    const openingDealerCards = (session: Session) => session.snapshot().round!.dealer.slice(0, 2)

    it('never deals Dealer 1 a natural blackjack, on any seed', () => {
      // ~4.8% of honest shuffles open on a dealer natural, so across this many first
      // deals a broken guard rail would surface dozens — this asserts none do.
      for (let seed = 1; seed <= 800; seed += 1) {
        const session = new Session(seed)
        session.deal()
        expect(isBlackjack(openingDealerCards(session))).toBe(false)
      }
    })

    it('holds the guard across every hand of the Dealer 1 fight', () => {
      // Play a single run's worth of hands while it stays on Dealer 1 — each deal
      // reshuffles, so the guard has to fire on every one, not just the first.
      const session = new Session(4242)
      for (let hand = 0; hand < 40; hand += 1) {
        const snap = session.snapshot()
        if (snap.phase === 'over' || snap.run.shiftIndex !== 1) break
        if (snap.phase === 'betting') {
          session.deal()
          expect(isBlackjack(openingDealerCards(session))).toBe(false)
          continue
        }
        if (snap.phase === 'resolved') {
          session.nextHand()
          continue
        }
        session.stand()
      }
    })

    it('leaves later dealers unguarded — a Dealer 2 natural is still possible', () => {
      // The rail is Dealer 1 only. Jump straight to Dealer 2 and confirm at least one
      // seed opens on an (honest) dealer natural, proving the guard doesn't leak past D1.
      let sawNatural = false
      for (let seed = 1; seed <= 300 && !sawNatural; seed += 1) {
        const session = new Session(seed, { startDealer: 2 })
        session.deal()
        if (isBlackjack(openingDealerCards(session))) {
          sawNatural = true
        }
      }
      expect(sawNatural).toBe(true)
    })

    it('stays deterministic — the same seed reshuffles to the same guarded shoe', () => {
      const a = new Session(4242)
      const b = new Session(4242)
      a.deal()
      b.deal()
      expect(a.snapshot().round!.shoe).toEqual(b.snapshot().round!.shoe)
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
