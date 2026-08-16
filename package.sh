#!/usr/bin/env bash
#
# Package the CURRENT contents of dest/ into an upload-ready CrazyGames zip.
#
#   Usage: ./package.sh          (run from anywhere; it cd's to the repo root itself)
#
# This does NOT build — it zips whatever `vite build` last produced. Because a zip is uploaded and
# reviewed by humans, a bad one costs days, so every check below runs BEFORE the archive is made
# and any failure aborts without writing a file. The checks answer three questions:
#
#   Is it a PROD build?   minified, no sourcemaps, no `import.meta.env`, sitelock compiled in,
#                         leaderboard encryption key baked in.
#   Is it CURRENT?        no source file is newer than the bundle (a stale dest/ is invisible).
#   Is it CLEAN?          every file came from one build, and every asset is actually referenced —
#                         so nothing from an older build is riding along.
#
# Escape hatches (both print a loud warning): ALLOW_NO_KEY=1 packages a keyless bundle,
# ALLOW_DIRTY=1 skips the "sources newer than build" abort.
set -euo pipefail

cd "$(dirname "$0")"

fail() { echo "  FAIL  $*" >&2; exit 1; }
ok()   { echo "  ok    $*"; }
warn() { echo "  WARN  $*"; }

echo "==> Verifying dest/"

[[ -d dest ]] || fail "no dest/ directory — run ./build.sh first"
# CrazyGames requires the entry HTML at the ROOT of the archive, which is why the zip step below
# archives the CONTENTS of dest/ (note the `cd dest`) rather than the directory itself.
[[ -f dest/index.html ]] || fail "dest/index.html missing"

# Resolve the entry bundle from index.html's own <script src> rather than globbing assets/*.js, so
# this follows Vite's content hash automatically and can never check a leftover bundle by accident.
entry_ref="$(grep -oE '\./assets/[A-Za-z0-9._-]+\.js' dest/index.html | head -1)"
[[ -n $entry_ref ]] || fail "no module script found in dest/index.html"
entry_js="dest/${entry_ref#./}"
[[ -f $entry_js ]] || fail "index.html references ${entry_ref}, which does not exist in dest/"
ok "entry bundle: ${entry_js#dest/}"

# --- Is it CURRENT? Any source newer than the bundle means dest/ predates an edit. ---
stale="$(find src index.html vite.config.ts package.json -type f -newer "$entry_js" -print -quit)"
if [[ -n $stale ]]; then
  if [[ ${ALLOW_DIRTY:-} == 1 ]]; then
    warn "sources are newer than dest/ (e.g. ${stale}) — packaging anyway (ALLOW_DIRTY=1)"
  else
    fail "${stale} is newer than the build — re-run ./build.sh (or ALLOW_DIRTY=1 to override)"
  fi
else
  ok "no source file is newer than the build"
fi

# --- Is it CLEAN? One build writes all of dest/ within the same moment (build.sh's vite step uses
# emptyOutDir, so a wide mtime spread means files were added to dest/ outside a build). ---
mapfile -t mtimes < <(find dest -type f -printf '%T@\n' | cut -d. -f1 | sort -n)
spread=$(( mtimes[-1] - mtimes[0] ))
(( spread <= 120 )) || fail "dest/ file mtimes span ${spread}s — looks like more than one build's output; rebuild"
ok "all $(find dest -type f | wc -l) files written by a single build (${spread}s spread)"

# Files that must never ship: sourcemaps (readable source), env files (the key in plaintext, and
# anything else in them), stray TypeScript, OS junk.
strays="$(find dest \( -name '*.map' -o -name '.env*' -o -name '*.ts' -o -name '.DS_Store' -o -name 'Thumbs.db' \) -print)"
[[ -z $strays ]] || fail "files that must not ship are in dest/:"$'\n'"$strays"
ok "no sourcemaps, .env files, or OS junk"

