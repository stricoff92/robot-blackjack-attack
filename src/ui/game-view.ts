import './game-view.css'

import { FLAGS } from '../flags'
import { readDebugFlags } from '../game/debug'
import type { Card } from '../game/deck'
import { POWERUPS } from '../game/powerups'
import { canDouble, canForcedSplit, canMulligan, canReturn, canSplit, dealerSettleTotal, DEFAULT_ROUND_RULES, isDealerHijacked, isWinningHand, roundTally, type PlayerHand, type Round, type RoundRules } from '../game/round'
import { evaluateHand, isBlackjack } from '../game/hand'
import { handReward } from '../game/rewards'
import { dealerHardHitCeiling, DESTROY_TOKEN, getShift, maxHitsFor, powerupCost, SABOTAGE_DEALER21_ENERGY, tokenMultiplier, TOTAL_DEALERS, winPointDeltas } from '../game/run'
import { CODA_ANALYZE_COST, CODA_MULLIGAN_COST, Session, SHOE_DECKS, type SessionState } from '../game/session'
import { getPersonalBest } from '../game/leaderboard'
import { isBatterySaver, setBatterySaver } from '../game/power-mode'
import { clearRun, loadSession, type PersistedSession } from '../game/persistence'
import { gameplayStart, gameplayStop, reportGameCompletedPercentage } from '../platform/crazygames'
import { blackjackPointBonusFor, nextTierLabel, rulesForUpgrades, UPGRADE_PATHS, type UpgradePath, type UpgradePathInfo } from '../game/upgrades'
import { getCardSprite, setCardBack } from '../render/card-sprite'
import { deviceDpr, type LayeredCanvas } from '../render/canvas'
import { createSpriteCanvas, type SpriteCanvas } from '../render/sprite-canvas'
import { ANALYSIS_STRIKE_MS, drawAnalysis, drawBustBlock, drawHands, drawMulliganDiscard, drawReturnCard, drawShoe, drawShuffle, playerCardCenter, setHoloFlickerStatic, shoeAnchor, SHUFFLE_SPLIT_FRACTION, type RoundResult } from '../render/cards'
import { drawDamageFx } from '../render/damage-fx'
import { abbreviateCount } from '../render/format'
import { drawDealer, drawDealerEyeGlow } from '../render/dealer'
import { drawClown } from '../render/clown'
import { drawHoloRays, drawStrikeFx, nexusHoloLight, nexusUtilityLight, type HoloRayTarget } from '../render/nexus'
import { dealerColors, isRgbDealer } from '../render/palette'
import { Scene, computeLayout, type Layout } from '../render/scene'
import { smoothEnd2, smoothStart2 } from '../render/easing'
import { drawSpecSheet, SPEC_STRIKE_MS, type SpecFlag, type SpecReadout } from '../render/spec-sheet'
import { drawScoreSheet, drawScoreTitle, scoreBoardPlacement, SCORE_LEFT_SHIFT, type ScoreReadout } from '../render/score-sheet'
import { drawCodaStake } from '../render/coda-stake'
import { drawCodaCounters } from '../render/coda-counters'
import { CASH_IN_REVEAL_MS, CASH_IN_STAGGER, drawHandSummary, type HandSummaryView, type SummarySlot } from '../render/hand-summary'
import { drawHearts } from '../render/hearts'
import { drawTapToStart } from '../render/tap-to-start'
import { drawOldDeckShred, drawShred, drawSpawnDeck, SHEET_SLIDE_START } from '../render/spawn'
import { DELTA_FLY_MS, drawScoreDeltas } from '../render/score-deltas'
import { drawTokens, type Point } from '../render/tokens'
import { ScoreDeltaFly } from './score-delta-animator'
import { ChipAnimation } from './chip-animator'
import { CodaCounterAnimation } from './coda-counter-animator'
import { CountTicker } from './count-ticker'
import { BustBlockAnimation } from './bust-block-animator'
import { DealAnimation } from './deal-animator'
import { DealerAnimation, HIT_TOTAL_MS, KILL_ARRIVE_MS, KILL_DEATH_LEAD_MS, KILL_DEATH_MS, KILL_DYING_MS, KILL_TOTAL_MS, STRIKE_TRAVEL_MS } from './dealer-animator'
import { ClownAnimation } from './clown-animator'
import { SpawnAnimation } from './spawn-animator'
import { MulliganAnimation } from './mulligan-animator'
import { NexusAnimation } from './nexus-animator'
import { HeartAnimation } from './heart-animator'
import { ReturnAnimation } from './return-animator'
import { FLY_MS, TokenAnimation } from './token-animator'
import { createStage, type Stage } from './stage'
import { ViewportGuard } from './viewport-guard'
import { sfx } from '../audio/sfx'
import { music } from '../audio/music'
import { angryGrowlPattern, clownifyLaugh, evilLaughPattern, voice, voiceSeedFor, type VoicePattern } from '../audio/voice'

// The token icon, imported once so Vite fingerprints the URL and the browser
// fetches it a single time on load; every <img> that references it (the token
// counter + each powerup cost pill) then serves from cache.
import powerUrl from '../assets/power.png'
// The choose-upgrade path icons (replace the path name text on each big button).
import detectiveUrl from '../assets/detective.png'
import chipUrl from '../assets/poker-chip.png'
// The yellow POINTS star, shown beside the top-right score counter.
import starUrl from '../assets/star.png'

// Path → icon: Sabotage a detective, Payout a chip, Tokens the token icon.
const UPGRADE_ICONS: Record<UpgradePath, string> = {
  antiDealer: detectiveUrl,
  chipEco: chipUrl,
  tokenEco: powerUrl,
}

// Canvas layers (canvases), bottom → top. Merged from 11 single-purpose layers into 6 grouped
// canvases to cut per-frame compositing + GPU memory (each canvas is a full-screen backing store the
// browser composites every painted frame). Each group is repainted by a render wrapper (renderCast_/
// renderPlay_/renderNexus_/renderOverlay_) that clears the canvas ONCE, then paints its members in
// z-order — so a partial redraw can't wipe a sibling. Z-order (and the reasons) are preserved:
//  - 'room'    = the backdrop (static; painted only on resize).
//  - 'cast'    = dealer + clown figures. BELOW 'felt' so the rail hides their lower bodies + death debris.
//  - 'felt'    = table felt/rail + resting deck (static; painted by paintTable_ on deck/resize events).
//  - 'play'    = dealt cards + all holo readouts + the coda pot (cards below chips, as before).
//  - 'nexus'   = the floating nexus device + laser (its own canvas: it hovers continuously + strikes on wins).
//  - 'overlay' = hearts, flying tokens, "+N" score deltas, and (top, additive) the eye-glow + holo ray fans.
const LAYERS = ['room', 'cast', 'felt', 'play', 'nexus', 'overlay'] as const

// The final scoreboard has two pages (run summary + performance stats), flipped by the ‹ › pager.
const SCORE_PAGES = 2

// When a reward's tokens lift off, relative to the card motion settling
// (anim.animEnd): a hit's token waits a short beat after its card lands, and a
// resolve's winning hands stagger their bursts so splits cascade.
const TOKEN_SPAWN_DELAY = 90
const TOKEN_HAND_STAGGER = 120
// How fast the shredder bed (sample + vacuum) fades once the last card is drawn in —
// kept short so the sound doesn't trail past the visual shred.
const SHRED_FADE_MS = 130
// Spacing between a burst's per-token blips (both the launch shower from the nexus
// and the land shower at the counter) — tight, so several sprites read as a quick
// coin shower rather than a sparse trickle. The counter's roll is matched to the
// land shower's length so the number lands with the last ping (see frame()).
const TOKEN_TONE_STAGGER_MS = 45

// How long a dismissed Analyze reading takes to flicker out.
const ANALYSIS_FADE_MS = 300

// How long the info-button spec-sheet projection takes to flicker out when toggled off
// (mirror of the strike-on; see specRender + render/spec-sheet.ts).
const SPEC_FADE_MS = 320


// How many light rays the holo projector fans onto each number it projects.
const HOLO_RAYS_PER = 5

// Beat after a resolved hand settles (its reward tokens fly, the hand-summary shows) before the
// nexus fires its damage laser — so the reward lands before the attack, never during.
const LASER_GAP = 180
// Sabotage T1: a dealer 21 flies a +20 ENERGY burst (SABOTAGE_DEALER21_ENERGY). The nexus attack —
// the heart-pop laser on a loss, or the dealer laser on a hijack win — is held until that burst has
// fully LANDED plus this gap, so the energy reward reads as a clean, complete beat before the strike.
const ENERGY_ATTACK_GAP = 300
// Beat after a dealer that SURVIVED its window strides off before its replacement walks in.
const WINDOW_WALKIN_DELAY = 300
// The dealer hand-summary: the whole board's ease-IN on appearance, how long it then holds the OLD
// state before the new slots start cascading in (render/hand-summary.ts owns the per-slot cascade
// timing, CASH_IN_STAGGER apart), and the whole board's fade-OUT on Next hand. The fade-in settles
// WELL before the appear-hold ends, so the board is fully present by the time the cascade begins.
const SUMMARY_FADE_IN_MS = 260
const SUMMARY_APPEAR_HOLD = 360
const SUMMARY_FADE_MS = 300
// Minimum time the FULLY-REVEALED summary stays put before it may fade out — but ONLY when the
// player pre-clicked Next hand (before the summary appeared): the deferred proceed then waits this
// long past the reveal so the board reads as [fade in] → [hold ≥ this] → [fade out] instead of
// snapping straight from reveal to fade. A click AFTER the summary is up ignores it (the player has
// already seen the result and is dismissing it).
const SUMMARY_MIN_HOLD = 400
// Beat after a lost hand's cards settle before the yellow heal beam lifts off (a
// late dealer repairing itself on a win) — so the repair reads as its own moment.
const HEAL_GAP = 220
// How long the nexus lens flares red as it fires the heart-pop laser on a loss (no dealer laser
// competes for the muzzle then, so it can flash for the strike).
const HEART_MUZZLE_MS = 260
// Beat after the nexus attack (and any death → walk-in) finishes before the spent
// cards gather back into the deck — the winning hand's final beat.
const GATHER_GAP = 220
// Beat after the returned card merges into the deck before the dealer plays out.
const RETURN_DEAL_DELAY = 220
// How much the dealer-spawn shred overlaps the tail of the walk-in, so the cards
// start being sucked in just as the new dealer arrives (no dead beat between).
const SHRED_ARRIVE_OVERLAP = 140
// A beat between the Banker finishing his entry shred and starting to cackle — his laugh lands this
// long after the shredding animation ends, so the two don't run on top of each other.
const BANKER_LAUGH_DELAY = 300
// A kill that grants an upgrade pick is played in two halves so the selector sits in
// the middle: the dealer is destroyed, then after this beat the upgrade card appears;
// once the player picks, the replacement's walk-in ceremony begins after this beat.
// The dealer already shattered (and its +40 bounty already flew) back on the resolve laser, so the
// selector just needs a short breath AFTER the hand-summary fades out of the way before it surfaces
// over the now-empty table.
const UPGRADE_REVEAL_LEAD = 350
const CEREMONY_LEAD = 800 // upgrade picked → new dealer walks in
// The Banker coda's timing: the beat after the entry ceremony before the prompt appears, and
// the beat a resolved double-or-nothing hand holds (so its result reads) before it doubles/ends.
const CODA_ENTRY_HOLD = 500
const CODA_RESULT_HOLD = 900
// A push auto-re-deals with NO prompt, so its resolved hand needn't linger as long as a win
// (re-prompt) or loss (game-over) before the board clears — half the result beat.
const CODA_PUSH_HOLD = 450
// Extra beat when a coda hand resolves ON THE DEAL (a natural blackjack — auto-resolved, no
// hit/stand prompt): hold the cards on the felt this much longer before the auto-collection so
// the player can register the instant blackjack. (Halved from 2500 — the old hold ran too long.)
const CODA_NATURAL_HOLD = 1250
// Beat after the boss is fully gone before the Banker strides in (a clear pause).
const CODA_WALKIN_DELAY = 500
// Extra hold once dealer 6's clown has fully walked off screen, before the Banker's entrance —
// so the two exits/entrances never overlap. Gated dynamically on the clown in the frame loop
// (its walk-off completes ~460ms AFTER codaArrivalAt_ alone would have fired), not baked into
// codaArrivalAt_, since the clown's walk-off clock isn't known when beginCoda_ schedules that.
const CODA_CLOWN_CLEAR_MS = 300
// How long the stake projection takes to fade out when the prompt closes (DOUBLE / cash-out).
const CODA_STAKE_FADE_MS = 260
// The coda pot renders as glass markers that COLOUR UP: 2^wins decomposes into perTier(wins)
// markers (1/2/4/8) of tier(wins), each tier worth 16× the last. Every 4th win fuses the
// eight markers into one of the next denomination, so the felt never holds more than eight.
const CODA_WINS_PER_TIER = 4
function codaTier(wins: number): number {
  return Math.floor(wins / CODA_WINS_PER_TIER)
}
function codaPerTier(wins: number): number {
  return 1 << (wins % CODA_WINS_PER_TIER)
}
// The Banker figure's shift sentinel — one past the last real dealer. drawFigure/dealerColors
// key off it for the Banker's look; the coda run sits at run.shiftIndex 7 too, so the health
// math (integrity / maxHitsFor(7)) reads full.
const BANKER_SHIFT = TOTAL_DEALERS + 1
// The Banker's amused-cackle identity: a fixed seed (same voice every run) and a mid-shift
// laugh — lighter + quicker than the menacing final-boss cackle. He's entertained, not
// threatening; fired on his walk-in, on each double-or-nothing, and on a losing hand.
const BANKER_VOICE_SEED = 0x8a17c30d
const BANKER_LAUGH_SHIFT = 3
// The Banker's cackle plays louder than the dealers' voices (a gain scale on voice.play).
const BANKER_LAUGH_GAIN = 1.6
// The dealer-6 clown's voice: a fixed seed (a stable clown laugh, pitched up by clownifyLaugh)
// for its own death cackle; it plays a touch quieter than the dealer (a smaller sidekick), and
// echoes the dealer's laughs CLOWN_LAUGH_DELAY_MS behind them. CLOWN_LAUGH_LEAD is the little
// lead on its stand-alone death laugh (so it lands just after the killing blow reads).
const CLOWN_VOICE_SEED = 0x5c107a11
const CLOWN_LAUGH_GAIN = 0.7
const CLOWN_LAUGH_DELAY_MS = 600
const CLOWN_LAUGH_LEAD = 0.2
// Tolerance (ms) for matching a walk-in/off's derived start stamp frame-to-frame, so its
// entrance voice fires once. Far above the ~1ms float jitter, far below the seconds between
// two real entrances.
const VOICE_START_EPS = 200
// The dealer (2–6) laughs as the cards deal when the player shoves ALL-IN and the table is
// still above this integrity fraction (a healthy house savouring a desperate gamble).
const ALLIN_LAUGH_HEALTH = 0.25
// "On the ropes": a dealer walking in laughs (mocks) instead of growling when the player would
// is holding fewer than this many tokens (the incoming dealer mocks a token-poor player).
const ROPES_TOKENS = 250
// After the tap-to-start tap, the "TAP TO START" projection fades out over this window before
// the scene starts (walk-in + HUD + first deal) — a short beat so the tap doesn't snap the game in.
const TAP_FADE_MS = 300
// The player hearts ease IN over this window once the scene starts (they're hidden on the
// tap-to-start / title screen) — matched to the HUD overlay's 0.5s opacity transition so the
// hearts and the counters fade up together.
const HEARTS_FADE_MS = 500
// Game over: beat after the ending hand's cards settle before the dealer sucks them up
// and shreds them (a win → laser death; a loss → walk-off), then projects the score.
const END_SHRED_GAP = 200
// A picked upgrade plays a dismiss animation (darkness + card fade, chosen button
// scales up) before the pick commits. Kept in sync with .upgrade-panel.is-dismissing.
const UPGRADE_DISMISS_MS = 350

// --- Battery saver (ui/game-view drives the loop; pref lives in game/power-mode) --------------
// When battery saver is on the render loop FULLY PARKS once the scene has been visually quiet
// (nothing moving) for SETTLE_GRACE_MS — instead of running the perpetual ambient (nexus hover,
// holo, damage sparks) at 60fps forever. Even a damaged dealer parks: its idle sparks are
// suppressed (a static figure) and sparks only fly during hits/strikes (those are busy → full
// speed). The grace period is deliberately generous so every short cosmetic fade
// (summary/spec/coda-stake/hearts/tap, the dealer laugh) finishes before we park, WITHOUT the loop
// needing to enumerate each one. While parked we still re-check at WATCHDOG_MS (~1fps — negligible
// battery) so anything the "busy" check missed self-heals within a second rather than freezing.
const SETTLE_GRACE_MS = 1200
const WATCHDOG_MS = 1000
// The fixed clock the ambient world (nexus device, holo rays, holo glow) renders at while battery
// saver is on — so it's a STATIC object that never hovers or skips. Any constant works; this phase
// sits the nexus at a neutral mid-hover.
const SAVER_STATIC_NOW = 0

interface ButtonDef {
  key: string
  label: string
  group: 'action' | 'power' | 'coda-power'
  /** True for the Banker-coda buttons — routed through runCoda, not run(). */
  coda?: boolean
  /** Token price, shown as a cost pill on the button (powerups + coda abilities). */
  cost?: number
  /** Coda ability whose `cost` is inflation-adjusted (powerupCost) rather than flat. */
  inflated?: boolean
  /**
   * Explicit tiebreak among equal-cost powerups (lower = higher in the column).
   * Only set where source order isn't the wanted display order; unset → 0, so
   * ties without an `order` still fall back to source order (stable sort).
   */
  order?: number
  act: () => void
  visible: (s: SessionState) => boolean
  enabled: (s: SessionState) => boolean
  /** When true, the button glows to show the powerup is currently armed. */
  active?: (s: SessionState) => boolean
}

export function mountGameView(root: HTMLElement): void {
  new GameView(root)
}

class GameView {
  private readonly session_: Session
  // Assigned in the constructor via seedVisualsFromState() (before any use).
  private state_!: SessionState
  // The dealer hand-summary shown between hands (the maxHands window slots + the newest reveal), and
  // when its fade-out began (0 = showing). Built in run_, painted by drawChips_/summaryView_.
  //  • appearAt — when the board starts easing IN. Set once the resolve knows its laser timing: AFTER
  //    the laser lands on a win (the summary follows the attack), or at the card-settle on a loss.
  //    0 until scheduled (nothing drawn yet).
  //  • playedCount — how many new slots are the real result (1 single, 2 split/double); the rest (on
  //    a kill) are the green cash-in cascade, timed from cashInAt.
  private summary_: {
    slots: SummarySlot[]
    revealFrom: number
    playedCount: number
    appearAt: number
    cashInAt: number
  } | null = null
  private summaryFadeAt_ = 0
  private readonly scene_ = new Scene()
  private readonly anim_ = new DealAnimation()
  private readonly chips_ = new ChipAnimation()
  private readonly dealer_ = new DealerAnimation()
  // The clown sidekick that shadows dealer 6 (the RGB final dealer) — follows it in, stands to
  // its right, laughs when it laughs, and strides off when it dies or leaves. Derived entirely
  // from the dealer's state each frame (clown_.observe), so it needs no action-sequencing hooks.
  private readonly clown_ = new ClownAnimation()
  // The dealer emote (start stamp) the clown has already mirrored onto its own grin — so a laugh
  // is echoed exactly once, not re-fired every frame it stays armed.
  private lastClownEmoteStart_ = -1
  private readonly tokens_ = new TokenAnimation()
  private readonly mulligan_ = new MulliganAnimation()
  private readonly returnAnim_ = new ReturnAnimation()
  // The Bust Block shield's reveal: the caught busting card is shown, then swept
  // off, before any replacement is dealt.
  private readonly bustBlock_ = new BustBlockAnimation()
  // The dealer-spawn ceremony: shred the previous dealer's cards into the new
  // dealer's mouth, then fly in a fresh shrink-wrapped deck + tear off the plastic.
  private readonly spawn_ = new SpawnAnimation()
  // The table nexus's twin emitter lights: dim at rest, glowing while the nexus
  // pays out its reward tokens and fires its damage laser (see run()).
  private readonly nexus_ = new NexusAnimation()
  private readonly hearts_ = new HeartAnimation()
  // The two number readouts roll from their old value to the new one (ticking through the integers)
  // and swell while they roll, rather than snapping: the token count as rewards land, the score as
  // points tick up. The token counter rolls in BOTH directions (rewards up, spends down); the score
  // counter (below) rolls UP only.
  private readonly tokenTicker_ = new CountTicker(0, true)
  // The points counter rolls UP only. It's held at its pre-resolve value (heldScore)
  // from the moment a hand resolves until that hand's reward tokens land at the token
  // counter, then released to run.score — so points always rise AFTER the token reward,
  // never before. `pendingScoreDelta` is the "+N" flashed underneath on release;
  // `scoreReleaseAt` is a fallback so a token-less win (a chips-only push) still ticks.
  private readonly scoreTicker_ = new CountTicker()
  private heldScore_: number | null = null
  private pendingScoreDelta_ = 0
  // Reward multiplier carried to the score-release flash. Always 1 now (the hit combo was removed) —
  // kept so holdScoreReward_/flashPointsDelta_ still show a plain "+N".
  private pendingMult_ = 1
  private scoreReleaseAt_ = 0
  // The fly-in score deltas (normal play): each winning green check launches a "+N" that arcs to a
  // stacked row below the counter, ticking it as it lands. While these fly the counter is held at
  // `deltaHoldBase` (the pre-resolve score) and climbs by `deltaLandedSum` as each lands — so it
  // never runs ahead of the deltas. `deltaPending` is the launch schedule (one per green check, fired
  // as its check reveals in drawCards_); `deltaLandIndex` steps the arrival tone's pitch up the run.
  private readonly scoreDeltas_ = new ScoreDeltaFly()
  private deltaHoldBase_: number | null = null
  private deltaLandedSum_ = 0
  private deltaPending_: { value: number; slotIndex: number; spawnAt: number; rowIndex: number }[] = []
  private deltaEmitted_ = 0
  private deltaLandIndex_ = 0
  // Edge tracker: true while the points counter is mid-roll, so the ticking sound fires
  // once when a roll starts (not every frame it runs).
  private pointsRolling_ = false
  private readonly stage_: Stage
  private raf_ = 0
  // Battery saver: whether the mode is active (read once from the pref, refreshed on toggle),
  // a shared setTimeout handle for the pulse/watchdog sleep (0 = none), and the timestamp of the
  // last frame that had real motion — the grace clock the park decision keys off. See frame_.
  private batterySaver_ = isBatterySaver()
  private sleepTimer_ = 0
  private lastBusyAt_ = 0
  // A recent, valid timestamp captured the instant the scene goes quiet — battery saver freezes the
  // start-stamped draws (cards, dealer figure) at THIS while idle, so they hold their real resting
  // pose (drawing them at an absolute constant would place them before their walk-in). See frame_.
  private freezeAt_ = 0
  // Like freezeAt_ but for the dealer FIGURE specifically: the last time the dealer was doing its OWN
  // choreography (a hit/kill/walk-in/emote). In battery saver the figure clock freezes here whenever
  // the dealer isn't attacking/emoting — so a wounded dealer's ambient sparks + eye-flicker DON'T come
  // alive just because something else (dealing cards) is animating. Damage FX play only when attacked.
  private dealerFreezeAt_ = 0
  private lastDealerChoreographing_ = false
  // Per-canvas dirty flags (Stage B). The 'cast' (robot figure) and 'nexus' (device) canvases are
  // skipped when nothing on them changed — the figure/device are otherwise redrawn every frame. Set
  // true by markGroupsDirty_ (via ensureLoop_, so every action/wake) and by the per-frame "active"
  // checks (an animator running); cleared after a redraw. 'play' + 'overlay' still redraw every
  // rendered frame (they carry the holo readouts / frameProjections, whose many timed reveals make
  // gating them risky — and they already park when idle). Start dirty so the first frame paints.
  private castDirty_ = true
  private nexusDirty_ = true
  private lastAnimating_ = false
  // Edge tracker for the dealer-death pause: when it clears, buttons re-enable.
  private lastDealerBlocking_ = false
  // Start-timestamps of the walk-in / walk-off we last voiced, so the growl/laugh fires
  // exactly ONCE per entrance/exit. Keyed on the START stamp (derived as now − progress·dur)
  // rather than a boolean edge, because the loop re-runs a frame at a slightly different clock
  // (the frozen-clock probe) — a boolean edge double-fires there. Matched with a tolerance:
  // the derived start jitters ~1ms across frames (float rounding of `progress`), while two
  // real entrances are seconds apart, so VOICE_START_EPS cleanly separates them.
  private lastWalkInStart_ = -1e9
  private lastWalkOffStart_ = -1e9
  // The card being returned (flips + flies back to the deck) and where it set off.
  private returnCardData_: { card: Card; from: Point } | null = null
  // The busting card the Bust Block shield caught, with the hand + slot it's shown
  // on. Drawn (over the settled hand) while `bustBlock` animates.
  private bustBlockData_: { handIndex: number; cardIndex: number; card: Card } | null = null
  // The winning hand's attack. The nexus laser now AUTO-FIRES on the resolve (after the reward
  // tokens + points), NOT on the Next-hand click: a `damage` hit drops the dealer's health, a
  // `kill` shatters it on impact (the +40 bounty flies with the death), a `windowOut` gets no laser
  // (the survivor just strides off). `kind` is still read by the Next-hand block to route the
  // table's advance (gather / walk-in+upgrade / walk-off). `dealAfter` is when the next deal waits.
  private pendingAttack_: { fromIntegrity: number; fromShift: number; toIntegrity: number; toShift: number; kind: 'kill' | 'windowOut' | 'damage' } | null = null
  // The resolve choreography's finish line — the earliest the Next-hand consent may act (the laser
  // has landed AND the summary's result mark/cash-in has revealed). A click before this doesn't
  // fast-forward: it arms `proceedPending`, which the frame loop fires once this passes.
  private resolveAttackEnd_ = 0
  private proceedPending_ = false
  // A heart-death (last hit point lost) is entering the coda: the losing summary + final heart pop
  // play FIRST, then the deferred coda entry fires. While set, the summary/hearts keep drawing over
  // the 'coda' phase, and the coda counters hold back. Consumed by the frame loop at heartDeathAt_.
  private heartDeathPending_ = false
  private heartDeathAt_ = 0
  private heartDeathEntry_: { prevScore: number; prevIntegrity: number; prevShift: number; integrity: number } | null = null
  private dealAfter_ = 0
  // A kill splits the ceremony around the Next-hand click: the dealer already SHATTERED on the
  // resolve laser, and the replacement's arrival (walk-in + shred + fresh deck) is deferred — until
  // the player picks an upgrade, or (no upgrade) until the summary fades and it walks straight in.
  // This holds what that deferred arrival needs — the round to shred + the incoming dealer — set on
  // the click, cleared when the arrival fires. `upgradeRevealAt` is when the selector may surface (a
  // beat after the summary clears), gating syncUpgradePanel so it doesn't pop up over the summary.
  private pendingCeremony_: { prevRound: Round; incomingShift: number; incomingIntegrity: number } | null = null
  private upgradeRevealAt_ = 0
  // True while a picked upgrade's dismiss animation plays (before the pick commits);
  // syncUpgradePanel yields the panel to the animation during this window.
  private upgradeDismissing_ = false
  // Edge tracker: fire the upgrade-menu sfx the frame the choose-upgrade buttons
  // first surface (hidden → shown), then again only after they've hidden.
  private upgradeShown_ = false
  // When the current Analyze reading first appeared, so its flicker can ramp in
  // from that moment (the projection stutters on over the first few hundred ms).
  private analysisStart_ = 0
  // A dismissed reading, retained so it can flicker OUT (mirror of the strike-on)
  // over ANALYSIS_FADE_MS instead of vanishing; null once faded.
  private analysisFadeOut_: SessionState['analysis'] = null
  private analysisFadeStart_ = 0
  // The info-button spec sheet the nexus projects onto the felt (token inflation + the
  // active ruleset). `specShownAt` is when it was toggled on (drives the flicker-in);
  // `specHideStart` when it was toggled off (drives the mirror flicker-out). At most one
  // is non-null — both null means nothing is projected. See toggleSpec / specRender.
  private specShownAt_: number | null = null
  private specHideStart_: number | null = null
  // Game-over score screen: `scoreRevealAt` is when the nexus starts projecting the run
  // summary (once the ending cards are sucked up) — 0 until scheduled; `scoreRevealed`
  // latches true at that moment (edge → re-sync so the New-run button appears). See
  // beginEndGame / scoreRender. `endShredDone` suppresses the settled-card redraw so the
  // shredded cards stay gone. `spawnShredOnly` marks a shred with no fresh deck flying in.
  private scoreRevealAt_ = 0
  private scoreRevealed_ = false
  // The final scoreboard's current page: 0 = the run summary, 1 = the performance stats
  // (bust %, blackjack %, star rating). Flipped by the DOM pager (‹ ›) below the board; reset
  // to 0 each time the board is revealed (line ~scoreRevealed latch).
  private scorePage_ = 0
  private endShredDone_ = false
  private spawnShredOnly_ = false
  // The Banker coda: `codaAdvanceAt` fires codaResolveNext once a resolved coda hand's reveal
  // beat passes (0 = nothing pending); `codaStakeShownAt` is the strike-in stamp for the
  // "points at risk" projection.
  private codaAdvanceAt_ = 0
  private codaStakeShownAt_ = 0
  // Fade-out of the stake projection once the prompt closes (DOUBLE / cash-out): when the fade
  // began, plus the content frozen at that moment so it fades the prompt, not the live hand.
  private codaStakeHideAt_ = 0
  private codaStakeFadePoints_ = 0
  private codaStakeFadeWon_ = false
  // True from the Banker's entry until his shred finishes, so the killing hand's cards are
  // marked gone (endShredDone) at the right moment and don't redraw before the prompt.
  private codaEntering_ = false
  // Whether the Banker has laid out his own deck yet. He shreds the boss's cards on entry but
  // only pulls out + unwraps his deck on the FIRST double-or-nothing (codaGamble).
  private codaDeckOut_ = false
  // The Banker's entrance is deferred a beat after the boss dies: `codaArrivalAt` is when his
  // walk-in fires (0 = none pending), and `codaEntryScore` is the stake to roll up as he arrives.
  private codaArrivalAt_ = 0
  // Once codaArrivalAt_ is reached, the Banker still waits for dealer 6's clown to clear the
  // screen: this is stamped (= now + CODA_CLOWN_CLEAR_MS) the frame the clown goes off-screen,
  // and the walk-in fires when it elapses. 0 while the clown is still exiting (or not yet stamped).
  private codaClownClearAt_ = 0
  // A dealer that SURVIVED its window walks off, then its replacement walks in — the walk-in is
  // deferred to this timestamp (like codaArrivalAt_) so the old figure keeps its colour off-screen.
  private windowArrivalAt_ = 0
  private pendingWindowOut_: { incomingShift: number; incomingIntegrity: number } | null = null
  // When to start the "Decisions" (Banker waiting) music: the moment his entry shred COMPLETES
  // (set from playCodaArrival, = codaShredEndAt; 0 = none pending). It plays once, filling what
  // used to be the coda-entry silence, while the player weighs double-or-nothing.
  private codaDecisionsAt_ = 0
  private codaEntryScore_: { prevScore: number; gained: number } | null = null
  // When the Banker's first-double deck fly-in lands, so it's committed to the static table
  // (visible as the cards deal from it) rather than only after the whole deal finishes.
  private codaDeckCommitAt_ = 0
  // When the Banker's entry shred finishes — then the killing hand's cards are marked gone and
  // collectRound cleared. Deferred from the settle so the dealt cards get chewed on his arrival
  // instead of despawning during the boss death.
  private codaShredEndAt_ = 0
  // When the chips start fading out (the last dealer just died — no bets in the coda).
  // When to fade the fight music out to silence at coda entry: the moment the dealer-6 winning
  // hand is revealed (its cards settle). The quiet holds through the Banker's walk-in + shred
  // until the "Decisions" theme rises (codaDecisionsAt) once the shred completes.
  private codaMusicFadeAt_ = 0
  // Whether the current coda prompt follows a HAND WIN — the banker-hand-win scoreboard (left-
  // justified, offer last, slow-clap sfx). false = the plain centred entry offer.
  private codaWonHand_ = false
  // Wall-clock until which the prompt's Double-or-nothing / Cash-out stay disabled after a coda
  // WIN — long enough for BOTH the top-right score roll and the glass-pot grow/colour-up to settle,
  // so the player can't gamble or cash out mid-scoreboard-update. 0 = no lock (past = unlocked).
  private codaChoiceReadyAt_ = 0
  // Was the coda choice-lock active last frame? Drives a falling-edge re-sync so the buttons
  // re-enable on the exact frame codaChoiceReadyAt passes (syncOverlay isn't called every frame).
  private lastCodaChoiceLocked_ = false
  // The Banker coda's glass winnings counters: physical markers that make the pot tangible.
  // codaCrystalValue is the ENTRY score (the base unit); codaWins is how many coda hands have
  // been won. The pot is 2^wins × base, rendered as codaPerTier(wins) markers of codaTier(wins)
  // — the markers COLOUR UP into higher denominations rather than overflowing the felt. The
  // animation owns timing (reveal / grow / colour-up on a win, fly back on a bust).
  private readonly codaCounters_ = new CodaCounterAnimation()
  private codaCrystalValue_ = 0
  private codaWins_ = 0
  // Every projected-number box actually drawn this frame (counts, chip amounts, analysis
  // rows). The number-drawing calls append here, and drawHoloProjection fires a ray fan at
  // each — so a ray exists iff its number is on screen, at exactly its position. Cleared at
  // the top of drawCards (the first draw of the frame); read in drawMask (after drawChips).
  private frameProjections_: HoloRayTarget[] = []
  // Battery-saver holo-ray cache: in saver mode the ray fans are static (their shimmer clock is a
  // constant), so instead of rebuilding 5 gradients + filling 5 additive triangles per readout every
  // awake frame, we bake them ONCE to this offscreen canvas and blit it, rebuilding only when the
  // projection geometry actually changes (a count moved, a readout appeared) — see drawHoloProjection_.
  // `key` fingerprints that geometry; null canvas = not yet built. Untouched outside saver mode.
  private holoCache_: SpriteCanvas | null = null
  private holoCacheKey_ = ''
  private holoCacheDpr_ = 0
  // The ending hand's round, retained so its cards can be gathered back into
  // the deck after the Session has already cleared `state.round`.
  private collectRound_: Round | null = null
  // The pre-split (single-hand) round, retained across the split's glide so
  // drawHands can tween the two originals out of their old slots. Set on a split,
  // cleared on the next action.
  private splitPrev_: Round | null = null
  // While gathering + shuffling, the deck is drawn on the cards layer (so it can
  // split/move) and hidden on the static table layer.
  private deckOnCards_ = false
  // Which dealer's colour the deck is currently painted in (marks progression). On a
  // kill the deck swap is the spawn ceremony (shred + fresh deck), which commits the
  // new colour when it settles (see the deckColorShift assignment there).
  private deckColorShift_ = 1
  // Edge tracker for the shuffle sfx: true once the riffle passes its split phase
  // and the piles start merging (where the clip's cascade actually sounds).
  private shuffleMergingLast_ = false
  // Previous frame's deck-unwrap progress (0..1), for firing the packaging sfx as
  // the wrap tears open (unwrap leaves 0) and the sheet slides off left (crosses
  // SHEET_SLIDE_START).
  private prevUnwrap_ = 0
  // Edge tracker for the shredder bed: true while the dealer is shredding cards, so
  // the loop starts on the leading edge and fast-fades on the trailing one.
  private shreddingLast_ = false
  // Edge tracker: play the win/loss sting once, the frame the resolved hand's
  // cards settle and the result is revealed. Reset when the round leaves resolved/over.
  private resultRevealed_ = false
  // A natural blackjack dealt straight off the deal auto-resolves before the player ever acts,
  // so the round is 'resolved' the instant the cards start flying in. Latched at that deal (in
  // run()) so `dealRevealPending()` can keep the play buttons up over the reveal instead of
  // flashing the Next-hand button early and spoiling the instant blackjack. Any later action
  // (which is never 'betting' → 'resolved') clears it.
  private dealNatural_ = false
  // A dealer-spawn ceremony's incoming deck colour, committed to `deckColorShift`
  // (and handed back to the static table) once the new wrapped deck lands + unwraps.
  private spawnIncomingShift_: number | null = null
  // True while a ceremony is shredding the PREVIOUS dealer's resting deck (a kill / New
  // run) — drawn on the cards layer (resting → sucked into the mouth) with the static
  // table deck hidden. False on the opening intro (no old deck exists yet).
  private spawnHasOldDeck_ = false
  // True only during the opening intro, before the very first deck has flown in —
  // suppresses the static resting deck until the ceremony delivers it.
  private deckHidden_ = false
  // The opening walk-in is HELD (dealer parked off-screen, invisible) from construction
  // until the render loop is producing steady frames — so the post-load settling stall
  // (a single ~250ms first frame after the Vite dev module load, from JIT/GC/first
  // composite) is spent during the invisible hold, not as a teleport across the visible
  // slide-in. Released in frame() → startIntroNow once frames are steady.
  private introHold_ = false
  private introHoldStart_ = 0
  private introPrevFrame_ = 0
  private introSteadyFrames_ = 0
  // False until the player's first tap. The opening plays on load, then the game HOLDS the first
  // deal (and projects "TAP TO START" from the nexus) until this flips — the tap also unlocks the
  // audio contexts (context.ts/main.ts window listeners), so all gameplay sound is on. Set in
  // buildIntroScreen's tap handler.
  private started_ = false
  // The timestamp the scene started (started_ flipped true) — the tap-to-start fade-out completing,
  // or a Continue/New game resuming in place. Drives the player hearts' fade-IN (they stay hidden on
  // the title/tap screen, then ease in with the HUD once the game begins).
  private startedAt_ = 0
  // Whether we've told CrazyGames a hand is actively being played (SDK.game.gameplayStart). Driven
  // off the phase each frame; toggled only on change.
  private gameplayActive_ = false
  // Highest game-completion % reported to CrazyGames this run (each of the 6 dealer kills is a
  // milestone; arriving at the Banker is 100%). A drop (fresh/restarted run) re-baselines it.
  private reportedProgressPct_ = 0
  // When the "TAP TO START" projection first appeared (for its strike-in), or 0 while hidden.
  private tapShownAt_ = 0
  // When the player tapped to start, or 0 before the tap. During [tapAt, tapAt + TAP_FADE_MS) the
  // projection fades out; at the end `started` flips and the scene begins. The catcher is held
  // for the whole beat so a second tap can't slip through to the (still-hidden) HUD.
  private tapAt_ = 0
  private introCatcher_: HTMLElement | null = null
  // A saved in-progress SESSION to offer on the title screen (else null — normal tap-to-start). Set
  // at construction from persistence.loadSession(); consumed/cleared by beginFromTitle. Carries the
  // exact phase + in-progress round, so Continue can resume mid-hand / mid-coda, not just at betting.
  private resumableRun_: PersistedSession | null = null
  // The Continue / New game title menu element (when a resumable run exists), else null.
  private titleMenu_: HTMLElement | null = null
  // True once the title menu has been shown, so the nexus "TAP TO START" prompt stays suppressed
  // (the wordmark still projects) — the HTML buttons are the prompt. Never reset.
  private titleMenuMode_ = false
  // Latches true once the OPENING hand's cards have fully landed. Until then, every projected count
  // (card totals) is held back so they appear together at the end of the deal rather than trickling
  // in one-by-one amid the tap-to-start light rays. First hand only; once latched, later hands
  // reveal their counts per-card/per-lane as usual (firstHandCountsHidden).
  private openingCountsShown_ = false

