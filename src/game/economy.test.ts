import { describe, expect, it } from 'vitest'
import type { Card } from './deck'
import {
  DEFAULT_ROUND_RULES,
  handWeight,
  isRedealRound,
  roundTally,
  type HandOutcome,
  type PlayerHand,
  type Round,
} from './round'
import {
  applyRound,
  basePoints,
  getShift,
  HEART_KILL_HEAL,
  heartsAfterRound,
  MAX_HEARTS,
  POINTS_BASE,
  POINTS_GROWTH,
  startRun,
  winPointDeltas,
  type RunState,
} from './run'

function card(rank: Card['rank'], suit: Card['suit'] = 'spades'): Card {
  return { rank, suit }
}

function hand(outcome: HandOutcome, opts: Partial<PlayerHand> = {}): PlayerHand {
  return {
    cards: [card('10'), card('7')],
    bet: 1,
    doubled: false,
    splitAce: false,
    finished: true,
    busted: outcome === 'bust',
    outcome,
    ...opts,
  }
}

// A resolved round with the given hand outcomes; the dealer stands on 17 so wins grade as beat-17.
function resolved(hands: PlayerHand[], dealer: Card[] = [card('10'), card('7')]): Round {
  return {
    shoe: [],
    drawIndex: 0,
    hands,
    activeIndex: 0,
    dealer,
    rules: DEFAULT_ROUND_RULES,
    status: 'resolved',
    secondChanceArmed: false,
    burned: null,
    dealerFrozen: false,
    mulliganed: false,
    discarded: [],
  }
}

function baseRun(overrides: Partial<RunState> = {}): RunState {
  return { ...startRun(1), ...overrides }
}

// Sum of the base points for the win ordinals lo..hi inclusive.
function scoreForWins(lo: number, hi: number): number {
  let sum = 0
  for (let n = lo; n <= hi; n += 1) {
    sum += Math.round(basePoints(n))
  }
  return sum
}

describe('points curve', () => {
  it('starts at POINTS_BASE and grows by POINTS_GROWTH per win', () => {
    expect(basePoints(1)).toBe(POINTS_BASE)
    expect(basePoints(2)).toBeCloseTo(POINTS_BASE * POINTS_GROWTH, 10)
    expect(basePoints(20)).toBeCloseTo(10 * Math.pow(1.12, 19), 6)
  })
})

describe('round helpers', () => {
  it('handWeight is 2 for a doubled hand, else 1', () => {
    expect(handWeight(hand('win'))).toBe(1)
    expect(handWeight(hand('win', { doubled: true }))).toBe(2)
  })

  it('roundTally weights wins/losses and skips pushes', () => {
    const t = roundTally(resolved([hand('win'), hand('lose'), hand('push')]))
    expect(t).toEqual({ hits: 1, losses: 1, slots: ['win', 'loss'] })
    const d = roundTally(resolved([hand('win', { doubled: true })]))
    expect(d).toEqual({ hits: 2, losses: 0, slots: ['win', 'win'] })
  })

  it('isRedealRound only when every hand pushed/voided', () => {
    expect(isRedealRound(resolved([hand('push')]))).toBe(true)
    expect(isRedealRound(resolved([hand('push'), hand('voided')]))).toBe(true)
    expect(isRedealRound(resolved([hand('push'), hand('win')]))).toBe(false)
    expect(isRedealRound(resolved([hand('win')]))).toBe(false)
  })
})

