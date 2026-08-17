import { createShoe, shuffle, type Card, type Rank } from './deck'
import { cardValue, isBlackjack } from './hand'
import { replayHandHistory } from './hand-history'
import { bustChanceOnHit, computeAnalysis, dealerWinChance, NOTHING_KNOWN, type Analysis, type Knowledge } from './odds'
import { POWERUPS, type PowerupId } from './powerups'
import { createRng, type Rng, type SeededRng } from './random'
import {
  armSecondChance,
  canForcedSplit,
  canMulligan,
  canReturn,
  DEFAULT_ROUND_RULES,
  dealerSettleTotal,
  doubleDown,
  forcedSplit,
  freezeDealer,
  hit,
  isRedealRound,
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
  dealerHardHitCeiling,
  dealerUpcardReshuffleChance,
  getShift,
  hasAvailableUpgrade,
  hitTokens,
  maxHitsFor,
  powerupCost,
  SABOTAGE_DEALER21_ENERGY,
  spendTokens,
  startRun,
  tallyPerformance,
  tallyWash,
  type HandDecision,
  type RunState,
} from './run'
import { rulesForUpgrades, type RunUpgrades, type UpgradePath } from './upgrades'
import { recordRun } from './leaderboard'
import { clearRun, saveSession, type PersistedSession } from './persistence'

export const SHOE_DECKS = 6

// 'choosing-upgrade' holds the deal after a non-final kill until the player picks
// a roguelite upgrade; in the UI the dealer dies first, the selector shows, then the
// replacement's walk-in ceremony plays once the pick releases the deal.
export type Phase = 'betting' | 'playing' | 'resolved' | 'over' | 'choosing-upgrade' | 'coda'

// Dev URL overrides. ALL apply to the INITIAL run only — a New run (restart) forgets them and starts
// a clean default run (see forgetDevOverrides_), so a debug-seeded run never re-seeds itself.
export interface SessionOptions {
  /** Dev switch: force the player's opening two cards to be a splittable pair. */
  forcePairs?: boolean
  /** With forcePairs, an optional specific rank to pair; otherwise pairs the top card. */
  forcePairRank?: Rank | null
  /** Dev switch: seed the initial run with this many tokens; null = default. */
  startTokens?: number | null
  /** Dev switch: seed the initial run with this many score points; null = default (0). */
  startScore?: number | null
  /** Dev switch: start the initial run's first dealer at this % health (1-100); null = full. */
  dealerHealth?: number | null
  /** Dev switch: start the initial run with this many player hit points (1..MAX_HEARTS); null = full. */
  hearts?: number | null
  /** Dev switch: start the initial run at this dealer (1-based); null = the first dealer. */
  startDealer?: number | null
  /** Dev switch: replay this win(true)/loss(false) history into the opening dealer's fight; null = none. */
  handHistory?: boolean[] | null
  /** Dev switch: start the initial run with these unlocked upgrade tiers; null = none. */
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

// Decorrelates the per-hand rating's dealer-win Monte-Carlo (recordDecision_) from every other
// stream — so scoring the player's decisions never disturbs the deal sequence, the heal rolls,
// or an Analyze readout (which would otherwise draw from a stream the rating had advanced).
const RATING_SEED_SALT = 0x27d4eb2f

// Monte-Carlo trials for the rating's "chance the dealer beats me if I stand". Fewer than the
// Analyze readout's 4000 — a 6-bucket star rating doesn't need that precision, and this runs on
// every hit/stand, so keep it cheap.
const RATING_TRIALS = 1200

// The Banker coda's stripped rules: plain S17, no split (and no double/upgrades) — the
// double-or-nothing hand is pure hit/stand blackjack. See the coda* methods below.
const CODA_RULES: RoundRules = { ...DEFAULT_ROUND_RULES, allowSplit: false }

// Coda-ability token costs. Analyze is FLAT (inflation-independent) — a cheap, always-on odds
// read. The Mulligan is a BASE cost that IS inflation-adjusted (powerupCost, like the main-game
// powerups) — an expensive, run-scaling reroll.
export const CODA_ANALYZE_COST = 5
export const CODA_MULLIGAN_COST = 200

// The rewarded-ad payout: a flat energy grant for opting into a CrazyGames rewarded video. Small
// enough to stay off the "pay-to-win" line (energy buys help/info powerups, never damage) and
// capped (once per dealer, 3 per run) so it can't snowball; see [[powerup-design]].
export const REWARDED_AD_ENERGY = 100

export class Session {
  // The deal RNG — its `.state` is checkpointed into run.deckState so a resume reproduces the
  // upcoming shoe exactly (see deal/adoptSession). The analysis + heal RNGs need no snapshot: they're
  // re-derived from run.seed on resume (below), so they stay deterministic per save too.
  private nextRandom_: SeededRng
  private analysisRandom_: Rng
  private ratingRandom_: Rng
  private run_: RunState
  private round_: Round | null = null
  private phase_: Phase = 'betting'
  private peeked_ = false
  private analysis_: Analysis | null = null
  // The bust risk of the last surviving hit that paid points (see hit()); cleared by the
  // next move. Drives the UI's risk caption ("WHOA!"/"Lucky!"/"Nice").
  private lastHitRisk_: number | null = null
  // The player's terminal hit/stand decision per hand this round (indexed by hand, so a split's
  // two hands are tracked separately), captured live because the odds can't be reconstructed once
  // the deck advances. Read at settle_ to rate the hand (tallyPerformance); reset on each deal.
  private handDecisions_: (HandDecision | undefined)[] = []
  // Coda only: a pushed double-or-nothing hand flags the UI to auto-re-deal. Resets on each
  // coda deal (and on restart).
  private codaRedeal_ = false
  // Set at game-over (enterOver) when the final score set a new personal best. Read by the score
  // screen; reset on restart.
  private newPersonalBest_ = false
  // Set when a kill just advanced the dealer (and the run isn't won): the next
  // hand is gated on a choose-upgrade pick.
  private upgradePending_ = false
  // Dev URL overrides, seeded from SessionOptions. They apply to the INITIAL run only — a New run
  // (restart) forgets them (forgetDevOverrides_) so it always starts a clean default run and a
  // debug-seeded run can't re-seed the same state on restart. Not readonly for that reason.
  private forcePairs_: boolean
  private forcePairRank_: Rank | null
  private startTokens_: number | null
  private startScore_: number | null
  private dealerHealth_: number | null
  private startHearts_: number | null
  private startDealer_: number | null
  private handHistory_: boolean[] | null
  private startUpgrades_: RunUpgrades | null
  private forceDealerNatural_: boolean
  private forcePlayerNatural_: boolean

