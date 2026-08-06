import type { Card } from './deck'
import { cardValue, evaluateHand, isBlackjack, isBust } from './hand'

export type RoundStatus = 'player-turn' | 'dealer-turn' | 'resolved'
export type HandOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust'

// How the dealer plays a soft 17: 'stand' (S17, the friendly default), 'hit' (H17 —
// always draws), or 'smart' (draws only when it isn't already beating the player —
// see dealerShouldHit). Set per dealer in run.ts's SHIFT_TABLE.
export type Soft17Rule = 'stand' | 'hit' | 'smart'

export interface RoundRules {
  /** The dealer's soft-17 play rule for this round (per dealer, see run.ts). */
  dealerSoft17: Soft17Rule
  /** The highest HARD total the 'smart' dealer will hit when strictly behind (17 for a
   *  healthy dealer; Dealer 6 raises it toward 20 as it nears death — see run.ts). */
  dealerHardHitCeiling: number
  blackjackPayoutNumerator: number
  blackjackPayoutDenominator: number
  allowSplit: boolean
  doubleWinBonusRatio: number
  // Roguelite upgrades (see game/upgrades.ts), folded in per-round at the deal.
  // Player total that instantly resolves the hand as a natural blackjack — the
  // dealer draws nothing (a dealt dealer natural pushes, else it's a win). null
  // disables it. Chip eco T2 = 21, T3 = 20.
  autoBlackjackAt: number | null
  // Anti-dealer T3: the dealer's standing total counts as one lower when under 21.
  dealerDowngrade: boolean
  // Anti-dealer T2: a dealt dealer natural is stolen — the player takes the win.
  hijackDealerNatural: boolean
  // Anti-dealer T1: fraction of the bet refunded on a loss to a dealer natural.
  dealerNaturalRefundRatio: number
  // Token eco: multiplier applied to every token reward this round.
  tokenMultiplier: number
}

export const DEFAULT_ROUND_RULES: RoundRules = {
  dealerSoft17: 'stand',
  dealerHardHitCeiling: 17,
  blackjackPayoutNumerator: 3,
  blackjackPayoutDenominator: 2,
  allowSplit: true,
  doubleWinBonusRatio: 0,
  autoBlackjackAt: null,
  dealerDowngrade: false,
  hijackDealerNatural: false,
  dealerNaturalRefundRatio: 0,
  tokenMultiplier: 1,
}

