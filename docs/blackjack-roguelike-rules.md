# ROBOT BLACKJACK ATTACK — Game Rules

A solo, free-to-play web game. You sit down across from a machine that deals blackjack and play until it takes everything you have. The bet climbs relentlessly, so you *will* go broke — the only question is how many dealers you destroy on the way down.

**Win condition:** none. **Lose condition:** guaranteed. **Goal:** the highest score before the house shuts you down.

> **On the name.** It's a nod to *Robot Unicorn Attack*, whose mechanics were a completely generic endless runner — the identity was entirely presentation. Same approach here: almost nothing below is mechanically "robot." The fiction does the work, and the one genuine addition (the dealer's health gauge, §4) is a single counter.
>
> Keep the riff at the name level. Don't reproduce the pastel-and-dolphins look or license anything near that soundtrack — a nod is fine, a costume is a takedown.

> **Revision note (2026-08-02).** This doc was rewritten to match the prototype, which deliberately diverged from the original design on several points:
> - **Charge meter removed.** Tokens are now earned directly from actions (§6), not by filling a meter.
> - **House rules removed** (were an optional/v2 module).
> - **Surviving a dealer removed.** The only way to advance is to *destroy* the dealer (§3, §4). There is no hand deadline.
> - **Player bet choice removed.** The bet is fixed each hand by a formula (§5).
> - **Presentation:** dealers are numbered ("Dealer 1, Dealer 2…"), the meter is "health" not "integrity", and the word "shift" is never shown. (Code internals still use `shiftIndex`/`integrity`.)
> - **Powerup costs raised** into an exponential curve (§7).
>
> The original simulation figures (median 31 hands, 53/47 destroy-vs-clock-out, etc.) assumed the old run model and no longer apply; run length now needs fresh playtest/simulation.

---

## 1. Setup

| | |
|---|---|
| Starting chips | 300 |
| Starting tokens | 0 |
| Starting score | 0 |
| Dealer health | 100 (each dealer) |
| Shoe | 6 decks, **reshuffled after every hand** |

The reshuffle is deliberate: it removes card counting entirely, which keeps Foresight a tactical tool rather than the seed of a hidden metagame.

---

## 2. Base blackjack rules

Standard, with the fiddly bits trimmed:

- Blackjack pays **3:2**
- Dealer **stands on all 17**, including soft 17
- Double down on any first two cards
- Split up to three times (four hands max); split aces receive one card each and cannot be re-split
- **No insurance.** It's a trap bet that teaches nothing and clutters the UI
- **No surrender** at baseline (see Open Questions)

*(The engine keeps these as configurable `RoundRules` — e.g. dealer-hits-soft-17, 6:5 payout — but the defaults above are the only ones in play.)*

---

## 3. The dealer ladder

This is the engine that makes the game finite. You face one dealer at a time. **The only way past a dealer is to destroy it** — drain its health to 0 (§4). Destroy it and a heavier model takes the chair; the bet floor rises and the score multiplier rises with it.

| Dealer | Min bet | Max bet | Score × |
|---|---|---|---|
| 1 | 10 | 100 | 1.0 |
| 2 | 25 | 250 | 1.5 |
| 3 | 60 | 600 | 2.0 |
| 4 | 150 | 1,500 | 3.0 |
| 5 | 400 | 4,000 | 4.0 |
| 6 | 1,000 | 10,000 | 5.5 |
| 7+ | ×2.5 each dealer | 10× min | **+1.5 flat** each dealer |

Max bet is always 10× the minimum.

**The score multiplier grows linearly on purpose.** Score is chips × multiplier (§8). If both the bet floor *and* the multiplier compounded, score would quadruple per dealer and the leaderboard tail would run away (a p90 run scoring hundreds of times the median — a lottery, not a skill ranking). The bet floor has to stay exponential to kill the player; the multiplier must stay linear so the top of the board stays reachable.

**Why the pressure matters:** blackjack played well has roughly a 0.5% house edge, so without escalation a patient player never busts out and the run never ends. The rising bet floor — plus the within-dealer bet climb in §5 — forces escalating risk on everyone and makes late hands worth an order of magnitude more than early ones.

Numbering the dealers (rather than naming them) keeps the death-screen résumé (§11) legible — "destroyed Dealer 3, fell to Dealer 4" — without hardcoded character names.

---

## 4. Dealer health

Every dealer has a health bar starting at **100**. It drains as you play, and **emptying it destroys the dealer** — that is the kill condition, the third word in the title made literal, and the *only* way to advance.

### Damage

| Event | Damage |
|---|---|
| Win a hand | 8 |
| Natural blackjack (on top of the win) | +12 |
| Dealer busts | 25 |

**Damage only lands if you were still live in the hand.** Bust first and the dealer never draws, so it takes nothing — not even from a hand you'd otherwise have won. Busting already costs you your bet; now it also wastes an attack. This gives standing on a stiff 15 a real reason to exist.

