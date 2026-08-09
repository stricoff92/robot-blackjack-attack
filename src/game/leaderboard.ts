// Leaderboard submission seam.
//
// The CrazyGames leaderboard SDK wiring lands in a separate pass. For now this is the single
// choke point every game-end funnels through (chip bust-out, coda bust, coda cash-out), so
// hooking up the SDK later is a one-function change. Called once per run, at game-over, with
// the final score — which on a coda bust is 0 (you gamble the whole score, record included).
export function submitScore(score: number): void {
  // TODO(leaderboard): submit `score` to the CrazyGames leaderboard SDK when it's wired up.
  void score
}
