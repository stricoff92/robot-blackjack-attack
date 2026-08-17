import { isBlackjack } from './hand'
import { handReward } from './rewards'
import { handWeight, isWinningHand, roundTally, type HandResult, type PlayerHand, type Round, type Soft17Rule } from './round'
import {
  blackjackPointBonusFor,
  bumpUpgrade,
  emptyUpgrades,
  hasAvailableUpgrade as hasAvailableUpgradeFor,
  inflationResistanceFor,
  tokenMultiplierFor,
  type RunUpgrades,
  type UpgradePath,
} from './upgrades'

// Bumped whenever resolution/reward maths change, so stale replays are invalidated.
// … (see git history for v4–v28) …
// v29: economy rework — chips/bankroll removed entirely. Dealer health is now an integer HIT
//      count (maxHits 5..10); every winning hand deals its WEIGHT in hits (1, or 2 if doubled).
//      Each dealer deals a fixed WINDOW of hands (maxHands); running it out with the dealer alive
//      makes it walk off with no upgrade. A kill CASHES IN every remaining window slot as a bonus
//      win. Score is per-win off a cumulative counter: POINTS_BASE × POINTS_GROWTH^(wins−1). The
//      bet ladder, wealth floor, bankruptcy coda, chip payout, runMultiplier (1.5^kills), the flat
//      kill score-bounty, and the free-double score bonus are all gone. The banker coda now always
//      fires at the end of Dealer 6 (killed OR window-out). Doubles/splits carry their risk as
//      weight (double win = 2 wins/2 hits, double loss = 2 window slots; split hands independent).
// v30: removed the hit-streak combo multiplier — it punished correct standing (only surviving HITS
//      built it) and duplicated the win-count curve. Score is now purely the cumulative-win curve;
//      surviving hits still pay tokens. RunState.combo dropped, so v29 saves are discarded.
// v31: player HEARTS (hit points) added — 5 heart-chips. A losing round pops one; qualifying wins
//      heal one back (buffed streak / natural or hijacked blackjack / double-win). Running the
//      hearts out ends the current dealer early and drops into the coda, with NO score penalty. New
//      RunState fields hearts/roundWins change the shape, so v30 saves are discarded.
// v32: Sabotage T1 re-themed — the old "25% points on a loss to a dealer natural" consolation is
//      replaced by a flat +20 ENERGY on ANY dealer 21 (dealt natural or hit-to-21), credited in
//      Session.settle_ so it also fires on a T2-voided 21 and stacks on a T3 hijack. The
//      dealerNaturalConsolation rule flag + lostToDealerNatural hand field + CONSOLATION_FRACTION
//      scoring are gone (RoundRules/PlayerHand shape changed), so v31 saves are discarded.
// v33: rewarded-ad usage counters (rewardedAdsThisRun / rewardedAdShiftIndex) added to RunState so
//      the once-per-dealer + 3-per-run rewarded-ad caps survive a mid-run reload (anti-farm). New
//      fields change the save shape, so v32 saves are discarded.
// v34: the rewarded-ad "ignore = no" cooldown (adDeclinedAtHand) moved from a view field into
//      RunState, so declining an offer survives a reload instead of letting the nag come straight
//      back. The vestigial `won` flag is gone with it — it was initialised false and never set
//      true by any path (the Banker coda replaced the boss-defeat ending), so it only ever
//      serialised dead weight and read as if it meant something. Both change the save shape, so
//      v33 saves are discarded.
export const RULES_VERSION = 34

// Tokens the player opens a run with — a small buffer so the early powerups
// (Peek/Bust Block/Mulligan) are reachable before token income ramps up.
export const STARTING_TOKENS = 100
// The run is won by destroying this many dealers; there is no dealer beyond it.
export const TOTAL_DEALERS = 6