# Every hashed asset must be referenced by index.html, the entry bundle, or the CSS. An orphan is a
# leftover from an older build (or dead weight in the upload).
orphans=""
while IFS= read -r asset; do
  grep -qF "$asset" dest/index.html "$entry_js" dest/assets/*.css || orphans+="    ${asset}"$'\n'
done < <(find dest/assets -type f -printf '%f\n')
[[ -z $orphans ]] || fail "assets in dest/ that nothing references:"$'\n'"$orphans"
ok "every asset in dest/assets is referenced"

echo "==> Verifying it is a production build"

# `vite dev` never minifies, so a multi-line entry bundle means this is not a release build. (A
# minified bundle is one long line with no trailing newline, so `wc -l` reports 0 — hence `<= 5`
# rather than an exact count.)
lines="$(wc -l < "$entry_js")"
(( lines <= 5 )) || fail "entry bundle is ${lines} lines — not minified, this is not a production build"
ok "bundle is minified ($(du -h "$entry_js" | cut -f1), $(wc -c < "$entry_js") bytes on one line)"

# Dev-only code is stripped by the `import.meta.env.DEV` constant folding at build time. If any of
# these survive, the bundle was produced in dev mode or with the wrong mode flag.
for token in 'import.meta.env' 'vite/client' '__vite' 'SCORE: win' '[crazygames]'; do
  grep -qF "$token" "$entry_js" && fail "dev-only marker present in the bundle: ${token}"
done
ok "no dev-only markers (import.meta.env, vite client, dev score/SDK logs)"

# The sitelock's masked host label (src/platform/sitelock.ts MASKED). Present = the real host check
# survived into the bundle; absent = built with VITE_UNLOCK, which would let anyone re-host the game.
grep -qF '88,73,90,65,66,92,90,86,94,72' "$entry_js" \
  || fail "sitelock host mask not found — built with VITE_UNLOCK, or MASKED changed in src/platform/sitelock.ts"
ok "sitelock compiled in (no VITE_UNLOCK hatch)"

# The leaderboard encryption key (32 bytes, base64 => 44 chars ending in '='). CrazyGames validates
# submissions against the key configured in the Developer Portal, so every build must carry the SAME
# one — and a missing key fails SILENTLY at runtime (submits are skipped with no console output in
# prod), which is exactly the kind of thing that only surfaces after launch.
mapfile -t found_keys < <(grep -oE '[A-Za-z0-9+/]{43}=' "$entry_js" | sort -u)
if [[ -n ${VITE_CG_ENCRYPTION_KEY:-} ]]; then
  grep -qF "$VITE_CG_ENCRYPTION_KEY" "$entry_js" \
    || fail "VITE_CG_ENCRYPTION_KEY is set but that key is NOT in the bundle — rebuild with it"
  ok "bundle carries the key from \$VITE_CG_ENCRYPTION_KEY"
elif (( ${#found_keys[@]} == 1 )); then
  # No key exported to compare against, so print it for an eyeball check against your saved copy.
  key="${found_keys[0]}"
  ok "bundle carries a leaderboard key: ${key:0:8}…${key: -6}  (must match the Developer Portal)"
elif (( ${#found_keys[@]} == 0 )); then
  if [[ ${ALLOW_NO_KEY:-} == 1 ]]; then
    warn "NO leaderboard encryption key in this bundle — score submits will silently no-op (ALLOW_NO_KEY=1)"
  else
    fail "no leaderboard encryption key in the bundle — rebuild with VITE_CG_ENCRYPTION_KEY=… ./build.sh (or ALLOW_NO_KEY=1)"
  fi
else
  fail "found ${#found_keys[@]} base64 key-shaped strings in the bundle; expected exactly one"
fi

echo "==> Packaging"

# Stamp the name with date-time + short git SHA so every upload is a distinct, traceable artifact.
stamp="$(date +%Y%m%d-%H%M%S)"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  warn "working tree is dirty — ${sha} does not fully describe what is in this zip"
fi

# Archives land in a gitignored directory (override with BUILD_OUT_DIR=…) rather than the repo
# root, so uploads accumulate in one place and never clutter `git status`. Keep any new value in
# step with .gitignore — an artifact directory that isn't ignored will offer 8MB zips for commit.
out_dir="${BUILD_OUT_DIR:-builds}"
mkdir -p "$out_dir"
zip_path="${out_dir}/rba-${stamp}-${sha}.zip"
rm -f "$zip_path"
# `cd dest` puts index.html at the archive root; the output path is relative to that, hence `../`.
( cd dest && zip -qr "../${zip_path}" . )

# Confirm the archive really has index.html at its root (a nested folder is the single most common
# reason CrazyGames rejects an upload) and that nothing was dropped.
if command -v zipinfo >/dev/null 2>&1; then
  zipinfo -1 "$zip_path" | grep -qx 'index.html' || fail "index.html is not at the root of ${zip_path}"
  zipped="$(zipinfo -1 "$zip_path" | grep -cv '/$')"
  on_disk="$(find dest -type f | wc -l)"
  (( zipped == on_disk )) || fail "zip holds ${zipped} files but dest/ has ${on_disk}"
  ok "index.html at archive root, ${zipped} files"
fi

echo "==> Done: ${zip_path} ($(du -h "$zip_path" | cut -f1)) — upload this to CrazyGames"
