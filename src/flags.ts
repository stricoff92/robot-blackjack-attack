// Feature flags — boolean toggles for features that are built but gated so they can be flipped off
// without ripping the code out. Read once at startup (not reactive): flipping a flag to false makes
// the guarded feature no-op / never mount. Keep this file dependency-free so anything can import it.
export const FLAGS = {
  // Viewport guard: when the screen is too short to show the ability column + help + info buttons,
  // disable play and show a blocking modal — "rotate to portrait" on a phone/tablet that would then
  // have room, otherwise "screen too small". See src/ui/viewport-guard.ts.
  viewportGuard: true,
} as const

export type FeatureFlag = keyof typeof FLAGS
