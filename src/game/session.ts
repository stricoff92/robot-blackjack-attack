import { createShoe, shuffle, type Card, type Rank } from './deck'
import { cardValue } from './hand'
import { bustChanceOnHit, computeAnalysis, type Analysis, type Knowledge } from './odds'
import { POWERUPS, type PowerupId } from './powerups'
import { createRng, type Rng } from './random'
import {
  activeHand,
  armSecondChance,
  canForcedSplit,
  canMulligan,
  canReturn,
  doubleDown,
  forcedSplit,
  freezeDealer,
  hit,
  lateDouble,
  mulligan,
  returnCard,
  split,
  stand,
  startRound,
  type Round,
} from './round'
import {
  addTokens,
  applyRound,
  applyUpgrade,
  FULL_INTEGRITY,
  hasAvailableUpgrade,
  hitTokens,
  nextBet,
  spendTokens,
  startRun,
  type RunState,
} from './run'
import { rulesForUpgrades, type RunUpgrades, type UpgradePath } from './upgrades'

const SHOE_DECKS = 6

// 'choosing-upgrade' holds the deal after a non-final kill until the player picks
// a roguelite upgrade; in the UI the dealer dies first, the selector shows, then the
// replacement's walk-in ceremony plays once the pick releases the deal.
export type Phase = 'betting' | 'playing' | 'resolved' | 'over' | 'choosing-upgrade'

export interface SessionOptions {
  /** Dev switch: force the player's opening two cards to be a splittable pair. */
  forcePairs?: boolean
  /** With forcePairs, an optional specific rank to pair; otherwise pairs the top card. */
  forcePairRank?: Rank | null
  /** Dev switch: seed the run (and each New run) with this many tokens; null = default. */
  startTokens?: number | null
  /** Dev switch: start the first dealer of each run at this % health (1-100); null = full. */
  dealerHealth?: number | null
  /** Dev switch: start each run at this dealer (1-based); null = the first dealer. */
  startDealer?: number | null
  /** Dev switch: start each run with these unlocked upgrade tiers; null = none. */
  startUpgrades?: RunUpgrades | null
  /** Dev switch: force the dealer's opening two cards to be a natural 21 every deal. */
  forceDealerNatural?: boolean
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
  // Set when a kill just advanced the dealer (and the run isn't won): the next
  // hand is gated on a choose-upgrade pick.
  private upgradePending = false
  private readonly forcePairs: boolean
  private readonly forcePairRank: Rank | null
  private readonly startTokens: number | null
  private readonly dealerHealth: number | null
  private readonly startDealer: number | null
  private readonly startUpgrades: RunUpgrades | null
  private readonly forceDealerNatural: boolean

  constructor(seed: number, options: SessionOptions = {}) {
    this.nextRandom = createRng(seed)
    this.analysisRandom = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.forcePairs = options.forcePairs ?? false
    this.forcePairRank = options.forcePairRank ?? null
    this.startTokens = options.startTokens ?? null
    this.dealerHealth = options.dealerHealth ?? null
    this.startDealer = options.startDealer ?? null
    this.startUpgrades = options.startUpgrades ?? null
    this.forceDealerNatural = options.forceDealerNatural ?? false
    this.run = this.freshRun(seed)
  }

