// Save-payload key obfuscation — the second half of "make the save opaque" (the first being the
// base64 + checksum envelope in ./obfuscate). pack() already hides the VALUES at a glance, but a
// base64-decode still reveals the field NAMES (`wins`, `score`, `integrity`, …), which hands a
// casual save-editor a labelled map of exactly which number to bump. This module renames every
// serialized key to a short opaque code before packing and reverses it on load, so a decoded save
// reads as `{"ws":12,"sc":0,…}` — structure obscured, not just the digits.
//
// Like ./obfuscate this is a speed bump, not encryption: the codes ship in the bundle, so a
// determined attacker can read this table and undo it. It exists to make the save non-trivial to
// hand-edit, in step with the run-persistence threat model. See [[run-persistence]].
//
// The transform is generic (a recursive key rewrite), but the dictionary is tuned for the
// SavedRun shape: { version, run: RunState { …, upgrades: RunUpgrades } }. Keys not in the table
// pass through unchanged — so a not-yet-mapped field is left readable (harmless) rather than
// dropped, and a legacy readable save still de-obfuscates cleanly (no real field name equals a
// code — see the length invariant below). Adding a serialized field means adding a code here; the
// keymap.test.ts "no field name leaks" check fails until you do.

// Full field name → short code, covering every key in a serialized SavedRun. INVARIANT: every
// code is exactly two chars and every real field name is longer, so a field name can never be
// mistaken for a code on decode (guarded by a test). Codes are otherwise arbitrary and must stay
// stable — changing one orphans existing saves (they'd fail to de-obfuscate; harmless, but a
// player loses their in-progress run).
const KEY_CODES: Readonly<Record<string, string>> = {
  // Envelope (SavedRun)
  version: 'vn',
  run: 'rn',
  // RunState
  seed: 'sd',
  deckState: 'dk',
  score: 'sc',
  tokens: 'tk',
  shiftIndex: 'si',
  handsThisDealer: 'hd',
  handsPlayed: 'hp',
  wins: 'ws',
  integrity: 'ig',
  healsThisDealer: 'hz',
  hitPoints: 'ht',
  roundWins: 'rw',
  handLog: 'lg',
  tokenInflation: 'tf',
  tokensThisShift: 'ss',
  kills: 'kl',
  handsWon: 'hw',
  handsLost: 'hl',
  tokensSpent: 'sp',
  freeDoubleWins: 'fw',
  busts: 'bu',
  blackjackWins: 'bj',
  pushes: 'pu',
  ratingSum: 'rs',
  ratedHands: 'rh',
  over: 'ov',
  won: 'wn',
  coda: 'cd',
  cashedOut: 'co',
  rewardedAdsThisRun: 'ra',
  rewardedAdShiftIndex: 'rx',
  upgrades: 'ug',
  // RunUpgrades
  antiDealer: 'ad',
  chipEco: 'ce',
  tokenEco: 'te',
  // Session envelope (resume-exactly): the live phase + in-progress round + the transient flags a
  // refresh must preserve, so a mid-hand / coda reload resumes precisely, never replaying a hand.
  phase: 'ph',
  round: 'rd',
  peeked: 'pk',
  codaRedeal: 'cr',
  upgradePending: 'up',
  // Round
  shoe: 'sh',
  drawIndex: 'di',
  hands: 'ha',
  activeIndex: 'ai',
  dealer: 'de',
  rules: 'ru',
  status: 'ts',
  secondChanceArmed: 'sa',
  burned: 'bn',
  dealerFrozen: 'df',
  mulliganed: 'mu',
  discarded: 'dc',
  // PlayerHand
  cards: 'ca',
  bet: 'be',
  doubled: 'db',
  splitAce: 'sl',
  finished: 'fn',
  busted: 'bt',
  outcome: 'oc',
  chipsOnly: 'cy',
  freeDoubled: 'fd',
  // RoundRules
  dealerSoft17: 's7',
  dealerHardHitCeiling: 'hh',
  allowSplit: 'al',
  pushWinsToPlayer: 'pw',
  voidDealer21: 'v2',
  hijackDealerNatural: 'hj',
  dealer21Energy: 'd2',
  tokenMultiplier: 'tm',
  // Card
  rank: 'rk',
  suit: 'su',
}

// Inverse (code → field name). Built once; the map has no duplicate codes, so this is lossless
// (a collision would be caught by the round-trip test on a full RunState).
const CODE_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KEY_CODES).map(([name, code]) => [code, name]),
)

// Rewrite a value with obfuscated keys, ready to hand to pack().
export function encodeSaveKeys(value: unknown): unknown {
  return remapKeys(value, KEY_CODES)
}

// Reverse encodeSaveKeys() on a value that came back from unpack(). Non-objects (including the
// null unpack() returns on a bad save) pass straight through.
export function decodeSaveKeys(value: unknown): unknown {
  return remapKeys(value, CODE_KEYS)
}

// Recursively rebuild `value`, renaming object keys via `map` (unmapped keys kept as-is). Arrays
// are recursed element-wise (NOT treated as objects — their numeric indices must never be
// renamed), and primitives/null are returned unchanged. Always returns fresh objects, never
// mutating the input (the live RunState is shared).
function remapKeys(value: unknown, map: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remapKeys(item, map))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[map[key] ?? key] = remapKeys(inner, map)
    }
    return out
  }
  return value
}