// Player hit points, shown as heart-chips above the HUD. A losing round pops one; running them out
// ends the current dealer early and drops into the coda (no score penalty — see [[banker-coda]]).
// Wins heal (see heartsAfterRound). This, the lookback, and the kill heal are the balance knobs.
export const MAX_HEARTS = 8
// A plain win heals a heart only if the player also won AT LEAST ONE of the last HEART_HEAL_LOOKBACK
// SCORED rounds. 1 = strict (two wins in a row); 2 = buffed (a W-L-W pattern still heals, surviving a
// single intervening loss). Buffed is the shipped default: in a house-edge game it rewards win-RATE
// over hot streaks. Natural/hijacked blackjacks and double-wins heal unconditionally (heartsAfterRound).
export const HEART_HEAL_LOOKBACK = 2
// Beating (destroying) a dealer heals this many hearts — a milestone reward, bigger than the ordinary
// per-win heal it supersedes on that round.
export const HEART_KILL_HEAL = 2

export const DESTROY_TOKEN = 40

// RunState.adDeclinedAtHand when the player has never passed on a rewarded-ad offer: far enough
// below any real handsPlayed that the cooldown subtraction always clears. Deliberately FINITE —
// the natural choice here is -Infinity, but this value is JSON.stringify'd into the save, and
// JSON has no infinity: it would round-trip as `null` and poison the arithmetic on the far side.
export const AD_NEVER_DECLINED = Number.MIN_SAFE_INTEGER

// Sabotage T1 (any Sabotage tier): a flat ENERGY bonus paid whenever the dealer reaches 21 — a dealt
// natural OR a hit-to-21 — regardless of the hand's outcome (a loss, a T2 void/redeal, a T3 hijack
// win, or a Payout-T3 push-win). Credited in Session.settle_ (not applyRound) so it also lands on a
// voided round, which never reaches applyRound. Flat (not scaled by the Energy token multiplier).
export const SABOTAGE_DEALER21_ENERGY = 20

// A surviving hit (the blackjack HIT action) pays tokens scaled by how risky it was: the base for
// a safe hit, climbing to base+bonus for a hit that was very likely to bust but landed anyway.
export const HIT_TOKEN_BASE = 1
export const HIT_TOKEN_MAX_BONUS = 9

export function hitTokens(bustChance: number): number {
  const risk = Math.min(1, Math.max(0, bustChance))
  return HIT_TOKEN_BASE + Math.round(risk * HIT_TOKEN_MAX_BONUS)
}

// A surviving hit (the blackjack HIT action) earns NO points — it only pays tokens (hitTokens,
// risk-priced, the powerup economy). Score comes purely from WINNING hands (see applyRound), so the
// score never punishes correct standing.

// Points curve: a WIN at cumulative ordinal `n` scores POINTS_BASE × POINTS_GROWTH^(n−1). The win
// counter never resets across the run, so every win permanently raises the rate for all wins ahead.
// A full clear lands ~100 wins → ~7M total. Bonus (cash-in) wins score off the same curve.
export const POINTS_BASE = 10
export const POINTS_GROWTH = 1.12

export function basePoints(winOrdinal: number): number {
  return POINTS_BASE * Math.pow(POINTS_GROWTH, Math.max(0, winOrdinal - 1))
}


// Dealers past the table (only reached by a dev jump; the run ends at dealer 6) keep gaining hits
// and window so a jumped-to late dealer is still a real fight.
const PROTOTYPE_HITS_STEP = 2
const PROTOTYPE_HANDS_STEP = 4

// Never heal a dealer off its last hit — a heal only fires while it has at least this many hits
// remaining, so the kill is always reachable.
const HEAL_MIN_HITS = 2

// Endgame "honorable duel" on the final dealer. Below these health fractions it stops
// self-repairing (heal off), locks the player out of token abilities, and (via its 'smart' AI,
// round.ts) grows more willing to hit a hard total when behind.
const ABILITIES_LOCK_FRACTION = 0.2
// The final dealer's desperation hard-hit ceiling by health: once its health drops below `below`,
// it will hit a hard total up to `ceiling` when behind (highest first).
const DESPERATION_CEILINGS: readonly { below: number; ceiling: number }[] = [
  { below: 0.1, ceiling: 20 },
  { below: 0.2, ceiling: 19 },
  { below: 0.3, ceiling: 18 },
]

