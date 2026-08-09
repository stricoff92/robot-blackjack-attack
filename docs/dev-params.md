# Dev / debug URL params

Query-string switches for exercising the game without grinding — force specific
hands, jump to a later dealer, seed upgrades, and so on.

**Dev-server only.** These are read from `window.location.search` and gated behind
`import.meta.env.DEV`, so they work under `npm run dev` and are **compiled out of
the production build** (`npm run build`) — they can never fire on the deployed
game. Source of truth: [`src/game/debug.ts`](../src/game/debug.ts).

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
| `chips=<n>` | positive int | Start the run with `n` chips (test the wealth-floor bet — §5 — with a fat stack). |
| `dealerHealth=<n>` | `1`–`100` | Start the first dealer at `n`% health (see the low-health eye flicker / a quick kill). |
| `dealer=<n>` | `1`–`6` | Start the run at dealer `n` (jumps straight to that dealer's colour). |
| `sabotageUpgrade=<t>` | `0`–`3` | Start with the **Sabotage** (anti-dealer) path unlocked through tier `t`. |
| `chipUpgrade=<t>` | `0`–`3` | Start with the **Payout** (chip) path unlocked through tier `t`. |
| `tokenUpgrades=<t>` | `0`–`3` | Start with the **Tokens** path unlocked through tier `t`. |
| `dealerBlackjack` | *(flag)* | The dealer draws a natural 21 (Ace + ten-value) **every** hand. |
| `playerBlackjack` | *(flag)* | The player is dealt a natural 21 (Ace + ten-value) **every** hand (test the blackjack payout / win). |

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
| 1 | 75% refund on a dealer natural blackjack | Natural blackjack pays 2:1 | +10% tokens · 25% inflation resist |
| 2 | Any dealer 21 (natural or hit) voids the hand | Natural blackjack pays 3:1 | +18% tokens · 45% inflation resist |
| 3 | Hijack the dealer's natural blackjack (you win) | You win all pushes (chips only, no damage) | +30% tokens · 65% inflation resist |

## `dealerBlackjack` — forcing the dealer-natural outcomes

`dealerBlackjack` makes the dealer's opening two cards a natural 21 every hand,
which resolves the round right at the deal. Combine it with `sabotageUpgrade` /
`chipUpgrade` to force each dealer-natural branch on demand:

| Combination | What you see every hand |
| --- | --- |
| `?dealerBlackjack` | Plain loss to the dealer's blackjack. |
| `?dealerBlackjack&sabotageUpgrade=1` | The **75% refund** — bet flies to the dealer, then a refund stack slides back. |
| `?dealerBlackjack&sabotageUpgrade=2` | **VOIDED** — the hand is a wash (bet returned, no damage). |
| `?dealerBlackjack&sabotageUpgrade=2&chipUpgrade=3` | The voided dealer 21 pays out as a **chips-only win** (Payout T3). |
| `?dealerBlackjack&sabotageUpgrade=3` | The **hijack** — you take it as a blackjack (`sabotageUpgrade=3` also carries the void + refund tiers; add `chipUpgrade=2` for the 3:1 rate). |

## Examples

```
?forcePairs=8                          # split 8s every hand
?forcePairs&tokens=1000                # splits + re-splits with tokens to burn
?dealer=6&dealerHealth=5               # the final RGB dealer, near death
?dealer=6&chips=8000                   # Dealer 6 with a fat stack → the 25% wealth-floor bet kicks in
?chipUpgrade=3&tokenUpgrades=2         # maxed Payout + Tokens through tier 2
?sabotageUpgrade=3&dealer=5            # maxed Sabotage, starting at dealer 5
?dealerBlackjack&sabotageUpgrade=1     # watch the refund animation on repeat
?playerBlackjack&chipUpgrade=1         # see the blackjack payout every hand (2:1 with Payout T1)
?playerBlackjack&dealerBlackjack       # both naturals → a push every hand
```
