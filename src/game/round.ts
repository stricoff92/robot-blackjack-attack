import type { Card } from './deck'
import { cardValue, evaluateHand, isBlackjack, isBust } from './hand'

export type RoundStatus = 'player-turn' | 'dealer-turn' | 'resolved'
export type HandOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust'

export interface RoundRules {
  dealerHitsSoft17: boolean
  blackjackPayoutNumerator: number
  blackjackPayoutDenominator: number
  allowSplit: boolean
  doubleWinBonusRatio: number
}

export const DEFAULT_ROUND_RULES: RoundRules = {
  dealerHitsSoft17: false,
  blackjackPayoutNumerator: 3,
  blackjackPayoutDenominator: 2,
  allowSplit: true,
  doubleWinBonusRatio: 0,
}

export interface PlayerHand {
  cards: Card[]
  bet: number
  doubled: boolean
  splitAce: boolean
  finished: boolean
  busted: boolean
  outcome: HandOutcome | null
}

export interface Round {
  shoe: Card[]
  drawIndex: number
  hands: PlayerHand[]
  activeIndex: number
  dealer: Card[]
  rules: RoundRules
  status: RoundStatus
  secondChanceArmed: boolean
  burned: Card | null
}

const MAX_HANDS = 4
const DEALER_STANDS_AT = 17

export function startRound(shoe: Card[], bet: number, rules: RoundRules = DEFAULT_ROUND_RULES): Round {
  const round: Round = {
    shoe,
    drawIndex: 4,
    hands: [newHand([shoe[0], shoe[1]], bet, false)],
    activeIndex: 0,
    dealer: [shoe[2], shoe[3]],
    rules,
    status: 'player-turn',
    secondChanceArmed: false,
    burned: null,
  }
  return resolveOpeningNaturals(round)
}

export function activeHand(round: Round): PlayerHand {
  const hand = round.hands[round.activeIndex]
  if (!hand) {
    throw new Error('no active hand')
  }
  return hand
}

export function canSplit(round: Round): boolean {
  if (round.status !== 'player-turn' || !round.rules.allowSplit) {
    return false
  }
  const hand = activeHand(round)
  if (hand.cards.length !== 2 || hand.splitAce || round.hands.length >= MAX_HANDS) {
    return false
  }
  return cardValue(hand.cards[0]) === cardValue(hand.cards[1])
}

export function canDouble(round: Round): boolean {
  return round.status === 'player-turn' && activeHand(round).cards.length === 2
}

export function isWinningHand(hand: PlayerHand): boolean {
  return hand.outcome === 'win' || hand.outcome === 'blackjack'
}

export function hit(round: Round): Round {
  requirePlayerTurn(round)
  if (round.secondChanceArmed) {
    return hitWithSecondChance(round)
  }
  const cards = [...activeHand(round).cards, round.shoe[round.drawIndex]]
  const drawn = withActiveCards(round, cards, round.drawIndex + 1)
  if (isBust(cards)) {
    return advanceHand(bustActive(drawn))
  }
  return drawn
}

export function stand(round: Round): Round {
  requirePlayerTurn(round)
  const hand = { ...activeHand(round), finished: true }
  return advanceHand(replaceHand(round, round.activeIndex, hand))
}

export function doubleDown(round: Round): Round {
  requirePlayerTurn(round)
  if (activeHand(round).cards.length !== 2) {
    throw new Error('can only double on the first two cards')
  }
  return applyDouble(round)
}

export function lateDouble(round: Round): Round {
  requirePlayerTurn(round)
  return applyDouble(round)
}

export function split(round: Round): Round {
  requirePlayerTurn(round)
  if (!canSplit(round)) {
    throw new Error('cannot split this hand')
  }
  const active = activeHand(round)
  const splittingAces = active.cards[0].rank === 'A'
  const handA = finalizeSplitHand(
    newHand([active.cards[0], round.shoe[round.drawIndex]], active.bet, splittingAces),
    splittingAces,
  )
  const handB = finalizeSplitHand(
    newHand([active.cards[1], round.shoe[round.drawIndex + 1]], active.bet, splittingAces),
    splittingAces,
  )
  const hands = round.hands.slice()
  hands.splice(round.activeIndex, 1, handA, handB)
  const afterSplit: Round = { ...round, hands, drawIndex: round.drawIndex + 2 }
  if (handA.finished) {
    return advanceHand(afterSplit)
  }
  return afterSplit
}

export function armSecondChance(round: Round): Round {
  requirePlayerTurn(round)
  return { ...round, secondChanceArmed: true }
}

export function payout(round: Round): number {
  return round.hands.reduce((total, hand) => total + handPayout(hand, round.rules), 0)
}

function newHand(cards: Card[], bet: number, splitAce: boolean): PlayerHand {
  return { cards, bet, doubled: false, splitAce, finished: false, busted: false, outcome: null }
}

function finalizeSplitHand(hand: PlayerHand, splittingAces: boolean): PlayerHand {
  const busted = isBust(hand.cards)
  if (splittingAces || busted) {
    return { ...hand, finished: true, busted, outcome: busted ? 'bust' : null }
  }
  return hand
}

