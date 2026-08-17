import { defineConfig, type Plugin } from 'vitest/config'

// Explicit .ts extension: Vite's forthcoming native config loader does not resolve extensionless
// imports in the config file itself (it warns today, and is planned to become the default).
import { stripIndexHtmlComments } from './scripts/strip-html-comments.ts'

// Strip comments from the SHIPPED index.html. The source file is heavily commented on purpose (why
// the SDK script is deferred, why touch-action is set on every element, why the splash is inline)
// and that stays — this only cleans the build output, which is read by players and reviewers, not
// by us. `apply: 'build'` leaves `vite dev` untouched; `order: 'post'` runs AFTER Vite has rewritten
// the asset URLs (the preload href + the @font-face url() both get hashed paths), so this never
// interferes with that pass.
//
// The transform itself is a context-aware scanner, NOT a regex sweep over the document — see the
// header of scripts/strip-html-comments.ts for why that distinction matters. It self-verifies and
// THROWS (failing the build) rather than ever writing a damaged entry point.
function stripHtmlComments(): Plugin {
  return {
    name: 'strip-html-comments',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: stripIndexHtmlComments,
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [stripHtmlComments()],
  // Expose the dev server on the LAN so a phone on the same Wi-Fi can reach it.
  // Pinned to 5173 (with strictPort) so it stays in step with the firewall rule
  // opened for that port — if 5173 is taken it errors loudly instead of silently
  // moving to a port the firewall would block.
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Vite's Host-header allow-list. `host: true` binds the LAN, but Vite still rejects an
    // arbitrary hostname in the Host header — add the dev machine's LAN name so http://ra:5173
    // works (default only permits localhost / IPs). Add 'ra.local' too if reaching it via mDNS.
    allowedHosts: ['ra'],
  },
  build: {
    outDir: 'dest',
    emptyOutDir: true,
    target: 'es2022',
    // --- Property-name obfuscation ---
    // Rolldown-Vite's default minifier (oxc) already renames every local variable and
    // module-scoped function to single letters (the app is one scope-hoisted bundle), so the only
    // readable surface left is object/class *property* names. oxc can't mangle those and esbuild's
    // `mangleProps` is ignored under Rolldown — so we minify with terser and enable regex property
    // mangling: every property whose name ends in `_` is renamed. This runs at build only; `vite
    // dev` doesn't minify, so real names stay for debugging.
    //
    // It's an OPT-IN convention keyed on the trailing `_`: all `private` class members carry one
    // (scripts/mangle-privates.mjs reapplies it in bulk). NEVER suffix `_` on:
    //   • serialized shapes — RunState / persistence fields are JSON.stringify'd and validated via
    //     dynamic `r[key]` access, so a mangled key would corrupt/reject saves;
    //   • computed-key records — `counts[rank]`, `upgrades[path]`, etc.;
    //   • Web / CrazyGames SDK properties — external, property-accessed; they never match /_$/
    //     anyway (verified: fillStyle, beginPath, gameplayStart, muteAudio … all survive).
    minify: 'terser',
    terserOptions: {
      mangle: { properties: { regex: /_$/ } },
    },
  },
})
