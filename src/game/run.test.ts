import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { hit, stand, startRound } from './round'
import {
  abilitiesLocked,
  applyRound,
  dealerHardHitCeiling,
  dealerUpcardReshuffleChance,
  getShift,
  hitTokens,
  powerupCost,
  spendTokens,
  startRun,
} from './run'

// The core NEW economy (weighted hits, the hand window, kill cash-in, the cumulative-win points
// curve, heals, doubles/splits, pushes, the D6 coda) is covered exhaustively in economy.test.ts.
// This file keeps the PERIPHERAL mechanics that survived the rework unchanged: the shift table, the
// dealer-upcard reshuffle guard, hit-token pricing, the token economy (rewards + inflation), the
// final-dealer desperation rules, and the cost/spend helpers.

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

// Player 20 over a standing dealer 17 — a plain beat-17 win (8 tokens).
function standWin() {
  return stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')]))
}

// Player 9+2, hit an 8 → 19 over a standing dealer 17 — a beat-17 win reached via a hit.
function hitThenWin() {
  return stand(hit(startRound([card('9'), card('2'), card('10', 'hearts'), card('7'), card('8')])))
}

// Player A+K — a natural blackjack (21 tokens).
function natural() {
  return startRound([card('A'), card('K'), card('10', 'hearts'), card('7')])
}

// Player 7+7, hit a 7 → a non-natural 21 over a standing dealer 20: the top token tier (22).
function beatTwentyWin() {
  return stand(hit(startRound([card('7'), card('7'), card('10'), card('10', 'hearts'), card('7', 'hearts')])))
}

describe('startRun', () => {
  it('opens with the documented starting resources', () => {
    const run = startRun(1)

    expect(run.tokens).toBe(100)
    expect(run.score).toBe(0)
    expect(run.wins).toBe(0)
    expect(run.integrity).toBe(getShift(1).maxHits) // full health = the dealer's hit count
    expect(run.shiftIndex).toBe(1)
  })
})

describe('getShift', () => {
  it('reads the fixed ladder for early shifts', () => {
    expect(getShift(4)).toMatchObject({ maxHits: 8, maxHands: 18, maxHeals: 0, dealerSoft17: 'hit' })
  })

  it('extrapolates prototype units beyond the table', () => {
    expect(getShift(7)).toMatchObject({ maxHits: 12, maxHands: 33, maxHeals: 3 })
  })
})

describe('dealerUpcardReshuffleChance', () => {
  it('suppresses the dealer 10/11 up-card only on the first three dealers', () => {
    expect(dealerUpcardReshuffleChance(1)).toBe(1) // never shows a 10/11
    expect(dealerUpcardReshuffleChance(2)).toBe(0.3)
    expect(dealerUpcardReshuffleChance(3)).toBe(0.15)
    expect(dealerUpcardReshuffleChance(4)).toBe(0) // fully unguarded from here on
    expect(dealerUpcardReshuffleChance(5)).toBe(0)
    expect(dealerUpcardReshuffleChance(6)).toBe(0)
  })

  it('keeps dev-jumped dealers past the table honest (never negative)', () => {
    expect(dealerUpcardReshuffleChance(7)).toBe(0)
    expect(dealerUpcardReshuffleChance(12)).toBe(0)
  })
})

describe('hitTokens', () => {
  it('pays the base for a risk-free hit and the max for a near-certain bust', () => {
    expect(hitTokens(0)).toBe(1)
    expect(hitTokens(1)).toBe(10)
  })

  it('scales up with the bust risk, monotonically', () => {
    expect(hitTokens(0.5)).toBe(6)
    expect(hitTokens(0.9)).toBe(9)
    let prev = 0
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const paid = hitTokens(p)
      expect(paid).toBeGreaterThanOrEqual(prev)
      prev = paid
    }
  })

  it('clamps out-of-range odds', () => {
    expect(hitTokens(-1)).toBe(1)
    expect(hitTokens(2)).toBe(10)
  })
})

describe('applyRound token rewards', () => {
  // Isolate the REWARD from the run's starting token balance by baselining to 0 tokens.
  const fromZero = () => ({ ...startRun(1), tokens: 0 })

  it('pays the dealer-total tier for a win (here, a standing 17)', () => {
    expect(applyRound(fromZero(), standWin()).tokens).toBe(8)
  })

  it('does not re-count hits at settle, since they are credited live', () => {
    expect(applyRound(fromZero(), hitThenWin()).tokens).toBe(8)
  })

  it('grants twenty-one tokens for a blackjack', () => {
    expect(applyRound(fromZero(), natural()).tokens).toBe(21)
  })
})

