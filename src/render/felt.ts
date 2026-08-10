// Felt texture for the blackjack table, painted directly onto the destination context.
//
// The felt is decorative and static, but it is deliberately NOT kept as a long-lived
// offscreen buffer. A full-screen offscreen canvas that we only blit a few times per hand
// is a prime candidate for the browser to purge under memory pressure: its pixel backing
// store gets reclaimed while the JS handle lives on (this is NOT JS garbage collection —
// the object is strongly referenced; the graphics layer just drops the buffer). That left
// the table a dark void, most visibly right after a dealer kill's allocation spike.
//
// Instead we repaint the felt from a FIXED seed each time the static table layer is
// repainted — a handful of times per hand, never per frame. The seed keeps every repaint
// pixel-identical, so the mottle/grain never shimmers between repaints (and, unlike the
// old Math.random build, it no longer reshuffles on every resize step).
//
// The texture is built in layers to read as fabric: base green gradient → low-frequency
// mottling → fine fibre grain → embossed suit pattern → vignette.

import { createRng, type Rng } from '../game/random'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const SUITS = ['♠', '♥', '♦', '♣']

// Any constant seed: the felt looks the same every run, which is what we want for a static
// background. Changing it just reshuffles the mottle/grain positions.
const FELT_SEED = 0x5eedfe17

// Paint the felt filling the box (0,0)–(width,height) in the context's CURRENT user space.
// The caller sets up the clip (the table's curved top edge) and any translate first, and the
// context is already device-pixel scaled, so we draw in CSS pixels and stay crisp on high-DPI.
export function paintFelt(ctx: Ctx2D, width: number, height: number): void {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const rng = createRng(FELT_SEED)

  // Rich casino green, brighter toward the middle like a table under a light.
  const base = ctx.createRadialGradient(
    w / 2,
    h * 0.4,
    Math.min(w, h) * 0.08,
    w / 2,
    h * 0.5,
    Math.max(w, h) * 0.72,
  )
  base.addColorStop(0, '#2f7d51')
  base.addColorStop(1, '#123f28')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)

  drawMottle(ctx, w, h, rng)
  drawGrain(ctx, w, h, rng)
  drawSuitPattern(ctx, w, h)
  drawVignette(ctx, w, h)
}

// Soft, low-frequency blotches so the felt isn't a flat wash of colour.
function drawMottle(ctx: Ctx2D, w: number, h: number, rng: Rng): void {
  ctx.save()
  const count = 20
  for (let i = 0; i < count; i++) {
    const x = rng() * w
    const y = rng() * h
    const r = Math.min(w, h) * (0.1 + rng() * 0.22)
    const light = rng() < 0.5
    const blob = ctx.createRadialGradient(x, y, 0, x, y, r)
    blob.addColorStop(0, light ? 'rgba(102, 194, 134, 0.12)' : 'rgba(0, 26, 13, 0.15)')
    blob.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = blob
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  ctx.restore()
}

// Fine woven-fibre grain via a tiled noise buffer blended over the felt.
function drawGrain(ctx: Ctx2D, w: number, h: number, rng: Rng): void {
  const tile = createNoiseTile(128, rng)
  const pattern = ctx.createPattern(tile, 'repeat')
  if (!pattern) {
    return
  }
  ctx.save()
  ctx.globalCompositeOperation = 'overlay'
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

// Faint diamond-lattice of card suits, embossed into the felt.
function drawSuitPattern(ctx: Ctx2D, w: number, h: number): void {
  const step = Math.max(46, Math.min(w, h) / 8)
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${step * 0.44}px serif`

  let row = 0
  for (let y = step * 0.5; y < h + step; y += step) {
    const offset = row % 2 === 0 ? 0 : step / 2
    let col = 0
    for (let x = step * 0.5 + offset; x < w + step; x += step) {
      const suit = SUITS[(row + col) % SUITS.length]
      // Shadow offset down-right, highlight on top — a stamped-in look.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.16)'
      ctx.fillText(suit, x + 2, y + 2)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'
      ctx.fillText(suit, x, y)
      col++
    }
    row++
  }
  ctx.restore()
}

// Darken the edges to give the felt some depth.
function drawVignette(ctx: Ctx2D, w: number, h: number): void {
  const vignette = ctx.createRadialGradient(
    w / 2,
    h * 0.45,
    Math.min(w, h) * 0.3,
    w / 2,
    h * 0.5,
    Math.max(w, h) * 0.75,
  )
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)
}

// A small, ephemeral noise tile for the grain pattern. Tiny (128²) and short-lived — it is
// discarded the moment createPattern has sampled it, so it never becomes a purge target.
function createNoiseTile(size: number, rng: Rng): Ctx2D['canvas'] {
  const { canvas, ctx } = createOffscreen(size, size)
  const image = ctx.createImageData(size, size)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    const value = rng() * 255
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 40
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

function createOffscreen(w: number, h: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: Ctx2D
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('offscreen 2d context unavailable')
    }
    return { canvas, ctx }
  }

  // Fallback for browsers without OffscreenCanvas: a detached <canvas>.
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2d context unavailable')
  }
  return { canvas, ctx }
}