  constructor(seed: number, options: SessionOptions = {}) {
    this.nextRandom_ = createRng(seed)
    this.analysisRandom_ = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.ratingRandom_ = createRng(seed ^ RATING_SEED_SALT)
    this.forcePairs_ = options.forcePairs ?? false
    this.forcePairRank_ = options.forcePairRank ?? null
    this.startTokens_ = options.startTokens ?? null
    this.startScore_ = options.startScore ?? null
    this.dealerHealth_ = options.dealerHealth ?? null
    this.startHearts_ = options.hearts ?? null
    this.startDealer_ = options.startDealer ?? null
    this.handHistory_ = options.handHistory ?? null
    this.startUpgrades_ = options.startUpgrades ?? null
    this.forceDealerNatural_ = options.forceDealerNatural ?? false
    this.forcePlayerNatural_ = options.forcePlayerNatural ?? false
    this.run_ = this.freshRun_(seed)
  }

  // A new run, with any dev overrides (starting tokens, opening dealer, opening
  // dealer health) folded in.
  private freshRun_(seed: number): RunState {
    let run = startRun(seed)
    if (this.startTokens_ !== null) {
      run = { ...run, tokens: this.startTokens_ }
    }
    if (this.startScore_ !== null) {
      run = { ...run, score: this.startScore_ }
    }
    if (this.startDealer_ !== null && this.startDealer_ > 1) {
      // Jump to a later dealer: advance the shift index and seed the kills of the
      // dealers we skipped, so the "dealers left" pips and the win-at-6 count stay
      // consistent with having actually fought up to here.
      const kills: number[] = []
      for (let i = 1; i < this.startDealer_; i += 1) {
        kills.push(i)
      }
      // Full health for the jumped-to dealer — its own max, not Dealer 1's (or the bar
      // would open partway drained, e.g. 100/220 at Dealer 6).
      run = { ...run, shiftIndex: this.startDealer_, kills, integrity: maxHitsFor(this.startDealer_) }
    }
    if (this.handHistory_ !== null) {
      // Replay the synthetic win/loss history through the real reducer so score, dealer HP, hearts,
      // energy, and the round counter all match having actually played those hands on this dealer.
      // Applied from the dealer's full health (above) and BEFORE the explicit dealerHealth/hearts
      // knobs, so those still win if someone combines them. Kept as-is (history ignored) when the
      // history is invalid for a mid-fight state on this dealer — see replayHandHistory.
      const replayed = replayHandHistory(run, this.handHistory_)
      if (replayed !== null) {
        run = replayed
      }
    }
    if (this.dealerHealth_ !== null) {
      // dealerHealth is a percentage of the current dealer's own max health (hits).
      run = { ...run, integrity: Math.round((maxHitsFor(run.shiftIndex) * this.dealerHealth_) / 100) }
    }
    if (this.startHearts_ !== null) {
      // Seed the player's hit points so a low value reaches the pop/heal/heart-death VFX fast.
      run = { ...run, hitPoints: this.startHearts_ }
    }
    if (this.startUpgrades_ !== null) {
      run = { ...run, upgrades: this.startUpgrades_ }
    }
    return run
  }

