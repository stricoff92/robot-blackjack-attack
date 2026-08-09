// In-progress run persistence — save/restore/clear the whole RunState so a player can close the
// tab mid-run and pick up where they left off ("players expect persistence").
//
// We snapshot the ENTIRE RunState, not a hand-picked subset: the score multiplier is 1.5^kills,
// so kills[] must survive, and the roguelite upgrades / combo / token inflation are all live
// gameplay inputs. It's a small plain JSON object (~1 KB, well under the 1 MB SDK.data cap). The
// save is stamped with RULES_VERSION so a snapshot from an older rule set is discarded rather than
// resumed into incompatible rules. Storage goes through the platform layer: SDK.data on CrazyGames
// (synced to the player's account + across devices, debounced ~1s so per-hand saves are cheap),
// else localStorage. See ../platform/crazygames. The save is CLEARED at game-over (session
// enterOver) — a finished run must never resume.
import { loadValue, removeValue, saveValue } from '../platform/crazygames'
import { RULES_VERSION, type RunState } from './run'

const RUN_KEY = 'rba.run'

interface SavedRun {
  version: number
  run: RunState
}

export function saveRun(run: RunState): void {
  saveValue(RUN_KEY, JSON.stringify({ version: RULES_VERSION, run } satisfies SavedRun))
}

// The resumable run, or null when there's nothing to resume: no save, a parse error, a stale
// RULES_VERSION, a malformed shape, or a run that's already finished (over) or in the Banker coda
// (we never persist the coda — quitting the endgame rewinds to just before the final dealer fell).
export function loadRun(): RunState | null {
  const raw = loadValue(RUN_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SavedRun>
    if (!parsed || parsed.version !== RULES_VERSION || !isValidRun(parsed.run)) {
      return null
    }
    if (parsed.run.over || parsed.run.coda) {
      return null
    }
    return parsed.run
  } catch {
    return null
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
