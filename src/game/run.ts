import { damageForRound } from './integrity'
import type { Rng } from './random'
import { handReward } from './rewards'
import { isWinningHand, payout, type Round, type Soft17Rule } from './round'
import {
  bumpUpgrade,
  emptyUpgrades,
  hasAvailableUpgrade as hasAvailableUpgradeFor,
  inflationResistanceFor,
  tokenMultiplierFor,
  type RunUpgrades,
  type UpgradePath,
} from './upgrades'

// Bumped whenever resolution/reward maths change, so stale replays are invalidated.
// v4: roguelite upgrades (auto-blackjack, dealer sabotage, chip/token scaling).
// v5: per-shift dealer HP + late-dealer heal-on-win; win-streak combo + clean-kill score.
// v6: wealth-floor bet (bet forced to a % of the stack on later dealers).
// v7: token inflation (powerup costs rise with tokens earned; Token eco resists it).
// v8: harder endgame — bigger wealth floor + Dealer 6 max bet; late dealers hit soft 17.
// v9: soft-17 rule per dealer — D3-5 hit, D6 plays 'smart' (hits only when behind).
// v10: smart D6 also hits a hard 17 when strictly behind (downgrade folded in).
// v11: D6 "honorable duel" — desperation hard-hit ceiling, no heal <30%, no abilities
//      <20%, and a bust from an abandoned stand pays the beat-total tier, not weak bust.
// v12: upgrade-path rework — Payout (2:1 → 3:1 blackjack → win all pushes), Sabotage
//      (75% refund → void any dealer 21 → hijack natural), buffed Tokens; the
//      auto-blackjack lift and the −1 dealer downgrade removed.
// v13: harder economy — min-bet ladder doubled per dealer (20/40/80/160/320/640) with
//      a steeper wealth floor (0/10/12/15/18/25%); Peek Dealer costs the same as Peek Deck.
// v14: kill bounty raised (150→1000 ×dealer) so kills dominate score, and clean-kill
//      decay halved (0.2→0.1) so the clean bonus survives a realistic loss count and
//      stays reachable on the drawn-out, self-healing late dealers.
// v15: winning a token-free Double (standard double-down, not the paid Late double
//      powerup) pays a 1.5x score boost — a reward for the bold, unbought risk.
// v16: surviving hits now also pay SCORE by bust risk (hitPoints) — a flat 10 up to 50%
//      risk, then a smoothStart2 ease-in climbing to 1000 at a certain bust.
// v17: lifetime tallies for the game-over score screen (handsWon/handsLost, tokensSpent,
//      freeDoubleWins) — display only, no effect on resolution maths.
// v18: hit-points curve retuned — flat 10 below 40% risk, then smoothStart2 from 10 to 400
//      (was a 50% floor climbing to 1000).
// v19: hit points now (a) ramp from a near-zero floor up to 10 across the sub-40% region
//      instead of a flat 10, and (b) scale by the dealer's score multiplier (Session.hit).
// v20: the combo is now a unified HIT streak (built +1 per surviving hit, reset on bust)
//      that multiplies ALL score — hit points, won chip score, and kill bounty — at x1..x2.
//      Replaces the old win-streak combo (consecutive won hands, reset on any dealer win).
// v21: hits earn NO points — their sole purpose is to build the combo, now a CONTINUOUS
//      risk-weighted accumulator (comboGain: safe hit +0.01, riskier hits more) that
//      multiplies won hands + kills at x1..x2. hitPoints removed.
// v22: clean-kill bonus removed (it was invisible to the player) — the kill bounty is now
//      just 1000 × dealer × combo, no per-loss decay. lossesThisDealer dropped.
// v23: the combo now resets on ANY lost hand (all hands, on a split), not just a bust —
//      so safe play (standing to protect the streak) no longer hoards the multiplier.
export const RULES_VERSION = 23
export const STARTING_CHIPS = 300
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

// Hits earn NO points directly — their sole purpose is to build the combo (below). A
// surviving hit adds `comboGain(risk)` to the combo, weighted by how risky the hit was: a
// safe hit (0% bust) nudges it by only COMBO_GAIN_FLOOR, a near-certain bust that survived
// adds the most. So the multiplier is built by taking real risk, not by free safe hits.
export const COMBO_GAIN_FLOOR = 0.01
export const COMBO_GAIN_SLOPE = 0.19 // + this × risk (max gain 0.20 at a certain-bust hit)