describe('winPointDeltas — per-green-check deltas', () => {
  it('one delta per winning slot, summing to the score gain', () => {
    const run = baseRun()
    const round = resolved([hand('win')])
    const deltas = winPointDeltas(run, round)
    expect(deltas).toEqual([Math.round(basePoints(1))])
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(applyRound(run, round).score - run.score)
  })

  it('a doubled win banks two ascending deltas at the next two ordinals', () => {
    const run = baseRun({ wins: 5 })
    expect(winPointDeltas(run, resolved([hand('win', { doubled: true })]))).toEqual([
      Math.round(basePoints(6)),
      Math.round(basePoints(7)),
    ])
  })

  it('WINDOW-CLAMPS a double win on the last open slot to ONE hit / point-win', () => {
    const maxHands = getShift(1).maxHands // dealer 1
    const run = baseRun({ handsThisDealer: maxHands - 1, integrity: 5, wins: 3 })
    const round = resolved([hand('win', { doubled: true })]) // weight 2, but only 1 window slot left
    expect(winPointDeltas(run, round)).toEqual([Math.round(basePoints(4))]) // ONE delta, not two
    const next = applyRound(run, round)
    expect(next.wins).toBe(run.wins + 1) // one win banked
    expect(next.score - run.score).toBe(Math.round(basePoints(4)))
    expect(next.integrity).toBeGreaterThan(0) // only 1 damage → dealer survives (window then runs out)
  })

  it('excludes losses and pushes — a green check only', () => {
    const run = baseRun()
    expect(winPointDeltas(run, resolved([hand('win'), hand('lose'), hand('push')]))).toEqual([
      Math.round(basePoints(run.wins + 1)),
    ])
  })

  it('a kill cashes in every remaining window slot as ascending bonus deltas', () => {
    const run = baseRun({ integrity: 1, handsThisDealer: 3 })
    const round = resolved([hand('win')])
    const deltas = winPointDeltas(run, round)
    const maxHands = getShift(run.shiftIndex).maxHands
    expect(deltas.length).toBe(1 + (maxHands - (3 + 1))) // the win + the cashed-in remainder
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(applyRound(run, round).score - run.score)
    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i]).toBeGreaterThanOrEqual(deltas[i - 1]) // ascending
    }
  })
})

describe('applyRound — hits & scoring', () => {
  it('a win lands 1 hit, banks 1 win, scores basePoints(1)', () => {
    const next = applyRound(baseRun(), resolved([hand('win')]))
    expect(next.integrity).toBe(getShift(1).maxHits - 1)
    expect(next.wins).toBe(1)
    expect(next.score).toBe(scoreForWins(1, 1))
    expect(next.handsThisDealer).toBe(1)
    expect(next.handLog).toEqual(['win'])
  })

  it('a double win lands 2 hits and banks 2 wins', () => {
    const next = applyRound(baseRun(), resolved([hand('win', { doubled: true })]))
    expect(next.integrity).toBe(getShift(1).maxHits - 2)
    expect(next.wins).toBe(2)
    expect(next.score).toBe(scoreForWins(1, 2))
    expect(next.handsThisDealer).toBe(2)
    expect(next.handLog).toEqual(['win', 'win'])
  })

  it('a split of one win + one loss banks 1 win and 1 loss slot', () => {
    const next = applyRound(baseRun(), resolved([hand('win'), hand('lose')]))
    expect(next.wins).toBe(1)
    expect(next.handsThisDealer).toBe(2)
    expect(next.handLog).toEqual(['win', 'loss'])
    expect(next.integrity).toBe(getShift(1).maxHits - 1)
  })

  it('a win scores exactly the base points — no hit/combo multiplier', () => {
    const next = applyRound(baseRun(), resolved([hand('win')]))
    expect(next.score).toBe(basePoints(1)) // POINTS_BASE, no multiplier applied
  })

  it('Payout T1 gives a natural blackjack +50% points', () => {
    const run = baseRun({ upgrades: { antiDealer: 0, chipEco: 1, tokenEco: 0 } })
    const next = applyRound(run, resolved([hand('blackjack')]))
    expect(next.score).toBe(Math.round(basePoints(1) * 1.5))
  })

  // Sabotage T1 now pays a flat +20 ENERGY on any dealer 21 (not a points consolation), credited in
  // Session.settle_ rather than applyRound — see session.test.ts for its coverage.
})

