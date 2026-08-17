/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** CrazyGames leaderboard Encryption Key (32-byte base64) from the Developer Portal →
   *  Leaderboard tab. Injected at build time; empty in dev, where submits are skipped. */
  readonly VITE_CG_ENCRYPTION_KEY?: string
  /** Opt-in sitelock bypass for LOCAL preview of the minified bundle only
   *  (`VITE_UNLOCK=1 npm run build && npm run preview`). NEVER set by build.sh — the shipped
   *  release stays locked to CrazyGames hosts. See src/platform/sitelock.ts. */
  readonly VITE_UNLOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
