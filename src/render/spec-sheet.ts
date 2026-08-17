// The dealer's active ruleset as a plain data model — the token inflation plus a list of
// flags (house rules + the player's roguelite mods). game-view's buildSpec_ builds it from
// the run/round state, and the full-screen TABLE RULES takeover (buildRulesPanel_) renders it.
//
// Import-free of the game's rules/run types: pure strings + a colour kind, so nothing here
// depends on game logic. (This module was formerly the nexus's cramped on-felt "RULES" holo
// projection; that was replaced by the DOM takeover, leaving just the shared data model.)

// One rule flag. `kind` colours it in the takeover: a HOUSE rule (the dealer's edge, teal)
// or a PLAYER mod (a roguelite buff in the player's favour, green).
export interface SpecFlag {
  // A terse CPU-style token (e.g. "S17", "SPLIT_TO_2") — the compact form.
  text: string
  kind: 'house' | 'player'
  // A plain-language expansion of `text`, shown in the TABLE RULES takeover where there's
  // room for prose (e.g. "Dealer stands on soft 17").
  label?: string
}

// The ruleset's data. `inflation` is the pre-formatted energy-inflation value (e.g. "+12%").
export interface SpecReadout {
  inflation: string
  flags: SpecFlag[]
}
