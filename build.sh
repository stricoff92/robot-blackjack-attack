#!/usr/bin/env bash
#
# Release build for CrazyGames.
#
#   typecheck  ->  tests  ->  production bundle (dest/)  ->  upload-ready zip
#
# Usage: ./build.sh            (run from anywhere; it cd's to the repo root itself)
#
# Fails fast: `set -euo pipefail` means a red typecheck or a failing test aborts the run
# BEFORE any bundle or zip is produced, so a broken build can never be packaged by mistake.
set -euo pipefail

# Always operate from the repo root (this script's own directory), so relative paths and the
# npm scripts resolve regardless of where it was invoked from.
cd "$(dirname "$0")"

echo "==> Typecheck"
npm run typecheck

echo "==> Tests"
npm test

echo "==> Production bundle (vite build -> dest/)"
# `npm run typecheck` already ran tsc, so build with vite directly to avoid a second typecheck
# pass. This is the same bundler step `npm run build` performs (terser property-mangling and all).
npx vite build

# Zip the CONTENTS of dest/ (note the `cd dest`) so index.html sits at the archive ROOT —
# CrazyGames requires the entry HTML at the top level of the uploaded zip, not nested in a folder.
# Stamp the name with date-time + short git SHA so every build is a distinct, traceable artifact.
stamp="$(date +%Y%m%d-%H%M%S)"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
zip_name="rba-${stamp}-${sha}.zip"
rm -f "$zip_name"
( cd dest && zip -qr "../${zip_name}" . )

echo "==> Done: ${zip_name} ($(du -h "$zip_name" | cut -f1)) — upload this to CrazyGames"
