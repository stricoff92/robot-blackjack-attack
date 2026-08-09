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
  DEFAULT_ROUND_RULES,
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
  type RoundRules,
} from './round'
import {
  addTokens,
  applyRound,
  applyUpgrade,
  abilitiesLocked,
  bumpCombo,
  dealerHardHitCeiling,
  dealerUpcardReshuffleChance,
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
import { recordRun } from './leaderboard'
import { clearRun, saveRun } from './persistence'

export const SHOE_DECKS = 6

// 'choosing-upgrade' holds the deal after a non-final kill until the player picks
// a roguelite upgrade; in the UI the dealer dies first, the selector shows, then the
// replacement's walk-in ceremony plays once the pick releases the deal.
export type Phase = 'betting' | 'playing' | 'resolved' | 'over' | 'choosing-upgrade' | 'coda'

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
  /** Dev switch: force the player's opening two cards to be a natural 21 every deal. */
  forcePlayerNatural?: boolean
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
  /** Coda only: a pushed double-or-nothing hand asks the UI to auto-re-deal (no re-prompt). */
  codaRedeal: boolean
  /** Set at game-over when the run's final score beat the stored personal best (drives the
   *  score screen's "NEW BEST" flair). False during play and on any non-record ending. */
  newPersonalBest: boolean
}

// Decorrelates the Analyze simulator's RNG from the deal RNG, so running odds
// never disturbs the card sequence (and the sequence is the same whether or not
// the player ever buys Analyze).
const ANALYSIS_SEED_SALT = 0x5f356495

// Decorrelates the heal-on-win roll from the deal RNG, so a healing dealer's repair
// amount never disturbs the card sequence (like ANALYSIS_SEED_SALT does for Analyze).
const HEAL_SEED_SALT = 0x1b873593

// The Banker coda's stripped rules: plain S17, no split (and no double/upgrades) — the
// double-or-nothing hand is pure hit/stand blackjack. See the coda* methods below.
const CODA_RULES: RoundRules = { ...DEFAULT_ROUND_RULES, allowSplit: false }

