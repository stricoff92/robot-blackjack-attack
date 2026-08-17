# ROBOT BLACKJACK ATTACK — Game Rules

A solo, free-to-play web game. You sit down across from a machine that deals blackjack and fight your way up a ladder of six dealers. Each dealer deals you a **fixed window of hands**; land enough winning hands to **destroy** it before the window runs out. You are playing for one thing — **points** — and a lost hand is a *missed opportunity*, never a drain. After the sixth dealer, the Banker steps in for a double-or-nothing coda on your whole score.

**There is no bust-out.** The run is a fixed six-dealer gauntlet: kill a dealer for a roguelite upgrade and a big point cash-in, or run out its window and it walks off (no upgrade). **Goal:** the highest score you can bank across the six dealers, then risk it — or keep it — in the coda.

> **On the name.** It's a nod to *Robot Unicorn Attack*, whose mechanics were a completely generic endless runner — the identity was entirely presentation. Same approach here: almost nothing below is mechanically "robot." The fiction does the work, and the one genuine addition (the dealer's health, §4) is a single small counter.
>
> Keep the riff at the name level. Don't reproduce the pastel-and-dolphins look or license anything near that soundtrack — a nod is fine, a costume is a takedown.

> **Revision note (2026-08-11, v30 — the "points, not survival" economy rework).** The whole economy was retargeted. Chips / bankroll / the bet ladder / bust-out are **gone**, and so is the old hit-streak combo multiplier. The changes below fold into `RULES_VERSION = 30` (v29 introduced the rework; v30 then dropped the combo multiplier — older saves are discarded on load). Earlier revision notes (v4–v28: bet ladders, wealth floor, chip payout, the old damage tiers) are in git history — they describe removed mechanics and are not repeated here.
>
> - **Dealer health is now an integer HIT count** (§4): 5 hits at Dealer 1 up to 10 at Dealer 6. Every winning hand lands exactly **1 hit** (×weight, below), flat — flashy and scrappy wins kill equally, so there's no reason to avoid the flashy ones.
> - **Each dealer deals a fixed WINDOW of hands** (§3): run it out without killing the dealer and it **walks off with no upgrade**. This is the opportunity cost that makes killing *fast* matter.
> - **A kill cashes in every remaining window slot as a bonus win** (§9): so killing early is strictly best (guaranteed bonus wins that also raise your score rate for the rest of the run), and there's no way to "milk" a dealer.
> - **Score is per-win off a cumulative counter** (§9): `10 × 1.12^(wins−1)`, so every win permanently raises your rate for all future wins. The old `chips × dealerMultiplier` and the flat kill score-bounty are gone.
> - **Doubles & splits carry their risk as *weight*** (§5): a double win = 2 hits / 2 wins, a double loss = 2 window slots; each split hand wins/loses independently. This replaces the old chip bet exposure.
> - **Pushes never consume a window hand** (§5): a single/doubled push **redeals**; a split-hand push has no effect. Payout T3 turns pushes into wins.
> - **The Banker coda always fires at the end of Dealer 6** (§10) — whether you killed it (boss death → Banker walk-in) or ran out its window (walk-off → Banker walk-in). No score tax.
> - **Payout & Sabotage upgrade paths re-themed** to points effects (§8); the Tokens (Energy) path and the whole token economy (§6, §7) are unchanged.

---

## 1. Setup

| | |
|---|---|
| Starting tokens (ENERGY) | 100 |
| Starting score | 0 |
| Dealer health | **5 → 10 hits**, scaling per dealer (§3, §4) |
| Dealers to win | 6 |
| Shoe | 6 decks, **reshuffled after every hand** |

There are no chips and no bet — the player never stakes money. The reshuffle-every-hand is deliberate: it removes card counting entirely, which keeps card-peek powerups a tactical tool rather than the seed of a hidden metagame.

---

## 2. Base blackjack rules

Standard, with the fiddly bits trimmed:

- Dealer **stands on all 17** — *except the later dealers* (§3): **Dealers 3–5 hit soft 17** (H17), and **Dealer 6 plays a smart 17** — it draws (soft *or* hard) only when standing wouldn't already beat you. A real, escalating house edge.
- Double down on any first two cards (see §5 — a double is worth **two** window slots).
- Split once, into two hands (no re-splitting); split aces receive one card each. Each split hand resolves independently (§5).
- **No insurance.** It's a trap bet that teaches nothing and clutters the UI.
- **No surrender** at baseline (see Open Questions).

