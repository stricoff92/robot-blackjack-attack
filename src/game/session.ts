import { createShoe, shuffle, type Card, type Rank } from './deck'
import { bustChanceOnHit, computeAnalysis, type Analysis, type Knowledge } from './odds'
import { POWERUPS, type PowerupId } from './powerups'
import { createRng, type Rng } from './random'
import {
  activeHand,
  armSecondChance,
  canMulligan,
  DEFAULT_ROUND_RULES,
  doubleDown,
  freezeDealer,
  hit,
  lateDouble,
  mulligan,
  split,
  stand,
  startRound,
  type Round,
} from './round'
import { addTokens, applyRound, hitTokens, nextBet, spendTokens, startRun, type RunState } from './run'

const SHOE_DECKS = 6

export type Phase = 'betting' | 'playing' | 'resolved' | 'over'

export interface SessionOptions {
  /** Dev switch: force the player's opening two cards to be a splittable pair. */
  forcePairs?: boolean
  /** With forcePairs, an optional specific rank to pair; otherwise pairs the top card. */
  forcePairRank?: Rank | null
}

export interface SessionState {
  run: RunState
  round: Round | null
  phase: Phase
  peeked: boolean
  foresightCard: Card | null
  /** Live Analyze readout, shown until the next action clears it. */
  analysis: Analysis | null
}

// Decorrelates the Analyze simulator's RNG from the deal RNG, so running odds
// never disturbs the card sequence (and the sequence is the same whether or not
// the player ever buys Analyze).
const ANALYSIS_SEED_SALT = 0x5f356495

export class Session {
  private nextRandom: Rng
  private analysisRandom: Rng
  private run: RunState
  private round: Round | null = null
  private phase: Phase = 'betting'
  private peeked = false
  private foresightCard: Card | null = null
  private analysis: Analysis | null = null
  private readonly forcePairs: boolean
  private readonly forcePairRank: Rank | null

  constructor(seed: number, options: SessionOptions = {}) {
    this.nextRandom = createRng(seed)
    this.analysisRandom = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.run = startRun(seed)
    this.forcePairs = options.forcePairs ?? false
    this.forcePairRank = options.forcePairRank ?? null
  }

  snapshot(): SessionState {
    return {
      run: this.run,
      round: this.round,
      phase: this.phase,
      peeked: this.peeked,
      foresightCard: this.foresightCard,
      analysis: this.analysis,
    }
  }

