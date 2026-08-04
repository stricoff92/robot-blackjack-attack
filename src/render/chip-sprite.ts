// The poker-chip face image — downloaded once on page load and reused for every
// chip painted on the felt.
//
// Vite fingerprints the imported asset and rewrites the URL to respect the
// (relative) deploy base, so the browser fetches it a single time and serves
// every draw from cache. We additionally hold one shared HTMLImageElement, so
// there is never more than one in-flight request and no per-frame allocation.
//
// Callers fall back to vector art until the image is ready (see chips.ts), and
// can register `onChipImageReady` to force a repaint the moment it arrives — so
// the chip appears even when nothing is animating.

import chipUrl from '../assets/poker-chip.png'

const img = new Image()
let ready = false
const waiters: Array<() => void> = []

img.decoding = 'async'
img.onload = () => {
  ready = true
  for (const cb of waiters.splice(0)) {
    cb()
  }
}
img.src = chipUrl // kicks off the single download at module evaluation (page load)

// The shared chip image, or null until it has finished loading.
export function chipImage(): HTMLImageElement | null {
  return ready ? img : null
}

// Run `cb` once the chip image is available (immediately if already loaded).
export function onChipImageReady(cb: () => void): void {
  if (ready) {
    cb()
  } else {
    waiters.push(cb)
  }
}