export interface Shift {
  index: number
  /** How many HITS destroying this dealer takes — each winning hand lands 1 (×weight). */
  maxHits: number
  /** The window: how many hands the dealer deals before walking off if still alive. */
  maxHands: number
  /** Max +1-hit heals this dealer can claw back (on hands it wins). 0 = never heals. */
  maxHeals: number
  /** Token inflation: destroying this dealer adds up to this fraction to the global inflation,
   *  scaled by how close the shift's token earnings came to `inflationDenom`. 0 = none. */
  inflationCap: number
  /** Token earnings that max out this shift's inflation add. */
  inflationDenom: number
  /** How this dealer plays a soft 17 (§ house rules): 'stand' early, 'hit' on the mid dealers,
   *  'smart' on Dealer 6. Folded into the round rules at deal. */
  dealerSoft17: Soft17Rule
}

export interface RunState {
  seed: number
  // The deal RNG's stream position (mulberry32 `.state`), checkpointed at each save so a resume
  // deals the SAME upcoming shoe on every reload.
  deckState: number
  score: number
  tokens: number
  shiftIndex: number
  handsThisDealer: number
  handsPlayed: number
  // Cumulative WINS this run (never reset per dealer). Incremented by real winning hands (×weight)
  // AND by kill cash-in bonus wins. Drives the points curve (basePoints).
  wins: number
  // Current dealer HP as an integer HIT count (max via maxHitsFor). Repurposes the old `integrity`.
  integrity: number
  // +1-hit heals this dealer has already clawed back; reset on shift advance.
  healsThisDealer: number
  // Player hit points (a run-long pool, NOT reset per dealer), drawn as the heart-chips. A losing
  // round pops one; wins heal (capped at MAX_HEARTS; a kill heals more). 0 opens the coda early.
  // Named hitPoints, not hearts, because the card-suit value "hearts" is plaintext in the save and
  // would trip the field-name-leak guard (keymap only obfuscates keys, not values).
  hitPoints: number
  // The last HEART_HEAL_LOOKBACK SCORED rounds' results (true = won that round), most-recent last.
  // Drives the streak heal; pushes/washes never reach applyRound so they never appear here.
  roundWins: boolean[]
  // Per consumed window slot, win or loss, for the dealer hand-summary. Reset on shift advance.
  handLog: HandResult[]
  // Global token inflation (a fraction): powerup costs are charged at base × (1 + this). Only rises.
  tokenInflation: number
  // Tokens earned against the current dealer, feeding the inflation add; reset on shift advance.
  tokensThisShift: number
  kills: number[]
  // Lifetime tallies for the game-over score screen (display only, never gameplay inputs).
  handsWon: number
  handsLost: number
  tokensSpent: number
  freeDoubleWins: number
  // Player-performance tallies for the score screen's "page 2" (tallyPerformance, display only).
  busts: number
  blackjackWins: number
  // WASH rounds — every hand pushed/voided, so the round never reached applyRound and never bumped
  // handsPlayed (see Session.settle_ / round.isRedealRound). Counted separately for the same reason:
  // pushes can't be derived as handsPlayed − handsWon − handsLost, because a scored round is ALWAYS
  // exactly one of won/lost, which made that difference a constant 0.
  pushes: number
  ratingSum: number
  ratedHands: number
  over: boolean
  // The Banker coda: set true when Dealer 6 is finished (killed OR its window runs out), so the run
  // enters the double-or-nothing endgame instead of ending. Stays true through the coda.
  coda: boolean
  // Set when the player cashes OUT of the coda (vs. busting it) — drives the score-screen title.
  cashedOut: boolean
  // Rewarded-ad usage this run: how many rewarded ads have paid out (the per-run cap) and the
  // shiftIndex the most recent one paid for. "Once per dealer" gates on rewardedAdShiftIndex !==
  // shiftIndex — because shiftIndex only ever climbs, a dealer advance re-enables the offer with NO
  // per-shift reset. Persisted so a mid-run reload can't reset the caps and farm energy.
  rewardedAdsThisRun: number
  rewardedAdShiftIndex: number
  // The handsPlayed at which the player last passed on an OFFERED rewarded ad — advanced without
  // taking it, or had the request come back unfilled. The offer then stays down until handsPlayed
  // has moved on far enough (AD_OFFER_COOLDOWN_HANDS, ui/game-view). It sits in RunState beside the
  // hard caps above so a reload can't wipe the "no" and put the offer straight back up; unlike them
  // this is cadence, not anti-farm, so losing it was a nag rather than an exploit.
  // AD_NEVER_DECLINED until the player passes on one.
  adDeclinedAtHand: number
  // Roguelite upgrades unlocked so far this run (see game/upgrades.ts).
  upgrades: RunUpgrades
}

