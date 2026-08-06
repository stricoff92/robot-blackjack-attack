# ROBOT BLACKJACK ATTACK — Game Rules

A solo, free-to-play web game. You sit down across from a machine that deals blackjack and fight your way up a ladder of dealers. Destroy all six and you win the run; run out of chips first and the house shuts you down. The bet climbs relentlessly, so most runs end in bust-out — the question is how far up the ladder you get.

**Win condition:** destroy all six dealers. **Lose condition:** run out of chips. **Goal:** clear the run, or — failing that — the highest score before the house shuts you down.

> **On the name.** It's a nod to *Robot Unicorn Attack*, whose mechanics were a completely generic endless runner — the identity was entirely presentation. Same approach here: almost nothing below is mechanically "robot." The fiction does the work, and the one genuine addition (the dealer's health gauge, §4) is a single counter.
>
> Keep the riff at the name level. Don't reproduce the pastel-and-dolphins look or license anything near that soundtrack — a nod is fine, a costume is a takedown.

> **Revision note (2026-08-06, bet-ladder + peek pass).** Playtest still showed a player reaching the end too reliably, so two levers tightened:
> - **Min-bet ladder doubled per dealer** (§3): 10/15/25/40/90/150 → **20/40/80/160/320/640**, with the wealth floor steepened to 0/10/12/15/18/**25%**. Max bets held at 200–2,750, so the bet *range* compresses on the later dealers. Thinner 300-chip bankroll + higher variance = more bust-outs, hardest early where runs actually end. The per-kill grant (3× the next min, §4) rises with it, so the floor climbs without starving the run.
> - **Peek Dealer 60 → 150** (§7): repriced to parity with Peek Deck — hole-card knowledge shapes every decision of the hand, the single biggest EV leak in basic strategy, so it earns the top tier rather than a discount. `RULES_VERSION` → 13.
>
> **Revision note (2026-08-06, upgrade-rebalance pass).** The roguelite upgrades (§8) were the real difficulty leak — after a couple of picks a run steamrolled — so all three paths were reworked and the old "upgrades are deliberately overpowered" stance (§5 note) reversed: the toolkit is a difficulty dial now, too.
> - **Payout** (§8): auto-blackjack removed. Now 2:1 → 3:1 blackjack → **you win all pushes** (chips + score, no damage — so it never shortens the run).
> - **Sabotage** (§8): the −1 dealer downgrade removed. Now 75% refund → **any dealer 21 (natural or hit) is VOIDED** (a wash — a new outcome, *not* a push) → hijack the natural. Void + Payout T3 cashes the voided 21 out as a chips-only win.
> - **Tokens** (§8): buffed to +10/18/30% and 25/45/65% inflation resist, so the (now weaker) other two don't dwarf it.
> - **Why the damage axis, not min bets:** progress is gated by *damage* (fixed per win, independent of bet, §4); chips only buy survival. So difficulty is tuned on the damage/upgrade axis, and Payout's bigger winnings are wasted buffer by design. `RULES_VERSION` → 12.
>
> **Revision note (2026-08-06, final-duel pass).** Turned the Dealer 6 endgame into a climax (§3, §4):
> - **Desperation:** as Dealer 6 falls, its smart AI raises the hard total it'll hit when behind — 17 → 18 (<30%) → 19 (<20%) → 20 (<10%).
> - **No self-repair below 30%** and **no token abilities below 20%** ("honorable duel", shown in the UI). Heal-off is what keeps the desperation from heal-looping into an unkillable stalemate.
> - **Don't-punish reward:** a dealer that busts a hand it would have stood on (soft-17 or smart hit) pays the beat-that-total tier, not the weak bust tier — downgrade folded in if active. Applies to any dealer that hits 17+. `RULES_VERSION` → 11.
>
> **Revision note (2026-08-06, smart-dealer pass).** Refined the late-dealer house rules (§2, §3):
> - **Soft 17 is now a per-dealer rule** (`stand` / `hit` / `smart`). **Dealers 3–5 hit soft 17** (moved earlier); **Dealer 6 plays smart** — it draws its 17 (**soft when tied-or-behind, hard when strictly behind**) only when a stand wouldn't already beat you, never hits above 17, and reads the Anti-dealer downgrade (§8) so you can't sabotage past it for free.
> - The odds/Analyze sim mirrors the smart rule exactly, so the readout stays accurate. `RULES_VERSION` → 10.
>
> **Revision note (2026-08-06, endgame-squeeze pass).** Fourth difficulty pass — inflation landed well, so tighten the rest:
> - **Wealth floor raised on every dealer** (§3, §5): now 0 / 4 / 8 / 12 / 16 / **20%** (was up to 12.5%).
> - **Dealer 6 max bet 1,500 → 2,500** (§3), so a dragged-out final fight can climb higher.
> - **Dealers 5 & 6 now hit soft 17** (§2, §3) — a real house edge that lowers late win rate without touching upgrades.
> - **Heal-on-win extended to Dealer 5** (5–9, §4), so the last two dealers are both attrition fights.
> - `RULES_VERSION` → 8. Inflation (§6) unchanged — it's working.
>
> **Revision note (2026-08-05, token-inflation pass).** Third difficulty pass — the token bank still trivialized the endgame:
> - **Token inflation** (§6): a global inflation % rises at each kill from the tokens earned that shift (per-shift caps 7%→18%, denoms 140→280), marking up all powerup costs; a "prices +X%" readout shows it, and cost pills display the live price. `RULES_VERSION` → 7.
> - **Tokens upgrade reworked into the economy path** (§8): each tier now *also* resists inflation (accrue ×0.85 → ×0.50), which both cancels the friction of earning-more-inflates-faster and finally gives the weakest path a real identity.
>
> **Revision note (2026-08-05, wealth-floor + Peek Dealer pass).** Second difficulty pass after playtest — the endgame was still too easy:
> - **Wealth-floor bet** (§3, §5): the bet is now the greater of the fixed ladder and a *percentage of the current stack* (0% → 12.5% by Dealer 6), so a fat bankroll can't shrug off the stakes. It can exceed the table max and auto-deleverages as chips fall. `RULES_VERSION` → 6.
> - **Peek Dealer repriced 10 → 60** (§7): hole-card info is a premier advantage-play edge, not the minor "information" tool the old price implied — at 10 it was a self-funding every-hand buy that won runs on its own.
>
> **Revision note (2026-08-05, difficulty & scoring pass).** Endgame pressure + score rework:
> - **Dealer HP now scales** 100 → 220 across the six dealers (§1, §3, §4); late kills take more hands.
> - **Dealer 6 heals 10–15 HP whenever it beats you** (§4) — a stumble costs progress, not just chips.
> - **Late minimum bets raised** (Dealer 5 → 90, Dealer 6 → 150) to squeeze the endgame bankroll (§3).
> - **Score rewards good play, not volume** (§9): a **win-streak combo** multiplier (×1 → ×3, reset by a
>   dealer win) and a **clean-kill bonus** (a flawless kill pays its bounty twice, a sloppy one once).
> - Upgrades (§8) are deliberately left overpowered — the *house*, not the player's toolkit, is the
>   difficulty dial. `RULES_VERSION` → 5.

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
| Dealer health | 100 → 220, scaling per dealer (§3, §4) |
| Dealers to win | 6 |
| Shoe | 6 decks, **reshuffled after every hand** |

The reshuffle is deliberate: it removes card counting entirely, which keeps Peek Deck a tactical tool rather than the seed of a hidden metagame.

---

## 2. Base blackjack rules

Standard, with the fiddly bits trimmed:

- Blackjack pays **3:2**
- Dealer **stands on all 17** — *except the later dealers* (§3): **Dealers 3–5 hit soft 17** (the H17 rule), and **Dealer 6 plays a smart 17** — it draws (soft *or* hard) only when standing wouldn't already beat you. A real, escalating house edge
- Double down on any first two cards
- Split up to three times (four hands max); split aces receive one card each and cannot be re-split
- **No insurance.** It's a trap bet that teaches nothing and clutters the UI
- **No surrender** at baseline (see Open Questions)

*(The engine keeps these as configurable `RoundRules` — e.g. dealer-hits-soft-17, 6:5 payout — but the defaults above are the only ones in play. Roguelike upgrades (§8) can bend some of them mid-run: the Payout path raises the blackjack rate (2:1, then 3:1) and later pays pushes out to the player, and the Sabotage path rewrites how the dealer's natural — and any dealer 21 — resolves.)*

---

## 3. The dealer ladder

This is the engine that makes the game finite. You face one dealer at a time. **The only way past a dealer is to destroy it** — drain its health to 0 (§4). Destroy it and a heavier model takes the chair; the bet floor rises and the score multiplier rises with it. **Destroy the sixth and you win the run.**

| Dealer | Health | Min bet | Max bet | Wealth floor | Soft 17 | Score × |
|---|---|---|---|---|---|---|
| 1 | 100 | 20 | 200 | 0% | stand | 1.0 |
| 2 | 110 | 40 | 350 | 10% | stand | 1.5 |
| 3 | 125 | 80 | 550 | 12% | **hit** | 2.0 |
| 4 | 150 | 160 | 850 | 15% | **hit** | 3.0 |
| 5 | 185 | 320 | 1,700 | 18% | **hit** | 4.0 |
| 6 | 220 | 640 | **2,750** | 25% | **smart** | 5.5 |
| 7+ | +45 each dealer | ×2.5 each dealer | 10× min | 25% held | smart | **+1.5 flat** each dealer |

Max bet is 10× the minimum on Dealer 1 but grows slower than the doubling floor, so the bet *range* narrows on the later dealers — Dealer 6 runs 640 up to **2,750** (a ~4× band), still enough for a dragged-out final fight to climb to a real ceiling. There is no dealer beyond the sixth in a normal run — clearing it ends the run in a win — but the extrapolation row exists so the maths never falls off a table (a dev jump can still seat a later dealer).

**The min-bet floor doubles per dealer** (20 → 40 → 80 → 160 → 320 → 640) to thin the 300-chip bankroll and raise variance — cold streaks bust the player out more often, hardest early where runs actually end. The per-kill grant (§4) still tops up the bankroll, but the heavier floor means a cold streak — early, or late against a fat, self-repairing Dealer 6 — bleeds you fast.

**The wealth floor** (detailed in §5) is the fixed floor's answer to a rich player: the bet is forced to at least a *percentage of your current stack* — 0% on Dealer 1, up to **25% on Dealer 6** — so a bankroll swollen by banked upgrades and winnings can't shrug off the stakes. Unlike the fixed min, it scales with wealth and can even exceed the table max, so late hands always move real money no matter how far ahead you are.

**The house plays tougher late.** On top of the tanky, self-repairing HP (§4), the dealers' *play* sharpens as you climb — a house edge that lowers your win rate at the source, untouched by your upgrades. It's the cleanest "the endgame is harder" lever: the fiction is the house bringing out its better machines.

- **Dealers 3–5: hit soft 17 (H17).** A dealer that always draws on a soft 17 wins measurably more than one that stands (it's a real ~+0.2% house-edge rule).
- **Dealer 6: smart 17.** The final machine is smarter than a fixed rule — it plays its 17 to your hand:
  - **Soft 17:** draws when a stand would *tie or lose*, keeps it when already ahead. (The ace makes that draw risk-free, so even breaking a push is worth it.) This captures H17's upside while cutting its one gift to the player — a plain H17 dealer busts a soft 17 it was already winning; the smart one never does.
  - **Hard 17:** draws only when *strictly behind* — where a stand is a certain loss, so any non-bust improvement helps. On a tie it stands (hitting a hard 17 would throw away a sure push), and it never hits above 17 (no drawing to an 18 to chase your 19).

**The final duel** — as Dealer 6 nears death, the fight escalates into a raw, no-safety-net climax:
- **Desperation.** Its hard-hit ceiling rises with its wounds: it will hit a hard total when strictly behind up to **17** (healthy) → **18** (<30% health) → **19** (<20%) → **20** (<10%). A cornered machine throwing bigger and bigger risks to survive a hand a stand would lose. (It never hits a 21.)
- **No self-repair below 30%.** Heal-on-win (§4) switches off once it's under 30% — too damaged to patch itself. Without this the desperation-hitting would let it heal-loop into a stalemate; with it, the endgame is a race you can actually win.
- **No abilities below 20%.** Token powerups (§7) lock out entirely for the last stretch — an "honorable duel" of pure blackjack. Each powerup button greys out with a red ✕ in place of its price.
- **Its gambles don't dock your damage** (§4, damage): when it busts a hand it *would have stood on*, you're paid for beating that total, not the weak bust tier — so its aggression can't cheat you out of the kill.

**Dealer health scales too** — from 100 up to 220 at Dealer 6 (see §4). Later dealers take more winning hands to destroy, which does two things: it exposes the player to more variance late (the pressure the escalating bet floor is meant to apply), and it hands the player more hands to bank score on the way down.

**The score multiplier grows linearly on purpose.** Score is chips × multiplier (§9). If both the bet floor *and* the multiplier compounded, score would quadruple per dealer and the leaderboard tail would run away (a p90 run scoring hundreds of times the median — a lottery, not a skill ranking). The bet floor has to escalate to pressure the player; the multiplier must stay linear so the top of the board stays reachable.

**Why the pressure matters:** blackjack played well has roughly a 0.5% house edge, so without escalation a patient player never busts out and the run never resolves. The rising bet floor — plus the within-dealer bet climb in §5 — forces escalating risk on everyone and makes late hands worth an order of magnitude more than early ones.

Numbering the dealers (rather than naming them) keeps the death-screen résumé (§12) legible — "destroyed Dealer 3, fell to Dealer 4" — without hardcoded character names.

---

## 4. Dealer health

Every dealer has a health bar, and **emptying it destroys the dealer** — that is the kill condition, the third word in the title made literal, and the *only* way to advance. The bar's **maximum scales per dealer**, from 100 at Dealer 1 up to **220 at Dealer 6** (§3), so late dealers take more winning hands to bring down. The gauge always reads as a fraction of that dealer's own max, so a full bar looks full whether it's worth 100 or 220.

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

**A dealer that busts a hand it would have stood on still pays full damage.** When a dealer takes an above-standard hit (a soft-17 draw, or Dealer 6's smart/desperation hit on a made hand, §3) and busts, you're graded as beating the total it *abandoned* — the highest 17-20 it held — not the weak 12-damage bust tier. So the dealer's aggression can't dock your damage: forcing it to gamble a 19 and bust still pays beat-19 (40). A plain draw from a stiff (<17) has no abandoned stand and pays the bust tier as before.

### Heal-on-win (late dealers fight back)

**The last two dealers repair health whenever they beat you** — a lost or busted hand, not a push. **Dealer 6 heals 10–15, Dealer 5 heals 5–9** (both random). The repair is capped at the dealer's max, and it only ever fires on a hand the *dealer* won, so it never softens a hand you won. Dealers 1–4 don't heal ([0, 0] in the table); it's a per-shift property, so the range can be retuned or pushed earlier.

The point is to give the endgame teeth without touching the player's (deliberately overpowered) upgrades. Against an overpowered build the heal only *slows* the kill — roughly a quarter — rather than reversing it, so Dealer 6 never becomes unkillable; it just turns a stumble into lost progress instead of a shrug, and combined with the raised min bet (§3) makes a cold streak a genuine bust-out threat. Note it also punishes reckless hits: busting is a dealer win, so an over-draw both wastes your attack *and* heals the dealer.

**Heal shuts off below 30% health.** A dealer too damaged to patch itself stops repairing — this is what keeps Dealer 6's desperation phase (§3) from heal-looping into an unkillable stalemate. Below 30% the last of its health only comes off; it can't be put back.

### There is no deadline

A dealer stays in the chair until you destroy it — there's no timer and no way to pass one you can't beat. If you can't drain its health, you keep playing (and the bet keeps climbing, §5) until you go broke on it.

### Destroying a dealer pays

Emptying a dealer's health awards:
- **+40 tokens** (§6), scaled by the Token upgrade if you have it (§8)
- **+150 × dealer number** to score, **plus a clean-kill bonus** scaled by how few hands you lost to that dealer (§9)
- a **bankroll grant of 3 × the next dealer's minimum bet**, so the escalating floor (§3) stays survivable instead of starving the run
- **one roguelike upgrade pick** (§8) — except on the sixth kill, which wins the run
- advance to the next dealer; health resets to **that dealer's own max** (§3) and the within-dealer bet climb resets (§5)

### Balance

Damage numbers are one dial; the **per-dealer HP ladder** (§3) and the **late-dealer heal ranges** (Dealers 5–6) are the two that specifically shape the endgame — HP sets how many winning hands a kill costs, the heal sets how much a stumble sets you back. Raising the dealer-bust value makes destruction routine; dropping the higher tiers makes dealer-busts nearly the only source, which turns the mechanic into something you passively hope for rather than build toward. Because damage comes only from *winning*, there's no way to grind a dealer's health down for free — and because the heal fires only on a dealer win, there's no way to farm it either.

---

## 5. Betting

The player does not choose a bet. The game sets it each hand as the **greater of two floors**, capped at your chips:

```
ladder = min(dealerMinBet × (1 + handsAgainstThisDealer × 0.5), dealerMaxBet)
floor  = dealerFloorPct × yourChips        # 0% at Dealer 1 → 25% at Dealer 6 (§3)
bet    = min(max(ladder, floor), yourChips)
```

**The ladder** is a **sawtooth**: `handsAgainstThisDealer` starts at 0 for each new dealer and resets when you destroy one, so each dealer opens at its minimum and the bet climbs the longer the fight drags on.

- Dealer 1: 20 → 30 → 40 → 50 → …
- Destroy it → Dealer 2 opens fresh at 40 → 60 → 80 → …

This escalates risk over time and quietly rewards **destroying fast** — a dragged-out fight inflates your own bet and bleeds you toward bust-out. The `0.5` step is the main run-length knob (§11).

**The wealth floor** is what keeps a fat bankroll honest. Without it, the fixed ladder min (640 at Dealer 6) is trivial next to a stack built from stacked upgrades and banked winnings, so a rich player never feels a hand. The floor forces the bet to at least a percentage of your *current* stack — nothing on Dealer 1, rising to **25% by Dealer 6** — so wins and losses always move real money late. Two properties fall out of it:

- **It can exceed the table max.** For the very rich the percentage floor overrides `dealerMaxBet`, so there's no ceiling to hide a huge stack behind (still capped at the chips you hold).
- **It auto-deleverages.** Because it tracks your *current* chips, a losing streak shrinks the floor as your stack shrinks — a smooth glide toward the ladder min, not a cliff. You can't be forced all-in by the floor alone.

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
- The **Token roguelike upgrade** (§8) multiplies every token reward above by ×1.10 / ×1.18 / ×1.30.
- **No cap.** Tokens accumulate freely — but the more you earn, the more they inflate (below), so hoarding buys less than it looks.

### Token inflation

The token-side answer to a swollen bank (the chip-side one is the §5 wealth floor). A global **inflation %** starts at 0 and only ever rises. Powerup costs (§7) are charged at `base × (1 + inflation)`, and a **"prices +X%"** readout appears once it climbs above 0.

Inflation rises **at each kill** (end of shifts 1–5; Dealer 6's kill wins the run, so it never inflates). The amount added is set by how many tokens you *earned* against that dealer:

```
added(shift) = cap(shift) × min(tokensEarnedThisShift, denom(shift)) / denom(shift) × resistance
```

| Shift | Cap (max add) | Denom (tokens to max it) |
|---|---|---|
| 1 | 7.0% | 140 |
| 2 | 9.75% | 170 |
| 3 | 12.5% | 200 |
| 4 | 15.25% | 240 |
| 5 | 18.0% | 280 |

- **Earned, not banked.** It keys off tokens *earned* in the shift (wins, hits, the bounty — all post-multiplier), so it can't be gamed by spend-then-rebuy, and it ramps naturally on the token-rich late dealers. A lean shift adds less than its cap; a heavy-earning one caps out.
- **`resistance`** is the Tokens upgrade's discount on the *add* (§8): ×1 with no path, down to ×0.35 maxed. It scales the increment only — it never claws back inflation already banked. Cumulative inflation runs ~48% by Dealer 6 for typical play (~62.5% if every shift maxes); a maxed-Tokens build cuts its own add to ~a third (~17% cumulative typical, ~31 points less).

---

## 7. Powerups

Bought with tokens (§6), spent during your turn. Costs escalate with how much the effect moves your win rate — probabilistic hints are cheap, hard information about a hidden card is dear. **The prices below are base prices; token inflation (§6) marks them all up as the run goes on, and the cost pill on each button always shows the live, inflated price you'll actually pay:**

> **Powerups lock out entirely during the final duel** — once Dealer 6 drops below 20% health (§3), every ability is disabled and the last stretch is pure blackjack, no tools.

| Powerup | Cost | Effect |
|---|---|---|
| **Analyze** | 4 | Read your bust-on-hit odds and the dealer-win odds for the current spot. Folds in anything you've already peeked. Clears the moment you act. |
| **Late double** | 30 | Double down after you've already taken hits. |
| **Forced split** | 30 | Split your opening two cards even when they aren't a matching pair. |
| **Return** | 50 | Push your most recently drawn card back onto the shoe (the dealer draws it next), then stand. |
| **Freeze Dealer** | 70 | Force the dealer to stand on its current two-card total — it takes no draws. |
| **Bust Block** | 90 | One expendable shield against busting. See below. |
| **Mulligan** | 100 | Discard your untouched opening hand and redeal it once. |
| **Peek Deck** | 150 | See the next card in the shoe. |
| **Peek Dealer** | 150 | Reveal the dealer's hole card. |

**Peek Dealer sits at the top tier on purpose** (it was 10 — badly underpriced). Knowing the dealer's exact total lets you deviate from basic strategy *optimally on every decision of the hand* — stand and let a stiff 12–16 bust, hit hard into a made 18–20 — and uncertainty about the dealer's hand is where basic strategy loses the most EV. That's why hole-carding is a premier advantage-play technique; it is **not** the minor "information" tool the old price implied. At 10 tokens it was self-funded by a single hand's winnings and became a rote every-hand buy that carried whole runs. It's now **150 — level with Peek Deck**: hole-card knowledge steers every decision of the hand rather than a single hit, so even though it doesn't fully resolve the dealer (a stiff still draws unknown cards), it earns parity with the shoe peek's one-card certainty rather than a discount.

Bust Block is priced below Peek Deck on purpose. Peek Deck is reliable certainty — see the card, decline the hit, never bust — whereas Bust Block is conditional and can whiff (nothing to shield if you weren't going to bust, or a second bust on the re-roll). So Peek Deck is the expensive, reliable power and Bust Block is the cheaper, swingier "upside" play — the one that can turn a dead 16 into a live 20.

The **Peek Deck → Late double** combo (see the next card, then double into it) is the signature offensive play; at 180 tokens combined it is a deliberate commitment. **Analyze** is priced as near-free on purpose: it sells a *probability*, not a hidden card, and is meant to be a rote learning aid for reading a spot before you commit to a pricier tool.

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
| 1 | **75% refund** on a loss to the dealer's natural blackjack. |
| 2 | **Any dealer 21 voids the hand.** A dealer that shows — or draws to — 21 while you're under 21 is a wash: your bet comes back, no damage, no reward. This is a **VOIDED** outcome, deliberately *not* a push (so it doesn't accidentally trigger Payout T3 on its own). |
| 3 | **Hijack** the dealer's natural blackjack: you take it *as your own* natural blackjack (paid at the blackjack rate — so it respects the Payout upgrade below — and dealing the blackjack damage/tokens). |

The tiers layer on the same event: on a **dealt natural** it's refund (T1) → void (T2) → hijack (T3), each strictly better; a **drawn dealer 21** can't be hijacked, so it keeps voiding at T3. All of it keys on the dealer reaching 21 (~12% of hands), so Sabotage is high-impact-but-situational insurance, not an always-on effect.

### Payout — bigger chip returns (money, not progress)

| Tier | Effect |
|---|---|
| 1 | Natural blackjack pays **2:1** (instead of 3:2). |
| 2 | Natural blackjack pays **3:1**. |
| 3 | **You win all pushes.** A genuine tie is paid to you at even money — chips **and score, but no damage and no reward tokens** (a *chips-only* win). It also cashes out a Sabotage-voided dealer 21 (T2 above): with both, a dealer 21 becomes a chips-only win instead of a wash. |

Payout is deliberately the money/score path, not a damage path: chips are a survival buffer, not a progress lever (killing a dealer is gated by damage, which is fixed per win — §4), so a chips-only push-win pads your stack and your score without shortening the run. It's the one path whose winnings don't buy you a faster kill.

### Tokens — the economy path

| Tier | Effect |
|---|---|
| 1 | **+10%** tokens (×1.10) · token inflation grows **25% slower** (×0.75). |
| 2 | **+18%** tokens (×1.18) · inflation grows **45% slower** (×0.55). |
| 3 | **+30%** tokens (×1.30) · inflation grows **65% slower** (×0.35). |

Two effects, both replacing the last tier (not stacking). The **multiplier** applies to every token source in §6 — hits, wins, blackjacks, and the kill bounty. The **inflation resistance** scales down each shift's inflation add (§6) — so this is the run's economy/anti-inflation identity, sitting alongside Sabotage (neuter the dealer) and Payout (bigger chips).

The resistance also fixes the friction the two effects would otherwise have: earning *more* tokens would, on its own, inflate *faster*. The resistance more than cancels that — a maxed-Tokens build both earns more and ends the run ~30 points *less* inflated than a build that skipped the path. Earlier this was the weakest, least-picked path; the buffed multipliers plus inflation control are meant to keep it a genuine third strategy now that the other two were cut.

**Shape.** Every upgrade is still a buff — the paths only ever help — but they're deliberately **surgical, not overwhelming** now: the old auto-blackjack and −1-downgrade tiers trivialised the back half, so they're gone. Each path owns a distinct axis — **Sabotage** neuters the dealer's 21s (win rate), **Payout** fattens chips + score (a survival/score buffer, not progress — see above), **Tokens** runs the ability economy — so a pick is a real trade-off, not a straight power spike. It still snowballs the late game more than the first few dealers (you enter Dealer 1 with zero picks), the intended roguelite arc, but the ceiling is low enough that the *house* (§3–§4) stays the main difficulty dial.

**Chips buy survival, not progress.** Destroying a dealer is gated by *damage*, which is fixed per win and independent of your bet (§4); chips only keep you solvent. That's why raising the *min bet* alone never made the game harder — it scales the buffer symmetrically — and why the fix lived in the upgrade set and the wealth-floor bet *volatility* (§5), not bet size. It's also why Payout can be a pure money/score path without unbalancing progress.

---

## 9. Score

Score is a separate ratchet from chips. It **never decreases**.

```
score += (chips won on the hand) × current dealer multiplier × win-streak combo
```

Blackjack paying 3:2 (2:1, then 3:1, with the Payout upgrade, §8) therefore scores more automatically, and Payout T3 turns a push — normally zero — into a scoring chips-only win.

- **Win-streak combo.** Each consecutive won hand lifts *that hand's* chip score: ×1 on the first win, then +0.25 per win, capped at **×3** (the ninth win in a row and beyond). A hand the dealer wins resets the streak to ×1; a push — or a chips-only push-win (§8), which deals no damage — leaves it untouched. This is score-only — it never touches chips, damage, or survival — so it rewards a dominant hot streak without affecting balance, and the healing late dealers (§4) are exactly what threaten to break a streak.
- **Destruction bonus:** `150 × dealer number` when you destroy a dealer, **plus a clean-kill bonus** — a second helping of that same base, scaled by how few hands you lost to the dealer: full at zero losses (so a flawless kill pays the bounty *twice*), shrinking 20% per lost hand, to nothing at five losses. This inverts the old incentive: killing fast and clean now scores *more*, not less.

The result points score at the play the win condition already wants — fast, clean, high-tier kills and unbroken streaks — instead of at grinding out extra hands. Winning the run (all six dealers) naturally maximises everything.

> **Not yet surfaced in the UI:** the combo multiplier and clean-kill bonus currently move the score number without a dedicated readout. `winStreak` lives on the run state, so a visible combo meter is an easy follow-up.

---

## 10. Going broke

When your chips fall below the dealer's minimum bet, you're on **last call**: the fixed bet (§5) automatically becomes everything you have. Win and you're back on a short stack; lose and the run ends.

This produces the single most memorable moment in every losing run, and it costs nothing to build — the bet formula already caps the bet at your chips.

Unspent tokens and unlocked upgrades are **not** converted to anything at bust-out — they last only for the run. Spend the tokens or lose them.

---

## 11. Tuning knobs

Difficulty lives in a handful of places:

1. **The within-dealer bet step** (`0.5` in §5). Bigger → the bet climbs faster within a dealer → shorter, tenser runs.
2. **The minimum-bet curve** (×2 per dealer through the table, ×2.5 past it), the **Dealer-6 max bet** (2,750, §3), **and the wealth floor** (0% → 25% by Dealer 6, §5). The fixed curve gentler → runs stop ending reliably; the wealth floor is the anti-turtle dial — it forces a rich, upgrade-stacked player to keep real money on the table late, so raise its late percentages if the endgame still feels stakes-free (and lower them if bust-out comes too fast for a fat stack).
3. **The per-kill bankroll grant** (`3 ×` the next min bet, §4), the **dealer HP ladder** (100 → 220, §3), the **late-dealer heals** (Dealer 5 5–9, Dealer 6 10–15, off below 30%, §4), the **soft-17 rule** per dealer (§2 — `stand` / `hit` / `smart`; the strongest single win-rate lever, set in the shift table), and the **damage tiers** (§4).
   - **The Dealer 6 final duel** (§3) has its own dials: the desperation health thresholds (30/20/10% → hard ceiling 18/19/20), the heal-off threshold (30%), and the abilities-lock threshold (20%). These are the knobs for how brutal the climax is — widen the lock window or raise the ceilings to make it harder, narrow them if it walls players out. Together these set how survivable the ladder is and how many hands it takes to destroy a dealer. Note that raising a late min bet (§3) also inflates the *previous* dealer's kill grant (`3 ×` it), which can hand the player a war chest right before the hardest fight — flatten the late kill grant if that reads as too soft.
4. **Token rewards** (§6) and **base powerup costs** (§7). These set how often a player gets to use the fun part; Peek Dealer's base price (150, up from 10) is the sharpest, since it's the strongest info tool.
5. **Token inflation** (§6): the per-shift **caps** (7% → 18%), the **denoms** (140 → 280), and the Tokens-path **resistance** (×1 → ×0.35). This is the anti-token-bank dial — raising the caps or lowering the denoms makes late powerups pricier and the token bank worth less. The denoms are estimates of per-shift token income and should be calibrated against real logged earnings; they're the most likely numbers to be off.
6. **The roguelike upgrades** (§8). Still the strongest single lever on win rate, but the set was rebalanced *down* (auto-blackjack and the −1 downgrade removed, Tokens buffed) so it no longer trivialises the back half; each path now owns a distinct axis (Sabotage = win rate, Payout = chips/score, Tokens = ability economy). Tune the tier strengths to move the clear rate — this is where the recent "too easy" pressure was fixed.
7. **The score multiplier must stay linear** (§3). This is not a taste knob — making it compound reintroduces the runaway leaderboard tail.
8. **The score combo and clean-kill** (§9): the combo step (`+0.25`/win) and cap (`×3`), and the clean-kill decay (`20%`/loss). These are score-only — they change the leaderboard shape and what play the board rewards, not survival — so they can be tuned freely without touching win rate.

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

The prototype already does this: the deal logic is pure and deterministic, and it uses a seeded mulberry32 PRNG threaded through the shuffle — no `Math.random()` anywhere in deal logic. A `RULES_VERSION` constant (currently 12) is stored so retuned rewards don't silently validate old replays.

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
- **Are the upgrades balanced against each other?** The paths were rebalanced (§8) — the trivialising tiers cut, Tokens buffed. Watch whether Tokens is now worth picking, whether Sabotage (win rate) still edges Payout (chips/score), and whether the reworked set lands the target clear rate instead of steamrolling the back half as the old set did.
- **Can a player get stuck?** Because advancing requires destroying, a cold streak on a dealer you can't damage just bleeds you out on it. Is that tense (good) or frustrating (bad)?
- **Are the powerup costs right, and does inflation tame the token bank?** Nine powerups compete for tokens (§7); Peek Dealer moved 10 → 60 after it single-handedly carried runs. The token bank is now attacked by **inflation** (§6) — the open question is whether the caps/denoms are calibrated right (the denoms are estimates), whether ~48% typical endgame inflation actually makes a flush player feel the squeeze, and whether the Tokens path's resistance leaves it competitive without swinging to overpowered.
- **Is Late double / Forced split ever bought?** They share a slot with each other in the UI; if either sees little use, reconsider its price or presentation.
- **Which leaderboard shape?** A global all-time board is forgeable and gets colonized by cheaters. A board that resets daily makes forged scores evaporate, and a percentile line on the end screen ("you beat 84% of today's runs") has no throne to defend. Decide this before wiring up any SDK.
- **Surrender as a meta-unlock?** Late surrender is a real strategic tool and would make a good permanent unlock after a first bust-out — a reason to start run two.
