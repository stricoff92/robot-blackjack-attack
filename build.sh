#!/usr/bin/env bash
#
# Release build for GitHub Pages.
#
#   typecheck  ->  tests  ->  production bundle (dest/)  ->  verify
#
# The deploy itself runs in CI (.github/workflows/deploy.yml); this is the same pipeline locally.
#
# Usage: ./build.sh            (run from anywhere; it cd's to the repo root itself)
#
# Fails fast: `set -euo pipefail` means a red typecheck or a failing test aborts the run
# BEFORE any bundle is produced, so a broken build can never be deployed by mistake.
set -euo pipefail

# Always operate from the repo root (this script's own directory), so relative paths and the
# npm scripts resolve regardless of where it was invoked from.
cd "$(dirname "$0")"

# Run a gate quietly: swallow its output on success (printing only the lines matched by $2, if any)
# and dump the whole log to stderr on failure before aborting. Both gates below are pass/fail — a
# green run has nothing to say, and vitest's interactive reporter listing all 47 test files would
# otherwise scroll the packaging checks that actually matter off the screen. Nothing is lost: a
# failure prints byte-for-byte what the bare command would have.
run_gate() {
  local cmd="$1" summary="${2:-}" log status
  log="$(mktemp -t rba-build-XXXXXX.log)"
  if $cmd >"$log" 2>&1; then
    [[ -n $summary ]] && grep -E "$summary" "$log" || true
    rm -f "$log"
  else
    status=$?
    cat "$log" >&2
    rm -f "$log"
    exit $status
  fi
}

echo "==> Typecheck"
run_gate "npm run typecheck"

echo "==> Tests"
# Keep vitest's own tally (files / tests / duration) — the one part of its output worth seeing.
run_gate "npm test" '^ +(Test Files|Tests|Duration) '

echo "==> Production bundle (vite build -> dest/)"
# `npm run typecheck` already ran tsc, so build with vite directly to avoid a second typecheck
# pass. This is the same bundler step `npm run build` performs (terser property-mangling and all).
npx vite build

# verify-dest.sh can also be run on its own to re-check an existing dest/ without rebuilding.
./verify-dest.sh