// Per-dealer config. maxHits climbs 5→10, the window (maxHands ≈ (maxHits+maxHeals)×2.25) sets the
// required win-rate to kill in time; the late dealers also claw back hits (maxHeals). The token
// inflation fields are unchanged from the old economy.
const SHIFT_TABLE: readonly Shift[] = [
  { index: 1, maxHits: 5,  maxHands: 11, maxHeals: 0, inflationCap: 0.07,   inflationDenom: 140, dealerSoft17: 'stand' },
  { index: 2, maxHits: 6,  maxHands: 14, maxHeals: 0, inflationCap: 0.0975, inflationDenom: 170, dealerSoft17: 'stand' },
  { index: 3, maxHits: 7,  maxHands: 16, maxHeals: 0, inflationCap: 0.125,  inflationDenom: 200, dealerSoft17: 'hit' },
  { index: 4, maxHits: 8,  maxHands: 18, maxHeals: 0, inflationCap: 0.1525, inflationDenom: 240, dealerSoft17: 'hit' },
  { index: 5, maxHits: 9,  maxHands: 25, maxHeals: 2, inflationCap: 0.18,   inflationDenom: 280, dealerSoft17: 'hit' },
  { index: 6, maxHits: 10, maxHands: 29, maxHeals: 3, inflationCap: 0,      inflationDenom: 320, dealerSoft17: 'smart' },
]

export function startRun(seed: number): RunState {
  return {
    seed,
    // The deal RNG opens at the seed; Session.deal advances this as it draws each shoe.
    deckState: seed >>> 0,
    score: 0,
    tokens: STARTING_TOKENS,
    shiftIndex: 1,
    handsThisDealer: 0,
    handsPlayed: 0,
    wins: 0,
    integrity: getShift(1).maxHits,
    healsThisDealer: 0,
    hitPoints: MAX_HEARTS,
    roundWins: [],
    handLog: [],
    tokenInflation: 0,
    tokensThisShift: 0,
    kills: [],
    handsWon: 0,
    handsLost: 0,
    tokensSpent: 0,
    freeDoubleWins: 0,
    busts: 0,
    blackjackWins: 0,
    pushes: 0,
    ratingSum: 0,
    ratedHands: 0,
    over: false,
    coda: false,
    cashedOut: false,
    rewardedAdsThisRun: 0,
    rewardedAdShiftIndex: 0,
    adDeclinedAtHand: AD_NEVER_DECLINED,
    upgrades: emptyUpgrades(),
  }
}

// The run's current token-reward multiplier (Token eco upgrade). Applied to hand
// rewards via RoundRules and to the flat kill bounty here.
export function tokenMultiplier(run: RunState): number {
  return tokenMultiplierFor(run.upgrades)
}

// Unlock the next tier of an upgrade path (the choose-upgrade pick after a kill).
export function applyUpgrade(run: RunState, path: UpgradePath): RunState {
  return { ...run, upgrades: bumpUpgrade(run.upgrades, path) }
}

export function hasAvailableUpgrade(run: RunState): boolean {
  return hasAvailableUpgradeFor(run.upgrades)
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
  return {
    index,
    maxHits: base.maxHits + PROTOTYPE_HITS_STEP * shiftsBeyond,
    maxHands: base.maxHands + PROTOTYPE_HANDS_STEP * shiftsBeyond,
    maxHeals: base.maxHeals,
    inflationCap: base.inflationCap,
    inflationDenom: base.inflationDenom,
    dealerSoft17: base.dealerSoft17,
  }
}

// The current dealer's full hit count, so the health pips can scale to a per-dealer max.
export function maxHitsFor(shiftIndex: number): number {
  return getShift(shiftIndex).maxHits
}

// How hard a dealer's 10/11-value UP-CARD is suppressed at the deal: the probability that such an
// opening is discarded and reshuffled. Falls off fast — Dealer 1 100% → 2 30% → 3 15% → honest.
const UPCARD_RESHUFFLE_CHANCE: readonly number[] = [1, 0.3, 0.15]
export function dealerUpcardReshuffleChance(shiftIndex: number): number {
  return UPCARD_RESHUFFLE_CHANCE[shiftIndex - 1] ?? 0
}

