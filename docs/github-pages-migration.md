# Migrating from CrazyGames to GitHub Pages

Target: `https://stricoff92.github.io/robot-blackjack-attack/`, a GitHub Pages project page built
from this repo by a GitHub Actions workflow. No CrazyGames SDK, no ads, no leaderboard, no sitelock.
All persistence goes to `localStorage`.

## TL;DR: what actually blocks the game today

The platform layer already degrades when the SDK is missing. `src/platform/crazygames.ts` falls back
to `localStorage`, midgame ads finish immediately, the rewarded button hides, and the banner reports
"unfilled". **Only two things stop a plain `dest/` from running on github.io:**

1. **The sitelock** (`src/platform/sitelock.ts`). In a production build it blanks the screen on any
   host whose second-level label isn't `crazygames`, and `github.io` fails that check.
2. **The SDK `<script>` tag** in `index.html`. It doesn't break anything, but it's an external
   request to a dead platform on every load.

Phase 1 fixes those two and gets the game deployed. Phase 2 deletes the CrazyGames code. Phase 2 is
mostly deletions, so it fits the 1000-additions-per-branch budget easily.

---

## Phase 1: Ship it (one small branch)

### 1.1 Remove the sitelock

- Delete `src/platform/sitelock.ts` and `src/platform/sitelock.test.ts`.
- `src/main.ts`: remove the `bootAllowed, renderLock` import (line 6) and the
  `if (!bootAllowed()) { renderLock(root); await new Promise<never>(() => {}) }` block plus its
  comment (~lines 267–274).
- `src/vite-env.d.ts`: remove `VITE_UNLOCK`.
- `CLAUDE.md` and the `sitelock` memory: drop the `VITE_UNLOCK` preview hatch.

*Why delete it and not point it at `stricoff92.github.io`:* the sitelock existed to stop people
re-hosting the bundle to run their own ads on CrazyGames' content. With the source on public GitHub
and no ad revenue to protect, a host check costs more than it saves: it would blank forks, local
previews, and any future custom domain. If you still want one, change `MASKED` to `stricoff92` and
compare against the *third*-to-last label (`stricoff92.github.io` → `parts[parts.length - 3]`).

### 1.2 Remove the SDK script tag

- `index.html`: delete the `<script defer src="https://sdk.crazygames.com/crazygames-sdk-v3.js">`
  line and the comment above it.
- In the same file, the CSS comments mention "CrazyGames-recommended" and "CrazyGames ad container".
  Reword them to platform-neutral text (the CSS itself stays: the selection, callout, and
  double-tap-zoom suppression all still matter on mobile web).
- Add a `<meta name="description">` and a favicon (`public/favicon.png`). On a top-level page, the
  browser tab and link previews now show them. CrazyGames used to supply this framing.

### 1.3 Shrink the 3-second SDK wait

`src/main.ts` ~line 254 races `initCrazyGames()` against `SDK_INIT_TIMEOUT_MS = 3000`. With the
script gone, `initCrazyGames()` returns immediately (no `window.CrazyGames`), so boot isn't delayed.
No change is needed in Phase 1. Phase 2 deletes the race.

### 1.4 Build script: drop the CrazyGames zip

`build.sh` ends by calling `./package.sh`, which **fails** on a github.io build. It requires the
sitelock mask (`88,73,90,...`) and a leaderboard encryption key in the bundle.

- `build.sh`: replace the final `./package.sh` with a verify-only step, or remove it.
- `package.sh`: either delete it or rename it to `verify-dest.sh` and keep only the checks that
  still apply:
  - **keep:** `dest/index.html` exists, entry bundle resolves, sources not newer than the build,
    single-build mtime spread, no `.map` / `.env*` / `.ts` / OS junk, no orphan assets, minified,
    dev-only markers absent.
  - **remove:** the sitelock-mask check, the whole encryption-key block, and the zip/`builds/`
    section. Rename the `'[crazygames]'` marker to whatever prefix the new storage module logs
    under (see 2.1).
- Delete the `builds/` directory and its `.gitignore` lines (`builds/`, `rba-*.zip`).
- Delete `encryption_key.txt` locally. It's gitignored and was never committed, and the portal key
  is meaningless now.

