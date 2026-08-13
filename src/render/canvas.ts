// Stacked canvas layers sharing one size + device-pixel-ratio.
//
// Splitting the scene across layers lets static content (table, dealer) be
// painted once on resize while only the animated layer (cards/chips) is
// cleared and redrawn each frame — the difference between repainting the whole
// table 60×/sec and just blitting a handful of card sprites.

// High-DPI screens report devicePixelRatio up to 3+; at 3× each full-screen layer
// is a 9×-area backing store, a steep per-frame fill and memory cost for a crispness
// gain few players notice. Cap at 2× — near-identical on screen, ~2.25× cheaper to
// fill per frame on 3× displays, and far less canvas memory across all the layers.
const MAX_DPR = 2

// Battery saver renders at a LOWER dpr cap — the single biggest per-frame lever, since it cuts the
// backing-store pixel count (and thus fill + composite cost) across EVERY layer and every draw. 1.5
// is ~1.8× cheaper than 2× on a retina phone with minimal crispness loss (drop to 1 for ~4× / more
// savings). Set once at startup via setSaverDpr() BEFORE the first render, so the offscreen sprite
// caches (cards, holo-text) bake at this scale — no live rebuild; a mid-session toggle applies next launch.
const SAVER_MAX_DPR = 1.5
let saverDpr = false
export function setSaverDpr(on: boolean): void {
  saverDpr = on
}
function dprCap(): number {
  return saverDpr ? SAVER_MAX_DPR : MAX_DPR
}

// The device-pixel ratio the layers actually render at (capped). Offscreen sprite
// caches (cards, holo-text) build at this scale so their blits stay pixel-crisp
// against the on-screen backing stores without over-rendering on 3×+ screens.
export function deviceDpr(): number {
  return Math.min(window.devicePixelRatio || 1, dprCap())
}

export interface CanvasLayer {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
}

export interface LayeredCanvas {
  readonly layers: Record<string, CanvasLayer>
  readonly width: number // CSS pixels
  readonly height: number
  dispose(): void
}

export function createLayeredCanvas(
  root: HTMLElement,
  names: readonly string[],
  onResize: (canvas: LayeredCanvas) => void,
): LayeredCanvas {
  const layers: Record<string, CanvasLayer> = {}
  for (const name of names) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('2d canvas context unavailable')
    }
    root.appendChild(canvas)
    layers[name] = { canvas, ctx }
  }

  const size = { width: 0, height: 0 }
  const api: LayeredCanvas = {
    layers,
    get width() {
      return size.width
    },
    get height() {
      return size.height
    },
    dispose,
  }

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap())
    const width = root.clientWidth
    const height = root.clientHeight

    for (const name of names) {
      const { canvas, ctx } = layers[name]
      // Setting width/height also clears the layer.
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      // Backing store at device resolution keeps rendering crisp on high-DPI.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    size.width = width
    size.height = height
    onResize(api)
  }

  const observer = new ResizeObserver(resize)
  observer.observe(root)
  resize()

  function dispose(): void {
    observer.disconnect()
    for (const name of names) {
      layers[name].canvas.remove()
    }
  }

  return api
}
