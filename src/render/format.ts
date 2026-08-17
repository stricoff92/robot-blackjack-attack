// Compact number formatting for the live HUD readouts — the top-right score
// counter, the bankroll chip pile, and the per-hand bet/winnings piles. Anything
// under 1000 shows exact; from 1000 up it collapses to a K/M/B suffix carrying at
// most one decimal (1100 → "1.1K", 12500 → "12.5K", 1.3M), so a big total never
// sprawls out of its corner. Intl's compact notation handles the unit boundaries
// (999999 → "1M") for free. Results screens keep the full toLocaleString number —
// this is only for the always-on, space-constrained counters.
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

// Abbreviate an integer count for a HUD readout: exact below 1000, K/M/B above.
export function abbreviateCount(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  // Under 1000 stays exact (per the readout spec). Compact would render these the
  // same, but the guard documents the contract and skips the formatter.
  if (Math.abs(value) < 1000) {
    return String(value)
  }
  return compactFormatter.format(value)
}
