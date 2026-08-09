/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** CrazyGames leaderboard Encryption Key (32-byte base64) from the Developer Portal →
   *  Leaderboard tab. Injected at build time; empty in dev, where submits are skipped. */
  readonly VITE_CG_ENCRYPTION_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