function applyDouble(round: Round): Round {
  const active = activeHand(round)
  const cards = [...active.cards, round.shoe[round.drawIndex]]
  const busted = isBust(cards)
  const hand: PlayerHand = {
    ...active,
    cards,
    bet: active.bet * 2,
    doubled: true,
    finished: true,
    busted,
    outcome: busted ? 'bust' : null,
  }
  return advanceHand({ ...replaceHand(round, round.activeIndex, hand), drawIndex: round.drawIndex + 1 })
}

function hitWithSecondChance(round: Round): Round {
  const active = activeHand(round)
  const firstCard = round.shoe[round.drawIndex]
  const attempt = [...active.cards, firstCard]
  if (!isBust(attempt)) {
    return { ...withActiveCards(round, attempt, round.drawIndex + 1), secondChanceArmed: false }
  }
  const finalCards = [...active.cards, round.shoe[round.drawIndex + 1]]
  const busted = isBust(finalCards)
  const hand: PlayerHand = { ...active, cards: finalCards, finished: true, busted, outcome: busted ? 'bust' : null }
  const settled: Round = {
    ...replaceHand(round, round.activeIndex, hand),
    drawIndex: round.drawIndex + 2,
    secondChanceArmed: false,
    burned: firstCard,
  }
  return advanceHand(settled)
}

function withActiveCards(round: Round, cards: Card[], drawIndex: number): Round {
  const hand = { ...activeHand(round), cards }
  return { ...replaceHand(round, round.activeIndex, hand), drawIndex }
}

function bustActive(round: Round): Round {
  const hand: PlayerHand = { ...activeHand(round), busted: true, finished: true, outcome: 'bust' }
  return replaceHand(round, round.activeIndex, hand)
}

function replaceHand(round: Round, index: number, hand: PlayerHand): Round {
  const hands = round.hands.slice()
  hands[index] = hand
  return { ...round, hands }
}

function advanceHand(round: Round): Round {
  const nextIndex = round.hands.findIndex((hand) => !hand.finished)
  if (nextIndex === -1) {
    return finishPlayerTurns(round)
  }
  return { ...round, activeIndex: nextIndex }
}

function finishPlayerTurns(round: Round): Round {
  const anyLive = round.hands.some((hand) => !hand.busted)
  if (!anyLive) {
    return settleAgainstDealer({ ...round, status: 'resolved' })
  }
  return settleAgainstDealer(playDealer({ ...round, status: 'dealer-turn' }))
}

function playDealer(round: Round): Round {
  let dealer = round.dealer
  let drawIndex = round.drawIndex
  while (dealerShouldHit(dealer, round.rules)) {
    dealer = [...dealer, round.shoe[drawIndex]]
    drawIndex += 1
  }
  return { ...round, dealer, drawIndex }
}

function dealerShouldHit(dealer: Card[], rules: RoundRules): boolean {
  const value = evaluateHand(dealer)
  if (value.total < DEALER_STANDS_AT) {
    return true
  }
  return value.total === DEALER_STANDS_AT && value.soft && rules.dealerHitsSoft17
}

function settleAgainstDealer(round: Round): Round {
  const dealerTotal = evaluateHand(round.dealer).total
  const dealerBust = dealerTotal > 21
  const hands = round.hands.map((hand) => {
    if (hand.outcome) {
      return hand
    }
    if (hand.busted) {
      return { ...hand, finished: true, outcome: 'bust' as HandOutcome }
    }
    const outcome = judgeHand(evaluateHand(hand.cards).total, dealerTotal, dealerBust)
    return { ...hand, finished: true, outcome }
  })
  return { ...round, hands, status: 'resolved' }
}

function judgeHand(playerTotal: number, dealerTotal: number, dealerBust: boolean): HandOutcome {
  if (dealerBust || playerTotal > dealerTotal) {
    return 'win'
  }
  if (playerTotal < dealerTotal) {
    return 'lose'
  }
  return 'push'
}

function resolveOpeningNaturals(round: Round): Round {
  const player = round.hands[0]
  const playerNatural = isBlackjack(player.cards)
  const dealerNatural = isBlackjack(round.dealer)
  if (!playerNatural && !dealerNatural) {
    return round
  }
  const outcome: HandOutcome = playerNatural && dealerNatural ? 'push' : playerNatural ? 'blackjack' : 'lose'
  return { ...round, hands: [{ ...player, finished: true, outcome }], status: 'resolved' }
}

function handPayout(hand: PlayerHand, rules: RoundRules): number {
  const outcome = hand.outcome
  if (!outcome) {
    throw new Error('cannot compute payout before the hand resolves')
  }
  if (outcome === 'blackjack') {
    return Math.floor(hand.bet * (rules.blackjackPayoutNumerator / rules.blackjackPayoutDenominator))
  }
  if (outcome === 'win') {
    return Math.floor(hand.bet * (1 + (hand.doubled ? rules.doubleWinBonusRatio : 0)))
  }
  if (outcome === 'push') {
    return 0
  }
  return -hand.bet
}

function requirePlayerTurn(round: Round): void {
  if (round.status !== 'player-turn') {
    throw new Error('action is only allowed during the player turn')
  }
}