describe('applyRound — window & kill', () => {
  it('a kill cashes in every remaining window slot as bonus wins', () => {
    const run = baseRun({ integrity: 1, handsThisDealer: 3 })
    const next = applyRound(run, resolved([hand('win')]))
    const maxHands = getShift(1).maxHands
    const remaining = maxHands - (3 + 1) // slots used after this hand
    expect(next.kills).toEqual([1])
    expect(next.shiftIndex).toBe(2)
    expect(next.integrity).toBe(getShift(2).maxHits)
    expect(next.handsThisDealer).toBe(0)
    expect(next.handLog).toEqual([])
    expect(next.wins).toBe(1 + remaining)
    expect(next.score).toBe(scoreForWins(1, 1 + remaining))
  })

  it('running out the window walks the dealer off with no kill and no upgrade advance', () => {
    const run = baseRun({ integrity: 3, handsThisDealer: getShift(1).maxHands - 1 })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.kills).toEqual([]) // no kill
    expect(next.shiftIndex).toBe(2)
    expect(next.integrity).toBe(getShift(2).maxHits)
    expect(next.handsThisDealer).toBe(0)
    expect(next.coda).toBe(false)
  })

  it('killing Dealer 6 enters the banker coda', () => {
    const run = baseRun({ shiftIndex: 6, integrity: 1, kills: [1, 2, 3, 4, 5] })
    const next = applyRound(run, resolved([hand('win')]))
    expect(next.kills).toEqual([1, 2, 3, 4, 5, 6])
    expect(next.coda).toBe(true)
  })

  it('running out Dealer 6 window also enters the coda (banker always comes out)', () => {
    const run = baseRun({ shiftIndex: 6, integrity: 5, handsThisDealer: getShift(6).maxHands - 1, kills: [1, 2, 3, 4, 5] })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.coda).toBe(true)
    expect(next.kills).toEqual([1, 2, 3, 4, 5]) // no kill credited
  })
})

describe('applyRound — heals', () => {
  it('a late dealer claws back 1 hit on a lost hand, within its heal budget', () => {
    const run = baseRun({ shiftIndex: 5, integrity: 4, healsThisDealer: 0 })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.integrity).toBe(5)
    expect(next.healsThisDealer).toBe(1)
  })

  it('never heals off the last hit', () => {
    const run = baseRun({ shiftIndex: 5, integrity: 1, healsThisDealer: 0 })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.integrity).toBe(1)
    expect(next.healsThisDealer).toBe(0)
  })

  it('stops healing once the budget is spent', () => {
    const run = baseRun({ shiftIndex: 5, integrity: 4, healsThisDealer: getShift(5).maxHeals })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.integrity).toBe(4)
  })
})