### 1.5 Add the Pages deploy workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22        # Vite 8 needs Node >= 20.19 / 22.12
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npx vite build      # tsc already ran above; same step build.sh uses
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dest
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Notes:
- `base: './'` in `vite.config.ts` already makes every asset URL relative, so the
  `/robot-blackjack-attack/` subpath just works. Don't change it to an absolute base.
- `deploy-pages` serves the artifact as-is (no Jekyll), so no `.nojekyll` is needed.
- Asset filenames contain spaces and commas (e.g. `Kevin MacLeod-Enigma-*.m4a`). Pages serves those
  fine because Vite emits URL-encoded references. If you ever hand-copy `dest/` into another repo
  instead, double-check that they survive.
- `public/OFL.txt` still ships at the site root, as the font license requires.

### 1.6 Turn on Pages (manual, in the GitHub UI)

**No new repo is needed.** GitHub Pages has two kinds of site:

- **User site:** a repo literally named `stricoff92.github.io`, served at the root
  `https://stricoff92.github.io/`. Only needed for a homepage, and optional.
- **Project site:** *any* repo can have Pages turned on, and it's served at
  `https://stricoff92.github.io/<repo-name>/`. This repo becomes
  `https://stricoff92.github.io/robot-blackjack-attack/`.

Both share the `stricoff92.github.io` domain whether or not the user-site repo exists. "Deploying"
means a workflow builds `dest/` and uploads it to GitHub, which hosts those static files. There's
no server and nothing to pay for.

Steps:

1. **Make the repo public** (Settings → General → Danger Zone → Change visibility), if it isn't
   already. Free-plan Pages requires it. This publishes the full source, `docs/`, and git history,
   so check first:
   - `docs/asset-attributions.txt` contains "a third party's personal email address". Remove it.
     If it's in an older commit, it's in history too. Ask the attribution owner whether that's
     fine, or rewrite history before going public.
   - `encryption_key.txt` and `.env*` are gitignored and were never committed. Confirm with
     `git log --all -- encryption_key.txt` (should print nothing).
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Merge the Phase 1 PR to `main`. The **Actions** tab shows the "Deploy to GitHub Pages" run.
   When it goes green (~1–2 min), the run summary links the live URL.
4. Every later merge to `main` redeploys automatically. The **Run workflow** button on the Actions
   tab (from `workflow_dispatch`) redeploys without a commit.
5. Optional: make a `stricoff92.github.io` repo with an `index.html` linking to the game, for a
   homepage.

At this point the game is live, ad-free, and saving to `localStorage`.

---

## Phase 2: Delete the CrazyGames layer (one deletion-heavy branch)

### 2.1 Replace `platform/crazygames.ts` with a storage module

Create `src/platform/storage.ts` exporting `loadValue`, `saveValue`, `removeValue`, and
`logStorageHealth`. Lift these from `crazygames.ts` (the "Durable key/value storage" section) and
remove the `platformStore()` / SDK branch:

- keep the `localStorage` → in-memory `Map` fallback and the one-shot `warnStorageLost` (iOS Private
  tab / Block All Cookies / in-app webview still apply);
- `logStorageHealth`: drop the `SDK.data` branch and rename the `[crazygames]` log prefix to
  `[storage]`. Update the matching dev-marker token in `package.sh` / `verify-dest.sh`.

Update importers:
- `src/game/persistence.ts:18` → `'../platform/storage'`
- `src/game/leaderboard.ts:11` → `'../platform/storage'`
- `src/game/persistence.test.ts:37` and `src/game/leaderboard.test.ts:12`: retarget the `vi.mock`
  paths and drop the mocked SDK functions.

`src/game/music-mute.ts` and `src/game/power-mode.ts` already use raw `localStorage` on purpose
(device-local prefs). They can switch to `storage.ts` to share the memory fallback, or stay as they
are. Either way, the comments explaining "deliberately NOT SDK.data" need rewording.

Then delete `src/platform/crazygames.ts` and `src/platform/crazygames.test.ts`.

### 2.2 Personal best (`src/game/leaderboard.ts`)