export function comboGain(bustChance: number): number {
  const risk = Math.min(1, Math.max(0, bustChance))
  return COMBO_GAIN_FLOOR + risk * COMBO_GAIN_SLOPE
}

const DESTRUCTION_SCORE_BASE = 1000
const HAND_BET_STEP = 0.5
// On a kill, seed the next dealer's bankroll with this many of its minimum bets,
// so the escalating min-bet ladder stays survivable instead of starving the run.
const KILL_REWARD_RATIO = 3
const PROTOTYPE_MIN_GROWTH = 2.5
const PROTOTYPE_MULTIPLIER_STEP = 1.5
// Dealers past the table (only reached by a dev jump; the run ends at dealer 6)
// keep gaining HP so a jumped-to late dealer is still a real fight.
const PROTOTYPE_HP_STEP = 45

// Unified combo (score only): a CONTINUOUS accumulator of risk-weighted surviving hits
// (see comboGain). `run.combo` holds the accumulated bonus fraction, capped at
// COMBO_MAX_BONUS; the multiplier is 1 + that. A BUST resets it to 0 (see Session.hit);
// standing, losing, and winning leave it. The multiplier scales ALL score the streak earns
// — a won hand's chip score and the kill bounty (hits themselves no longer score). Built in
// Session.hit; applyRound only READS it.
const COMBO_MAX_BONUS = 1 // caps the multiplier at x2

// Free-double win bonus (score only): a hand won on the standard token-free Double
// (doubleDown) scores x1.5 — a reward for the bold, unbought risk. The paid Late
// double powerup is deliberately excluded (buying score would be too cheap).
const FREE_DOUBLE_SCORE_BONUS = 1.5

// Endgame "honorable duel" on the final dealer. Below these health fractions it stops
// self-repairing (heal-on-win off), locks the player out of token abilities, and (via
// its 'smart' AI, round.ts) grows more willing to hit a hard total when behind.
const HEAL_MIN_HEALTH_FRACTION = 0.3
const ABILITIES_LOCK_FRACTION = 0.2
// The final dealer's desperation hard-hit ceiling by health: once its health drops
// below `below`, it will hit a hard total up to `ceiling` when behind (highest first).
const DESPERATION_CEILINGS: readonly { below: number; ceiling: number }[] = [
  { below: 0.1, ceiling: 20 },
  { below: 0.2, ceiling: 19 },
  { below: 0.3, ceiling: 18 },
]

export interface Shift {
  index: number
  minBet: number
  maxBet: number
  scoreMultiplier: number
  /** The dealer's full integrity — how much damage destroying it takes. */
  maxIntegrity: number
  /** On a hand the dealer wins, it repairs a random amount of HP in [min, max],
   *  capped at maxIntegrity. [0, 0] = never heals. */
  healOnWin: readonly [min: number, max: number]
  /** Wealth floor: the bet is forced to at least this fraction of the player's
   *  chips (the greater of it and the ladder bet), so a fat stack can't shrug off
   *  the stakes. 0 on Dealer 1, up to 0.125 (12.5%) by Dealer 6. */
  minBetPct: number
  /** Token inflation: destroying this dealer adds up to this fraction to the global
   *  inflation (§ token inflation), scaled by how close the shift's token earnings
   *  came to `inflationDenom`. 0 = no inflation from this shift (Dealer 6 wins the
   *  run, so its kill never inflates anything). */
  inflationCap: number
  /** Token earnings that max out this shift's inflation add. Higher on later shifts,
   *  which normally earn more, so the add tracks *excess* earning, not raw volume. */
  inflationDenom: number
  /** How this dealer plays a soft 17 (§ house rules): 'stand' early, 'hit' (H17) on
   *  the mid dealers, 'smart' on Dealer 6 (hits only when not already winning). Folded
   *  into the round rules at deal. */
  dealerSoft17: Soft17Rule
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
  // Accumulated risk-weighted combo bonus since the last lost hand (a continuous 0..1
  // value), driving the score multiplier (comboMultiplier = 1 + this). Grown by each
  // surviving hit in Session.hit (comboGain), reset to 0 in applyRound when the whole hand
  // is lost (all split hands lost); multiplies won hands + kills.
  combo: number
  // Global token inflation (a fraction): powerup costs are charged at base × (1 + this).
  // Only ever rises, by an amount set at each kill from the shift's token earnings.
  tokenInflation: number
  // Tokens earned against the current dealer, feeding the inflation add; reset on kill.
  tokensThisShift: number
  kills: number[]
  // Lifetime tallies for the game-over score screen (display only, never gameplay inputs).
  // handsWon/handsLost feed the win/loss ratio (pushes count as neither); tokensSpent is
  // cumulative powerup spend; freeDoubleWins counts wins that used the token-free Double.
  handsWon: number
  handsLost: number
  tokensSpent: number
  freeDoubleWins: number
  over: boolean
  won: boolean
  // Roguelite upgrades unlocked so far this run (see game/upgrades.ts).
  upgrades: RunUpgrades
}