  private readonly defs_: ButtonDef[]
  private tokensEl_!: HTMLElement
  private tokenCountEl_!: HTMLElement
  // Win/blackjack tokens are credited to run.tokens the instant a hand resolves, but held out of
  // the counter (no flight, no number bump) until the player calls the next hand.
  private heldTokens_ = 0
  // Last values written to the token counter's DOM, so updateTokenCounter can skip the
  // write when nothing changed (it's called every frame).
  private lastTokenText_ = ''
  private lastTokenTransform_ = ''
  private messageEl_!: HTMLElement
  private buttons_!: Record<string, HTMLButtonElement>
  // Per-powerup cost-pill number spans, rewritten each frame to the inflated price.
  private costPills_!: Record<string, HTMLElement>
  // The arcade points counter (top-right): the number span (swelled as it rolls) and
  // the "+N" delta that flashes underneath each time it starts ticking.
  private pointsCountEl_!: HTMLElement
  private pointsDeltaEl_!: HTMLElement
  // The points counter's outer container (top-right), toggled hidden during the Banker coda —
  // the score is fixed once the coda starts, so the corner readout just adds clutter there.
  private pointsEl_!: HTMLElement
  // The star + number row — the swell transform rides this so the star pumps with the count
  // (and the delta, a sibling of the row, isn't dragged by it).
  private pointsRowEl_!: HTMLElement
  // Last values written to the points counter's DOM, so updatePointsCounter can skip the
  // write when nothing changed (it's called every frame, like the token counter).
  private lastPointsText_ = ''
  private lastPointsTransform_ = ''
  // The final scoreboard's page controls (‹ • • ›), anchored below the summary band and shown
  // only once the board is revealed. `lastPagerPos` gates the position write (like the counters).
  private scorePagerEl_!: HTMLElement
  private scorePrevBtn_!: HTMLButtonElement
  private scoreNextBtn_!: HTMLButtonElement
  private scoreDotsEl_!: HTMLElement
  private lastPagerPos_ = ''
  // The info button beside the dealer's head: toggles the nexus's spec-sheet projection.
  private infoBtnEl_!: HTMLButtonElement
  // The battery-saver toggle: a round HUD button stacked above the info button, plus (when the
  // title / tap-to-start screen is up) a matching pill. Both flip the render loop's park mode.
  private batteryBtnEl_!: HTMLButtonElement
  private saverToggleEl_: HTMLButtonElement | null = null
  // The help button (an "H", styled like the info button) + the full-screen ability-guide
  // modal it opens. A tap anywhere on the modal closes it.
  private helpBtnEl_!: HTMLButtonElement
  private helpPanelEl_!: HTMLElement
  // The powerup + action button columns, hidden while the choose-upgrade card is up.
  private powersEl_!: HTMLElement
  private actionsEl_!: HTMLElement
  // Blocks play behind a "rotate / screen too small" modal when the viewport is too short to fit the
  // ability column + help + info buttons. Null when the feature flag is off. See viewport-guard.ts.
  private viewportGuard_: ViewportGuard | null = null
  // The choose-upgrade card (shown after a non-final kill) and its three path buttons.
  private upgradeEl_!: HTMLElement
  private upgradeButtons_!: { info: UpgradePathInfo; btn: HTMLButtonElement; effectEl: HTMLElement; tierEl: HTMLElement }[]