### There is no deadline

The old design let a dealer "clock out" after a fixed number of hands. That's gone. A dealer stays in the chair until you destroy it — there's no timer and no way to pass one you can't beat. If you can't drain its health, you keep playing (and the bet keeps climbing, §5) until you go broke on it.

### Destroying a dealer pays

Emptying a dealer's health awards:
- **+40 tokens** (§6)
- **+150 × dealer number** to score (§8)
- advance to the next dealer; health resets to 100 and the within-dealer bet climb resets (§5)

### Balance

Damage numbers are the dial. Raising the dealer-bust value makes destruction routine; dropping the per-win value makes dealer-busts nearly the only source, which turns the mechanic into something you passively hope for rather than build toward. Because damage comes only from *winning while live*, there's no way to grind a dealer's health down for free — but note the token farm in §6/§13.

---

## 5. Betting

The player does not choose a bet. The game sets a fixed bet each hand:

```
bet = dealerMinBet × (1 + handsAgainstThisDealer × 0.5)
      capped at the dealer's max bet and at your current chips
```

`handsAgainstThisDealer` starts at 0 for each new dealer and resets when you destroy one. So the bet is a **sawtooth**: each dealer opens at its minimum and climbs the longer the fight drags on.

- Dealer 1: 10 → 15 → 20 → 25 → …
- Destroy it → Dealer 2 opens fresh at 25 → 38 → 50 → …

This does the work the old "rising floor" did — escalating risk over time — but it also quietly rewards **destroying fast**, since a dragged-out fight inflates your own bet and bleeds you toward bust-out. The `0.5` step is the main run-length knob (§10).

---

## 6. Tokens

Tokens are the powerup currency (§7). Unlike the old Charge meter, they're earned **directly from what you do at the table**:

| Action | Tokens |
|---|---|
| Hit | +1 (credited the instant you hit) |
| Win a hand | +10 |
| Blackjack | +21 |
| Destroy a dealer | +40 |

- Hit tokens are deposited live, per hit, so the counter ticks up as you take cards.
- Win and blackjack tokens are awarded per hand, so a swept split pays for each winning hand.
- **No cap.** Tokens accumulate freely, because the powerup costs are now large (§7).

---

## 7. Powerups

Costs escalate with how reliable and powerful the effect is — cheap utility, expensive certainty:

| Powerup | Cost | Effect |
|---|---|---|
| **Peek** | 10 | Reveal the dealer's hole card. Usable after the deal, before you act. |
| **Late double** | 30 | Double down after you've already taken hits. |
| **Second chance** | 90 | One expendable shield against busting. See below. |
| **Foresight** | 150 | See the next card in the shoe. Usable at any point during your turn. |

