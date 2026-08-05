# Robot Blackjack Attack

game design: docs/blackjack-roguelike-rules.md

dev/debug URL params (dev-server only): docs/dev-params.md

### Clean Code
 - Follow existing patterns.
 - Suggest changes to existing patterns when there is a big improvement to readability, or performance. Do not make performance improvements that hurt readability.
 - Comments: forbidden by default. Only add one when it documents non-obvious *why* — a hidden constraint, a subtle invariant, a workaround for a specific bug. Never describe *what* the code does. No section dividers, no method preambles
 - Each unittest and integration test should tell a story about how the app works. If a code comment helps tell that story add a comment. Prefer to write extremely readable tests instead of writing comments in tests.
 - All function names should have a verb: for example "calculate", "update", "delete", "patch", "validate"
 - Don't use the variable "e" unless it's for an event or error.
 - Avoid unnecessary abbreviations. For example: dont say evt when event is more readable and doesn't take up excessive space.
 - follow defensive coding patterns:


```ts
// BAD
if(condition_a) {
  // condition a
} else {
  // condition b
}

// GOOD
if(condition_a) {
  // condition a
} else else(condition_b) {
  // condition b
} else {
  throw new Error("not implemented")
}
```

```ts
// BAD
myfunction() {
  if(condition) {
    // logic (deeply nested)
  }
  // invalid state is silently ignored
  return
}

// GOOD
ECODE myfunction() {
  if(!condition) {
    // this should never happen
    throw new Error("Not implemented")
  }
  // logic (less nested)
  return
}
```


## CrazyGames Platform

This game ships to CrazyGames as a static HTML5 bundle. `npm run build` outputs to `dest/`; a zip of its contents (with `index.html` at the root) is what gets uploaded. No server-side code. Details below reflect knowledge as of early 2026 — confirm SDK method names against https://docs.crazygames.com before integrating.

### Build & assets
 - Use relative asset paths (`base: './'` in Vite). The game is served from a subpath, so absolute `/assets/...` paths break.
 - Keep the initial bundle small and load fast; show a loading indicator for anything slow.
 - Keep assets bundled/local. Avoid external network requests — they may be blocked.

### Responsive canvas (required)
 - The game runs in an iframe and must fill whatever space it is given, on desktop and mobile, and re-layout on resize / orientation change. No fixed pixel dimensions.
 - Size the canvas backing store to `cssSize * devicePixelRatio` and scale the 2d context by DPR so rendering stays crisp; game code draws in logical (CSS) pixels. See `src/render/canvas.ts`.
 - `html, body, #app` fill the viewport; `overflow: hidden` (no scrollbars); `touch-action: none` on the canvas so mobile gestures don't scroll or zoom the page.
 - Support both mouse/keyboard and touch input.

### SDK (integrate later, wrap in a typed module)
 - Load the CrazyGames SDK from their CDN `<script>` tag, not npm.
 - Signal active play with gameplay start/stop calls, and loading start/stop around asset loading.
 - Mute all audio while an ad plays and restore it afterward; provide a mute button.
 - Start audio only after a user gesture (browser autoplay policy).
 - Use the SDK's data module for persistence — iframe localStorage may be partitioned.

## Git

All claude code changes are done on a branch which is already set. Claude will not run any git commands. Ideally each branch has at most 1000 additions. There is no limit to the number of deletions on a branch.

The user will merge PRs and manage branches.