  constructor(root: HTMLElement) {
    const debug = readDebugFlags()
    // Any of the three upgrade-path flags seeds the run with those unlocked tiers.
    const startUpgrades =
      debug.sabotageUpgrade !== null || debug.chipUpgrade !== null || debug.tokenUpgrades !== null
        ? { antiDealer: debug.sabotageUpgrade ?? 0, chipEco: debug.chipUpgrade ?? 0, tokenEco: debug.tokenUpgrades ?? 0 }
        : null
    this.session_ = new Session(generateSeed(), {
      forcePairs: debug.forcePairs,
      forcePairRank: debug.forcePairRank,
      startTokens: debug.startTokens,
      startScore: debug.startScore,
      dealerHealth: debug.dealerHealth,
      hearts: debug.hearts,
      startDealer: debug.startDealer,
      startUpgrades,
      forceDealerNatural: debug.dealerBlackjack,
      forcePlayerNatural: debug.playerBlackjack,
    })
    // Offer to resume a saved in-progress run — unless a dev override seeds a specific run (then
    // always start fresh). buildIntroScreen shows CONTINUE / NEW GAME when this is set.
    const hasRunOverride =
      startUpgrades !== null ||
      debug.startDealer !== null ||
      debug.startScore !== null ||
      debug.startTokens !== null ||
      debug.dealerHealth !== null ||
      debug.hearts !== null
    this.resumableRun_ = hasRunOverride ? null : loadSession()
    // Seed the opening balances + dealer/deck identity from the run so the first paint is correct.
    this.seedVisualsFromState_()
    // Arm the opening ceremony BEFORE createStage's first (synchronous) paint, so the
    // very first frame already shows the dealer walking in + the deck hidden — never a
    // settled figure that then pops off-screen to walk back.
    this.armIntro_()
    this.defs_ = this.makeButtons_()
    this.stage_ = createStage(root, LAYERS, (canvas) => this.onResize_(canvas))
    this.prewarmDeckSprite_() // so the deck's fly-in doesn't hitch mid walk-in
    this.buildOverlay_()
    this.syncOverlay_(now())
    this.buildIntroScreen_() // tap-to-play gate: unlocks audio + releases the opening on first tap
    // Mount the too-short-screen guard once the overlay + ability column exist. It measures the
    // column and blocks play behind a rotate / screen-too-small modal when there isn't the height
    // to show it. Off entirely when the flag is down.
    if (FLAGS.viewportGuard) {
      // Mount on the stage container (not the HUD overlay, which fades out during the intro) so the
      // modal shows above everything — including the title menu — regardless of the overlay's opacity.
      this.viewportGuard_ = new ViewportGuard(this.stage_.container, () => this.measureControlColumn_())
    }
    setHoloFlickerStatic(this.batterySaver_) // no holo-readout flicker while saver is on
    // Stop repainting while the tab is hidden (backgrounded / screen off) — pure wasted battery
    // otherwise, since the loop doesn't park on its own. Mirrors the audio context's visibility
    // suspend (audio/context.ts); unconditional, not gated by battery saver. On return, ensureLoop_
    // restarts from a fresh frame.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.raf_) {
          cancelAnimationFrame(this.raf_)
          this.raf_ = 0
        }
        if (this.sleepTimer_) {
          clearTimeout(this.sleepTimer_)
          this.sleepTimer_ = 0
        }
      } else {
        this.ensureLoop_()
      }
    })
    this.ensureLoop_() // drive the opening ceremony, then auto-deal the first hand
  }

  // Seed the opening balances + the dealer/deck colour identity from the current run state, so the
  // scene paints correctly from the first frame. Used at construction and again when CONTINUE
  // adopts a saved run (which may sit at a later dealer, partway health, etc.).
  private seedVisualsFromState_(): void {
    this.state_ = this.session_.snapshot()
    // Show the balances immediately (no roll up from zero on load).
    this.tokenTicker_.set(this.displayedTokens_(now()))
    this.scoreTicker_.set(this.displayedScore_())
    // Seed the dealer to the current integrity so a partway-damaged dealer (resume, or the
    // dealerHealth dev override) shows the right eye flicker + damage sparks from the first frame.
    this.dealer_.setLevel(this.state_.run.integrity, this.state_.run.shiftIndex)
    // Seed the heart row to the run's current hit points (a resume may sit at partway health) so it
    // paints the right count from the first frame — no phantom pop/heal.
    this.hearts_.sync(this.state_.run.hitPoints)
    // Seed the dealer's colour identity + the deck colour to the current dealer, so the bowtie and
    // card backs wear that dealer's colour from the first paint.
    this.deckColorShift_ = this.state_.run.shiftIndex
    this.dealer_.setShift(this.state_.run.shiftIndex)
    setCardBack(dealerColors(this.deckColorShift_, now()).back)
  }

  // The opening gate. Until the game starts, ONLY the table + the nexus's projected wordmark show —
  // the dealer stays parked off-screen (the intro-hold gate in frame()) and the HUD overlay
  // (counters + buttons) is hidden. With a saved run this is a CONTINUE / NEW GAME menu; otherwise
  // a transparent full-screen tap catcher. Either gesture unlocks the audio contexts + starts music
  // (context.ts/main.ts window listeners), then the dealer walks in, the HUD fades in, and the
  // first hand deals.
  private buildIntroScreen_(): void {
    this.stage_.overlay.classList.add('hud-hidden') // hide counters + buttons during the intro
    // The button groups stay hidden a beat LONGER than the rest of the HUD: on start the counters
    // fade in, but the powerups / action / info buttons hold back through the dealer walk-in + first
    // deal, then fade in once that hand is fully dealt (revealOpeningButtons).
    this.powersEl_.classList.add('opening-hidden')
    this.actionsEl_.classList.add('opening-hidden')
    this.infoBtnEl_.classList.add('opening-hidden')
    this.batteryBtnEl_.classList.add('opening-hidden')
    if (this.resumableRun_) {
      this.buildTitleMenu_(this.resumableRun_)
    } else {
      this.buildTapCatcher_()
    }
  }

  // No saved run: a transparent full-screen catcher records the first tap. Not a menu.
  private buildTapCatcher_(): void {
    const catcher = element('div', 'intro-catch')
    this.introCatcher_ = catcher
    this.stage_.container.appendChild(catcher)
    const tap = (): void => {
      if (this.tapAt_ > 0) {
        return // already tapping (mid fade-out)
      }
      // Record the tap; the frame loop fades "TAP TO START" out over TAP_FADE_MS, then flips
      // `started` (releasing the walk-in + deal + HUD). Audio unlocks now via the window listeners.
      this.tapAt_ = now()
      this.ensureLoop_() // battery saver may have parked the idle title screen — wake it to start
      window.removeEventListener('keydown', tap)
    }
    catcher.addEventListener('pointerdown', tap)
    window.addEventListener('keydown', tap)
    // The battery-saver toggle sits above the catcher (a sibling, its own taps stopPropagation so
    // they don't also fire tap-to-start). Removed when the intro catcher is (frame_ start block).
    this.stage_.container.appendChild(this.buildSaverToggle_())
  }

  // A saved run exists: offer CONTINUE (resume it) or NEW GAME (wipe it, start fresh). The wordmark
  // still projects above; these HTML buttons stand in for the "TAP TO START" prompt.
  private buildTitleMenu_(saved: PersistedSession): void {
    const run = saved.run
    this.titleMenuMode_ = true // suppress the nexus "TAP TO START" line (keep the wordmark)
    const menu = element('div', 'title-menu')
    this.titleMenu_ = menu
    const cont = element('button', 'title-btn title-btn-continue') as HTMLButtonElement
    cont.type = 'button'
    cont.innerHTML = `Continue<span class="title-sub">Dealer ${run.shiftIndex} · ${run.score.toLocaleString()} pts</span>`
    cont.addEventListener('click', () => this.beginFromTitle_('continue'))
    const fresh = element('button', 'title-btn title-btn-new') as HTMLButtonElement
    fresh.type = 'button'
    fresh.textContent = 'New game'
    fresh.addEventListener('click', () => this.beginFromTitle_('new'))
    menu.append(cont, fresh)
    this.stage_.container.appendChild(menu)
    // The battery-saver toggle rides the top-centre of the title screen (a sibling of the menu, not
    // inside it — so it keeps its own pill styling and is removed alongside the menu on start).
    this.stage_.container.appendChild(this.buildSaverToggle_())
  }

  // Leave the title screen: CONTINUE adopts the saved session (re-seeding the visuals for its
  // dealer / balances), NEW GAME wipes the save and keeps the fresh session already built. A NEW
  // game — or a CONTINUE that resumes at 'betting' — sets tapAt so the frame loop runs the normal
  // start transition (fade, walk-in, HUD reveal, first deal). A CONTINUE that resumes mid-hand /
  // mid-coda instead snaps straight to a settled, playable scene (resumeSettled_) — its hand is
  // already on the table, so there's no deal ceremony to run.
  private beginFromTitle_(mode: 'continue' | 'new'): void {
    if (this.tapAt_ > 0) {
      return // already starting (guard against a double click)
    }
    const resumed = mode === 'continue' ? this.resumableRun_ : null
    if (resumed) {
      this.session_.adoptSession(resumed)
      // A 'resolved' checkpoint is a between-hands state — the hand already settled and the deck
      // advanced. DON'T re-show the resolved screen: its Next-click re-runs the gather / kill /
      // walk-in ceremonies, which depend on transient UI state (pendingAttack_, pendingCeremony_,
      // spawnIncomingShift_) that a fresh resume never set up → a broken next deal. Advance the
      // engine straight to the next real state (the upgrade pick, or the next hand's betting) so we
      // resume there instead. Called directly (not via run_), so no UI ceremony fires.
      if (resumed.phase === 'resolved') {
        this.session_.nextHand()
      }
      this.seedVisualsFromState_()
    } else {
      clearRun() // wipe the save; the fresh session built at construction stands
    }
    this.resumableRun_ = null
    this.titleMenu_?.remove()
    this.titleMenu_ = null
    this.saverToggleEl_?.remove()
    this.saverToggleEl_ = null
    // Resume entry states (after the resolved→next advance above):
    //  • 'playing' / 'coda' — a hand/coda is mid-action and can't be re-dealt, so snap to a settled,
    //    ceremony-free scene (resumeSettled_).
    //  • 'betting' / 'choosing-upgrade' — take the normal start path (tapAt_): the walk-in plays,
    //    then the deal fires off dealAfter_ (immediately for betting; after the pick commits betting
    //    for choosing-upgrade). This reuses the real deal trigger — resumeSettled_ never sets
    //    dealAfter_, so a pick there would leave the next hand un-dealt.
    if (resumed && (this.state_.phase === 'playing' || this.state_.phase === 'coda')) {
      this.resumeSettled_() // already calls ensureLoop_
      return
    }
    this.tapAt_ = now()
    this.ensureLoop_() // battery saver may have parked the idle title menu — wake it to start
  }

  // Resume a saved run at a MID-ACTION phase — 'playing' (a hand in progress) or the coda — where
  // there's a live table that can't be re-dealt. (Betting and the post-kill upgrade pick take the
  // normal tapAt_ start path instead; see beginFromTitle_.) The state is already in this.state_
  // (adopted + seeded). Bypass the opening ceremony (walk-in, deck fly-in, first deal) and snap to a
  // settled, playable scene: stand the dealer at its mark, reveal the HUD + buttons, and let the
  // normal render paint the restored round settled (the deal animator is idle, so drawHands lays
  // cards at rest).
  //
  // The anti-cheat lives entirely in the engine (the session was restored exactly); this is purely
  // the display. A resumed coda skips the Banker entry ceremony — it's seeded best-effort here.
  private resumeSettled_(): void {
    const state = this.state_
    this.started_ = true
    this.startedAt_ = now() // fade the hearts in as Continue snaps the scene up
    this.introHold_ = false
    this.deckHidden_ = false // the resting deck sits on the table (no ceremony flew one in)
    this.openingCountsShown_ = true // show projected counts at once — there's no first-deal hold
    this.dealer_.standAtMark() // cancel the constructor's parked walk-in; stand upright at the spot
    if (state.phase === 'coda') {
      // The coda is fought against the BANKER, not the last regular dealer. seedVisualsFromState_
      // seeded run.shiftIndex — already BANKER_SHIFT for a killed-Dealer-6 coda, but Dealer 6 for a
      // window-out coda. Force the Banker's identity + full health + deck colour so a resumed coda
      // shows him, exactly as the normal entry ceremony (playCodaArrival_) does.
      this.dealer_.setShift(BANKER_SHIFT)
      this.dealer_.setLevel(maxHitsFor(BANKER_SHIFT), BANKER_SHIFT)
      this.deckColorShift_ = BANKER_SHIFT
      this.codaCrystalValue_ = state.run.score // best-effort: show the real pot, not 0 (default)
      this.codaCounters_.reveal(now()) // the glass pot pile (drawn in drawChips_), shown all coda long
      if (state.round && state.round.status === 'resolved') {
        // A resolved hand at the tab-close (the killing hand that entered the coda, or a played-out
        // gamble awaiting its outcome): re-arm the auto-advance. codaResolveNext then dismisses it and
        // transitions INTO the prompt — which is where the normal flow sets codaStakeShownAt_, so the
        // stake panel appears then. Don't set it here (it'd double-draw over the resolving hand).
        this.codaAdvanceAt_ = now()
      } else if (!state.round) {
        // AT THE PROMPT (double-or-nothing offer): arm the projected stake PANEL — Points at risk +
        // the high-score BEST, drawn by drawCodaStake and gated on codaStakeShownAt_. The normal flow
        // only sets it when transitioning INTO the prompt, which a resume skips → no projected text.
        // The panel's other inputs stay at their construction defaults, which is exactly the plain
        // steady offer we want: codaWonHand_ = false (not a fresh win).
        this.codaStakeShownAt_ = now()
      }
      // (mid-gamble — round in 'player-turn' — needs neither: the hand is up, no stake panel.)
    }
    // Reveal the HUD + button groups (normally faded in by the frame loop after the opening deal).
    this.stage_.overlay.classList.remove('hud-hidden')
    this.introCatcher_?.remove()
    this.introCatcher_ = null
    this.revealOpeningButtons_()
    // Seed the deal animator so the restored cards read as ALREADY LANDED — the renderer skips any
    // card the animator has no timing for, so a fresh animator would paint an empty felt.
    const t = now()
    this.anim_.setNow(t)
    this.anim_.settle(this.state_, t)
    // Paint every layer once now (the frame loop will keep them fresh), so the resumed table shows
    // its cards + counts on the very first frame rather than flashing empty.
    const canvas = this.stage_.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    this.paintTable_(canvas, layout, this.tableHasDeck_())
    this.updateClown_(t) // a run resumed at dealer 6 snaps the clown to standing beside it
    this.renderCast_(canvas, layout, t, !this.batterySaver_ || this.dealer_.isSequencing(t)) // sparks only if mid-attack
    this.renderPlay_(canvas, layout, t)
    this.renderNexus_(canvas, layout, t, t)
    this.renderOverlay_(canvas, layout, t, t, t)
    this.lastAnimating_ = false
    this.syncOverlay_(t)
    this.ensureLoop_()
  }

  // The "TAP TO START" projection this frame — its strike-in age + a fade (1 while waiting,
  // winding 1 → 0 over TAP_FADE_MS after the tap). Null once the scene has started.
  private tapToStartRender_(timestamp: number): { age: number; fade: number } | null {
    if (this.started_) {
      this.tapShownAt_ = 0
      return null
    }
    if (this.tapShownAt_ === 0) {
      this.tapShownAt_ = timestamp
    }
    const fade = this.tapAt_ > 0 ? Math.max(0, 1 - (timestamp - this.tapAt_) / TAP_FADE_MS) : 1
    return { age: timestamp - this.tapShownAt_, fade }
  }

  // Whether the projected counts (card totals + chip amounts) should be held off the felt
  // this frame. True only for the VERY FIRST hand while its cards are still in flight, so the
  // counts don't pop in piecemeal (dealer total, then player total, then the bet/bankroll) amid
  // the fading tap-to-start rays — they all reveal together the instant the deal settles. Once
  // that first deal lands, `openingCountsShown` latches and this returns false forever after.
  private firstHandCountsHidden_(now: number): boolean {
    return !this.openingCountsShown_ && this.anim_.isAnimating(now)
  }

  // True only while a natural dealt straight off the deal is still playing its reveal animation:
  // the hand resolved at the deal (`dealNatural`) but the cards + hole-flip are still in flight.
  // During this window the action row keeps showing the disabled play buttons (see the button
  // defs) rather than the Next-hand button, so the instant blackjack isn't given away before the
  // reveal. Goes false the frame the reveal settles (the deal animation stops) — matching the
  // beat the Win/Blackjack label + sting fire, so the row swaps to Next hand exactly then.
  private dealRevealPending_(): boolean {
    return this.dealNatural_ && this.anim_.isAnimating(now())
  }

  // Fade the button groups (powerups, action bar, info button) in — done once, the frame the
  // opening hand finishes dealing, so the buttons appear together with its projected counts
  // rather than sitting live through the walk-in + deal. A no-op after that (the class is gone).
  private revealOpeningButtons_(): void {
    this.powersEl_.classList.remove('opening-hidden')
    this.actionsEl_.classList.remove('opening-hidden')
    this.infoBtnEl_.classList.remove('opening-hidden')
    this.batteryBtnEl_.classList.remove('opening-hidden')
    // The full column (now including the help button, hidden during the intro) is live — re-measure
    // so the guard trips on a too-short screen even if the player never resizes after the deal.
    this.viewportGuard_?.evaluate()
  }

  // Arm the opening ceremony but hold it: park the dealer off-screen (so the initial
  // paint + the warm-up frames show it off-screen) and wait for steady frames before
  // starting the visible slide-in (see the hold gate in frame() → startIntroNow). Runs
  // before the stage exists: no paint.
  private armIntro_(): void {
    this.deckHidden_ = true // no resting deck until the ceremony flies one in
    const t = now()
    this.dealer_.spawn(t) // park the figure off-screen
    this.introHold_ = true
    this.introHoldStart_ = t
    this.introPrevFrame_ = t
  }

  // Begin the opening ceremony on a warm frame `t`: base the walk-in + deck timeline
  // here so the slide-in starts from off-screen on steady frames, never mid-jank.
  private startIntroNow_(t: number): void {
    this.dealer_.spawn(t)
    this.spawnIncomingShift_ = this.state_.run.shiftIndex
    const shredStart = t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP
    this.dealAfter_ = this.spawn_.begin(shredStart, 0)
    this.lastAnimating_ = true // so the settle edge fires when the ceremony ends
  }

  // Build the deck-back sprite up front so the deck's fly-in during the opening
  // ceremony doesn't hitch while it's rendered (PCB pattern + all) for the first time.
  private prewarmDeckSprite_(): void {
    const c = this.stage_.canvas
    const a = shoeAnchor(computeLayout(c.width, c.height))
    getCardSprite(null, a.w, a.h, window.devicePixelRatio || 1)
  }

  // Repaint every layer. Static layers (back, table) only change here — on
  // resize (and the initial paint). The cards layer is redrawn per frame too.
  private onResize_(canvas: LayeredCanvas): void {
    const layout = computeLayout(canvas.width, canvas.height)
    const t = now()
    this.anim_.setNow(t)
    this.scene_.drawBackground(canvas.layers.room.ctx, layout)
    this.paintTable_(canvas, layout, this.tableHasDeck_())
    // Repaint every dynamic group at its CURRENT animated state, so a resize
    // mid-death/mid-strike doesn't blank the figure or the beam.
    this.renderCast_(canvas, layout, t, !this.batterySaver_ || this.dealer_.isSequencing(t)) // sparks only if mid-attack
    this.renderPlay_(canvas, layout, t)
    this.renderNexus_(canvas, layout, t, t)
    this.renderOverlay_(canvas, layout, t, t, t)
    // Re-anchor the score pager to the new layout (it reads band coords from the current size).
    this.syncScorePager_()
    // A resize / orientation change reaches here via the stage ResizeObserver — re-check whether the
    // control layout still fits the (new) viewport height.
    this.viewportGuard_?.evaluate()
  }

  // Height (viewport px) the whole left-edge control layout needs so nothing clips or overlaps: the
  // top-anchored ability column PLUS its "?" ability-help button (the column's last child) must clear
  // the bottom-anchored "i" rules button, which sits at the same left edge. Returns null when the
  // column isn't laid out (hidden behind a modal / at game over) so the guard keeps its last good
  // measurement rather than assuming everything fits.
  //
  // Help and info each toggle with the phase (help shows only in 'playing', info only mid-hand), so
  // to keep the requirement STABLE across the hand cycle we reserve a fixed block for whichever isn't
  // currently rendered: help is already inside the column's bottom when visible (else add its block);
  // info is reserved from the viewport bottom when visible (else its block). The blocks are the real
  // measured sizes per CSS breakpoint, so the reserved and measured cases agree — no flapping.
  private measureControlColumn_(): number | null {
    const el = this.powersEl_
    if (!el.isConnected) {
      return null
    }
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) {
      return null
    }
    // Mirror the CSS compact breakpoint (game-view.css) — narrow OR short both switch to the compact
    // button sizes — so these reserve blocks match the layout that's actually rendered.
    const compact = window.matchMedia('(max-width: 560px), (max-height: 620px)').matches
    // Help "?" block = row gap + its margin-top + button height; info "i" block = its height + bottom
    // inset. (Roomy 38px buttons / compact 32px, per game-view.css .hud-help + .hud-info.)
    const HELP_BLOCK = compact ? 40 : 48
    const INFO_BLOCK = compact ? 42 : 52
    const BATTERY_BLOCK = compact ? 40 : 46 // battery toggle height + its gap above the info button
    const GAP = 12 // clear air we insist on between the column's bottom and the info button
    const help = this.helpBtnEl_.getBoundingClientRect()
    const helpReserve = help.height > 0 ? 0 : HELP_BLOCK // 0 when it's already in rect.bottom
    // The battery toggle stacks directly above the info button, so the column must clear whichever
    // sits higher — reserve from the top of that stack down to the screen bottom.
    const info = this.infoBtnEl_.getBoundingClientRect()
    const battery = this.batteryBtnEl_.getBoundingClientRect()
    const stackTop = Math.min(
      info.height > 0 ? info.top : Infinity,
      battery.height > 0 ? battery.top : Infinity,
    )
    const infoReserve = Number.isFinite(stackTop)
      ? Math.max(0, window.innerHeight - stackTop)
      : INFO_BLOCK + BATTERY_BLOCK
    return rect.bottom + helpReserve + GAP + infoReserve
  }

  // Repaint the table layer (felt + rail), optionally with the static deck.
  private paintTable_(canvas: LayeredCanvas, layout: Layout, withDeck: boolean): void {
    const ctx = canvas.layers.felt.ctx // single-layer group: keeps its own clear
    ctx.clearRect(0, 0, layout.width, layout.height)
    this.scene_.drawTable(ctx, layout)
    // The nexus device (damage + tokens originate from it) floats in a hover, so it's
    // NOT drawn here on the static table — it rides the per-frame fx layer (drawFx).
    if (withDeck) {
      this.applyDeckColor_(now()) // paint the shoe in the current dealer's colour
      const a = shoeAnchor(layout)
      drawShoe(ctx, a.x, a.y, a.w, a.h)
    }
  }

  // Point the shared card-back palette at the current dealer's deck colour, so every
  // back drawn this frame (shoe, deal, discard/return/peek flips) matches. `now`
  // advances the RGB dealer's hue.
  private applyDeckColor_(now: number): void {
    setCardBack(dealerColors(this.deckColorShift_, now).back)
  }

  // The RGB (final) dealer's deck shimmers, so its resting deck lives on the per-frame
  // cards layer and the render loop is kept alive while it's in play.
  private rgbActive_(): boolean {
    return isRgbDealer(this.deckColorShift_)
  }

  // Whether the resting deck belongs on the static table layer this repaint. It moves
  // to the cards layer while gathering/shuffling (deckOnCards) and while the RGB
  // dealer is in play (so its colour can cycle) — in both cases the table omits it.
  private tableHasDeck_(): boolean {
    return !this.deckOnCards_ && !this.deckHidden_ && !this.rgbActive_()
  }

  // --- Per-group canvas render -----------------------------------------------------------------
  // Each grouped canvas is repainted by ONE wrapper that clears the shared canvas once, then paints
  // its members in z-order — so a partial redraw can never wipe a sibling. All render sites (frame_,
  // the settle re-render, resumeSettled_, onResize_) go through these. renderPlay_ MUST run before
  // renderOverlay_ each frame: cards/chips populate frameProjections_, which the mask's ray fans read.
  private renderCast_(canvas: LayeredCanvas, layout: Layout, figureNow: number, sparks: boolean): void {
    canvas.layers.cast.ctx.clearRect(0, 0, layout.width, layout.height)
    this.drawDealerFigure_(canvas, layout, figureNow, sparks)
    this.drawClownFigure_(canvas, layout, figureNow)
  }

  private renderPlay_(canvas: LayeredCanvas, layout: Layout, cardsNow: number): void {
    canvas.layers.play.ctx.clearRect(0, 0, layout.width, layout.height)
    this.drawCards_(canvas, layout, cardsNow) // resets + populates frameProjections_
    this.drawChips_(canvas, layout, cardsNow)
  }

  private renderNexus_(canvas: LayeredCanvas, layout: Layout, bodyNow: number, laserNow: number): void {
    this.drawFx_(canvas, layout, bodyNow, laserNow) // single-layer group — drawStrikeFx clears the nexus canvas itself
  }

  private renderOverlay_(canvas: LayeredCanvas, layout: Layout, ambientNow: number, fxNow: number, figureNow: number): void {
    canvas.layers.overlay.ctx.clearRect(0, 0, layout.width, layout.height)
    this.drawHearts_(canvas, layout, fxNow)
    this.drawTokens_(canvas, layout, fxNow)
    this.drawScoreDeltas_(canvas, layout, fxNow)
    // The dealer eye glow rides the FIGURE clock (figureNow), not fxNow — the emissive glow is part of
    // the dealer's damage FX, so like its sparks it must freeze during a deal and flicker only while the
    // dealer itself is active (attack/emote). Holo rays use ambientNow; hearts/tokens/deltas use fxNow.
    this.drawMask_(canvas, layout, ambientNow, figureNow)
  }

  // The dealer layer: the animated robot figure, below the rail so its lower body
  // and death debris tuck behind the table. A wounded dealer (< 75% health) also sparks
  // and smokes here — the diegetic replacement for the old health bar — over the figure
  // but still behind the rail, so downward sparks tuck away like the lower body does.
  private drawDealerFigure_(canvas: LayeredCanvas, layout: Layout, timestamp: number, sparks = true): void {
    const ctx = canvas.layers.cast.ctx // shared with the clown; renderCast_ clears it once
    drawDealer(ctx, layout, this.dealer_, timestamp)
    // Only while the figure is STANDING at its home spot — the burst origins are the
    // resting figure, so sparks must not show while it's dying, walking in, or off. `sparks` lets
    // battery saver CLEAR them on a pulse OFF beat (a clean figure) rather than freeze them mid-flight.
    if (sparks && this.dealerStanding_(timestamp)) {
      drawDamageFx(ctx, layout, this.dealer_.damageBursts(timestamp))
    }
  }

  // The clown layer: the dealer-6 sidekick, standing to the dealer's right (below the rail like
  // the dealer). A pure render — the state was advanced by updateClown_ earlier in the frame.
  private drawClownFigure_(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    drawClown(canvas.layers.cast.ctx, layout, this.clown_, timestamp)
  }

  // Advance the clown from the dealer's state (once per frame) and fire its laughs. The clown
  // follows dealer 6 in/out and to its side entirely off the dealer's public animation state, so
  // this is the only place it's driven — no hooks in the action sequencing.
  //  • On dealer 6's DEATH (observe returns 'death') the clown cackles at the wreckage, then goes.
  //  • Whenever the dealer arms a fresh LAUGH emote, the clown echoes it on a slight delay — so it
  //    laughs along with dealer 6's showdown-win cackles and its game-over walk-off laugh.
  private updateClown_(timestamp: number): void {
    // While the opening is held (the dealer is parked off-screen each frame during the
    // tap-to-start / title screen, so its arriving() reads ~0 every frame), DON'T let the clown
    // treat that as a walk-in and trot out over the title screen. It starts following only once the
    // hold releases and the real walk-in begins (mirrors the walk-in growl's !introHold_ gate).
    if (this.introHold_) {
      return
    }
    if (this.clown_.observe(this.dealer_, timestamp) === 'death') {
      // A stand-alone clown cackle at the moment dealer 6 shatters (the dealer itself is silent —
      // it's being destroyed), landing just as the death reads before the clown turns to leave.
      const pattern = clownifyLaugh(evilLaughPattern(CLOWN_VOICE_SEED, TOTAL_DEALERS))
      voice.play(pattern, CLOWN_LAUGH_LEAD, CLOWN_LAUGH_GAIN)
      this.clown_.emote(timestamp + CLOWN_LAUGH_LEAD * 1000, pattern)
    }
    // Echo the dealer's own laughs onto the clown's grin, a beat behind. Every fresh dealer emote
    // is marked "seen" the frame it appears (so a laugh armed while the clown wasn't yet on screen
    // is skipped, never fired late) — but only a LAUGH, only while the on-screen figure really is
    // dealer 6 (never the Banker that walks in after its death), and only while the clown is up,
    // actually plays. On a walk-off, dealer 6's parting cackle is mirrored as the clown follows.
    const de = this.dealer_.currentEmote()
    if (de && de.start !== this.lastClownEmoteStart_) {
      this.lastClownEmoteStart_ = de.start
      const isDealer6 = this.dealer_.figureShift(timestamp) === TOTAL_DEALERS
      if (de.pattern.kind === 'laugh' && isDealer6 && this.clown_.present(timestamp)) {
        const start = de.start + CLOWN_LAUGH_DELAY_MS
        const pattern = clownifyLaugh(de.pattern)
        voice.play(pattern, Math.max(0, start - now()) / 1000, CLOWN_LAUGH_GAIN)
        this.clown_.emote(start, pattern)
      }
    }
  }

  // The dealer is upright at its mark (not mid-death, walk-in, or walk-off) — the only
  // time the health-driven damage sparks track the figure, so the only time they draw.
  private dealerStanding_(now: number): boolean {
    return (
      this.dealer_.alive(now) &&
      this.dealer_.dying(now) === null &&
      this.dealer_.arriving(now) === null &&
      this.dealer_.leaving(now) === null
    )
  }

  // The fx layer: the floating nexus device body (hovering with the frame clock),
  // its emitter-light charge glow, and the laser strike (beam + muzzle flash +
  // impact sparks) — all drawn together since they share the device's bobbing muzzle.
  // `bodyNow` drives the static nexus device (frozen in battery saver so it never hovers/skips);
  // `laserNow` drives the attack laser/charge/heal (always live so a strike still animates). They're
  // the same live timestamp outside battery saver.
  private drawFx_(canvas: LayeredCanvas, layout: Layout, bodyNow: number, laserNow: number): void {
    const charge = {
      red: this.nexus_.redLight(laserNow),
      heal: this.nexus_.healLight(laserNow),
      yellow: this.nexus_.yellowLight(laserNow),
      holo: 1, // the holo projector is always on
      chargeUp: this.nexus_.chargeUp(laserNow),
      healBeam: this.nexus_.healBeam(laserNow),
    }
    drawStrikeFx(canvas.layers.nexus.ctx, layout, this.dealer_, charge, laserNow, bodyNow)
  }

  // Paints the dealt cards + holo readouts onto the shared 'play' canvas (renderPlay_ clears it first,
  // then calls this and drawChips_). Populates frameProjections_ for the mask's ray fans.
  private drawCards_(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.play.ctx
    // Start the frame's projected-number collection fresh; drawHands / drawAnalysis (here)
    // and drawChips (next) append to it, and drawMask fires the ray fans at it. Reuse the
    // array (truncate, don't reallocate) so a settled frame produces no garbage here.
    this.frameProjections_.length = 0
    // Every back drawn this frame uses the current dealer's deck colour.
    this.applyDeckColor_(timestamp)

    // A dealer-spawn ceremony: the fresh shrink-wrapped deck flies in from the
    // dealer and unwraps here (in the incoming dealer's colour), instead of the
    // same-dealer riffle below. The static table deck is untouched (kept as the old
    // deck, or hidden on the opening intro) until this one lands + commits.
    if (this.spawn_.isAnimating(timestamp)) {
      const shift = this.spawnIncomingShift_ ?? this.deckColorShift_
      // The outgoing dealer's deck is shredded into the mouth first (drawn resting on the
      // shoe until the shred reaches it), then the fresh wrapped deck flies in over the
      // emptied shoe — instead of just landing on top of the old one.
      if (this.spawnHasOldDeck_) {
        drawOldDeckShred(ctx, layout, dealerColors(this.deckColorShift_, timestamp).back, this.spawn_, timestamp)
      }
      // A game-over shred flies no fresh deck in — it just chews the table cards.
      if (!this.spawnShredOnly_) {
        drawSpawnDeck(ctx, layout, dealerColors(shift, timestamp).back, this.spawn_, timestamp)
      }
    } else if (this.deckOnCards_) {
      // While gathering/shuffling, the deck lives on this layer so it can slide
      // out to the centre (in front of the dealer) and split for the riffle.
      const rest = shoeAnchor(layout)
      const centerX = layout.width / 2 - rest.w / 2
      const x = rest.x + (centerX - rest.x) * this.anim_.deckShift()
      const shuffle = this.anim_.shuffle()
      if (shuffle !== null) {
        drawShuffle(ctx, x, rest.y, rest.w, rest.h, shuffle)
      } else {
        drawShoe(ctx, x, rest.y, rest.w, rest.h)
      }
    } else if (this.rgbActive_() && !this.deckHidden_) {
      // The RGB dealer's resting deck stays on this per-frame layer so its colour keeps
      // cycling (the static table layer would freeze it between repaints). Suppressed while
      // the deck is hidden (a ceremony flew/shredded it) — otherwise at game over, once the
      // shred finishes, this branch would redraw the just-shredded RGB deck (it reappears).
      const rest = shoeAnchor(layout)
      drawShoe(ctx, rest.x, rest.y, rest.w, rest.h)
    }

    // During a dealer-spawn ceremony the ending round's cards are being sucked into the new
    // dealer's mouth + shredded (drawn here), not laid out settled. But NOT while the deal
    // animator is still flying cards in: at game over `beginEndGame` schedules the shred the
    // same frame the final hand resolves, so `spawn.isAnimating` goes true before those cards
    // (the dealer's draw-out, or a busting card) have flown from the deck. Keep drawing them
    // via drawHands until they settle (anim idle), then the shred takes over — same card
    // positions (tableCards ≡ drawHands), so no pop. (Normal ceremonies run with anim idle.)
    if (this.spawn_.isAnimating(timestamp) && this.collectRound_ && !this.anim_.isAnimating(timestamp)) {
      drawShred(ctx, layout, this.collectRound_, this.spawn_, timestamp)
    } else if (!this.endShredDone_) {
      // Fall back to the retained ending round while its cards are gathering / flying in.
      // Skipped once a game-over shred has finished — those cards were sucked up and stay gone.
      const round = this.state_.round ?? this.collectRound_
      if (round) {
        // Hole hidden while it's the player's turn (main game OR coda), revealed once past it or on a
        // peek — keyed off round.status, not phase, so the coda (always phase 'coda') doesn't leak the
        // Banker's hole. (drawHands ignores this when the animator drives the flip, as here; kept
        // consistent so the one pattern can't reintroduce the resumed-coda hole-reveal bug.)
        const revealHole = round.status !== 'player-turn' || this.state_.peeked
        this.frameProjections_.push(
          ...drawHands(ctx, layout, round, revealHole, timestamp, this.anim_, this.handResults_(timestamp), this.splitPrev_ ?? undefined, this.firstHandCountsHidden_(timestamp)),
        )
      }
    }

    // Mulligan: the tossed opening cards flip down and fly back to the deck while
    // the fresh pair (already in `round`, but not yet scheduled) waits to fly in.
    if (this.mulligan_.isAnimating(timestamp)) {
      drawMulliganDiscard(ctx, layout, this.mulligan_.frames(timestamp))
    }

    // Return: the returned card flips face-down and flies back onto the deck,
    // just before the dealer reveals + plays out.
    if (this.returnCardData_ && this.returnAnim_.isAnimating(timestamp)) {
      const f = this.returnAnim_.frame(timestamp)
      const { card, from } = this.returnCardData_
      drawReturnCard(ctx, layout, card, from.x, from.y, f.flip, f.fly)
    }

    // Bust Block: the shield caught a busting draw — reveal that card (the bust the
    // player hit) on its slot, catch it in the gold ring, then sweep it off. The
    // replacement, if any, is held back until this finishes (scheduled in run()).
    if (this.bustBlockData_ && this.bustBlock_.isAnimating(timestamp)) {
      const round = this.state_.round ?? this.collectRound_
      if (round) {
        const { handIndex, cardIndex, card } = this.bustBlockData_
        drawBustBlock(ctx, layout, round, handIndex, cardIndex, card, this.bustBlock_.frame(timestamp))
      }
    }

    // The Analyze readout sits in the band between the two hands. Only while a
    // reading is live and the table is settled — never over cards in flight. It
    // shimmers, so `timestamp` drives it and the loop is kept alive below.
    const ar = this.analysisRender_(timestamp)
    if (ar) {
      this.frameProjections_.push(...drawAnalysis(ctx, layout, ar.a, ar.age, ar.fade, timestamp))
    }

    // The dealer HAND-SUMMARY the nexus projects between hands: the window slots (green win / red
    // loss), the newest animating in. Its box joins frameProjections so the holo lens fans rays onto it.
    const summary = this.summaryView_(timestamp)
    if (summary) {
      // Bound the pips to the clear zone: right of the (measured) powerup column, left of the nexus
      // (which sits at this vertical level on the right, like the spec/score readouts clamp to).
      const gap = Math.max(12, layout.width * 0.02)
      const left = this.hudLeftInset_() + gap
      const right = nexusHoloLight(layout, timestamp).x - Math.max(36, layout.width * 0.025)
      const draw = drawHandSummary(ctx, layout, summary, { left, right })
      this.frameProjections_.push(...draw.rays)
      // Launch any due score deltas from their green check's live position (now known this frame).
      this.emitScoreDeltas_(draw.slotCenters, timestamp)
    }

    // The info-button spec sheet the nexus projects: the ruleset + token inflation,
    // centred on the felt, flickering in like the Analyze readout. Its panel box goes
    // into frameProjections so the holo lens fans its rays onto it (drawMask).
    const sr = this.specRender_(timestamp)
    if (sr) {
      this.frameProjections_.push(...drawSpecSheet(ctx, layout, sr.spec, sr.age, sr.fade, timestamp))
    }

    // The FINAL SCOREBOARD the nexus projects once the cards are sucked up: the game title above
    // the summary board, both boxes joining frameProjections so the holo lens fans its rays onto
    // each, like the spec sheet.
    const scr = this.scoreRender_(timestamp)
    if (scr) {
      // The cash-out / lost-to-Banker boards (run went through the coda) sit slightly left of
      // centre, like the coda scoreboards. (Every run reaches the coda now, so run.coda is set here.)
      this.frameProjections_.push(...drawScoreTitle(ctx, layout, scr.age, timestamp))
      this.frameProjections_.push(...drawScoreSheet(ctx, layout, scr.readout, scr.age, 1, timestamp, this.state_.run.coda))
    }

    // The BANKER SCOREBOARD: project the double-or-nothing "points at risk" stake at the prompt
    // (between hands).
    const cs = this.codaStakeRender_(timestamp)
    if (cs) {
      // getPersonalBest() is in-memory cached after its first read, so the per-frame call here is
      // cheap; it's the prior best (recordRun only updates at run-end), i.e. the score to beat.
      this.frameProjections_.push(...drawCodaStake(ctx, layout, cs.points, cs.wonHand, getPersonalBest(), cs.age, cs.fade, timestamp))
    }

    // The opening "TAP TO START" the nexus projects while the game waits for the first tap. Its
    // box joins frameProjections so the holo lens fans its rays onto it, like the other readouts.
    const tap = this.tapToStartRender_(timestamp)
    if (tap) {
      // Suppress the "TAP TO START" line when the Continue / New game menu is up (the HTML buttons
      // are the prompt); the wordmark still projects.
      this.frameProjections_.push(...drawTapToStart(ctx, layout, tap.age, tap.fade, timestamp, !this.titleMenuMode_))
    }
  }

  // The top overlay layer (additive light, no scene dimming): the dealer's emissive
  // eye glow, plus the 5-ray fans the always-on holo projector casts onto every readout.
  // (The holo lens's own glow lives on the fx layer, drawn by drawStrikeFx.)
  // Two clocks so battery saver can freeze the ambient independently of the dealer: the holo rays are
  // ambient (drawn at `ambientTs` — a frozen constant in saver so they read as static), while the eye
  // glow/flicker is part of the dealer's damage FX and rides `eyeGlowTs` = the FIGURE clock (frozen
  // during a deal, live only while the dealer is attacked/emoting — matching its sparks + eye shapes).
  // Outside battery saver both are live, so nothing changes.
  private drawMask_(canvas: LayeredCanvas, layout: Layout, ambientTs: number, eyeGlowTs: number): void {
    const ctx = canvas.layers.overlay.ctx // shared; renderOverlay_ clears it once, then paints its members
    drawDealerEyeGlow(ctx, layout, this.dealer_.eyeGlow(eyeGlowTs))
    this.drawHoloProjection_(ctx, layout, ambientTs)
  }

  // The holo projector casts a fan of HOLO_RAYS_PER white rays onto every projected
  // number that was ACTUALLY drawn this frame — `frameProjections` is the single source
  // of truth (populated by drawHands / drawChips / drawAnalysis as they draw each number),
  // so a ray fan exists iff its number is on screen, at exactly its position. No ray can
  // lead or lag its number. Each fan gets its own seed so their flicker stays independent.
  private drawHoloProjection_(ctx: CanvasRenderingContext2D, layout: Layout, timestamp: number): void {
    const boxes = this.frameProjections_
    // Normal mode: the fans flicker every frame (the shimmer is live), so draw them straight — caching
    // would only add a bake+blit on top of the same fill work. Saver mode: the shimmer clock is frozen
    // (timestamp is a constant), so the fans are pixel-identical until a readout moves — cache + blit.
    if (!this.batterySaver_) {
      boxes.forEach((box, i) => drawHoloRays(ctx, layout, box, HOLO_RAYS_PER, timestamp, i * 1000))
      return
    }
    if (boxes.length === 0) {
      return // nothing projected this frame — draw (and blit) nothing
    }
    // Fingerprint what the fans depend on: the frozen clock, viewport (drives the lens/apex), and each
    // box's rounded geometry. Unchanged key ⇒ the baked bitmap is still valid ⇒ skip the refill, blit.
    let key = `${timestamp}|${layout.width}x${layout.height}`
    for (const b of boxes) {
      key += `|${b.left | 0},${b.right | 0},${b.top | 0},${b.bottom | 0},${(b.fade ?? 1).toFixed(2)},${b.clampToNexus ? 1 : 0}`
    }
    const dpr = deviceDpr()
    if (key !== this.holoCacheKey_ || dpr !== this.holoCacheDpr_ || !this.holoCache_) {
      const cache = this.ensureHoloCache_(layout, dpr)
      const cctx = cache.ctx
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cctx.clearRect(0, 0, layout.width, layout.height)
      boxes.forEach((box, i) => drawHoloRays(cctx, layout, box, HOLO_RAYS_PER, timestamp, i * 1000))
      this.holoCacheKey_ = key
      this.holoCacheDpr_ = dpr
    }
    // Blit the baked fans additively — identical to drawing each ray with 'lighter' straight onto the
    // overlay (addition is associative), but one composite instead of ~5×N gradient triangles.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(this.holoCache_!.canvas, 0, 0, layout.width, layout.height)
    ctx.restore()
  }

  // The saver-mode holo-ray backing canvas, (re)allocated at device resolution when missing or when a
  // resize/dpr change invalidates the last one.
  private ensureHoloCache_(layout: Layout, dpr: number): SpriteCanvas {
    const w = Math.round(layout.width * dpr)
    const h = Math.round(layout.height * dpr)
    let cache = this.holoCache_
    if (!cache || cache.canvas.width !== w || cache.canvas.height !== h) {
      cache = createSpriteCanvas(w, h)
      this.holoCache_ = cache
    }
    return cache
  }

  // The Analyze projection to paint this frame (live or flickering out), with the
  // age + fade its beams/text/mask all share, or null when nothing's showing.
  private analysisRender_(
    timestamp: number,
  ): { a: NonNullable<SessionState['analysis']>; age: number; fade: number } | null {
    if (this.showingAnalysis_(timestamp)) {
      return { a: this.state_.analysis!, age: timestamp - this.analysisStart_, fade: 1 }
    }
    const fading = this.analysisFade_(timestamp)
    // Rewind the strike age (mirror flicker) and fade to nothing on dismiss.
    return fading ? { a: fading.a, age: ANALYSIS_STRIKE_MS * fading.fade, fade: fading.fade } : null
  }

  // Whether the shimmering Analyze projection should be painting right now.
  private showingAnalysis_(timestamp: number): boolean {
    // Also during the coda (a live double-or-nothing hand) — its phase is 'coda', not 'playing'.
    const inHand = this.state_.phase === 'playing' || this.state_.phase === 'coda'
    return inHand && this.state_.analysis !== null && !this.anim_.isAnimating(timestamp)
  }

  // A dismissed reading still flickering out, with its remaining life (1 → 0).
  private analysisFade_(timestamp: number): { a: NonNullable<SessionState['analysis']>; fade: number } | null {
    if (!this.analysisFadeOut_) {
      return null
    }
    const life = 1 - (timestamp - this.analysisFadeStart_) / ANALYSIS_FADE_MS
    return life > 0 ? { a: this.analysisFadeOut_, fade: life } : null
  }

  // The spec sheet to paint this frame (flickering in, or out on dismiss), with the age
  // + fade the panel/text share — or null when nothing's projected. The data is rebuilt
  // each frame (cheap: it's only up when toggled, and the state is static meanwhile).
  private specRender_(timestamp: number): { spec: SpecReadout; age: number; fade: number } | null {
    if (this.specShownAt_ !== null) {
      return { spec: this.buildSpec_(), age: timestamp - this.specShownAt_, fade: 1 }
    }
    if (this.specHideStart_ !== null) {
      const life = 1 - (timestamp - this.specHideStart_) / SPEC_FADE_MS
      if (life <= 0) {
        this.specHideStart_ = null
        return null
      }
      // Rewind the strike age (mirror flicker) and fade to nothing on dismiss.
      return { spec: this.buildSpec_(), age: SPEC_STRIKE_MS * life, fade: life }
    }
    return null
  }

  // The FINAL SCOREBOARD (docs/scoreboards.md) to project this frame, or null until the ending
  // cards have been sucked up (scoreRevealAt). It only flickers IN — it stays up until the New run
  // resets the phase, so there's no dismiss/fade-out to mirror.
  private scoreRender_(timestamp: number): { readout: ScoreReadout; age: number } | null {
    if (this.state_.phase !== 'over' || this.scoreRevealAt_ <= 0 || timestamp < this.scoreRevealAt_) {
      return null
    }
    return { readout: this.buildScore_(), age: timestamp - this.scoreRevealAt_ }
  }

  // The final scoreboard's contents, one of two pages the DOM pager (‹ ›) flips between: the run
  // SUMMARY (page 0) or the PERFORMANCE stats (page 1). Both share the same title spot and holo
  // rendering (drawScoreSheet takes pure strings).
  private buildScore_(): ScoreReadout {
    return this.scorePage_ === 1 ? this.buildPerformance_() : this.buildSummary_()
  }

  // Page 0: the outcome TITLE naming which of the three run-ending paths happened — CASHED OUT
  // (banked the stake after the Banker), BUSTED (lost a hand to the Banker, a coda bust), or
  // BANKRUPT (broke at Dealer 1–2, no coda offered) — then the final points, hands played, the
  // win/loss tally (pushes count as neither), and tokens spent on powerups.
  private buildSummary_(): ScoreReadout {
    const run = this.state_.run
    // recordRun (at enterOver) has already folded this run's score into the personal best, so on a
    // new record getPersonalBest() === run.score — show "NEW BEST ★" rather than echo the number;
    // otherwise show the standing best (the target this run missed). A coda bust (0) never records.
    const isNewBest = this.state_.newPersonalBest
    return {
      // `won` is never set (the run resolves through the coda): a cash-out banks the score, a coda
      // bust zeroes it. Every run now reaches the coda, so 'BANKRUPT' is an unreachable fallback.
      title: run.cashedOut ? 'CASHED OUT' : run.coda ? 'BUSTED' : 'BANKRUPT',
      rows: [
        // Player points are locale-grouped (thousands separators — "," or "." per the runtime
        // locale), matching the banker scoreboards; the count rows below stay bare.
        { label: 'POINTS', value: run.score.toLocaleString() },
        { label: 'BEST', value: isNewBest ? 'NEW BEST ★' : getPersonalBest().toLocaleString() },
        { label: 'HANDS PLAYED', value: String(run.handsPlayed) },
        // The win/loss RATIO (wins ÷ losses), guarded against divide-by-zero — a flawless run
        // (0 losses) divides by 1, so it reads as the win count (e.g. "12.00"), never NaN/∞.
        { label: 'WIN / LOSS', value: (run.handsWon / Math.max(run.handsLost, 1)).toFixed(2) },
        { label: 'ENERGY SPENT', value: String(run.tokensSpent) },
      ],
    }
  }

  // Page 1: how WELL the run was played — the share of hands that busted, the share won on a
  // blackjack (natural or hijacked), the share that pushed, and the averaged 1–5 star rating of
  // each hand's terminal call (see run.ts tallyPerformance). Percentages are over handsPlayed
  // (rounds, so a split counts once, matching the summary); the rating averages only the hands
  // that had a real decision to judge (a run that ended before any playable hand shows "—").
  private buildPerformance_(): ScoreReadout {
    const run = this.state_.run
    const played = Math.max(run.handsPlayed, 1)
    // Every round is exactly one of win / loss / push (see applyRound), so pushes need no stored
    // tally — they're whatever's left once the wins and losses are removed.
    const pushes = Math.max(0, run.handsPlayed - run.handsWon - run.handsLost)
    return {
      title: 'PERFORMANCE',
      // The star rating leads, centered label-less under the heading; the percentages follow.
      hero: run.ratedHands > 0 ? ratingStars(run.ratingSum / run.ratedHands) : '—',
      rows: [
        { label: 'BUST %', value: `${Math.round((run.busts / played) * 100)}%` },
        { label: 'BLACKJACK %', value: `${Math.round((run.blackjackWins / played) * 100)}%` },
        { label: 'PUSH %', value: `${Math.round((pushes / played) * 100)}%` },
      ],
    }
  }

  // Build the projected ruleset: the token inflation plus the dealer's active house
  // rules and the player's roguelite mods, as abbreviated feature flags (CPU-style).
  // Uses the live round's rules when a hand is up, else the rules the next deal will
  // apply (so it reads correctly at the betting screen too).
  private buildSpec_(): SpecReadout {
    const { run, round } = this.state_
    // The Banker coda runs its own fixed rule set — a by-the-book dealer (S17, 3:2, no split),
    // with NONE of the run's shift rules (dealer heals, bet floor, desperation ceiling) or
    // roguelite upgrades carried in. Show that cleanly rather than dealer 6's stale spec.
    if (run.coda) {
      const codaFlags: SpecFlag[] = [
        { text: `${SHOE_DECKS}DECK`, kind: 'house' },
        { text: 'H16', kind: 'house' },
        { text: DEFAULT_ROUND_RULES.dealerSoft17 === 'stand' ? 'S17' : 'H17', kind: 'house' },
      ]
      return { inflation: `+${Math.round(run.tokenInflation * 100)}%`, flags: codaFlags }
    }
    const shiftIndex = Math.min(run.shiftIndex, TOTAL_DEALERS)
    const shift = getShift(shiftIndex)
    const rules =
      round?.rules ??
      ({
        ...rulesForUpgrades(run.upgrades),
        dealerSoft17: shift.dealerSoft17,
        dealerHardHitCeiling: dealerHardHitCeiling(run),
      } as RoundRules)

    const flags: SpecFlag[] = []
    const house = (text: string): void => void flags.push({ text, kind: 'house' })
    const player = (text: string): void => void flags.push({ text, kind: 'player' })

    // Table baseline + the dealer's draw rules.
    house(`${SHOE_DECKS}DECK`)
    house('H16') // the dealer always hits a hard 16 or below
    if (rules.dealerSoft17 === 'hit') {
      house('H17')
    } else if (rules.dealerSoft17 === 'smart' && rules.dealerHardHitCeiling <= 17) {
      // Smart 17: hits a hard/soft 17 when behind. Skipped when the desperation
      // ceiling has risen above 17 — the raised-ceiling flag below already reads
      // "hits up to N when behind", which subsumes this, so printing both is redundant.
      house('H17_when_behind')
    } else if (rules.dealerSoft17 === 'stand') {
      house('S17')
    }
    // The final dealer's desperation hard-hit ceiling (17 normally; rises as it's
    // wounded) — the single escalating "when behind" flag: 17 → 18 → 19 → 20.
    if (rules.dealerHardHitCeiling > 17) {
      house(`H${rules.dealerHardHitCeiling}_when_behind`)
    }
    // Payout upgrade: a natural blackjack scores bonus points (T1 +50%, T2/T3 +100%).
    const bjBonus = blackjackPointBonusFor(run.upgrades)
    if (bjBonus > 0) {
      player(`BJ_+${Math.round(bjBonus * 100)}%`)
    }
    if (rules.allowSplit) {
      house('SPLIT_TO_2') // may split once, up to 2 hands (round.ts MAX_HANDS)
    }
    // A late dealer claws back a hit whenever it beats the player.
    if (shift.maxHeals > 0) {
      house('DEALER_HEALS')
    }
    if (this.state_.abilitiesLocked) {
      house('NO_ABILITIES')
    }

    // Player roguelite mods (Sabotage / Payout / Tokens), all working in the player's
    // favour — drawn in green.
    // Sabotage T1 pays flat energy on any dealer 21, and stays active at every tier (T2/T3 add the
    // redeal + hijack on top), so the flag shows the whole time the run owns Sabotage.
    if (rules.dealer21Energy) {
      player(`+${SABOTAGE_DEALER21_ENERGY}E_ON_D21`)
    }
    if (rules.voidDealer21) {
      player('REDEAL_D21')
    }
    if (rules.hijackDealerNatural) {
      player('HIJACK_BJ')
    }
    if (rules.pushWinsToPlayer) {
      player('PUSH_WINS')
    }
    if (rules.tokenMultiplier > 1) {
      // ×1.10 → "ENERGY_x1.1", ×1.18 → "ENERGY_x1.18" (drop a trailing zero).
      player(`ENERGY_x${rules.tokenMultiplier.toFixed(2).replace(/0$/, '')}`)
    }

    return { inflation: `+${Math.round(run.tokenInflation * 100)}%`, flags }
  }

  // Each hand's outcome (Win/Lose/Push/Bust + amount), one entry per player hand,
  // shown beside that hand's count — so both halves of a split report their own
  // result. Withheld until the card motion settles, so it never spoils the reveal.
  private handResults_(timestamp: number): (RoundResult | undefined)[] | undefined {
    const { phase, round } = this.state_
    if (!round) {
      return undefined // 'over' shows the run summary on the felt (nexus score screen), not per-hand results
    }
    // A settled hand projects its per-hand status ("Win"/"Lose"/"Blackjack"/"Push") beside the
    // count. Two phases carry a resolved hand: a normal 'resolved' hand, AND a resolved CODA hand —
    // the coda phase stays 'coda' the whole way through (the boss-kill/window-out entry hand and
    // every double-or-nothing hand), so a win/loss to the Banker would otherwise show a bare count
    // with no status. Both get the tag; 'over' (final scoreboard) falls through to undefined.
    const settledCoda = phase === 'coda' && round.status === 'resolved'
    if (phase !== 'resolved' && !settledCoda) {
      return undefined
    }
    if (this.anim_.isAnimating(timestamp)) {
      return undefined
    }
    return round.hands.map((hand) => handResultLabel(hand))
  }

  // The result reaction on a card-settle. The per-hand win/loss STING no longer plays here — it's
  // timed to the hand-summary mark's fade-in (summaryAppear_) — so a normal resolve only triggers
  // the dealer's VOICE. A finished run ('over') still plays its end sting off run.won/cashedOut (the
  // final scoreboard has no hand-summary to key off).
  private playResultSting_(): void {
    const { phase, run, round } = this.state_
    if (phase === 'over') {
      // The run ended: a coda cash-out (banked the score) plays the win sting; a coda bust plays
      // the loss sting.
      sfx.play(run.won || run.cashedOut ? 'player-won' : 'player-lost')
      return
    }
    if (phase === 'resolved' && round) {
      // The player-won/player-lost sting itself is NOT played here any more — it fires with the
      // hand-summary mark's fade-in (see summaryAppear_), and nowhere else. This card-settle beat
      // now only drives the dealer's VOICE reaction (laugh / growl).
      // A dealer that was just DESTROYED doesn't react. applyRound has already advanced the
      // shift to the next dealer (so playDealerAngry/Laugh would speak in the WRONG dealer's
      // voice) and zeroed handsThisDealer — which, at a resolved hand, only happens on a kill.
      // The kill/attack + walk-in sequence carries the audio instead. Dealer 1 depends on this:
      // beating it can trip an angry-growl trigger while the shift already reads 2, and Dealer 1
      // must stay completely silent.
      if (run.handsThisDealer === 0) {
        return
      }
      // The dealer cackles when it OUTSCORED the player: a 'lose' hand (the player stood and
      // the dealer's total beat theirs, incl. a dealer natural). A player 'bust' is their own
      // doing and 'push'/'voided' is a wash — neither earns a laugh. Otherwise, some
      // player triumphs make the dealer GROWL instead (see angryResolutionTrigger). The two
      // are mutually exclusive, and the laugh wins if somehow both apply.
      if (round.hands.some((hand) => hand.outcome === 'lose')) {
        this.playDealerLaugh_()
      } else if (this.angryResolutionTrigger_(round)) {
        this.playDealerAngry_()
      }
    }
  }

  // Whether this resolved round should make the dealer GROWL (an agitated reaction to the
  // player pulling something off). The three always-on cases plus one that only fires half
  // the time (a below-17 stand that the dealer's own bust bailed out — cheeky luck).
  private angryResolutionTrigger_(round: Round): boolean {
    // The player hits a natural blackjack (a real two-card 21 — NOT a hijacked dealer 21,
    // which also carries a 'blackjack' outcome).
    if (round.hands.some((hand) => hand.outcome === 'blackjack' && isBlackjack(hand.cards))) {
      return true
    }
    // A token-free Double that WON.
    if (round.hands.some((hand) => hand.freeDoubled && isWinningHand(hand))) {
      return true
    }
    // The dealer's own natural blackjack was voided (Sabotage T2) or hijacked (T3).
    if (isBlackjack(round.dealer) && (isDealerHijacked(round) || round.hands.some((h) => h.outcome === 'voided'))) {
      return true
    }
    // The player stood below 17 and the dealer busted (a lucky bail-out) — only half the time.
    if (
      dealerSettleTotal(round) > 21 &&
      round.hands.some((h) => h.outcome === 'win' && !h.busted && evaluateHand(h.cards).total < 17)
    ) {
      return Math.random() < 0.5
    }
    return false
  }

  // The dealer's evil-laugh voice emote on a house win: the mouth panel lights up with
  // rippling waves (render/dealer.ts) while a synthesised cackle plays (audio/voice.ts).
  // Both are driven by one seeded pattern so they pulse together. Dealer 1 is silent
  // (voiceSeedFor returns null). A short lead lets it land just behind the loss sting,
  // reading as the dealer's reaction rather than clashing with it.
  private playDealerLaugh_(): void {
    const shift = this.state_.run.shiftIndex
    const seed = voiceSeedFor(shift)
    if (seed === null) {
      return
    }
    // The seed varies each dealer's voice; the shift ramps it deeper + slower with progression.
    const pattern = evilLaughPattern(seed, shift)
    const lead = 0.16 // seconds, applied to both the audio clock and the visual clock
    voice.play(pattern, lead)
    this.dealer_.emote(now() + lead * 1000, pattern)
  }

  // The Banker's amused cackle — he's entertained by the gamble no matter how it lands. Fired
  // on his walk-in, on each double-or-nothing, and on a losing hand (never a growl: he's never
  // rattled). `startAt` is the absolute moment it should begin (a future walk-in, or now).
  private playBankerLaugh_(startAt: number, endBy?: number): void {
    const base = evilLaughPattern(BANKER_VOICE_SEED, BANKER_LAUGH_SHIFT)
    // Twice as long: run the cackle through a second time (slightly overlapped) — "hahaha… hahaha".
    const gap = base.totalMs - 90
    let pattern: VoicePattern = {
      ...base,
      syllables: [...base.syllables, ...base.syllables.map((s) => ({ ...s, at: s.at + gap }))],
      totalMs: base.totalMs * 2 - 90,
    }
    // The walk-in laugh is cut off at `endBy` (it should end as the deck shred begins, not carry
    // on through it): drop any syllable that starts past the deadline and clamp the total.
    if (endBy !== undefined) {
      const maxMs = Math.max(200, endBy - startAt)
      pattern = { ...pattern, syllables: pattern.syllables.filter((s) => s.at < maxMs), totalMs: Math.min(pattern.totalMs, maxMs) }
    }
    const lead = Math.max(0, startAt - now()) / 1000
    voice.play(pattern, lead, BANKER_LAUGH_GAIN)
    this.dealer_.emote(startAt, pattern)
  }

  // A hand just started (cards dealing): a dealer 2–6 LAUGHS if the player has shoved ALL-IN
  // (down to their last window hand) while the table is still healthy (> 25% of its hits) — the
  // house savouring a desperate gamble. Fires once per deal (a fresh round appearing).
  private checkDealLaugh_(prevRound: Round | null): void {
    const round = this.state_.round
    if (prevRound || !round) {
      return // only when a round just appeared — i.e. a fresh deal
    }
    const run = this.state_.run
    if (run.shiftIndex <= 1) {
      return
    }
    // The house savours it when the player is down to their last window hand with the dealer
    // still healthy — the escalation analogue of the old all-in shove.
    const shift = getShift(run.shiftIndex)
    const lastCall = run.handsThisDealer >= shift.maxHands - 1
    const healthy = run.integrity > ALLIN_LAUGH_HEALTH * maxHitsFor(run.shiftIndex)
    if (lastCall && healthy) {
      this.playDealerLaugh_()
    }
  }

  // The dealer's angry-growl emote — the agitated counterpart to the laugh, fired when the
  // player pulls something off (see the resolution + action triggers). Same seed/shift voice
  // identity, a hot-tinted mouth, and a short lead so it reads as an immediate reaction.
  // Dealer 1 is silent (voiceSeedFor returns null).
  private playDealerAngry_(): void {
    const shift = this.state_.run.shiftIndex
    const seed = voiceSeedFor(shift)
    if (seed === null) {
      return
    }
    const pattern = angryGrowlPattern(seed, shift)
    const lead = 0.05 // a quick, immediate snarl
    voice.play(pattern, lead)
    this.dealer_.emote(now() + lead * 1000, pattern)
  }

  // A dealer (2–6) stomps in growling — a short (600–800ms) growl fired as the walk-in begins.
  // BUT if the player is on the ropes (would go bankrupt within ROPES_HANDS losing hands and is
  // low on tokens), the incoming dealer MOCKS them with a laugh instead. Dealer 1 is silent.
  private playWalkInGrowl_(timestamp: number): void {
    const shift = this.dealer_.figureShift(timestamp)
    // The Banker isn't a menacing dealer — his amused laugh is fired from beginCoda instead.
    if (shift > TOTAL_DEALERS) {
      return
    }
    const seed = voiceSeedFor(shift)
    if (seed === null) {
      return
    }
    const run = this.state_.run
    const onTheRopes = run.tokens < ROPES_TOKENS
    const pattern = onTheRopes ? evilLaughPattern(seed, shift) : angryGrowlPattern(seed, shift)
    voice.play(pattern, 0) // starts now, in step with the walk-in's first steps
    this.dealer_.emote(timestamp, pattern)
  }

  // Game over — the player went bankrupt — so the victorious dealer (2–6) saunters off
  // CACKLING. The natural-length laugh keeps ringing a beat past the exit. Dealer 1 silent.
  private playWalkOffLaugh_(timestamp: number): void {
    const shift = this.dealer_.figureShift(timestamp)
    // The Banker handles his own reactions (a cash-out gets no gloat; a bust already laughed).
    if (shift > TOTAL_DEALERS) {
      return
    }
    const seed = voiceSeedFor(shift)
    if (seed === null) {
      return
    }
    const pattern = evilLaughPattern(seed, shift)
    voice.play(pattern, 0)
    this.dealer_.emote(timestamp, pattern)
  }

  // Action-driven angry triggers, checked from run() off the before/after round diff:
  // the player FREEZES the dealer, or makes a risky HIT at >= 16 and survives it (half the
  // time). Both happen mid-hand with the dealer standing. (Resolution triggers are handled
  // separately in playResultSting.)
  private checkAngryAction_(prevRound: Round | null, prevPhase: SessionState['phase']): void {
    const round = this.state_.round
    if (!round || !prevRound) {
      return
    }
    // Freeze Dealer just used — the dealer was forced to stand on its total.
    if (round.dealerFrozen && !prevRound.dealerFrozen) {
      this.playDealerAngry_()
      return
    }
    // A risky HIT that survived and left the player still in the hand: same hand set, exactly
    // one card added to a hand (rules out split/deal/return), it wasn't a Double, the hand
    // didn't bust, and it was already >= 16 before the card. Half the time.
    if (prevPhase === 'playing' && this.state_.phase === 'playing' && round.hands.length === prevRound.hands.length) {
      for (let i = 0; i < round.hands.length; i++) {
        const nh = round.hands[i]
        const ph = prevRound.hands[i]
        if (nh.cards.length === ph.cards.length + 1 && !nh.doubled && !nh.busted) {
          if (evaluateHand(ph.cards).total >= 16 && Math.random() < 0.5) {
            this.playDealerAngry_()
          }
          return
        }
      }
    }
  }

  // Chips/bankroll are gone; this layer now only carries the coda's glass winnings counters (the
  // double-or-nothing pot made physical). The dealer hand-summary is a nexus projection (drawCards_).
  private drawChips_(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.play.ctx // shared with cards; renderPlay_ clears it once (drawCards_ runs first)
    // The glass pot appears with the coda proper — held back while a heart-death is still popping its
    // final chip on the way in (heartDeathPending_), so the two don't overlap.
    if (this.state_.run.coda && !this.heartDeathPending_) {
      drawCodaCounters(ctx, layout, this.codaCrystalValue_, this.codaCounters_.frame(timestamp))
    }
  }

  // The player hit-point row (heart-chips) plus its pop/heal beams. Shown throughout normal play; it
  // clears once the coda begins (hit points are a normal-play resource), except while the fatal pop
  // is still animating in on a heart-death entry.
  private drawHearts_(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.overlay.ctx // shared; renderOverlay_ clears it once (no clear here)
    // Nothing on the tap-to-start / title screen — the hearts belong to a live run, and they ease in
    // once it begins (fade below).
    if (!this.started_) {
      return
    }
    if (this.state_.run.coda && !this.heartDeathPending_ && !this.hearts_.isAnimating(timestamp)) {
      return
    }
    const fade = Math.min(1, Math.max(0, (timestamp - this.startedAt_) / HEARTS_FADE_MS))
    drawHearts(ctx, layout, this.hearts_.view(timestamp), timestamp, fade)
  }

  // The dealer hand-summary shown between hands: the played slots (green win / red loss) filling the
  // dealer's window, the newest scaling in, fading out on Next hand. Null while a hand is live, the
  // cards are still settling, or the summary has fully faded.
  private summaryView_(t: number): HandSummaryView | null {
    const s = this.summary_
    if (!s) {
      return null
    }
    // Fading out (the player called the next hand): keep painting the board as it winds down —
    // deliberately BEFORE the appear gate below, since the next-hand ceremony is already running.
    // Gating this on the appear/phase checks is what made the board snap out instead of fading.
    if (this.summaryFadeAt_ > 0) {
      const presence = 1 - (t - this.summaryFadeAt_) / SUMMARY_FADE_MS
      if (presence <= 0) {
        this.summary_ = null
        return null
      }
      // Fade OUT front-loaded (smoothStart2): the bright, GLOWING win/loss marks need their alpha to
      // drop fast early or a linear ramp makes them hold-then-snap (display gamma), while the faint
      // gray pips fade smoothly regardless. Matching the whole board to this curve makes every element
      // — pips, marks, and the holo rays keyed off `fade` below — wind down as one.
      return { slots: s.slots, revealFrom: s.revealFrom, cashInElapsed: t - s.cashInAt, fade: smoothStart2(presence) }
    }
    // Not shown until its appear anchor: AFTER the laser lands on a win, or the card-settle on a loss
    // (set in run_). Until then — and until it's actually scheduled (appearAt 0) — nothing is drawn.
    if (s.appearAt === 0 || t < s.appearAt) {
      return null
    }
    const phase = this.state_.phase
    // A heart-death entry keeps painting the losing board over the 'coda' phase until its final pop
    // has played and the walk-off begins (heartDeathPending_).
    if (phase !== 'resolved' && phase !== 'choosing-upgrade' && !this.heartDeathPending_) {
      return null
    }
    // The whole board eases IN from its appear anchor; then every new slot cascades in from cashInAt
    // (= the reveal moment) at CASH_IN_STAGGER intervals — split/double checks and kill cash-in alike.
    // smoothEnd2 mirrors the fade-out: the board rises quickly then settles, so the pips + holo rays are
    // present fast without the marks popping in late (the mark-reveal cascade runs after fade-in ends).
    const fade = smoothEnd2(clamp01((t - s.appearAt) / SUMMARY_FADE_IN_MS))
    return { slots: s.slots, revealFrom: s.revealFrom, cashInElapsed: t - s.cashInAt, fade }
  }

  // Stamp WHEN the hand-summary eases in (its appear anchor: after the laser lands on a win, at the
  // card-settle on a loss), derive the kill cash-in start, and set the Next-hand consent gate to the
  // moment the result mark (and any kill cascade) has fully revealed — so a click never fast-forwards
  // past the player seeing the outcome. Called on the resolve once the laser timing is known.
  private summaryAppear_(appearAt: number): void {
    const s = this.summary_
    if (!s) {
      this.resolveAttackEnd_ = appearAt
      return
    }
    s.appearAt = appearAt
    const revealAt = appearAt + SUMMARY_APPEAR_HOLD
    // Every new slot cascades uniformly from the reveal moment (cashInAt = revealAt) at
    // CASH_IN_STAGGER — a split/double's two checks, and a kill's whole cash-in run, fill one-by-one.
    s.cashInAt = revealAt
    // The win/loss sting — the ONLY place these play — timed to the mark's fade-in (revealAt). An
    // all-push wash never gets here (summary_ is null, handled above).
    const newMarks = s.slots.slice(s.revealFrom, s.revealFrom + s.playedCount)
    const stingDelay = Math.max(0, revealAt - now()) / 1000
    if (newMarks.includes('win')) {
      sfx.play('player-won', stingDelay)
    } else if (newMarks.includes('loss')) {
      sfx.play('player-lost', stingDelay)
    }
    // The consent gate: once the whole cascade of new (non-empty) slots has fully revealed. They sit
    // contiguously from revealFrom (played result + any cash-in), so the last is at index newFilled-1.
    const newFilled = s.slots.slice(s.revealFrom).filter((slot) => slot !== 'empty').length
    this.resolveAttackEnd_ = revealAt + Math.max(0, newFilled - 1) * CASH_IN_STAGGER + CASH_IN_REVEAL_MS
  }

  // Build the fly-in schedule from a resolved round's per-green-check deltas (winPointDeltas): pair
  // each with the next WIN slot in the summary's new run, to launch when that check reveals (all at
  // once on a normal win, cascaded on a kill). Hold the counter at the pre-resolve score, and extend
  // the Next-hand consent gate so the last "+N" reaches the counter before the hand can be cleared.
  private setupScoreDeltas_(prevScore: number, deltas: number[], revealAt: number): void {
    const s = this.summary_
    if (!s) {
      return
    }
    this.scoreDeltas_.reset()
    this.deltaHoldBase_ = prevScore
    this.deltaLandedSum_ = 0
    this.deltaEmitted_ = 0
    this.deltaLandIndex_ = 0
    this.deltaPending_ = []
    let di = 0
    let lastSpawn = revealAt
    for (let k = 0; s.revealFrom + k < s.slots.length && di < deltas.length; k += 1) {
      if (s.slots[s.revealFrom + k] !== 'win') {
        continue // losses (red ✗) score nothing — no green check, no delta
      }
      // Launch each delta as its own check reveals — slot k pops at revealAt + k·CASH_IN_STAGGER — so
      // a split/double's two "+N"s and a kill's cash-in fly one-by-one, matching the checks.
      const spawnAt = revealAt + k * CASH_IN_STAGGER
      this.deltaPending_.push({ value: deltas[di], slotIndex: s.revealFrom + k, spawnAt, rowIndex: di })
      lastSpawn = Math.max(lastSpawn, spawnAt)
      di += 1
    }
    this.resolveAttackEnd_ = Math.max(this.resolveAttackEnd_, lastSpawn + DELTA_FLY_MS)
  }

  // Diff the player's hit points across a (non-fatal) resolve and drive the heart VFX: a lost round
  // POPs the last chip, a qualifying win HEALs the first empty one — both fired at `startAt` (after
  // the summary's mark is fully revealed), and the Next-hand consent gate held until the effect ends.
  // When hit points didn't change, just keep the animator's committed count in step for the next diff.
  private syncHearts_(prevHitPoints: number, startAt: number): void {
    const hp = this.state_.run.hitPoints
    if (hp === prevHitPoints) {
      this.hearts_.sync(hp)
      return
    }
    if (hp < prevHitPoints) {
      this.schedulePop_(startAt) // a loss always pops exactly one
    } else {
      this.scheduleHeal_(hp - prevHitPoints, startAt) // a win heals one, or several on a kill
    }
    this.resolveAttackEnd_ = Math.max(this.resolveAttackEnd_, this.hearts_.animEndAfter(startAt))
  }

  // Fire the heart-pop laser: the animator's pop, the red lens flare, and the prepare/impact sounds.
  // No dealer laser competes on a loss, so the lens is free to flare; the impact lands a beat after
  // launch as the beam reaches the chip (≈ the animator's beam travel).
  private schedulePop_(startAt: number): void {
    const t = now()
    this.hearts_.pop(startAt)
    this.nexus_.fire(t, startAt, startAt + HEART_MUZZLE_MS)
    sfx.play('laser-prepare', Math.max(0, startAt - t) / 1000)
    sfx.play('laser-impact', Math.max(0, startAt + 120 - t) / 1000)
  }

  // Fire the heart-heal beam for `count` hearts: the animator's heal + the repair chime. The green
  // band is drawn from the nexus lens by the hearts layer (no dealer-side heal is triggered).
  private scheduleHeal_(count: number, startAt: number): void {
    this.hearts_.heal(count, startAt)
    sfx.playHeal(Math.max(0, startAt - now()) / 1000)
  }

  // Launch any scheduled deltas whose green check has revealed by `now`, from that check's live
  // position (slotCenters, straight off the summary draw). Called each frame from drawCards_.
  private emitScoreDeltas_(slotCenters: readonly Point[], now: number): void {
    while (this.deltaEmitted_ < this.deltaPending_.length) {
      const d = this.deltaPending_[this.deltaEmitted_]
      if (now < d.spawnAt) {
        break // pending are in ascending spawnAt order — the rest aren't due yet
      }
      const from = slotCenters[d.slotIndex]
      if (!from) {
        break // the summary isn't laying this slot out this frame — retry next frame
      }
      this.scoreDeltas_.emit(d.value, from, d.rowIndex, now)
      this.deltaEmitted_ += 1
    }
  }

  // Tick the held counter up by every delta that reached its row since last frame, and ping the
  // arrival tone (its pitch stepping up the run so a kill's ascending cash-in rings as a rising
  // arpeggio). Called every frame from the loop.
  private landScoreDeltas_(now: number): void {
    for (const value of this.scoreDeltas_.landed(now)) {
      this.deltaLandedSum_ += value
      const pitch = Math.min(2, Math.pow(2, this.deltaLandIndex_ / 12))
      sfx.playTone('score-delta-land', 0, pitch)
      this.deltaLandIndex_ += 1
    }
  }

  // Where row 0 of the delta stack lands: just below the score counter's number, right-anchored to
  // its right edge (the "+N"s grow leftward). Canvas space (shared CSS-pixel coords, like tokenTarget).
  private scoreDeltaTarget_(): Point {
    const host = this.stage_.container.getBoundingClientRect()
    const box = this.pointsRowEl_.getBoundingClientRect()
    return { x: box.right - host.left, y: box.bottom - host.top + box.height * 0.4 }
  }

  private drawScoreDeltas_(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.overlay.ctx // shared; renderOverlay_ clears it once (no clear here)
    if (!this.scoreDeltas_.isAnimating(timestamp)) {
      return
    }
    drawScoreDeltas(ctx, layout, this.scoreDeltas_, timestamp, this.scoreDeltaTarget_())
  }

  // The Next-hand button is CONSENT, not a fast-forward: if the resolve choreography (reward → laser
  // → summary reveal) is still playing, arm `proceedPending` and let the frame loop advance once the
  // gate passes; past the gate, advance now. Run inside run_ (the click wrapper), so even the
  // arm-only path re-syncs the overlay (disabling the button now that consent's been given).
  private requestNextHand_(): void {
    if (now() >= this.resolveAttackEnd_) {
      this.session_.nextHand()
    } else {
      this.proceedPending_ = true
    }
  }

  // The rendered RIGHT edge of the left powerup ("ability") column, in canvas/CSS coords — so the
  // hand-summary lays its pips out CLEAR of it. The column's width is LABEL-DRIVEN (max-width 44vw,
  // stretched to the longest ability name), so it's MEASURED, not assumed. 0 when it's hidden/empty.
  private hudLeftInset_(): number {
    const powers = this.powersEl_.getBoundingClientRect()
    if (powers.width <= 0) {
      return 0
    }
    const host = this.stage_.container.getBoundingClientRect()
    return powers.right - host.left
  }

  // The top layer: reward tokens flying up to the counter. Cleared and left blank
  // whenever nothing is in the air (which is most of the time).
  private drawTokens_(canvas: LayeredCanvas, layout: Layout, timestamp: number): void {
    const ctx = canvas.layers.overlay.ctx // shared; renderOverlay_ clears it once (no clear here)
    if (!this.tokens_.isAnimating(timestamp)) {
      return
    }
    drawTokens(ctx, layout, this.tokens_, timestamp, this.tokenTarget_())
  }

  // The token counter's centre in canvas space. The overlay and the canvas layers
  // share the stage's box and CSS-pixel coordinates, so the counter's position
  // relative to the stage IS its canvas coordinate — the point tokens fly into.
  private tokenTarget_(): Point {
    const host = this.stage_.container.getBoundingClientRect()
    const box = this.tokensEl_.getBoundingClientRect()
    return { x: box.left - host.left + box.width / 2, y: box.top - host.top + box.height / 2 }
  }

  // The count to show: the run total minus whatever is still flying toward the
  // counter (pending) AND whatever a resolve is withholding until the next hand
  // (heldTokens) — so a win only registers once its tokens are released and land.
  private displayedTokens_(now: number): number {
    return this.state_.run.tokens - this.tokens_.pending(now) - this.heldTokens_
  }

  // Point the token counter at what should be shown now (bursts still in the air
  // are withheld), then paint the ticker's current value + swell. As each burst
  // lands the target jumps up and the counter rolls up to meet it. Called every
  // frame while anything is in motion, and on each state sync.
  private updateTokenCounter_(now: number): void {
    this.tokenTicker_.retarget(this.displayedTokens_(now), now)
    // This runs every frame (even at rest). Only touch the DOM when the value or swell
    // actually changes, so a settled counter isn't rewriting its text node + transform
    // 60×/sec (each write invalidates style/layout).
    const text = String(this.tokenTicker_.value(now))
    if (text !== this.lastTokenText_) {
      this.tokenCountEl_.textContent = text
      this.lastTokenText_ = text
    }
    const scale = this.tokenTicker_.scale(now)
    const transform = scale === 1 ? '' : `scale(${scale})`
    if (transform !== this.lastTokenTransform_) {
      this.tokensEl_.style.transform = transform
      this.lastTokenTransform_ = transform
    }
  }

  // The points to show: the pre-resolve value while a reward is still landing (heldScore),
  // otherwise the live run total. The ticker rolls up to whatever this returns.
  private displayedScore_(): number {
    // While the fly-in deltas are landing, the counter shows the pre-resolve base plus only what has
    // arrived so far — it climbs step-by-step with each "+N" (never ahead of them).
    if (this.deltaHoldBase_ !== null) {
      return this.deltaHoldBase_ + this.deltaLandedSum_
    }
    return this.heldScore_ ?? this.state_.run.score
  }

  // Point the score counter at what should be shown now, then paint the ticker's value +
  // swell — mirrors updateTokenCounter. Called every frame and on each state sync.
  private updatePointsCounter_(now: number): void {
    this.scoreTicker_.retarget(this.displayedScore_(), now)
    // A roll just began — play the ticking flutter for exactly as long as it runs. The
    // edge flag keeps it to one play per roll (this runs every frame + on each sync).
    const rolling = this.scoreTicker_.isAnimating(now)
    if (rolling && !this.pointsRolling_) {
      sfx.playPointsRoll(this.scoreTicker_.remainingMs(now))
    }
    this.pointsRolling_ = rolling
    const text = abbreviateCount(this.scoreTicker_.value(now))
    if (text !== this.lastPointsText_) {
      this.pointsCountEl_.textContent = text
      // Shrink the counter by digit count so the double-or-nothing coda's big totals don't
      // crowd the top-right corner on small screens (see the [data-len] rules in the CSS).
      this.pointsCountEl_.dataset.len = String(Math.min(text.length, 12))
      this.lastPointsText_ = text
    }
    const scale = this.scoreTicker_.scale(now)
    const transform = scale === 1 ? '' : `scale(${scale})`
    if (transform !== this.lastPointsTransform_) {
      // Swell the whole star + number row together (pinned to the right edge) so the star
      // pumps with the count and never overlaps it.
      this.pointsRowEl_.style.transform = transform
      this.lastPointsTransform_ = transform
    }
  }

  // Hold the points counter frozen at `prevScore` until the reward tokens land, then it
  // releases to run.score with a "+delta" flash (the EFFECTIVE, already-multiplied points).
  // `mult` is the combo that produced it — carried for the middle-of-felt reward projection,
  // NOT the top-right (which shows total + effective delta only). `releaseAt` is a fallback
  // in case no token ever lands to trigger the release (a chips-only win).
  private holdScoreReward_(prevScore: number, delta: number, mult: number, releaseAt: number): void {
    this.heldScore_ = prevScore
    this.pendingScoreDelta_ = delta
    this.pendingMult_ = mult
    this.scoreReleaseAt_ = releaseAt
  }

  // Release the held score: the reward tokens have landed, so let the counter roll up to
  // run.score (the effective total) and flash the "+base ×mult" breakdown top-right.
  private releaseHeldScore_(): void {
    const delta = this.pendingScoreDelta_
    const mult = this.pendingMult_
    this.heldScore_ = null
    this.pendingScoreDelta_ = 0
    this.pendingMult_ = 1
    this.scoreReleaseAt_ = 0
    if (delta > 0) {
      this.flashPointsDelta_(delta, mult)
    }
  }

  // Flash the reward top-right: the BASE points (white) with the combo "×mult" (yellow) that
  // multiplied them — "+200 ×1.5" — while the counter above ticks up by the effective total
  // (base × mult). `delta` is the effective gain, so base = round(delta / mult). Fades + pops
  // via the .is-flashing keyframes; restart the animation (drop class → reflow → re-add) so
  // back-to-back rewards replay instead of freezing.
  private flashPointsDelta_(delta: number, mult: number): void {
    const base = mult > 1 ? Math.round(delta / mult) : delta
    this.pointsDeltaEl_.textContent = `+${base}`
    if (mult > 1) {
      const mx = element('span', 'hud-points__mult')
      mx.textContent = `  ×${mult.toFixed(2)}`
      this.pointsDeltaEl_.appendChild(mx)
    }
    // The coda has no next-hand click to drop the delta, so it uses a SELF-FADING variant that
    // holds ~3s then fades on its own; regular rounds hold until the next hand clears them.
    const coda = this.state_.run.coda
    this.pointsDeltaEl_.classList.remove(coda ? 'is-flashing' : 'is-flashing-coda')
    restartAnimation(this.pointsDeltaEl_, coda ? 'is-flashing-coda' : 'is-flashing')
  }

  // The BANKER SCOREBOARD (docs/scoreboards.md) to paint this frame: full presence at the prompt
  // (live values), then fading out once a hand is dealt (DOUBLE) or the run ends (cash-out). Its
  // content freezes the instant it starts fading, so the fade shows the prompt it's leaving, not
  // the live hand behind it. Null return when nothing's up. (Mirrors comboProjRender's
  // self-clearing.)
  private codaStakeRender_(now: number): { points: number; wonHand: boolean; age: number; fade: number } | null {
    if (this.codaStakeShownAt_ <= 0) {
      return null
    }
    if (this.state_.phase === 'coda' && !this.state_.round) {
      this.codaStakeHideAt_ = 0
      // Use the ROLLING counter value (the same one the top-right score rides), not the raw
      // displayedScore() — so on a win the projected stake ticks up to the doubled total in
      // lockstep with the HUD instead of snapping when the held reward releases.
      return { points: this.scoreTicker_.value(now), wonHand: this.codaWonHand_, age: now - this.codaStakeShownAt_, fade: 1 }
    }
    // The prompt just closed — fade out, freezing the content at the moment it began hiding.
    if (this.codaStakeHideAt_ <= 0) {
      this.codaStakeHideAt_ = now
      this.codaStakeFadePoints_ = this.scoreTicker_.value(now)
      this.codaStakeFadeWon_ = this.codaWonHand_
    }
    const fade = 1 - (now - this.codaStakeHideAt_) / CODA_STAKE_FADE_MS
    if (fade <= 0) {
      this.codaStakeShownAt_ = 0
      this.codaStakeHideAt_ = 0
      return null
    }
    return { points: this.codaStakeFadePoints_, wonHand: this.codaStakeFadeWon_, age: now - this.codaStakeShownAt_, fade }
  }

  // Animation loop: repaints the dynamic canvas layers every frame. It never fully
  // parks — the nexus's perpetual hover keeps it running (see the unconditional
  // reschedule at the end of frame()) — and the overlay is synced on the animate→idle
  // edge (and every frame while an upgrade pick is pending).
  // Tell CrazyGames when a hand is ACTIVELY being played (SDK.game.gameplayStart/Stop). Active = a
  // hand in progress — the main game ('playing') or a coda double-or-nothing hand ('coda' with a
  // round up). Everything else (the title, the betting wait, the resolved / upgrade / coda prompts,
  // game-over) is a break. Emitted only on change. Ads are never fired from here — we request them
  // explicitly — so a between-hands break can never pop an ad mid-hand.
  private syncGameplaySignal_(): void {
    const s = this.state_
    const active = this.started_ && (s.phase === 'playing' || (s.phase === 'coda' && s.round !== null))
    if (active === this.gameplayActive_) {
      return
    }
    this.gameplayActive_ = active
    if (active) {
      gameplayStart()
    } else {
      gameplayStop()
    }
  }

  // Report progression to CrazyGames (SDK.game.reportGameCompletedPercentage) as dealers fall: each
  // of the 6 kills is a milestone, and arriving at the Banker coda (the 6th) is 100%. Emitted only
  // when the percentage rises; a drop (a fresh or restarted run) re-baselines without emitting.
  private syncProgressSignal_(): void {
    const run = this.state_.run
    const defeated = run.coda ? TOTAL_DEALERS : Math.min(run.kills.length, TOTAL_DEALERS)
    const pct = Math.round((defeated / TOTAL_DEALERS) * 100)
    if (pct < this.reportedProgressPct_) {
      this.reportedProgressPct_ = pct // a new run — re-baseline, don't report a decrease
      return
    }
    if (pct === this.reportedProgressPct_) {
      return
    }
    this.reportedProgressPct_ = pct
    reportGameCompletedPercentage(pct)
  }

  private readonly frame_ = (timestamp: number): void => {
    this.anim_.setNow(timestamp)
    // Battery saver bookkeeping: a live frame means we're awake, so drop any pending pulse/watchdog
    // sleep (it can't double-schedule), then note whether THIS frame has real motion — the grace
    // clock the tail's park decision reads. Short cosmetic fades aren't in busy_; the grace covers
    // them. Cheap no-ops when saver is off.
    if (this.sleepTimer_) {
      clearTimeout(this.sleepTimer_)
      this.sleepTimer_ = 0
    }
    if (this.busy_(timestamp)) {
      this.lastBusyAt_ = timestamp
    }
    this.syncGameplaySignal_()
    this.syncProgressSignal_()
    // Tap-to-start: once the post-tap fade-out beat (TAP_FADE_MS) has elapsed, start the scene —
    // flip `started` (releasing the held walk-in + first deal), reveal the HUD, drop the catcher.
    if (this.tapAt_ > 0 && !this.started_ && timestamp >= this.tapAt_ + TAP_FADE_MS) {
      this.started_ = true
      this.startedAt_ = timestamp // begin the hearts' fade-in with the HUD
      this.stage_.overlay.classList.remove('hud-hidden')
      this.introCatcher_?.remove()
      this.introCatcher_ = null
      this.saverToggleEl_?.remove() // the title pill goes with the catcher (HUD button takes over)
      this.saverToggleEl_ = null
    }
    // Game over: the ending cards have just finished being sucked up. Latch the reveal
    // (before drawCards, so the shredded cards stay gone this frame), start projecting
    // the score screen, and re-sync so the New-run button appears.
    if (this.scoreRevealAt_ > 0 && !this.scoreRevealed_ && timestamp >= this.scoreRevealAt_) {
      this.scoreRevealed_ = true
      this.endShredDone_ = true
      // Every run's board opens on the summary page; force a reposition on this fresh board.
      this.scorePage_ = 0
      this.lastPagerPos_ = ''
      this.syncOverlay_(timestamp) // syncScorePager_ runs at the end → the pager appears + positions
    }
    // A card just launched from the shoe (one entry per fresh flight this frame) —
    // fire the draw sfx for each. Glides (split originals) are excluded upstream.
    const drawn = this.anim_.drawnCards(timestamp).length
    for (let i = 0; i < drawn; i += 1) {
      sfx.play('draw-card')
    }
    // Reward tokens just shot out of the nexus vent — one rising tone per visible
    // token sprite, staggered into a quick cascade (a kill's 5-sprite burst reads
    // as a coin shower, not a single stacked blip).
    const launched = this.tokens_.launched(timestamp)
    for (let i = 0; i < launched; i += 1) {
      sfx.playTone('token-launch', (i * TOKEN_TONE_STAGGER_MS) / 1000)
    }
    // ...and the answering shower as each burst reaches the counter: one ping per
    // visible token, tight like the launch (so it reads as a dense shower, not a
    // sparse trickle). The counter then rolls the number up over that SAME window,
    // so it finishes climbing exactly as the last ping lands — audio and number in
    // step, both a quick punch rather than a long tail.
    for (const icons of this.tokens_.landed(timestamp)) {
      for (let i = 0; i < icons; i += 1) {
        sfx.playTone('token-land', (i * TOKEN_TONE_STAGGER_MS) / 1000)
      }
      const showerMs = Math.max(1, icons - 1) * TOKEN_TONE_STAGGER_MS
      this.tokenTicker_.retarget(this.displayedTokens_(timestamp), timestamp, showerMs)
      // The hand's reward tokens have reached the counter — now let the points catch up
      // (they were held at the pre-resolve value so they rise AFTER the reward, per spec).
      if (this.heldScore_ !== null) {
        this.releaseHeldScore_()
      }
    }
    // The fresh deck's shrink-wrap: read the same unwrap fraction the renderer uses
    // and fire the tear-open sfx as it begins peeling (unwrap leaves 0), then the
    // rustling sfx as the big sheet starts sliding off to the left.
    const unwrap = this.spawn_.deckState(timestamp)?.unwrap ?? 0
    if (unwrap > 0 && this.prevUnwrap_ <= 0) {
      sfx.play('packaging-opening')
    }
    if (unwrap >= SHEET_SLIDE_START && this.prevUnwrap_ < SHEET_SLIDE_START) {
      sfx.play('packaging-rustling')
    }
    this.prevUnwrap_ = unwrap
    // The dealer's shredder: start the looping bed (shredder + vacuum) as the first
    // card is sucked in, fast-fade it once the last is gone.
    const shredding = this.spawn_.isShredding(timestamp)
    if (shredding && !this.shreddingLast_) {
      sfx.startShredding()
    } else if (!shredding && this.shreddingLast_) {
      sfx.stopShredding(SHRED_FADE_MS)
    }
    this.shreddingLast_ = shredding
    // Opening walk-in hold: keep the dealer parked off-screen until the loop settles
    // into steady (~60fps) frames, THEN start the slide-in — so the one big post-load
    // frame (JIT/GC/first composite) is absorbed by the invisible hold instead of
    // teleporting the visible walk-in. Released after two consecutive steady frames,
    // or a 600ms safety cap so it can't stall forever on a slow device.
    if (this.introHold_) {
      if (!this.started_) {
        // Tap-to-start intro: keep the dealer parked OFF-SCREEN (invisible) until the tap, so
        // nothing but the table + the nexus's "TAP TO START" shows. On the tap the walk-in
        // begins (now WITH sound, since the gesture just unlocked the audio contexts).
        this.dealer_.spawn(timestamp)
        this.introHoldStart_ = timestamp // don't count the warm-up until the tap releases it
      } else {
        const dt = timestamp - this.introPrevFrame_
        this.introPrevFrame_ = timestamp
        this.introSteadyFrames_ = dt > 0 && dt < 40 ? this.introSteadyFrames_ + 1 : 0
        if (this.introSteadyFrames_ >= 2 || timestamp - this.introHoldStart_ > 600) {
          this.introHold_ = false
          this.startIntroNow_(timestamp)
        } else {
          this.dealer_.spawn(timestamp) // hold the figure off-screen this frame
        }
      }
    }
    // The dealer's walk-in footsteps: one boot-thud per bob-down beat as the figure
    // strides to its spot (page load, New run, or a replacement after a kill). Fired
    // off the animator's step tracker so each thud lands exactly on a visible dip;
    // the sfx is rate-jittered per play so the strides don't sound stamped identical.
    const steps = this.dealer_.footsteps(timestamp)
    for (let i = 0; i < steps; i += 1) {
      sfx.play('footstep')
    }
    // Voice on entrances/exits, detected off the walk animations (once per start stamp):
    //  • a dealer 2–6 stomps in GROWLING (the growl ends exactly as it plants), and
    //  • at game over (the player went bankrupt) the dealer strolls off CACKLING.
    // Both skip dealer 1 (silent). The intro-hold guard keeps the opening (invisible,
    // parked) dealer from growling before its real walk-in.
    const arriving = this.dealer_.arriving(timestamp)
    if (arriving !== null && !this.introHold_) {
      const startAt = timestamp - arriving * KILL_ARRIVE_MS
      if (Math.abs(startAt - this.lastWalkInStart_) > VOICE_START_EPS) {
        this.lastWalkInStart_ = startAt
        this.playWalkInGrowl_(timestamp)
        // A new dealer (2..6) is starting — turn the soundtrack over (fade out, fade a fresh
        // one in). NOT the Banker: his coda picks its song by the player's choice (double-or-
        // nothing snaps in the coda theme; cash out leaves the current track), so his walk-in
        // must leave the music untouched.
        const walkInShift = this.dealer_.figureShift(timestamp)
        if (walkInShift > 1 && walkInShift !== BANKER_SHIFT) {
          music.advanceTrack()
        }
      }
    }
    const leaving = this.dealer_.leaving(timestamp)
    if (leaving !== null) {
      const startAt = timestamp - leaving * KILL_ARRIVE_MS
      if (Math.abs(startAt - this.lastWalkOffStart_) > VOICE_START_EPS) {
        this.lastWalkOffStart_ = startAt
        this.playWalkOffLaugh_(timestamp)
      }
    }
    // Track the riffle's progress (null when not shuffling) — used to fire the shuffle
    // sfx at the merge and to draw the reforming deck.
    const shuffleT = this.anim_.shuffle()
    // Fire the shuffle sfx the frame the riffle passes its split phase and the
    // piles start merging — that's where the clip's cascade sound sits (it has no
    // silent lead-in), and the merge is sized to the clip so they end together.
    const merging = shuffleT !== null && shuffleT >= SHUFFLE_SPLIT_FRACTION
    if (merging && !this.shuffleMergingLast_) {
      sfx.play('shuffle')
    }
    this.shuffleMergingLast_ = merging
    // The result just became visible — the resolved/over hand's cards have
    // settled (same gate the Win/Lose label uses). Play the win or loss sting
    // once; the flag resets when the round leaves the resolved/over phases.
    const resolved = this.state_.phase === 'resolved' || this.state_.phase === 'over'
    const revealed = resolved && !this.anim_.isAnimating(timestamp)
    if (revealed && !this.resultRevealed_) {
      this.resultRevealed_ = true
      this.playResultSting_()
      // The reveal just landed (deal animation stopped): re-sync so a deal-time natural's row
      // swaps from the borrowed play buttons to Next hand right now. A winning natural keeps the
      // reward tokens flying past this point (the settle edge won't fire until they land), so
      // without this the play buttons would linger disabled over the revealed blackjack.
      this.syncOverlay_(timestamp)
    }
    if (!resolved) {
      this.resultRevealed_ = false
    }
    const canvas = this.stage_.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    // The Banker's first-double deck fly-in just landed — commit it to the static table (so the
    // deck is visible as the cards deal from it) before drawing this frame. Mirrors the settle's
    // deck commit, but fires as the fly-in ends rather than after the whole deal.
    if (this.codaDeckCommitAt_ > 0 && timestamp >= this.codaDeckCommitAt_) {
      this.codaDeckCommitAt_ = 0
      this.deckColorShift_ = BANKER_SHIFT
      this.spawnIncomingShift_ = null
      this.spawnHasOldDeck_ = false
      this.deckHidden_ = false
      this.paintTable_(canvas, layout, this.tableHasDeck_())
    }
    // The Banker's entry shred just finished — mark the killing hand's cards gone BEFORE this
    // frame's draw, so they don't flash for a frame between the shred ending and being cleared.
    if (this.codaShredEndAt_ > 0 && timestamp >= this.codaShredEndAt_) {
      this.codaShredEndAt_ = 0
      this.endShredDone_ = true
      this.collectRound_ = null
      this.codaEntering_ = false
    }
    // The dealer-6 winning hand has just been revealed (its cards settled) — fade the fight
    // music out to silence. The quiet holds through the Banker's walk-in + shred; the "Decisions"
    // theme (codaDecisionsAt) rises once the shred completes and plays through the prompt.
    if (this.codaMusicFadeAt_ > 0 && timestamp >= this.codaMusicFadeAt_) {
      this.codaMusicFadeAt_ = 0
      music.enterCodaSilence()
    }
    // Heart-death: the final chip has finished popping — now let the dealer walk off and the coda
    // begin (deferred from beginHeartDeathCoda_ so the red X + last pop played first).
    if (this.heartDeathPending_ && timestamp >= this.heartDeathAt_) {
      this.heartDeathPending_ = false
      const e = this.heartDeathEntry_
      this.heartDeathEntry_ = null
      if (e) {
        this.beginCoda_(e.prevScore, e.prevIntegrity, e.prevShift, e.integrity, now())
      }
    }
    // --- Battery-saver render clocks ------------------------------------------------------------
    // Two render clocks so saver mode looks clean instead of half-frozen:
    //  • staticNow — the nexus body + holo rays. A fixed constant whenever saver is on (busy OR idle),
    //    so the nexus is a genuinely STATIC object: it never hovers and never skips on resume. Safe as
    //    a constant because it has no start-stamped state.
    //  • frozenNow — cards, chips, and the dealer FIGURE/eyes. These DO have start-stamped animation
    //    (deals, walk-ins), so they can't use the constant (that would draw them "before" their
    //    walk-in — the dealer would vanish). While idle they hold a RECENT frozen time (static); while
    //    busy they're live.
    // A damaged dealer FULLY PARKS when idle (no idle spark animation — `drawSparks` off while quiet):
    // it sits static, and sparks only fly during hits/strikes, which are busy → full speed. The holo
    // readouts also don't flicker in saver (holoFlicker frozen, see render/cards). Outside saver every
    // clock is the live timestamp and every layer repaints, exactly as before.
    const saver = this.batterySaver_
    const quiet = saver && timestamp - this.lastBusyAt_ > SETTLE_GRACE_MS
    if (!quiet) {
      this.freezeAt_ = timestamp // hold a recent, valid time to freeze stateful draws at while idle
    }
    const staticNow = saver ? SAVER_STATIC_NOW : timestamp
    const frozenNow = quiet ? this.freezeAt_ : timestamp
    // The dealer FIGURE runs on its OWN clock, independent of the cards. It's live only while the dealer
    // is doing something itself — a hit/kill/walk-in (isSequencing/isBlocking) or an emote (a laugh) —
    // and frozen otherwise, EVEN when the cards are being dealt. Without this, dealing a hand (a busy
    // frame) woke a wounded dealer's ambient sparks + eye-flicker, then they refroze — the damage FX
    // looked coupled to the deal. Now the diegetic damage plays only when the dealer is actually
    // attacked. Outside saver the figure is always live (continuous ambient, as before). The `|| timestamp`
    // guards the pre-first-choreography frames (title screen) where dealerFreezeAt_ is still 0.
    const dealerChoreographing =
      this.dealer_.isSequencing(timestamp) || this.dealer_.isEmoting(timestamp) || this.dealer_.isBlocking(timestamp)
    if (!saver || dealerChoreographing) {
      this.dealerFreezeAt_ = timestamp
    }
    const figureNow = this.dealerFreezeAt_ || timestamp
    // Sparks (smoke/spark bursts) fire only while the dealer is under attack (a strike/hit/kill
    // sequence), never during unrelated activity; outside saver they're the continuous health readout.
    const drawSparks = !saver || this.dealer_.isSequencing(timestamp)
    // Dirty-flag gating for the 'cast' + 'nexus' canvases (Stage B): keep them dirty while something
    // on them is animating, else skip the redraw (their last frame persists). 'cast' = dealer/clown
    // figures. In saver it's dirty only while the dealer choreographs (+ one clean redraw the frame
    // AFTER, to settle the resting pose / clear sparks); outside saver its ambient flicker/sparks run
    // every frame (isAnimating). 'nexus' = the device (hovers every frame outside saver → always dirty
    // there; in saver dirty only when the laser/heal fires). play + overlay always redraw (field comment).
    if (
      dealerChoreographing ||
      this.lastDealerChoreographing_ ||
      this.clown_.present(timestamp) ||
      // Normal mode keeps the ambient damage FX (eye-flicker <33% AND sparks/smoke <75%) running every
      // frame — ambientDamageActive is the widest band, so it must be OR'd in (isAnimating alone only
      // covers the <33% flicker + active sequences). Saver deliberately omits this: no idle ambient.
      (!saver && (this.dealer_.isAnimating(timestamp) || this.dealer_.ambientDamageActive(timestamp))) ||
      (!quiet && this.rgbActive_())
    ) {
      this.castDirty_ = true
    }
    this.lastDealerChoreographing_ = dealerChoreographing
    if (this.nexus_.isAnimating(timestamp) || this.nexus_.isHealing(timestamp) || !saver) {
      this.nexusDirty_ = true
    }
    this.updateClown_(timestamp) // state tracking on the live clock; the clown RENDER (in renderCast_) uses figureNow
    if (this.castDirty_) {
      this.renderCast_(canvas, layout, figureNow, drawSparks)
      this.castDirty_ = false
    }
    this.renderPlay_(canvas, layout, frozenNow) // before renderOverlay_ (populates frameProjections_)
    if (this.nexusDirty_) {
      this.renderNexus_(canvas, layout, staticNow, timestamp)
      this.nexusDirty_ = false
    }
    this.renderOverlay_(canvas, layout, staticNow, frozenNow, figureNow)
    // Roll the counter up toward any tokens that just landed (ticks per burst).
    this.updateTokenCounter_(timestamp)
    // Fly-in score deltas reaching their rows: tick the held counter up by each + ping the tone.
    this.landScoreDeltas_(timestamp)
    // Fallback release: a token-less win (a chips-only push earns points but flies no
    // tokens, so nothing lands to trigger the tick above) still ticks once its reward
    // would have arrived.
    if (this.heldScore_ !== null && this.scoreReleaseAt_ > 0 && timestamp >= this.scoreReleaseAt_) {
      this.releaseHeldScore_()
    }
    this.updatePointsCounter_(timestamp)

    const sequenceAnimating =
      this.anim_.isAnimating(timestamp) ||
      this.chips_.isAnimating(timestamp) ||
      this.spawn_.isAnimating(timestamp) ||
      this.bustBlock_.isAnimating(timestamp) ||
      // A dealer's heal beam holds the settle (buttons + result) until it finishes,
      // so the repair always reads in full before the player can call the next hand.
      this.nexus_.isHealing(timestamp) ||
      // A heart popping/healing keeps the settle open too, so its beam finishes before the next deal.
      this.hearts_.isAnimating(timestamp)

    // The card + chip sequence just finished: run the one-time settle. Other systems
    // (the dealer's damage/heal FX and its death choreography) may keep animating past
    // this point — the integrity drop lands after the reveal — but the loop stays alive
    // on the nexus hover below regardless, so they must NOT hold up the settle, or the
    // buttons and next deal would stall behind them.
    if (!sequenceAnimating && this.lastAnimating_) {
      this.raf_ = 0 // let a re-deal's run() → ensureLoop reschedule cleanly
      this.lastAnimating_ = false

      // The opening deal has landed (a hand is on the table): reveal its held-back counts —
      // all together this frame — plus fade the button groups in, and latch, so every later
      // hand's counts show per-card again. (The pre-deal ceremony settle has no round yet, so
      // it never latches early.)
      if (this.state_.round && !this.openingCountsShown_) {
        this.openingCountsShown_ = true
        this.revealOpeningButtons_()
      }

      if (this.deckOnCards_) {
        // Gather + shuffle finished: hand the deck back to the static table layer
        // (unless the RGB dealer keeps it on the cards layer to keep shimmering).
        this.deckOnCards_ = false
        this.paintTable_(canvas, layout, this.tableHasDeck_())
      }
      if (this.spawnIncomingShift_ !== null) {
        // Spawn ceremony finished: the fresh deck has landed + unwrapped. Commit its
        // colour and hand it back to the static table layer (the old deck it flew in
        // over is replaced right where they register, so the swap is unseen).
        this.deckColorShift_ = this.spawnIncomingShift_
        this.spawnIncomingShift_ = null
        this.spawnHasOldDeck_ = false
        this.deckHidden_ = false
        this.paintTable_(canvas, layout, this.tableHasDeck_())
      }
      // Keep the ending round's cards on the felt while a deferred arrival is pending — the
      // dealer's dead and the upgrade selector is up, and those cards are what the new dealer
      // shreds when it walks in (playArrival). Same for the Banker coda entry (codaEntering): he
      // shreds them on arrival (playCodaArrival → codaShredEndAt), NOT here — the settle can fire
      // during the boss death, and clearing them then made the dealt cards despawn before the
      // shred instead of being chewed up. And a WINDOW-OUT walk-off (pendingWindowOut): the survivor
      // strides off and its replacement's shred is deferred to playWindowArrival — the settle fires
      // during the walk-off (spawn hasn't begun yet), and clearing them here left nothing to shred.
      if (!this.pendingCeremony_ && !this.codaEntering_ && !this.pendingWindowOut_) {
        this.collectRound_ = null
      }
      // Settle re-render (the state just changed: counts revealed, collectRound cleared). Repaint the
      // FULL play + overlay groups (cast/nexus keep this frame's earlier paint). renderPlay_ before
      // renderOverlay_ (frameProjections_).
      this.renderPlay_(canvas, layout, timestamp)
      this.renderOverlay_(canvas, layout, timestamp, timestamp, figureNow) // eye glow matches the (possibly frozen) figure
      this.syncOverlay_(timestamp)

      // No Deal button — once the deck is ready, deal the next hand automatically, UNLESS a
      // deferred laser/death is still to play (dealAfter), the opening is still waiting on the
      // tap-to-start (`started`), or a WINDOW-OUT walk-off is mid-flight (pendingWindowOut) — its
      // replacement hasn't walked in + shredded yet, and dealAfter is still 0, so without this guard
      // the deal would fire the instant the chips settle, mid-walk-off, over an empty table.
      if (this.state_.phase === 'betting' && this.dealAfter_ <= timestamp && this.started_ && !this.pendingWindowOut_) {
        this.run_(() => this.session_.deal())
        return
      }
    }

    // Deferred CONSENT: the player pressed Next hand while the resolve choreography (reward → laser
    // → summary reveal) was still playing. It never fast-forwards — it waits here for the gate, then
    // advances. (A click PAST the gate advances immediately in requestNextHand_ and never sets this.)
    // The extra SUMMARY_MIN_HOLD past the reveal gate gives the fully-formed summary a readable beat
    // before the click's fade-out — the courtesy the pre-clicker would otherwise skip past.
    if (this.proceedPending_ && timestamp >= this.resolveAttackEnd_ + SUMMARY_MIN_HOLD && this.state_.phase === 'resolved' && this.started_) {
      this.proceedPending_ = false
      this.raf_ = 0
      this.run_(() => this.session_.nextHand())
      return
    }

    // Deferred deal: the summary fade-out + the card gather (and any walk-in) play after the
    // Next-hand click; only once that finishes do the next cards deal. Also how the OPENING deal
    // is scheduled (startIntroNow sets dealAfter), so `started` holds it until the tap-to-start.
    // (pendingWindowOut can't be set here — playWindowArrival clears it as it sets dealAfter — but
    // the guard keeps the two deal paths symmetric.)
    if (this.dealAfter_ > 0 && timestamp >= this.dealAfter_ && this.state_.phase === 'betting' && !sequenceAnimating && this.started_ && !this.pendingWindowOut_) {
      this.dealAfter_ = 0
      // Zero the raf first (like the settle block) so run() → ensureLoop reschedules
      // the loop — the `return` below skips this frame's own reschedule.
      this.raf_ = 0
      this.run_(() => this.session_.deal())
      return
    }

    // A survived dealer's replacement walks in a beat after the old one has strode off.
    if (this.windowArrivalAt_ > 0 && timestamp >= this.windowArrivalAt_ && this.started_) {
      this.windowArrivalAt_ = 0
      this.playWindowArrival_()
    }
    // The Banker's deferred entrance. Two gates, both required: the boss-gone beat
    // (codaArrivalAt_, the death/laser floor) AND dealer 6's clown having fully walked off
    // screen, plus a short buffer — so the Banker never strides in over the clown's exit.
    if (this.codaArrivalAt_ > 0 && timestamp >= this.codaArrivalAt_ && this.started_) {
      if (this.clown_.present(timestamp)) {
        // Clown still walking off — hold, and keep the buffer unarmed so it counts from the
        // exact frame the clown clears the screen, not from when codaArrivalAt_ was reached.
        this.codaClownClearAt_ = 0
      } else {
        // Clown is gone (or was never on screen): arm the buffer once, then fire when it elapses.
        if (this.codaClownClearAt_ === 0) this.codaClownClearAt_ = timestamp + CODA_CLOWN_CLEAR_MS
        if (timestamp >= this.codaClownClearAt_) {
          this.codaArrivalAt_ = 0
          this.codaClownClearAt_ = 0
          this.playCodaArrival_()
        }
      }
    }
    // Once his entry shred completes (codaDecisionsAt, set in playCodaArrival), the Banker's
    // waiting theme rises out of the quiet — it plays once through the double-or-nothing prompt.
    if (this.codaDecisionsAt_ > 0 && timestamp >= this.codaDecisionsAt_ && this.started_) {
      this.codaDecisionsAt_ = 0
      music.codaDecisions()
    }
    // The Banker coda auto-advances: once a resolved hand's reveal beat passes (or the entry
    // ceremony finishes), codaResolveNext dismisses the killing hand / doubles a win + re-prompts
    // / re-deals a push / ends the run on a loss.
    if (this.codaAdvanceAt_ > 0 && timestamp >= this.codaAdvanceAt_ && !sequenceAnimating && this.started_) {
      this.codaAdvanceAt_ = 0
      this.raf_ = 0
      this.runCoda_(() => this.session_.codaResolveNext())
      return
    }
    // A pushed double-or-nothing hand re-deals with no re-prompt: once the table clears, gamble again.
    if (this.state_.phase === 'coda' && this.state_.codaRedeal && !sequenceAnimating && this.started_) {
      this.raf_ = 0
      this.runCoda_(() => this.session_.codaGamble())
      return
    }

    // The dealer-death pause blocks the buttons via syncOverlay's `animating`, but
    // syncOverlay only runs per-action + on the settle edge — so detect the moment
    // the block clears and re-sync to re-enable the buttons + show the result.
    const dealerBlocking = this.dealer_.isBlocking(timestamp)
    if (this.lastDealerBlocking_ && !dealerBlocking) {
      this.syncOverlay_(timestamp)
    }
    this.lastDealerBlocking_ = dealerBlocking

    // While the choose-upgrade pick is pending, keep the overlay synced every frame
    // so the card surfaces the instant the death settles + its reveal beat passes (and
    // clears the moment a pick releases the deal). The loop already runs for the hover.
    if (this.state_.phase === 'choosing-upgrade') {
      this.syncOverlay_(timestamp)
    }

    // A coda WIN freezes the prompt's Double-or-nothing / Cash-out until the scoreboard settles
    // (codaChoiceReadyAt). Re-sync each frame through that window — plus once more on the unlock
    // edge — so the buttons re-enable the instant it passes; nothing else re-syncs here (the
    // auto-advance already fired and the win's gather has long since settled).
    const codaChoiceLocked = timestamp < this.codaChoiceReadyAt_
    if (codaChoiceLocked || this.lastCodaChoiceLocked_) {
      this.syncOverlay_(timestamp)
    }
    this.lastCodaChoiceLocked_ = codaChoiceLocked

    // Reschedule (reusing `quiet` from the render clocks above). Without battery saver the loop never
    // fully parks — the nexus hover always needs repainting — so it runs at full speed exactly as
    // before. With saver ON, once the scene is quiet we PARK fully (even a damaged dealer — its idle
    // sparks are suppressed), leaving only a ~1fps watchdog that re-runs frame_ to self-heal any
    // missed timer; because everything repaints at the frozen/constant clocks, that re-render is
    // byte-identical (no visible jitter). Any real action wakes us via ensureLoop_.
    if (!quiet) {
      this.raf_ = requestAnimationFrame(this.frame_)
    } else {
      this.raf_ = 0
      this.sleepTimer_ = window.setTimeout(this.wake_, WATCHDOG_MS)
    }
  }

  // The pulse / watchdog timer firing: re-render ONE frame to re-evaluate, but do NOT count as
  // activity (unlike ensureLoop_) — otherwise every timer wake would reset the grace clock and drag
  // the loop back to full speed. frame_ recomputes quiet/pulse from the unchanged lastBusyAt_.
  private readonly wake_ = (): void => {
    this.sleepTimer_ = 0
    if (!this.raf_) {
      this.raf_ = requestAnimationFrame(this.frame_)
    }
  }

  // Whether anything is actively MOVING this frame — the signal the battery-saver grace clock keys
  // off. Built only from reliable, enumerable signals (each animator's own isAnimating, the dealer's
  // transient/emote states, armed STATE-CHANGING timers). It deliberately does NOT enumerate every
  // short cosmetic fade — SETTLE_GRACE_MS holds the loop open well past those. The dealer's
  // low-health AMBIENT (idle sparks/shimmer) is excluded so an idle damaged dealer counts as quiet
  // and the loop fully parks (its idle sparks are suppressed while parked — see drawSparks).
  private busy_(t: number): boolean {
    return (
      this.anim_.isAnimating(t) ||
      this.chips_.isAnimating(t) ||
      this.spawn_.isAnimating(t) ||
      this.bustBlock_.isAnimating(t) ||
      this.tokens_.isAnimating(t) ||
      this.nexus_.isAnimating(t) ||
      this.hearts_.isAnimating(t) ||
      this.mulligan_.isAnimating(t) ||
      this.returnAnim_.isAnimating(t) ||
      this.scoreDeltas_.isMoving(t) || // isMoving, NOT isAnimating: a landed "+N" list HOLDS on screen (drawn) until the next hand, but it's static — it must not pin the loop awake
      this.codaCounters_.isAnimating(t) ||
      this.tokenTicker_.isAnimating(t) ||
      this.scoreTicker_.isAnimating(t) ||
      this.dealer_.isSequencing(t) ||
      this.dealer_.isBlocking(t) ||
      this.dealer_.isEmoting(t) ||
      this.clown_.present(t) ||
      this.dealRevealPending_() ||
      this.deltaEmitted_ < this.deltaPending_.length ||
      this.state_.phase === 'choosing-upgrade' ||
      this.heldScore_ !== null ||
      this.proceedPending_ ||
      this.introHold_ ||
      // A scheduled auto-deal only matters (and only ever fires) while we're in 'betting' waiting for
      // it. dealAfter_ is NOT cleared when the opening deal fires via the settle path, so it holds a
      // stale PAST timestamp through 'playing'/'resolved' — gating on the phase avoids pinning the
      // loop awake forever on that stale value.
      (this.dealAfter_ > 0 && this.state_.phase === 'betting') ||
      this.windowArrivalAt_ > 0 ||
      this.codaArrivalAt_ > 0 ||
      this.codaAdvanceAt_ > 0 ||
      this.heartDeathPending_
    )
  }

  // Flip battery saver at runtime (HUD / title toggle): persist the explicit choice, refresh the
  // toggle chrome, and wake the loop so it takes effect immediately (resumes full-speed ambient
  // when turning off; repaints once when turning on).
  private setBatterySaver_(on: boolean): void {
    this.batterySaver_ = on
    setBatterySaver(on)
    setHoloFlickerStatic(on) // freeze the holo readout flicker while saver is on
    this.syncBatteryToggle_()
    this.ensureLoop_()
  }

  private ensureLoop_(): void {
    // Any wake — an action (run_/runCoda_), resize, tab-focus, or a pulse/watchdog timer firing —
    // counts as fresh activity, so restart the grace clock (keeps a click-triggered fade inside the
    // window) and drop any pending sleep before rescheduling.
    if (this.sleepTimer_) {
      clearTimeout(this.sleepTimer_)
      this.sleepTimer_ = 0
    }
    this.lastBusyAt_ = now()
    // Every action/interaction routes through here (run_/runCoda_ end here too), so a wake is the
    // safety net that marks the dirty-flagged canvases for a redraw — covers any state change that
    // isn't otherwise caught by the per-frame "active" checks (which handle ongoing animations).
    this.castDirty_ = true
    this.nexusDirty_ = true
    if (!this.raf_) {
      this.raf_ = requestAnimationFrame(this.frame_)
    }
  }

  private makeButtons_(): ButtonDef[] {
    const playing = (s: SessionState) => s.phase === 'playing'
    // The action row shown while cards are being dealt: the live play phase, OR a deal-time
    // natural whose reveal is still animating (dealRevealPending) — the latter borrows the play
    // row (disabled) so an instant blackjack's deal-in looks exactly like a normal one until the
    // reveal lands. The buttons are disabled either way while animating (syncOverlay).
    const dealingRow = (s: SessionState) => playing(s) || this.dealRevealPending_()
    // A live coda hand (a double-or-nothing hand dealt and still being played).
    const codaPlaying = (s: SessionState) => s.phase === 'coda' && !!s.round && s.round.status === 'player-turn'
    // Powerups stay put — always visible, just enabled/disabled — so the column
    // never collapses and reflows between hands. Their "only during play"
    // condition lives in `enabled` (via playing()), not `visible`. The contextual
    // ACTION buttons (Hit/Stand/Next/…) still appear per phase.
    const defs: ButtonDef[] = [
      { key: 'hit', label: 'Hit', group: 'action', act: () => this.session_.hit(), visible: dealingRow, enabled: yes },
      { key: 'stand', label: 'Stand', group: 'action', act: () => this.session_.stand(), visible: dealingRow, enabled: yes },
      {
        key: 'double',
        label: 'Double',
        group: 'action',
        act: () => this.session_.double(),
        visible: dealingRow,
        enabled: (s) => !!s.round && canDouble(s.round),
      },
      {
        key: 'split',
        label: 'Split',
        group: 'action',
        act: () => this.session_.split(),
        visible: dealingRow,
        enabled: (s) => !!s.round && canSplit(s.round),
      },
      // Also shown (disabled) through a MAIN-GAME game-over draw-out/shred, so the bottom row looks
      // exactly like any resolving hand — an EMPTY row (no Next hand) would spoil that this was the
      // final hand. It swaps to New run once the score screen shows (scoreRevealed). EXCLUDED for a
      // coda end (`run.coda` — a cash-out or a loss to the Banker): the player deliberately ended
      // the run there, so there's nothing to spoil, and a disabled "Next hand" over the Banker's
      // collect/walk-off just reads as a bug (the action row is simply empty until New run).
      // Held back while a deal-time natural is still revealing (dealRevealPending): the play row
      // shows instead, so the button doesn't pop in early and spoil the instant blackjack.
      { key: 'next', label: 'Next hand', group: 'action', act: () => this.requestNextHand_(), visible: (s) => (s.phase === 'resolved' && !this.dealRevealPending_()) || (this.state_.phase === 'over' && !this.scoreRevealed_ && !this.state_.run.coda), enabled: (s) => s.phase === 'resolved' },
      // Shown only once the game-over sequence has projected the score screen (the cards
      // are sucked up, the dealer destroyed / gone) — not the instant the run ends.
      { key: 'restart', label: 'New run', group: 'action', act: () => this.session_.restart(), visible: () => this.state_.phase === 'over' && this.scoreRevealed_, enabled: yes },
      {
        key: 'analyze',
        label: 'Analyze',
        group: 'power',
        cost: POWERUPS.analyze.cost,
        act: () => this.session_.buyAnalyze(),
        visible: yes,
        // Disabled while a reading is already up (it can't be paid for twice); the
        // button glows via `active` until the player acts and the reading clears.
        enabled: (s) => playing(s) && affords(POWERUPS.analyze.cost, s) && s.analysis === null,
        active: (s) => playing(s) && s.analysis !== null,
      },
      {
        key: 'peek',
        label: 'Peek Dealer',
        group: 'power',
        cost: POWERUPS.peek.cost,
        order: 3, // Bust Block, Mulligan, then Peek Dealer among the 60-cost trio.
        act: () => this.session_.buyPeek(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.peek.cost, s) && !s.peeked,
      },
      {
        key: 'forced-split',
        label: 'Forced split',
        group: 'power',
        cost: POWERUPS['forced-split'].cost,
        act: () => this.session_.buyForcedSplit(),
        // Shares one slot with Late double to save space: shown only in the pre-hit
        // phase (while a free Double is still on the table), hidden the moment the
        // player hits. Disabled — but still shown — when the hand can already be
        // split for free, since paying to force it would be pointless.
        visible: (s) => !!s.round && canDouble(s.round),
        enabled: (s) =>
          playing(s) &&
          affords(POWERUPS['forced-split'].cost, s) &&
          !!s.round &&
          canForcedSplit(s.round) &&
          !canSplit(s.round),
      },
      {
        key: 'late-double',
        label: 'Late double',
        group: 'power',
        cost: POWERUPS['late-double'].cost,
        act: () => this.session_.buyLateDouble(),
        // Hidden while a free Double is still on the table (first two cards) — that
        // slot shows Forced split instead. Appears once the player has hit and the
        // free Double has lapsed.
        visible: (s) => !(s.round && canDouble(s.round)),
        enabled: (s) =>
          playing(s) && affords(POWERUPS['late-double'].cost, s) && !!s.round && !canDouble(s.round),
      },
      {
        key: 'return',
        label: 'Return',
        group: 'power',
        cost: POWERUPS.return.cost,
        act: () => this.session_.buyReturn(),
        visible: yes,
        // Only once the hand has taken a hit (more than two cards) is there a
        // drawn card to push back. Auto-stands, so it also ends the turn.
        enabled: (s) => playing(s) && affords(POWERUPS.return.cost, s) && !!s.round && canReturn(s.round),
      },
      {
        key: 'freeze',
        label: 'Freeze Dealer',
        group: 'power',
        cost: POWERUPS.freeze.cost,
        act: () => this.session_.buyFreezeDealer(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.freeze.cost, s) && !!s.round && !s.round.dealerFrozen,
        active: (s) => playing(s) && !!s.round && s.round.dealerFrozen,
      },
      {
        key: 'second-chance',
        label: 'Bust Block',
        group: 'power',
        cost: POWERUPS['second-chance'].cost,
        order: 1, // Bust Block, Mulligan, then Peek Dealer among the 60-cost trio.
        act: () => this.session_.buySecondChance(),
        visible: yes,
        enabled: (s) =>
          playing(s) && affords(POWERUPS['second-chance'].cost, s) && !!s.round && !s.round.secondChanceArmed,
        active: (s) => playing(s) && !!s.round && s.round.secondChanceArmed,
      },
      {
        key: 'mulligan',
        label: 'Mulligan',
        group: 'power',
        cost: POWERUPS.mulligan.cost,
        order: 2, // Bust Block, Mulligan, then Peek Dealer among the 60-cost trio.
        act: () => this.session_.buyMulligan(),
        visible: yes,
        enabled: (s) => playing(s) && affords(POWERUPS.mulligan.cost, s) && !!s.round && canMulligan(s.round),
      },
      // --- The Banker coda (double-or-nothing) — all routed through runCoda, not run() ---
      { key: 'coda-double', label: 'Double or nothing', group: 'action', coda: true, act: () => this.session_.codaGamble(), visible: (s) => s.phase === 'coda' && !s.round, enabled: yes },
      { key: 'coda-cash', label: 'Cash out', group: 'action', coda: true, act: () => this.session_.codaCashOut(), visible: (s) => s.phase === 'coda' && !s.round, enabled: yes },
      { key: 'coda-hit', label: 'Hit', group: 'action', coda: true, act: () => this.session_.codaHit(), visible: codaPlaying, enabled: yes },
      { key: 'coda-stand', label: 'Stand', group: 'action', coda: true, act: () => this.session_.codaStand(), visible: codaPlaying, enabled: yes },
      {
        key: 'coda-analyze',
        label: 'Analyze',
        group: 'coda-power',
        coda: true,
        cost: CODA_ANALYZE_COST,
        act: () => this.session_.codaAnalyze(),
        visible: codaPlaying,
        enabled: (s) => codaPlaying(s) && s.analysis === null && s.run.tokens >= CODA_ANALYZE_COST,
        active: (s) => s.phase === 'coda' && s.analysis !== null,
      },
      {
        key: 'coda-mulligan',
        label: 'Mulligan',
        group: 'coda-power',
        coda: true,
        cost: CODA_MULLIGAN_COST,
        inflated: true, // 200 base, scaled by the run's token inflation (unlike flat Analyze)
        act: () => this.session_.codaMulligan(),
        visible: codaPlaying,
        enabled: (s) => codaPlaying(s) && !!s.round && canMulligan(s.round) && s.run.tokens >= powerupCost(CODA_MULLIGAN_COST, s.run),
      },
    ]
    // The powerup column reads top-to-bottom in ascending token cost, then by explicit
    // `order` within a cost tie (Bust Block, Mulligan, Peek Dealer at 60). Array.sort is
    // stable, so the action buttons (no cost/order → 0) keep their defined order and their
    // own column, and equal-cost powerups without an `order` (Late double & Forced split at
    // 30) hold source order. Dispatch to columns is by `group`, so sorting the flat list is
    // safe.
    return defs.sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0) || (a.order ?? 0) - (b.order ?? 0))
  }

  private buildOverlay_(): void {
    const tokens = this.buildTokenCounter_()
    const points = this.buildPointsCounter_()
    this.messageEl_ = element('div', 'hud-message')
    const powers = element('div', 'hud-powerups')
    const actions = element('div', 'hud-actions')
    const codaPowers = element('div', 'hud-coda-powers')
    this.powersEl_ = powers
    this.actionsEl_ = actions

    this.buttons_ = {}
    this.costPills_ = {}
    for (const def of this.defs_) {
      const button = document.createElement('button')
      button.classList.add(`hud-btn-${def.key}`) // per-button hook for CSS (e.g. a wide Next hand)
      if (def.cost === undefined) {
        button.textContent = def.label
      } else {
        // Powerups: the name on the button, the token cost in a pill pinned to
        // the bottom-right corner. Track the number span so syncOverlay can rewrite
        // it to the inflated price each frame.
        const label = element('span', 'power-label')
        label.textContent = def.label
        const pill = costPill(def.cost)
        // A lock pill (red ✕) sits in the same corner, hidden until the Dealer 6 duel
        // locks abilities — CSS swaps it in for the cost pill via the button's is-locked.
        button.append(label, pill, lockPill())
        const num = pill.querySelector('.cost-pill__num')
        if (num) {
          this.costPills_[def.key] = num as HTMLElement
        }
      }
      button.addEventListener('click', () => {
        // A powerup click fires the ability cue (and, as the first user gesture,
        // resumes the audio context). Move buttons make no sound — it's masked by
        // the card-draw sfx anyway.
        if (def.group === 'power' || def.group === 'coda-power') {
          sfx.play('ability')
        }
        // Coda buttons drive the stripped coda handler; everything else the main one.
        if (def.coda) {
          this.runCoda_(def.act)
        } else {
          this.run_(def.act)
        }
      })
      this.buttons_[def.key] = button
      const column = def.group === 'power' ? powers : def.group === 'coda-power' ? codaPowers : actions
      column.appendChild(button)
    }

    // The info button sits in the bottom-left corner (fixed via CSS); pressing it toggles
    // the nexus's spec-sheet projection.
    this.infoBtnEl_ = this.buildInfoButton_()

    // The battery-saver toggle stacks just above the info button (same bottom-left corner).
    this.batteryBtnEl_ = this.buildBatteryButton_()
    this.syncBatteryToggle_() // reflect the initial (per-device default or stored) state

    // The help button ("H") rides at the BOTTOM of the powerup column (appended last, so
    // flexbox keeps it right under whichever ability button is currently the lowest visible
    // one — the stack's height changes as powerups show/hide). Opens the ability-guide modal.
    this.helpBtnEl_ = this.buildHelpButton_()
    powers.appendChild(this.helpBtnEl_)
    this.helpPanelEl_ = this.buildHelpPanel_()

    // The choose-upgrade card sits above the columns (appended last), shown only
    // during the choosing-upgrade phase once the dealer's death settles.
    this.stage_.overlay.append(tokens, points, this.infoBtnEl_, this.batteryBtnEl_, this.messageEl_, powers, actions, codaPowers, this.buildScorePager_(), this.buildUpgradePanel_(), this.helpPanelEl_)

    // While the spec sheet is projected, a click or touch ANYWHERE dismisses it — except
    // on the info button itself, whose own click handler toggles it. pointerdown fires
    // before the button's click, and specShownAt is only set on that click, so the tap
    // that OPENS the sheet never immediately closes it.
    this.stage_.container.addEventListener('pointerdown', (e) => {
      if (this.specShownAt_ !== null && e.target instanceof Node && !this.infoBtnEl_.contains(e.target)) {
        this.dismissSpec_()
      }
    })
  }

  // The info button: a small circular "i" pinned to the left of the dealer's head. A
  // click toggles the nexus spec-sheet projection (the ruleset + token inflation).
  private buildInfoButton_(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'hud-info'
    btn.textContent = 'i'
    btn.title = 'Show the dealer ruleset + energy inflation'
    btn.setAttribute('aria-label', 'Show the dealer ruleset and energy inflation')
    btn.addEventListener('click', () => this.toggleSpec_())
    return btn
  }

  // The battery-saver toggle: a round twin of the info "i", stacked just above it in the bottom-left
  // utility corner. position:absolute keeps it out of every layout flow; measureControlColumn_
  // reserves for it explicitly so it never collides with the powerup column on short screens.
  private buildBatteryButton_(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'hud-battery'
    btn.type = 'button'
    btn.textContent = '🔋'
    btn.addEventListener('click', () => this.setBatterySaver_(!this.batterySaver_))
    return btn
  }

  // The battery-saver toggle shown on the title / tap-to-start screen (the in-game HUD uses the round
  // button above). A pill appended INTO the title menu or tap catcher, so it's removed with them; on
  // the catcher it stops its own taps from also firing tap-to-start.
  private buildSaverToggle_(): HTMLButtonElement {
    const btn = element('button', 'title-saver') as HTMLButtonElement
    btn.type = 'button'
    btn.setAttribute('role', 'switch')
    btn.addEventListener('pointerdown', (e) => e.stopPropagation())
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setBatterySaver_(!this.batterySaver_)
    })
    this.saverToggleEl_ = btn
    this.syncBatteryToggle_()
    return btn
  }

  // Reflect the current battery-saver state on both surfaces: the round HUD button and (when shown)
  // the title-screen pill. Called at build time and on every toggle.
  private syncBatteryToggle_(): void {
    const on = this.batterySaver_
    if (this.batteryBtnEl_) {
      this.batteryBtnEl_.classList.toggle('is-active', on)
      this.batteryBtnEl_.setAttribute('aria-pressed', String(on))
      const label = on ? 'Battery saver: on' : 'Battery saver: off'
      this.batteryBtnEl_.setAttribute('aria-label', label)
      this.batteryBtnEl_.title = label
    }
    // NOT gated on isConnected: buildSaverToggle_ calls this BEFORE the pill is appended, so the
    // initial label/state must still be set (else it renders as a tiny empty pill until first click).
    // saverToggleEl_ is nulled when the pill is removed, so a non-null ref is always the live pill.
    const pill = this.saverToggleEl_
    if (pill) {
      pill.classList.toggle('is-on', on)
      pill.setAttribute('aria-checked', String(on))
      pill.textContent = `Battery saver: ${on ? 'ON' : 'OFF'}`
    }
  }

  // The help button: a small circular "?" at the bottom of the powerup column. A click opens
  // the full-screen ability guide; a tap anywhere on that guide closes it (see buildHelpPanel_).
  private buildHelpButton_(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'hud-help'
    btn.textContent = '?'
    btn.title = 'What each ability does'
    btn.setAttribute('aria-label', 'Show what each ability does')
    btn.addEventListener('click', () => this.openHelp_())
    return btn
  }

  // The ability-guide modal: a full-screen panel listing every ability with a terse one-liner,
  // packed to fit on one screen (even on mobile). It starts hidden; openHelp_ reveals it, and a
  // pointerdown ANYWHERE on the panel dismisses it (it covers the whole screen, so any tap lands
  // on it). sfx mirrors the spec sheet's projector cue.
  private buildHelpPanel_(): HTMLElement {
    const panel = element('div', 'help-panel is-hidden')
    const card = element('div', 'help-panel__card')
    const title = element('div', 'help-panel__title')
    title.textContent = 'ABILITIES'
    card.appendChild(title)
    const list = element('div', 'help-panel__list')
    for (const { name, desc } of ABILITY_HELP) {
      const row = element('div', 'help-panel__row')
      const term = element('span', 'help-panel__name')
      term.textContent = name
      const detail = element('span', 'help-panel__desc')
      detail.textContent = desc
      row.append(term, detail)
      list.appendChild(row)
    }
    card.appendChild(list)
    const hint = element('div', 'help-panel__hint')
    hint.textContent = 'tap anywhere to close'
    card.appendChild(hint)
    panel.appendChild(card)
    // Dismiss on CLICK, not pointerdown. Hiding the panel on pointerdown removes it
    // before iOS dispatches the follow-up click, so that click falls through to whatever
    // button sat beneath the modal and fires it too. Closing on click keeps the panel
    // (topmost, full-screen) as the event's target, so nothing underneath ever sees it.
    // The pointerdown handler only stops the press leaking to the stage container behind
    // (spec-sheet dismiss / table); the CSS gives the panel cursor:pointer so iOS reliably
    // fires the click on this non-interactive div.
    panel.addEventListener('pointerdown', (e) => e.stopPropagation())
    panel.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeHelp_()
    })
    return panel
  }

  // Reveal the ability guide. Opened on the help button's `click`, which completes before any
  // fresh pointerdown reaches the now-visible panel, so the opening tap never self-closes it.
  private openHelp_(): void {
    this.helpPanelEl_.classList.remove('is-hidden')
    sfx.play('ability')
  }

  private closeHelp_(): void {
    this.helpPanelEl_.classList.add('is-hidden')
    sfx.play('ability') // same projector cue as opening it (and as the info spec sheet's toggle)
  }

  // The final scoreboard's page controls: a ‹ back arrow, a two-dot page indicator, and a ›
  // forward arrow, in a row anchored just below the summary band (positioned in syncScorePager).
  // Hidden until the board is revealed. Flipping a page only swaps which readout buildScore_
  // returns — the always-running render loop repaints the holo board on the next frame.
  private buildScorePager_(): HTMLElement {
    const pager = element('div', 'hud-score-pager is-hidden')
    const prev = element('button', 'hud-score-pager__btn hud-score-pager__btn--prev') as HTMLButtonElement
    prev.type = 'button'
    prev.textContent = '‹'
    prev.setAttribute('aria-label', 'Previous page')
    const dots = element('div', 'hud-score-pager__dots')
    for (let i = 0; i < SCORE_PAGES; i += 1) {
      dots.appendChild(element('span', 'hud-score-pager__dot'))
    }
    const next = element('button', 'hud-score-pager__btn hud-score-pager__btn--next') as HTMLButtonElement
    next.type = 'button'
    next.textContent = '›'
    next.setAttribute('aria-label', 'Next page')
    for (const btn of [prev, next]) {
      // Keep a page tap from bubbling to the stage's pointerdown (which dismisses the spec sheet).
      btn.addEventListener('pointerdown', (e) => e.stopPropagation())
    }
    prev.addEventListener('click', () => this.flipScorePage_(-1))
    next.addEventListener('click', () => this.flipScorePage_(1))
    pager.append(prev, dots, next)
    this.scorePagerEl_ = pager
    this.scorePrevBtn_ = prev
    this.scoreNextBtn_ = next
    this.scoreDotsEl_ = dots
    return pager
  }

  // Step the scoreboard page (clamped to the two pages) and refresh the pager chrome; the board
  // itself rebuilds from scorePage_ on the next frame.
  private flipScorePage_(delta: number): void {
    const page = Math.max(0, Math.min(SCORE_PAGES - 1, this.scorePage_ + delta))
    if (page === this.scorePage_) {
      return
    }
    this.scorePage_ = page
    this.syncScorePager_()
    this.ensureLoop_() // the score board redraws from scorePage_ next frame — wake if parked
  }

  // Show/position the page pager and reflect the current page. Called on every overlay sync, on
  // resize, and on a page flip. The pager anchors to scoreBoardPlacement().pagerY — the slot the
  // board reserves just beneath itself — which is page-independent (placed off the taller page), so
  // it never shifts as the two pages' differing row counts change the board's height. Centred under
  // the board (matching its slight left shift on the coda-ending boards). Position is written only
  // when it changes, like the counters, so a settled screen isn't rewriting layout each sync.
  private syncScorePager_(): void {
    if (!this.scorePagerEl_) {
      return
    }
    const visible = this.state_.phase === 'over' && this.scoreRevealed_
    this.scorePagerEl_.classList.toggle('is-hidden', !visible)
    if (!visible) {
      return
    }
    this.scorePrevBtn_.disabled = this.scorePage_ <= 0
    this.scoreNextBtn_.disabled = this.scorePage_ >= SCORE_PAGES - 1
    const dots = this.scoreDotsEl_.children
    for (let i = 0; i < dots.length; i += 1) {
      ;(dots[i] as HTMLElement).classList.toggle('is-active', i === this.scorePage_)
    }
    const layout = computeLayout(this.stage_.canvas.width, this.stage_.canvas.height)
    const cx = layout.width / 2 - (this.state_.run.coda ? Math.min(layout.width, layout.height) * SCORE_LEFT_SHIFT : 0)
    const top = scoreBoardPlacement(layout).pagerY
    const pos = `${Math.round(cx)},${Math.round(top)}`
    if (pos !== this.lastPagerPos_) {
      this.scorePagerEl_.style.left = `${cx}px`
      this.scorePagerEl_.style.top = `${top}px`
      this.lastPagerPos_ = pos
    }
  }

  // Toggle the nexus spec-sheet projection on or off, arming its flicker-in / -out.
  private toggleSpec_(): void {
    const t = now()
    if (this.specShownAt_ !== null) {
      this.specHideStart_ = t // flicker out from full
      this.specShownAt_ = null
    } else {
      this.specShownAt_ = t // flicker in
      this.specHideStart_ = null
    }
    this.infoBtnEl_.classList.toggle('is-active', this.specShownAt_ !== null)
    // Give the readout the whole felt: hide the powerup + action columns while it's up
    // (they'd otherwise crowd it on narrow/mobile layouts). Restored when it's dismissed.
    this.applyHudColumns_(this.state_)
    sfx.play('ability') // the nexus powering up its projector
    this.ensureLoop_()
  }

  // Fade the spec sheet out if it's up — any real game action dismisses it, so it never
  // lingers over a live hand.
  private dismissSpec_(): void {
    if (this.specShownAt_ !== null) {
      this.specHideStart_ = now()
      this.specShownAt_ = null
      this.infoBtnEl_.classList.remove('is-active')
      this.applyHudColumns_(this.state_) // bring the button columns back
      this.ensureLoop_() // wake so the flicker-out repaints even if the loop had parked
    }
  }

  // Show/hide the powerup + action button columns and the info button. Both columns hide
  // while the choose-upgrade card is up (its modal owns the screen) or the spec sheet is
  // projected (the readout wants the full felt). On the GAME-OVER SCREEN the powerups + info
  // button hide too (no abilities to use, nothing to inspect) — but NOT until the score
  // screen actually shows (`scoreRevealed`): the phase flips to 'over' the instant the final
  // hand resolves, and hiding then would drop the buttons while the dealer is still drawing
  // out (spoiling the outcome). Until then they stay visible-but-disabled, like any resolving
  // hand. The actions column always stays so the New-run button can appear.
  private applyHudColumns_(s: SessionState): void {
    // Gate on the card being SHOWN (`upgradeShown`), not the raw `choosing-upgrade` phase:
    // the phase flips the instant a kill resolves, but the card is deferred until the
    // dealer's death settles — hiding on the phase would yank the columns away mid-death
    // (jarring), so instead they stay visible-but-disabled through the death and vanish as
    // the card slides in.
    const modal = this.upgradeShown_ || this.specShownAt_ !== null
    const over = s.phase === 'over' && this.scoreRevealed_
    this.powersEl_.classList.toggle('is-hidden', modal || over)
    this.actionsEl_.classList.toggle('is-hidden', modal)
    // The top-right score counter hides for the whole Banker coda: the score is locked in by then
    // (the coda only stakes it double-or-nothing), so the corner readout is redundant there — the
    // stake panel already shows the number in play. It returns on the game-over score screen.
    this.pointsEl_.classList.toggle('is-hidden', s.phase === 'coda')
    // The info button rides with the Hit/Stand prompt ONLY — visible while the player has a live
    // hand to act on (main play, or a coda double-or-nothing hand at player-turn), or while its own
    // spec sheet is still open (so it can be toggled off). Hidden between rounds, at the betting
    // wait, on the coda offer / scoreboards, and at game over.
    const inPlay = s.phase === 'playing' || (s.phase === 'coda' && !!s.round && s.round.status === 'player-turn')
    this.infoBtnEl_.classList.toggle('is-hidden', !(inPlay || this.specShownAt_ !== null))
    // The help button lives INSIDE the main powerup column, so it only belongs in normal play:
    // during the coda that column is dormant (its powerups collapse) but stays mounted at the
    // same top-left spot as the coda ability column, which paints over it — so a coda-visible
    // help button would flash behind the coda abilities. Normal play only, hidden behind modals.
    this.helpBtnEl_.classList.toggle('is-hidden', s.phase !== 'playing' || modal)
  }

  // The choose-upgrade card: a title and one big coloured button per upgrade path,
  // each showing the effect it would unlock next. A maxed path's button is hidden.
  // Clicking picks the upgrade (session.chooseUpgrade) and releases the held deal.
  private buildUpgradePanel_(): HTMLElement {
    const panel = element('div', 'upgrade-panel is-hidden')
    const title = element('div', 'upgrade-panel__title')
    title.textContent = 'Choose:'
    const row = element('div', 'upgrade-panel__row')
    this.upgradeButtons_ = UPGRADE_PATHS.map((info) => {
      const btn = document.createElement('button')
      btn.className = `upgrade-btn upgrade-btn--${info.path}`
      btn.style.setProperty('--upgrade-color', info.color)
      btn.style.setProperty('--upgrade-glow', info.glow)
      const icon = document.createElement('img')
      icon.className = 'upgrade-btn__icon'
      icon.src = UPGRADE_ICONS[info.path]
      icon.alt = info.name // the path name still reaches screen readers
      const effectEl = element('span', 'upgrade-btn__effect')
      // The tier being offered (1, 2, or 3), pinned to the button's top-right corner so the
      // player can see how deep this path already runs. Text set per-frame in syncUpgradePanel.
      const tierEl = element('span', 'upgrade-btn__tier')
      tierEl.setAttribute('aria-hidden', 'true') // decorative; the effect text conveys the tier
      btn.append(icon, effectEl, tierEl)
      btn.addEventListener('click', () => this.pickUpgrade_(info, btn))
      row.appendChild(btn)
      return { info, btn, effectEl, tierEl }
    })
    panel.append(title, row)
    this.upgradeEl_ = panel
    return panel
  }

  // A path button was clicked: play the dismiss animation (darkness + title fade,
  // the unselected buttons snap away, the chosen button fades while scaling up) and
  // only commit the pick — which releases the held deal and starts the next dealer's
  // walk-in — once it finishes. Guarded so a second click mid-animation is ignored.
  private pickUpgrade_(info: UpgradePathInfo, btn: HTMLButtonElement): void {
    if (this.upgradeDismissing_) {
      return
    }
    sfx.play('upgrade-selected')
    this.upgradeDismissing_ = true
    btn.classList.add('is-chosen')
    this.upgradeEl_.classList.add('is-dismissing')
    window.setTimeout(() => {
      // Commit first: this flips to `betting`, and syncOverlay hides the card
      // (is-hidden → visibility:hidden), so dropping the animation classes next is
      // invisible. Clearing the flag before run() lets syncUpgradePanel hide it.
      this.upgradeDismissing_ = false
      this.run_(() => this.session_.chooseUpgrade(info.path))
      this.upgradeEl_.classList.remove('is-dismissing')
      btn.classList.remove('is-chosen')
    }, UPGRADE_DISMISS_MS)
  }

  // The player's token counter (icon + count), pinned top-left. The icon <img>
  // is created once here so it loads a single time; syncOverlay only rewrites the
  // count text.
  private buildTokenCounter_(): HTMLElement {
    const el = element('div', 'hud-tokens')
    this.tokensEl_ = el // measured each frame so reward tokens can fly into it
    this.tokenCountEl_ = element('span', 'hud-tokens__count')
    el.append(powerIcon('hud-tokens__icon'), this.tokenCountEl_)
    return el
  }

  // The arcade points counter, pinned top-right: the rolling number (swelled while it
  // ticks) with the "+N" reward delta flashing just beneath it. Only the number swells;
  // the delta is a sibling, so it isn't dragged by the count's swell transform.
  private buildPointsCounter_(): HTMLElement {
    const el = element('div', 'hud-points')
    this.pointsEl_ = el
    this.pointsRowEl_ = element('div', 'hud-points__row')
    this.pointsCountEl_ = element('div', 'hud-points__count')
    // Star TRAILS the number as its points unit ("512,000 ★") — matches the coda banner, and
    // pins the icon at the outer top-right corner (mirroring the token icon at the top-left).
    this.pointsRowEl_.append(this.pointsCountEl_, starIcon('hud-points__star'))
    this.pointsDeltaEl_ = element('div', 'hud-points__delta')
    el.append(this.pointsRowEl_, this.pointsDeltaEl_)
    return el
  }

  private run_(mutate: () => void): void {
    // Any game action closes the spec projection so it never hangs over a live hand.
    this.dismissSpec_()
    const prevPhase = this.state_.phase
    const prevRound = this.state_.round
    const prevRun = this.state_.run // pre-resolve snapshot (for the per-green-check score deltas)
    const prevTokens = this.state_.run.tokens
    const prevScore = this.state_.run.score
    const prevIntegrity = this.state_.run.integrity
    const prevShift = this.state_.run.shiftIndex
    const prevHandLog = this.state_.run.handLog
    const prevKillsLen = this.state_.run.kills.length
    const prevAnalysis = this.state_.analysis
    mutate()
    this.state_ = this.session_.snapshot()
    // Latch a deal-time natural: a hand that went straight from 'betting' to 'resolved' with no
    // player turn (a natural blackjack — the player's OR the dealer's). Its reveal is still to
    // animate, and dealRevealPending() uses this to keep the disabled play buttons up over the
    // flip instead of the Next-hand button, so a normal deal and an instant blackjack look
    // identical until the reveal settles. Every other action resets it (never 'betting' here).
    this.dealNatural_ = prevPhase === 'betting' && this.state_.phase === 'resolved'
    // Action-driven angry emotes (freeze used, a lucky risky hit): fired here off the
    // before/after diff, while the dealer stands mid-hand. Resolution-driven ones live in
    // playResultSting instead.
    this.checkAngryAction_(prevRound, prevPhase)
    // A hand just started (cards dealing) with the player shoved all-in vs a healthy table:
    // the dealer laughs.
    this.checkDealLaugh_(prevRound)
    const { integrity, shiftIndex } = this.state_.run

    const t = now()
    // Capture the dealer hand-summary the moment a hand resolves: this hand's win/loss slots appended
    // to the prior log, padded to the dealer's window; a kill fills the remainder green (the cash-in).
    // `appearAt`/`cashInAt` are stamped LATER (in the token/laser block) once the laser timing is
    // known — the summary follows the attack on a win, the card-settle on a loss.
    // A heart-death jumps straight to 'coda' (never 'resolved'), but the losing hand still gets a
    // summary board so its red X shows before the final pop + walk-off (see beginHeartDeathCoda_).
    const heartDeathSummary = this.state_.phase === 'coda' && this.state_.run.hitPoints <= 0 && prevPhase !== 'coda'
    if (((this.state_.phase === 'resolved' && prevPhase !== 'resolved') || heartDeathSummary) && this.state_.round) {
      const killed = this.state_.run.kills.length > prevKillsLen
      const summaryShift = shiftIndex > prevShift ? prevShift : shiftIndex
      const maxHands = getShift(summaryShift).maxHands
      // WINDOW CLAMP (matches applyRound / winPointDeltas): a hand can't fill more of the window than
      // remains, so a double on the last open slot lands ONE green check, not two.
      const remaining = Math.max(0, maxHands - prevHandLog.length)
      const thisHand = (roundTally(this.state_.round).slots as SummarySlot[]).slice(0, remaining)
      if (thisHand.length === 0) {
        // An all-push round is a WASH (it redeals) — it lands no slot, so there's nothing new to
        // show. Skip the summary entirely rather than flash an unchanged board.
        this.summary_ = null
      } else {
        const played: SummarySlot[] = [...prevHandLog, ...thisHand]
        if (killed) {
          while (played.length < maxHands) {
            played.push('win')
          }
        }
        const slots: SummarySlot[] = []
        for (let i = 0; i < maxHands; i += 1) {
          slots.push(played[i] ?? 'empty')
        }
        this.summary_ = { slots, revealFrom: prevHandLog.length, playedCount: thisHand.length, appearAt: 0, cashInAt: 0 }
      }
      this.summaryFadeAt_ = 0
      this.proceedPending_ = false // a fresh resolve starts with no armed consent
    }
    // Stamp when a fresh reading appears (flicker ramps in from here), or start the
    // flicker-out when one is dismissed (retain it so it can die gracefully).
    if (this.state_.analysis && !prevAnalysis) {
      this.analysisStart_ = t
      this.analysisFadeOut_ = null
    } else if (!this.state_.analysis && prevAnalysis) {
      this.analysisFadeOut_ = prevAnalysis
      this.analysisFadeStart_ = t
    }
    // The upgrade was just chosen (choosing-upgrade → betting): the dealer's already
    // dead and gone; now the deferred arrival ceremony — walk-in + shred + fresh deck —
    // plays, then the next hand deals. Handled on its own since there's no round change.
    if (prevPhase === 'choosing-upgrade' && this.pendingCeremony_) {
      this.playArrival_(t)
      this.syncOverlay_(t)
      this.lastAnimating_ = this.anim_.isAnimating(t) || this.chips_.isAnimating(t) || this.spawn_.isAnimating(t)
      this.ensureLoop_()
      return
    }
    // Enter this block on a round-clearing transition (Next hand, or a losing/coda-bust hand) AND
    // on a New run restart from game-over — which can arrive with NO prior round: a Banker-coda
    // CASH OUT ends at the prompt (round already null), so `prevRound` is null there. Gating on
    // `prevRound` alone skipped the whole reset on a cash-out, leaving the dealer un-spawned, no
    // deal queued, and a stale collectRound_ painting a ghost "bet" once run.coda clears.
    if ((prevRound || prevPhase === 'over') && !this.state_.round) {
      // Next hand called: settle the deferred chips now (winners collect, losers pay
      // the house). What follows depends on whether the DEALER CHANGES. A same-dealer
      // hand gathers the spent cards back into the deck + riffles; a dealer SPAWN — a
      // kill, or a New run's reset — instead shreds the old cards into the new
      // dealer's mouth and flies in a fresh shrink-wrapped deck (the ceremony).
      this.summaryFadeAt_ = t // the hand-summary fades out as the player calls the next hand
      // Everything the click sets in motion (gather / walk-off / walk-in) waits for that fade-out to
      // finish first — the table clears only once the summary has gone (the laser already fired on
      // the resolve, so there's none left to wait on).
      const summaryFadeEnd = t + SUMMARY_FADE_MS
      this.proceedPending_ = false // consent consumed (the loop may have armed it)
      this.collectRound_ = prevRound
      // A cash-out restart has no hand on the table (prevRound null) — no bet chips to sweep, and
      // chips.clear(null) would throw — so only settle chips when a round actually resolved.
      if (prevRound) {
        this.chips_.clear(prevRound, t)
      }
      // The win tokens were already awarded on the resolve (they flew in as the hand settled).
      // A New run (from 'over') just drops the withheld final reward.
      this.heldTokens_ = 0
      // The reward "+base ×mult" delta holds (no fade) until THIS moment — the player
      // clicked Next hand — so clear it now. Also drop any reward that hadn't flashed yet
      // (a fast click before its tokens landed): release the held score to the total so the
      // counter isn't stuck, without a late flash bleeding into the next hand.
      this.pointsDeltaEl_.classList.remove('is-flashing', 'is-flashing-coda')
      this.heldScore_ = null
      this.pendingScoreDelta_ = 0
      this.pendingMult_ = 1
      this.scoreReleaseAt_ = 0
      // The fly-in deltas have all landed by now (the consent gate waited them out), so the counter
      // already reads run.score — drop the hold and fade the settled "+N" list away as the hand clears.
      this.deltaHoldBase_ = null
      this.deltaLandedSum_ = 0
      this.deltaPending_ = []
      this.deltaEmitted_ = 0
      this.scoreDeltas_.clear(t)

      const isKill = !!this.pendingAttack_ && prevPhase === 'resolved' && this.pendingAttack_.kind === 'kill'
      const isWindowOut = !!this.pendingAttack_ && prevPhase === 'resolved' && this.pendingAttack_.kind === 'windowOut'
      const newRun = prevPhase === 'over'
      const ceremony = isKill || isWindowOut || newRun

      if (!ceremony) {
        // Same dealer: move the deck onto the cards layer so the gather + riffle can
        // slide + split it. A ceremony instead keeps the old deck on the static table
        // until the fresh one lands over it, so its colour swap stays hidden.
        this.deckOnCards_ = true
        const canvas = this.stage_.canvas
        this.paintTable_(canvas, computeLayout(canvas.width, canvas.height), false)
      }
      // A New run zeroes the count: snap it rather than dramatically rolling the whole
      // balance down (a full reset isn't a "spend").
      if (newRun) {
        this.tokenTicker_.set(this.displayedTokens_(t))
        // If the last run ended on a coda end sting (bust or cash out) the soundtrack is on that
        // sting / its trailing silence — fade it out and bring a normal dealer track back in
        // (no-op after a normal game-over, which keeps its current track). Dealer 1's walk-in
        // doesn't advance the music, so this is what restores it.
        music.resumeAfterEnd()
        // The fresh run zeroes the score: clear any held reward + flash and snap the
        // counter to 0 rather than rolling the whole total down.
        this.heldScore_ = null
        this.pendingScoreDelta_ = 0
        this.pendingMult_ = 1
        this.scoreReleaseAt_ = 0
        this.deltaHoldBase_ = null
        this.deltaLandedSum_ = 0
        this.deltaPending_ = []
        this.deltaEmitted_ = 0
        this.scoreDeltas_.reset() // wipe any lingering "+N" list with no fade
        this.pointsDeltaEl_.classList.remove('is-flashing', 'is-flashing-coda')
        this.scoreTicker_.set(this.displayedScore_())
        // Clear any coda winnings-counter state from the prior run (a fresh run has no pot
        // until it reaches the Banker again; reveal() re-arms the animation there).
        this.codaWins_ = 0
        this.codaCrystalValue_ = 0
        this.codaChoiceReadyAt_ = 0
        this.windowArrivalAt_ = 0
        this.pendingWindowOut_ = null
        // A fresh run refills the hearts and drops any pending heart-death entry from the last run.
        this.hearts_.sync(this.state_.run.hitPoints)
        this.heartDeathPending_ = false
        this.heartDeathEntry_ = null
      }

      if (isWindowOut && prevRound) {
        // The dealer survived its whole WINDOW — it strides OFF (no laser, no death); the replacement
        // walks in behind it, deferred to windowArrivalAt_ so the old figure keeps its colour through
        // the walk-off. The walk-off waits for the summary to clear; the resting cards (collectRound)
        // wait for the new dealer's shred.
        const pa = this.pendingAttack_!
        this.pendingAttack_ = null
        this.dealer_.walkOff(summaryFadeEnd)
        this.pendingWindowOut_ = { incomingShift: pa.toShift, incomingIntegrity: pa.toIntegrity }
        this.windowArrivalAt_ = summaryFadeEnd + KILL_ARRIVE_MS + WINDOW_WALKIN_DELAY
        this.dealAfter_ = 0 // the deal waits for the walk-in
      } else if (this.pendingAttack_ && prevPhase === 'resolved' && prevRound) {
        // A win — the laser + damage/shatter ALREADY fired on the resolve. The click only advances
        // the table, and only once the summary has faded out.
        this.pendingAttack_ = null
        if (isKill) {
          // The dealer already SHATTERED on the resolve laser; its cards rest for the replacement to
          // shred. The replacement's walk-in is deferred — held in pendingCeremony (+ collectRound).
          // The state already advanced to the new dealer, so shiftIndex/integrity ARE the incoming.
          this.pendingCeremony_ = { prevRound, incomingShift: shiftIndex, incomingIntegrity: integrity }
          if (this.state_.phase === 'choosing-upgrade') {
            // An upgrade to pick: reveal the selector AFTER the summary fades out (over the empty
            // table), and walk the replacement in on the pick (playArrival, above).
            this.upgradeRevealAt_ = summaryFadeEnd + UPGRADE_REVEAL_LEAD
            this.dealAfter_ = 0 // the deal waits for the pick, not a timestamp
          } else {
            // No upgrade (every path maxed): the replacement walks in, its mouth shreds the old
            // cards + a fresh wrapped deck flies in (playArrival, the same path a pick takes). Its
            // CEREMONY_LEAD (800ms) outlasts the summary's fade, so the board clears first.
            this.playArrival_(t)
          }
        } else {
          // Same dealer, just damaged: once the summary clears, gather the cards back + riffle.
          this.anim_.collect(prevRound, summaryFadeEnd + GATHER_GAP)
          this.dealAfter_ = this.anim_.animEnd
        }
      } else if (newRun) {
        // A New run: the fresh run's opening dealer walks in and presents a new deck. The
        // old run's table cards were already shredded at game over, so there are none left
        // to chew — clear collectRound (beginSpawn then shreds only the resting deck), and
        // reset the game-over state so the fresh run starts clean. No laser (no attack).
        this.pendingAttack_ = null
        this.collectRound_ = null
        this.endShredDone_ = false
        this.scoreRevealAt_ = 0
        this.scoreRevealed_ = false
        this.dealer_.setLevel(integrity, shiftIndex)
        this.dealer_.setShift(shiftIndex)
        this.dealer_.spawn(t) // a standalone walk-in (no preceding death)
        // The old run's cards + deck were already shredded at game over — shred nothing,
        // just fly the fresh deck in.
        this.dealAfter_ = this.beginSpawn_(shiftIndex, t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP, false)
      } else if (prevRound) {
        // No attack (a losing/pushing hand): once the summary clears, gather the cards back in.
        // Refresh the health + dealer state now (a heal already played its beam on the resolve).
        // (Reached only with a round in hand — a round-less restart always took the `newRun` branch
        // above; the guard narrows for TS.)
        this.anim_.collect(prevRound, summaryFadeEnd)
        this.pendingAttack_ = null
        this.dealAfter_ = 0
        this.dealer_.sync(prevIntegrity, prevShift, integrity, shiftIndex, t)
      }
    } else {
      if (this.state_.round) {
        this.collectRound_ = null
      }
      const round = this.state_.round
      const ai = prevRound ? prevRound.activeIndex : 0
      // Return pops the most-recently-drawn card off the active hand (one fewer
      // card than before) and auto-stands — the only action that REMOVES a card.
      const returned =
        prevPhase === 'playing' &&
        !!prevRound &&
        !!round &&
        prevRound.hands.length === round.hands.length && // not a split (which also drops a card)
        !!prevRound.hands[ai] &&
        !!round.hands[ai] &&
        round.hands[ai].cards.length === prevRound.hands[ai].cards.length - 1
      const mulliganed = !!prevRound && !prevRound.mulliganed && !!round && round.mulliganed
      const split =
        prevPhase === 'playing' && !!prevRound && prevRound.hands.length === 1 && !!round && round.hands.length === 2
      // Bust Block fired: the shield spends by recording the busting draw it caught
      // in `round.burned`, which is null until then — so a freshly-set `burned` is
      // the shield triggering on this hit.
      const bustBlocked = prevPhase === 'playing' && !!prevRound && !!round && !prevRound.burned && !!round.burned
      this.splitPrev_ = null // stale after any action; the split branch re-sets it
      this.returnCardData_ = null
      this.bustBlockData_ = null
      if (returned && prevRound && round) {
        // Flip the returned card face-down + fly it back onto the deck, THEN a
        // short beat, THEN the dealer reveals its hole and plays out.
        const li = prevRound.hands[ai].cards.length - 1
        const canvas = this.stage_.canvas
        const layout = computeLayout(canvas.width, canvas.height)
        this.returnCardData_ = { card: prevRound.hands[ai].cards[li], from: playerCardCenter(layout, prevRound, ai, li) }
        const returnEnd = this.returnAnim_.begin(t)
        this.anim_.sync(prevPhase, this.state_, returnEnd + RETURN_DEAL_DELAY)
      } else if (mulliganed && prevRound && round) {
        // Toss the old opening cards to the dealer, then deal the fresh pair once
        // they've been swept away.
        const discardEnd = this.mulligan_.begin(prevRound.hands[0].cards, t)
        this.anim_.redealHand(0, round.hands[0].cards.length, discardEnd)
        // A fresh natural resolves at once — reveal the dealer after the redeal.
        if (this.state_.phase !== 'playing') {
          this.anim_.sync(prevPhase, this.state_, this.anim_.animEnd)
        }
      } else if (split && prevRound) {
        // Glide the two originals into the two new hands, then deal each its card.
        this.splitPrev_ = prevRound
        this.anim_.splitHands(t)
        // Split aces resolve at the deal (each hand stands on one card) — schedule
        // the hole flip + dealer draws to follow the glide.
        if (this.state_.phase !== 'playing') {
          this.anim_.sync(prevPhase, this.state_, this.anim_.animEnd)
        }
      } else if (bustBlocked && prevRound && round && round.burned) {
        // Reveal the busting card on the active hand's next slot, catch it in the
        // shield, then sweep it off — and only THEN deal any replacement + play the
        // dealer out (anim.sync scheduled from the reveal's end).
        const cardIndex = prevRound.hands[ai].cards.length
        this.bustBlockData_ = { handIndex: ai, cardIndex, card: round.burned }
        const ejectEnd = this.bustBlock_.begin(t)
        this.anim_.sync(prevPhase, this.state_, ejectEnd)
      } else {
        // A hit/stand/double.
        this.anim_.sync(prevPhase, this.state_, t)
      }
      // A winning hand damages the dealer. The nexus laser + damage/shatter are FIRED below (in the
      // awardWinTokens block), auto-timed to land just after the reward tokens — no longer deferred
      // to the Next-hand click. The exception is the final blow ('over'), which ends the run — its
      // shred → laser death is run by beginEndGame below, and the coda's boss death by beginCoda.
      const enteringOver = this.state_.phase === 'over' && prevPhase !== 'over'
      const enteringCoda = this.state_.phase === 'coda' && prevPhase !== 'coda'
      const damaged = integrity < prevIntegrity || shiftIndex > prevShift
      if (damaged && !enteringOver && !enteringCoda) {
        // Tag the kind now, while we can still tell a KILL (kills grew) from a WINDOW-OUT (the dealer
        // survived its window — shift advanced but kills didn't). The laser block reads it to pick
        // the beat (hit / shatter / no-laser), and the Next-hand block to route the table's advance.
        const killed = this.state_.run.kills.length > prevKillsLen
        const kind: 'kill' | 'windowOut' | 'damage' = killed ? 'kill' : shiftIndex > prevShift ? 'windowOut' : 'damage'
        this.pendingAttack_ = { fromIntegrity: prevIntegrity, fromShift: prevShift, toIntegrity: integrity, toShift: shiftIndex, kind }
      }
      // A late dealer that BEAT the player repairs itself (heal-on-win): integrity
      // rose with no shift change. The YELLOW emitter fires a heal beam and the bar
      // climbs under it, timed just after the lost hand's cards settle — the gentle
      // counterpart to the player's red laser. Skipped on the final hand ('over'):
      // the run is ending, so there's no repair to show.
      const healed = integrity > prevIntegrity && shiftIndex === prevShift
      if (healed && this.state_.phase === 'resolved') {
        const healStart = this.anim_.animEnd + HEAL_GAP
        this.nexus_.heal(healStart)
        // Steady the eye-flicker + damage sparks to the repaired level (fewer/none as the
        // dealer climbs back above the FX threshold).
        this.dealer_.setLevel(integrity, shiftIndex)
        sfx.playHeal(Math.max(0, healStart - t) / 1000)
      }
      // Reward tokens for a surviving hit fly up right away; the win reward is
      // handled below, timed to the chips.
      this.scheduleTokens_(prevPhase, prevTokens)
      // A surviving hit earns NO score — it only pays tokens (scheduled above).
      // On resolve, freeze the bankroll at its pre-settle *available* value (the
      // live bet is on the table); it releases to the new total once the payout
      // chips land on the next hand.
      if (this.syncChips_(prevPhase, t)) {
        // Award the win reward the moment the won chips finish sliding into place
        // beside the bet (chips.animEnd) — no longer deferred to the Next-hand click.
        // Only a normal resolve pays the counter; a final blow ('over') ends the run.
        if (this.state_.phase === 'resolved' && this.state_.round) {
          const tokensEnd = this.awardWinTokens_(this.state_.round, this.chips_.animEnd + TOKEN_SPAWN_DELAY)
          // Sabotage T1: the dealer reaching 21 paid flat energy (already credited in Session.settle_).
          // Fly it up as its own burst — anchored, like every reward, at the nexus vent — so even a
          // LOSING hand (or a voided 21) shows a clear "the dealer's 21 fuelled you" beat instead of a
          // silent counter tick. Unlike the win tokens, this DOES gate the attack below: `attackFloor`
          // holds the nexus strike until the burst has fully landed (liftoff + FLY_MS) plus a beat, so
          // the +20 completes cleanly before the laser hits (see ENERGY_ATTACK_GAP).
          let attackFloor = 0
          if (this.state_.round.rules.dealer21Energy && dealerSettleTotal(this.state_.round) === 21) {
            const layout = computeLayout(this.stage_.canvas.width, this.stage_.canvas.height)
            const liftoff = tokensEnd + TOKEN_HAND_STAGGER
            this.tokens_.emit(nexusUtilityLight(layout, liftoff), SABOTAGE_DEALER21_ENERGY, liftoff)
            this.nexus_.pulseYellow(liftoff)
            attackFloor = liftoff + FLY_MS + ENERGY_ATTACK_GAP
          }
          // The nexus laser now AUTO-FIRES here — no longer deferred to the Next-hand click. The
          // reward tokens land, THEN the utility light charges red (anticipate), THEN the beam
          // strikes: tokens → points → laser, in step. A `damage` hit drops the dealer's health;
          // a `kill` SHATTERS it on impact (playDeath fires the +40 bounty with the death, and the
          // replacement's walk-in / upgrade pick wait for the click). A `windowOut` fires NO laser
          // — the survivor simply strides off on the click. The summary then eases in behind the
          // attack (appearAt), and its reveal sets the Next-hand consent gate. `attackFloor` pushes the
          // strike (and its charge-up) past the Sabotage energy burst when there is one.
          const pa = this.pendingAttack_
          let appearAt = tokensEnd
          if (pa && pa.kind !== 'windowOut') {
            const laserStart = Math.max(tokensEnd + LASER_GAP, attackFloor)
            this.nexus_.anticipate(laserStart - LASER_GAP)
            const kill = pa.kind === 'kill'
            appearAt = kill
              ? this.playDeath_(pa.fromIntegrity, pa.fromShift, pa.toIntegrity, pa.toShift, laserStart)
              : this.playAttack_(pa.fromIntegrity, pa.fromShift, pa.toIntegrity, pa.toShift, laserStart)
            this.fireLaser_(t, laserStart, kill)
          }
          this.summaryAppear_(appearAt)
          // Points fly in as a "+N" from each winning green check to a stacked row below the counter,
          // timed to the summary's reveal — the counter holds at prevScore and climbs as each lands.
          // The `else if` is a defensive fallback for any round that raises the score without a green
          // check to fly from; the normal win path always takes the first branch.
          const deltas = winPointDeltas(prevRun, this.state_.round)
          if (deltas.length > 0 && this.summary_) {
            this.setupScoreDeltas_(prevScore, deltas, appearAt + SUMMARY_APPEAR_HOLD)
          } else if (this.state_.run.score - prevScore > 0) {
            const releaseAt = this.chips_.animEnd + TOKEN_SPAWN_DELAY + FLY_MS + 200
            this.holdScoreReward_(prevScore, this.state_.run.score - prevScore, 1, releaseAt)
          }
          // Player hearts: a lost round pops the last chip, a qualifying win heals the first empty
          // one — fired after the summary's mark (resolveAttackEnd_, computed just above) is in, and
          // never before the Sabotage energy burst has landed (attackFloor), so on a dealer-21 loss
          // the +20 completes cleanly before the heart-pop laser strikes.
          this.syncHearts_(prevRun.hitPoints, Math.max(this.resolveAttackEnd_, attackFloor))
        }
      }
      // Game over: once the ending hand's cards settle, the dealer sucks them up + shreds
      // them, then is destroyed (a win: laser death) or walks off (a loss), and the nexus
      // projects the score screen. Fires for a bust-out loss too (no damage this hand).
      if (enteringCoda) {
        if (this.state_.run.hitPoints <= 0 && this.state_.run.kills.length < TOTAL_DEALERS) {
          // HEART-DEATH: the player bled out before Dealer 6. Play the losing summary + final heart
          // pop first, THEN let the dealer walk off and the coda begin (deferred to the frame loop).
          this.beginHeartDeathCoda_(prevScore, prevIntegrity, prevShift, integrity, t)
        } else {
          // The 6th dealer fell (or outlasted its window) → the Banker walks in and the coda begins.
          this.beginCoda_(prevScore, prevIntegrity, prevShift, integrity, t)
        }
      } else if (enteringOver) {
        this.beginEndGame_(prevScore, prevIntegrity, prevShift, integrity, shiftIndex, t)
      }
    }

    this.syncOverlay_(t) // reflect the new state immediately (disable while animating)
    this.lastAnimating_ =
      this.anim_.isAnimating(t) ||
      this.chips_.isAnimating(t) ||
      this.spawn_.isAnimating(t) ||
      this.bustBlock_.isAnimating(t) ||
      this.nexus_.isHealing(t) ||
      this.hearts_.isAnimating(t)
    this.ensureLoop_()
  }

  // Schedule chip motion for whatever the state change implies: a deal places
  // the bet(s); a round resolving flies the winnings in from the house (after
  // the cards settle) but leaves everything resting until the next hand. Returns
  // whether the round resolved (so the bankroll can freeze until the payout moves).
  private syncChips_(prevPhase: SessionState['phase'], t: number): boolean {
    const round = this.state_.round
    if (!round) {
      return false
    }
    if (prevPhase === 'betting') {
      this.chips_.placeBets(round, t)
    }
    // The coda-entry hand (the 6th kill) resolves into the 'coda' phase, not 'resolved'/'over' —
    // count it as resolved too so the winning chips still collect before the Banker arrives.
    const resolvedNow = this.state_.phase === 'resolved' || this.state_.phase === 'over' || this.state_.phase === 'coda'
    const wasResolved = prevPhase === 'resolved' || prevPhase === 'over'
    if (resolvedNow && !wasResolved) {
      this.chips_.resolve(round, this.anim_.animEnd)
      return true
    }
    return false
  }

  // React to the tokens this action just earned. Every token flies from the table
  // nexus (the device damage + rewards originate from). A surviving hit credits +1
  // while play continues, so its token flies right away. A winning resolve's reward
  // is flown by awardWinTokens (timed to the chips), not here. The +40 dealer-kill
  // token is emitted from the nexus in run() (timed to the dealer's destruction).
  private scheduleTokens_(prevPhase: SessionState['phase'], prevTokens: number): void {
    const round = this.state_.round
    if (!round) {
      return
    }
    const phase = this.state_.phase

    // Surviving hit: the only token credited while the hand plays on. It flies
    // from the card that was just dealt (the active hand's last card).
    if (phase === 'playing' && this.state_.run.tokens > prevTokens) {
      const canvas = this.stage_.canvas
      const layout = computeLayout(canvas.width, canvas.height)
      const amount = this.state_.run.tokens - prevTokens
      const liftoff = this.anim_.animEnd + TOKEN_SPAWN_DELAY
      // Launch from where the vent floats at liftoff (the device is always bobbing).
      this.tokens_.emit(nexusUtilityLight(layout, liftoff), amount, liftoff)
      // Pulse the yellow vent as the reward token shoots out of it.
      this.nexus_.pulseYellow(liftoff)
      return
    }

    // Final blow: the run is ending, so the last hand's reward is withheld from the count and
    // simply dropped when it resets — never flown to the counter. On a WIN that includes the
    // +40 kill bounty (already in run.tokens), so withhold it too — otherwise the top-left
    // count ticks up by 40 during the draw-out, spoiling the win.
    if (phase === 'over' && prevPhase !== 'over') {
      const killBounty = this.state_.run.won ? Math.round(DESTROY_TOKEN * tokenMultiplier(this.state_.run)) : 0
      this.heldTokens_ = winTokensTotal(round) + killBounty
    }
  }

  // Fly the win/blackjack tokens up to the counter, from the nexus utility vent,
  // staggered per winning hand so a split's two wins cascade. Called on the resolve
  // once the won chips have slid into place (startAfter = chips settle), so the
  // reward lands right behind the money — no waiting for the Next-hand click. Returns
  // the timestamp the last token LANDS (or `startAfter` if nothing flew), so the caller
  // can hold the Next-hand button + schedule the red laser charge until after it.
  private awardWinTokens_(round: Round, startAfter: number): number {
    const canvas = this.stage_.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    let end = startAfter
    round.hands.forEach((hand, hi) => {
      const amount = winTokenFor(hand, round)
      if (amount > 0) {
        const liftoff = startAfter + hi * TOKEN_HAND_STAGGER
        // From where the vent floats at liftoff (the device bobs continuously).
        this.tokens_.emit(nexusUtilityLight(layout, liftoff), amount, liftoff)
        // Pulse the utility light yellow as the reward shoots out of it.
        this.nexus_.pulseYellow(liftoff)
        end = Math.max(end, liftoff + FLY_MS)
      }
    })
    return end
  }

  // Kick off the dealer-spawn ceremony: shred `prevRound`'s table cards into the new
  // dealer's mouth starting at `shredStart`, then fly in a fresh wrapped deck in the
  // incoming dealer's colour (committed to the static table when it lands — see the
  // frame loop). Returns the timestamp the deck is ready, so the next deal can wait.
  // `shredOldDeck` is true for a kill (the beaten dealer's resting deck is chewed too),
  // false for a New run after game over (the old run's deck was already shredded at game
  // over, so there's nothing resting to chew — only the fresh deck flies in).
  private beginSpawn_(incomingShift: number, shredStart: number, shredOldDeck = true): number {
    this.spawnIncomingShift_ = incomingShift
    this.spawnShredOnly_ = false // a real ceremony: the fresh deck flies in
    // The previous dealer's resting deck moves off the static table onto the cards layer
    // so it can be sucked into the new dealer's mouth; the static deck stays hidden until
    // the fresh one lands + commits (frame settle). Draw it resting there right away.
    this.spawnHasOldDeck_ = shredOldDeck
    this.deckHidden_ = true
    // Arm the settle edge so the ceremony-end commit (deckColorShift + deckHidden=false, in the
    // frame loop's `!sequenceAnimating && lastAnimating_` block) runs when the ceremony finishes —
    // that's the ONLY place the fresh deck hands back to the static table. The New-run/kill callers
    // reach this via run_, which recomputes lastAnimating_ to the same true afterward (spawn is now
    // animating), so this is a no-op for them. But a WINDOW-OUT arrival (playWindowArrival_, fired
    // from the frame loop, not run_) would otherwise leave it false: the settle would never fire, the
    // deck would never commit, and it would VANISH the instant the next hand deals (deckHidden stays
    // true, and the spawn-deck stops drawing once it lands). Setting it here covers every path.
    this.lastAnimating_ = true
    const canvas = this.stage_.canvas
    this.paintTable_(canvas, computeLayout(canvas.width, canvas.height), false)
    // The table cards to shred are whatever `collectRound` holds (null on a game-over New
    // run — they were already shredded at game over, so nothing is chewed there).
    const src = this.collectRound_
    const cardCount = src ? src.dealer.length + src.hands.reduce((sum, hand) => sum + hand.cards.length, 0) : 0
    // Every dealer — including the final dealer and the Banker — uses the same deck ceremony timing.
    return this.spawn_.begin(shredStart, cardCount, shredOldDeck)
  }

  // The front half of an upgrade-granting kill: the laser fires, the dealer breaks
  // apart (no walk-in), and the +40 bounty flies from the nexus — but the replacement is
  // held back for playArrival. Returns when the figure is gone.
  private playDeath_(fromI: number, fromS: number, toI: number, toS: number, startAfter: number): number {
    this.dealer_.sync(fromI, fromS, toI, toS, startAfter, false, false) // death only, no walk-in
    const canvas = this.stage_.canvas
    const layout = computeLayout(canvas.width, canvas.height)
    const liftoff = startAfter + KILL_DEATH_MS
    const bounty = Math.round(DESTROY_TOKEN * tokenMultiplier(this.state_.run))
    this.tokens_.emit(nexusUtilityLight(layout, liftoff), bounty, liftoff)
    return startAfter + KILL_DEATH_MS
  }

  // The back half of an upgrade-granting kill, run when the player picks: after a beat
  // the replacement dealer walks in, its mouth shreds the old cards + resting deck, and a
  // fresh wrapped deck flies in. The next deal waits for it all.
  private playArrival_(t: number): void {
    const c = this.pendingCeremony_!
    this.pendingCeremony_ = null
    this.collectRound_ = c.prevRound // re-anchor the cards to shred (kept resting till now)
    const walkInStart = t + CEREMONY_LEAD
    this.dealer_.setLevel(c.incomingIntegrity, c.incomingShift)
    this.dealer_.setShift(c.incomingShift)
    this.dealer_.spawn(walkInStart)
    this.dealAfter_ = this.beginSpawn_(c.incomingShift, walkInStart + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP)
  }

  // A survived dealer's replacement walks in (deferred from the window-out walk-off): the new dealer
  // slides in, its mouth shreds the old resting cards + deck, and a fresh wrapped deck flies in. The
  // resting cards come from collectRound_ (set at the Next-hand clear, kept until now).
  private playWindowArrival_(): void {
    const w = this.pendingWindowOut_
    if (!w) {
      return
    }
    this.pendingWindowOut_ = null
    const t = now()
    this.dealer_.setLevel(w.incomingIntegrity, w.incomingShift)
    this.dealer_.setShift(w.incomingShift)
    this.dealer_.spawn(t)
    this.playWalkInGrowl_(t)
    this.dealAfter_ = this.beginSpawn_(w.incomingShift, t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP)
  }

  // Blast the nexus's red muzzle for the laser beam at `attackStart` (from `t`, the
  // action) and fire the attack sounds at their true moments: the laser as it fires,
  // the impact as the beam reaches the dealer (STRIKE_TRAVEL_MS later, damage dealt),
  // and — on a kill — the explosion as the figure blows apart (KILL_DEATH_LEAD_MS in).
  // Centralised so every laser — the auto-fired resolve damage/kill and the final blow — is in step.
  private fireLaser_(t: number, attackStart: number, kill: boolean): void {
    this.nexus_.fire(t, attackStart, attackStart + HIT_TOTAL_MS)
    sfx.play('laser-prepare', Math.max(0, attackStart - t) / 1000)
    sfx.play('laser-impact', Math.max(0, attackStart + STRIKE_TRAVEL_MS - t) / 1000)
    if (kill) {
      sfx.play('dealer-death', Math.max(0, attackStart + KILL_DEATH_LEAD_MS - t) / 1000)
    }
  }

  // Fire the nexus laser at the dealer for a damage/kill, starting at `startAfter`.
  // Returns when the sequence finishes — a plain hit, or the full death → walk-in
  // → recharge on a kill — so the next deal can wait for it. The +40 kill token
  // flies from the nexus once the old dealer is fully destroyed.
  // `emitBounty` flies the +40 kill token from the nexus (default). At GAME OVER it's false:
  // the run is ending, so the bounty is withheld from the count (see scheduleTokens) and the
  // counter never shows it — flying it would double-count against that withholding.
  private playAttack_(fromI: number, fromS: number, toI: number, toS: number, startAfter: number, emitBounty = true): number {
    const final = this.state_.run.won || toS > TOTAL_DEALERS
    this.dealer_.sync(fromI, fromS, toI, toS, startAfter, final)
    if (toS > fromS) {
      if (emitBounty) {
        const canvas = this.stage_.canvas
        const layout = computeLayout(canvas.width, canvas.height)
        const liftoff = startAfter + KILL_DEATH_LEAD_MS + KILL_DYING_MS
        // The kill bounty flies scaled by the Token eco multiplier, matching the
        // credited amount (run.ts). The upgrade pick comes after this, so the current
        // run's multiplier is the one that applied to this bounty.
        const bounty = Math.round(DESTROY_TOKEN * tokenMultiplier(this.state_.run))
        this.tokens_.emit(nexusUtilityLight(layout, liftoff), bounty, liftoff)
      }
      return startAfter + KILL_TOTAL_MS
    }
    return startAfter + HIT_TOTAL_MS
  }

  // The game-over sequence that ends at the FINAL SCOREBOARD (docs/scoreboards.md). Reached by an
  // early bankruptcy (broke at Dealer 1–2, no coda) — the coda's own end runs through
  // beginCodaEnd_ instead. Once the ending hand's cards settle, the dealer sucks BOTH the table
  // cards AND its resting deck into its mouth and shreds them — exactly the shred a beaten
  // dealer's ceremony plays, but with NO fresh deck flying in (the run is over). Then — a win: the
  // nexus laser fires and the final dealer breaks apart; a loss: the dealer strides off to the
  // right (footsteps). The instant everything is shredded the nexus starts projecting the final
  // scoreboard and the New-run button appears (scoreRevealAt / the frame loop's reveal edge).
  private beginEndGame_(prevScore: number, prevIntegrity: number, prevShift: number, integrity: number, shiftIndex: number, t: number): void {
    const round = this.state_.round
    if (!round) {
      return
    }
    // The dealer never shreds the hand it won — on a game-over LOSS the cards RETURN TO THE DECK
    // (a gather, like between hands, but with NO riffle — there's no next hand) and the dealer
    // strides off. The deck stays put on its layer; the cards just fly back into it.
    this.collectRound_ = round
    this.endShredDone_ = false

    // Settle the table chips FIRST: a loss flies the bet to the house (beside the dealer), a
    // win collects the winnings to the bankroll. Everything else waits for them — so on a
    // loss the bet reaches the dealer before the cards return to the deck. Start once the cards
    // have landed AND any resolve animation (the winnings flying in on a win) has finished. The
    // bankroll count stays frozen at its resolve value (heldChips) — there's no next hand.
    const chipStart = Math.max(this.anim_.animEnd, this.chips_.animEnd)
    this.chips_.clear(round, chipStart)

    const gatherStart = this.chips_.animEnd + END_SHRED_GAP
    this.anim_.collect(round, gatherStart, false)
    const gatherEnd = this.anim_.animEnd
    if (this.state_.run.won) {
      // Dead path: run.won is never set now (the Banker coda replaced the boss-defeat ending).
      // Kept so the death/laser wiring — and this method's integrity/shift params — stay used.
      this.playAttack_(prevIntegrity, prevShift, integrity, shiftIndex, gatherEnd, false)
      this.fireLaser_(t, gatherEnd, true)
    } else {
      // The house won: the dealer turns and strides off to the right once the cards are back.
      this.dealer_.walkOff(gatherEnd)
    }
    // Freeze the score counter until the score screen shows (gatherEnd) — letting the top-right
    // counter roll up during the gather/walk-off would spoil the run's final beat.
    const gained = this.state_.run.score - prevScore
    if (gained > 0) {
      this.holdScoreReward_(prevScore, gained, 1, gatherEnd)
    }
    // Once the cards are back in the deck, project the score screen + reveal the New-run button.
    this.scoreRevealAt_ = gatherEnd
    this.scoreRevealed_ = false
    // Clear any lingering "+N" delta from an earlier win so it can't flash stale over the
    // game-over screen (the loss adds no points, so nothing new replaces it).
    this.pointsDeltaEl_.classList.remove('is-flashing', 'is-flashing-coda')
    this.pointsDeltaEl_.textContent = ''
  }

  // Enter the coda — the BANKER walks in to run a double-or-nothing, ending at the banker scoreboard
  // (docs/scoreboards.md). Two doorways into the SAME coda, branched on whether Dealer 6 was killed
  // (kills.length reached TOTAL_DEALERS): the VICTORY entry (the 6th dealer just fell to a winning
  // hand — the boss breaks apart, then the Banker walks in as its "replacement") and the WINDOW-OUT
  // entry (Dealer 6's hand window ran out — the surviving dealer walks off, then the Banker walks
  // in). Either way it's a normal non-final kill ceremony (final would suppress the walk-in), his
  // mouth shredding the boss's resting cards as he arrives, with a fresh Banker-coloured deck for
  // the double-or-nothing hands.
  // The killing hand is kept resting for the shred, then dismissed to the prompt (codaResolveNext)
  // once the ceremony finishes.
  // A heart-death coda entry: the player lost their last hit point. Show the losing hand's summary
  // and pop the final heart-chip FIRST; the frame loop (at heartDeathAt_) then fires beginCoda_ so the
  // dealer walks off and the Banker's double-or-nothing begins — the red X + last pop read before the
  // table clears. No score penalty: the coda opens on the current total (the loss scored nothing).
  private beginHeartDeathCoda_(prevScore: number, prevIntegrity: number, prevShift: number, integrity: number, t: number): void {
    this.heartDeathPending_ = true
    this.heartDeathEntry_ = { prevScore, prevIntegrity, prevShift, integrity }
    // Ease the losing summary in once the cards settle (no laser on a loss), like any other loss —
    // summaryAppear_ sets resolveAttackEnd_ to the moment the red X is fully revealed.
    const appearAt = Math.max(this.anim_.animEnd, t)
    this.summaryAppear_(appearAt)
    // Then the final chip pops (after the red X), and the deferred coda entry waits for it to finish.
    const startAt = this.resolveAttackEnd_
    this.schedulePop_(startAt)
    this.heartDeathAt_ = this.hearts_.animEndAfter(startAt) + SUMMARY_MIN_HOLD
  }

  private beginCoda_(prevScore: number, prevIntegrity: number, prevShift: number, integrity: number, t: number): void {
    const round = this.state_.round
    if (!round) {
      return
    }
    this.collectRound_ = round // the killing hand's cards, for the Banker to shred on arrival
    this.endShredDone_ = false
    this.codaEntering_ = true
    this.codaDeckOut_ = false
    // Warm the coda tracks now so a later coda action (double-or-nothing / cash out) can snap in
    // on a quick fade with no download gap.
    music.prefetchCoda()
    // Fade the fight music out to SILENCE the moment the winning hand is revealed (its cards
    // settle), then hold silent through the Banker's entrance until the player picks an action.
    this.codaMusicFadeAt_ = Math.max(this.anim_.animEnd, t)
    this.codaWonHand_ = false // the entry prompt isn't a hand-win
    // Score to roll up when the Banker arrives (his walk-in is deferred by CODA_WALKIN_DELAY).
    this.codaEntryScore_ = { prevScore, gained: this.state_.run.score - prevScore }
    // Freeze the counter at the pre-coda total (so it doesn't roll up during the boss death),
    // and clear any lingering "+N" delta from the last hand — the score reveals as the Banker
    // settles (playCodaArrival re-holds with the real release), with no per-hand delta text.
    this.holdScoreReward_(prevScore, 0, 1, Number.MAX_SAFE_INTEGER)
    this.pointsDeltaEl_.classList.remove('is-flashing', 'is-flashing-coda')

    // Settle the last hand's chips before the exit — a bankruptcy loss flies the bet to the
    // house; a 6th-kill win collects the winnings — then the boss leaves. Floor on `t`: a heart-death
    // entry calls this DEFERRED (well after the resolve), so the anim/chip clocks are stale and in the
    // past — without the `t` floor the walk-off would start in the past and JUMP forward on frame one.
    const chipStart = Math.max(this.anim_.animEnd, this.chips_.animEnd, t)
    this.chips_.clear(round, chipStart)

    if (this.state_.run.kills.length < TOTAL_DEALERS) {
      // Dealer 6 outlasted its window (it wasn't killed): it strides OFF (no laser/death), and the
      // Banker walks in behind it to run the double-or-nothing. The last window hand's cards stay
      // resting (collectRound, above) for the Banker to shred on arrival, exactly like a 6th-kill entry.
      const walkStart = this.chips_.animEnd + LASER_GAP
      this.dealer_.walkOff(walkStart)
      this.codaArrivalAt_ = walkStart + KILL_ARRIVE_MS + CODA_WALKIN_DELAY
      return
    }

    // The boss breaks apart — DEATH ONLY, no walk-in (walkIn=false). The Banker arrives a beat
    // later (playCodaArrival, scheduled here) so there's a clear pause before he appears.
    const attackStart = this.chips_.animEnd + LASER_GAP
    this.dealer_.sync(prevIntegrity, prevShift, integrity, BANKER_SHIFT, attackStart, false, false)
    this.fireLaser_(t, attackStart, true)
    this.codaArrivalAt_ = attackStart + KILL_DEATH_MS + CODA_WALKIN_DELAY
  }

  // The Banker's deferred entrance, fired CODA_WALKIN_DELAY after the boss is gone (see the frame
  // loop). He strides in cackling; his mouth shreds the boss's resting cards + deck as he arrives
  // (no fresh deck yet — that waits for the first double), and the counter rolls up to the stake.
  // Once the shred finishes the killing hand is dismissed to the prompt.
  private playCodaArrival_(): void {
    const t = now()
    this.dealer_.setLevel(maxHitsFor(BANKER_SHIFT), BANKER_SHIFT)
    this.dealer_.setShift(BANKER_SHIFT)
    this.dealer_.spawn(t)

    this.spawnShredOnly_ = true
    this.spawnIncomingShift_ = null
    this.spawnHasOldDeck_ = true
    this.deckHidden_ = true
    const canvas = this.stage_.canvas
    this.paintTable_(canvas, computeLayout(canvas.width, canvas.height), false)
    const round = this.collectRound_
    const cardCount = round ? round.dealer.length + round.hands.reduce((sum, hand) => sum + hand.cards.length, 0) : 0
    // shredOnly (no fresh deck — he pulls his own out on the first double); one continuous shred.
    const shredEnd = this.spawn_.begin(t + KILL_ARRIVE_MS - SHRED_ARRIVE_OVERLAP, cardCount, true, true)
    this.codaShredEndAt_ = shredEnd
    // Hold the Banker's waiting theme until the shred is fully done — it rises out of the quiet as
    // the last card is chewed, then plays once through the double-or-nothing prompt.
    this.codaDecisionsAt_ = shredEnd
    // He cackles a BANKER_LAUGH_DELAY beat AFTER the shredding finishes — the shred and the laugh are
    // separate moments, not layered. (endShredDone / clearing the cards is driven by codaShredEndAt_
    // above, independent of this.)
    this.playBankerLaugh_(this.spawn_.shredEnd + BANKER_LAUGH_DELAY)

    const info = this.codaEntryScore_
    this.codaEntryScore_ = null
    this.pointsDeltaEl_.classList.remove('is-flashing', 'is-flashing-coda') // fade any lingering delta from the last hand
    if (info) {
      // Roll the counter up to the stake as the Banker settles — no "+N" delta (the coda is
      // about the total at risk, not a per-hand gain).
      this.holdScoreReward_(info.prevScore, 0, 1, shredEnd)
    }
    // Once the shred finishes, dismiss the killing hand → the coda prompt (DOUBLE / CASH OUT).
    this.codaAdvanceAt_ = shredEnd + CODA_ENTRY_HOLD
  }

  // The coda's own transition handler (mirrors run(), stripped to the double-or-nothing loop:
  // no chips, tokens, laser, or combo). Routes each coda action to its animation and, when the
  // run ends, hands off to beginCodaEnd. codaResolveNext (the frame-loop auto-advance) flows here.
  private runCoda_(mutate: () => void): void {
    this.dismissSpec_()
    const prevRound = this.state_.round
    const prevScore = this.state_.run.score
    const prevAnalysis = this.state_.analysis
    // A pushed hand auto-re-deals with codaRedeal already set; an explicit "Double or nothing"
    // from a prompt has it clear. Used below to (re)start the theme only on the explicit pick.
    const wasRedeal = this.state_.codaRedeal
    mutate()
    this.state_ = this.session_.snapshot()
    const t = now()

    // Analyze reading flicker (mirror run()).
    if (this.state_.analysis && !prevAnalysis) {
      this.analysisStart_ = t
      this.analysisFadeOut_ = null
    } else if (!this.state_.analysis && prevAnalysis) {
      this.analysisFadeOut_ = prevAnalysis
      this.analysisFadeStart_ = t
    }

    const round = this.state_.round
    if (this.state_.phase === 'over') {
      // A coda bust or cash-out ended the run → the Banker's exit + the score screen. On a bust he
      // laughs as he strides OFF with everything (fired from beginCodaEnd, timed to the walk-off —
      // not while he shreds); a cash-out gets no gloat.
      this.beginCodaEnd_(prevRound)
    } else if (!prevRound && round) {
      // codaGamble: a fresh double-or-nothing hand. The Banker cackles as he sets it up.
      this.collectRound_ = null
      this.endShredDone_ = false // the coda hand's cards draw normally again
      this.playBankerLaugh_(t)
      // (Re)start the double-or-nothing theme ("Mistake the Getaway") from its opening bang —
      // but ONLY when the player explicitly picks double-or-nothing. A pushed hand re-deals
      // automatically (wasRedeal), so we leave the music playing rather than restarting it.
      if (!wasRedeal) {
        music.codaHand()
      }
      // On the FIRST double he pulls out his own deck (wrapped) and unwraps it, THEN deals; on
      // later doubles the deck's already out, so he just deals. (shredOldDeck=false — nothing
      // resting to chew; the boss's deck was shredded on entry.)
      let dealAt = t
      if (!this.codaDeckOut_) {
        this.codaDeckOut_ = true
        dealAt = this.beginSpawn_(BANKER_SHIFT, t, false)
        this.codaDeckCommitAt_ = dealAt // commit the deck to the static table as the fly-in lands (frame loop)
      }
      this.codaAnimSync_('betting', dealAt)
      if (round.status === 'resolved') {
        // A natural blackjack right off the deal — hold the cards on the felt an extra beat
        // before the auto-collection so the player can take in what happened.
        this.codaAdvanceAt_ = this.anim_.animEnd + CODA_RESULT_HOLD + CODA_NATURAL_HOLD
      }
    } else if (prevRound && round) {
      // A coda hand action: a Mulligan (discard the opening two + redraw — guaranteed, no coin)
      // or a hit/stand.
      const mulliganed = round.mulliganed && !prevRound.mulliganed
      if (mulliganed) {
        // Discard the opening two, then deal a fresh pair once they've been swept up.
        const discardEnd = this.mulligan_.begin(prevRound.hands[0].cards, t)
        this.anim_.redealHand(0, round.hands[0].cards.length, discardEnd)
        if (round.status === 'resolved') {
          this.codaAnimSync_('playing', this.anim_.animEnd) // a fresh natural resolves at once
          // A mulligan redraw that lands a natural — same extra hold as a dealt natural.
          this.codaAdvanceAt_ = this.anim_.animEnd + CODA_RESULT_HOLD + CODA_NATURAL_HOLD
        }
      } else {
        this.codaAnimSync_('playing', t)
        if (round.status === 'resolved') {
          // A push clears + auto-re-deals with no prompt, so it holds only the shorter beat; a
          // win (re-prompt) or loss (game-over) keeps the full result beat so the outcome reads.
          const outcome = round.hands[0].outcome
          const pushed = outcome === 'push' || outcome === 'voided'
          this.codaAdvanceAt_ = this.anim_.animEnd + (pushed ? CODA_PUSH_HOLD : CODA_RESULT_HOLD)
        }
      }
    } else if (prevRound && !round) {
      // codaResolveNext cleared the resolved hand. A coda win/push hand (bet 0) is still on the
      // felt — gather it away (with a riffle); the killing hand (a real bet) was already shredded.
      if (prevRound.hands[0].bet === 0) {
        this.collectRound_ = prevRound
        // Move the deck onto the cards layer so the gather + riffle actually slides/splits it
        // (like the main game's next-hand gather) — otherwise the shuffle sfx plays but nothing
        // moves. The settle hands the deck back to the static layer when it finishes.
        this.deckOnCards_ = true
        const canvas = this.stage_.canvas
        this.paintTable_(canvas, computeLayout(canvas.width, canvas.height), false)
        this.anim_.collect(prevRound, t)
      }
      // A push auto-re-deals with no re-prompt — DON'T re-show the stake projection (it flashed
      // "Double or nothing?" for a beat before the redeal). Only a win / the entry re-prompts.
      if (!this.state_.codaRedeal) {
        this.codaStakeShownAt_ = t
      }
      if (prevRound.hands[0].bet > 0) {
        // ENTRY: the killing hand was just dismissed to the first prompt. The pot's first
        // glass marker materialises now, embedding the entry score as its base unit.
        this.codaCrystalValue_ = this.state_.run.score
        this.codaWins_ = 0
        this.codaCounters_.reveal(t)
      }
      const gained = this.state_.run.score - prevScore
      if (gained > 0) {
        // A coda WIN just doubled the stake — the banker-hand-win scoreboard appears (left-
        // justified), the projected number ticks up to the new doubled total, and the Banker gives
        // a slow hand-clap as it shows — robotically re-voiced (playHandClap) to a metallic clank
        // so it reads as the machine's mock applause, not a soundboard clip.
        this.holdScoreReward_(prevScore, gained, 1, this.anim_.animEnd)
        this.codaWonHand_ = true
        sfx.playHandClap()
        // Grow the glass pile in lockstep with the score roll: within a tier the banker slides
        // matching markers in (1→2→4→8), and on every 4th win the eight fuse into ONE marker of
        // the next, higher denomination (colour up) rather than overflowing the felt.
        const prevWins = this.codaWins_
        this.codaWins_ = prevWins + 1
        const start = this.anim_.animEnd
        const counterEnd =
          codaTier(this.codaWins_) > codaTier(prevWins)
            ? this.codaCounters_.colourUp(codaPerTier(prevWins), codaTier(prevWins), codaTier(this.codaWins_), start)
            : this.codaCounters_.grow(codaPerTier(prevWins), codaPerTier(this.codaWins_), codaTier(this.codaWins_), start)
        // Freeze the prompt's choices until the scoreboard finishes: the top-right counter's roll
        // (released at `start`, running rollDurationMs) AND the glass pot's grow/colour-up. Whichever
        // ends later governs — a colour-up (implode + bloom) outlasts the number roll.
        this.codaChoiceReadyAt_ = Math.max(counterEnd, start + CountTicker.rollDurationMs(gained))
      }
    }

    this.syncOverlay_(t)
    this.lastAnimating_ =
      this.anim_.isAnimating(t) || this.chips_.isAnimating(t) || this.spawn_.isAnimating(t)
    this.ensureLoop_()
  }

  // Deal-animator sync for a coda hand. The coda phase is never 'playing', so synthesize the
  // phase from the round status (a live hand → 'playing' keeps the dealer hole down; a resolved
  // hand → 'resolved' flips the hole + plays the dealer out).
  private codaAnimSync_(prevAnimPhase: SessionState['phase'], t: number): void {
    const round = this.state_.round
    const animPhase: SessionState['phase'] = round && round.status === 'resolved' ? 'resolved' : 'playing'
    this.anim_.sync(prevAnimPhase, { ...this.state_, phase: animPhase }, t)
  }

  // The coda's game-over sequence, ending at the FINAL SCOREBOARD (docs/scoreboards.md — title
  // BUSTED on a coda bust, CASHED OUT on a cash-out). A coda bust leaves the losing hand on the
  // table — the Banker shreds it (no laser: he isn't destroyed) and strides off; a cash-out has no
  // hand, so he just collects and leaves. Either way the nexus then projects the final scoreboard
  // (score already banked / zeroed by the Session).
  private beginCodaEnd_(prevRound: Round | null): void {
    const t = now()
    if (prevRound) {
      // Music — coda BUST: snap the coda theme out and play the bust sting once, then silence
      // (it won't bleed into the score screen; a new run brings normal music back).
      music.codaBust()
      // Coda bust: the Banker never shreds the hand he won — the cards RETURN TO THE DECK (a
      // gather, like between hands, but with NO riffle — there's no next hand) and he strides
      // off; the score screen projects as the gather ends (the game-over loss beat). The deck
      // stays put (per-frame, glowing); the cards fly back into it (start clamped to `now` so it
      // can't run off a stale anim clock).
      this.collectRound_ = prevRound
      this.endShredDone_ = false
      const gatherStart = Math.max(this.anim_.animEnd, t) + END_SHRED_GAP
      this.anim_.collect(prevRound, gatherStart, false)
      const gatherEnd = this.anim_.animEnd
      // The pot is lost: once the cards are gathered, the glass counters fly BACK to the
      // Banker's hands before he leaves (he reclaims his stake), and only then does he stride
      // off. Reveal the score once the plaques have landed.
      const reclaimEnd = this.codaCrystalValue_ > 0 ? this.codaCounters_.collect(codaPerTier(this.codaWins_), codaTier(this.codaWins_), gatherEnd) : gatherEnd
      this.dealer_.walkOff(reclaimEnd)
      this.playBankerLaugh_(reclaimEnd) // he cackles as he strides off with everything
      // Reveal the score as the Banker strides off (cards vanished into the deck, plaques back
      // in his hands, so nothing can flicker back).
      this.scoreRevealAt_ = reclaimEnd
      // The bust zeroes the score — clear any lingering "+N" delta from the last coda WIN so a
      // stale gain doesn't flash over the game-over screen.
      this.pointsDeltaEl_.classList.remove('is-flashing', 'is-flashing-coda')
      this.pointsDeltaEl_.textContent = ''
    } else {
      // Music — cash OUT: snap the coda theme out and play the cash-out sting ("Enigma") once,
      // then silence (won't bleed into the score screen; a new run brings normal music back).
      music.codaCashOut()
      // Cash out: no hand on the table — the Banker collects and strides off (from `now`, not a
      // stale clock, so the walk-off is actually seen), then the score screen projects once he's gone.
      const walkStart = t + END_SHRED_GAP
      // The pot is BANKED, not reclaimed: the glass counters dissolve where they sit (they don't
      // fly back to the Banker — the player keeps the score) as he leaves.
      if (this.codaCrystalValue_ > 0) {
        this.codaCounters_.fade(codaPerTier(this.codaWins_), codaTier(this.codaWins_), walkStart)
      }
      this.dealer_.walkOff(walkStart)
      this.scoreRevealAt_ = walkStart + KILL_ARRIVE_MS
    }
    this.scoreRevealed_ = false
  }

  // Sync overlay text + button state. While cards are in motion, buttons are
  // disabled and the result message is withheld until the sequence settles.
  private syncOverlay_(timestamp: number): void {
    const s = this.state_
    // The dealer-death pause + spawn ceremony (walk-in, shred, fresh deck) block
    // input the same way card motion does: all buttons disabled and the result
    // message withheld until the sequence ends.
    const animating =
      this.anim_.isAnimating(timestamp) ||
      this.dealer_.isBlocking(timestamp) ||
      this.dealer_.isArriving(timestamp) ||
      this.spawn_.isAnimating(timestamp) ||
      this.bustBlock_.isAnimating(timestamp) ||
      this.nexus_.isHealing(timestamp)

    // Point the counters at their current values (rewards still flying are withheld);
    // the frame loop rolls them up as they land.
    this.updateTokenCounter_(timestamp)
    this.updatePointsCounter_(timestamp)
    this.messageEl_.textContent = animating ? '' : this.buildMessage_()
    this.syncUpgradePanel_(s, animating, timestamp)

    for (const def of this.defs_) {
      const button = this.buttons_[def.key]
      // Main powerups are hidden through the WHOLE coda — including its game-over (cash-out /
      // bust), where phase is 'over' but run.coda is still true — so they don't flash back on.
      const visible = def.visible(s) && !(def.group === 'power' && s.run.coda)
      button.classList.toggle('is-hidden', !visible)
      // Armed powerups glow; using the shield clears the armed flag, which drops
      // the class here on the next sync and returns the button to normal.
      button.classList.toggle('is-active', visible && !!def.active?.(s))
      // Powerups are locked during the Dealer 6 duel (< 20% health): disable them and
      // swap the cost pill for a red ✕ (via the is-locked class, styled in CSS).
      const duelLocked = def.group === 'power' && s.abilitiesLocked
      button.classList.toggle('is-locked', duelLocked)
      // After a coda WIN, freeze the prompt's Double-or-nothing / Cash-out until the score roll +
      // glass-pot animation settle (codaChoiceReadyAt) — no acting on a mid-update scoreboard.
      const codaChoiceLocked =
        (def.key === 'coda-double' || def.key === 'coda-cash') && timestamp < this.codaChoiceReadyAt_
      button.disabled = animating || duelLocked || codaChoiceLocked || (visible && !def.enabled(s))
      // Next-hand is CONSENT, not a fast-forward: enable it the instant the resolved hand's cards
      // settle (its result is revealed) and keep it enabled THROUGH the auto-firing reward + laser +
      // summary — clicking only arms the advance (which then waits out the choreography). So the
      // attack/ceremony animations in `animating` must NOT disable it; only unsettled cards, a
      // still-revealing deal-natural, or an already-given consent do. (The 'over' New-run case keeps
      // the generic gate above.)
      if (def.key === 'next' && s.phase === 'resolved') {
        button.disabled = !def.enabled(s) || this.anim_.isAnimating(timestamp) || this.dealRevealPending_() || this.proceedPending_
      }
      // Powerup cost pills show the live (inflated) price the spend path will charge.
      const pill = this.costPills_[def.key]
      if (pill && def.cost !== undefined) {
        // Flat-priced coda abilities (Analyze) show their base cost; everything else — main
        // powerups AND inflation-adjusted coda abilities (Mulligan) — shows the live inflated price.
        const flat = def.group === 'coda-power' && !def.inflated
        pill.textContent = String(flat ? def.cost : powerupCost(def.cost, s.run))
      }
    }
    // The score-screen page pager rides the same sync (it fires at the reveal edge and on every
    // action), so it appears the instant the board does and hides the moment a New run begins.
    this.syncScorePager_()
  }

  // Show/hide the choose-upgrade card and swap the normal HUD columns out while it's
  // up. The card appears once the dealer's death settles and its reveal beat passes;
  // each path button shows the effect it would unlock next, and a maxed path's
  // button is hidden. No indication of what's already been picked — by design.
  private syncUpgradePanel_(s: SessionState, animating: boolean, timestamp: number): void {
    // While a pick's dismiss animation is playing, let it own the panel — don't
    // re-toggle is-hidden / the buttons out from under the fade + scale. The columns
    // stay hidden too (still choosing-upgrade until pickUpgrade commits the pick).
    if (this.upgradeDismissing_) {
      return
    }
    const choosing = s.phase === 'choosing-upgrade'
    // The card surfaces only once the death has finished AND a beat has passed
    // (upgradeRevealAt) — so it doesn't pop up over the dealer breaking apart.
    const reveal = choosing && !animating && timestamp >= this.upgradeRevealAt_
    if (reveal && !this.upgradeShown_) {
      sfx.play('upgrade-menu')
    }
    this.upgradeShown_ = reveal
    this.upgradeEl_.classList.toggle('is-hidden', !reveal)
    // The columns hide for the upgrade card OR the spec sheet (centralised so the two
    // never fight over is-hidden).
    this.applyHudColumns_(s)
    if (!choosing) {
      return
    }
    for (const { info, btn, effectEl, tierEl } of this.upgradeButtons_) {
      const level = s.run.upgrades[info.path]
      const label = nextTierLabel(info, level)
      btn.classList.toggle('is-hidden', label === null)
      if (label !== null) {
        effectEl.textContent = label
        // The offered tier is one past the current level (0-based) — so tier 1, 2, or 3.
        tierEl.textContent = String(level + 1)
      }
    }
  }

  private buildMessage_(): string {
    // Betting is a thin deal-gate now (no wager to show); game over paints the felt summary.
    return ''
  }

}

