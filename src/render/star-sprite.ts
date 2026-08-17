// The bright-yellow POINTS star — downloaded once on page load and reused wherever the
// score icon is painted on the CANVAS (the coda's "The banker says:" banner). Mirrors
// chip-sprite.ts: one shared HTMLImageElement so there is never more than one in-flight
// request and no per-frame allocation. (The DOM points counter uses its own <img>.)
//
// The render loop never parks during the coda, so once the image arrives it simply appears
// on the next frame — callers just skip the star until starImage() is non-null.

import starUrl from '../assets/star.png'

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
img.src = starUrl // kicks off the single download at module evaluation (page load)

// The shared star image, or null until it has finished loading.
export function starImage(): HTMLImageElement | null {
  return ready ? img : null
}

// Run `cb` once the star image is available (immediately if already loaded).
export function onStarImageReady(cb: () => void): void {
  if (ready) {
    cb()
  } else {
    waiters.push(cb)
  }
}
