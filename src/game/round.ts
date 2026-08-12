import type { Card } from './deck'
import { cardValue, evaluateHand, isBlackjack, isBust } from './hand'

export type RoundStatus = 'player-turn' | 'dealer-turn' | 'resolved'
export type HandOutcome = 'blackjack' | 'win' | 'push' | 'voided' | 'lose' | 'bust'
// One consumed window slot's result, for the dealer hand-summary (see run.handLog).
export type HandResult = 'win' | 'loss'

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
  allowSplit: boolean
  // Roguelite upgrades (see game/upgrades.ts), folded in per-round at the deal.
  // Payout T3: a genuine push (player total == dealer total), and a Sabotage-voided dealer 21, are
  // awarded to the player as a WIN (a hit + points) instead of redealing.
  pushWinsToPlayer: boolean
  // Sabotage T2: any dealer 21 (a dealt natural OR a hit to 21), while the player is under 21, voids
  // the hand — a wash the Session redeals (no window slot spent), not a loss. With pushWinsToPlayer
  // it instead resolves as a win.
  voidDealer21: boolean
  // Sabotage T3: a dealt dealer natural is stolen — the player takes the win.
  hijackDealerNatural: boolean
  // Sabotage T1: any dealer 21 (a dealt natural OR a hit to 21) pays a flat energy bonus, whatever the
  // hand's outcome. The credit is a run-state effect applied in Session.settle_ (SABOTAGE_DEALER21_ENERGY),
  // not a settlement rule — this flag is just the "the run owns Sabotage" signal the credit + spec-sheet read.
  dealer21Energy: boolean
  // Token eco: multiplier applied to every token reward this round.
  tokenMultiplier: number
}

export const DEFAULT_ROUND_RULES: RoundRules = {
  dealerSoft17: 'stand',
  dealerHardHitCeiling: 17,
  allowSplit: true,
  pushWinsToPlayer: false,
  voidDealer21: false,
  hijackDealerNatural: false,
  dealer21Energy: false,
  tokenMultiplier: 1,
}

