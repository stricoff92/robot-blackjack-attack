# Scoreboards

The game shows a few distinct holo readouts, all projected by the table nexus into the clear band
between the two hands' counts. They are easy to confuse in conversation and in code, so this is the
shared vocabulary — use these exact names everywhere.

| Name | When it shows | Renders |
| --- | --- | --- |
| **victory banker scoreboard** | The run reaches the end of **Dealer 6** — the Banker's first double-or-nothing offer. | `drawCodaStake(…, tax = null, wonHand = false)` — [`src/render/coda-stake.ts`](../src/render/coda-stake.ts) |
| **banker hand player victory scoreboard** | Player **wins a hand against the Banker** — the re-offer, with a slow-clap sfx. | `drawCodaStake(…, tax = null, wonHand = true)` — [`src/render/coda-stake.ts`](../src/render/coda-stake.ts) |
| **final scoreboard** | The run is **over** — cash out or a loss to the Banker. | `drawScoreSheet` + `drawScoreTitle` — [`src/render/score-sheet.ts`](../src/render/score-sheet.ts) |

Both **banker scoreboards** are the double-or-nothing offer panel (`drawCodaStake`): the entry offer
is centred, the hand-win re-offer is left-justified. The **final scoreboard** is a different render
entirely — the run summary.

> **Note (v29).** The old **bankruptcy banker scoreboard** and its **tax** rows are gone with chips —
> there is no bust-out and no taxed entry. `drawCodaStake` still *accepts* a `tax` (`CodaTaxBreakdown`)
> parameter, but `GameView` never sets it now (`codaStakeTax_` stays null), so the tax path is dead
> code pending removal. Ignore it.

---

## The coda entry — two ceremonies, one offer

The Banker coda **always** fires at the end of Dealer 6 (§10 of the rules doc), reached two ways —
both landing at the **same** centred double-or-nothing offer:

- **Dealer 6 killed** — `run.kills.length >= TOTAL_DEALERS`. The boss breaks apart (laser **death**),
  then the Banker walks in. In `beginCoda_`, the `kills.length >= TOTAL_DEALERS` branch plays the
  death + deferred Banker walk-in.
- **Dealer 6 window ran out** — `coda` is set with `kills.length < TOTAL_DEALERS`. Dealer 6 strides
  **off** (no death), and the Banker walks in behind it. In `beginCoda_`, the
  `kills.length < TOTAL_DEALERS` branch plays `dealer_.walkOff` then the same deferred walk-in. (This
  branch is the repurposed old bankruptcy walk-off entry, minus the tax.)

There is no score tax on either entry — the player faces the Banker holding their full run score.

---

## victory banker scoreboard

**Trigger.** Reaching the end of Dealer 6 (`coda = true`) — via either entry above. This is the
**entry** offer only (no congrats yet).

**What it shows.** The double-or-nothing offer, **centred**, no tax rows. The stake (point score)
leads, then the offer, then the best-score line last (set apart by extra margin):

```
      The banker says:
      6,400 ⭐               ← the stake (your full run score)
      Double or nothing?

      Your best 50,000 ⭐
```

**Code.** `drawCodaStake` with `tax = null` and `congrats = null` → the centred block.

---

## banker hand player victory scoreboard

**Trigger.** The player **wins a coda hand** — in `runCoda_` the score doubles (`gained > 0`), so
`codaWonHand_` is set and the next prompt shows this board. A slow **hand-clap sfx** fires as it
appears.

**What it shows.** The re-offer, **left-justified** and sat slightly **left of felt-centre** (the
plain entry stays centred). Same row order as the entry board — stake, offer, then best-score last:

```
The banker says:
12,800 ⭐            ← the now-doubled stake
Double or nothing?

Your best 50,000 ⭐
```

**Code.** `drawCodaStake` with `tax = null` and `wonHand = true` → the left-justified block. The stake
number ticks up to the doubled total in lockstep with the top-right counter.

**Reach it (dev):** `?dealer=6&dealerHealth=1&tokens=500&points=100000`, then win one hand.

---

## final scoreboard

**Trigger.** `run.over` — set at the end of a coda (cash out or coda bust, in `Session`). There is no
chip bust-out any more, so every run reaches the coda first. Shown once the ending hand's cards have
been shredded (`scoreRevealAt_`).

**What it shows.** A `GAME OVER`-style summary — a title over POINTS / BEST / HANDS PLAYED / WIN·LOSS
/ ENERGY SPENT. The point rows are **locale-grouped** (thousands separators); the count rows stay
bare. `WIN / LOSS` shows the **ratio** wins ÷ losses to two decimals, guarded against divide-by-zero.
The **title** names which of the run-ending paths happened (`buildScore_` in `GameView`):

| Title | Path |
| --- | --- |
| `CASHED OUT` | Player **cashed out** at the Banker (banks the stake). |
| `BUSTED` | Player **lost a hand to the Banker** (a coda bust — score zeroed). |

Both endings come **through the Banker** (`run.coda === true`), so the final scoreboard sits **slightly
left of felt-centre** (`SCORE_LEFT_SHIFT = 0.08`, matching the coda scoreboards).

**Code.** `drawScoreSheet` (the rows) + `drawScoreTitle` (the game wordmark above it).

---

See also: [`docs/dev-params.md`](./dev-params.md) for the URL params used in the "reach it" recipes.
