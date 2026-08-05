# ROBOT BLACKJACK ATTACK — Game Rules

A solo, free-to-play web game. You sit down across from a machine that deals blackjack and fight your way up a ladder of dealers. Destroy all six and you win the run; run out of chips first and the house shuts you down. The bet climbs relentlessly, so most runs end in bust-out — the question is how far up the ladder you get.

**Win condition:** destroy all six dealers. **Lose condition:** run out of chips. **Goal:** clear the run, or — failing that — the highest score before the house shuts you down.

> **On the name.** It's a nod to *Robot Unicorn Attack*, whose mechanics were a completely generic endless runner — the identity was entirely presentation. Same approach here: almost nothing below is mechanically "robot." The fiction does the work, and the one genuine addition (the dealer's health gauge, §4) is a single counter.
>
> Keep the riff at the name level. Don't reproduce the pastel-and-dolphins look or license anything near that soundtrack — a nod is fine, a costume is a takedown.

> **Revision note (2026-08-05).** Synced to the prototype. Changes since the last note:
> - **There is now a win condition.** Destroying all six dealers wins the run (§3); it is not a guaranteed loss.
> - **Bet ladder softened** to a gentler ~1.6×/dealer curve (§3), topped up by a per-kill bankroll grant so the escalating floor stays survivable.
> - **Damage and tokens are now scaled by *how* you won** (the standing dealer total you beat), not flat values (§4, §6).
> - **The full powerup roster is nine** (§7), not four.
> - **Roguelike upgrades added** (§8): a permanent, choose-one-of-three pick after each kill.
> - **Hit-token farm closed:** the +token on a hit is credited only on a hand that survives (§6).

> **Revision note (2026-08-02).** Earlier rewrite to match the prototype, which diverged from the original design: the charge meter and house-rules module were removed, "surviving a dealer" was replaced by *destroying* it (§3, §4), the player no longer chooses a bet (§5), dealers are numbered, the gauge is "health" not "integrity", and the word "shift" is never shown (code internals still use `shiftIndex`/`integrity`). The original simulation figures (median 31 hands, etc.) assumed the old model and no longer apply.

---

## 1. Setup

| | |
|---|---|
| Starting chips | 300 |
| Starting tokens | 0 |
| Starting score | 0 |
| Dealer health | 100 (each dealer) |
| Dealers to win | 6 |
| Shoe | 6 decks, **reshuffled after every hand** |

The reshuffle is deliberate: it removes card counting entirely, which keeps Peek Deck a tactical tool rather than the seed of a hidden metagame.

---

## 2. Base blackjack rules

Standard, with the fiddly bits trimmed:

- Blackjack pays **3:2**
- Dealer **stands on all 17**, including soft 17
- Double down on any first two cards
- Split up to three times (four hands max); split aces receive one card each and cannot be re-split
- **No insurance.** It's a trap bet that teaches nothing and clutters the UI
- **No surrender** at baseline (see Open Questions)

