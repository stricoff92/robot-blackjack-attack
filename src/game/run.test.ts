import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { DEFAULT_ROUND_RULES, doubleDown, hit, lateDouble, stand, startRound, type HandOutcome, type PlayerHand, type Round } from './round'
import {
  abilitiesLocked,
  applyRound,
  comboGain,
  comboMultiplier,
  dealerHardHitCeiling,
  getShift,
  hitTokens,
  isLastCall,
  nextBet,
  powerupCost,
  spendTokens,
  startRun,
} from './run'

function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit }
}

function standWin(bet: number) {
  return stand(startRound([card('K'), card('Q'), card('10', 'hearts'), card('7')], bet))
}

function hitThenWin(bet: number) {
  return stand(hit(startRound([card('9'), card('2'), card('10', 'hearts'), card('7'), card('8')], bet)))
}

function natural(bet: number) {
  return startRound([card('A'), card('K'), card('10', 'hearts'), card('7')], bet)
}

function dealerBustWin(bet: number) {
  return stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('6'), card('10', 'hearts')], bet))
}

// Player 7+7, hit a 7 → a non-natural 21 over a standing dealer 20: the top damage
// tier, so a dealer falls in the fewest hands.
function beatTwentyWin(bet: number) {
  return stand(hit(startRound([card('7'), card('7'), card('10'), card('10', 'hearts'), card('7', 'hearts')], bet)))
}

function pushHand(bet: number) {
  return stand(startRound([card('K'), card('Q'), card('K', 'hearts'), card('Q', 'hearts')], bet))
}

function losingHand(bet: number) {
  return stand(startRound([card('9'), card('7'), card('K'), card('Q')], bet))
}

// A resolved multi-hand (split) round with the given per-hand outcomes, over a stood
// dealer 18 (so a 'win' hand grades to the beat-18 tier). Used to test the combo reset.
function resolvedSplit(outcomes: HandOutcome[], bet = 10): Round {
  const hands: PlayerHand[] = outcomes.map((outcome) => ({
    cards: [card('K'), card('9')],
    bet,
    doubled: false,
    splitAce: false,
    finished: true,
    busted: outcome === 'bust',
    outcome,
  }))
  return {
    shoe: [],
    drawIndex: 0,
    hands,
    activeIndex: hands.length - 1,
    dealer: [card('K'), card('8')], // stands on 18
    rules: DEFAULT_ROUND_RULES,
    status: 'resolved',
    secondChanceArmed: false,
    burned: null,
    dealerFrozen: false,
    mulliganed: false,
    discarded: [],
  }
}

// Player 5+6=11, free-doubles into a K for 21 over a standing dealer 17. The doubled
// bet means net chips = 2*bet.
function doubleWin(bet: number) {
  return doubleDown(startRound([card('5'), card('6'), card('10', 'hearts'), card('7'), card('K')], bet))
}

// Same 2*bet win, but reached via the paid Late double (hit 5+3 to 8, then late-double
// into a K for 21) — so it earns no free-double score boost.
function lateDoubleWin(bet: number) {
  return lateDouble(hit(startRound([card('5'), card('3'), card('10', 'hearts'), card('7'), card('3', 'hearts'), card('K')], bet)))
}

describe('startRun', () => {
  it('opens with the documented starting resources', () => {
    const run = startRun(1)

    expect(run.chips).toBe(300)
    expect(run.tokens).toBe(0)
    expect(run.integrity).toBe(100)
    expect(run.shiftIndex).toBe(1)
  })
})