  // Drop every dev URL override so subsequent runs + deals ignore them — the existing `!== null` /
  // boolean guards in freshRun_ and deal() then no-op. Called on New run (see restart).
  private forgetDevOverrides_(): void {
    this.forcePairs_ = false
    this.forcePairRank_ = null
    this.startTokens_ = null
    this.startScore_ = null
    this.dealerHealth_ = null
    this.startHearts_ = null
    this.startDealer_ = null
    this.handHistory_ = null
    this.startUpgrades_ = null
    this.forceDealerNatural_ = false
    this.forcePlayerNatural_ = false
  }

  snapshot(): SessionState {
    return {
      run: this.run_,
      round: this.round_,
      phase: this.phase_,
      peeked: this.peeked_,
      analysis: this.analysis_,
      abilitiesLocked: abilitiesLocked(this.run_),
      lastHitRisk: this.lastHitRisk_,
      codaRedeal: this.codaRedeal_,
      newPersonalBest: this.newPersonalBest_,
    }
  }

  deal(): void {
    if (this.phase_ !== 'betting') {
      return
    }
    const shoe = this.shuffleShoe_()
    // shuffleShoe_ just advanced the deal RNG past this hand's shoe; nothing advances it again until
    // the NEXT deal. checkpoint_ (below, and at every action) snapshots that live position into
    // run.deckState, so a resume restores the exact upcoming shoe — a reload can't reroll the deal.
    if (this.forcePairs_) {
      forcePlayerPair(shoe, this.forcePairRank_)
    }
    // Player natural runs after forcePairs (so it wins if both are set) and before the dealer
    // natural (which then re-seats the dealer's cards from deeper in the shoe).
    if (this.forcePlayerNatural_) {
      forcePlayerNaturalCards(shoe)
    }
    if (this.forceDealerNatural_) {
      forceDealerNaturalCards(shoe)
    }
    this.peeked_ = false
    this.analysis_ = null
    this.handDecisions_ = [] // a fresh hand: forget last round's decision snapshots
    // Fold the run's unlocked upgrades AND the current dealer's house rules (late
    // dealers hit soft 17) into this round's rules.
    const rules = {
      ...rulesForUpgrades(this.run_.upgrades),
      dealerSoft17: getShift(this.run_.shiftIndex).dealerSoft17,
      dealerHardHitCeiling: dealerHardHitCeiling(this.run_),
    }
    this.round_ = startRound(shoe, rules)
    if (this.round_.status === 'resolved') {
      this.settle_() // an opening natural — resolves straight to resolved/coda (or a push → redeal)
    } else {
      this.phase_ = 'playing'
    }
    // One checkpoint for the deal, whichever branch: persists the freshly-dealt hand (mid-hand
    // refresh resumes it exactly) or the natural's resolution. A no-op if the natural busted out.
    this.checkpoint_()
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
  //     that first hand the player keeps any natural (scored as a blackjack win) — an early-game buff.
  //   • Coda dealer natural — when `guardDealerNatural` is set (the Banker's double-or-nothing
  //     hands), any shoe dealing the DEALER a natural 21 (shoe[2]+shoe[3]) is rejected. The coda
  //     stakes the whole score with no powerups/sabotage, so an instant Banker blackjack would
  //     zero the run with zero player agency — we never let it happen. The player may still open
  //     on a natural (an instant coda win).
  // Reshuffling only advances the deal RNG, so the run stays fully deterministic for its seed,
  // and can't loop forever (the shoe always has compliant openings). Runs before the dev
  // switches so forceDealerNatural still wins.
  private shuffleShoe_(guardDealerNatural = false): Card[] {
    const upcardReshuffleChance = dealerUpcardReshuffleChance(this.run_.shiftIndex)
    const guardPlayerNatural = this.run_.shiftIndex === 1 && this.run_.handsThisDealer === 0
    // Whether to reject this shoe for its dealer up-card. Only 10/11-value up-cards are ever
    // rejected; the 100%/0% dealers resolve without a dice roll (so their RNG stream is untouched),
    // and the middle dealers roll the seeded RNG so the decision stays reproducible per seed.
    const rejectUpcard = (shoe: Card[]): boolean => {
      const upCard = shoe[2]
      if (upCard.rank !== 'A' && cardValue(upCard) !== 10) return false
      if (upcardReshuffleChance >= 1) return true
      if (upcardReshuffleChance <= 0) return false
      return this.nextRandom_() < upcardReshuffleChance
    }
    let shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom_)
    while (
      rejectUpcard(shoe) ||
      (guardPlayerNatural && isBlackjack([shoe[0], shoe[1]])) ||
      (guardDealerNatural && isBlackjack([shoe[2], shoe[3]]))
    ) {
      shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom_)
    }
    return shoe
  }