describe('late-dealer house rules', () => {
  it('sets the soft-17 rule per dealer: stand early, hit mid, smart on Dealer 6', () => {
    expect(getShift(2).dealerSoft17).toBe('stand')
    expect(getShift(3).dealerSoft17).toBe('hit')
    expect(getShift(4).dealerSoft17).toBe('hit')
    expect(getShift(5).dealerSoft17).toBe('hit')
    expect(getShift(6).dealerSoft17).toBe('smart')
  })

  it('gives the late dealers a heal budget (maxHeals), none before dealer 5', () => {
    expect(getShift(4).maxHeals).toBe(0)
    expect(getShift(5).maxHeals).toBe(2)
    expect(getShift(6).maxHeals).toBe(3)
  })
})

describe('Dealer 6 desperation', () => {
  // maxHits(6) = 10, so integrity IS the tenths of health: 2 = 20%, 1 = 10%.
  const d6 = (integrity: number) => ({ ...startRun(1), shiftIndex: 6, integrity })

  it('raises the hard-hit ceiling as the final dealer nears death', () => {
    expect(dealerHardHitCeiling(d6(10))).toBe(17) // full health
    expect(dealerHardHitCeiling(d6(2))).toBe(18) // 20% → below the 30% threshold
    expect(dealerHardHitCeiling(d6(1))).toBe(19) // 10% → below the 20% threshold
    expect(dealerHardHitCeiling({ ...startRun(1), shiftIndex: 3, integrity: 1 })).toBe(17) // not the final dealer
  })

  it('locks token abilities below 20% health, final dealer only', () => {
    expect(abilitiesLocked(d6(2))).toBe(false) // exactly 20% — not yet locked
    expect(abilitiesLocked(d6(1))).toBe(true) // 10% < 20%
    expect(abilitiesLocked({ ...startRun(1), shiftIndex: 5, integrity: 1 })).toBe(false) // not the final dealer
  })
})

describe('token inflation', () => {
  // A beat-20 win kills Dealer 1 at its last hit; that killing hand banks 22 win tokens + a
  // 40-token kill bounty toward the shift's inflation tally (Dealer 1 denom = 140).
  it('adds a fraction of the shift cap based on the shift token earnings', () => {
    // 78 preset + 22 + 40 = 140 = the denom → the full 7% cap.
    const full = applyRound({ ...startRun(1), integrity: 1, tokensThisShift: 78 }, beatTwentyWin())
    expect(full.tokenInflation).toBeCloseTo(0.07, 5)
    expect(full.tokensThisShift).toBe(0) // reset for the next dealer
  })

  it('scales the add down when the shift earned less than the denom', () => {
    // 8 + 22 + 40 = 70 = half the 140 denom → half the cap.
    const half = applyRound({ ...startRun(1), integrity: 1, tokensThisShift: 8 }, beatTwentyWin())
    expect(half.tokenInflation).toBeCloseTo(0.035, 5)
  })

  it('does not inflate on the Dealer 6 kill (which enters the coda)', () => {
    const run = { ...startRun(1), shiftIndex: 6, integrity: 1, kills: [1, 2, 3, 4, 5], tokensThisShift: 300 }
    const after = applyRound(run, beatTwentyWin())
    expect(after.coda).toBe(true)
    expect(after.tokenInflation).toBe(0)
  })

  it('Token eco resists inflation — a maxed path cuts the add to ~a third', () => {
    const base = { ...startRun(1), integrity: 1, tokensThisShift: 78 }
    const none = applyRound(base, beatTwentyWin())
    const maxed = applyRound({ ...base, upgrades: { antiDealer: 0, chipEco: 0, tokenEco: 3 } }, beatTwentyWin())
    expect(none.tokenInflation).toBeCloseTo(0.07, 5)
    expect(maxed.tokenInflation).toBeCloseTo(0.0245, 5) // ×0.35 resistance (both hands cap the fraction)
  })
})

describe('powerupCost', () => {
  it('inflates a base cost by the run inflation, rounded', () => {
    expect(powerupCost(60, { ...startRun(1), tokenInflation: 0 })).toBe(60)
    expect(powerupCost(60, { ...startRun(1), tokenInflation: 0.2 })).toBe(72)
    expect(powerupCost(50, { ...startRun(1), tokenInflation: 0.05 })).toBe(53) // round(52.5)
  })
})

describe('spendTokens', () => {
  it('accumulates tokens spent (cumulative, never decreases)', () => {
    const run = { ...startRun(1), tokens: 100 }
    const after = spendTokens(spendTokens(run, 30), 20)
    expect(after.tokensSpent).toBe(50)
    expect(after.tokens).toBe(50)
  })
})
