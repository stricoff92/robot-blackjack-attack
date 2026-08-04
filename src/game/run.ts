import { damageForRound } from './integrity'
import { handReward } from './rewards'
import { payout, type Round } from './round'

export const RULES_VERSION = 3
export const STARTING_CHIPS = 300
export const FULL_INTEGRITY = 100
// The run is won by destroying this many dealers; there is no dealer beyond it.
export const TOTAL_DEALERS = 6

export const DESTROY_TOKEN = 40

// A surviving hit pays tokens scaled by how risky it was: the base for a safe
// hit, climbing to base+bonus for a hit that was very likely to bust but landed
// anyway. Expected value stays modest — the riskier the hit, the rarer it
// survives to be paid — so this rewards nerve without inflating the economy.
export const HIT_TOKEN_BASE = 1
export const HIT_TOKEN_MAX_BONUS = 9

export function hitTokens(bustChance: number): number {
  const risk = Math.min(1, Math.max(0, bustChance))
  return HIT_TOKEN_BASE + Math.round(risk * HIT_TOKEN_MAX_BONUS)
}

const DESTRUCTION_SCORE_BASE = 150
const HAND_BET_STEP = 0.5
// On a kill, seed the next dealer's bankroll with this many of its minimum bets,
// so the escalating min-bet ladder stays survivable instead of starving the run.
const KILL_REWARD_RATIO = 3
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
  won: boolean
}

// Gentle ~1.6x/shift min-bet ladder: the floor climbs slowly enough that a flat
// bankroll (topped up by kill rewards) can keep pace. maxBet stays at 10x min.
const SHIFT_TABLE: readonly Shift[] = [
  { index: 1, minBet: 10, maxBet: 100, scoreMultiplier: 1.0 },
  { index: 2, minBet: 15, maxBet: 150, scoreMultiplier: 1.5 },
  { index: 3, minBet: 25, maxBet: 250, scoreMultiplier: 2.0 },
  { index: 4, minBet: 40, maxBet: 400, scoreMultiplier: 3.0 },
  { index: 5, minBet: 65, maxBet: 650, scoreMultiplier: 4.0 },
  { index: 6, minBet: 100, maxBet: 1000, scoreMultiplier: 5.5 },
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
    won: false,
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
  let won = false

  if (integrity <= 0) {
    tokens += DESTROY_TOKEN
    score += DESTRUCTION_SCORE_BASE * shiftIndex
    kills = [...kills, shiftIndex]
    shiftIndex += 1
    handsThisDealer = 0
    integrity = FULL_INTEGRITY
    if (kills.length >= TOTAL_DEALERS) {
      won = true
    } else {
      chips += KILL_REWARD_RATIO * getShift(shiftIndex).minBet
    }
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
    won,
    over: won || chips <= 0,
  }
}

// Reward tokens for the round, scaled by how each hand won (see rewards.ts). Hit
// tokens are credited live by the Session as each hit happens, so they aren't
// counted here.
function tokensForRound(round: Round): number {
  return round.hands.reduce((earned, hand) => earned + handReward(hand, round).tokens, 0)
}