- `recordRun()`: remove `submitToCrazyGames(score)` and `happytime()`. Keep `nextBest` and the
  `rba.personalBest` save. The "score to beat" was always the local best, so the player sees no
  change.
- Consider renaming the file to `personal-best.ts`, since there's no leaderboard anymore. Update
  `src/ui/game-view.ts:12`, `src/game/session.ts` (~line 831 comment), and the comments in
  `src/render/coda-stake.ts:95` and `src/render/tap-to-start.ts:84` that say "CrazyGames
  leaderboards are submit-only".
- `src/vite-env.d.ts`: remove `VITE_CG_ENCRYPTION_KEY`. Once nothing else is declared there,
  collapse the file back to just `/// <reference types="vite/client" />`.

### 2.3 Boot (`src/main.ts`)

- Remove the SDK import (line 5), the `SDK_INIT_TIMEOUT_MS` race (~248–259), `loadingStart()` /
  `loadingStop()`, `getMuteSetting()` / `onMuteChange()`, and `setAudioMuteControl()`.
- Import `logStorageHealth` from `./platform/storage`.
- The `await` the race introduced was the only top-level await besides the sitelock. Once both are
  gone, `main.ts` boots synchronously. Check that the boot-splash removal and the
  `BOOT_SPLASH_FAILSAFE_MS` failsafe still read correctly.
- The `describeError` / injected-script diagnostics name "the CrazyGames SDK" as a candidate
  (~lines 122–128). Reword them.

### 2.4 Audio "platform mute"

`music.setMuted`, `sfx.setMuted`, and `voice.setMuted` exist only to honour CrazyGames'
`settings.muteAudio` and to mute during ads. With both gone, nothing calls them.

**Decided: repurpose it as a mute-all toggle.** Today the only in-game audio control is the *music*
mute (`music-mute.ts`), so SFX and the dealer voice can't be silenced except by system volume.

- Add `src/game/audio-mute.ts`, modeled on `music-mute.ts`: `isAllMuted()` / `setAllMuted()`,
  persisted under `rba.allMuted`.
- `main.ts`: keep `applyMute` (music + sfx + voice `setMuted`) and call it with `isAllMuted()` at
  boot, replacing `getMuteSetting()`.
- Add a mute-all button to the HUD and the title screen next to the music and battery toggles. It
  calls `setAllMuted` + `applyMute`.
- Mute-all overrides the music mute. Unmuting all restores music only if the music toggle is
  still on. The `setMuted` (master) vs `setUserMuted` (music pref) split in `music.ts` already
  supports this.

### 2.5 Ads: remove every surface (`src/ui/game-view.ts` + CSS)

| Surface | Where | Action |
| --- | --- | --- |
| Rewarded "+100 energy" button | button def `key: 'watch-ad'` (~3085–3110), the `watch-ad` branches in `buildOverlay_` (~3270–3311) and ~5172, `watchRewardedAd_` (~4660), `showAdToast_`, `adRequestPending_`, `adWasOffered_`, `REWARDED_AD_*` / `AD_OFFER_COOLDOWN_HANDS` constants | delete |
| Dealer-3 → 4 interstitial | `arriveMaybeWithAd_` (~4589); callers `playArrival_` / `playWindowArrival_` | inline `run()` at both call sites, delete the method + `AD_BREAK_INCOMING_SHIFT` |
| New-run interstitial | `requestNewRunWithAd_` (~4723) | call `this.run_(() => this.session_.restart())` directly, and keep `hideScoreBanner_` removal below in mind |
| Ad pause guard | `adPausing_` (field ~725, checks ~2792 / 2807 / 2830) | delete the field and the three `&& !this.adPausing_` clauses |
| Score-screen banner | `scoreBannerEl_` (~3357), `showScoreBanner_` / `hideScoreBanner_` / `reflowScoreBanner_` (~4606–4658), call sites ~1246, ~2475–2482, ~4188, `SCORE_BANNER_ID`, `BANNER_MIN_REQUEST_GAP_MS`, `scoreBanner*_` fields | delete |
| `?suppressads` / `?rewardad` | `src/game/debug.ts` (~29–35, 119–120), `suppressAds_` in game-view, `docs/dev-params.md` table rows | delete |
| CSS | `game-view.css`: `.hud-score-banner*` (~84–110), `.hud-btn-watch-ad*` + `.watch-ad__*` (~1164–1230 and the media-query copies at ~1343, ~1658, ~1875) | delete |
| Icon asset | `src/assets/video-marketing.png` (the ad film-strip glyph) | delete if nothing else imports it, otherwise `verify-dest.sh`'s orphan check passes anyway |

