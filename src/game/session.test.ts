import { describe, expect, it, vi } from 'vitest'

import { cardValue, isBlackjack } from './hand'
import { recordRun } from './leaderboard'
import { bustChanceOnHit } from './odds'
import { clearRun, saveSession, type PersistedSession } from './persistence'
import { POWERUPS } from './powerups'
import { canForcedSplit, canSplit } from './round'
import { getShift, hitTokens, powerupCost, SABOTAGE_DEALER21_ENERGY, STARTING_TOKENS, startRun } from './run'
import { CODA_ANALYZE_COST, CODA_MULLIGAN_COST, REWARDED_AD_ENERGY, Session } from './session'

// recordRun submits to CrazyGames + updates the personal best (real storage/SDK); mock it so the
// coda tests can observe that each game-end funnels the final score through the single seam
// without touching localStorage or the SDK. Returns a non-record result by default.
vi.mock('./leaderboard', () => ({ recordRun: vi.fn(() => ({ previousBest: 0, isNewBest: false })) }))

// Persistence writes to real storage (SDK.data/localStorage); mock it so tests can observe the
// save/clear checkpoints without touching storage. loadSession returns null (no saved run) by default.
vi.mock('./persistence', () => ({ saveSession: vi.fn(), clearRun: vi.fn(), loadSession: vi.fn(() => null) }))

// Wrap a bare run into a betting-phase session snapshot for adoptSession (the common resume shape).
function bettingResume(run: import('./run').RunState): PersistedSession {
  return { run, phase: 'betting', round: null, peeked: false, codaRedeal: false, upgradePending: false }
}