  // Snapshot the player's decision on the active hand for the end-of-run star rating (see
  // run.ts ratePlayerHand). Captured BEFORE the move lands, from public cards: the exact
  // bust-if-hit chance and the Monte-Carlo chance the dealer beats the current total if the
  // player stands. Overwrites each move, so the last one recorded is the hand's terminal call.
  // The dealer-win sim runs on its own decorrelated RNG, so rating never perturbs the deal.
  private recordDecision_(action: 'hit' | 'stand', bustChance?: number): void {
    if (this.phase_ !== 'playing' || this.round_ === null || this.round_.status !== 'player-turn') {
      return
    }
    const round = this.round_
    const pBust = bustChance ?? bustChanceOnHit(round)
    const pLose = dealerWinChance(round, NOTHING_KNOWN, this.ratingRandom_, RATING_TRIALS)
    this.handDecisions_[round.activeIndex] = { action, bustChance: pBust, standLoseChance: pLose }
  }

  hit(): void {
    if (this.phase_ !== 'playing') {
      return
    }
    const round = this.requireRound_()
    const hitIndex = round.activeIndex
    // Price the risk before taking it: the odds this hit busts (from public cards) set the token
    // reward (risk-priced — a hit that likely busts but survives pays the most).
    const bustChance = bustChanceOnHit(round)
    // Record this hit as the hand's (current) terminal decision — reusing the bust chance.
    this.recordDecision_('hit', bustChance)
    const tokenMult = round.rules.tokenMultiplier
    this.act_(() => hit(this.requireRound_())) // clears lastHitRisk; re-set below on survival
    if (this.round_ !== null && !this.round_.hands[hitIndex].busted) {
      // A surviving hit earns NO score — it only pays tokens (the powerup economy, scaled by the
      // Token eco multiplier), so the score never rewards hitting over correct standing. Risk stashed for the UI.
      this.run_ = addTokens(this.run_, Math.round(hitTokens(bustChance) * tokenMult))
      this.lastHitRisk_ = bustChance
    }
    this.checkpoint_() // after the token update above, so a refund isn't possible on refresh
  }

  stand(): void {
    this.recordDecision_('stand')
    this.act_(() => stand(this.requireRound_()))
    this.checkpoint_()
  }

  double(): void {
    // A double commits to exactly one more card then stands — an aggressive HIT decision,
    // judged at the pre-double total (the bust chance of that one card).
    this.recordDecision_('hit')
    this.act_(() => doubleDown(this.requireRound_()))
    this.checkpoint_()
  }

  split(): void {
    this.act_(() => split(this.requireRound_()))
    this.checkpoint_()
  }

  buyPeek(): void {
    if (!this.canBuy_('peek')) {
      return
    }
    this.analysis_ = null
    this.run_ = spendTokens(this.run_, this.costOf_('peek'))
    this.peeked_ = true
    // Persist the spend + the revealed-hole flag: a refresh now resumes mid-hand WITH the hole known
    // and the tokens gone, so you can't peek, read the hole, then refresh to refund the cost.
    this.checkpoint_()
  }

  // Read the odds and hold them in `analysis` until the next action clears them.
  // Blocked while a reading is already up, so it can't be paid for twice. Uses a
  // dedicated RNG so the simulation never touches the deal sequence.
  buyAnalyze(): void {
    if (!this.canBuy_('analyze') || this.analysis_ !== null) {
      return
    }
    const round = this.requireRound_()
    this.run_ = spendTokens(this.run_, this.costOf_('analyze'))
    // Fold in the dealer's hole card if Peek Dealer has revealed it: a known hole
    // is used outright instead of averaged over, so paying for more information
    // buys a more accurate reading.
    const knowledge: Knowledge = {
      hole: this.peeked_ ? round.dealer[1] : null,
    }
    this.analysis_ = computeAnalysis(round, knowledge, this.analysisRandom_)
    this.checkpoint_() // persist the token spend (the reading itself is transient, re-derivable)
  }

  buyLateDouble(): void {
    if (!this.canBuy_('late-double')) {
      return
    }
    this.run_ = spendTokens(this.run_, this.costOf_('late-double'))
    // Like a free Double: a terminal, aggressive HIT decision at the pre-double total.
    this.recordDecision_('hit')
    this.act_(() => lateDouble(this.requireRound_()))
    this.checkpoint_()
  }