// A single hand's result label + tone, from its settled outcome and net chips.
// Returns undefined when the hand shows no player-side label — a voided hand is
// tagged beside the dealer's total instead (see cards.ts dealerNote).
function handResultLabel(hand: PlayerHand): RoundResult | undefined {
  if (hand.outcome === 'blackjack') {
    return { label: 'Blackjack', tone: 'win' }
  }
  if (hand.outcome === 'voided') {
    return undefined
  }
  if (hand.outcome === 'win') {
    return { label: 'Win', tone: 'win' }
  }
  if (hand.outcome === 'bust') {
    return { label: 'Bust', tone: 'lose' }
  }
  if (hand.outcome === 'lose') {
    return { label: 'Lose', tone: 'lose' }
  }
  return { label: 'Push', tone: 'push' }
}

// The reward tokens a settled hand earns (0 for a loss/push), scaled by how it
// won (see rewards.ts) — so the flown count matches what run.ts actually credits.
// The +40 dealer-kill token isn't counted here — it isn't part of the flown,
// withheld reward (see scheduleTokens).
function winTokenFor(hand: PlayerHand, round: Round): number {
  return handReward(hand, round).tokens
}

function winTokensTotal(round: Round): number {
  return round.hands.reduce((total, hand) => total + winTokenFor(hand, round), 0)
}