describe('Session', () => {
  it('opens in the betting phase with the starting resources', () => {
    const snapshot = new Session(12345).snapshot()

    expect(snapshot.phase).toBe('betting')
    expect(snapshot.run.tokens).toBe(100) // STARTING_TOKENS buffer for the early powerups
    expect(snapshot.run.score).toBe(0)
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

  it('checkpoints the run after a resolved hand and clears it at game-over', () => {
    const save = vi.mocked(saveSession)
    const clear = vi.mocked(clearRun)
    const session = new Session(12345)
    save.mockClear()
    clear.mockClear()

    session.deal()
    while (session.snapshot().phase === 'playing') {
      session.stand()
    }

    const snap = session.snapshot()
    if (snap.phase === 'resolved') {
      // A between-hands checkpoint captured the finished hand's run.
      expect(save).toHaveBeenCalled()
      const lastRun = save.mock.calls[save.mock.calls.length - 1][0].run
      expect(lastRun.handsPlayed).toBe(1)
    } else {
      // A bankrupt bust-out funnels through enterOver, which nukes the save.
      expect(clear).toHaveBeenCalled()
    }
  })

  it('adoptSession resumes a saved betting run', () => {
    const session = new Session(1)
    const saved = bettingResume({ ...startRun(999), score: 4200, tokens: 40, shiftIndex: 3, integrity: 5, kills: [1, 2] })

    session.adoptSession(saved)

    const snap = session.snapshot()
    expect(snap.phase).toBe('betting')
    expect(snap.round).toBeNull()
    expect(snap.run.score).toBe(4200)
    expect(snap.run.shiftIndex).toBe(3)
    expect(snap.run.kills).toEqual([1, 2])
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

  it('tallies performance at resolution: a busting hit counts a bust and rates the (recorded) hand', () => {
    const session = new Session(3)
    session.deal()
    expect(session.snapshot().phase).toBe('playing')

    session.hit() // busts this hand → resolves the round → settle_ → tallyPerformance

    const run = session.snapshot().run
    expect(run.busts).toBe(1)
    expect(run.ratedHands).toBe(1) // the hit was captured as the terminal decision
    expect(run.ratingSum).toBeGreaterThanOrEqual(1)
    expect(run.ratingSum).toBeLessThanOrEqual(5)
    expect(run.blackjackWins).toBe(0)
  })

  it('rates a stood hand and leaves the bust/blackjack tallies clear', () => {
    const session = new Session(9)
    session.deal()
    expect(session.snapshot().phase).toBe('playing')

    while (session.snapshot().phase === 'playing') {
      session.stand()
    }

    const run = session.snapshot().run
    expect(run.busts).toBe(0) // standing never busts
    expect(run.ratedHands).toBe(1) // the stand was captured + rated
    expect(run.ratingSum).toBeGreaterThanOrEqual(1)
    expect(run.ratingSum).toBeLessThanOrEqual(5)
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

  describe('forcePlayerNatural (dev switch)', () => {
    it('deals the player a natural 21 on every seed', () => {
      for (const seed of [1, 2, 3, 12345, 99999]) {
        const session = new Session(seed, { forcePlayerNatural: true })
        session.deal()
        // The natural auto-resolves at the deal, so read hand 0's opening two cards from the
        // resolved round (blackjack outcome) or the live one.
        const hand = session.snapshot().round!.hands[0]
        expect(isBlackjack(hand.cards.slice(0, 2))).toBe(true)
      }
    })

    it('resolves the opening hand as a player blackjack (dealer natural is guarded off)', () => {
      const session = new Session(12345, { forcePlayerNatural: true })
      session.deal()
      const snap = session.snapshot()
      // A player natural with no dealer natural resolves instantly as a blackjack win.
      expect(snap.round!.hands[0].outcome).toBe('blackjack')
    })

    it('leaves the deal untouched when off', () => {
      const rigged = new Session(2024, { forcePlayerNatural: false })
      const plain = new Session(2024)
      rigged.deal()
      plain.deal()
      expect(rigged.snapshot().round!.hands[0].cards).toEqual(plain.snapshot().round!.hands[0].cards)
    })

    it('composes with forceDealerNatural — both draw naturals (a push)', () => {
      const session = new Session(777, { forcePlayerNatural: true, forceDealerNatural: true })
      session.deal()
      const snap = session.snapshot()
      expect(isBlackjack(snap.round!.hands[0].cards.slice(0, 2))).toBe(true)
      expect(isBlackjack(snap.round!.dealer.slice(0, 2))).toBe(true)
    })
  })

  describe('Sabotage dealer-21 energy (T1)', () => {
    // A fresh session sits on Dealer 1's first hand, where the opening-deal guard forbids the PLAYER a
    // natural — so forceDealerNatural cleanly produces a dealer 21 the player faces without one.
    const sabotaged = (antiDealer: number) =>
      new Session(4242, { forceDealerNatural: true, startUpgrades: { antiDealer, chipEco: 0, tokenEco: 0 } })

    it('pays a flat +20 energy on a loss to a dealer natural (T1)', () => {
      const session = sabotaged(1)
      session.deal()
      const snap = session.snapshot()
      expect(snap.round!.hands[0].outcome).toBe('lose') // the dealer's natural beat the player
      expect(snap.run.tokens).toBe(STARTING_TOKENS + SABOTAGE_DEALER21_ENERGY)
    })

    it('does not pay without the Sabotage upgrade', () => {
      const session = new Session(4242, { forceDealerNatural: true })
      session.deal()
      expect(session.snapshot().run.tokens).toBe(STARTING_TOKENS)
    })

    it('still pays on a T2-voided dealer 21 (the hand washes but the energy lands)', () => {
      const session = sabotaged(2)
      session.deal()
      const snap = session.snapshot()
      expect(snap.round!.hands[0].outcome).toBe('voided')
      expect(snap.run.tokens).toBe(STARTING_TOKENS + SABOTAGE_DEALER21_ENERGY)
    })

    it('tallies the washed round as a push, without consuming a scored hand', () => {
      const session = sabotaged(2)
      session.deal()
      const snap = session.snapshot()
      // The wash short-circuits applyRound, so it's the pushes counter — not handsPlayed — that moves.
      // Without it the score screen's PUSH % could only ever read 0%.
      expect(snap.run.pushes).toBe(1)
      expect(snap.run.handsPlayed).toBe(0)
      expect(snap.run.handsWon).toBe(0)
      expect(snap.run.handsLost).toBe(0)
    })

    it('stacks on a T3 hijack — the blackjack reward plus the +20 energy', () => {
      const session = sabotaged(3)
      session.deal()
      const snap = session.snapshot()
      expect(snap.round!.hands[0].outcome).toBe('blackjack') // the dealer's natural is hijacked into a player win
      // 21 blackjack-win tokens + the flat sabotage bonus, both banked on the same resolve
      expect(snap.run.tokens).toBe(STARTING_TOKENS + 21 + SABOTAGE_DEALER21_ENERGY)
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
    expect(new Session(1, { startDealer: 6 }).snapshot().run.integrity).toBe(getShift(6).maxHits)
  })

  it('FORGETS the override on a New run — a clean default first-dealer run', () => {
    // A New run ignores every dev URL override, so a debug-seeded run can't re-seed the same
    // (possibly broken) state on restart. It starts at the first dealer with no kills.
    const session = new Session(1, { startDealer: 3, startScore: 14343, startTokens: 500 })
    session.restart()
    const run = session.snapshot().run
    expect(run.shiftIndex).toBe(1)
    expect(run.kills).toEqual([])
    // …and the other overrides are gone too — zero score, default tokens.
    expect(run.score).toBe(0)
    expect(run.tokens).toBe(new Session(1).snapshot().run.tokens)
  })
})

describe('Session Banker coda', () => {
  // Session at the MOMENT the coda is entered: jump to dealer 6 at ~1% health, then win a hand
  // to land the 6th kill. The killing hand is still on the table (a real bet), awaiting the
  // entry ceremony. Fat chips so a cold streak rarely busts out first; null if it busts out.
  function codaEntry(seed: number): Session | null {
    const session = new Session(seed, { startDealer: 6, dealerHealth: 1, startTokens: 500 })
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
    expect(entry.run.score).toBeGreaterThan(0)
    const score = entry.run.score

    session.codaResolveNext() // after the ceremony → the prompt

    const prompt = session.snapshot()
    expect(prompt.phase).toBe('coda')
    expect(prompt.round).toBeNull()
    expect(prompt.run.score).toBe(score) // dismissing the killing hand does NOT double it
  })

  it('respects ?playerBlackjack in the coda — the gamble deals the player a natural', () => {
    // Reach a coda prompt with the dev switch on, then gamble: like the main deal, the coda hand
    // must open the PLAYER on a natural 21 (an instant coda win), not just normal main-game deals.
    for (let seed = 1; seed < 4000; seed += 1) {
      const session = new Session(seed, {
        startDealer: 6,
        dealerHealth: 1,
        startTokens: 500,
        forcePlayerNatural: true,
      })
      let reached = false
      for (let guard = 0; guard < 60; guard += 1) {
        const phase = session.snapshot().phase
        if (phase === 'coda') { reached = true; break }
        if (phase === 'over') break
        if (phase === 'betting') { session.deal(); continue }
        if (phase === 'resolved') { session.nextHand(); continue }
        if (phase === 'choosing-upgrade') { session.chooseUpgrade('tokenEco'); continue }
        session.stand()
      }
      if (!reached) continue

      session.codaResolveNext() // dismiss the killing hand → the prompt
      session.codaGamble()
      const round = session.snapshot().round!
      // The player's opening two are a natural — the whole point of the dev switch.
      expect(isBlackjack([round.hands[0].cards[0], round.hands[0].cards[1]])).toBe(true)
      return
    }
    throw new Error('no seed reached the coda with forcePlayerNatural')
  })

  it('never deals the Banker a natural 21, across many double-or-nothing hands', () => {
    // The coda stakes the WHOLE score with no move to make and no sabotage upgrades in play,
    // so a dealt Banker natural would zero the run instantly — guardDealerNatural must never
    // let it happen. Unguarded, ~4.8% of deals are a two-card natural, so across this many coda
    // hands a leak would surface dozens of times over. The PLAYER may still open on a natural.
    let deals = 0
    for (let seed = 1; seed < 2000 && deals < 500; seed += 1) {
      const session = codaPrompt(seed)
      if (!session) continue
      // Ride double-or-nothing for this whole run (win re-prompts, push re-deals, loss ends it),
      // checking the Banker's opening two cards on every deal.
      for (let guard = 0; guard < 40 && session.snapshot().phase === 'coda'; guard += 1) {
        const round = session.snapshot().round
        if (!round) {
          session.codaGamble()
          const dealt = session.snapshot().round
          if (!dealt) break
          expect(isBlackjack(dealt.dealer.slice(0, 2))).toBe(false)
          deals += 1
          continue
        }
        if (round.status === 'player-turn') { session.codaStand(); continue }
        session.codaResolveNext() // resolved → double a win / re-deal a push / end on a loss
      }
    }
    expect(deals).toBeGreaterThan(100) // actually sampled a large batch of Banker deals
  })

  it('cashes out — banks the score, ends the run, and submits it once', () => {
    const submit = vi.mocked(recordRun)
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
    const submit = vi.mocked(recordRun)
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

describe('Session.grantRewardedEnergy', () => {
  it('adds a flat, inflation-neutral energy grant and stamps the per-dealer / per-run caps', () => {
    const session = new Session(12345)
    const before = session.snapshot().run

    session.grantRewardedEnergy()

    const after = session.snapshot().run
    expect(after.tokens).toBe(before.tokens + REWARDED_AD_ENERGY)
    // Inflation-neutral: the grant must NOT feed tokensThisShift (which would inflate later powerups).
    expect(after.tokensThisShift).toBe(before.tokensThisShift)
    // "Once per dealer" is gated on rewardedAdShiftIndex === shiftIndex; the per-run count climbs.
    expect(after.rewardedAdShiftIndex).toBe(after.shiftIndex)
    expect(after.rewardedAdsThisRun).toBe(before.rewardedAdsThisRun + 1)
  })

  it('accumulates across grants (the per-run cap is enforced by the button gate, not here)', () => {
    const session = new Session(777)

    session.grantRewardedEnergy()
    session.grantRewardedEnergy()

    const run = session.snapshot().run
    expect(run.rewardedAdsThisRun).toBe(2)
    expect(run.tokens).toBe(STARTING_TOKENS + 2 * REWARDED_AD_ENERGY)
  })

  it('PERSISTS the caps on grant (checkpoint) so a refresh cannot reset them', () => {
    const session = new Session(4242)
    const save = vi.mocked(saveSession)
    save.mockClear() // ignore any construction-time save; watch the grant's checkpoint

    session.grantRewardedEnergy()

    // grantRewardedEnergy checkpoints, so the bumped counters are written into the persisted run —
    // adoptSession restores the whole RunState on resume, so a refresh reloads them (can't reset).
    expect(save).toHaveBeenCalled()
    const persisted = save.mock.calls.at(-1)![0]
    expect(persisted.run.rewardedAdsThisRun).toBe(1)
    expect(persisted.run.rewardedAdShiftIndex).toBe(session.snapshot().run.shiftIndex)
  })
})