  buyForcedSplit(): void {
    if (!this.canBuy_('forced-split') || !canForcedSplit(this.requireRound_())) {
      return
    }
    this.run_ = spendTokens(this.run_, this.costOf_('forced-split'))
    this.act_(() => forcedSplit(this.requireRound_()))
    this.checkpoint_()
  }

  buySecondChance(): void {
    if (!this.canBuy_('second-chance')) {
      return
    }
    this.analysis_ = null
    this.run_ = spendTokens(this.run_, this.costOf_('second-chance'))
    this.round_ = armSecondChance(this.requireRound_())
    this.checkpoint_()
  }

  buyFreezeDealer(): void {
    if (!this.canBuy_('freeze') || this.requireRound_().dealerFrozen) {
      return
    }
    this.analysis_ = null
    this.run_ = spendTokens(this.run_, this.costOf_('freeze'))
    this.round_ = freezeDealer(this.requireRound_())
    this.checkpoint_()
  }

  buyMulligan(): void {
    if (!this.canBuy_('mulligan') || !canMulligan(this.requireRound_())) {
      return
    }
    this.analysis_ = null
    this.run_ = spendTokens(this.run_, this.costOf_('mulligan'))
    this.round_ = mulligan(this.requireRound_())
    if (this.requireRound_().status === 'resolved') {
      this.settle_()
    }
    this.checkpoint_()
  }

  buyReturn(): void {
    if (!this.canBuy_('return') || !canReturn(this.requireRound_())) {
      return
    }
    this.analysis_ = null
    this.run_ = spendTokens(this.run_, this.costOf_('return'))
    this.round_ = returnCard(this.requireRound_())
    // Return auto-stands, which can hand the turn to the dealer and resolve the
    // round outright — settle if so, exactly like a normal stand.
    if (this.requireRound_().status === 'resolved') {
      this.settle_()
    }
    this.checkpoint_()
  }

  // --- The Banker coda: double-or-nothing on the whole score (see run.ts coda flow) ---

  // Deal one stripped double-or-nothing hand (no bet, no split/double). Only from the prompt
  // (no hand in progress). If it resolves at the deal (a natural), the outcome is left for
  // codaResolveNext so the UI can reveal the dealt cards first.
  codaGamble(): void {
    if (this.phase_ !== 'coda' || this.round_ !== null) {
      return
    }
    this.analysis_ = null
    this.codaRedeal_ = false
    // guardDealerNatural: the Banker must never open on a natural 21 (it would zero the whole
    // score instantly, with no player move and no coda sabotage to catch it).
    const shoe = this.shuffleShoe_(true)
    // Dev aid (?playerBlackjack): honour the forced player natural in the coda too, like deal()
    // — an instant coda WIN. Safe against the dealer-natural guard above: if seating the player's
    // natural incidentally leaves the Banker one, both-natural is a PUSH (re-deal), never a loss.
    if (this.forcePlayerNatural_) {
      forcePlayerNaturalCards(shoe)
    }
    // Coda gamble hands keep the bet-0 convention so codaResolveNext can tell them apart from the
    // (already-scored) main-game hand that ENTERED the coda, which carries the vestigial bet 1.
    const gamble = startRound(shoe, CODA_RULES)
    this.round_ = { ...gamble, hands: gamble.hands.map((hand) => ({ ...hand, bet: 0 })) }
    // Persist the dealt gamble + the advanced deal-RNG position, so a refresh resumes THIS gamble
    // (not a rewind that re-rolls it — the coda re-roll hole).
    this.checkpoint_()
  }

  codaHit(): void {
    if (this.phase_ !== 'coda' || this.round_ === null || this.round_.status !== 'player-turn') {
      return
    }
    this.analysis_ = null
    this.round_ = hit(this.round_) // a bust resolves the round; codaResolveNext reads the outcome
    this.checkpoint_()
  }

  codaStand(): void {
    if (this.phase_ !== 'coda' || this.round_ === null || this.round_.status !== 'player-turn') {
      return
    }
    this.analysis_ = null
    this.round_ = stand(this.round_)
    this.checkpoint_()
  }

