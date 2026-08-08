import { createShoe, shuffle, type Card, type Rank } from './deck'
import { cardValue, isBlackjack } from './hand'
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
  abilitiesLocked,
  bumpCombo,
  dealerHardHitCeiling,
  getShift,
  hasAvailableUpgrade,
  hitTokens,
  maxIntegrityFor,
  nextBet,
  powerupCost,
  spendTokens,
  startRun,
  type RunState,
} from './run'
import { rulesForUpgrades, type RunUpgrades, type UpgradePath } from './upgrades'

export const SHOE_DECKS = 6

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
  /** Dev switch: seed the run (and each New run) with this many chips; null = default (300). */
  startChips?: number | null
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
  /** Live Analyze readout, shown until the next action clears it. */
  analysis: Analysis | null
  /** Whether token abilities are locked — the Dealer 6 "honorable duel" (< 20% health). */
  abilitiesLocked: boolean
  /** The bust risk [0,1] of the hit that just landed and paid points, else null. Set on a
   *  surviving hit, cleared by the next move — lets the UI caption the reward ("Nice"…). */
  lastHitRisk: number | null
}

// Decorrelates the Analyze simulator's RNG from the deal RNG, so running odds
// never disturbs the card sequence (and the sequence is the same whether or not
// the player ever buys Analyze).
const ANALYSIS_SEED_SALT = 0x5f356495

// Decorrelates the heal-on-win roll from the deal RNG, so a healing dealer's repair
// amount never disturbs the card sequence (like ANALYSIS_SEED_SALT does for Analyze).
const HEAL_SEED_SALT = 0x1b873593

export class Session {
  private nextRandom: Rng
  private analysisRandom: Rng
  private healRandom: Rng
  private run: RunState
  private round: Round | null = null
  private phase: Phase = 'betting'
  private peeked = false
  private analysis: Analysis | null = null
  // The bust risk of the last surviving hit that paid points (see hit()); cleared by the
  // next move. Drives the UI's risk caption ("WHOA!"/"Lucky!"/"Nice").
  private lastHitRisk: number | null = null
  // Set when a kill just advanced the dealer (and the run isn't won): the next
  // hand is gated on a choose-upgrade pick.
  private upgradePending = false
  private readonly forcePairs: boolean
  private readonly forcePairRank: Rank | null
  private readonly startTokens: number | null
  private readonly startChips: number | null
  private readonly dealerHealth: number | null
  private readonly startDealer: number | null
  private readonly startUpgrades: RunUpgrades | null
  private readonly forceDealerNatural: boolean

  constructor(seed: number, options: SessionOptions = {}) {
    this.nextRandom = createRng(seed)
    this.analysisRandom = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.healRandom = createRng(seed ^ HEAL_SEED_SALT)
    this.forcePairs = options.forcePairs ?? false
    this.forcePairRank = options.forcePairRank ?? null
    this.startTokens = options.startTokens ?? null
    this.startChips = options.startChips ?? null
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
    if (this.startChips !== null) {
      run = { ...run, chips: this.startChips }
    }
    if (this.startDealer !== null && this.startDealer > 1) {
      // Jump to a later dealer: advance the shift index and seed the kills of the
      // dealers we skipped, so the "dealers left" pips and the win-at-6 count stay
      // consistent with having actually fought up to here.
      const kills: number[] = []
      for (let i = 1; i < this.startDealer; i += 1) {
        kills.push(i)
      }
      // Full health for the jumped-to dealer — its own max, not Dealer 1's (or the bar
      // would open partway drained, e.g. 100/220 at Dealer 6).
      run = { ...run, shiftIndex: this.startDealer, kills, integrity: maxIntegrityFor(this.startDealer) }
    }
    if (this.dealerHealth !== null) {
      // dealerHealth is a percentage of the current dealer's own max integrity.
      run = { ...run, integrity: Math.round((maxIntegrityFor(run.shiftIndex) * this.dealerHealth) / 100) }
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
      analysis: this.analysis,
      abilitiesLocked: abilitiesLocked(this.run),
      lastHitRisk: this.lastHitRisk,
    }
  }

  deal(): void {
    if (this.phase !== 'betting') {
      return
    }
    const bet = nextBet(this.run)
    const shoe = this.shuffleShoe()
    if (this.forcePairs) {
      forcePlayerPair(shoe, this.forcePairRank)
    }
    if (this.forceDealerNatural) {
      forceDealerNaturalCards(shoe)
    }
    this.peeked = false
    this.analysis = null
    // Fold the run's unlocked upgrades AND the current dealer's house rules (late
    // dealers hit soft 17) into this round's rules.
    const rules = {
      ...rulesForUpgrades(this.run.upgrades),
      dealerSoft17: getShift(this.run.shiftIndex).dealerSoft17,
      dealerHardHitCeiling: dealerHardHitCeiling(this.run),
    }
    this.round = startRound(shoe, bet, rules)
    if (this.round.status === 'resolved') {
      this.settle()
    } else {
      this.phase = 'playing'
    }
  }