// The highest HARD total the current dealer will hit when behind (see round.ts). 17 for any dealer
// but a wounded final dealer, which grows desperate as it nears death.
export function dealerHardHitCeiling(run: RunState): number {
  if (run.shiftIndex < TOTAL_DEALERS) {
    return 17
  }
  const frac = run.integrity / maxHitsFor(run.shiftIndex)
  for (const { below, ceiling } of DESPERATION_CEILINGS) {
    if (frac < below) {
      return ceiling
    }
  }
  return 17
}

// The final dealer's "honorable duel": token abilities are locked once it drops below
// ABILITIES_LOCK_FRACTION of its max health — the climax is raw blackjack, no powerups.
export function abilitiesLocked(run: RunState): boolean {
  return run.shiftIndex >= TOTAL_DEALERS && run.integrity < maxHitsFor(run.shiftIndex) * ABILITIES_LOCK_FRACTION
}

export function addTokens(run: RunState, amount: number): RunState {
  // Every token earned counts toward the current shift's inflation tally (this is the
  // live-credited hit tokens; win/kill tokens are tallied in applyRound).
  return { ...run, tokens: run.tokens + amount, tokensThisShift: run.tokensThisShift + amount }
}

// A powerup's live token cost: its base price inflated by the run's token inflation.
export function powerupCost(baseCost: number, run: RunState): number {
  return Math.round(baseCost * (1 + run.tokenInflation))
}

export function spendTokens(run: RunState, amount: number): RunState {
  if (run.tokens < amount) {
    throw new Error('not enough tokens')
  }
  return { ...run, tokens: run.tokens - amount, tokensSpent: run.tokensSpent + amount }
}

// The player's TERMINAL decision on a hand — the last hit-or-stand call, captured live in
// Session (the odds can't be reconstructed after the deck advances).
export interface HandDecision {
  action: 'hit' | 'stand'
  bustChance: number
  standLoseChance: number
}

// The per-hand star rating (1..5), or null if the hand can't be rated.
export function ratePlayerHand(hand: PlayerHand, decision: HandDecision | undefined): number | null {
  // A real natural blackjack (not a hijacked dealer 21) — top marks, no decision involved.
  if (hand.outcome === 'blackjack' && isBlackjack(hand.cards)) {
    return 5
  }
  if (!decision) {
    return null
  }
  const won = hand.outcome === 'win' || hand.outcome === 'blackjack'
  const push = hand.outcome === 'push' || hand.outcome === 'voided'
  const shouldHit = decision.bustChance < decision.standLoseChance
  const rightCall = (decision.action === 'hit') === shouldHit
  if (rightCall) {
    return won ? 5 : push ? 4 : 3
  }
  return won ? 3 : push ? 2 : 1
}

// Fold a resolved round's PLAYER-PERFORMANCE tallies into the run (display only). Kept OUT of
// applyRound so the pure resolution maths never depend on the live odds snapshots this needs.
export function tallyPerformance(run: RunState, round: Round, decisions: readonly (HandDecision | undefined)[]): RunState {
  const playerBusted = round.hands.some((hand) => hand.outcome === 'bust')
  const blackjackWin = round.hands.some((hand) => hand.outcome === 'blackjack')
  const stars = round.hands
    .map((hand, i) => ratePlayerHand(hand, decisions[i]))
    .filter((star): star is number => star !== null)
  let ratingSum = run.ratingSum
  let ratedHands = run.ratedHands
  if (stars.length > 0) {
    ratingSum += stars.reduce((sum, star) => sum + star, 0) / stars.length
    ratedHands += 1
  }
  return {
    ...run,
    busts: run.busts + (playerBusted ? 1 : 0),
    blackjackWins: run.blackjackWins + (blackjackWin ? 1 : 0),
    ratingSum,
    ratedHands,
  }
}

// Count a WASH round (every hand pushed/voided) for the score screen's push %. The wash short-
// circuits before applyRound/tallyPerformance — it consumes no window slot and scores nothing — so
// this is the only tally it feeds. Display only, like the rest of tallyPerformance.
export function tallyWash(run: RunState): RunState {
  return { ...run, pushes: run.pushes + 1 }
}