Watch out for the rewarded-ad offer layout. The `rewarded-ad-band` memory says the offer banner is
"a class on the existing action row + a bottom scrim". Remove that class and the scrim, and confirm
that Next hand still sits where it should on phone portrait and landscape.

### 2.6 Gameplay / progress signals

- `game-view.ts` ~614 (the "told CrazyGames a hand is actively being played" field), the
  `gameplayStart` / `gameplayStop` method (~2397–2412), and the `reportGameCompletedPercentage`
  method (~2416–2431) plus their call sites: delete.
- `isCrazyGamesApp` and `pickBannerSize` disappear with 2.5.

### 2.7 RunState: ad counters (save-shape change)

`src/game/run.ts` carries `rewardedAdsThisRun`, `rewardedAdShiftIndex`, and `adDeclinedAtHand`
(+ `AD_NEVER_DECLINED`). They're serialized, so removing them changes the save shape:

- delete the three fields, their initial values (~259–261), and `AD_NEVER_DECLINED`;
- `src/game/session.ts`: delete `grantRewardedEnergy` / `declineRewardedAd` and the
  rewarded-energy constant (~130);
- `src/game/persistence.ts` ~108–122: delete the backfills;
- `src/game/keymap.ts`: remove the `ra`, `rx`, and `adDeclinedAtHand` codes. **Don't reuse those
  short codes** for future fields;
- **bump `RULES_VERSION`** and add a `vNN:` line to the history comment in `run.ts`. This discards
  any old save, which is harmless: github.io is a new origin, so no CrazyGames-era save exists there;
- update the affected tests (`session.test.ts`, `persistence.test.ts`,
  `resume.integration.test.ts`, `refresh-exploits.integration.test.ts`, `run.test.ts`).

**Decided:** the rewarded ad is dropped with no replacement energy. The economy stays as it is.

### 2.8 Credits screen

`CREDITS` in `game-view.ts` (~5328) shows URLs as plain text "because the game runs inside the
CrazyGames iframe, which restricts outbound navigation". On github.io you can make them real
`<a target="_blank" rel="noopener">` links. That's optional, since CC BY doesn't require it.
Update the header of `docs/asset-attributions.txt` either way.

### 2.9 Comment and doc sweep

`grep -rni crazygames src docs index.html vite.config.ts` should come back empty (except this file).
Known hits beyond the ones above:

- `src/audio/music.ts` (~136, ~192), `src/audio/sfx.ts` (~205, ~243), `src/audio/voice.ts` (~250):
  "platform mute (CrazyGames settings.muteAudio)". Update per the 2.4 decision.
