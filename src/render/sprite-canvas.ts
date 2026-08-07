// Backing canvas for the game's off-screen sprite caches (card faces, holo-text glow,
// flying tokens, the health heart).
//
// Deliberately an in-memory HTMLCanvasElement, NOT an OffscreenCanvas. Every one of
// these sprites exists to be a drawImage SOURCE blitted onto the visible layers each
// frame, and Firefox is markedly slower blitting from an OffscreenCanvas than from a
// plain <canvas> (Chrome is equally fast either way). We're always on the main thread
// with a document here, so a detached <canvas> is both the faster cross-browser source
// and simpler than the OffscreenCanvas-with-fallback dance.

export interface SpriteCanvas {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

// Create a `w`×`h` DEVICE-pixel backing canvas. Callers scale the context by dpr and
// then draw in CSS px, exactly as the visible layers do, so the blit stays crisp.
export function createSpriteCanvas(w: number, h: number): SpriteCanvas {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2d sprite context unavailable')
  }
  return { canvas, ctx }
}