// A resolved round's effect on the player's HEARTS (hit points) and the recent-win history that
// drives the streak heal. Pure, so it unit-tests without running the whole applyRound. A round of
// only pushes/voids never reaches here (Session redeals it), so the round is always a net win or a
// net loss:
//   • LOSS (no winning hand) → pop one heart.
//   • WIN → heal (capped at MAX_HEARTS):
//       – a KILL (beating the dealer) heals HEART_KILL_HEAL, superseding the per-win heal below;
//       – a natural or hijacked blackjack (outcome 'blackjack'), one, unconditionally;
//       – a double-win (a split where BOTH hands won), one, unconditionally;
//       – any other win, one, only if ≥1 of the last HEART_HEAL_LOOKBACK scored rounds was also a win.
// The win/loss split uses the unclamped tally; the last-window-slot split-clamp corner (a won split
// hand that didn't land) simply favours the player's hearts, which is fine.
export function heartsAfterRound(
  prevHitPoints: number,
  prevRoundWins: readonly boolean[],
  round: Round,
  killed = false,
): { hitPoints: number; roundWins: boolean[] } {
  const { hits, losses } = roundTally(round)
  const won = hits > 0
  const lost = !won && losses > 0

  let hitPoints = prevHitPoints
  if (lost) {
    hitPoints = Math.max(0, prevHitPoints - 1)
  } else if (won) {
    const heal = killed ? HEART_KILL_HEAL : heartHealQualifies(round, prevRoundWins) ? 1 : 0
    hitPoints = Math.min(MAX_HEARTS, prevHitPoints + heal)
  }

  // Record this round's result for future streak checks, keeping only the last HEART_HEAL_LOOKBACK.
  const roundWins = won || lost ? [...prevRoundWins, won].slice(-HEART_HEAL_LOOKBACK) : [...prevRoundWins]
  return { hitPoints, roundWins }
}

function heartHealQualifies(round: Round, prevRoundWins: readonly boolean[]): boolean {
  // A natural or hijacked blackjack always heals.
  if (round.hands.some((hand) => hand.outcome === 'blackjack')) {
    return true
  }
  // A double-win — a split where both hands won — always heals.
  if (round.hands.length === 2 && round.hands.every(isWinningHand)) {
    return true
  }
  // Any other win heals only on a recent-win streak (buffed default: ≥1 of the last N scored rounds).
  return prevRoundWins.some((won) => won)
}