  // Advance the coda past the resolved hand on the table — called by the UI after the reveal
  // (or, at coda entry, after the boss-death + Banker ceremony). The main-game hand that
  // ENTERED the coda carries a real bet and was already scored by applyRound, so it's simply
  // dismissed to reveal the prompt. A coda double-or-nothing hand (bet 0) applies its outcome:
  // a win DOUBLES the score and returns to the prompt; a push re-deals (score unchanged); any
  // loss or bust ZEROES the score and ends the run. A losing coda hand is left on the table for
  // the game-over shred; the round is cleared only on a win/push (or the dismissed killing hand).
  codaResolveNext(): void {
    if (this.phase_ !== 'coda' || this.round_ === null || this.round_.status !== 'resolved') {
      return
    }
    const hand = this.round_.hands[0]
    this.analysis_ = null
    if (hand.bet > 0) {
      // The killing hand from the main game — already scored; just dismiss it to the prompt.
      this.round_ = null
      this.codaRedeal_ = false
    } else {
      const outcome = hand.outcome
      if (outcome === 'win' || outcome === 'blackjack') {
        this.run_ = { ...this.run_, score: this.run_.score * 2 }
        this.round_ = null
        this.codaRedeal_ = false
      } else if (outcome === 'push' || outcome === 'voided') {
        this.round_ = null
        this.codaRedeal_ = true
      } else {
        this.run_ = { ...this.run_, score: 0 }
        this.enterOver_() // a coda bust ends the run — cleared, nothing left to resume
        return
      }
    }
    // Back at the coda prompt (or a push re-deal): checkpoint so a refresh resumes the prompt, not a
    // rewind that would let the player retry the double-or-nothing.
    this.checkpoint_()
  }

  // Walk away from the coda, banking the current score. Only from the prompt (no hand up).
  codaCashOut(): void {
    if (this.phase_ !== 'coda' || this.round_ !== null) {
      return
    }
    this.run_ = { ...this.run_, cashedOut: true }
    this.enterOver_()
  }

  // Coda Analyze: cheap, flat-priced, ALWAYS fires — the "should I let it ride?" odds readout.
  codaAnalyze(): void {
    if (this.phase_ !== 'coda' || this.round_ === null || this.round_.status !== 'player-turn') {
      return
    }
    if (this.analysis_ !== null || this.run_.tokens < CODA_ANALYZE_COST) {
      return
    }
    this.run_ = spendTokens(this.run_, CODA_ANALYZE_COST)
    this.analysis_ = computeAnalysis(this.round_, { hole: null }, this.analysisRandom_)
    this.checkpoint_() // persist the token spend
  }

  // Coda Mulligan: expensive, flat-priced — discards the opening two and redraws (guaranteed,
  // no gamble). Only on an untouched opening hand (canMulligan) and if affordable.
  codaMulligan(): void {
    if (this.phase_ !== 'coda' || this.round_ === null || !canMulligan(this.round_)) {
      return
    }
    const cost = powerupCost(CODA_MULLIGAN_COST, this.run_)
    if (this.run_.tokens < cost) {
      return
    }
    this.analysis_ = null
    this.run_ = spendTokens(this.run_, cost)
    this.round_ = mulligan(this.round_)
    this.checkpoint_()
  }

  nextHand(): void {
    if (this.phase_ !== 'resolved') {
      return
    }
    this.round_ = null
    this.analysis_ = null
    // A kill grants an upgrade pick: hold in choose-upgrade until the player picks
    // (the walk-in ceremony plays after the pick), unless every path is already maxed.
    this.phase_ = this.upgradePending_ && hasAvailableUpgrade(this.run_) ? 'choosing-upgrade' : 'betting'
    this.upgradePending_ = false
    // Saves the 'betting' transition; a no-op at 'choosing-upgrade' (checkpoint_ skips it), which
    // preserves the prior 'resolved' + upgradePending save so a refresh there still offers the pick.
    this.checkpoint_()
  }

  // Apply the chosen roguelite upgrade and release the held deal. No-op unless the
  // player is actually on the choose-upgrade screen.
  chooseUpgrade(path: UpgradePath): void {
    if (this.phase_ !== 'choosing-upgrade') {
      return
    }
    this.run_ = applyUpgrade(this.run_, path)
    this.phase_ = 'betting'
    // The upgrade mutated the run (new roguelite tier) — re-checkpoint so a resume keeps it.
    this.checkpoint_()
  }

  // Grant the rewarded-ad payout (+REWARDED_AD_ENERGY). Inflation-neutral: credited straight to the
  // spendable balance, NOT via addTokens (which would also pad tokensThisShift and make later
  // powerups pricier). Stamps the shiftIndex it paid for + bumps the per-run count so the once-per-
  // dealer / 3-per-run caps hold, then checkpoints so a mid-run reload can't reset them and re-farm.
  // Called only from the rewarded ad's onReward callback — never on adError (no reward on a
  // failed/unfilled ad). The caps themselves are enforced by the button's visibility gate.
  grantRewardedEnergy(): void {
    this.run_ = {
      ...this.run_,
      tokens: this.run_.tokens + REWARDED_AD_ENERGY,
      rewardedAdShiftIndex: this.run_.shiftIndex,
      rewardedAdsThisRun: this.run_.rewardedAdsThisRun + 1,
    }
    this.checkpoint_()
  }