  // A new run, with any dev overrides (starting tokens, opening dealer, opening
  // dealer health) folded in.
  private freshRun(seed: number): RunState {
    let run = startRun(seed)
    if (this.startTokens !== null) {
      run = { ...run, tokens: this.startTokens }
    }
    if (this.startDealer !== null && this.startDealer > 1) {
      // Jump to a later dealer: advance the shift index and seed the kills of the
      // dealers we skipped, so the "dealers left" pips and the win-at-6 count stay
      // consistent with having actually fought up to here.
      const kills: number[] = []
      for (let i = 1; i < this.startDealer; i += 1) {
        kills.push(i)
      }
      run = { ...run, shiftIndex: this.startDealer, kills }
    }
    if (this.dealerHealth !== null) {
      run = { ...run, integrity: Math.round((FULL_INTEGRITY * this.dealerHealth) / 100) }
    }
    if (this.startUpgrades !== null) {
      run = { ...run, upgrades: this.startUpgrades }
    }
    return run
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
    if (this.forceDealerNatural) {
      forceDealerNaturalCards(shoe)
    }
    this.peeked = false
    this.foresightCard = null
    this.analysis = null
    // Fold the run's unlocked upgrades into this round's rules.
    this.round = startRound(shoe, bet, rulesForUpgrades(this.run.upgrades))
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
    const tokenMult = round.rules.tokenMultiplier
    this.act(() => hit(this.requireRound()))
    // Only reward a hit that keeps the hand alive — a bust earns nothing. The Token
    // eco multiplier scales it, like every other reward.
    if (this.round !== null && !this.round.hands[hitIndex].busted) {
      this.run = addTokens(this.run, Math.round(hitTokens(bustChance) * tokenMult))
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

  buyForcedSplit(): void {
    if (!this.canBuy('forced-split') || !canForcedSplit(this.requireRound()) || !this.canAffordSplitBet()) {
      return
    }
    this.run = spendTokens(this.run, POWERUPS['forced-split'].cost)
    this.act(() => forcedSplit(this.requireRound()))
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

  buyReturn(): void {
    if (!this.canBuy('return') || !canReturn(this.requireRound())) {
      return
    }
    this.analysis = null
    // The returned card becomes the new top of the shoe, so any Peek Deck preview
    // (which pointed at the old top) is now stale — drop it.
    this.foresightCard = null
    this.run = spendTokens(this.run, POWERUPS.return.cost)
    this.round = returnCard(this.requireRound())
    // Return auto-stands, which can hand the turn to the dealer and resolve the
    // round outright — settle if so, exactly like a normal stand.
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
    // A kill grants an upgrade pick: hold in choose-upgrade until the player picks
    // (the walk-in ceremony plays after the pick), unless every path is already maxed.
    this.phase = this.upgradePending && hasAvailableUpgrade(this.run) ? 'choosing-upgrade' : 'betting'
    this.upgradePending = false
  }

  // Apply the chosen roguelite upgrade and release the held deal. No-op unless the
  // player is actually on the choose-upgrade screen.
  chooseUpgrade(path: UpgradePath): void {
    if (this.phase !== 'choosing-upgrade') {
      return
    }
    this.run = applyUpgrade(this.run, path)
    this.phase = 'betting'
  }

  restart(): void {
    const seed = generateSeed()
    this.nextRandom = createRng(seed)
    this.analysisRandom = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.run = this.freshRun(seed)
    this.round = null
    this.peeked = false
    this.foresightCard = null
    this.analysis = null
    this.upgradePending = false
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
    const beforeShift = this.run.shiftIndex
    this.run = applyRound(this.run, this.requireRound())
    // A non-final kill (the dealer advanced but the run isn't won) earns an upgrade
    // pick, taken after the player calls the next hand.
    if (!this.run.over && this.run.shiftIndex > beforeShift) {
      this.upgradePending = true
    }
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

  // A split adds one more hand at the active hand's bet — same chip exposure test
  // as a double-style extra bet.
  private canAffordSplitBet(): boolean {
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

// Dev aid: reorder the shoe so the dealer's opening two cards (shoe[2], shoe[3])
// make a natural 21 — one Ace and one ten-value card. Pulls them from deeper in the
// shoe (index 4+), so the player's opening cards (shoe[0..1]) are left untouched
// and this composes with forcePlayerPair. A 6-deck shoe always has both to spare.
function forceDealerNaturalCards(shoe: Card[]): void {
  seatDealerCard(shoe, 2, (card) => card.rank === 'A')
  seatDealerCard(shoe, 3, (card) => cardValue(card) === 10)
}

// Swap a card matching `pred` into dealer slot `pos` from deeper in the shoe (past
// the four dealt cards), unless the slot already satisfies it.
function seatDealerCard(shoe: Card[], pos: number, pred: (card: Card) => boolean): void {
  if (pred(shoe[pos])) {
    return
  }
  for (let i = 4; i < shoe.length; i++) {
    if (pred(shoe[i])) {
      swap(shoe, pos, i)
      return
    }
  }
}

function swap(cards: Card[], a: number, b: number): void {
  const held = cards[a]
  cards[a] = cards[b]
  cards[b] = held
}
