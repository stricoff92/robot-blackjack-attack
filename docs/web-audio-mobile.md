# Building WebAudio that survives iOS (and everywhere else)

**Why this exists.** Getting sound + music to work *and keep working* across an app-switch on
iOS Safari/WebKit is one of the nastiest corners of the web platform, and it bites every project
fresh. This doc is the distilled, battle-tested recipe: how to structure the audio services so they
unlock correctly, survive backgrounding, and resume flawlessly on iOS, Android, and desktop —
plus the exact anti-patterns that *look* right and silently break. Follow the rules; don't
re-derive them under pressure.

This mirrors the working implementation in `src/audio/context.ts` (shared plumbing) with
`src/audio/{music,sfx,voice}.ts` (the services) and the `?audiodebug` overlay in `src/main.ts`.

---

## TL;DR — the seven rules

1. **One `AudioContext` for the whole app.** Never one-per-service. Multiple contexts do *not*
   recover from an iOS interruption together — the idle ones get stuck.
2. **Keep that context alive with a continuously-playing source** (the music). iOS only reliably
   brings a context back out of `interrupted` if it has active audio.
3. **Unlock on the first user gesture.** `resume()` synchronously inside a `pointerdown` /
   `touchend` / `keydown` handler. Keep the listeners attached (not `{ once: true }`).
4. **Suspend on `visibilitychange` → hidden.** Simple and synchronous. Don't get clever.
5. **Resume on the context's `statechange` event**, not just a poll. This is the iOS linchpin.
6. **Gate resume on `navigator.userActivation.hasBeenActive`** and guard against overlapping
   suspend/resume calls.
7. **Don't over-engineer.** No gain-ducking, no deferred suspend, no event-suppression window
   unless you genuinely have a backlog. Every one of those was tried here and made things worse.

If you do 1–7, you're done. The rest of this doc explains *why*, so you can debug the next weird
device.

---

## The mental model: AudioContext states

A browser `AudioContext` moves between these states (`ctx.state`):

| State | Meaning | How you get there |
|-------|---------|-------------------|
| `suspended` | Not producing sound; clock frozen. | Initial state pre-gesture (autoplay policy); after you call `suspend()`. |
| `running` | Producing sound. | After `resume()` inside/after a user gesture. |
| `interrupted` | **iOS/WebKit only.** The OS took the audio session (app switch, phone call, Siri, Control Center). | Backgrounding Safari; another app grabs audio focus. |
| `closed` | Dead permanently. | You called `close()`. |

Two facts do all the damage:

- **Autoplay policy:** a freshly created context is `suspended` and will only go `running` from a
  `resume()` (or a `start()`) that happens *inside or after* a real user gesture.
- **iOS interruption:** on app-switch the context goes `interrupted`. WebKit is buggy here — the
  state may still *read* `suspended`, but `resume()` **rejects with `InvalidStateError`** for as long
  as the interruption lasts. It only succeeds once WebKit ends the interruption, and WebKit tells
  you that moment by firing a **`statechange`** event. This is the whole ballgame.

---

## The reference architecture

### One shared context, many service graphs

Create exactly one `AudioContext`. Each "service" (music, sfx, voice) builds its own sub-graph —
typically its own master `GainNode` for independent volume/mute — and connects to the shared
context's `destination`. They mix at the hardware output, exactly as if they were separate
contexts, but they share one iOS audio session that recovers as a unit.

```
              ┌─ music master gain ─┐
 sources ─────┼─ sfx master gain  ──┼──► sharedCtx.destination
              └─ voice out         ─┘
```