describe('player hearts — heartsAfterRound', () => {
  const win = () => resolved([hand('win')])
  const loss = () => resolved([hand('lose')])

  it('pops a heart on a losing round, floored at zero', () => {
    expect(heartsAfterRound(5, [], loss()).hitPoints).toBe(4)
    expect(heartsAfterRound(1, [], loss()).hitPoints).toBe(0)
    expect(heartsAfterRound(0, [], loss()).hitPoints).toBe(0)
  })

  it('a plain win heals only with a recent win in the lookback window', () => {
    expect(heartsAfterRound(3, [true], win()).hitPoints).toBe(4) // last round won → streak heal
    expect(heartsAfterRound(3, [false], win()).hitPoints).toBe(3) // last round lost → no heal
    expect(heartsAfterRound(3, [], win()).hitPoints).toBe(3) // no history → no heal
  })

  it('buffed lookback: a win heals if EITHER of the last two rounds won (survives a W-L-W)', () => {
    expect(heartsAfterRound(3, [true, false], win()).hitPoints).toBe(4) // a win two rounds back still counts
    expect(heartsAfterRound(3, [false, false], win()).hitPoints).toBe(3) // neither of the last two won → no heal
  })

  it('a natural or hijacked blackjack always heals, even stone cold', () => {
    expect(heartsAfterRound(2, [false, false], resolved([hand('win')]), false)).toMatchObject({ hitPoints: 2 }) // cold win, no heal
    expect(heartsAfterRound(2, [false, false], resolved([hand('blackjack')])).hitPoints).toBe(3)
  })

  it('beating a dealer (a kill) heals HEART_KILL_HEAL, superseding the per-win streak heal', () => {
    // killed=true → the bigger kill heal regardless of streak; killed=false + cold win → no heal.
    expect(heartsAfterRound(3, [], resolved([hand('win')]), true).hitPoints).toBe(3 + HEART_KILL_HEAL)
    expect(heartsAfterRound(3, [], resolved([hand('win')]), false).hitPoints).toBe(3)
  })

  it('a double-win (both split hands) always heals, even stone cold', () => {
    expect(heartsAfterRound(2, [false, false], resolved([hand('win'), hand('win')])).hitPoints).toBe(3)
  })

  it('a split with a single win heals only on a prior win (a plain win, not a double)', () => {
    const splitOneWin = () => resolved([hand('win'), hand('lose')])
    expect(heartsAfterRound(3, [true], splitOneWin()).hitPoints).toBe(4)
    expect(heartsAfterRound(3, [false], splitOneWin()).hitPoints).toBe(3)
  })

  it('never heals above MAX_HEARTS', () => {
    expect(heartsAfterRound(MAX_HEARTS, [true], win()).hitPoints).toBe(MAX_HEARTS)
    expect(heartsAfterRound(MAX_HEARTS, [], resolved([hand('blackjack')])).hitPoints).toBe(MAX_HEARTS)
  })

  it('an all-push wash leaves hearts and the streak history untouched', () => {
    const r = heartsAfterRound(3, [true], resolved([hand('push'), hand('push')]))
    expect(r.hitPoints).toBe(3)
    expect(r.roundWins).toEqual([true])
  })

  it('records each scored round, capping the history to the lookback window', () => {
    expect(heartsAfterRound(3, [], win()).roundWins).toEqual([true])
    expect(heartsAfterRound(3, [true], loss()).roundWins).toEqual([true, false])
    expect(heartsAfterRound(3, [false, true], loss()).roundWins).toEqual([true, false]) // oldest falls off
  })
})

describe('player hearts — applyRound integration', () => {
  it('decrements hitPoints on a loss and opens the coda when they run out', () => {
    let run = baseRun({ hitPoints: 2 })
    run = applyRound(run, resolved([hand('lose')]))
    expect(run.hitPoints).toBe(1)
    expect(run.coda).toBe(false)
    run = applyRound(run, resolved([hand('lose')]))
    expect(run.hitPoints).toBe(0)
    expect(run.coda).toBe(true) // bled out → the coda begins early
  })

  it('a qualifying win heals a spent heart', () => {
    const run = baseRun({ hitPoints: 3, roundWins: [true] })
    expect(applyRound(run, resolved([hand('win')])).hitPoints).toBe(4)
  })

  it('a killing win heals HEART_KILL_HEAL, even off a cold streak', () => {
    const run = baseRun({ hitPoints: 3, integrity: 1, roundWins: [] }) // the win drops the dealer to 0
    const next = applyRound(run, resolved([hand('win')]))
    expect(next.kills).toEqual([1]) // dealer beaten
    expect(next.hitPoints).toBe(3 + HEART_KILL_HEAL)
  })

  it('a heart-death keeps the current dealer and never touches the score', () => {
    const run = baseRun({ hitPoints: 1, shiftIndex: 3, integrity: getShift(3).maxHits, score: 500 })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.hitPoints).toBe(0)
    expect(next.coda).toBe(true)
    expect(next.shiftIndex).toBe(3) // the dealer walks off into the coda — no advance
    expect(next.score).toBe(500) // no penalty
  })

  it('a fatal loss on the last window slot enters the coda instead of a window-out advance', () => {
    // Both a window-out AND a heart-death would fire — the heart-death takes precedence.
    const run = baseRun({ hitPoints: 1, integrity: 3, handsThisDealer: getShift(1).maxHands - 1 })
    const next = applyRound(run, resolved([hand('lose')]))
    expect(next.hitPoints).toBe(0)
    expect(next.coda).toBe(true)
    expect(next.shiftIndex).toBe(1) // did NOT advance to dealer 2
  })
})
