// Leaderboard + personal-best facade — the single seam the game calls at run-end and the UI
// reads for the "score to beat".
//
// CrazyGames leaderboards are submit-only (the client can't read the global top score or a
// player's rank — CrazyGames shows those in its own widget), so the number we surface in-game is
// the player's LOCAL personal best, tracked here and persisted via the platform storage (SDK.data
// on-platform, else localStorage — see ../platform/crazygames). recordRun() is called exactly
// once per run at game-over — a chip bust-out, a coda bust (score 0), or a coda cash-out — and it
// both submits the score to CrazyGames and folds it into the personal best.
import { nextBest } from './highscore'
import { happytime, loadValue, saveValue, submitToCrazyGames } from '../platform/crazygames'

const BEST_KEY = 'rba.personalBest'

// Cached in memory so the per-frame coda "your best" read doesn't hit storage each call. Seeded
// lazily on first read and kept in step with saves.
let cachedBest: number | null = null

// The player's all-time best banked score (0 if none yet). Read anytime by the UI.
export function getPersonalBest(): number {
  if (cachedBest === null) {
    const raw = loadValue(BEST_KEY)
    const parsed = raw === null ? 0 : Math.floor(Number(raw))
    cachedBest = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return cachedBest
}

// Record a finished run: submit the final score to the CrazyGames leaderboard and fold it into
// the local personal best. Returns whether this run set a new best (for the score-screen flair).
export function recordRun(score: number): { previousBest: number; isNewBest: boolean } {
  const previousBest = getPersonalBest()
  const { best, isNewBest } = nextBest(previousBest, score)
  if (isNewBest) {
    cachedBest = best
    saveValue(BEST_KEY, String(best))
    // Beating an EXISTING best is a "positive moment" for CrazyGames. Guard on previousBest > 0 so a
    // player's first-ever banked score (no prior high score) does not fire it.
    if (previousBest > 0) {
      happytime()
    }
  }
  submitToCrazyGames(score)
  return { previousBest, isNewBest }
}