Why not one context per service? Because on an iOS interruption, WebKit only resurrects a context
that has an **active source**. In testing, three separate contexts gave: `music:running` (recovered —
it's always playing) but `sfx`/`voice` stuck at `suspended`/`interrupted`, throwing
`InvalidStateError` forever. Put everything on the music's context and it all rides the session that
comes back.

### The shared plumbing module (skeleton)

This is the essential shape of `src/audio/context.ts`, stripped to the load-bearing parts:

```ts
let sharedCtx: AudioContext | null = null
const inFlight = new WeakSet<AudioContext>()   // never overlap suspend/resume

// Every service calls this; they all get the SAME context.
export function getAudioContext(): AudioContext {
  if (sharedCtx) return sharedCtx
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext
  sharedCtx = new Ctor()
  declarePlaybackSession()               // optional; see "the mute switch" below
  attachGestureUnlock(sharedCtx)
  attachLifecycle(sharedCtx)
  return sharedCtx
}

function resumeCtx(ctx: AudioContext): void {
  if (ctx.state === 'running' || inFlight.has(ctx)) return
  inFlight.add(ctx)
  ctx.resume().catch(() => {}).finally(() => inFlight.delete(ctx))  // InvalidStateError is expected mid-interruption
}

function suspendCtx(ctx: AudioContext): void {
  if (ctx.state !== 'running' || inFlight.has(ctx)) return
  inFlight.add(ctx)
  ctx.suspend().catch(() => {}).finally(() => inFlight.delete(ctx))
}

function activated(): boolean {
  const ua = navigator.userActivation
  return !ua || ua.hasBeenActive     // iOS won't honor resume() before first activation
}

function reconcile(ctx: AudioContext): void {
  if (document.hidden) { suspendCtx(ctx); return }
  if (activated()) resumeCtx(ctx)
}

function attachLifecycle(ctx: AudioContext): void {
  // (a) React to visibility flips.
  document.addEventListener('visibilitychange', () => reconcile(ctx))
  // (b) THE iOS FIX: resume the instant WebKit ends the interruption.
  ctx.addEventListener('statechange', () => { if (!document.hidden) reconcile(ctx) })
  // (c) Belt-and-braces poll so a missed/rejected resume gets retried.
  setInterval(() => reconcile(ctx), 500)
}

function attachGestureUnlock(ctx: AudioContext): void {
  const unlock = () => resumeCtx(ctx)          // synchronous resume INSIDE the gesture
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true })
  window.addEventListener('touchend',   unlock, { capture: true, passive: true })
  window.addEventListener('keydown',    unlock)   // NOT { once: true } — re-unlock after backgrounding
}
```

Three redundant resume triggers — **statechange** (the reliable one), the **poll** (catch-all), and
the **gesture** (first unlock + manual recovery). Redundancy is correct here; each covers a case the
others miss.

### Services plug in, they don't own the context

Each service lazily grabs the shared context and builds its graph once:

```ts
class SfxService {
  private ctx_?: AudioContext
  private master_?: GainNode
  private ctx() {
    if (!this.ctx_) {
      this.ctx_ = getAudioContext()
      this.master_ = this.ctx_.createGain()
      this.master_.gain.value = this.muted_ ? 0 : 1
      this.master_.connect(this.ctx_.destination)
    }
    return this.ctx_
  }
  play(name) {
    const ctx = this.ctx()
    // Just schedule. Do NOT gate on ctx.state here — a sound scheduled on a
    // suspended context plays fine once the shared plumbing resumes it.
    const src = ctx.createBufferSource()
    src.buffer = this.buffers_.get(name)
    src.connect(this.master_!)
    src.start()
  }
}
```

Music is identical but it keeps a source **always playing** (rotate tracks back-to-back). That
continuous playback is what keeps the shared context recoverable — treat it as a feature, not just
ambiance.

---

## iOS-specific gotchas (the ones that cost days)

- **`resume()` rejects with `InvalidStateError` while interrupted.** Expected. Swallow it and let the
  `statechange`/poll retry. Don't treat it as fatal, don't `close()` on it.
- **The state getter lies.** During an interruption `ctx.state` can read `suspended` while `resume()`
  still throws. Never trust the state alone; drive recovery off the `statechange` *event*.
- **`resume()` must originate from a gesture or a statechange, not a bare timer, for the FIRST unlock.**
  The poll handles re-resume after that, but the first time audio ever starts must be gesture-driven.
- **`userActivation.hasBeenActive`** is `false` until the user has interacted; `resume()` is ignored
  before then. Gate on it (defensively — it's absent in some TS DOM libs and older browsers).
- **The ringer/mute switch.** By default iOS routes WebAudio through the physical mute switch. Set
  `navigator.audioSession.type = 'playback'` (once, navigator-wide) to bypass it — at the cost that
  audio is *allowed* to continue in the background. Ship a URL flag (we use `?npb`) to disable it for
  A/B testing, because "the behavior is still wonky" across iOS versions.
- **Tab discarding.** After ~20–30s backgrounded, mobile Safari may **discard and reload** the page
  to reclaim memory. You cannot prevent this in JS. Make it a non-event with run/session persistence
  and a Continue flow — don't mistake it for an audio bug.
- **`AudioBuffer`s are reusable across contexts.** If you ever must recreate the context (the nuclear
  option for a truly `closed`/dead session), you can reuse already-decoded buffers on the new context
  — no re-fetch/re-decode. We did *not* need this once the single-context + statechange fix landed,
  but keep it in your back pocket.

---

## Anti-patterns — everything that looked right and broke

These are real dead-ends from building this. Do **not** reach for them:

- **One `AudioContext` per service.** The headline mistake. Idle contexts don't recover from an
  interruption; you get a maddening "music comes back but SFX don't."
- **A blind `resume()` poll as the *only* recovery.** It fires mid-interruption, hits
  `InvalidStateError`, and — if you don't also listen for `statechange` — may never land. Symptom:
  "audio dead until I reload the page."
- **Ducking a master gain to 0 on background, restoring on foreground.** Tempting for click/tone
  suppression. It sticks silent: if the restore is gated on "all contexts running" (or any state that
  doesn't reliably re-fire), the gain never comes back and that service is dead. Symptom: "music
  resumes but SFX stay silent."
- **Deferring `suspend()` with a `setTimeout`** (e.g. to let a fade finish). iOS freezes your JS on
  backgrounding *before* the timer fires, so you never suspend and audio keeps playing in the
  background. Suspend synchronously in the `visibilitychange` handler.
- **An event-suppression / "drop the backlog" window.** Only needed if your app keeps *generating*
  sounds while hidden. If your render/game loop parks on `visibilitychange` (it should), there is no
  backlog and this machinery just adds fragile coupling.
- **Recreating the context on every hiccup.** Heavy and usually unnecessary. Reserve `close()` +
  recreate for a genuinely `closed` context, not for `interrupted`.

The through-line: **stop fighting the platform.** Suspend on hide, resume on the signals the browser
actually gives you (gesture, statechange), and keep one context alive. Extra cleverness regressed
every time.

---

## On-device diagnostics (you will need these)

iOS Safari has **no visible console** on-device, and this class of bug only reproduces on real
hardware. Build a tiny on-screen overlay, gated behind a URL flag (`?audiodebug`), that renders:

- Each context's live `state`.
- A rolling event log of `suspend`/`resume`/`statechange` calls **and their outcomes** (log the
  `InvalidStateError`!). Collapse repeated lines so the poll spam doesn't bury the signal.
- Two independent tick counters — one from `requestAnimationFrame`, one from `setInterval` — so you
  can *see* which timers actually run after a return (they can differ on mobile).

This overlay is what cracked the bug here; it's cheap, fully gated, and worth keeping in the
production bundle for the next device report. See the `?audiodebug` block in `src/main.ts` and
`getAudioDebugSnapshot()` in `src/audio/context.ts`.

The reproduction that matters: **start audio → switch apps for 10–30s → return.** Everything must
resume with no tap. Then confirm the same with a phone call / Siri interruption, and with the mute
switch both ways.

---

## Testing without a device

The lifecycle logic is pure enough to unit-test in Node (no DOM). Stub `window` / `document` /
`navigator` and a fake `AudioContext` (`{ state, suspend(), resume(), addEventListener }`), capture
the `setInterval` callback, and drive transitions by hand:

- hidden → `suspend()` called;
- visible + activated → `resume()` retried each tick until `running`;
- `resume()` rejecting `InvalidStateError` until a `statechange` fires, then recovering;
- the in-flight guard prevents overlapping calls;
- the gesture path bypasses the activation gate.

See `src/audio/context.test.ts` for the pattern. These tests can't reproduce the real `interrupted`
state (no device API for it), but they lock in the state machine so a refactor can't silently break
it. The `interrupted` path itself is validated on-device via the overlay.

---

## Build checklist

- [ ] Exactly one `AudioContext`, shared by all services.
- [ ] Music (or some source) plays continuously to keep the context alive.
- [ ] First unlock: `resume()` synchronously inside `pointerdown`/`touchend`/`keydown`; listeners
      stay attached.
- [ ] `visibilitychange` → hidden suspends (synchronously); → visible resumes.
- [ ] `statechange` listener resumes when not hidden. **(the iOS fix)**
- [ ] ~500ms poll as a backup retry.
- [ ] Resume gated on `userActivation.hasBeenActive`; in-flight guard around suspend/resume.
- [ ] Per-service master gain for volume/mute; services never own the context.
- [ ] `InvalidStateError` from `resume()` is swallowed, not fatal.
- [ ] Decide on `audioSession.type = 'playback'` (mute-switch bypass vs background playback) + a
      disable flag.
- [ ] `?audiodebug` overlay shipped (gated) for on-device diagnosis.
- [ ] No gain-ducking, no deferred suspend, no suppression window.
- [ ] Persistence + Continue flow so a discarded/reloaded tab is a non-event.