  // Record that the player passed on an OFFERED rewarded ad — they advanced past it without taking
  // it, or the request came back unfilled. Stamps the current handsPlayed so the offer stays down
  // for AD_OFFER_COOLDOWN_HANDS hands, and checkpoints so a reload can't wipe the "no" and put the
  // offer straight back up. Unlike grantRewardedEnergy this spends no cap: passing on an ad (or an
  // ad that never filled) costs the player nothing, so only the cadence moves.
  declineRewardedAd(): void {
    this.run_ = { ...this.run_, adDeclinedAtHand: this.run_.handsPlayed }
    this.checkpoint_()
  }

  // Resume a saved in-progress session (the title "Continue"). Restores the EXACT phase + in-progress
  // round + flags — not just the RunState — so a refresh resumes precisely where the player was: a
  // mid-hand reload shows the same cards on the same turn, a coda reload lands back in the coda. This
  // exactness is the anti-cheat: it removes the rewind-to-an-earlier-checkpoint window that let a
  // refresh replay a lost hand (see persistence).
  //
  // It RE-SEEDS the RNGs from the SAVE, not from construction: the deal RNG is restored to
  // run.deckState — the checkpoint refreshes that to the LIVE stream position on every save (so it's
  // correct mid-coda too, where codaGamble advances the RNG outside deal()). Byte-for-byte the same
  // shoe on every reload, so a player can't reload-spam to reroll. The Analyze/heal/rating RNGs are
  // re-derived from run.seed (their salted streams restart from origin — harmless, they don't touch
  // the card sequence, and stay deterministic per save, so a reload can't reroll a dealer's heal).
  adoptSession(saved: PersistedSession): void {
    const run = saved.run
    this.nextRandom_ = createRng(run.deckState)
    this.analysisRandom_ = createRng(run.seed ^ ANALYSIS_SEED_SALT)
    this.ratingRandom_ = createRng(run.seed ^ RATING_SEED_SALT)
    this.run_ = run
    this.round_ = saved.round
    this.peeked_ = saved.peeked
    this.analysis_ = null
    this.lastHitRisk_ = null
    this.handDecisions_ = []
    this.codaRedeal_ = saved.codaRedeal
    this.newPersonalBest_ = false
    this.upgradePending_ = saved.upgradePending
    this.phase_ = saved.phase
  }

  restart(): void {
    // A New run is a CLEAN run: forget every dev URL override (dealer=, points=, forcePairs,
    // dealerHealth, upgrades, forced naturals…) so restarting from a debug-seeded run can't re-seed
    // the same (possibly broken) state — New run always starts a default first-dealer run.
    this.forgetDevOverrides_()
    const seed = generateSeed()
    this.nextRandom_ = createRng(seed)
    this.analysisRandom_ = createRng(seed ^ ANALYSIS_SEED_SALT)
    this.ratingRandom_ = createRng(seed ^ RATING_SEED_SALT)
    this.run_ = this.freshRun_(seed)
    this.round_ = null
    this.peeked_ = false
    this.analysis_ = null
    this.lastHitRisk_ = null
    this.handDecisions_ = []
    this.codaRedeal_ = false
    this.newPersonalBest_ = false
    this.upgradePending_ = false
    this.phase_ = 'betting'
  }

  private act_(transition: () => Round): void {
    if (this.phase_ !== 'playing') {
      return
    }
    // Any player move dismisses a live Analyze reading — the odds were only valid
    // for the pre-move table. The prior hit's risk caption clears too (hit()
    // re-sets it if THIS move is a surviving hit).
    this.analysis_ = null
    this.lastHitRisk_ = null
    this.round_ = transition()
    if (this.requireRound_().status === 'resolved') {
      this.settle_()
    }
  }