// The min-bet floor doubles per dealer (20 → 640, v13) to thin the 300-chip bankroll
// and raise variance — cold streaks bust the player out more often, hardest early
// where runs actually end. maxBet grows slower than the min, so the ladder's bet range
// compresses on the later dealers. The wealth floor climbs too (0 → 25%). Dealer HP
// scales — from 100 up to 220 at dealer 6, so late kills take more hands (more exposure
// to a cold streak, more score) — and dealer 6 repairs 10-15 HP whenever it beats you,
// so a stumble against it costs progress, not just chips.
const SHIFT_TABLE: readonly Shift[] = [
  { index: 1, minBet: 20, maxBet: 200, scoreMultiplier: 1.0, maxIntegrity: 100, healOnWin: [0, 0], minBetPct: 0, inflationCap: 0.07, inflationDenom: 140, dealerSoft17: 'stand' },
  { index: 2, minBet: 40, maxBet: 350, scoreMultiplier: 1.5, maxIntegrity: 110, healOnWin: [0, 0], minBetPct: 0.1, inflationCap: 0.0975, inflationDenom: 170, dealerSoft17: 'stand' },
  { index: 3, minBet: 80, maxBet: 550, scoreMultiplier: 2.0, maxIntegrity: 125, healOnWin: [0, 0], minBetPct: 0.12, inflationCap: 0.125, inflationDenom: 200, dealerSoft17: 'hit' },
  { index: 4, minBet: 160, maxBet: 850, scoreMultiplier: 3.0, maxIntegrity: 150, healOnWin: [0, 0], minBetPct: 0.15, inflationCap: 0.1525, inflationDenom: 240, dealerSoft17: 'hit' },
  { index: 5, minBet: 320, maxBet: 1700, scoreMultiplier: 4.0, maxIntegrity: 185, healOnWin: [5, 9], minBetPct: 0.18, inflationCap: 0.18, inflationDenom: 280, dealerSoft17: 'hit' },
  { index: 6, minBet: 640, maxBet: 2750, scoreMultiplier: 5.5, maxIntegrity: 220, healOnWin: [10, 15], minBetPct: 0.25, inflationCap: 0, inflationDenom: 320, dealerSoft17: 'smart' },
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
    integrity: getShift(1).maxIntegrity,
    combo: 0,
    tokenInflation: 0,
    tokensThisShift: 0,
    kills: [],
    handsWon: 0,
    handsLost: 0,
    tokensSpent: 0,
    freeDoubleWins: 0,
    over: false,
    won: false,
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
  const minBet = Math.round(base.minBet * Math.pow(PROTOTYPE_MIN_GROWTH, shiftsBeyond))
  return {
    index,
    minBet,
    maxBet: minBet * 10,
    scoreMultiplier: base.scoreMultiplier + PROTOTYPE_MULTIPLIER_STEP * shiftsBeyond,
    maxIntegrity: base.maxIntegrity + PROTOTYPE_HP_STEP * shiftsBeyond,
    healOnWin: base.healOnWin,
    minBetPct: base.minBetPct,
    inflationCap: base.inflationCap,
    inflationDenom: base.inflationDenom,
    dealerSoft17: base.dealerSoft17,
  }
}

// The current dealer's full integrity, so the health bar can scale to a per-dealer
// max (dealers no longer share a flat 100).
export function maxIntegrityFor(shiftIndex: number): number {
  return getShift(shiftIndex).maxIntegrity
}

