import { describe, expect, it } from 'vitest'

import type { Card, Rank, Suit } from './deck'
import { hit, stand, startRound } from './round'
import {
  abilitiesLocked,
  applyRound,
  cleanKillFactor,
  comboMultiplier,
  dealerHardHitCeiling,
  getShift,
  hitTokens,
  isLastCall,
  nextBet,
  powerupCost,
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
    expect(getShift(4)).toMatchObject({ minBet: 40, maxBet: 400, scoreMultiplier: 3 })
  })

  it('extrapolates prototype units beyond the table', () => {
    expect(getShift(7)).toMatchObject({ minBet: 375, maxBet: 3750, scoreMultiplier: 7, maxIntegrity: 265 })
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
    expect(nextBet(run0)).toBe(10)

    const run1 = applyRound(run0, standWin(10))
    expect(run1.handsThisDealer).toBe(1)
    expect(nextBet(run1)).toBe(15)
  })

  it('resets to the new dealer minimum after a destroy', () => {
    let run = startRun(1)
    while (run.shiftIndex === 1) {
      run = applyRound(run, beatTwentyWin(10))
    }

    expect(run.shiftIndex).toBe(2)
    expect(nextBet(run)).toBe(15)
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
  it('scales the floor percentage from 0% at dealer 1 to 20% at dealer 6', () => {
    expect(getShift(1).minBetPct).toBe(0)
    expect(getShift(6).minBetPct).toBe(0.2)
  })

  it('adds nothing on dealer 1, however fat the stack', () => {
    expect(nextBet({ ...startRun(1), chips: 5000 })).toBe(10) // ladder min, 0% floor
  })

  it('forces a bet worth 20% of a fat stack on dealer 6', () => {
    expect(nextBet({ ...startRun(1), shiftIndex: 6, chips: 4000 })).toBe(800) // max(150, 20% of 4000)
  })

  it('lets the wealth floor exceed the table max bet for the very rich', () => {
    expect(nextBet({ ...startRun(1), shiftIndex: 6, chips: 20000 })).toBe(4000) // 20% of 20000, above the 2500 max
  })

  it('falls back to the ladder min when the stack is small', () => {
    expect(nextBet({ ...startRun(1), shiftIndex: 6, chips: 300 })).toBe(150) // 20% of 300 = 60 < ladder min 150
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

    // Each +10 win, plus 3 x the Dealer 2 minimum (15) seeded on the kill.
    expect(run.shiftIndex).toBe(2)
    expect(run.chips).toBe(300 + hands * 10 + 3 * 15)
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
    expect(getShift(5).minBet).toBe(90)
    expect(getShift(6).minBet).toBe(150)
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

describe('win-streak combo (score)', () => {
  it('multiplies chip score on consecutive wins and tracks the streak', () => {
    let run = startRun(1) // dealer 1, score x1
    run = applyRound(run, standWin(10)) // win #1: +10 chips x mult 1.0 x combo 1.0
    expect(run.score).toBe(10)
    expect(run.winStreak).toBe(1)

    const afterFirst = run.score
    run = applyRound(run, standWin(10)) // win #2: combo x1.25 -> round(10 * 1.25) = 13
    expect(run.score - afterFirst).toBe(13)
    expect(run.winStreak).toBe(2)
  })

  it('resets the streak when the dealer wins a hand', () => {
    let run = startRun(1)
    run = applyRound(run, standWin(10))
    run = applyRound(run, standWin(10))
    expect(run.winStreak).toBe(2)
    run = applyRound(run, losingHand(10))
    expect(run.winStreak).toBe(0)
  })
})

describe('score helpers', () => {
  it('combo multiplier ramps a quarter per win and caps at x3', () => {
    expect(comboMultiplier(1)).toBe(1)
    expect(comboMultiplier(2)).toBe(1.25)
    expect(comboMultiplier(5)).toBe(2)
    expect(comboMultiplier(9)).toBe(3)
    expect(comboMultiplier(50)).toBe(3)
  })

  it('clean-kill factor decays from full to zero with losses', () => {
    expect(cleanKillFactor(0)).toBe(1)
    expect(cleanKillFactor(2)).toBeCloseTo(0.6)
    expect(cleanKillFactor(5)).toBe(0)
    expect(cleanKillFactor(9)).toBe(0)
  })
})

describe('clean-kill bonus', () => {
  it('pays a flawless kill a bigger bounty than a sloppy one', () => {
    // A dealer 1 hand from death; the incoming win destroys it. Same win, same combo,
    // so the only score difference is the clean-kill helping (base 150: full vs x0.4).
    const flawless = { ...startRun(1), integrity: 10, lossesThisDealer: 0 }
    const sloppy = { ...startRun(1), integrity: 10, lossesThisDealer: 3 }
    const fk = applyRound(flawless, beatTwentyWin(10))
    const sk = applyRound(sloppy, beatTwentyWin(10))
    expect(fk.score - sk.score).toBe(90) // 150 * 1.0 - round(150 * 0.4) = 150 - 60
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

  it('Token eco resists inflation — a maxed path halves the add', () => {
    const base = { ...startRun(1), integrity: 10, tokensThisShift: 78 }
    const none = applyRound(base, beatTwentyWin(10))
    const maxed = applyRound({ ...base, upgrades: { antiDealer: 0, chipEco: 0, tokenEco: 3 } }, beatTwentyWin(10))
    expect(none.tokenInflation).toBeCloseTo(0.07, 5)
    expect(maxed.tokenInflation).toBeCloseTo(0.035, 5) // x0.50 resistance (both hands cap the fraction)
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