  private settle_(): void {
    const round = this.requireRound_()
    // Sabotage T1: the dealer reaching 21 — a dealt natural OR a hit-to-21 — pays a flat energy bonus,
    // whatever the outcome (a loss, a T2 void/redeal, a T3 hijack win, or a Payout-T3 push-win). Credited
    // HERE, before the wash short-circuit below, so a voided dealer 21 (which never reaches applyRound)
    // still pays it. Feeds tokensThisShift like any energy, so applyRound's inflation tally picks it up.
    if (round.rules.dealer21Energy && dealerSettleTotal(round) === 21) {
      this.run_ = addTokens(this.run_, SABOTAGE_DEALER21_ENERGY)
    }
    // A round that lands nothing — every hand pushed/voided (no Payout T3) — is a WASH: it consumes
    // no window slot and doesn't score. Leave the run untouched (phase 'resolved') and let the UI
    // redeal a fresh hand (it detects the wash via round.isRedealRound).
    if (isRedealRound(round)) {
      // Still tally it for the score screen's push % — it's the only place a wash is ever recorded.
      this.run_ = tallyWash(this.run_)
      this.phase_ = 'resolved'
      return
    }
    const beforeKills = this.run_.kills.length
    this.run_ = applyRound(this.run_, round)
    // Fold in the display-only performance tallies (bust %, blackjack %, star rating) from the
    // decisions captured this hand. Only main-game hands reach settle_ — coda hands resolve in
    // codaResolveNext — so the metrics stay scoped to the run proper, as intended.
    const ratedBefore = this.run_.ratedHands
    const ratingSumBefore = this.run_.ratingSum
    this.run_ = tallyPerformance(this.run_, round, this.handDecisions_)
    // Dev aid: log this dealer 1–6 hand's star rating as it resolves. Compiled out of the
    // production build (import.meta.env.DEV). Only fires when the hand was actually rated.
    if (import.meta.env.DEV && this.run_.ratedHands > ratedBefore) {
      const rating = this.run_.ratingSum - ratingSumBefore
      console.log(`PLAYER HAND RATING: ${Number.isInteger(rating) ? rating : rating.toFixed(1)}/5`)
    }
    // A KILL (kills grew, and it wasn't the 6th → coda) earns an upgrade pick, taken after the next
    // hand. A window-out that merely ADVANCES the dealer (no kill) must NOT arm the selector.
    if (!this.run_.over && !this.run_.coda && this.run_.kills.length > beforeKills) {
      this.upgradePending_ = true
    }
    // settle_ only RESOLVES the round (compute + set phase); the CALLER checkpoints exactly once
    // afterwards. So the coda + the finished hand get persisted (the coda refresh-escape fix).
    if (this.run_.over) {
      this.enterOver_() // never reached now (no chip bust-out) — kept as a defensive funnel
    } else if (this.run_.coda) {
      this.phase_ = 'coda' // Dealer 6 fell, or its window ran out — the Banker always comes out
    } else {
      this.phase_ = 'resolved'
    }
  }

  // Persist the EXACT live session so a refresh resumes precisely here — same phase, same in-progress
  // round, same peeked / coda flags. Called after every state-changing action (not only at settle),
  // so a mid-hand or mid-coda reload can't rewind to an earlier checkpoint and replay the hand.
  //
  // Skipped when the run is over (enterOver_ has already cleared the save — a finished run must never
  // resume) or at the transient 'choosing-upgrade' gate (its prior 'resolved' checkpoint carries
  // upgradePending, so resuming there flows resolved → Next → pick).
  //
  // We also refresh run.deckState to the LIVE deal-RNG position here. In the main game that equals
  // the deal-time value (nothing advances the RNG mid-hand), but the coda's codaGamble advances the
  // RNG WITHOUT going through deal() — so checkpointing the live position is what makes a resumed
  // coda deal the same next gamble, closing the coda re-roll hole.
  private checkpoint_(): void {
    if (this.phase_ === 'over' || this.phase_ === 'choosing-upgrade') {
      return
    }
    this.run_ = { ...this.run_, deckState: this.nextRandom_.state }
    saveSession({
      run: this.run_,
      phase: this.phase_,
      round: this.round_,
      peeked: this.peeked_,
      codaRedeal: this.codaRedeal_,
      upgradePending: this.upgradePending_,
    })
  }

  // The single game-end choke point: mark the run over, surface the score screen, and record the
  // final score exactly once. Every ending funnels here — a chip bust-out (settle), a coda bust,
  // and a coda cash-out — so the leaderboard/personal-best hook lives in one place. recordRun
  // submits the score to CrazyGames AND folds it into the local personal best, reporting back
  // whether it set a new record. The score is recorded as-is: 0 on a coda bust (you gamble the
  // whole score, record included), which can never become a new best.
  private enterOver_(): void {
    if (!this.run_.over) {
      this.run_ = { ...this.run_, over: true }
    }
    this.phase_ = 'over'
    this.newPersonalBest_ = recordRun(this.run_.score).isNewBest
    clearRun() // nuke the in-progress save — a finished run must never resume
  }

  // A powerup's live cost — its base price inflated by the run's token inflation.
  private costOf_(id: PowerupId): number {
    return powerupCost(POWERUPS[id].cost, this.run_)
  }

  private canBuy_(id: PowerupId): boolean {
    // The Dealer 6 duel locks abilities below 20% health.
    if (abilitiesLocked(this.run_)) {
      return false
    }
    return this.phase_ === 'playing' && this.round_ !== null && this.run_.tokens >= this.costOf_(id)
  }

  private requireRound_(): Round {
    if (!this.round_) {
      throw new Error('no active round')
    }
    return this.round_
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