- `src/game/obfuscate.ts`, `src/game/highscore.ts:2`, `src/game/persistence.ts` header (the "SDK.data
  … debounced ~1s … 1 MB cap" paragraph now just says "localStorage").
- `src/ui/game-view.css`: header safe-area note (~10–16), press-pop note (~1186), ad-indicator note
  (~1215), ~1273, ~1514.
- `src/ui/viewport-guard.test.ts`.
- `vite.config.ts`: the mangle comment's "Web / CrazyGames SDK properties" bullet.
- `package.json` `"description"`: drop "for CrazyGames".
- `docs/blackjack-roguelike-rules.md`, `docs/dev-params.md`, `docs/scoreboards.md`, `README.md`
  (add the play URL).
- `CLAUDE.md`: replace the **CrazyGames Platform** section with a short **GitHub Pages** section:
  static bundle, `base: './'`, deployed by `.github/workflows/deploy.yml` on push to `main`,
  `localStorage` persistence, no external network requests, responsive/touch rules unchanged. The
  "Build & assets" and "Responsive canvas" bullets still apply. The "SDK" bullets go.

---

## Behaviour changes to be aware of

**Persistence is now device-local and less durable.**
- `SDK.data` synced to the player's CrazyGames account. `localStorage` is per browser, per device.
- **The origin is `https://stricoff92.github.io`, shared by every project page you host there.** Keep
  every key under the `rba.` prefix (already true: `rba.run`, `rba.personalBest`, `rba.musicMuted`,
  `rba.batterySaver`) so another project can't collide with it.
- **Safari ITP evicts script-written storage for sites that go unvisited for 7 days.** An iPhone
  player who stops for a week loses their in-progress run and personal best. Calling
  `navigator.storage.persist()` at boot helps on Chrome/Firefox, but not against Safari's ITP.
  Accept it, or note it on the title screen.
- Saves are synchronous writes now (no SDK debounce). The session is a few KB and is written once
  per action, which is well within budget, but watch for jank on low-end Android during rapid
  Hit taps.
- CrazyGames players' saves can't be migrated. They lived on another origin and in a dead backend.

**No iframe around the game anymore.**
- Safe-area top inset: `game-view.css` deliberately ignores `env(safe-area-inset-top)` because "the
  CrazyGames app already frames the game clear of the notch". Mobile Safari in portrait still
  zeroes it, but **if you add a web-app manifest or `apple-mobile-web-app-capable` (Add to Home
  Screen, standalone)**, the top inset becomes real and the top HUD row will sit under the notch.
  Re-test that on an iPhone before adding a manifest.
- Viewport guard (`FLAGS.viewportGuard`): still useful, since desktop windows can be any size.
- Audio unlock on the first gesture (`main.ts` `startMusic`, `audio/context.ts`) is unchanged and
  still required.
- Consider a fullscreen button (`document.documentElement.requestFullscreen()`). It's optional, but
  without the platform's own fullscreen control, desktop players otherwise get browser chrome.

**Keep the terser property-mangle.** The obfuscation build (`vite.config.ts` `minify: 'terser'` +
`_$` regex) is still worth keeping for save-tamper resistance. If the repo goes public, the source
is readable anyway, so this only deters casual save editing. Same for `obfuscate.ts` / `keymap.ts`.

---

## Verification checklist

Automated:
- [ ] `npm run typecheck` and `npm test` pass (after removing the CrazyGames and sitelock tests).
- [ ] `./build.sh` passes, including the slimmed verify step.
- [ ] `grep -c crazygames dest/assets/*.js` returns 0.

Local subpath preview (mimics the Pages URL):
```bash
mkdir -p /tmp/pages && rm -rf /tmp/pages/robot-blackjack-attack
cp -r dest /tmp/pages/robot-blackjack-attack
python3 -m http.server 5199 -d /tmp/pages   # open http://localhost:5199/robot-blackjack-attack/
```
- [ ] Boot splash hands off to tap-to-start. No 12 s failsafe hang, no blank screen.
- [ ] DevTools Network: no requests outside the origin.
- [ ] Play a few hands, reload mid-hand → **Continue** resumes the exact hand.
- [ ] Finish a run → personal best shows on the score screen and as "score to beat" after reload.
- [ ] Dealer 3 → 4 transition: walk-in plays immediately (no ad pause).
- [ ] Score screen: no empty banner slot. **New run** restarts immediately.
- [ ] Between hands: no "+100" offer, and the Next-hand row layout is unchanged.
- [ ] Mute toggle(s) and battery saver persist across reloads.
- [ ] Private/incognito window: game runs, and saves just don't persist (memory fallback, no crash).

On device, after the first deploy:
- [ ] iPhone Safari portrait + landscape: HUD clear of the notch and home indicator, audio starts
      on the first tap, and a resume works after backgrounding the tab.
- [ ] Android Chrome: same.
- [ ] Desktop: resize the window across the viewport-guard threshold.

## Memory / notes to retire afterwards

These auto-memory entries describe CrazyGames-only systems and should be deleted or rewritten once
Phase 2 lands: `crazygames-rejection`, `crazygames-deployment`, `crazygames-leaderboard`,
`crazygames-lifecycle`, `crazygames-ads`, `rewarded-ad-band`, `sitelock`, and the `SDK.data` wording
in `run-persistence`.
