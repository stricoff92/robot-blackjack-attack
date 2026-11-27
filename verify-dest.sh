#!/usr/bin/env bash
#
# Verify the CURRENT contents of dest/ are a clean, current production build before it is deployed.
#
#   Usage: ./verify-dest.sh      (run from anywhere; it cd's to the repo root itself)
#
# This does NOT build — it checks whatever `vite build` last produced, and any failure exits non-zero.
# The checks answer three questions:
#
#   Is it a PROD build?   minified, no sourcemaps, no `import.meta.env`, no dev-only markers.
#   Is it CURRENT?        no source file is newer than the bundle (a stale dest/ is invisible).
#   Is it CLEAN?          every file came from one build, and every asset is actually referenced —
#                         so nothing from an older build is riding along.
#
# Escape hatch (prints a loud warning): ALLOW_DIRTY=1 skips the "sources newer than build" abort.
set -euo pipefail

cd "$(dirname "$0")"

fail() { echo "  FAIL  $*" >&2; exit 1; }
ok()   { echo "  ok    $*"; }
warn() { echo "  WARN  $*"; }

echo "==> Verifying dest/"

[[ -d dest ]] || fail "no dest/ directory — run ./build.sh first"
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
    warn "sources are newer than dest/ (e.g. ${stale}) — verifying anyway (ALLOW_DIRTY=1)"
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

# Files that must never ship: sourcemaps (readable source), env files (secrets in plaintext),
# stray TypeScript, OS junk.
strays="$(find dest \( -name '*.map' -o -name '.env*' -o -name '*.ts' -o -name '.DS_Store' -o -name 'Thumbs.db' \) -print)"
[[ -z $strays ]] || fail "files that must not ship are in dest/:"$'\n'"$strays"
ok "no sourcemaps, .env files, or OS junk"

# Every hashed asset must be referenced by index.html, the entry bundle, or the CSS. An orphan is a
# leftover from an older build (or dead weight in the deploy).
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
# these survive, the bundle was produced in dev mode or with the wrong mode flag — or a new dev
# affordance was written UNGATED (which is how ?audiodebug and ?npb once shipped: they read the URL
# at runtime, so no mode flag was wrong and nothing else here caught them).
for token in 'import.meta.env' 'vite/client' '__vite' 'SCORE: win' '[crazygames]' 'audiodebug' 'audio-debug-overlay' 'DEV PLACEHOLDER'; do
  grep -qF "$token" "$entry_js" && fail "dev-only marker present in the bundle: ${token}"
done
ok "no dev-only markers (import.meta.env, vite client, dev score/SDK logs, debug overlays)"

echo "==> Done: dest/ is ready to deploy"