// The highest HARD total the current dealer will hit when behind (see round.ts). 17 for
// any dealer but a wounded final dealer, which grows desperate as it nears death — it
// will risk hitting an 18/19/20 to survive a hand a stand would lose.
export function dealerHardHitCeiling(run: RunState): number {
  if (run.shiftIndex < TOTAL_DEALERS) {
    return 17
  }
  const frac = run.integrity / maxIntegrityFor(run.shiftIndex)
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
  return run.shiftIndex >= TOTAL_DEALERS && run.integrity < maxIntegrityFor(run.shiftIndex) * ABILITIES_LOCK_FRACTION
}

// The player no longer chooses a bet. It's the greater of two floors, capped at the
// bankroll: the ladder bet (the dealer's min, climbing as the fight drags on, capped
// at the table max) and a wealth floor (a % of the current stack, §3). The wealth
// floor is what keeps a fat bankroll honest — it can push the bet above the table max
// for the very rich, so wins and losses always move real money late.
export function nextBet(run: RunState): number {
  const shift = getShift(run.shiftIndex)
  const climbed = Math.min(
    Math.round(shift.minBet * (1 + run.handsThisDealer * HAND_BET_STEP)),
    shift.maxBet,
  )
  const wealthFloor = Math.round(shift.minBetPct * run.chips)
  return Math.min(Math.max(climbed, wealthFloor), run.chips)
}

export function isLastCall(run: RunState): boolean {
  return run.chips > 0 && run.chips < getShift(run.shiftIndex).minBet
}

export function addTokens(run: RunState, amount: number): RunState {
  // Every token earned counts toward the current shift's inflation tally (this is the
  // live-credited hit tokens; win/kill tokens are tallied in applyRound).
  return { ...run, tokens: run.tokens + amount, tokensThisShift: run.tokensThisShift + amount }
}

// A powerup's live token cost: its base price inflated by the run's token inflation.
// The single source of truth for what a powerup costs right now — used by both the
// spend path and the UI's cost pills.
export function powerupCost(baseCost: number, run: RunState): number {
  return Math.round(baseCost * (1 + run.tokenInflation))
}

export function spendTokens(run: RunState, amount: number): RunState {
  if (run.tokens < amount) {
    throw new Error('not enough tokens')
  }
  return { ...run, tokens: run.tokens - amount, tokensSpent: run.tokensSpent + amount }
}

