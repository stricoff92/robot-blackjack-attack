import { describe, expect, it, vi } from 'vitest'

import { cardValue, isBlackjack } from './hand'
import { submitScore } from './leaderboard'
import { bustChanceOnHit } from './odds'
import { POWERUPS } from './powerups'
import { canForcedSplit, canSplit } from './round'
import { comboGain, getShift, hitTokens, powerupCost } from './run'
import { CODA_ANALYZE_COST, CODA_MULLIGAN_COST, Session } from './session'

// The submit seam is a no-op stub until the SDK lands; mock it so the coda tests can observe
// that each game-end funnels the final score through it.
vi.mock('./leaderboard', () => ({ submitScore: vi.fn() }))

describe('Session', () => {
  it('opens in the betting phase with the starting bankroll', () => {
    const snapshot = new Session(12345).snapshot()

    expect(snapshot.phase).toBe('betting')
    expect(snapshot.run.chips).toBe(300)
    expect(snapshot.run.tokens).toBe(100) // STARTING_TOKENS buffer for the early powerups
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
    const session = new Session(9)
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
    const session = new Session(9)
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
    // Seed 9's opening hand survives at least one hit before busting — walk it up, watching the
    // combo climb by comboGain(risk) each time, then bust and confirm it snaps back to 0.
    const session = new Session(9)
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
    const session = new Session(9)
    session.deal()
    // Build some combo with one surviving hit, then stand it out.
    session.hit()
    const combo = session.snapshot().run.combo
    expect(combo).toBeGreaterThan(0)

    while (session.snapshot().phase === 'playing') {
      session.stand()
    }
    // Seed 9's hand isn't a total loss, so resolution keeps the combo (a LOST hand would
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
    // Pin to a broke player so both buys are genuinely unaffordable (defeats the
    // STARTING_TOKENS buffer, which would otherwise cover Freeze Dealer).
    const session = new Session(1, { startTokens: 0 })
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
    const session = new Session(12345, { startTokens: 0 })

    session.hit()

    expect(session.snapshot().run.tokens).toBe(0)
    expect(session.snapshot().run.handsPlayed).toBe(0)
    expect(session.snapshot().phase).toBe('betting')
  })

  describe('Analyze powerup', () => {
    it('does nothing when the player cannot afford it', () => {
      const session = new Session(1, { startTokens: 0 })
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

  describe('opening-deal guard rails', () => {
    // The dealer's opening two cards; startRound seeds round.dealer as [shoe[2], shoe[3]]
    // and only appends to it when the dealer draws, so the first two are always the deal.
    const openingDealerCards = (session: Session) => session.snapshot().round!.dealer.slice(0, 2)
    // The player's opening two cards; hand 0 is seeded [shoe[0], shoe[1]] and grows only on
    // a hit, so right after deal() its first two cards are the deal.
    const openingPlayerCards = (session: Session) => session.snapshot().round!.hands[0].cards.slice(0, 2)

    it('never deals Dealer 1 an Ace or 10-value up-card, on any seed', () => {
      // The up-card is shoe[2] = round.dealer[0]. ~38% of honest shuffles open on an Ace or a
      // ten-value up-card, so a broken rail would surface constantly across this sweep.
      for (let seed = 1; seed <= 800; seed += 1) {
        const session = new Session(seed)
        session.deal()
        const upCard = openingDealerCards(session)[0]
        expect(upCard.rank === 'A' || cardValue(upCard) === 10).toBe(false)
      }
    })

    it('never deals Dealer 1 a natural blackjack, on any seed', () => {
      // Barring the Ace/ten up-card also precludes a two-card natural (which needs an Ace
      // paired with a ten). Across this many first deals a leak would surface dozens.
      for (let seed = 1; seed <= 800; seed += 1) {
        const session = new Session(seed)
        session.deal()
        expect(isBlackjack(openingDealerCards(session))).toBe(false)
      }
    })

    it('never deals the PLAYER a natural on the very first hand, on any seed', () => {
      // The player-side rail guards only the opening hand (a UI/UX fix, not a debuff): the
      // game's very first deal is never an instant blackjack. A fresh session's first deal()
      // is always that opening hand (handsThisDealer === 0), so this sweep exercises it.
      for (let seed = 1; seed <= 800; seed += 1) {
        const session = new Session(seed)
        session.deal()
        expect(isBlackjack(openingPlayerCards(session))).toBe(false)
      }
    })

    it('guards the dealer up-card on EVERY Dealer 1 hand, but the player only on the first', () => {
      // Play a run's worth of hands while it stays on Dealer 1 — each deal reshuffles, so the
      // DEALER up-card guard has to fire on every one (no Ace/ten face-up, ever — Dealer 1 is
      // meant to be easy). The PLAYER guard is opening-hand only: after the first hand the player
      // may open on a natural again (the buff), so we assert it's guarded on hand 0 and simply
      // don't constrain it afterward.
      const session = new Session(4242)
      let dealNumber = 0
      for (let hand = 0; hand < 40; hand += 1) {
        const snap = session.snapshot()
        if (snap.phase === 'over' || snap.run.shiftIndex !== 1) break
        if (snap.phase === 'betting') {
          session.deal()
          const upCard = openingDealerCards(session)[0]
          expect(upCard.rank === 'A' || cardValue(upCard) === 10).toBe(false) // guarded EVERY hand
          if (dealNumber === 0) {
            expect(isBlackjack(openingPlayerCards(session))).toBe(false)
          }
          dealNumber += 1
          continue
        }
        if (snap.phase === 'resolved') {
          session.nextHand()
          continue
        }
        session.stand()
      }
      expect(dealNumber).toBeGreaterThan(1) // actually exercised multiple Dealer 1 hands, not just the opener
    })

    it('lets the player open on a natural after the first Dealer 1 hand (the buff)', () => {
      // The player-side rail is opening-hand only. Sweep seeds: play the guarded first hand,
      // then hunt the following Dealer 1 deals for a player natural. At ~4.8% a side it must
      // surface within this many seeds — proving the guard is lifted past the opening hand.
      let sawLaterPlayerNatural = false
      for (let seed = 1; seed <= 1500 && !sawLaterPlayerNatural; seed += 1) {
        const session = new Session(seed)
        for (let hand = 0; hand < 12; hand += 1) {
          const snap = session.snapshot()
          if (snap.phase === 'over' || snap.run.shiftIndex !== 1) break
          if (snap.phase === 'betting') {
            session.deal()
            const dealt = session.snapshot()
            // Only the deals AFTER the opening one may show a player natural.
            if (dealt.run.handsThisDealer > 0 && isBlackjack(openingPlayerCards(session))) {
              sawLaterPlayerNatural = true
              break
            }
            continue
          }
          if (snap.phase === 'resolved') {
            session.nextHand()
            continue
          }
          session.stand()
        }
      }
      expect(sawLaterPlayerNatural).toBe(true)
    })

    it('weakens the dealer up-card guard past Dealer 1 — mid dealers sometimes, late dealers freely', () => {
      // The up-card reshuffle chance falls off fast (Dealer 1 100% → 2 30% → 3 15% → 0% from
      // Dealer 4 on), so a 10/11 up-card that NEVER appears on Dealer 1 shows up often on a mid
      // dealer (partial guard) and freely on a late one (unguarded). Sweep seeds per start-dealer
      // and confirm at least one 10/11 up-card surfaces — proving the rail isn't Dealer-1-wide.
      const sawTenOrAceUpcard = (startDealer: number) => {
        for (let seed = 1; seed <= 400; seed += 1) {
          const session = new Session(seed, { startDealer })
          session.deal()
          const up = openingDealerCards(session)[0]
          if (up.rank === 'A' || cardValue(up) === 10) return true
        }
        return false
      }
      expect(sawTenOrAceUpcard(2)).toBe(true) // ~30% of Dealer 2 deals survive its 30% reshuffle
      expect(sawTenOrAceUpcard(5)).toBe(true) // ~38% — Dealer 5 is fully unguarded
    })

    it('leaves Dealers 5 & 6 fully unguarded — a natural is still possible for either side', () => {
      // Dealers 5 & 6 sit at 0% reshuffle, so both a dealer AND a player natural still appear
      // honestly across seeds — the guard is completely lifted for the late game.
      let sawDealerNatural = false
      let sawPlayerNatural = false
      for (let seed = 1; seed <= 300 && !(sawDealerNatural && sawPlayerNatural); seed += 1) {
        const session = new Session(seed, { startDealer: 5 })
        session.deal()
        if (isBlackjack(openingDealerCards(session))) {
          sawDealerNatural = true
        }
        if (isBlackjack(openingPlayerCards(session))) {
          sawPlayerNatural = true
        }
      }
      expect(sawDealerNatural).toBe(true)
      expect(sawPlayerNatural).toBe(true)
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

describe('Session Banker coda', () => {
  // Session at the MOMENT the coda is entered: jump to dealer 6 at ~1% health, then win a hand
  // to land the 6th kill. The killing hand is still on the table (a real bet), awaiting the
  // entry ceremony. Fat chips so a cold streak rarely busts out first; null if it busts out.
  function codaEntry(seed: number): Session | null {
    const session = new Session(seed, { startDealer: 6, dealerHealth: 1, startChips: 100000, startTokens: 500 })
    for (let guard = 0; guard < 60; guard += 1) {
      const phase = session.snapshot().phase
      if (phase === 'coda') return session
      if (phase === 'over') return null
      if (phase === 'betting') { session.deal(); continue }
      if (phase === 'resolved') { session.nextHand(); continue }
      if (phase === 'choosing-upgrade') { session.chooseUpgrade('tokenEco'); continue }
      session.stand() // a win kills the ~2 HP dealer 6 → the coda
    }
    return null
  }

  function firstCodaEntry(): Session {
    for (let seed = 1; seed < 4000; seed += 1) {
      const session = codaEntry(seed)
      if (session) return session
    }
    throw new Error('no seed reached the coda')
  }

  // Session at the coda PROMPT — killing hand dismissed (codaResolveNext), awaiting DOUBLE / CASH OUT.
  function codaPrompt(seed: number): Session | null {
    const session = codaEntry(seed)
    if (!session) return null
    session.codaResolveNext() // dismiss the killing hand → the prompt
    return session
  }

  function firstPrompt(): Session {
    for (let seed = 1; seed < 4000; seed += 1) {
      const session = codaPrompt(seed)
      if (session) return session
    }
    throw new Error('no seed reached the coda prompt')
  }

  // Session parked on a LIVE double-or-nothing hand (dealt, not resolved at the deal).
  function codaHand(): Session {
    for (let seed = 1; seed < 4000; seed += 1) {
      const session = codaPrompt(seed)
      if (!session) continue
      session.codaGamble()
      const round = session.snapshot().round
      if (round && round.status === 'player-turn') return session
    }
    throw new Error('no seed produced a live coda hand')
  }

  it('enters with the killing hand present, then dismisses to the prompt', () => {
    const session = firstCodaEntry()
    const entry = session.snapshot()
    // At coda entry the killing hand (a real bet) is still on the table for the ceremony.
    expect(entry.phase).toBe('coda')
    expect(entry.round).not.toBeNull()
    expect(entry.round!.hands[0].bet).toBeGreaterThan(0)
    expect(entry.run.coda).toBe(true)
    expect(entry.run.over).toBe(false)
    expect(entry.run.won).toBe(false)
    expect(entry.run.score).toBeGreaterThan(0)
    const score = entry.run.score

    session.codaResolveNext() // after the ceremony → the prompt

    const prompt = session.snapshot()
    expect(prompt.phase).toBe('coda')
    expect(prompt.round).toBeNull()
    expect(prompt.run.score).toBe(score) // dismissing the killing hand does NOT double it
  })

  it('cashes out — banks the score, ends the run, and submits it once', () => {
    const submit = vi.mocked(submitScore)
    const session = firstPrompt()
    const score = session.snapshot().run.score
    submit.mockClear() // discard any submits from busted setup seeds

    session.codaCashOut()

    const after = session.snapshot()
    expect(after.phase).toBe('over')
    expect(after.run.over).toBe(true)
    expect(after.run.cashedOut).toBe(true)
    expect(after.run.score).toBe(score) // preserved
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(score)
  })

  it('resolves every coda outcome — win doubles, loss zeroes + submits 0, push re-deals', () => {
    const submit = vi.mocked(submitScore)
    let sawWin = false
    let sawLoss = false
    let sawPush = false
    for (let seed = 1; seed < 4000 && !(sawWin && sawLoss && sawPush); seed += 1) {
      const session = codaPrompt(seed)
      if (!session) continue
      const entry = session.snapshot().run.score
      session.codaGamble()
      let snap = session.snapshot()
      while (snap.round && snap.round.status === 'player-turn') {
        session.codaStand()
        snap = session.snapshot()
      }
      const outcome = session.snapshot().round!.hands[0].outcome!
      submit.mockClear()
      session.codaResolveNext()
      const after = session.snapshot()
      if (outcome === 'win' || outcome === 'blackjack') {
        expect(after.run.score).toBe(entry * 2)
        expect(after.phase).toBe('coda')
        expect(after.round).toBeNull()
        sawWin = true
      } else if (outcome === 'push' || outcome === 'voided') {
        expect(after.run.score).toBe(entry)
        expect(after.phase).toBe('coda')
        expect(after.codaRedeal).toBe(true)
        sawPush = true
      } else {
        expect(after.run.score).toBe(0)
        expect(after.phase).toBe('over')
        expect(after.run.over).toBe(true)
        expect(submit).toHaveBeenCalledWith(0)
        sawLoss = true
      }
    }
    expect(sawWin).toBe(true)
    expect(sawLoss).toBe(true)
    expect(sawPush).toBe(true)
  })

  it('Analyze is cheap, always fires, and does not pay twice', () => {
    const session = codaHand()
    const before = session.snapshot().run.tokens

    session.codaAnalyze()

    const shown = session.snapshot()
    expect(shown.analysis).not.toBeNull()
    expect(shown.run.tokens).toBe(before - CODA_ANALYZE_COST)
    session.codaAnalyze() // a second buy while a reading is up is a no-op
    expect(session.snapshot().run.tokens).toBe(before - CODA_ANALYZE_COST)
  })

  it('Mulligan spends a flat cost and always redraws the opening two', () => {
    const session = codaHand()
    const before = session.snapshot().run.tokens

    session.codaMulligan()

    const after = session.snapshot()
    expect(after.run.tokens).toBe(before - CODA_MULLIGAN_COST)
    expect(after.round!.mulliganed).toBe(true)
  })
})
