// Pure personal-best logic — no I/O, unit-tested. The storage + CrazyGames SDK wiring lives in
// src/platform/crazygames.ts; the orchestration (submit + persist) in src/game/leaderboard.ts.

// Fold a finished run's score into the running personal best. Only a strictly higher, positive,
// finite score sets a new best — a coda bust (score 0) never becomes a record, and a tie holds
// the existing best. Non-finite / negative inputs are floored to 0 so junk can't poison the best.
export function nextBest(currentBest: number, score: number): { best: number; isNewBest: boolean } {
  const best = Number.isFinite(currentBest) && currentBest > 0 ? Math.floor(currentBest) : 0
  const clean = Number.isFinite(score) && score > 0 ? Math.floor(score) : 0
  if (clean > best) {
    return { best: clean, isNewBest: true }
  }
  return { best, isNewBest: false }
}