// `rng` sources the heal-on-win roll (only consumed on a dealer-won hand at a
// healing dealer). It defaults to the mid-roll so callers that don't care — the
// early dealers never heal — stay deterministic.
export function applyRound(run: RunState, round: Round, rng: Rng = () => 0.5): RunState {
  if (round.status !== 'resolved') {
    throw new Error('cannot apply an unresolved round')
  }
  const shift = getShift(run.shiftIndex)

  const net = payout(round)
  const chipsWon = Math.max(net, 0)
  const damage = damageForRound(round)
  const playerWon = damage > 0
  const dealerWon = !playerWon && roundHasLoss(round)

  // The combo (built from surviving hits, see Session.hit) resets when the hand is a total
  // LOSS — every hand lost or busted, no win/push to hold it. On a split that means all
  // hands must lose; one winning/pushing hand keeps the streak. So losing a hand (however —
  // busted or stood-and-beaten) wipes the multiplier, and safe play earns no protection.
  const comboReset = round.hands.every((hand) => hand.outcome === 'lose' || hand.outcome === 'bust')

  // The combo multiplies ALL score this hand earns — the won chip score here, and the kill
  // bounty below. Read the pre-reset value (a losing hand scores nothing anyway); the reset
  // is applied to `run.combo` in the return so it takes effect next hand.
  const combo = comboMultiplier(run.combo)

  // A win on a token-free Double lifts that hand's chip score by FREE_DOUBLE_SCORE_BONUS
  // (the paid Late double is excluded — it never sets freeDoubled).
  const freeDoubleWin = playerWon && round.hands.some((h) => isWinningHand(h) && h.freeDoubled)
  const doubleBoost = freeDoubleWin ? FREE_DOUBLE_SCORE_BONUS : 1

  const roundTokens = tokensForRound(round)
  let chips = run.chips + net
  let score = run.score + Math.round(chipsWon * shift.scoreMultiplier * combo * doubleBoost)
  let tokens = run.tokens + roundTokens
  let tokensThisShift = run.tokensThisShift + roundTokens
  let tokenInflation = run.tokenInflation

  let integrity = run.integrity - damage
  // Heal-on-win: a late dealer repairs itself when it beats the player, capped at its
  // own max. Only fires on a dealer-won hand, and shuts off once the dealer is below
  // HEAL_MIN_HEALTH_FRACTION — too damaged to self-repair, so the endgame can't heal-loop
  // into a stalemate.
  if (dealerWon && run.integrity >= shift.maxIntegrity * HEAL_MIN_HEALTH_FRACTION) {
    integrity = Math.min(shift.maxIntegrity, integrity + healAmount(shift, rng))
  }

  let shiftIndex = run.shiftIndex
  let handsThisDealer = run.handsThisDealer + 1
  let kills = run.kills
  let won = false

  if (integrity <= 0) {
    // The kill bounty scales with the Token eco multiplier, like every other reward.
    const bountyTokens = Math.round(DESTROY_TOKEN * tokenMultiplier(run))
    tokens += bountyTokens
    tokensThisShift += bountyTokens
    // Destroying the dealer ends the shift: bank inflation from everything earned
    // against it, softened by the Token eco tier's resistance (see upgrades.ts). Then
    // reset the tally for the next dealer.
    tokenInflation += inflationIncrement(shift, tokensThisShift, inflationResistanceFor(run.upgrades))
    tokensThisShift = 0
    // Base bounty (1000 × dealer), scaled by the current combo — a kill lands on a won
    // hand, so the streak still applies.
    const bounty = DESTRUCTION_SCORE_BASE * shiftIndex
    score += Math.round(bounty * combo)
    kills = [...kills, shiftIndex]
    shiftIndex += 1
    handsThisDealer = 0
    integrity = getShift(shiftIndex).maxIntegrity
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
    handsWon: run.handsWon + (playerWon ? 1 : 0),
    handsLost: run.handsLost + (dealerWon ? 1 : 0),
    freeDoubleWins: run.freeDoubleWins + (freeDoubleWin ? 1 : 0),
    integrity,
    combo: comboReset ? 0 : run.combo,
    tokenInflation,
    tokensThisShift,
    kills,
    won,
    over: won || chips <= 0,
  }
}

// Inflation added when a shift's dealer is destroyed: the shift's cap scaled by how
// close its token earnings came to the denom (min 0, capped at the full cap), then
// by the Token eco resistance. Guarded so a zero-cap shift (Dealer 6) never inflates.
function inflationIncrement(shift: Shift, tokensThisShift: number, resistance: number): number {
  if (shift.inflationCap <= 0) {
    return 0
  }
  const frac = Math.min(tokensThisShift, shift.inflationDenom) / shift.inflationDenom
  return shift.inflationCap * frac * resistance
}

// The unified score multiplier for the given accumulated combo bonus (0..): x1 at no
// combo, climbing with the risk-weighted hits banked, capped at x2 (COMBO_MAX_BONUS).
export function comboMultiplier(combo: number): number {
  return 1 + Math.min(Math.max(combo, 0), COMBO_MAX_BONUS)
}

// Add a surviving hit's risk-weighted gain to the combo, capped at COMBO_MAX_BONUS. Score
// only — the hit itself pays nothing; it just grows the multiplier for the wins/kills ahead.
export function bumpCombo(run: RunState, bustChance: number): RunState {
  return { ...run, combo: Math.min(COMBO_MAX_BONUS, run.combo + comboGain(bustChance)) }
}

// HP a healing dealer repairs on a win: a random amount in the shift's [min, max]
// range (inclusive), or 0 for a dealer that never heals.
function healAmount(shift: Shift, rng: Rng): number {
  const [lo, hi] = shift.healOnWin
  if (hi <= 0) {
    return 0
  }
  return lo + Math.floor(rng() * (hi - lo + 1))
}

// Whether the player lost or busted at least one hand this round (a dealer win).
function roundHasLoss(round: Round): boolean {
  return round.hands.some((hand) => hand.outcome === 'lose' || hand.outcome === 'bust')
}

// Reward tokens for the round, scaled by how each hand won (see rewards.ts). Hit
// tokens are credited live by the Session as each hit happens, so they aren't
// counted here.
function tokensForRound(round: Round): number {
  return round.hands.reduce((earned, hand) => earned + handReward(hand, round).tokens, 0)
}