**Early dealers rarely (or never) open on a strong face-up card — a per-dealer up-card rail.** A dealer's *up-card* being a "10/11" (an Ace or any ten-value card) is silently discarded and reshuffled with a **per-dealer probability that falls off fast**: Dealer 1 **100%** (never shows a 10/11), Dealer 2 **30%**, Dealer 3 **15%**, Dealers 4–6 **0%** (honest deal). Because a two-card natural needs an Ace paired with a ten, the rail also suppresses **dealer natural blackjacks** on the same curve — Dealer 1 can never open on a dealt 21. The hole card and any hits are left honest; a dealer *hitting* to 21 is untouched. The dice roll uses the seeded deal RNG (the 100%/0% ends don't roll), so runs stay deterministic (§13).

**The player can't open on a natural on the run's very first hand — a UI/UX rail, not a debuff.** The same reshuffle rejects a *player* two-card 21, but only on the opening hand of the run, to dodge an instant-blackjack opening before the player has acted. From the second hand on the player keeps any natural.

*(The engine keeps house rules as configurable `RoundRules` — dealer-hits-soft-17, etc. — but the defaults above are the only ones in play. Roguelite upgrades (§8) bend some of them: the Sabotage path rewrites how the dealer's 21 resolves, and Payout T3 turns pushes into wins.)*

---

## 3. The dealer ladder

This is the engine that makes the game finite. You face one dealer at a time.

| Dealer | Health (hits) | Window (hands) | Heals | Soft 17 |
|---|---|---|---|---|
| 1 | 5 | 11 | 0 | stand |
| 2 | 6 | 14 | 0 | stand |
| 3 | 7 | 16 | 0 | **hit** |
| 4 | 8 | 18 | 0 | **hit** |
| 5 | 9 | 25 | up to 2 | **hit** |
| 6 | 10 | 29 | up to 3 | **smart** |
| 7+ | +2 / dealer | +4 / dealer | (as D6) | smart |

There is no dealer beyond the sixth in a normal run — clearing it (or running out its window) opens the coda (§10) — but the extrapolation row exists so a dev jump can seat a later dealer without the maths falling off a table.

**Two ways a dealer leaves the chair:**
- **You destroy it** — land its `health` in hits before its window runs out. You get the roguelite upgrade pick (§8), the token bounty, and the point cash-in (§9). This is the goal.
- **Its window runs out** — you play all `window` hands and it's still alive. It **walks off with no upgrade, no bounty, and no cash-in**; the next dealer walks in. A whiffed dealer is a permanent power deficit for the rest of the run (a missed upgrade) plus a much lower score curve — real stakes, without ending the run.

**The window sets the required win rate.** `window ≈ (health + heals) × 2.25`, so you need to win roughly **1 in 2.25 (~44%)** of your hands to kill in time — right around real blackjack odds, so a baseline player will *whiff* dealers and the upgrade/push economy (§8) is what tilts the rate over the line. This ratio is the **primary difficulty knob** (§11) and should be tuned per-dealer after playtest — expect to loosen Dealers 5–6.

**The house plays tougher late.** On top of tankier health and the heals (§4), the dealers' *play* sharpens as you climb (H17 on 3–5, smart 17 on 6) — a house edge that lowers your win rate at the source, untouched by your upgrades.

- **Dealers 3–5: hit soft 17 (H17).**
- **Dealer 6: smart 17** — draws its 17 to your hand (soft when tied-or-behind, hard only when strictly behind), never above 17, and reads the Sabotage state so you can't neuter it for free.

**The final duel** — as Dealer 6 nears death (measured as a fraction of its `health` hits), the fight escalates:
- **Desperation.** Its hard-hit ceiling rises with its wounds: it will hit a hard total when strictly behind up to **17** (healthy) → **18** (<30%) → **19** (<20%) → **20** (<10%). (It never hits a 21.)
- **No self-repair below ~30%.** Heal-on-win (§4) is gated so it can never heal off the player's last hit — the kill is always reachable.
- **No abilities below 20%.** Token powerups (§7) lock out for the last stretch — an "honorable duel" of pure blackjack. Each button greys out with a red ✕.
- **Its gambles don't dock you** (§4): when it busts a hand it *would have stood on*, you still land your hit.

Numbering the dealers keeps the end-screen résumé (§12) legible — "destroyed Dealer 3, timed out on Dealer 4" — without hardcoded names.

---

## 4. Dealer health (hits)

Every dealer's health is a small integer **hit count** — 5 at Dealer 1 up to 10 at Dealer 6 (§3). **Emptying it destroys the dealer**, and that is the *only* kill condition. The gauge reads as a fraction of that dealer's own max (the dealer's own damage visual — cracks, eye flicker — carries it), so a full bar looks full whether it's worth 5 hits or 10.

### Hits

Every **winning hand lands its *weight* in hits** — normally **1**, but **2 if it was doubled** (§5). A split's hands each count separately. Losses, pushes, and busts land **nothing**. That's the whole model: `win = 1 hit`, flat, regardless of *how* you won — so a scrappy dealer-bust win and a natural blackjack chip the dealer down equally, and there's never a reason to avoid the flashy win.

*(Token rewards still scale by how you won — §6 — but that's the powerup economy, orthogonal to killing.)*

**Busting wastes your attack.** Bust first and the dealer never draws, so it takes no hit — not even from a hand you'd otherwise have won.

**A dealer that busts a hand it would have stood on still lands your hit** (and pays the higher token tier, §6): forcing Dealer 6 to gamble a made 19 and bust counts as a win.

### Heal-on-win (late dealers fight back)

**The last two dealers claw back a hit whenever they beat you** — a lost or busted hand, not a push. **Dealer 5 heals up to 2 times, Dealer 6 up to 3**, one hit each. A heal is capped at the dealer's max and **never fires off the player's last hit** (only while the dealer has ≥ 2 hits remaining), so the kill is always reachable — it turns a stumble into lost progress, never an unkillable stalemate. Dealers 1–4 don't heal.

Note the heal also punishes reckless hits: busting is a dealer win, so an over-draw both wastes your attack *and* can heal the dealer.

### The window is the deadline

Unlike the old game, a dealer does **not** stay until you kill it. It deals a fixed **window** of hands (§3) and then leaves. Run out of window with the dealer alive → it walks off, no reward (§3).

---

## 5. Stakes — doubles, splits, and pushes

The player never stakes money; the "risk" of a double or split is expressed in the new currency of **hits, window slots, and wins**. Every player hand carries a **weight**: **1**, or **2 if it was doubled**.

- **Window cost** (how many of the dealer's `window` slots a round burns): the round's total weight over its non-pushed hands — a normal hand 1, a double 2, a 2-way split 2, a doubled split hand 2.
- **A win** contributes its weight in **hits *and* points**: a **double win = 2 hits & 2 wins** (two consecutive advances of the score curve, §9); each split win = 1.
- **A loss** contributes its weight to slots burned: a **double loss = 2 window slots consumed**. Split hands lose independently, 1 each.

So doubling is a genuine gamble: land it and you chip the dealer twice as fast for twice the points; miss it and you've burned two of your limited window hands.

### Pushes

A push never consumes a window slot and never records a win/loss:

- **Without Payout T3:** a **single** hand push (including a doubled hand) → **redeal** the round, window unchanged. A **split** hand push has **no effect** — that hand is dropped; the round resolves on its other hands.
- **With Payout T3** (§8): a push resolves as a **win** — a hit, points, and a green slot.

A Sabotage-voided dealer 21 (§8) shares the redeal path — it voids the round without spending the window.

---

## 6. Tokens (ENERGY)

> **Nomenclature: "token" (code) = "ENERGY" (player).** The currency here is called **tokens** throughout the code and these docs; the player **never sees the word "token"** — every user-facing surface says **ENERGY** (the **Energy** upgrade path, the scoreboard's **ENERGY SPENT** row, the **ENERGY INFLATION** readout). Display-layer rename only, like `integrity` → "health". When this doc says "tokens", the player reads "energy".

Tokens are the powerup currency (§7), earned directly from play. **The token economy is unchanged by the v29 rework** — it runs alongside the points game.

| Action | Tokens |
|---|---|
| Hit (and survive) | +1 to +10, scaled by how risky the hit was |
| Win — dealer busts | +4 |
| Win — beat a standing 17 / 18 / 19 / 20 | +8 / +12 / +16 / +22 |
| Natural blackjack | +21 |
| Dealer reaches 21 (Sabotage T1) | +20 |
| Destroy a dealer | +40 |

- **Hit tokens are risk-priced** and credited **only if the hand survives** (a bust earns nothing).
- **Win tokens scale by *how* you won** — beating a higher standing total pays more. (A push converted to a win by Payout T3 grades at the floor tier.) This tier system is the one place "flashy wins" still pay extra — into the ability economy, not toward the kill.
- The **Energy roguelite upgrade** (§8) multiplies every token reward by ×1.10 / ×1.18 / ×1.30.

### Token inflation

A global **inflation %** starts at 0 and only ever rises. Powerup costs (§7) are charged at `base × (1 + inflation)`, and a "prices +X%" readout appears once it climbs. Inflation rises **at each kill** (shifts 1–5; a Dealer 6 kill opens the coda, so it never inflates), by how many tokens you *earned* against that dealer:

```
added(shift) = cap(shift) × min(tokensEarnedThisShift, denom(shift)) / denom(shift) × resistance
```

| Shift | Cap | Denom |
|---|---|---|
| 1 | 7.0% | 140 |
| 2 | 9.75% | 170 |
| 3 | 12.5% | 200 |
| 4 | 15.25% | 240 |
| 5 | 18.0% | 280 |

`resistance` is the Energy upgrade's discount on the *add* (×1 → ×0.35 maxed). Note: a **window-out** (no kill) advances the dealer without banking inflation — only a kill inflates.

---

## 7. Powerups

Bought with tokens (§6), spent during your turn. Prices are base prices; token inflation marks them up, and each button's cost pill shows the live price. **Unchanged by the v29 rework.**

> **Powerups lock out entirely during the final duel** — once Dealer 6 drops below 20% health (§3).

| Powerup | Cost | Effect |
|---|---|---|
| **Analyze** | 4 | Read your bust-on-hit odds and the dealer-win odds. Clears the moment you act. |
| **Late double** | 30 | Double down after you've already taken hits. (Still weight 2 — §5.) |
| **Forced split** | 30 | Split your opening two cards even when they aren't a matching pair. |
| **Return** | 50 | Push your most recently drawn card back onto the shoe (the dealer draws it next), then stand. |
| **Freeze Dealer** | 70 | Force the dealer to stand on its current two-card total. |
| **Bust Block** | 80 | One expendable shield against busting (below). |
| **Mulligan** | 90 | Discard your untouched opening hand and redeal it once. |
| **Peek Dealer** | 100 | Reveal the dealer's hole card. |
| **Peek Deck** | 150 | See the next card in the shoe. *(designed — not yet implemented)* |

> **Peek Deck is designed but not yet built** — the shipped roster is the other eight powerups.

### Bust Block (detail)

Declare it before hitting; it applies to your next single draw: if the drawn card would bust you, it's burned face-up and one replacement is drawn — whatever it is, it stands. The shield is spent either way. Near-safe on a 12, a real gamble on a 16, dismal on a 20 (so standing on 20 stays correct). Show the burned card face-up — it's the most dramatic beat in the game.

---

## 8. Roguelite upgrades

After destroying a dealer, you permanently unlock **one tier of one of three paths**. No token cost — the choices only ever help. A pick is offered after each of the first five **kills** (a window-out earns no pick; the sixth kill opens the coda), so a single path can be maxed but not all three: **every pick is a real trade-off.** Note: since win-manufacturing tiers (below) directly speed up killing, they're strong — a real consideration when balancing.

Tiers unlock **in order** (1 → 2 → 3). The choose-upgrade screen shows three coloured buttons — Sabotage (red), Payout (blue), Energy (green) — each labelled with the *next* tier.

### Sabotage — turn the dealer's edge against it

| Tier | Effect |
|---|---|
| 1 | **+20 energy on any dealer 21** — a flat energy bonus whenever the dealer reaches 21 (a dealt natural *or* a hit-to-21), whatever the hand's outcome (a loss, a T2 void, a T3 hijack). The dealer's best hand fuels your abilities. |
| 2 | **Any dealer 21 redeals the hand.** A dealer that shows — or draws to — 21 while you're under 21 voids the round and deals a fresh one (no window slot spent). *(The T1 +20 still pays.)* |
| 3 | **Hijack** the dealer's natural blackjack: you take it as your own blackjack (a hit + points, plus the Payout point bonus). *(The T1 +20 stacks on top.)* |

All of it keys on the dealer reaching 21 (~12% of hands), so Sabotage is high-impact-but-situational — and unlike the higher tiers, T1's energy also pays off a *hit-to-21*, so it earns from the very first dealer (whose dealt naturals are rail-suppressed to zero).

### Payout — bigger point returns

| Tier | Effect |
|---|---|
| 1 | Natural blackjack scores **+50% points**. |
| 2 | Natural blackjack scores **+100% points**. |
| 3 | **You win all pushes** — a genuine tie resolves as a win (a hit + points + a green slot), and cashes out a Sabotage-voided dealer 21 the same way. |

### Energy — the economy path

| Tier | Effect |
|---|---|
| 1 | **+10%** tokens (×1.10) · token inflation grows **25% slower** (×0.75). |
| 2 | **+18%** tokens (×1.18) · inflation grows **45% slower** (×0.55). |
| 3 | **+30%** tokens (×1.30) · inflation grows **65% slower** (×0.35). |

Two effects, both replacing the last tier (not stacking). The multiplier applies to every token source in §6; the inflation resistance scales down each shift's inflation add — the run's economy/anti-inflation identity.

**Shape.** Each path owns a distinct axis — **Sabotage** neuters the dealer's 21s (and Payout T3 / Sabotage T2–T3 also *manufacture wins*, which speed the kill), **Payout** fattens the points off naturals and pushes, **Energy** runs the ability economy — so a pick is a real trade-off. It snowballs the late game (you enter Dealer 1 with zero picks), the intended roguelite arc.

---

## 9. Score

Score is the whole point of the game. It **never decreases** (until the coda risks it, §10), and it comes from a single ratchet: a running **win counter**.

```
each WIN scores:  round( 10 × 1.12^(wins − 1) )
```

- **`wins`** is the cumulative count of winning hands across the *entire run* (never reset per dealer), incremented by real wins **and** by the kill cash-in (below). A double win advances it twice. So every win permanently raises your rate for all future wins: victory 1 is worth 10, victory 20 ≈ 86, victory 50 ≈ 2,600 — a full clear lands ~100 wins and a total near **7M**. The curve base (**1.12**) is the leaderboard-shape dial (§11).
- **The kill cash-in is the entire point reward for a kill.** When you destroy a dealer, **every remaining slot in its window is credited as a bonus win** — each advancing the counter and scoring off the same curve. Kill on hand 4 of an 11-hand window → 7 bonus wins. So killing *early and efficiently* is strictly best (more guaranteed high-curve wins, which also lift every later win), and there's no way to milk a dealer for extra hands. There is **no** separate flat kill score-bounty.
- **No hit combo.** Surviving hits pay **tokens** (§6), not score — so the score never rewards hitting over correct standing. (A hit-streak score multiplier existed pre-v30 but was removed: it punished the skill of knowing when to stand and merely duplicated the win-count curve.)
- **Payout T1/T2** add **+50% / +100%** to a natural blackjack's points (§8). *(Sabotage T1 no longer touches score — it pays flat energy on a dealer 21, §6/§8.)*

The old `chips × dealerMultiplier`, the `1.5^kills` run multiplier, the free-double ×1.5, and the hit-streak combo are all **removed** — the win-count curve is the sole compounding, and a double's reward is simply that it counts as two wins.

> **In the UI:** each reward flashes top-right as `+N`. The **dealer hand-summary** (a projected row of window slots — green check per win, red X per loss) fills between hands, and a kill flips its remaining slots green as the cash-in lands. DEV builds also log `SCORE: win #N +P` per win and the free-win cash-in on a kill.

---

## 10. The Banker coda

There is **no bust-out** — the run always reaches the end of Dealer 6, and **the Banker always comes out** for a last double-or-nothing on the whole score.

- **You killed Dealer 6** → the boss breaks apart (laser death), the Banker walks in.
- **You ran out Dealer 6's window** → Dealer 6 strides off (no death), the Banker walks in behind it.

Either way you land at the same prompt, holding your full run score. The coda is stripped-down blackjack (by-the-book dealer, no split/double, no upgrades):

- **Double or nothing** — win the hand and your score **doubles**; a push **redeals** (score unchanged); a loss or bust **zeroes it** and ends the run.
- **Cash out** — walk away and bank the current score.

Coda-only abilities (a cheap flat Analyze, an expensive flat Mulligan) are available at the prompt. Unspent tokens and unlocked upgrades are **not** converted to anything — they last only for the run.

---

## 11. Tuning knobs

1. **The window ratio** (`≈ ×2.25` of `health + heals`, §3). The single biggest dial: it sets the win rate you must hit to kill in time (~44% at 2.25). Loosen it (2.5–3.0) if whiffing dealers feels punishing; tighten it for more tension. Ship the per-dealer `maxHands` as explicit numbers so it's a one-line edit — expect to loosen Dealers 5–6.
2. **The score curve base** (`1.12`, §9). The leaderboard-shape dial. Steeper → the final dealer dominates the score and totals explode; flatter → the whole run matters more and numbers stay small.
3. **Per-dealer `health` (hits)** and **`maxHeals`** (§3–§4). Health sets how many wins a kill costs; heals set how much a stumble on Dealers 5–6 sets you back (and tighten their effective window).
4. **The soft-17 rule per dealer** (§2 — the strongest single win-rate lever) and the **Dealer 6 final-duel thresholds** (desperation 30/20/10%, heal-off / abilities-lock).
5. **Token rewards & base powerup costs** (§6–§7) and **token inflation** (caps 7→18%, denoms 140→280, Energy resistance). The ability-economy dials.
6. **The roguelite upgrade strengths** (§8) — still a strong win-rate lever, especially the win-manufacturing tiers.
Starting tokens barely matter past the first couple of dealers.

---

## 12. Art direction

The obvious read on this name is grimdark neon cyberpunk casino. That's the wrong one.

*Robot Unicorn Attack* worked because it was sincere and sweet underneath a violent title — the contrast was the joke, and the game never once winked at it. The version of this that lands is a relentlessly cheerful dealer robot, warm colors instead of neon, and an over-emotional synthpop track played completely straight. The violence lives in the name and the explosions and nowhere else. Earnest, not edgy.

- **The dealers are polite.** Each congratulates you on your wins and stays warm while taking everything you can score. Personality comes from art and voice, not on-screen names — the UI just says "Dealer 1", "Dealer 2".
- **Overheating is spectacular and bloodless** — steam, popped panels, a small apologetic chirp.
- **Warm felt.** Burnt orange, cream, brass. Reserve the only cold color for the health gauge so it reads instantly.
- **One track, no shuffle.**
- **The end screen is a résumé of the run** — the dealers you destroyed (and any you timed out on), in order, with your score. That's the shareable artifact.

---

## 13. Technical: shuffling and score verification

**Every run gets its own freshly generated random seed.** Seeded means *reproducible*: a seeded shuffle is a real shuffle from a known number, so replaying with that number reproduces the identical sequence. The deal logic is pure and deterministic, threaded through a seeded mulberry32 PRNG — no `Math.random()` in deal logic. A `RULES_VERSION` constant (currently **29**) is stored so retuned rewards don't silently validate old replays, and an in-progress run persists the whole session (phase + round + deck-stream position) so a refresh resumes *exactly* — the anti-cheat that stops a reload from replaying a lost hand.

**Still to build:** logging the player's action sequence alongside the seed, for cheap server-side replay validation (turn-based, no timing, a couple of kilobytes per run).

### Why not a daily challenge

A shared-seed daily is a bad fit: divergence is immediate (if I hit and you stand, every later card shifts), and the deck leaks — Peek Dealer / Peek Deck plus a scarce-information economy die the moment the first hundred players map and post the shoe. The least-bad version seeds per hand rather than per shoe; it still does nothing about the leak.

*(Dev note: URL query params can force specific hands, upgrades, and dealers on the dev server — see [`dev-params.md`](dev-params.md).)*

---

## 14. Open questions for playtest

- **Is the window ratio right?** At `×2.25` you must beat real blackjack odds to kill in time, so baseline players whiff dealers and lean on the upgrade/push economy. Is that the right pressure, or does it need loosening (2.5–3.0), especially on Dealers 5–6 where heals tighten it further?
- **Does the score curve feel right?** `1.12` over ~100 wins means the final dealer dominates the total and scores reach millions. Is that satisfying, or should the curve flatten so a strong early run matters more?
- **Do whiffed dealers feel fair?** Running out a window (no upgrade, no cash-in, a permanent power deficit) is the main stakes now that there's no bust-out. Is that tense (good) or frustrating (bad)?
- **Are doubles/splits weighted correctly?** A double is a genuine two-slot gamble now. Does that read clearly, and is it worth it at the right frequency?
- **Are the upgrades balanced?** The win-manufacturing tiers (Payout T3, Sabotage T2–T3) speed the kill *and* score *and* the curve at once — do they dominate the pure point-boosters?
- **Which leaderboard shape?** A global all-time board is forgeable; a daily reset or a percentile end-screen line ("you beat 84% of today's runs") has no throne to defend. Decide before wiring the SDK.
- **Surrender as a meta-unlock?** Late surrender would make a good permanent unlock after a first failed run.