function now(): number {
  return performance.now()
}

function yes(): boolean {
  return true
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

// The ability guide's contents: every powerup with a one-line gloss, kept terse so all eight
// fit one screen even on mobile. Ordered to roughly follow the on-screen powerup column so the
// list is easy to cross-reference. Names match the in-game button labels.
const ABILITY_HELP: readonly { name: string; desc: string }[] = [
  { name: 'Analyze', desc: 'Show probabilities based on known info.' },
  { name: 'Peek Dealer', desc: "Reveal the dealer's hole card." },
  { name: 'Forced split', desc: 'Split any 2 cards into 2 hands.' },
  { name: 'Late double', desc: 'Double your bet anytime.' },
  { name: 'Return', desc: 'Send last drawn card to the top of the deck.' },
  { name: 'Freeze Dealer', desc: 'Prevent the dealer from drawing.' },
  { name: 'Bust Block', desc: 'Next drawn card is discarded if it causes a bust.' },
  { name: 'Mulligan', desc: 'Discard cards and redraw.' },
]

// Render an averaged 1–5 rating as filled/empty stars plus the decimal, e.g. 4.2 → "★★★★☆ 4.2".
// The star count rounds to nearest; the number keeps the precision the glyphs lose.
function ratingStars(rating: number): string {
  const filled = Math.max(1, Math.min(5, Math.round(rating)))
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)} ${rating.toFixed(1)}`
}

// Restart a one-shot CSS animation on `el`: drop the class, force a reflow so the animation
// resets, then re-add it — lets the same element replay its keyframes back-to-back instead
// of freezing after the first play.
function restartAnimation(el: HTMLElement, className: string): void {
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)
}

// A fresh <img> for the token icon. Every instance shares the one imported
// (fingerprinted) URL, so the browser downloads the asset a single time no
// matter how many pills/counters reference it.
function powerIcon(className: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = powerUrl
  img.className = className
  img.alt = ''
  img.setAttribute('aria-hidden', 'true')
  return img
}

// A fresh <img> for the yellow points star (top-right counter). Like powerIcon, every
// instance shares the one imported (fingerprinted) URL, so it downloads a single time.
function starIcon(className: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = starUrl
  img.className = className
  img.alt = ''
  img.setAttribute('aria-hidden', 'true')
  return img
}

// Whether the player can afford a powerup at its current (inflated) price.
function affords(baseCost: number, s: SessionState): boolean {
  return s.run.tokens >= powerupCost(baseCost, s.run)
}

// A powerup's "locked" pill: a red ✕ in the same bottom-right corner as the cost pill,
// hidden until the Dealer 6 duel (< 20% health) locks abilities. CSS shows it — and
// hides the cost pill — while the button carries the is-locked class.
function lockPill(): HTMLElement {
  const pill = element('span', 'lock-pill')
  pill.textContent = '✕'
  pill.title = 'Locked — final duel'
  return pill
}

// A powerup's cost pill: "<cost> <icon>", pinned to the button's bottom-right. The
// number starts at the base price and is rewritten to the inflated price each frame.
function costPill(cost: number): HTMLElement {
  const pill = element('span', 'cost-pill')
  const num = element('span', 'cost-pill__num')
  num.textContent = String(cost)
  pill.append(num, powerIcon('cost-pill__icon'))
  return pill
}

function generateSeed(): number {
  return Math.floor(Math.random() * 0x100000000)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