export interface PlayerHand {
  cards: Card[]
  // Vestigial since chips were removed — a hand's stake WEIGHT comes from `doubled` (see
  // run.handWeight), not this. Kept as a constant 1 to avoid churning the round struct; it carries
  // no economy meaning.
  bet: number
  doubled: boolean
  splitAce: boolean
  finished: boolean
  busted: boolean
  outcome: HandOutcome | null
  // Set on a win that came from a push or a Sabotage-voided dealer 21 being converted to a win by
  // Payout T3. Scores + lands a hit like any win, but grades its TOKENS at the floor tier — there
  // was no dealer total to beat (see rewards.ts).
  chipsOnly?: boolean
  // Set when this hand was doubled via the standard, token-free Double (doubleDown), as opposed to
  // the paid Late double powerup. A free-doubled win is tallied for the score screen (freeDoubleWins);
  // it carries no scoring effect (the double's reward is that it counts as 2 wins — see run.ts).
  freeDoubled?: boolean
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

// Splitting is capped at 2 hands total (one split, no resplits) — a UI/UX
// constraint on how many hands the table can lay out and play through at once.
const MAX_HANDS = 2
const DEALER_STANDS_AT = 17

export function startRound(shoe: Card[], rules: RoundRules = DEFAULT_ROUND_RULES): Round {
  const round: Round = {
    shoe,
    drawIndex: 4,
    hands: [newHand([shoe[0], shoe[1]], false)],
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

// A hand's stake WEIGHT: 2 if it was doubled (the doubled hand risks — and pays — twice), else 1.
// Replaces the old chip bet exposure. Drives window cost, hits landed, and points (see run.ts).
export function handWeight(hand: PlayerHand): number {
  return hand.doubled ? 2 : 1
}

// The window slots a resolved round consumes and their win/loss result — one entry per WEIGHT unit
// of each non-pushed hand (a double win → ['win','win']; a split → one per hand). Pushes/voids
// contribute nothing (they never consume the window — see isRedealRound). Drives run.handLog.
export function roundTally(round: Round): { hits: number; losses: number; slots: HandResult[] } {
  let hits = 0
  let losses = 0
  const slots: HandResult[] = []
  for (const hand of round.hands) {
    const weight = handWeight(hand)
    if (hand.outcome === 'win' || hand.outcome === 'blackjack') {
      hits += weight
      for (let i = 0; i < weight; i += 1) slots.push('win')
    } else if (hand.outcome === 'lose' || hand.outcome === 'bust') {
      losses += weight
      for (let i = 0; i < weight; i += 1) slots.push('loss')
    }
  }
  return { hits, losses, slots }
}

// A round that lands nothing — every hand pushed or voided (a wash). It consumes no window slot; the
// Session deals a fresh round instead of advancing the dealer. With Payout T3 a push resolves as a
// win, so this is never true then.
export function isRedealRound(round: Round): boolean {
  return round.hands.length > 0 && round.hands.every((hand) => hand.outcome === 'push' || hand.outcome === 'voided')
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
  return applyDouble(round, true)
}

export function lateDouble(round: Round): Round {
  requirePlayerTurn(round)
  return applyDouble(round, false)
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
    newHand([active.cards[0], round.shoe[round.drawIndex]], splittingAces),
    splittingAces,
  )
  const handB = finalizeSplitHand(
    newHand([active.cards[1], round.shoe[round.drawIndex + 1]], splittingAces),
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
    ...replaceHand(round, round.activeIndex, newHand(cards, false)),
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

function newHand(cards: Card[], splitAce: boolean): PlayerHand {
  return { cards, bet: 1, doubled: false, splitAce, finished: false, busted: false, outcome: null }
}

function finalizeSplitHand(hand: PlayerHand, splittingAces: boolean): PlayerHand {
  const busted = isBust(hand.cards)
  if (busted) {
    return { ...hand, finished: true, busted: true, outcome: 'bust' }
  }
  if (splittingAces) {
    return { ...hand, finished: true, busted: false, outcome: null }
  }
  return hand
}

function applyDouble(round: Round, free: boolean): Round {
  const active = activeHand(round)
  const cards = [...active.cards, round.shoe[round.drawIndex]]
  const busted = isBust(cards)
  const hand: PlayerHand = {
    ...active,
    cards,
    doubled: true,
    freeDoubled: free,
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
//     total vs the player's best live hand. A SOFT 17 draws when behind OR tied (the
//     ace makes that hit free, so breaking even a push is +EV). A HARD total draws only
//     when *strictly* behind and no higher than dealerHardHitCeiling — 17 for a healthy
//     dealer, but a wounded Dealer 6 raises it (18/19/20) as it grows desperate, taking
//     bigger risks to survive a hand a stand would lose.
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
    if (value.soft) {
      return value.total === DEALER_STANDS_AT && value.total <= playerTotal
    }
    return value.total <= rules.dealerHardHitCeiling && value.total < playerTotal
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
// already carry an outcome (e.g. busts) are settled and need no dealer.
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

// The dealer's total as it settles — the evaluated hand. Drives both the win/loss
// judgement and the reward tier (see rewards.ts).
export function dealerSettleTotal(round: Round): number {
  return evaluateHand(round.dealer).total
}

// Sabotage T3 (rules.hijackDealerNatural): whether the dealer's dealt natural
// blackjack was hijacked into a player win. A natural is the only 21 isBlackjack
// recognises (two cards), so this is exactly the hijacked-hand case.
export function isDealerHijacked(round: Round): boolean {
  return round.rules.hijackDealerNatural && isBlackjack(round.dealer)
}

function settleAgainstDealer(round: Round): Round {
  const dealerTotal = dealerSettleTotal(round)
  const dealerBust = dealerTotal > 21
  // A dealt dealer natural resolves at the opening, so a settling total of 21 is
  // always a hit-to-21 — the case Sabotage T2 (voidDealer21) voids.
  const dealer21 = dealerTotal === 21
  const hands = round.hands.map((hand) => {
    if (hand.outcome) {
      return hand
    }
    if (hand.busted) {
      return { ...hand, finished: true, outcome: 'bust' as HandOutcome }
    }
    const judged = judgeHand(evaluateHand(hand.cards).total, dealerTotal, dealerBust, dealer21, round.rules)
    return { ...hand, finished: true, ...judged }
  })
  return { ...round, hands, status: 'resolved' }
}

// The settled outcome for one player hand vs the dealer, plus whether it's a converted win
// (Payout T3 turning a push or a Sabotage-voided dealer 21 into a win — flagged chipsOnly, a
// legacy name; it now lands a hit + points but grades its tokens at the floor tier, see rewards.ts).
function judgeHand(
  playerTotal: number,
  dealerTotal: number,
  dealerBust: boolean,
  dealer21: boolean,
  rules: RoundRules,
): { outcome: HandOutcome; chipsOnly?: boolean } {
  // Sabotage T2: a dealer that hit to 21 voids the player's (sub-21) hand — a redeal (the Session
  // re-deals a voided round, no window slot spent), unless Payout T3 turns it into a win.
  if (dealer21 && rules.voidDealer21 && playerTotal < 21) {
    return rules.pushWinsToPlayer ? { outcome: 'win', chipsOnly: true } : { outcome: 'voided' }
  }
  if (dealerBust || playerTotal > dealerTotal) {
    return { outcome: 'win' }
  }
  if (playerTotal < dealerTotal) {
    return { outcome: 'lose' }
  }
  // A genuine tie: Payout T3 resolves it as a win, otherwise it pushes (which the Session redeals).
  return rules.pushWinsToPlayer ? { outcome: 'win', chipsOnly: true } : { outcome: 'push' }
}

function resolveOpeningNaturals(round: Round): Round {
  const player = round.hands[0]
  const playerBlackjack = isBlackjack(player.cards)
  const dealerNatural = isBlackjack(round.dealer)
  if (!playerBlackjack && !dealerNatural) {
    return round
  }
  const rules = round.rules
  let outcome: HandOutcome
  let chipsOnly = false
  if (playerBlackjack && dealerNatural) {
    // Both naturals: a push, unless Sabotage T3 hijacks it into a player blackjack
    // or Payout T3 turns the push into a win.
    if (rules.hijackDealerNatural) {
      outcome = 'blackjack'
    } else if (rules.pushWinsToPlayer) {
      outcome = 'win'
      chipsOnly = true
    } else {
      outcome = 'push'
    }
  } else if (playerBlackjack) {
    outcome = 'blackjack'
  } else {
    // Dealer natural, player without one. Sabotage ladder: T3 hijacks it (a player blackjack win —
    // a hit + points), T2 voids it (a redeal, or a win with Payout T3), T1 leaves it a plain loss
    // (its +20 energy fires off the dealer's 21 in Session.settle_, independent of the outcome).
    if (rules.hijackDealerNatural) {
      outcome = 'blackjack'
    } else if (rules.voidDealer21) {
      if (rules.pushWinsToPlayer) {
        outcome = 'win'
        chipsOnly = true
      } else {
        outcome = 'voided'
      }
    } else {
      outcome = 'lose'
    }
  }
  return {
    ...round,
    hands: [{ ...player, finished: true, outcome, chipsOnly }],
    status: 'resolved',
  }
}

function requirePlayerTurn(round: Round): void {
  if (round.status !== 'player-turn') {
    throw new Error('action is only allowed during the player turn')
  }
}
