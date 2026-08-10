# Scoreboards

The game shows four distinct holo readouts, all projected by the table nexus into
the clear band between the two hands' counts. They are easy to confuse in
conversation and in code, so this is the shared vocabulary — use these exact names
everywhere.

| Name | When it shows | Renders |
| --- | --- | --- |
| **bankruptcy banker scoreboard** | Player runs out of chips at **Dealer 2+** — the Banker offers a taxed double-or-nothing. | `drawCodaStake(…, tax)` — [`src/render/coda-stake.ts`](../src/render/coda-stake.ts) |
| **victory banker scoreboard** | Player has **beaten all 6 dealers** — the Banker's first double-or-nothing offer. | `drawCodaStake(…, tax = null, wonHand = false)` — [`src/render/coda-stake.ts`](../src/render/coda-stake.ts) |
| **banker hand player victory scoreboard** | Player **wins a hand against the Banker** — the re-offer, with a slow-clap sfx (in either coda). | `drawCodaStake(…, tax = null, wonHand = true)` — [`src/render/coda-stake.ts`](../src/render/coda-stake.ts) |
| **final scoreboard** | The run is **over** — cash out, a loss to the Banker, or an early bankruptcy. | `drawScoreSheet` + `drawScoreTitle` — [`src/render/score-sheet.ts`](../src/render/score-sheet.ts) |

The three **banker scoreboards** are all the double-or-nothing offer panel (`drawCodaStake`),
distinguished by how they look: the victory entry is centred, the bankruptcy entry is a
left-aligned taxed statement, and the hand-win re-offer is left-justified. The **final
scoreboard** is a different render entirely — the run summary.

---

## bankruptcy banker scoreboard

**Trigger.** In `applyRound` ([`src/game/run.ts`](../src/game/run.ts)): a losing hand with
`chips <= 0` **and** `shiftIndex > BANKRUPTCY_MIN_SHIFT` (= 1, i.e. **Dealer 2–6**). It sets
`bankruptcyCoda = true`, `coda = true`, and taxes the score by `BANKRUPTCY_TAX` (83%) —
`score = floor(score × 0.17)` — instead of ending the run. The dealer that won walks off and
the Banker walks in.

**What it shows.** A left-aligned **statement** (a receipt), sat slightly **left of felt-centre**,
under a single `The banker says:` header — labels left, values right-aligned in a column, all
**one size** and **one holo-cyan tone**, with **red** on the `−83%` deduction alone. The
`Double or nothing?` call to action sits **last**:

```
The banker says:

Points            124,000
Bankruptcy tax       −83%     ← red
Net                21,080 ⭐   ← the surviving stake you gamble
Your best          50,000 ⭐      (starred; there's no separate
                                   stake row — Net IS the stake)
Double or nothing?
```

The tax rows (Points → Bankruptcy tax → Net) are the **bankruptcy tax**; they only appear on
this entry prompt. Rows cascade in one at a time, and the top-right score counter ticks **down**
gross→net as the `Net` row lands.

**Code.** `drawCodaStake` routes to `drawBankruptcyStatement` when passed a non-null `tax` (a
`CodaTaxBreakdown`). In `GameView` the `codaStakeTax_` field is set only for this entry prompt
(`runCoda_`'s `bet > 0` branch) and cleared once the panel fades. (The victory board keeps its own
centred, larger-number look — the two banker boards deliberately differ.)

**Reach it (dev):** `?dealer=3&chips=40&points=50000` → bust the all-in hand (the tax takes
50,000 down to 8,500). A pure `dealer=` jump seeds score 0, so run naturally to Dealer 3 to
see a real taxed gross.

---

## victory banker scoreboard

**Trigger.** Destroying the 6th dealer (`shiftIndex >= TOTAL_DEALERS`) sets `coda = true` with
`bankruptcyCoda` staying false. The boss dies (laser), then the Banker walks in. This is the
**entry** offer only (no congrats yet).

**What it shows.** The double-or-nothing offer, **centred**, without the tax rows:

```
      The banker says:
      Double or nothing?
      6,400 ⭐               ← the stake
      Your best 50,000 ⭐
```

**Code.** `drawCodaStake` with `tax = null` and `congrats = null` → the centred block.

---

## banker hand player victory scoreboard

**Trigger.** The player **wins a coda hand** — in `runCoda_` the score doubles (`gained > 0`), so
`codaWonHand_` is set and the next prompt shows this board. Reached in **either** coda (victory or
bankruptcy) — winning a hand against the Banker is the same either way. A slow **hand-clap sfx**
(`sfx.play('hand-clap')`) fires as it appears.

**What it shows.** The re-offer, **left-justified** and sat slightly **left of felt-centre** (the
plain victory entry stays centred), with `Double or nothing?` **last**:

```
The banker says:
12,800 ⭐            ← the now-doubled stake
Your best 50,000 ⭐
Double or nothing?
```

**Code.** `drawCodaStake` with `tax = null` and `wonHand = true` → the left-justified block
(`drawStakeLineLeft`, anchored at `cx − scale × CODA_LEFT_SHIFT`). The stake number keeps its
larger lavender treatment and ticks up to the doubled total in lockstep with the top-right counter.

**Reach it (dev):** `?dealer=6&dealerHealth=1&tokens=500&chips=100000`, then win one hand.

---

## final scoreboard

**Trigger.** `run.over` — set by `applyRound` (`won || (chips <= 0 && !bankruptcyCoda)`) or at
the end of a coda (cash out / coda bust, in `Session`). Shown once the ending hand's cards have
been shredded (`scoreRevealAt_`).

**What it shows.** A `GAME OVER`-style summary — a title over POINTS / BEST / HANDS PLAYED /
WIN·LOSS / ENERGY SPENT. The point rows (POINTS, BEST) are **locale-grouped** (thousands
separators — `,` or `.` per the runtime locale), like every point figure on the banker
scoreboards; the count rows stay bare. `WIN / LOSS` shows the **ratio** wins ÷ losses to two
decimals (label unchanged), guarded against divide-by-zero — a flawless run (0 losses) divides by
1, so it reads as the win count (e.g. `12.00`), never NaN/∞. The **title** names which of the three
run-ending paths happened (`buildScore_` in `GameView`):

| Title | Path |
| --- | --- |
| `BANKRUPT` | Broke at **Dealer 1** (`shiftIndex <= BANKRUPTCY_MIN_SHIFT`) — no coda offered. |
| `CASHED OUT` | Player **cashed out** after facing the Banker (banks the stake). |
| `BUSTED` | Player **lost a hand to the Banker** (a coda bust — `run.coda` true, not cashed out; score zeroed). |

The two boards reached **through the Banker** — `CASHED OUT` and `BUSTED` (i.e. `run.coda === true`)
— sit **slightly left of felt-centre** (`drawScoreSheet`'s `shiftLeft`, `SCORE_LEFT_SHIFT = 0.08`,
matching the coda scoreboards); an early `BANKRUPT` (no coda) stays centred.

**Code.** `drawScoreSheet` (the rows) + `drawScoreTitle` (the game wordmark above it).

---

See also: [`docs/dev-params.md`](./dev-params.md) for the URL params used in the "reach it"
recipes above.
