import { damageForRound } from './integrity'
import { payout, type Round } from './round'

export const RULES_VERSION = 2
export const STARTING_CHIPS = 300
export const FULL_INTEGRITY = 100

export const HIT_TOKEN = 1
export const WIN_TOKEN = 10
export const BLACKJACK_TOKEN = 21
export const DESTROY_TOKEN = 40

const DESTRUCTION_SCORE_BASE = 150
const HAND_BET_STEP = 0.5
const PROTOTYPE_MIN_GROWTH = 2.5
const PROTOTYPE_MULTIPLIER_STEP = 1.5

export interface Shift {
  index: number
  minBet: number
  maxBet: number
  scoreMultiplier: number
}

export interface RunState {
  seed: number
  chips: number
  score: number
  tokens: number
  shiftIndex: number
  handsThisDealer: number
  handsPlayed: number
  integrity: number
  kills: number[]
  over: boolean
}

const SHIFT_TABLE: readonly Shift[] = [
  { index: 1, minBet: 10, maxBet: 100, scoreMultiplier: 1.0 },
  { index: 2, minBet: 25, maxBet: 250, scoreMultiplier: 1.5 },
  { index: 3, minBet: 60, maxBet: 600, scoreMultiplier: 2.0 },
  { index: 4, minBet: 150, maxBet: 1500, scoreMultiplier: 3.0 },
  { index: 5, minBet: 400, maxBet: 4000, scoreMultiplier: 4.0 },
  { index: 6, minBet: 1000, maxBet: 10000, scoreMultiplier: 5.5 },
]

export function startRun(seed: number): RunState {
  return {
    seed,
    chips: STARTING_CHIPS,
    score: 0,
    tokens: 0,
    shiftIndex: 1,
    handsThisDealer: 0,
    handsPlayed: 0,
    integrity: FULL_INTEGRITY,
    kills: [],
    over: false,
  }
}

export function getShift(index: number): Shift {
  if (index < 1) {
    throw new Error('shift index starts at 1')
  }
  const listed = SHIFT_TABLE[index - 1]
  if (listed) {
    return listed
  }
  const base = SHIFT_TABLE[SHIFT_TABLE.length - 1]
  const shiftsBeyond = index - base.index
  const minBet = Math.round(base.minBet * Math.pow(PROTOTYPE_MIN_GROWTH, shiftsBeyond))
  return {
    index,
    minBet,
    maxBet: minBet * 10,
    scoreMultiplier: base.scoreMultiplier + PROTOTYPE_MULTIPLIER_STEP * shiftsBeyond,
  }
}

// The player no longer chooses a bet. It scales with the dealer (via the min-bet ladder)
// and with how long the current dealer has dragged on, capped by the max and the bankroll.
export function nextBet(run: RunState): number {
  const shift = getShift(run.shiftIndex)
  const scaled = Math.round(shift.minBet * (1 + run.handsThisDealer * HAND_BET_STEP))
  return Math.min(scaled, shift.maxBet, run.chips)
}

export function isLastCall(run: RunState): boolean {
  return run.chips > 0 && run.chips < getShift(run.shiftIndex).minBet
}

export function addTokens(run: RunState, amount: number): RunState {
  return { ...run, tokens: run.tokens + amount }
}

export function spendTokens(run: RunState, amount: number): RunState {
  if (run.tokens < amount) {
    throw new Error('not enough tokens')
  }
  return { ...run, tokens: run.tokens - amount }
}

export function applyRound(run: RunState, round: Round): RunState {
  if (round.status !== 'resolved') {
    throw new Error('cannot apply an unresolved round')
  }
  const shift = getShift(run.shiftIndex)

  const net = payout(round)
  const chipsWon = Math.max(net, 0)
  let chips = run.chips + net
  let score = run.score + Math.round(chipsWon * shift.scoreMultiplier)
  let tokens = run.tokens + tokensForRound(round)

  let integrity = run.integrity - damageForRound(round)
  let shiftIndex = run.shiftIndex
  let handsThisDealer = run.handsThisDealer + 1
  let kills = run.kills

  if (integrity <= 0) {
    tokens += DESTROY_TOKEN
    score += DESTRUCTION_SCORE_BASE * shiftIndex
    kills = [...kills, shiftIndex]
    shiftIndex += 1
    handsThisDealer = 0
    integrity = FULL_INTEGRITY
  }

  return {
    ...run,
    chips,
    score,
    tokens,
    shiftIndex,
    handsThisDealer,
    handsPlayed: run.handsPlayed + 1,
    integrity,
    kills,
    over: chips <= 0,
  }
}

// Hit tokens are credited live by the Session as each hit happens, so they are not counted here.
function tokensForRound(round: Round): number {
  let earned = 0
  for (const hand of round.hands) {
    if (hand.outcome === 'blackjack') {
      earned += BLACKJACK_TOKEN
    } else if (hand.outcome === 'win') {
      earned += WIN_TOKEN
    }
  }
  return earned
}