// Resolve a settled round into the run: land hits (weighted wins), score each win off the cumulative
// curve, log the window slots, apply a heal on a lost hand, and — on the killing/last hand — either
// cash in the remaining window as bonus wins (kill) or walk the dealer off (window-out). A round of
// only pushes/voids never reaches here (Session redeals it — see round.isRedealRound).
export function applyRound(run: RunState, round: Round): RunState {
  if (round.status !== 'resolved') {
    throw new Error('cannot apply an unresolved round')
  }
  const shift = getShift(run.shiftIndex)

  const bjBonus = blackjackPointBonusFor(run.upgrades)

  // One pass over the hands: weighted hits/losses, the per-slot win/loss log, and per-win scoring.
  // Score is purely the cumulative win curve (basePoints) — no combo multiplier. SCORE: logs are
  // DEV-only diagnostics.
  //
  // WINDOW CLAMP: a hand can't consume more of the dealer's remaining window than is left — a double
  // (weight 2) played on the LAST open slot counts as 1 (1 hit, 1 window slot, 1 point-win), the
  // overflow simply doesn't land. So doubling to secure the final hand is fair, never a free 2×.
  let hits = 0
  let losses = 0
  const slots: HandResult[] = []
  let wins = run.wins
  let score = run.score
  let remainingWindow = Math.max(0, shift.maxHands - run.handsThisDealer)
  for (const hand of round.hands) {
    const weight = Math.min(handWeight(hand), remainingWindow)
    remainingWindow -= weight
    if (weight === 0) {
      continue // no window left — this hand is over the cap and doesn't count
    }
    if (hand.outcome === 'win' || hand.outcome === 'blackjack') {
      hits += weight
      const isBlackjackWin = hand.outcome === 'blackjack'
      const mult = isBlackjackWin ? 1 + bjBonus : 1
      for (let i = 0; i < weight; i += 1) {
        slots.push('win')
        wins += 1
        const pts = Math.round(basePoints(wins) * mult)
        score += pts
        if (import.meta.env.DEV) {
          console.log(`SCORE: win #${wins} +${pts}${isBlackjackWin ? ' (blackjack)' : ''}`)
        }
      }
    } else if (hand.outcome === 'lose' || hand.outcome === 'bust') {
      losses += weight
      for (let i = 0; i < weight; i += 1) {
        slots.push('loss')
      }
    }
    // push / voided → nothing (no slot, no symbol, no score)
  }

  const playerWon = hits > 0
  const dealerWon = hits === 0 && losses > 0
  const freeDoubleWin = playerWon && round.hands.some((hand) => isWinningHand(hand) && hand.freeDoubled)

  // Player hearts: a losing round pops one; a win heals (a kill heals more). Computed up front so a
  // fatal loss (the last heart gone) can pre-empt the normal window advance below and drop straight
  // into the coda with the current dealer still on-screen (it walks off) — no kill, no score penalty.
  // `willKill` mirrors the integrity check below (a win that drops the dealer's HP to 0).
  const willKill = run.integrity - hits <= 0
  const { hitPoints, roundWins } = heartsAfterRound(run.hitPoints, run.roundWins, round, willKill)
  const heartDeath = hitPoints <= 0

  const roundTokens = tokensForRound(round)
  let tokens = run.tokens + roundTokens
  let tokensThisShift = run.tokensThisShift + roundTokens
  let tokenInflation = run.tokenInflation

  let integrity = run.integrity - hits
  let healsThisDealer = run.healsThisDealer
  // Heal-on-win: a late dealer claws back 1 hit when it beats the player, capped at its own max and
  // its heal budget, and never off the player's last hit (so the kill stays reachable).
  if (dealerWon && healsThisDealer < shift.maxHeals && integrity >= HEAL_MIN_HITS) {
    integrity = Math.min(shift.maxHits, integrity + 1)
    healsThisDealer += 1
  }

  let shiftIndex = run.shiftIndex
  let handsThisDealer = run.handsThisDealer + slots.length
  let handLog: HandResult[] = [...run.handLog, ...slots]
  let kills = run.kills
  let coda = run.coda

  if (integrity <= 0) {
    // KILL. Token bounty (feeds powerups) + banked inflation; NO score bounty (the cash-in below IS
    // the point reward). Cash in every remaining window slot as a bonus win off the same curve.
    const bountyTokens = Math.round(DESTROY_TOKEN * tokenMultiplier(run))
    tokens += bountyTokens
    tokensThisShift += bountyTokens
    tokenInflation += inflationIncrement(shift, tokensThisShift, inflationResistanceFor(run.upgrades))
    tokensThisShift = 0

    const remaining = Math.max(0, shift.maxHands - handsThisDealer)
    if (import.meta.env.DEV && remaining > 0) {
      console.log(`SCORE: Dealer ${run.shiftIndex} down — cashing in ${remaining} free win${remaining === 1 ? '' : 's'}`)
    }
    let cashInTotal = 0
    for (let i = 0; i < remaining; i += 1) {
      wins += 1
      const pts = Math.round(basePoints(wins))
      score += pts
      cashInTotal += pts
      if (import.meta.env.DEV) {
        console.log(`SCORE:   free win #${wins} +${pts}`)
      }
    }
    if (import.meta.env.DEV && remaining > 0) {
      console.log(`SCORE: Dealer ${run.shiftIndex} cash-in = ${remaining} free wins for +${cashInTotal}`)
    }

    kills = [...kills, shiftIndex]
    shiftIndex += 1
    handsThisDealer = 0
    healsThisDealer = 0
    handLog = []
    integrity = getShift(shiftIndex).maxHits
    if (kills.length >= TOTAL_DEALERS) {
      // The final dealer is down — enter the Banker coda rather than ending the run.
      coda = true
    }
  } else if (handsThisDealer >= shift.maxHands && !heartDeath) {
    // WINDOW-OUT: the dealer survived its window and walks off — no kill, no bounty, no upgrade.
    // (Skipped on a heart-death: that round instead ends the dealer via the coda below, and we keep
    // the current dealer/handLog so the losing summary still shows before it walks off.)
    if (shiftIndex >= TOTAL_DEALERS) {
      // Dealer 6 outlasting its window still opens the banker coda (it always comes out).
      coda = true
    } else {
      shiftIndex += 1
      handsThisDealer = 0
      healsThisDealer = 0
      handLog = []
      tokensThisShift = 0
      integrity = getShift(shiftIndex).maxHits
    }
  }

  if (heartDeath) {
    // Out of hearts — the current dealer walks off and the run drops into the coda (no kill,
    // no bounty, no score penalty). A kill can't coincide (a kill round is a win), so this only
    // pre-empts a normal or window-out loss.
    coda = true
  }

  return {
    ...run,
    score,
    tokens,
    shiftIndex,
    handsThisDealer,
    handsPlayed: run.handsPlayed + 1,
    handsWon: run.handsWon + (playerWon ? 1 : 0),
    handsLost: run.handsLost + (dealerWon ? 1 : 0),
    freeDoubleWins: run.freeDoubleWins + (freeDoubleWin ? 1 : 0),
    wins,
    integrity,
    healsThisDealer,
    hitPoints,
    roundWins,
    handLog,
    tokenInflation,
    tokensThisShift,
    kills,
    coda,
  }
}

