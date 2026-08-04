// The token (power) icon image — downloaded once on page load and reused for
// every reward token that flies up to the counter.
//
// Same shape as chip-sprite.ts: Vite fingerprints the imported asset so the
// browser fetches it a single time, and we hold one shared HTMLImageElement so
// there is never a per-frame allocation or a second request. The DOM counter +
// cost pills use the same URL via their own <img> tags, served from cache.
//
// Callers fall back to a vector coin until the image is ready (see tokens.ts),
// and can register `onTokenImageReady` to force a repaint the moment it arrives.

import tokenUrl from '../assets/power.png'

const img = new Image()
let ready = false
// The icon is portrait; hold a sensible w/h until the true ratio is measured so
// early draws aren't stretched.
let aspect = 0.72
const waiters: Array<() => void> = []

img.decoding = 'async'
img.onload = () => {
  ready = true
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    aspect = img.naturalWidth / img.naturalHeight
  }
  for (const cb of waiters.splice(0)) {
    cb()
  }
}
img.src = tokenUrl // kicks off the single download at module evaluation (page load)

// The shared token image, or null until it has finished loading.
export function tokenImage(): HTMLImageElement | null {
  return ready ? img : null
}

// The icon's width / height, so it's drawn without distortion.
export function tokenAspect(): number {
  return aspect
}

// Run `cb` once the token image is available (immediately if already loaded).
export function onTokenImageReady(cb: () => void): void {
  if (ready) {
    cb()
  } else {
    waiters.push(cb)
  }
}