*(The engine keeps these as configurable `RoundRules` — e.g. dealer-hits-soft-17, 6:5 payout — but the defaults above are the only ones in play. Roguelike upgrades (§8) can bend some of them mid-run: the Payout path raises blackjack to 3:1 and lets a 20/21 count as a natural, and the Sabotage path rewrites how the dealer's natural and standing total resolve.)*

---

## 3. The dealer ladder

This is the engine that makes the game finite. You face one dealer at a time. **The only way past a dealer is to destroy it** — drain its health to 0 (§4). Destroy it and a heavier model takes the chair; the bet floor rises and the score multiplier rises with it. **Destroy the sixth and you win the run.**

| Dealer | Min bet | Max bet | Score × |
|---|---|---|---|
| 1 | 10 | 100 | 1.0 |
| 2 | 15 | 150 | 1.5 |
| 3 | 25 | 250 | 2.0 |
| 4 | 40 | 400 | 3.0 |
| 5 | 65 | 650 | 4.0 |
| 6 | 100 | 1,000 | 5.5 |
| 7+ | ×2.5 each dealer | 10× min | **+1.5 flat** each dealer |

Max bet is always 10× the minimum. There is no dealer beyond the sixth in a normal run — clearing it ends the run in a win — but the extrapolation row exists so the maths never falls off a table.

**The min-bet floor climbs ~1.6× per dealer** — gently enough that a flat bankroll, topped up by the per-kill grant (§4), can keep pace instead of starving the run outright. It still compounds, so late dealers force much bigger bets than early ones.

**The score multiplier grows linearly on purpose.** Score is chips × multiplier (§9). If both the bet floor *and* the multiplier compounded, score would quadruple per dealer and the leaderboard tail would run away (a p90 run scoring hundreds of times the median — a lottery, not a skill ranking). The bet floor has to escalate to pressure the player; the multiplier must stay linear so the top of the board stays reachable.

**Why the pressure matters:** blackjack played well has roughly a 0.5% house edge, so without escalation a patient player never busts out and the run never resolves. The rising bet floor — plus the within-dealer bet climb in §5 — forces escalating risk on everyone and makes late hands worth an order of magnitude more than early ones.

Numbering the dealers (rather than naming them) keeps the death-screen résumé (§12) legible — "destroyed Dealer 3, fell to Dealer 4" — without hardcoded character names.

---

## 4. Dealer health

Every dealer has a health bar starting at **100**. It drains as you play, and **emptying it destroys the dealer** — that is the kill condition, the third word in the title made literal, and the *only* way to advance.

### Damage

Damage comes only from **winning a hand**, and scales by *how* you won — beating a higher standing dealer total is harder, so it hits harder. A dealer that busts itself is the weakest win of all (you didn't have to outdraw anything). Losses, pushes, and busts deal **nothing**.

| How you won | Damage |
|---|---|
| Dealer busts | 12 |
| Beat a standing 17 | 22 |
| Beat a standing 18 | 30 |
| Beat a standing 19 | 40 |
| Beat a standing 20 | 52 |
| Natural blackjack | 42 |

So the ladder is: dealer bust `<` beat 17 `<` beat 18 `<` beat 19 `<` beat 20, with a natural blackjack sitting as its own premium just under the top. (A Freeze Dealer win, §7, always grades as the 17 tier — you can't pin a fat dealer to farm the high tiers.) The token reward (§6) moves on the same tiers.

**Busting wastes your attack.** Bust first and the dealer never draws, so it takes nothing — not even from a hand you'd otherwise have won. Busting already costs you your bet; now it also wastes an attack. This gives standing on a stiff 15 a real reason to exist.

### There is no deadline

A dealer stays in the chair until you destroy it — there's no timer and no way to pass one you can't beat. If you can't drain its health, you keep playing (and the bet keeps climbing, §5) until you go broke on it.

### Destroying a dealer pays

Emptying a dealer's health awards:
- **+40 tokens** (§6), scaled by the Token upgrade if you have it (§8)
- **+150 × dealer number** to score (§9)
- a **bankroll grant of 3 × the next dealer's minimum bet**, so the escalating floor (§3) stays survivable instead of starving the run
- **one roguelike upgrade pick** (§8) — except on the sixth kill, which wins the run
- advance to the next dealer; health resets to 100 and the within-dealer bet climb resets (§5)

### Balance

Damage numbers are the dial. Raising the dealer-bust value makes destruction routine; dropping the higher tiers makes dealer-busts nearly the only source, which turns the mechanic into something you passively hope for rather than build toward. Because damage comes only from *winning*, there's no way to grind a dealer's health down for free.

---

## 5. Betting

The player does not choose a bet. The game sets a fixed bet each hand:

```
bet = dealerMinBet × (1 + handsAgainstThisDealer × 0.5)
      capped at the dealer's max bet and at your current chips
```

`handsAgainstThisDealer` starts at 0 for each new dealer and resets when you destroy one. So the bet is a **sawtooth**: each dealer opens at its minimum and climbs the longer the fight drags on.

- Dealer 1: 10 → 15 → 20 → 25 → …
- Destroy it → Dealer 2 opens fresh at 15 → 23 → 30 → …

This does the work the old "rising floor" did — escalating risk over time — but it also quietly rewards **destroying fast**, since a dragged-out fight inflates your own bet and bleeds you toward bust-out. The `0.5` step is the main run-length knob (§11).

---

## 6. Tokens

Tokens are the powerup currency (§7). Unlike the old Charge meter, they're earned **directly from what you do at the table**:

| Action | Tokens |
|---|---|
| Hit (and survive) | +1 to +10, scaled by how risky the hit was |
| Win — dealer busts | +4 |
| Win — beat a standing 17 / 18 / 19 / 20 | +8 / +12 / +16 / +22 |
| Natural blackjack | +21 |
| Destroy a dealer | +40 |

- **Hit tokens are risk-priced.** A safe hit pays the base +1; a hit that was very likely to bust but landed anyway pays up to +10. Because a risky hit rarely survives to be paid, the expected value stays modest — it rewards nerve without inflating the economy. The token is credited **only if the hand survives**; a bust earns nothing (this closes the old hit-into-bust farm).
- **Win tokens move on the same tiers as damage** (§4): beating a higher standing total pays more.
- Win/blackjack tokens are awarded per hand, so a swept split pays for each winning hand.
- The **Token roguelike upgrade** (§8) multiplies every token reward above by ×1.05 / ×1.10 / ×1.20.
- **No cap.** Tokens accumulate freely, because the powerup costs are large.

---

## 7. Powerups

Bought with tokens (§6), spent during your turn. Costs escalate with how reliable and powerful the effect is — cheap information, expensive certainty:

| Powerup | Cost | Effect |
|---|---|---|
| **Analyze** | 4 | Read your bust-on-hit odds and the dealer-win odds for the current spot. Folds in anything you've already peeked. Clears the moment you act. |
| **Peek Dealer** | 10 | Reveal the dealer's hole card. |
| **Late double** | 30 | Double down after you've already taken hits. |
| **Forced split** | 30 | Split your opening two cards even when they aren't a matching pair. |
| **Return** | 50 | Push your most recently drawn card back onto the shoe (the dealer draws it next), then stand. |
| **Freeze Dealer** | 70 | Force the dealer to stand on its current two-card total — it takes no draws. |
| **Bust Block** | 90 | One expendable shield against busting. See below. |
| **Mulligan** | 100 | Discard your untouched opening hand and redeal it once. |
| **Peek Deck** | 150 | See the next card in the shoe. |

Bust Block is priced below Peek Deck on purpose. Peek Deck is reliable certainty — see the card, decline the hit, never bust — whereas Bust Block is conditional and can whiff (nothing to shield if you weren't going to bust, or a second bust on the re-roll). So Peek Deck is the expensive, reliable power and Bust Block is the cheaper, swingier "upside" play — the one that can turn a dead 16 into a live 20.

The **Peek Deck → Late double** combo (see the next card, then double into it) is the signature offensive play; at 180 tokens combined it is a deliberate commitment. **Analyze** is priced as near-free on purpose: it sells *information*, not an outcome, and is meant to be a rote learning aid for reading a spot before you commit to a pricier tool.

### Bust Block (detail)

Declare it before hitting. It applies to your **next single draw**:

> If the drawn card would bust you, it is burned face-up to the discard pile and one replacement card is drawn. Whatever that card is, it stands. The shield is spent either way.

One shield, one hit, one re-roll. Success odds by hand total:

| Your total | Safe cards | Survives |
|---|---|---|
| 12 | A–9 | ~90% |
| 13 | A–8 | ~85% |
| 14 | A–7 | ~79% |
| 15 | A–6 | ~71% |
| 16 | A–5 | ~62% |
| 19 | A–2 | ~28% |
| 20 | A only | ~15% |

It's useful across every stiff hand — near-safe on a 12, a real gamble on a 16 — and dismal on high totals, so **standing on 20 remains correct** and the shield can never be farmed into an automatic 21.

Show the burned card face-up as it's discarded. It's the most dramatic beat in the game.

---

## 8. Roguelike upgrades

After destroying a dealer, you permanently unlock **one tier of one of three paths**. There is no token cost — the choices only ever help you. A pick is offered after each of the first five kills (the sixth wins the run), so a single path can be maxed but not all three: **every pick is a real trade-off.**

Tiers within a path unlock **in order** (1 → 2 → 3). The choose-upgrade screen appears once the new dealer has walked in, showing three large coloured buttons — Sabotage (red), Payout (blue), Tokens (green) — each labelled with the *next* tier it would unlock. A fully-maxed path's button disappears. There is no on-screen readout of what you've already picked.

### Sabotage — turn the dealer's edge against it

| Tier | Effect |
|---|---|
| 1 | **60% refund** on a loss to the dealer's natural blackjack. |
| 2 | **Hijack** the dealer's natural blackjack: you take it *as your own* natural blackjack (paid at the blackjack rate — so it respects the Payout 3:1 upgrade below — and dealing the blackjack damage/tokens). |
| 3 | The dealer's standing total counts as **1 lower** whenever it's under 21 (applied after the dealer stands — it drives both who wins and the reward tier). |

### Payout — bigger chip returns

| Tier | Effect |
|---|---|
| 1 | Natural blackjack pays **3:1** (instead of 3:2). |
| 2 | Your **21 counts as a natural blackjack**: the moment your hand reaches 21 it resolves instantly — the dealer draws nothing; a dealt dealer natural pushes, otherwise you win as a blackjack. |
| 3 | Your **20 counts as a natural blackjack** too (same instant resolution). |

### Tokens — a fatter economy

| Tier | Effect |
|---|---|
| 1 | **+5%** tokens on every reward (×1.05). |
| 2 | **+10%** tokens (×1.10). |
| 3 | **+20%** tokens (×1.20). |

The Token tiers *replace* one another (the top is a flat ×1.20, not a stack). The multiplier applies to every token source in §6 — hits, wins, blackjacks, and the kill bounty.

**Shape.** Every upgrade is a pure buff, so the system is a straight difficulty reduction — deliberately, since reaching the later dealers was the pain point. It **snowballs the late game** more than it eases the first few dealers (you enter Dealer 1 with zero picks), which is the intended roguelite arc: an early skill check, then a compounding power fantasy once you survive to bank a couple of picks.

---

## 9. Score

Score is a separate ratchet from chips. It **never decreases**.

```
score += (chips won on the hand) × current dealer multiplier
```

Blackjack paying 3:2 (or 3:1 with the Payout upgrade, §8) therefore scores more automatically. Plus:

- **Destruction bonus:** `150 × dealer number`, awarded when you destroy a dealer.

Two viable emphases fall out of this: a careful player banks destruction bonuses on the way up; an aggressive player scores through the multiplier on big late-hand wins. The rising bet eventually drags everyone toward the aggressive style. Winning the run (all six dealers) naturally maximises both.

---

## 10. Going broke

When your chips fall below the dealer's minimum bet, you're on **last call**: the fixed bet (§5) automatically becomes everything you have. Win and you're back on a short stack; lose and the run ends.

This produces the single most memorable moment in every losing run, and it costs nothing to build — the bet formula already caps the bet at your chips.

Unspent tokens and unlocked upgrades are **not** converted to anything at bust-out — they last only for the run. Spend the tokens or lose them.

---

## 11. Tuning knobs

Difficulty lives in a handful of places:

1. **The within-dealer bet step** (`0.5` in §5). Bigger → the bet climbs faster within a dealer → shorter, tenser runs.
2. **The minimum-bet curve** (~1.6× per dealer through the table, ×2.5 past it). Gentler → runs stop ending reliably; steeper → the early dealers blur past before the player learns the systems.
3. **The per-kill bankroll grant** (`3 ×` the next min bet, §4) and **dealer health** (100) and the **damage tiers** (§4). Together these set how survivable the ladder is and how many hands it takes to destroy a dealer.
4. **Token rewards** (§6) and **powerup costs** (§7). These set how often a player actually gets to use the fun part.
5. **The roguelike upgrades** (§8). Being pure buffs, they're the strongest lever on win rate; the current set targets a punishing but achievable clear.
6. **The score multiplier must stay linear** (§3). This is not a taste knob — making it compound reintroduces the runaway leaderboard tail.

Starting chips barely matter past the first couple of dealers — don't tune there.

---

## 12. Art direction

The obvious read on this name is grimdark neon cyberpunk casino. That's the wrong one.

*Robot Unicorn Attack* worked because it was sincere and sweet underneath a violent title — the contrast was the joke, and the game never once winked at it. The version of this that lands is a relentlessly cheerful dealer robot, warm colors instead of neon, and an over-emotional synthpop track played completely straight. The violence lives in the name and the explosions and nowhere else. Earnest, not edgy.

Concretely:

- **The dealers are polite.** Each one congratulates you on your wins and stays warm and encouraging while taking everything you own. Nobody threatens the player, ever. Personality comes from art and voice, not from on-screen names — the UI just says "Dealer 1", "Dealer 2", and so on.
- **Overheating is spectacular and bloodless** — steam, popped panels, a small apologetic chirp, a dealer wheeled off by an even smaller robot.
- **Warm felt.** Burnt orange, cream, brass. Reserve the only cold color in the palette for the health gauge, so it reads instantly.
- **One track, no shuffle.** Committing to a single song is a large part of what made the reference work.
- **The end screen is a résumé of the run** — the dealers you destroyed, in order, and either the one you fell to or a clean sweep of all six, with your score. That's the shareable artifact, and it's the reason the ladder in §3 exists at all.

---

## 13. Technical: shuffling and score verification

**Every run gets its own freshly generated random seed.** Seeded does not mean shared and does not mean less random — it means *reproducible*. A seeded shuffle is a real shuffle that starts from a known number, so replaying with that number reproduces the identical sequence.

```js
// Unreproducible, unverifiable
shuffle(deck);

// Equally random, but replayable
const rng = mulberry32(seed);
shuffle(deck, rng);
```

The prototype already does this: the deal logic is pure and deterministic, and it uses a seeded mulberry32 PRNG threaded through the shuffle — no `Math.random()` anywhere in deal logic. A `RULES_VERSION` constant (currently 4) is stored so retuned rewards don't silently validate old replays.

**Still to build:** logging the player's action sequence (hit, stand, double, split, token spends, upgrade picks) alongside the seed. That pair — seed plus actions — is a complete, verifiable recording of a run: a server that knows the seed replays the identical deal, computes the score itself, and trusts nothing the client sent. Replay validation is unusually cheap here (turn-based, no timing, a short input vocabulary; a full run is a couple of kilobytes). Doing it now is nearly free; retrofitting it once randomness is scattered through the deal code is not.

### Why not a daily challenge

A daily challenge — everyone shares one seed so the run becomes a skill contest — is a *different* feature and a bad fit here. Two reasons:

**Divergence is immediate.** In a platformer with a daily seed the level is fixed no matter what you do. In blackjack, if I hit and you stand, every subsequent card shifts — same shoe, completely different game from hand two onward.

**The deck leaks, and this game can't survive that.** Peek Dealer and Peek Deck are core powerups, and the token economy assumes card information is scarce. Share a seed and the first hundred players map the deck and post it; by afternoon everyone knows the hole card on hand seven for free, and those powerups are worthless.

If you want a daily anyway, the least-bad version seeds **per hand rather than per shoe**, so hand 5 is the same starting position for everyone regardless of hands 1–4. It does nothing about the information leak. Nothing does.

*(Dev note: URL query params can force specific hands, upgrades, and dealers on the dev server for testing — see [`dev-params.md`](dev-params.md).)*

---

## 14. Open questions for playtest

- **Do runs end at the right length, and win at the right rate?** Run length is set by the bet climb (§5) draining chips vs how fast you destroy dealers, and the roguelike upgrades (§8) tilt the back half toward a clear. Target a punishing-but-achievable win rate and roughly 8–15 minutes; the `0.5` bet step, the bet curve, and the upgrade strengths are the dials.
- **Are the upgrades balanced against each other?** Sabotage and Payout are far stronger than Tokens; watch whether Tokens is ever picked, and whether a maxed Sabotage/Payout trivialises the late game.
- **Can a player get stuck?** Because advancing requires destroying, a cold streak on a dealer you can't damage just bleeds you out on it. Is that tense (good) or frustrating (bad)?
- **Are the powerup costs right?** Nine powerups now compete for tokens (§7). Watch whether the cheap information tools (Analyze 4, Peek Dealer 10) become rote every-hand buys, and whether the expensive certainty (Peek Deck 150, Mulligan 100) ever gets bought once upgrades are also draining attention.
- **Is Late double / Forced split ever bought?** They share a slot with each other in the UI; if either sees little use, reconsider its price or presentation.
- **Which leaderboard shape?** A global all-time board is forgeable and gets colonized by cheaters. A board that resets daily makes forged scores evaporate, and a percentile line on the end screen ("you beat 84% of today's runs") has no throne to defend. Decide this before wiring up any SDK.
- **Surrender as a meta-unlock?** Late surrender is a real strategic tool and would make a good permanent unlock after a first bust-out — a reason to start run two.