// The ordered per-WIN point deltas a resolved round banks — one entry per GREEN CHECK the hand-
// summary shows: each real winning slot (in hand order), then, on a kill, every cash-in bonus win.
// Mirrors applyRound's win scoring exactly so the fly-in "+N" texts match the counter. Losses and
// pushes add no green check, so they're excluded. Returns [] for a non-winning round.
export function winPointDeltas(run: RunState, round: Round): number[] {
  if (round.status !== 'resolved') {
    return []
  }
  const bjBonus = blackjackPointBonusFor(run.upgrades)
  const deltas: number[] = []
  let wins = run.wins
  let hits = 0
  let slotCount = 0
  // Same WINDOW CLAMP as applyRound (a double on the last open slot counts as 1) so the "+N"s match.
  let remainingWindow = Math.max(0, getShift(run.shiftIndex).maxHands - run.handsThisDealer)
  for (const hand of round.hands) {
    const weight = Math.min(handWeight(hand), remainingWindow)
    remainingWindow -= weight
    if (weight === 0) {
      continue
    }
    if (hand.outcome === 'win' || hand.outcome === 'blackjack') {
      hits += weight
      slotCount += weight
      const mult = hand.outcome === 'blackjack' ? 1 + bjBonus : 1
      for (let i = 0; i < weight; i += 1) {
        wins += 1
        deltas.push(Math.round(basePoints(wins) * mult))
      }
    } else if (hand.outcome === 'lose' || hand.outcome === 'bust') {
      slotCount += weight
    }
    // push / voided → no slot, no score
  }
  // A kill (integrity spent, only reachable on a winning hand — heals are loss-only) cashes in every
  // remaining window slot as a bonus win off the same curve, in ascending order.
  if (hits > 0 && run.integrity - hits <= 0) {
    const remaining = Math.max(0, getShift(run.shiftIndex).maxHands - (run.handsThisDealer + slotCount))
    for (let i = 0; i < remaining; i += 1) {
      wins += 1
      deltas.push(Math.round(basePoints(wins)))
    }
  }
  return deltas
}

// Inflation added when a shift's dealer is destroyed: the shift's cap scaled by how close its token
// earnings came to the denom (min 0, capped at the full cap), then by the Token eco resistance.
function inflationIncrement(shift: Shift, tokensThisShift: number, resistance: number): number {
  if (shift.inflationCap <= 0) {
    return 0
  }
  const frac = Math.min(tokensThisShift, shift.inflationDenom) / shift.inflationDenom
  return shift.inflationCap * frac * resistance
}


// Reward tokens for the round, scaled by how each hand won (see rewards.ts). Hit tokens are credited
// live by the Session as each hit happens, so they aren't counted here.
function tokensForRound(round: Round): number {
  return round.hands.reduce((earned, hand) => earned + handReward(hand, round).tokens, 0)
}