export interface PlayerHand {
  cards: Card[]
  bet: number
  doubled: boolean
  splitAce: boolean
  finished: boolean
  busted: boolean
  outcome: HandOutcome | null
  // Set when this hand's loss was to a dealer natural, so the Anti-dealer T1
  // refund (rules.dealerNaturalRefundRatio) can pay part of the bet back.
  lostToDealerNatural?: boolean
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
  dealerFrozen: boolean
  mulliganed: boolean
  // Cards permanently out of play but seen by the player (mulligan-discarded
  // opening hands). Known, spent, and no longer drawable — the odds exclude them.
  discarded: Card[]
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
    dealerFrozen: false,
    mulliganed: false,
    discarded: [],
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
  if (reachesAutoBlackjack(cards, round.rules)) {
    return advanceHand(settlePlayerBlackjack(drawn, drawn.activeIndex))
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
  return applySplit(round)
}

// Forced split (paid powerup): splits the opening two cards even when they are
// not a matching pair. Same gate as a normal split minus the equal-value
// requirement, so an opening hand of two cards that hasn't been hit can always
// be broken into two hands.
export function canForcedSplit(round: Round): boolean {
  if (round.status !== 'player-turn' || !round.rules.allowSplit) {
    return false
  }
  const hand = activeHand(round)
  return hand.cards.length === 2 && !hand.splitAce && round.hands.length < MAX_HANDS
}

export function forcedSplit(round: Round): Round {
  requirePlayerTurn(round)
  if (!canForcedSplit(round)) {
    throw new Error('cannot force split this hand')
  }
  return applySplit(round)
}

function applySplit(round: Round): Round {
  const active = activeHand(round)
  // The one-card-each ace rule only applies to a genuine pair of aces. A forced
  // split of, say, A+7 makes two ordinary hands that each play on normally.
  const splittingAces = active.cards[0].rank === 'A' && active.cards[1].rank === 'A'
  const handA = finalizeSplitHand(
    newHand([active.cards[0], round.shoe[round.drawIndex]], active.bet, splittingAces),
    splittingAces,
    round,
  )
  const handB = finalizeSplitHand(
    newHand([active.cards[1], round.shoe[round.drawIndex + 1]], active.bet, splittingAces),
    splittingAces,
    round,
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

export function freezeDealer(round: Round): Round {
  requirePlayerTurn(round)
  return { ...round, dealerFrozen: true }
}

// Mulligan only applies to an untouched opening hand: a single hand of exactly
// two cards that hasn't been hit, doubled, or split. Once per round.
export function canMulligan(round: Round): boolean {
  if (round.status !== 'player-turn' || round.mulliganed || round.hands.length !== 1) {
    return false
  }
  const hand = activeHand(round)
  return hand.cards.length === 2 && !hand.doubled && !hand.finished
}

export function mulligan(round: Round): Round {
  requirePlayerTurn(round)
  if (!canMulligan(round)) {
    throw new Error('cannot mulligan this hand')
  }
  const active = activeHand(round)
  const cards = [round.shoe[round.drawIndex], round.shoe[round.drawIndex + 1]]
  const redealt: Round = {
    ...replaceHand(round, round.activeIndex, newHand(cards, active.bet, false)),
    drawIndex: round.drawIndex + 2,
    mulliganed: true,
    // The tossed opening cards are now spent + known; keep them out of the shoe odds.
    discarded: [...round.discarded, ...active.cards],
  }
  // The dealer can't hold a natural here (that resolves the round at the deal, so
  // we'd never reach player-turn), but the fresh hand still can — honor it.
  return resolveOpeningNaturals(redealt)
}

// Return: available once the active hand has taken at least one hit (more than
// two cards). Pops the most recently drawn card back onto the top of the shoe —
// drawIndex steps back one, so shoe[drawIndex] is that card again and the
// dealer's next hit draws it (there's no burn between the player and dealer
// phases). Then auto-stands: re-hitting would only pull the same card straight
// back, so standing on the lower total is the only sensible follow-up.
export function canReturn(round: Round): boolean {
  return round.status === 'player-turn' && activeHand(round).cards.length > 2
}

export function returnCard(round: Round): Round {
  requirePlayerTurn(round)
  if (!canReturn(round)) {
    throw new Error('cannot return a card from this hand')
  }
  const active = activeHand(round)
  const hand: PlayerHand = { ...active, cards: active.cards.slice(0, -1), finished: true }
  return advanceHand({ ...replaceHand(round, round.activeIndex, hand), drawIndex: round.drawIndex - 1 })
}

export function payout(round: Round): number {
  return round.hands.reduce((total, hand) => total + handPayout(hand, round.rules), 0)
}

// Net chips won (+) or lost (-) on a single settled hand — used to label each
// hand's result, so split hands each show their own win/loss.
export function handNet(hand: PlayerHand, rules: RoundRules): number {
  return handPayout(hand, rules)
}

// Chip eco T2/T3 (see reachesAutoBlackjack): whether this hand was lifted to a
// natural blackjack by reaching the auto-blackjack total — as opposed to being
// dealt a genuine two-card 21, which needs no upgrade. Used to badge the score.
export function isHandUpgraded(hand: PlayerHand, rules: RoundRules): boolean {
  return reachesAutoBlackjack(hand.cards, rules) && !isBlackjack(hand.cards)
}

function newHand(cards: Card[], bet: number, splitAce: boolean): PlayerHand {
  return { cards, bet, doubled: false, splitAce, finished: false, busted: false, outcome: null }
}

function finalizeSplitHand(hand: PlayerHand, splittingAces: boolean, round: Round): PlayerHand {
  const busted = isBust(hand.cards)
  if (busted) {
    return { ...hand, finished: true, busted: true, outcome: 'bust' }
  }
  // A split half that lands on the auto-blackjack total locks as a natural right
  // away (dealer natural pushes it), just like it would on the main hand.
  if (reachesAutoBlackjack(hand.cards, round.rules)) {
    return { ...hand, finished: true, outcome: playerBlackjackOutcome(round) }
  }
  if (splittingAces) {
    return { ...hand, finished: true, busted: false, outcome: null }
  }
  return hand
}

function applyDouble(round: Round): Round {
  const active = activeHand(round)
  const cards = [...active.cards, round.shoe[round.drawIndex]]
  const busted = isBust(cards)
  // A double that lands on the auto-blackjack total resolves as a natural (on the
  // doubled bet); otherwise it stands, finished, to be judged against the dealer.
  const outcome: HandOutcome | null = busted
    ? 'bust'
    : reachesAutoBlackjack(cards, round.rules)
      ? playerBlackjackOutcome(round)
      : null
  const hand: PlayerHand = {
    ...active,
    cards,
    bet: active.bet * 2,
    doubled: true,
    finished: true,
    busted,
    outcome,
  }
  return advanceHand({ ...replaceHand(round, round.activeIndex, hand), drawIndex: round.drawIndex + 1 })
}

function hitWithSecondChance(round: Round): Round {
  const active = activeHand(round)
  const firstCard = round.shoe[round.drawIndex]
  const attempt = [...active.cards, firstCard]
  if (!isBust(attempt)) {
    const survived: Round = { ...withActiveCards(round, attempt, round.drawIndex + 1), secondChanceArmed: false }
    if (reachesAutoBlackjack(attempt, round.rules)) {
      return advanceHand(settlePlayerBlackjack(survived, survived.activeIndex))
    }
    return survived
  }
  // The hit would bust, so the shield burns it and tries one replacement. If the
  // replacement keeps the hand alive you stand on it; if it would ALSO bust, the
  // shield absorbs the whole thing and you stand on your current total. Either
  // way the hand never busts — that's the point of the shield.
  const replacement = [...active.cards, round.shoe[round.drawIndex + 1]]
  const cards = isBust(replacement) ? active.cards : replacement
  const hand: PlayerHand = { ...active, cards, finished: true, busted: false, outcome: null }
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
  // The dealer only plays if some hand still needs judging against it. Hands that
  // already carry an outcome — busts, and player-blackjack auto-wins that resolved
  // against the dealer's dealt cards — take no dealer draw (the dealer stays put).
  const needsDealer = round.hands.some((hand) => hand.outcome === null)
  if (!needsDealer) {
    return settleAgainstDealer({ ...round, status: 'resolved' })
  }
  return settleAgainstDealer(playDealer({ ...round, status: 'dealer-turn' }))
}

function playDealer(round: Round): Round {
  // Freeze Dealer: the dealer stands on its current two cards, taking no draws.
  if (round.dealerFrozen) {
    return round
  }
  // The 'smart' soft-17 rule plays against the player's best live hand.
  const playerTotal = bestLivePlayerTotal(round)
  let dealer = round.dealer
  let drawIndex = round.drawIndex
  while (dealerShouldHit(dealer, round.rules, playerTotal)) {
    dealer = [...dealer, round.shoe[drawIndex]]
    drawIndex += 1
  }
  return { ...round, dealer, drawIndex }
}

// The dealer's play rule: always hit below 17, always stand on 21. At 17-20,
// rules.dealerSoft17 decides:
//   • 'hit'   — plain H17: draw a soft 17, stand everything else.
//   • 'smart' — draw only when not already beating the player, judged on the dealer's
//     *settling* total (Anti-dealer downgrade folded in) vs the player's best live
//     hand. A SOFT 17 draws when behind OR tied (the ace makes that hit free, so
//     breaking even a push is +EV). A HARD total draws only when *strictly* behind and
//     no higher than dealerHardHitCeiling — 17 for a healthy dealer, but a wounded
//     Dealer 6 raises it (18/19/20) as it grows desperate, taking bigger risks to
//     survive a hand a stand would lose.
function dealerShouldHit(dealer: Card[], rules: RoundRules, playerTotal: number): boolean {
  const value = evaluateHand(dealer)
  if (value.total < DEALER_STANDS_AT) {
    return true
  }
  if (value.total >= 21) {
    return false
  }
  if (rules.dealerSoft17 === 'hit') {
    return value.total === DEALER_STANDS_AT && value.soft
  }
  if (rules.dealerSoft17 === 'smart') {
    const effective = rules.dealerDowngrade && value.total < 21 ? value.total - 1 : value.total
    if (value.soft) {
      return value.total === DEALER_STANDS_AT && effective <= playerTotal
    }
    return value.total <= rules.dealerHardHitCeiling && effective < playerTotal
  }
  return false // 'stand'
}

// The highest standing-eligible total (17-20) the dealer held and then hit before
// busting — the hand it "would have stood on" under stand-on-17. On a bust the final
// total is >21, so every 17-20 it ever held was a hit it chose (a forced draw only
// happens below 17), and this is the best one it threw away. 0 if it never held one
// (it drew straight from a stiff into the bust). Used to grade the player's win so the
// dealer's aggression doesn't dock them to the weak bust tier (see rewards.ts).
export function dealerAbandonedStand(dealer: Card[]): number {
  let best = 0
  for (let n = 2; n <= dealer.length; n += 1) {
    const total = evaluateHand(dealer.slice(0, n)).total
    if (total >= 17 && total <= 20 && total > best) {
      best = total
    }
  }
  return best
}

// The best (highest, non-busted) total among the player hands still to be judged
// against the dealer — the target the 'smart' soft-17 rule plays against. Hands that
// already carry an outcome (busts, auto-blackjacks) are settled and need no dealer.
function bestLivePlayerTotal(round: Round): number {
  let best = 0
  for (const hand of round.hands) {
    if (hand.outcome === null) {
      const total = evaluateHand(hand.cards).total
      if (total <= 21 && total > best) {
        best = total
      }
    }
  }
  return best
}

// The dealer's total as it settles: normally the evaluated hand, but one lower
// when the Anti-dealer downgrade is active and the dealer stood under 21. Drives
// both the win/loss judgement and the reward tier (see rewards.ts), so beating a
// downgraded dealer is more common but each win grades one notch weaker.
export function dealerSettleTotal(round: Round): number {
  const total = evaluateHand(round.dealer).total
  if (round.rules.dealerDowngrade && total < 21) {
    return total - 1
  }
  return total
}

// Anti-dealer T3 (rules.dealerDowngrade): whether the dealer's standing total is
// currently being counted one lower — true exactly when dealerSettleTotal applies
// the −1 (the dealer stood under 21). A natural or a bust is never marked. Callers
// showing this should also confirm the round resolved, since during play the hole
// is hidden (or a Peek reveals it early) before the downgrade actually bites.
export function isDealerDowngraded(round: Round): boolean {
  return round.rules.dealerDowngrade && evaluateHand(round.dealer).total < 21
}

// Anti-dealer T2 (rules.hijackDealerNatural): whether the dealer's dealt natural
// blackjack was hijacked into a player win. A natural is the only 21 isBlackjack
// recognises (two cards), so this is exactly the hijacked-hand case.
export function isDealerHijacked(round: Round): boolean {
  return round.rules.hijackDealerNatural && isBlackjack(round.dealer)
}

function settleAgainstDealer(round: Round): Round {
  const dealerTotal = dealerSettleTotal(round)
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
  // A player natural is a dealt two-card 21; with the auto-blackjack upgrade, an
  // opening 20/21 counts the same and resolves instantly against the dealer's cards.
  const playerBlackjack = isBlackjack(player.cards) || reachesAutoBlackjack(player.cards, round.rules)
  const dealerNatural = isBlackjack(round.dealer)
  if (!playerBlackjack && !dealerNatural) {
    return round
  }
  let outcome: HandOutcome
  let lostToDealerNatural = false
  if (playerBlackjack && dealerNatural) {
    // Both dealt naturals normally push — unless hijack steals even that into a
    // player blackjack win.
    outcome = round.rules.hijackDealerNatural ? 'blackjack' : 'push'
  } else if (playerBlackjack) {
    outcome = 'blackjack'
  } else if (round.rules.hijackDealerNatural) {
    // Anti-dealer T2: steal the dealer's natural — the player takes it AS a natural
    // blackjack, so it pays the blackjack rate (respecting the Payout 3:1 upgrade)
    // and grades as the blackjack reward.
    outcome = 'blackjack'
  } else {
    outcome = 'lose'
    lostToDealerNatural = round.rules.dealerNaturalRefundRatio > 0
  }
  return { ...round, hands: [{ ...player, finished: true, outcome, lostToDealerNatural }], status: 'resolved' }
}

// Whether a hand has reached the player's auto-blackjack total (Chip eco T2/T3):
// the moment the total hits the threshold, the hand wins as a natural without the
// dealer drawing. Null threshold (no upgrade) never triggers.
function reachesAutoBlackjack(cards: Card[], rules: RoundRules): boolean {
  return rules.autoBlackjackAt !== null && !isBust(cards) && evaluateHand(cards).total >= rules.autoBlackjackAt
}

// The outcome for a player hand that hit the auto-blackjack total: a push if the
// dealer holds a dealt natural (nothing beats that), otherwise a natural win.
function playerBlackjackOutcome(round: Round): HandOutcome {
  return isBlackjack(round.dealer) ? 'push' : 'blackjack'
}

// Lock a hand as a player blackjack (see reachesAutoBlackjack): finished, judged
// against the dealer's dealt cards only — the dealer never draws for it.
function settlePlayerBlackjack(round: Round, index: number): Round {
  const hand: PlayerHand = { ...round.hands[index], finished: true, outcome: playerBlackjackOutcome(round) }
  return replaceHand(round, index, hand)
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
  // Anti-dealer T1: part of the bet is refunded on a loss to a dealer natural.
  if (outcome === 'lose' && hand.lostToDealerNatural && rules.dealerNaturalRefundRatio > 0) {
    return -(hand.bet - Math.floor(hand.bet * rules.dealerNaturalRefundRatio))
  }
  return -hand.bet
}

function requirePlayerTurn(round: Round): void {
  if (round.status !== 'player-turn') {
    throw new Error('action is only allowed during the player turn')
  }
}