  // Shuffle a fresh 6-deck shoe for the deal. Dealer 1 carries an invisible guard rail:
  // if the shuffle would deal the dealer a natural blackjack (an opening two-card 21 —
  // shoe[2]+shoe[3] — that the player can't out-win), the shoe is discarded and reshuffled
  // until it doesn't, so the very first dealer never opens on an unbeatable natural (see the
  // rules doc §2). Later dealers get an honest shuffle. Reshuffling only advances the deal
  // RNG, so the run stays fully deterministic for its seed. A natural is rare (~4.8%), so
  // this almost never reshuffles more than once and can't loop forever (the shoe always has
  // non-natural openings). Runs before the dev switches so forceDealerNatural still wins.
  private shuffleShoe(): Card[] {
    let shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom)
    if (this.run.shiftIndex === 1) {
      while (isBlackjack([shoe[2], shoe[3]])) {
        shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom)
      }
    }
    return shoe
  }

  hit(): void {
    if (this.phase !== 'playing') {
      return
    }
    const round = this.requireRound()
    const hitIndex = round.activeIndex
    // Price the risk before taking it: the odds this hit busts (from public cards) set both
    // the token reward and how much the hit grows the combo.
    const bustChance = bustChanceOnHit(round)
    const tokenMult = round.rules.tokenMultiplier
    this.act(() => hit(this.requireRound())) // clears lastHitRisk; re-set below on survival
    if (this.round !== null && !this.round.hands[hitIndex].busted) {
      // A surviving hit earns NO score — it just grows the combo (risk-weighted, see
      // comboGain), which multiplies the wins + kills ahead. It still pays tokens (the
      // powerup economy, scaled by the Token eco multiplier). The risk is stashed for the UI.
      this.run = bumpCombo(addTokens(this.run, Math.round(hitTokens(bustChance) * tokenMult)), bustChance)
      this.lastHitRisk = bustChance
    }
    // A busting hit doesn't reset the combo here — the reset happens at RESOLUTION (run.ts
    // applyRound) when the whole hand is lost, so a split hand that busts but has a winning
    // sibling keeps the streak.
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
    this.run = spendTokens(this.run, this.costOf('peek'))
    this.peeked = true
  }

  // Read the odds and hold them in `analysis` until the next action clears them.
  // Blocked while a reading is already up, so it can't be paid for twice. Uses a
  // dedicated RNG so the simulation never touches the deal sequence.
  buyAnalyze(): void {
    if (!this.canBuy('analyze') || this.analysis !== null) {
      return
    }
    const round = this.requireRound()
    this.run = spendTokens(this.run, this.costOf('analyze'))
    // Fold in the dealer's hole card if Peek Dealer has revealed it: a known hole
    // is used outright instead of averaged over, so paying for more information
    // buys a more accurate reading.
    const knowledge: Knowledge = {
      hole: this.peeked ? round.dealer[1] : null,
    }
    this.analysis = computeAnalysis(round, knowledge, this.analysisRandom)
  }

  buyLateDouble(): void {
    if (!this.canBuy('late-double') || !this.canAffordLateDouble()) {
      return
    }
    this.run = spendTokens(this.run, this.costOf('late-double'))
    this.act(() => lateDouble(this.requireRound()))
  }

  buyForcedSplit(): void {
    if (!this.canBuy('forced-split') || !canForcedSplit(this.requireRound()) || !this.canAffordSplitBet()) {
      return
    }
    this.run = spendTokens(this.run, this.costOf('forced-split'))
    this.act(() => forcedSplit(this.requireRound()))
  }

  buySecondChance(): void {
    if (!this.canBuy('second-chance')) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, this.costOf('second-chance'))
    this.round = armSecondChance(this.requireRound())
  }

  buyFreezeDealer(): void {
    if (!this.canBuy('freeze') || this.requireRound().dealerFrozen) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, this.costOf('freeze'))
    this.round = freezeDealer(this.requireRound())
  }

  buyMulligan(): void {
    if (!this.canBuy('mulligan') || !canMulligan(this.requireRound())) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, this.costOf('mulligan'))
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
    this.run = spendTokens(this.run, this.costOf('return'))
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
    this.healRandom = createRng(seed ^ HEAL_SEED_SALT)
    this.run = this.freshRun(seed)
    this.round = null
    this.peeked = false
    this.analysis = null
    this.lastHitRisk = null
    this.upgradePending = false
    this.phase = 'betting'
  }

  private act(transition: () => Round): void {
    if (this.phase !== 'playing') {
      return
    }
    // Any player move dismisses a live Analyze reading — the odds were only valid
    // for the pre-move table. The prior hit's risk caption clears too (hit()
    // re-sets it if THIS move is a surviving hit).
    this.analysis = null
    this.lastHitRisk = null
    this.round = transition()
    if (this.requireRound().status === 'resolved') {
      this.settle()
    }
  }

  private settle(): void {
    const beforeShift = this.run.shiftIndex
    this.run = applyRound(this.run, this.requireRound(), this.healRandom)
    // A non-final kill (the dealer advanced but the run isn't won) earns an upgrade
    // pick, taken after the player calls the next hand.
    if (!this.run.over && this.run.shiftIndex > beforeShift) {
      this.upgradePending = true
    }
    this.phase = this.run.over ? 'over' : 'resolved'
  }

  // A powerup's live cost — its base price inflated by the run's token inflation.
  private costOf(id: PowerupId): number {
    return powerupCost(POWERUPS[id].cost, this.run)
  }

  private canBuy(id: PowerupId): boolean {
    // The Dealer 6 duel locks abilities below 20% health.
    if (abilitiesLocked(this.run)) {
      return false
    }
    return this.phase === 'playing' && this.round !== null && this.run.tokens >= this.costOf(id)
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