describe('getShift', () => {
  it('reads the fixed ladder for early shifts', () => {
    expect(getShift(4)).toMatchObject({ minBet: 160, maxBet: 850, scoreMultiplier: 1.35 })
  })

  it('extrapolates prototype units beyond the table', () => {
    expect(getShift(7)).toMatchObject({ minBet: 1600, maxBet: 16000, scoreMultiplier: 3.2, maxIntegrity: 265 })
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

describe('comboGain', () => {
  it('nudges the combo by only the floor for a safe hit, more for a risky one', () => {
    expect(comboGain(0)).toBeCloseTo(0.01) // a 0%-risk (automatic) hit — near-nothing
    expect(comboGain(1)).toBeCloseTo(0.2) // a certain-bust hit that survived — the most
  })

  it('scales linearly with bust risk between the floor and the max', () => {
    expect(comboGain(0.5)).toBeCloseTo(0.01 + 0.5 * 0.19) // 0.105
    // A real gamble grows the combo far faster than a free safe hit.
    expect(comboGain(0.6)).toBeGreaterThan(comboGain(0) * 10)
  })

  it('clamps out-of-range odds', () => {
    expect(comboGain(-1)).toBeCloseTo(0.01)
    expect(comboGain(2)).toBeCloseTo(0.2)
  })
})

describe('applyRound token rewards', () => {
  it('pays the dealer-total tier for a win (here, a standing 17)', () => {
    expect(applyRound(startRun(1), standWin(10)).tokens).toBe(8)
  })

  it('does not re-count hits at settle, since they are credited live', () => {
    expect(applyRound(startRun(1), hitThenWin(10)).tokens).toBe(8)
  })

  it('grants twenty-one tokens for a blackjack', () => {
    expect(applyRound(startRun(1), natural(10)).tokens).toBe(21)
  })
})

describe('applyRound advancement', () => {
  it('only advances by destroying the dealer, and pays the destroy token', () => {
    let run = startRun(1)
    let hands = 0
    while (run.shiftIndex === 1) {
      run = applyRound(run, beatTwentyWin(10))
      hands += 1
    }

    expect(run.shiftIndex).toBe(2)
    expect(run.integrity).toBe(110) // dealer 2's max, not a flat 100
    expect(run.kills).toEqual([1])
    expect(run.tokens).toBe(hands * 22 + 40)
  })

  it('never advances a dealer that is not destroyed, no matter how many hands pass', () => {
    let run = startRun(1)
    for (let hand = 0; hand < 15; hand += 1) {
      run = applyRound(run, pushHand(10))
    }

    expect(run.shiftIndex).toBe(1)
    expect(run.integrity).toBe(100)
    expect(run.kills).toEqual([])
  })
})

describe('nextBet', () => {
  it('scales the fixed bet up as a dealer drags on', () => {
    const run0 = startRun(1)
    expect(nextBet(run0)).toBe(20)

    const run1 = applyRound(run0, standWin(10))
    expect(run1.handsThisDealer).toBe(1)
    expect(nextBet(run1)).toBe(30) // 20 x (1 + 0.5)
  })

  it('recomputes the bet for the new dealer after a destroy', () => {
    let run = startRun(1)
    while (run.shiftIndex === 1) {
      run = applyRound(run, beatTwentyWin(10))
    }

    // Dealer 1 dies in 2 beat-20 wins → chips 440. On Dealer 2 the ladder min is 40,
    // but the 10% wealth floor on 440 chips (44) now leads it.
    expect(run.shiftIndex).toBe(2)
    expect(run.chips).toBe(440)
    expect(nextBet(run)).toBe(44)
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

  it('extends heal-on-win down to dealer 5', () => {
    expect(getShift(4).healOnWin).toEqual([0, 0])
    expect(getShift(5).healOnWin).toEqual([5, 9])
    expect(getShift(6).healOnWin).toEqual([10, 15])
  })
})

describe('wealth-floor bet', () => {
  it('scales the floor percentage from 0% at dealer 1 to 25% at dealer 6', () => {
    expect(getShift(1).minBetPct).toBe(0)
    expect(getShift(6).minBetPct).toBe(0.25)
  })

  it('adds nothing on dealer 1, however fat the stack', () => {
    expect(nextBet({ ...startRun(1), chips: 5000 })).toBe(20) // ladder min, 0% floor
  })

  it('forces a bet worth 25% of a fat stack on dealer 6', () => {
    expect(nextBet({ ...startRun(1), shiftIndex: 6, chips: 4000 })).toBe(1000) // max(640, 25% of 4000)
  })

  it('lets the wealth floor exceed the table max bet for the very rich', () => {
    expect(nextBet({ ...startRun(1), shiftIndex: 6, chips: 20000 })).toBe(5000) // 25% of 20000, above the 2750 max
  })

  it('falls back to the ladder min when the stack is small', () => {
    expect(nextBet({ ...startRun(1), shiftIndex: 6, chips: 1000 })).toBe(640) // 25% of 1000 = 250 < ladder min 640
  })
})

describe('kill reward', () => {
  it('seeds the next dealer bankroll with 3x its minimum bet', () => {
    let run = startRun(1)
    let hands = 0
    while (run.shiftIndex === 1) {
      run = applyRound(run, beatTwentyWin(10))
      hands += 1
    }

    // Each +10 win, plus 3 x the Dealer 2 minimum (40) seeded on the kill.
    expect(run.shiftIndex).toBe(2)
    expect(run.chips).toBe(300 + hands * 10 + 3 * 40)
  })
})

describe('victory', () => {
  it('wins the run when the sixth dealer is destroyed and awards no further seed', () => {
    let run = startRun(1)
    while (!run.over) {
      run = applyRound(run, dealerBustWin(10))
    }

    expect(run.won).toBe(true)
    expect(run.over).toBe(true)
    expect(run.kills).toEqual([1, 2, 3, 4, 5, 6])
    expect(run.shiftIndex).toBe(7)
  })
})

describe('scaled dealer HP and late min bets', () => {
  it('climbs dealer integrity per shift, up to 220 at dealer 6', () => {
    expect(getShift(1).maxIntegrity).toBe(100)
    expect(getShift(4).maxIntegrity).toBe(150)
    expect(getShift(5).maxIntegrity).toBe(185)
    expect(getShift(6).maxIntegrity).toBe(220)
  })

  it('raises the late-dealer minimum bets', () => {
    expect(getShift(5).minBet).toBe(320)
    expect(getShift(6).minBet).toBe(640)
  })
})

describe('heal-on-win', () => {
  const atDealerSix = (integrity: number) => ({ ...startRun(1), shiftIndex: 6, integrity, chips: 1000 })

  it('repairs dealer 6 when it beats the player, within the shift range', () => {
    expect(applyRound(atDealerSix(100), losingHand(10), () => 0).integrity).toBe(110) // +10 (min)
    expect(applyRound(atDealerSix(100), losingHand(10), () => 0.999).integrity).toBe(115) // +15 (max)
  })

  it('never heals above the dealer max', () => {
    expect(applyRound(atDealerSix(218), losingHand(10), () => 0.999).integrity).toBe(220)
  })

  it('does not heal on a push, only on a dealer win', () => {
    expect(applyRound(atDealerSix(100), pushHand(10), () => 0).integrity).toBe(100)
  })

  it('leaves earlier dealers unhealed', () => {
    const run = { ...startRun(1), shiftIndex: 3, integrity: 50, chips: 1000 }
    expect(applyRound(run, losingHand(10), () => 0.999).integrity).toBe(50)
  })

  it('stops healing below 30% health (the endgame duel)', () => {
    // Dealer 6 max is 220; 30% = 66. At 66 it still heals, at 44 (20%) it does not.
    expect(applyRound(atDealerSix(66), losingHand(10), () => 0).integrity).toBe(76)
    expect(applyRound(atDealerSix(44), losingHand(10), () => 0.999).integrity).toBe(44)
  })
})

describe('Dealer 6 desperation', () => {
  const atFrac = (frac: number) => ({ ...startRun(1), shiftIndex: 6, integrity: Math.round(getShift(6).maxIntegrity * frac) })

  it('raises the hard-hit ceiling as the final dealer nears death', () => {
    expect(dealerHardHitCeiling(atFrac(0.5))).toBe(17)
    expect(dealerHardHitCeiling(atFrac(0.25))).toBe(18) // < 30%
    expect(dealerHardHitCeiling(atFrac(0.15))).toBe(19) // < 20%
    expect(dealerHardHitCeiling(atFrac(0.05))).toBe(20) // < 10%
    expect(dealerHardHitCeiling({ ...startRun(1), shiftIndex: 3, integrity: 5 })).toBe(17) // not the final dealer
  })

  it('locks token abilities below 20% health, final dealer only', () => {
    expect(abilitiesLocked(atFrac(0.25))).toBe(false)
    expect(abilitiesLocked(atFrac(0.15))).toBe(true)
    expect(abilitiesLocked({ ...startRun(1), shiftIndex: 5, integrity: 1 })).toBe(false)
  })
})

describe('combo multiplier on resolved hands (score)', () => {
  // `combo` is now the accumulated bonus fraction: 0.5 → x1.5, 1.0 → x2 (capped).
  it('multiplies a won hand chip score by the current combo', () => {
    const run = applyRound({ ...startRun(1), combo: 0.5 }, standWin(10)) // x1.5
    expect(run.score).toBe(15) // round(10 chips * mult 1.0 * combo 1.5)
  })

  it('multiplies the kill bounty by the current combo', () => {
    // A dealer 1 on exactly the damage a beat-17 win deals (22), so this win destroys it.
    // Bounty = 400 × dealer 1, x1.5 combo = 600; the +10 chip win adds
    // round(10 * 1.5) = 15 → 615.
    const nearDead = { ...startRun(1), integrity: 22, combo: 0.5 }
    const run = applyRound(nearDead, standWin(10))
    expect(run.kills).toEqual([1])
    expect(run.score).toBe(615)
  })

  it('keeps the combo on a won or pushed hand, wipes it on a lost hand', () => {
    const held = { ...startRun(1), combo: 0.4 }
    expect(applyRound(held, standWin(10)).combo).toBe(0.4) // a win holds the streak
    expect(applyRound(held, pushHand(10)).combo).toBe(0.4) // a push holds it (a wash, not a loss)
    // A stood-and-beaten hand wipes it — safe play earns no protection (no bust needed).
    expect(applyRound(held, losingHand(10)).combo).toBe(0)
  })

  it('on a split, resets the combo only when ALL hands lose', () => {
    const held = { ...startRun(1), combo: 0.4 }
    expect(applyRound(held, resolvedSplit(['lose', 'bust'])).combo).toBe(0) // every hand lost
    expect(applyRound(held, resolvedSplit(['lose', 'win'])).combo).toBe(0.4) // one win holds it
    expect(applyRound(held, resolvedSplit(['bust', 'push'])).combo).toBe(0.4) // a push holds it
  })
})

describe('free-double score boost', () => {
  it('pays a 1.5x score boost when a token-free double wins', () => {
    const run = applyRound(startRun(1), doubleWin(10)) // net 20 chips x mult 1.0 x combo 1.0 x 1.5
    expect(run.score).toBe(30)
    expect(run.chips).toBe(320)
  })

  it('does not boost a win from the paid Late double', () => {
    const run = applyRound(startRun(1), lateDoubleWin(10)) // same net 20 chips, no boost
    expect(run.score).toBe(20)
    expect(run.chips).toBe(320)
  })
})

describe('run stats (score screen)', () => {
  it('tallies wins, losses (pushes count as neither), and free-double wins', () => {
    let run = startRun(1)
    run = applyRound(run, standWin(10)) // win
    run = applyRound(run, doubleWin(10)) // free-double win
    run = applyRound(run, losingHand(10)) // loss
    run = applyRound(run, pushHand(10)) // push — neither

    expect(run.handsPlayed).toBe(4)
    expect(run.handsWon).toBe(2)
    expect(run.handsLost).toBe(1)
    expect(run.freeDoubleWins).toBe(1)
  })

  it('accumulates tokens spent (cumulative, never decreases)', () => {
    const run = { ...startRun(1), tokens: 100 }
    const after = spendTokens(spendTokens(run, 30), 20)
    expect(after.tokensSpent).toBe(50)
    expect(after.tokens).toBe(50)
  })
})

describe('score helpers', () => {
  it('combo multiplier is 1 + the accumulated bonus, capped at x2', () => {
    expect(comboMultiplier(0)).toBe(1) // no combo
    expect(comboMultiplier(0.1)).toBeCloseTo(1.1)
    expect(comboMultiplier(0.5)).toBeCloseTo(1.5)
    expect(comboMultiplier(1)).toBe(2) // cap
    expect(comboMultiplier(5)).toBe(2) // over cap
  })
})

describe('token inflation', () => {
  // beatTwentyWin at integrity 10 destroys the dealer (52 damage); that killing hand
  // adds 22 win tokens + 40 bounty = 62 to the shift's token tally. Preset the rest.
  it('adds a fraction of the shift cap based on the shift token earnings', () => {
    // 78 preset + 62 this hand = 140 = the Dealer 1 denom → the full 7% cap.
    const full = applyRound({ ...startRun(1), integrity: 10, tokensThisShift: 78 }, beatTwentyWin(10))
    expect(full.tokenInflation).toBeCloseTo(0.07, 5)
    expect(full.tokensThisShift).toBe(0) // reset for the next dealer
  })

  it('scales the add down when the shift earned less than the denom', () => {
    // 8 + 62 = 70 = half the 140 denom → half the cap.
    const half = applyRound({ ...startRun(1), integrity: 10, tokensThisShift: 8 }, beatTwentyWin(10))
    expect(half.tokenInflation).toBeCloseTo(0.035, 5)
  })

  it('does not inflate on the winning Dealer 6 kill', () => {
    const run = { ...startRun(1), shiftIndex: 6, integrity: 10, kills: [1, 2, 3, 4, 5], chips: 5000, tokensThisShift: 300 }
    const after = applyRound(run, beatTwentyWin(10))
    expect(after.won).toBe(true)
    expect(after.tokenInflation).toBe(0)
  })

  it('Token eco resists inflation — a maxed path cuts the add to ~a third', () => {
    const base = { ...startRun(1), integrity: 10, tokensThisShift: 78 }
    const none = applyRound(base, beatTwentyWin(10))
    const maxed = applyRound({ ...base, upgrades: { antiDealer: 0, chipEco: 0, tokenEco: 3 } }, beatTwentyWin(10))
    expect(none.tokenInflation).toBeCloseTo(0.07, 5)
    expect(maxed.tokenInflation).toBeCloseTo(0.0245, 5) // x0.35 resistance (both hands cap the fraction)
  })
})

describe('powerupCost', () => {
  it('inflates a base cost by the run inflation, rounded', () => {
    expect(powerupCost(60, { ...startRun(1), tokenInflation: 0 })).toBe(60)
    expect(powerupCost(60, { ...startRun(1), tokenInflation: 0.2 })).toBe(72)
    expect(powerupCost(50, { ...startRun(1), tokenInflation: 0.05 })).toBe(53) // round(52.5)
  })
})

describe('applyRound bust-out', () => {
  it('ends the run when chips reach zero', () => {
    const run = applyRound({ ...startRun(1), chips: 40 }, losingHand(40))

    expect(run.over).toBe(true)
    expect(run.chips).toBe(0)
  })
})

describe('isLastCall', () => {
  it('triggers when chips fall below the table minimum', () => {
    expect(isLastCall({ ...startRun(1), chips: 5 })).toBe(true)
  })
})