Second chance is priced below Foresight on purpose. Foresight is reliable certainty — see the card, decline the hit, never bust — whereas Second chance is conditional and can whiff (nothing to shield if you weren't going to bust, or a second bust on the re-roll). So Foresight is the expensive, reliable power and Second chance is the cheaper, swingier "upside" play — the one that can turn a dead 16 into a live 20.

The **Foresight → Late double** combo (see the next card, then double into it) is the signature offensive play; at 180 tokens combined it is a deliberate commitment.

### Second chance (detail)

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

## 8. Score

Score is a separate ratchet from chips. It **never decreases**.

```
score += (chips won on the hand) × current dealer multiplier
```

Blackjack paying 3:2 therefore scores more automatically. Plus:

- **Destruction bonus:** `150 × dealer number`, awarded when you destroy a dealer.

Two viable emphases fall out of this: a careful player banks destruction bonuses on the way up; an aggressive player scores through the multiplier on big late-hand wins. The rising bet eventually drags everyone toward the aggressive style.

---

## 9. Going broke

When your chips fall below the dealer's minimum bet, you're on **last call**: the fixed bet (§5) automatically becomes everything you have. Win and you're back on a short stack; lose and the run ends.

This produces the single most memorable moment in every run, and it costs nothing to build — the bet formula already caps the bet at your chips.

Unspent tokens are **not** converted to anything at bust-out — they're ability currency only. Spend them or lose them.

---

## 10. Tuning knobs

Difficulty lives in a handful of places:

1. **The within-dealer bet step** (`0.5` in §5). Bigger → the bet climbs faster within a dealer → shorter, tenser runs.
2. **The minimum-bet curve** (×2.5 per dealer). Below ×2 runs stop ending reliably; above ×3 the early dealers blur past before the player learns the systems.
3. **Dealer health** (100) and the **damage numbers** (§4). These set how many hands it takes to destroy a dealer.
4. **Token rewards** (§6) and **powerup costs** (§7). These set how often a player actually gets to use the fun part.
5. **The score multiplier must stay linear** (§3). This is not a taste knob — making it compound reintroduces the runaway leaderboard tail.

Starting chips barely matter past the first couple of dealers — don't tune there.

---

## 11. Art direction

The obvious read on this name is grimdark neon cyberpunk casino. That's the wrong one.

*Robot Unicorn Attack* worked because it was sincere and sweet underneath a violent title — the contrast was the joke, and the game never once winked at it. The version of this that lands is a relentlessly cheerful dealer robot, warm colors instead of neon, and an over-emotional synthpop track played completely straight. The violence lives in the name and the explosions and nowhere else. Earnest, not edgy.

Concretely:

- **The dealers are polite.** Each one congratulates you on your wins and stays warm and encouraging while taking everything you own. Nobody threatens the player, ever. Personality comes from art and voice, not from on-screen names — the UI just says "Dealer 1", "Dealer 2", and so on.
- **Overheating is spectacular and bloodless** — steam, popped panels, a small apologetic chirp, a dealer wheeled off by an even smaller robot.
- **Warm felt.** Burnt orange, cream, brass. Reserve the only cold color in the palette for the health gauge, so it reads instantly.
- **One track, no shuffle.** Committing to a single song is a large part of what made the reference work.
- **The death screen is a résumé of kills** — the dealers you destroyed, in order, and the one you fell to, with your score. That's the shareable artifact, and it's the reason the ladder in §3 exists at all.

---

## 12. Technical: shuffling and score verification

**Every run gets its own freshly generated random seed.** Seeded does not mean shared and does not mean less random — it means *reproducible*. A seeded shuffle is a real shuffle that starts from a known number, so replaying with that number reproduces the identical sequence.

```js
// Unreproducible, unverifiable
shuffle(deck);

// Equally random, but replayable
const rng = mulberry32(seed);
shuffle(deck, rng);
```

The prototype already does this: the deal logic is pure and deterministic, and it uses a seeded mulberry32 PRNG threaded through the shuffle — no `Math.random()` anywhere in deal logic. A `RULES_VERSION` constant is stored so retuned rewards don't silently validate old replays.

**Still to build:** logging the player's action sequence (hit, stand, double, split, token spends) alongside the seed. That pair — seed plus actions — is a complete, verifiable recording of a run: a server that knows the seed replays the identical deal, computes the score itself, and trusts nothing the client sent. Replay validation is unusually cheap here (turn-based, no timing, a short input vocabulary; a full run is a couple of kilobytes). Doing it now is nearly free; retrofitting it once randomness is scattered through the deal code is not.

### Why not a daily challenge

A daily challenge — everyone shares one seed so the run becomes a skill contest — is a *different* feature and a bad fit here. Two reasons:

**Divergence is immediate.** In a platformer with a daily seed the level is fixed no matter what you do. In blackjack, if I hit and you stand, every subsequent card shifts — same shoe, completely different game from hand two onward.

**The deck leaks, and this game can't survive that.** Peek and Foresight are half the powerup roster, and the token economy assumes card information is scarce. Share a seed and the first hundred players map the deck and post it; by afternoon everyone knows the hole card on hand seven for free, and two of your four powerups are worthless.

If you want a daily anyway, the least-bad version seeds **per hand rather than per shoe**, so hand 5 is the same starting position for everyone regardless of hands 1–4. It does nothing about the information leak. Nothing does.

---

## 13. Open questions for playtest

- **The hit-token farm.** +1 per hit is credited even on hands you bust. Since busting deals no damage, a player can hit-into-bust to bank tokens without advancing — paying only their bet. Watch whether this is a real strategy; the one-line guard is to credit the hit token only on hands that don't bust.
- **Do runs end at the right length?** With no hand deadline, run length is now set by the bet climb (§5) draining chips vs how fast you destroy dealers. Target roughly 8–15 minutes; tune the `0.5` bet step and the bet curve to hit it.
- **Can a player get stuck?** Because advancing requires destroying, a cold streak on a dealer you can't damage just bleeds you out on it. Is that tense (good) or frustrating (bad)?
- **Are the powerup costs right?** Current: Peek 10, Late double 30, Second chance 90, Foresight 150. Foresight is priced as the premium (reliable certainty), Second chance sits below it as the swingy option, and Peek is deliberately kept cheap. Watch whether Second chance at 90 still gets skipped for Foresight, and whether Peek at 10 becomes a rote every-hand buy.
- **Is Late double ever bought?** Peek is the safer low-cost purchase in most spots. If Late double sees little use, reconsider its price or fold it into Foresight.
- **Which leaderboard shape?** A global all-time board is forgeable and gets colonized by cheaters. A board that resets daily makes forged scores evaporate, and a percentile line on the death screen ("you beat 84% of today's runs") has no throne to defend. Decide this before wiring up any SDK.
- **Surrender as a meta-unlock?** Late surrender is a real strategic tool and would make a good permanent unlock after a first bust-out — a reason to start run two.