// Coda-ability token costs. Analyze is FLAT (inflation-independent) — a cheap, always-on odds
// read. The Mulligan is a BASE cost that IS inflation-adjusted (powerupCost, like the main-game
// powerups) — an expensive, run-scaling reroll.
export const CODA_ANALYZE_COST = 5
export const CODA_MULLIGAN_COST = 200

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
  // Coda only: a pushed double-or-nothing hand flags the UI to auto-re-deal. Resets on each
  // coda deal (and on restart).
  private codaRedeal = false
  // Set at game-over (enterOver) when the final score set a new personal best. Read by the score
  // screen; reset on restart.
  private newPersonalBest = false
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
  private readonly forcePlayerNatural: boolean

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
    this.forcePlayerNatural = options.forcePlayerNatural ?? false
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
      codaRedeal: this.codaRedeal,
      newPersonalBest: this.newPersonalBest,
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
    // Player natural runs after forcePairs (so it wins if both are set) and before the dealer
    // natural (which then re-seats the dealer's cards from deeper in the shoe).
    if (this.forcePlayerNatural) {
      forcePlayerNaturalCards(shoe)
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

  // Shuffle a fresh 6-deck shoe for the deal, honoring the opening-deal guard rails (see the
  // rules doc §2). Two independent rails can each reject a shoe and force a reshuffle:
  //   • Dealer up-card — a 10/11-value FACE-UP card (shoe[2] = round.dealer[0]: an Ace, or any
  //     ten-value card) is discarded with the current dealer's reshuffle probability, which
  //     ramps DOWN per dealer (Dealer 1 100% → 5 & 6 0%; see dealerUpcardReshuffleChance). So
  //     Dealer 1 NEVER shows a menacing up-card (and, since a natural needs an Ace paired with a
  //     ten, can't open on a natural blackjack either), while late dealers deal honestly. The
  //     roll uses the seeded deal RNG so runs stay deterministic; the 100%/0% ends short-circuit
  //     WITHOUT drawing from it, so those dealers' shoe streams are unchanged by this knob.
  //   • Player side — only on the very FIRST hand of Dealer 1, the player can't open on a
  //     natural either (shoe[0]+shoe[1]). This is NOT a debuff: it dodges a UI/UX corner case
  //     in the opening deal (an instant blackjack resolving before the player has acted). After
  //     that first hand the player keeps any natural (with its 3:2 payout) — an early-game buff.
  //   • Coda dealer natural — when `guardDealerNatural` is set (the Banker's double-or-nothing
  //     hands), any shoe dealing the DEALER a natural 21 (shoe[2]+shoe[3]) is rejected. The coda
  //     stakes the whole score with no powerups/sabotage, so an instant Banker blackjack would
  //     zero the run with zero player agency — we never let it happen. The player may still open
  //     on a natural (an instant coda win).
  // Reshuffling only advances the deal RNG, so the run stays fully deterministic for its seed,
  // and can't loop forever (the shoe always has compliant openings). Runs before the dev
  // switches so forceDealerNatural still wins.
  private shuffleShoe(guardDealerNatural = false): Card[] {
    const upcardReshuffleChance = dealerUpcardReshuffleChance(this.run.shiftIndex)
    const guardPlayerNatural = this.run.shiftIndex === 1 && this.run.handsThisDealer === 0
    // Whether to reject this shoe for its dealer up-card. Only 10/11-value up-cards are ever
    // rejected; the 100%/0% dealers resolve without a dice roll (so their RNG stream is untouched),
    // and the middle dealers roll the seeded RNG so the decision stays reproducible per seed.
    const rejectUpcard = (shoe: Card[]): boolean => {
      const upCard = shoe[2]
      if (upCard.rank !== 'A' && cardValue(upCard) !== 10) return false
      if (upcardReshuffleChance >= 1) return true
      if (upcardReshuffleChance <= 0) return false
      return this.nextRandom() < upcardReshuffleChance
    }
    let shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom)
    while (
      rejectUpcard(shoe) ||
      (guardPlayerNatural && isBlackjack([shoe[0], shoe[1]])) ||
      (guardDealerNatural && isBlackjack([shoe[2], shoe[3]]))
    ) {
      shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom)
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

  // --- The Banker coda: double-or-nothing on the whole score (see run.ts coda flow) ---

  // Deal one stripped double-or-nothing hand (no bet, no split/double). Only from the prompt
  // (no hand in progress). If it resolves at the deal (a natural), the outcome is left for
  // codaResolveNext so the UI can reveal the dealt cards first.
  codaGamble(): void {
    if (this.phase !== 'coda' || this.round !== null) {
      return
    }
    this.analysis = null
    this.codaRedeal = false
    // guardDealerNatural: the Banker must never open on a natural 21 (it would zero the whole
    // score instantly, with no player move and no coda sabotage to catch it).
    this.round = startRound(this.shuffleShoe(true), 0, CODA_RULES)
  }

  codaHit(): void {
    if (this.phase !== 'coda' || this.round === null || this.round.status !== 'player-turn') {
      return
    }
    this.analysis = null
    this.round = hit(this.round) // a bust resolves the round; codaResolveNext reads the outcome
  }

  codaStand(): void {
    if (this.phase !== 'coda' || this.round === null || this.round.status !== 'player-turn') {
      return
    }
    this.analysis = null
    this.round = stand(this.round)
  }

  // Advance the coda past the resolved hand on the table — called by the UI after the reveal
  // (or, at coda entry, after the boss-death + Banker ceremony). The main-game hand that
  // ENTERED the coda carries a real bet and was already scored by applyRound, so it's simply
  // dismissed to reveal the prompt. A coda double-or-nothing hand (bet 0) applies its outcome:
  // a win DOUBLES the score and returns to the prompt; a push re-deals (score unchanged); any
  // loss or bust ZEROES the score and ends the run. A losing coda hand is left on the table for
  // the game-over shred; the round is cleared only on a win/push (or the dismissed killing hand).
  codaResolveNext(): void {
    if (this.phase !== 'coda' || this.round === null || this.round.status !== 'resolved') {
      return
    }
    const hand = this.round.hands[0]
    this.analysis = null
    if (hand.bet > 0) {
      // The killing hand from the main game — already scored; just dismiss it to the prompt.
      this.round = null
      this.codaRedeal = false
      return
    }
    const outcome = hand.outcome
    if (outcome === 'win' || outcome === 'blackjack') {
      this.run = { ...this.run, score: this.run.score * 2 }
      this.round = null
      this.codaRedeal = false
    } else if (outcome === 'push' || outcome === 'voided') {
      this.round = null
      this.codaRedeal = true
    } else {
      this.run = { ...this.run, score: 0 }
      this.enterOver()
    }
  }

  // Walk away from the coda, banking the current score. Only from the prompt (no hand up).
  codaCashOut(): void {
    if (this.phase !== 'coda' || this.round !== null) {
      return
    }
    this.run = { ...this.run, cashedOut: true }
    this.enterOver()
  }

  // Coda Analyze: cheap, flat-priced, ALWAYS fires — the "should I let it ride?" odds readout.
  codaAnalyze(): void {
    if (this.phase !== 'coda' || this.round === null || this.round.status !== 'player-turn') {
      return
    }
    if (this.analysis !== null || this.run.tokens < CODA_ANALYZE_COST) {
      return
    }
    this.run = spendTokens(this.run, CODA_ANALYZE_COST)
    this.analysis = computeAnalysis(this.round, { hole: null }, this.analysisRandom)
  }

  // Coda Mulligan: expensive, flat-priced — discards the opening two and redraws (guaranteed,
  // no gamble). Only on an untouched opening hand (canMulligan) and if affordable.
  codaMulligan(): void {
    if (this.phase !== 'coda' || this.round === null || !canMulligan(this.round)) {
      return
    }
    const cost = powerupCost(CODA_MULLIGAN_COST, this.run)
    if (this.run.tokens < cost) {
      return
    }
    this.analysis = null
    this.run = spendTokens(this.run, cost)
    this.round = mulligan(this.round)
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
    // The upgrade mutated the run (new roguelite tier) — re-checkpoint so a resume keeps it.
    saveRun(this.run)
  }

  // Resume a saved in-progress run (the title "Continue"). Adopts the restored RunState and
  // reopens at the betting screen; the RNGs keep the fresh seed from construction (a resumed run
  // gets an unpredictable next shoe — no save-scumming the deal). The saved run is never over or
  // in the coda (persistence.loadRun rejects those), so betting is always the right phase.
  adoptRun(run: RunState): void {
    this.run = run
    this.round = null
    this.peeked = false
    this.analysis = null
    this.lastHitRisk = null
    this.codaRedeal = false
    this.newPersonalBest = false
    this.upgradePending = false
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
    this.codaRedeal = false
    this.newPersonalBest = false
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
    // A non-final kill (the dealer advanced, but it wasn't the 6th) earns an upgrade pick,
    // taken after the player calls the next hand. The 6th kill enters the coda instead, so
    // it must never arm an upgrade selector.
    if (!this.run.over && !this.run.coda && this.run.shiftIndex > beforeShift) {
      this.upgradePending = true
    }
    if (this.run.over) {
      this.enterOver() // a chip bust-out — funnel through the single submit seam
    } else if (this.run.coda) {
      this.phase = 'coda' // the 6th dealer fell → the Banker coda begins (not persisted)
    } else {
      this.phase = 'resolved'
      // Checkpoint the finished hand so a mid-run quit resumes here (the in-progress next hand
      // isn't saved, so quitting mid-hand rewinds to this stable between-hands state).
      saveRun(this.run)
    }
  }

  // The single game-end choke point: mark the run over, surface the score screen, and record the
  // final score exactly once. Every ending funnels here — a chip bust-out (settle), a coda bust,
  // and a coda cash-out — so the leaderboard/personal-best hook lives in one place. recordRun
  // submits the score to CrazyGames AND folds it into the local personal best, reporting back
  // whether it set a new record. The score is recorded as-is: 0 on a coda bust (you gamble the
  // whole score, record included), which can never become a new best.
  private enterOver(): void {
    if (!this.run.over) {
      this.run = { ...this.run, over: true }
    }
    this.phase = 'over'
    this.newPersonalBest = recordRun(this.run.score).isNewBest
    clearRun() // nuke the in-progress save — a finished run must never resume
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

// Dev aid: reorder the shoe so the player's opening two cards (shoe[0], shoe[1]) make a natural
// 21 — one Ace and one ten-value card. Pulls them from deeper in the shoe (index 2+), leaving the
// rest as dealt; runs before forceDealerNaturalCards (which re-seats shoe[2..3] from index 4+), so
// the two compose. A 6-deck shoe always has both to spare.
function forcePlayerNaturalCards(shoe: Card[]): void {
  if (isBlackjack([shoe[0], shoe[1]])) {
    return // already a natural
  }
  seatPlayerCard(shoe, 0, (card) => card.rank === 'A')
  seatPlayerCard(shoe, 1, (card) => cardValue(card) === 10)
}

// Swap a card matching `pred` into player slot `pos` from deeper in the shoe (past the two dealt
// player cards), unless the slot already satisfies it.
function seatPlayerCard(shoe: Card[], pos: number, pred: (card: Card) => boolean): void {
  if (pred(shoe[pos])) {
    return
  }
  for (let i = 2; i < shoe.length; i++) {
    if (pred(shoe[i])) {
      swap(shoe, pos, i)
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
