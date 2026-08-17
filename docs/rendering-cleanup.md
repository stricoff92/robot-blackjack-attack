# Rendering-layer cleanup notes

**Why this exists.** While adding resume-exact persistence (mid-hand / coda reload — see
`src/game/persistence.ts`), a string of *visual* bugs surfaced that the test suite couldn't catch:
an empty felt on resume, the bet chips missing, the wrong dealer identity in the coda, missing
projected text, the shred cards collapsing to a dot, and the Banker's hole card revealed on a
resumed gamble. None were engine bugs — all were in the presentation layer, and most came from the
same few structural weaknesses. This doc records those weaknesses and how to reduce them, so the
next change to this layer is less error-prone.

> **v29 note.** Chips / bet were removed in the economy rework, so the "bet chips missing/shown"
> mentions in this doc are **historical**. The chips canvas layer now carries the dealer
> **hand-summary** (the window slots, between hands) and the coda pot instead.

**Scope.** This is about `src/ui/game-view.ts` and `src/render/*` / the animators. It is NOT about
`src/game/*` — that layer (rules, run/session state, persistence, anti-cheat) is clean,
deterministic, and covered by ~390 tests. Leave it alone; spend effort below the game/render line.

---

## The core problem

`game-view.ts` is a ~3,900-line stateful class: **222 private fields**, **16 `*At_` timestamp
fields** driving implicit "fire at time T" coupling, **22 `coda*` fields**. Presentation state,
animation timelines, audio cues, and the frame loop all live in one object, wired by convention
rather than types. Adding to it means satisfying invariants that nothing enforces — which is
exactly how each bug above slipped in.

The render functions it calls (`src/render/*`) are pure and mostly fine, but a few carry
duplicated or dead logic (below). Critically, **there are no tests for the pure draw functions or
for `game-view.ts` itself** — the animators are tested (`src/ui/*-animator.test.ts`), but
`drawShred` / `drawHands` / the whole `game-view` render path are canvas-only and unverified. Every
bug this round lived in that gap.

---

## Concrete smells (ranked by fragility payoff)

### 1. Duplicated shred logic — HIGH value, LOW risk

`src/render/spawn.ts` has two near-identical "card flies into the dealer's mouth, shrinking, then
sprays paper chunks" routines that **drifted apart**:

- `drawShred` (dealt/table cards) — used `scale = 1 - suck` → collapsed to a *point*.
- `drawOldDeckShred` (the outgoing deck's cards) — `cardScale = 1 - 0.5 * smoothStart2(suck)` +
  `alpha = 1 - smoothStart4(suck)` → shrinks modestly and *fades*.

They looked different on screen ("dealt cards too small") purely because the shared idea was
copy-pasted and one copy was tuned and the other wasn't. It's now hand-synced (both use the
`1 - 0.5*…` + fade), but nothing keeps them in sync.

**Cleanup:** extract one helper, e.g. `shredCardToMouth(ctx, sprite-or-drawer, from, mouth, suck,
{ fade })`, that owns the fly path + shrink curve + fade + chunk timing. `drawShred` passes a
face-up card drawer (`drawCardCentered`), `drawOldDeckShred` passes a back drawer
(`drawBackCentered`) with the deck's extra "lift off the top" offset. One curve, one place to tune.

**Verify:** visual only (no test covers `drawShred`). Eyeball a dealer-death shred and the coda
entry shred; the two should look identical to today.

### 2. Dead `revealHole` plumbing — MEDIUM value, LOW risk

`revealHole` is computed at each call site (`game-view.ts` `drawCards_`) and threaded through
`drawHands → drawDealt` and `→ faceUpDealer` (`src/render/cards.ts`). But when a `CardAnim` is
present — which it always is in real rendering — both the card **flip** and the dealer **count**
read from the animator (`st.flip`), and `revealHole` is used *only* in the `else` (no-anim)
fallback that never runs. So it's a parameter that misleads: it looks like it controls hole
visibility, but the animator does.

This is what made the hole-reveal bug subtle: the true control is the animator's flip, seeded by
`DealAnimation.settle` / scheduled by `sync`. The rendering `revealHole` was a red herring.

**Cleanup (pick one):**
- (a) Remove the no-anim fallback and the `revealHole` parameter entirely if `anim` is provably
  always present (make `anim` required). Then hole visibility has exactly one source of truth: the
  animator, seeded from `round.status`.
- (b) If the no-anim path must stay, rename/comment it so it's clear it's a fallback, and route its
  value through the same `holeRevealed(state)` predicate as #3.

**Verify:** `deal-animator.test.ts` already asserts settle's hole behavior; add a no-anim render
assertion only if keeping path (a) is rejected.

### 3. "phase === 'playing'" as a proxy for "a hand is in play" — HIGH value, LOW risk

The coda is `phase === 'coda'` throughout, but it reuses the main-game render/animation paths via a
**synthetic-phase remap** in `codaAnimSync_` (`round.status === 'resolved' ? 'resolved' :
'playing'`). Any code that branches on the *raw* phase (`phase === 'playing'` / `!== 'playing'`) to
mean "the player is mid-hand" silently mis-handles the coda. This is the exact bug class that
revealed the Banker's hole on resume: `DealAnimation.settle` used `phase !== 'playing'` instead of
`round.status`.

Audited sites (grep `'playing'`): most are already coda-aware (`|| phase === 'coda'`), action-
driven (fire on a move, not a render), or main-game-only (split/bust-block/mulligan). The two that
meant "hand in play" (`settle`, and the inert `drawCards_` `revealHole`) are now fixed to use
`round.status`.

**Cleanup:** add tiny shared predicates so intent is explicit and coda-safe, and convert the
"hand in play" checks to them:
```ts
// somewhere shared (e.g. src/game/round.ts or a ui helper)
const isPlayerTurn = (r: Round | null) => r?.status === 'player-turn'
const holeRevealed = (s: SessionState) => s.round != null && s.round.status !== 'player-turn' || s.peeked
```
Then grep-and-replace the "is a hand being played" phase checks. Keep the *genuinely* main-game-only
checks (emotes, split) on phase — the point is to separate "which game mode" from "is a hand live."

**Verify:** the added `deal-animator.test.ts` coda case guards the hole; add one predicate unit test.

### 4. Resume re-seeds scattered "scene setup" — HIGH value, MEDIUM risk

Normal play sets up presentation state across the frame loop + the `run_` diff handler (dealer
identity, deck colour, `codaStakeShownAt_`, `codaCounters_`, the animator's card timings, HUD
reveal…). Resume (`resumeSettled_`) has to *replicate a subset by hand* — which is why fields kept
getting missed one at a time (Banker identity, then the stake panel, then the hole). There's no
single definition of "what the scene looks like for a given `SessionState`."

**Cleanup:** centralize a `presentState(state)` (or `seedSceneFor(state)`) that derives ALL
presentation from a `SessionState` — dealer identity + level, deck colour, which readouts are up,
the animator's settled card timings — and have BOTH the normal flow and `resumeSettled_` call it.
Resume becomes "call `presentState`, skip the ceremony animations," not "remember every field the
ceremony would have set." This is the highest-leverage fix for *future* resume bugs but touches the
most code — do it deliberately, with the resume matrix (below) as the acceptance check.

### 5. `game-view.ts` god-class — HIGH value, HIGH risk (do last / incrementally)

222 fields in one class is the root cause of the above. Natural seams to extract, each owning its
own fields + render + timeline:
- **CodaPresenter** — the 22 `coda*` fields, `drawCodaStake`/`drawCodaCounters` calls, coda timers
  (`codaStakeShownAt_`, `codaAdvanceAt_`, `codaArrivalAt_`, …), and `codaAnimSync_`.
- **Ceremony/timeline** — the 16 `*At_` "fire at T" fields (deal, shred, walk-in, laser) behind a
  small scheduler instead of scattered `if (now >= xAt_)` blocks in the frame loop.
- **Resume seeding** — `presentState` from #4.

Do this incrementally (one seam at a time, keep it green) — a big-bang split of a 3,900-line
untested class is how you get a worse chat than this one.

---

## Conventions to adopt (would have prevented this round's bugs)

1. **Hole visibility is `round.status`-based, never `phase`-based.** The animator is the single
   source of truth for card flips; set it from status. (Bug: resumed-coda hole reveal.)
2. **One animation, one implementation.** If two ceremonies animate "a card into the mouth," they
   call one helper. (Bug: dealt-vs-deck shred drift.)
3. **Resume must not re-list fields.** Any state the normal flow sets from `SessionState` should be
   set by a shared `presentState`, so resume can't miss one. (Bugs: Banker identity, stake panel.)
4. **A parameter that's ignored on the real path is a bug, not documentation.** Remove it or make it
   authoritative. (Bug: `revealHole` red herring.)

---

## How to verify safely (the canvas gap)

The engine is test-covered; the render layer is not, and that's where every bug this round lived.
Two ways to close the gap:

- **Push logic into the animators** (which *are* unit-tested): `DealAnimation`, `SpawnAnimation`,
  `CodaCounterAnimation`, etc. The more "what should be visible" lives in a tested animator vs a
  pure draw call, the more a test can catch. `deal-animator.test.ts`'s settle/coda cases are the
  model.
- **Manual resume checklist** (until there's a visual harness). Resume must be eyeballed for each
  entry state — walk these once after any render/resume change:

  | Saved phase | Expect on Continue |
  |---|---|
  | betting | walk-in, auto-deal |
  | playing (incl. split, armed powerup) | same cards/turn, hole DOWN |
  | resolved (no kill) | hand-summary shown, advances to next hand on click |
  | resolved (kill) | hand-summary greens flip, advances to upgrade pick → deal |
  | coda prompt | Banker shown, pot + BEST projected, double/cash |
  | coda mid-gamble | gamble hand, Banker hole DOWN |
  | coda resolved-gamble / entry hand | auto-advances to prompt |

A lightweight visual harness (render a fixed `SessionState` to an offscreen canvas and snapshot, or
just a dev route that jumps straight to each state) would let these be checked without playing to
the coda every time.

---

## Suggested order

1. #3 predicates + #1 shred dedupe — small, safe, kill two whole bug classes.
2. #2 `revealHole` removal — small, clarifying.
3. #4 `presentState` — medium, the big win for resume robustness.
4. #5 god-class seams — large, incremental, only with the checklist as a net.