  deal(): void {
    if (this.phase !== 'betting') {
      return
    }
    const bet = nextBet(this.run)
    const shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom)
    if (this.forcePairs) {
      forcePlayerPair(shoe, this.forcePairRank)
    }
    this.peeked = false
    this.foresightCard = null
    this.analysis = null
    this.round = startRound(shoe, bet, DEFAULT_ROUND_RULES)
    if (this.round.status === 'resolved') {
      this.settle()
    } else {
      this.phase = 'playing'
    }
  }

  hit(): void {
    if (this.phase !== 'playing') {
      return
    }
    const round = this.requireRound()
    const hitIndex = round.activeIndex
    // Price the risk before taking it: the odds this hit busts (from public cards)
    // set how much a surviving hit pays.
    const bustChance = bustChanceOnHit(round)
    this.act(() => hit(this.requireRound()))
    // Only reward a hit that keeps the hand alive — a bust earns nothing.
    if (this.round !== null && !this.round.hands[hitIndex].busted) {
      this.run = addTokens(this.run, hitTokens(bustChance))
    }
  }

  stand(): void {
    this.act(() => stand(this.requireRound()))
  }

  double(): void {
    this.act(() => doubleDown(this.requireRound()))
  }

  split(): void {
    this.act(() => split(this.requireRound()))
  }

  buyPeek(): void {
    if (!this.canBuy('peek')) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, POWERUPS.peek.cost)
    this.peeked = true
  }

  buyForesight(): void {
    if (!this.canBuy('foresight')) {
      return
    }
    const round = this.requireRound()
    this.analysis = null
    this.run = spendTokens(this.run, POWERUPS.foresight.cost)
    this.foresightCard = round.shoe[round.drawIndex]
  }

  // Read the odds and hold them in `analysis` until the next action clears them.
  // Blocked while a reading is already up, so it can't be paid for twice. Uses a
  // dedicated RNG so the simulation never touches the deal sequence.
  buyAnalyze(): void {
    if (!this.canBuy('analyze') || this.analysis !== null) {
      return
    }
    const round = this.requireRound()
    this.run = spendTokens(this.run, POWERUPS.analyze.cost)
    // Fold in whatever the player has already peeked: the dealer's hole card
    // (Peek Dealer) and/or the next card in the shoe (Peek Deck). Both sharpen the
    // odds — a known hole is used outright, a known next card makes the outcome
    // certain — so paying for more information buys a more accurate reading.
    const knowledge: Knowledge = {
      hole: this.peeked ? round.dealer[1] : null,
      nextCard: this.foresightCard,
    }
    this.analysis = computeAnalysis(round, knowledge, this.analysisRandom)
  }

  buyLateDouble(): void {
    if (!this.canBuy('late-double') || !this.canAffordLateDouble()) {
      return
    }
    this.run = spendTokens(this.run, POWERUPS['late-double'].cost)
    this.act(() => lateDouble(this.requireRound()))
  }

  buySecondChance(): void {
    if (!this.canBuy('second-chance')) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, POWERUPS['second-chance'].cost)
    this.round = armSecondChance(this.requireRound())
  }

  buyFreezeDealer(): void {
    if (!this.canBuy('freeze') || this.requireRound().dealerFrozen) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, POWERUPS.freeze.cost)
    this.round = freezeDealer(this.requireRound())
  }

  buyMulligan(): void {
    if (!this.canBuy('mulligan') || !canMulligan(this.requireRound())) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, POWERUPS.mulligan.cost)
    // The peeked next card is dealt into the fresh hand, so the stale preview clears.
    this.foresightCard = null
    this.round = mulligan(this.requireRound())
    if (this.requireRound().status === 'resolved') {
      this.settle()
    }
  }

  nextHand(): void {
    if (this.phase !== 'resolved') {
      return
    }
    this.round = null
    this.analysis = null
    this.phase = 'betting'
  }

  restart(): void {
    const seed = generateSeed()
    this.nextRandom = createRng(seed)
    this.analysisRandom = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.run = startRun(seed)
    this.round = null
    this.peeked = false
    this.foresightCard = null
    this.analysis = null
    this.phase = 'betting'
  }

  private act(transition: () => Round): void {
    if (this.phase !== 'playing') {
      return
    }
    // Any player move dismisses a live Analyze reading (and the stale next-card
    // preview) — the odds were only valid for the pre-move table.
    this.foresightCard = null
    this.analysis = null
    this.round = transition()
    if (this.requireRound().status === 'resolved') {
      this.settle()
    }
  }

  private settle(): void {
    this.run = applyRound(this.run, this.requireRound())
    this.phase = this.run.over ? 'over' : 'resolved'
  }

  private canBuy(id: PowerupId): boolean {
    return this.phase === 'playing' && this.round !== null && this.run.tokens >= POWERUPS[id].cost
  }

  private canAffordLateDouble(): boolean {
    const round = this.requireRound()
    const exposure = round.hands.reduce((total, hand) => total + hand.bet, 0)
    return this.run.chips >= exposure + activeHand(round).bet
  }

  private requireRound(): Round {
    if (!this.round) {
      throw new Error('no active round')
    }
    return this.round
  }
}

function generateSeed(): number {
  return Math.floor(Math.random() * 0x100000000)
}

// Dev aid: reorder the shoe so the player's opening two cards (shoe[0], shoe[1])
// share a rank, making the hand splittable. The dealer's cards (shoe[2..3]) and
// the rest of the shoe stay as dealt. A 6-deck shoe holds 24 of every rank, so a
// match is always available.
function forcePlayerPair(shoe: Card[], rank: Rank | null): void {
  // Optionally seat a specific rank as the top card first, so the pair is that rank.
  if (rank) {
    const found = shoe.findIndex((card) => card.rank === rank)
    if (found > 0) {
      swap(shoe, 0, found)
    }
  }
  if (shoe[1].rank === shoe[0].rank) {
    return // already a pair
  }
  for (let i = 2; i < shoe.length; i++) {
    if (shoe[i].rank === shoe[0].rank) {
      swap(shoe, 1, i)
      return
    }
  }
}

function swap(cards: Card[], a: number, b: number): void {
  const held = cards[a]
  cards[a] = cards[b]
  cards[b] = held
}
