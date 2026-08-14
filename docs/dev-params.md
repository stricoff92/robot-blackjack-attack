# Dev / debug URL params

Query-string switches for exercising the game without grinding — force specific
hands, jump to a later dealer, seed upgrades, and so on.

**Dev-server only.** These are read from `window.location.search` and gated behind
`import.meta.env.DEV`, so they work under `npm run dev` and are **compiled out of
the production build** (`npm run build`) — they can never fire on the deployed
game. Source of truth: [`src/game/debug.ts`](../src/game/debug.ts).

**"token" = player-facing "ENERGY".** The `tokens` / `tokenUpgrades` params (and the code) keep
the internal name **token**; the player only ever sees **ENERGY**. It's a display-layer rename —
see [the nomenclature note in the rules doc](./blackjack-roguelike-rules.md#6-tokens).

**Initial run only.** Every param seeds the **first** run of the page. Pressing **New run**
starts a **clean default run** that ignores all of them (first dealer, default tokens, zero
score, no forced hands) — so a debug-seeded run can never re-seed the same state on restart.
Reload the page to apply the params again.

## Usage

Append to the dev URL as normal query params, combining freely with `&`:

```
http://localhost:5173/?dealer=3&tokens=500&chipUpgrade=2
```

(The browser-test server the tooling uses is port `5199`; the default `npm run dev`
server is `5173`.)

## Parameters

| Param | Value | Effect |
| --- | --- | --- |
| `forcePairs` | *(flag)* | Every deal gives the player a splittable pair. |
| `forcePairs=<rank>` | `2`–`10`, `J`, `Q`, `K`, `A` | …a pair of that specific rank. |
| `tokens=<n>` | non-negative int | Start the run with `n` tokens (buy powerups off the first deal). |
| `points=<n>` | non-negative int | Start the run with `n` score points (test the [banker coda](./scoreboards.md) stake without grinding a real score). |
| `dealerHealth=<n>` | `1`–`100` | Start the first dealer at `n`% health (see the low-health eye flicker / a quick kill). |
| `hearts=<n>` | `1`–`5` | Start with `n` player hit points (heart-chips) — reach the heart pop, heal beam, or heart-death coda without grinding losses. `hearts=1` → the next loss pops the last heart and opens the coda; `hearts=2` → a qualifying win heals back. |
| `dealer=<n>` | `1`–`6` | Start the run at dealer `n` (jumps straight to that dealer's colour). |
| `sabotageUpgrade=<t>` | `0`–`3` | Start with the **Sabotage** (anti-dealer) path unlocked through tier `t`. |
| `chipUpgrade=<t>` | `0`–`3` | Start with the **Payout** path unlocked through tier `t`. (Legacy param name — the path pays out in points now, not chips.) |
| `tokenUpgrades=<t>` | `0`–`3` | Start with the **Energy** (`tokenEco`) path unlocked through tier `t`. |
| `dealerBlackjack` | *(flag)* | The dealer draws a natural 21 (Ace + ten-value) **every** hand. |
| `playerBlackjack` | *(flag)* | The player is dealt a natural 21 (Ace + ten-value) **every** hand (test the blackjack point bonus / win). |
| `rewardad` | *(flag)* | Force the "watch ad for +100 energy" button visible on every between-hands (Next-hand) screen, past its low-energy threshold + once-per-dealer / 3-per-run caps. Off-platform the reward is granted immediately (no real ad serves in dev), so the flow is testable on demand. Pair with `tokens=<n>` to also see it under its natural low-energy trigger. |

Invalid or out-of-range values are ignored (the param falls back to off). Numeric
params are clamped to their stated range; `dealer` also caps at the roster size.

### Dealer colours (`dealer=`)

`1` blue · `2` purple · `3` green · `4` yellow · `5` red · `6` the RGB-cycling final dealer.

## Upgrade tiers

The three upgrade params seed the run's roguelite upgrades on load, so you don't
have to destroy dealers to reach them. **Tiers stack in order** — a value of `t`
unlocks tiers `1..t` of that path (so `3` = fully maxed, `0` = same as off). The
choose-upgrade screen still appears after kills and continues from the seeded tiers.

| Tier | `sabotageUpgrade` (Sabotage) | `chipUpgrade` (Payout) | `tokenUpgrades` (Tokens) |
| --- | --- | --- | --- |
| 1 | +20 energy on any dealer 21 (natural or hit-to-21) | Natural blackjack scores +50% | +10% tokens · 25% inflation resist |
| 2 | Any dealer 21 (natural or hit) redeals the hand | Natural blackjack scores +100% | +18% tokens · 45% inflation resist |
| 3 | Hijack the dealer's natural blackjack (you win) | You win all pushes (a hit + points) | +30% tokens · 65% inflation resist |

## `dealerBlackjack` — forcing the dealer-natural outcomes

`dealerBlackjack` makes the dealer's opening two cards a natural 21 every hand,
which resolves the round right at the deal. Combine it with `sabotageUpgrade` /
`chipUpgrade` to force each dealer-natural branch on demand:

| Combination | What you see every hand |
| --- | --- |
| `?dealerBlackjack` | Plain loss to the dealer's blackjack. |
| `?dealerBlackjack&sabotageUpgrade=1` | Plain loss, but **+20 energy** lands on the dealer's 21 (watch the ENERGY counter). |
| `?dealerBlackjack&sabotageUpgrade=2` | **REDEAL** — the dealer 21 voids the round and a fresh hand deals (no window slot spent); the **+20 energy** still pays. |
| `?dealerBlackjack&sabotageUpgrade=2&chipUpgrade=3` | The dealer 21 resolves as a **win** instead of redealing (Payout T3); **+20 energy** on top. |
| `?dealerBlackjack&sabotageUpgrade=3` | The **hijack** — you take it as a blackjack (+21 energy) with the **+20** stacked on top (T3 also carries the redeal tier). |

## Examples

```
?forcePairs=8                          # split 8s every hand
?forcePairs&tokens=1000                # splits + re-splits with tokens to burn
?dealer=6&dealerHealth=5               # the final RGB dealer, near death
?dealer=6&points=50000                 # jump to Dealer 6 with a score, to reach the coda quickly
?chipUpgrade=3&tokenUpgrades=2         # maxed Payout + Energy through tier 2
?sabotageUpgrade=3&dealer=5            # maxed Sabotage, starting at dealer 5
?dealerBlackjack&sabotageUpgrade=1     # +20 energy on the dealer-natural loss (Sabotage T1)
?playerBlackjack&chipUpgrade=1         # blackjack scores +50% every hand (Payout T1)
?playerBlackjack&dealerBlackjack       # both naturals → a push every hand
```
