// In-progress run persistence — save/restore/clear the whole SESSION so a player can close the tab
// mid-run (or mid-hand, or mid-coda) and pick up EXACTLY where they left off. We persist not just
// the RunState but the live phase + the in-progress round + the transient flags a refresh must
// preserve. That exactness is the anti-cheat: without it, a refresh rewound to the last stable
// checkpoint, and because the deck is deterministic (see [[run-persistence]]) that checkpoint
// re-dealt the very hand you were in — letting you replay a lost hand (worst of all, escape the
// bankruptcy coda) with full foreknowledge. Resuming the exact round instead makes a refresh a
// no-op: same cards, same turn, no advantage.
//
// We snapshot the ENTIRE RunState (the score multiplier is 1.5^kills, so kills[] must survive, and
// upgrades / combo / token inflation are all live inputs) plus the Round (which carries the whole
// shoe — a few KB, still far under the 1 MB SDK.data cap). The save is stamped with RULES_VERSION
// so a snapshot from an older rule set (or the pre-resume-exact save shape) is discarded rather
// than resumed into incompatible state. Storage goes through the platform layer: SDK.data on
// CrazyGames (synced to the account + across devices, debounced ~1s so per-action saves are cheap),
// else localStorage. The save is CLEARED at game-over (session enterOver) — a finished run never
// resumes.
import { loadValue, removeValue, saveValue } from '../platform/crazygames'
import { decodeSaveKeys, encodeSaveKeys } from './keymap'
import { pack, unpack } from './obfuscate'
import type { Round } from './round'
import { RULES_VERSION, type RunState } from './run'
import type { Phase } from './session'

const RUN_KEY = 'rba.run'

// A resumable phase. Excludes 'over' (a finished run is cleared, never persisted) and
// 'choosing-upgrade' (a transient gate — its prior 'resolved' checkpoint already carries
// upgradePending, so a refresh there resumes to resolved → Next → pick). The UI resumes the rest:
// betting auto-deals the next hand, playing/resolved paint the in-progress hand, coda paints the
// double-or-nothing table.
export type ResumablePhase = Exclude<Phase, 'over' | 'choosing-upgrade'>

// The full session snapshot we persist and restore. Mirrors the resume-relevant Session fields;
// the purely visual / re-derivable ones (analysis readout, last-hit risk, star-rating decisions)
// are intentionally omitted — they cost nothing to reset and reset gives no exploit.
export interface PersistedSession {
  run: RunState
  phase: ResumablePhase
  round: Round | null
  peeked: boolean
  codaRedeal: boolean
  upgradePending: boolean
}

interface SavedSession extends PersistedSession {
  version: number
}

const RESUMABLE_PHASES: ReadonlySet<string> = new Set<ResumablePhase>([
  'betting',
  'playing',
  'resolved',
  'coda',
])

export function saveSession(session: PersistedSession): void {
  // encodeSaveKeys() renames the fields to short codes (so a decoded save doesn't read as a
  // labelled map of what to edit), then pack() base64-wraps + checksums the payload so a casual
  // save-editor is deterred and edits are detected on load — not because localStorage can be truly
  // secured. See ./keymap and ./obfuscate.
  saveValue(RUN_KEY, pack(encodeSaveKeys({ version: RULES_VERSION, ...session } satisfies SavedSession)))
}

// The resumable session, or null when there's nothing to resume: no save, a parse error, a stale
// RULES_VERSION (this includes the pre-resume-exact save shape), a malformed run, an unresumable
// phase, or a run that's already finished (over). A coda IS now resumable (previously rejected) —
// that's the fix for the bankruptcy/victory coda refresh escapes.
export function loadSession(): PersistedSession | null {
  const raw = loadValue(RUN_KEY)
  if (!raw) {
    return null
  }
  // unpack() returns null if the envelope is missing/corrupt or the checksum fails (tampered);
  // decodeSaveKeys() then restores the real field names (a no-op on null). The checksum has already
  // validated the payload, so decode only ever runs on data we produced.
  const parsed = decodeSaveKeys(unpack(raw)) as Partial<SavedSession> | null
  if (!parsed || parsed.version !== RULES_VERSION || !isValidRun(parsed.run)) {
    return null
  }
  const run = parsed.run
  if (run.over) {
    return null // a finished run must never resume
  }
  if (typeof parsed.phase !== 'string' || !RESUMABLE_PHASES.has(parsed.phase)) {
    return null
  }
  const phase = parsed.phase as ResumablePhase
  // A mid-hand ('playing') save must carry its round, or there's nothing to resume. Betting has no
  // round; resolved/coda may or may not (coda sits at a prompt between gambles).
  const round = parsed.round ?? null
  if (phase === 'playing' && round === null) {
    return null // a mid-hand save with no hand is corrupt
  }
  // Backfill the deck-stream position for a save missing deckState (defensive): resume the deal RNG
  // from the run's origin seed. `seed >>> 0` coerces a missing seed to 0 rather than NaN.
  if (typeof run.deckState !== 'number' || !Number.isFinite(run.deckState)) {
    run.deckState = run.seed >>> 0
  }
  return {
    run,
    phase,
    round,
    peeked: parsed.peeked === true,
    codaRedeal: parsed.codaRedeal === true,
    upgradePending: parsed.upgradePending === true,
  }
}

export function clearRun(): void {
  removeValue(RUN_KEY)
}

// A light structural guard against corrupt/tampered saves — enough that adopting the run won't
// throw downstream. Checks the numeric fields the engine reads and the presence of the arrays/
// objects it indexes, not a full deep validation.
function isValidRun(run: unknown): run is RunState {
  if (typeof run !== 'object' || run === null) {
    return false
  }
  const r = run as Record<string, unknown>
  const numbers = ['chips', 'score', 'tokens', 'shiftIndex', 'integrity', 'combo', 'handsPlayed']
  if (!numbers.every((key) => typeof r[key] === 'number' && Number.isFinite(r[key]))) {
    return false
  }
  return Array.isArray(r.kills) && typeof r.upgrades === 'object' && r.upgrades !== null
}
