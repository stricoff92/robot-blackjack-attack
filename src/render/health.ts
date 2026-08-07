// The dealer's health bar: a vertical, fighting-game-style gauge (Street Fighter
// / Mortal Kombat energy) standing to the right of the dealer. The fill sinks as
// the dealer takes damage; the slice that was just removed flashes white-hot and
// fades away. A white heart sits centered near the bar's bottom.
//
// Mirrors cards.ts / chips.ts: this module owns geometry + paint, while
// ui/health-animator.ts owns the timing (the HealthView passed in here).

import { deviceDpr } from './canvas'
import { cachedGradient } from './gradient-cache'
import { dealerBox, feltTopEdgeY, type Layout } from './scene'
import { createSpriteCanvas } from './sprite-canvas'

// The removed slice fading out after a hit, expressed as fractions of the bar
// (0 = empty/bottom, 1 = full/top). `fade` runs 1 (just removed, hot) → 0 (gone).
export interface Ghost {
  lo: number // the new health level — bottom of the removed slice
  hi: number // the old health level — top of the removed slice
  fade: number
}

export interface HealthView {
  isAnimating(now: number): boolean
  level(now: number): number // solid fill fraction, 0..1
  ghost(now: number): Ghost | null
  // The slice a heal beam is repairing, glowing green-gold over the red fill (null
  // when no heal is playing). Reuses the Ghost shape: lo/hi bound the slice, fade
  // runs 1 (bright) → 0 (gone).
  healGlow(now: number): Ghost | null
}

interface RGB {
  r: number
  g: number
  b: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const PAD = 3 // metal frame thickness around the trough
const RADIUS = 5 // frame corner rounding
const HEART_SCALE = 0.8 // heart size relative to bar width

// Dealer-remaining pips: a vertical column of small red circles standing just to
// the right of the bar, one per dealer still to defeat (see drawDealerPips). The
// gap and radius are fractions of the bar width (so the column scales with the
// gauge); the spacing is a multiple of the radius, keeping the pips tightly stacked.
const PIP_GAP = 0.22 // horizontal offset of the column from the frame's right edge
const PIP_RADIUS = 0.13 // pip radius
const PIP_SPACING = 2.6 // pip centre-to-centre, as a multiple of the radius

// Vivid red — the dealer is the enemy, so its gauge reads as a threat rather
// than the player's own vitality.
const FILL: RGB = { r: 0xe2, g: 0x34, b: 0x2c }

// Bar footprint (the inner trough/fill area), derived from the dealer so the
// gauge always stands at its right side, up in the room above the table. Its
// bottom is pinned above the rail so the gauge never spills onto the felt.
export function healthBarBox(layout: Layout): Box {
  const d = dealerBox(layout)
  const w = clamp(d.headR * 0.5, 12, 26)
  const gap = d.headR * 0.55
  const top = d.headCenterY - d.headR

  let x = d.bodyRight + gap
  // Keep the bar's frame AND the dealer-remaining pip column on-screen on narrow
  // layouts (the pips stand just to the right of the frame).
  const maxX = layout.width - w - PAD * 2 - pipReserve(w)
  if (x > maxX) {
    x = maxX
  }

  // Stop the frame (and its bottom-anchored cross) well clear of the rail's top
  // edge, so the gauge sits up in the room with a comfortable gap to the table.
  const railTop = feltTopEdgeY(layout, x) - layout.rail
  const bottomGap = clamp(d.headR * 0.55, 16, 44)
  const bottom = railTop - bottomGap - PAD
  const h = Math.max(w * 2, bottom - top)
  return { x, y: top, w, h }
}

export function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  view: HealthView,
  now: number,
  dealersLeft: number,
  totalDealers: number,
): void {
  const box = healthBarBox(layout)
  const level = clamp(view.level(now), 0, 1)
  const ghost = view.ghost(now)

  drawFrame(ctx, box)

  // Everything inside the trough is clipped to the rounded interior so fills and
  // the fading slice never spill past the frame's corners.
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(box.x, box.y, box.w, box.h, Math.max(0, RADIUS - 2))
  ctx.clip()

  drawTrough(ctx, box)
  drawFill(ctx, box, level)
  if (ghost) {
    drawGhost(ctx, box, ghost)
  }
  const heal = view.healGlow(now)
  if (heal) {
    drawHealGlow(ctx, box, heal)
  }

  ctx.restore()

  drawHeart(ctx, box)
  drawDealerPips(ctx, box, dealersLeft, totalDealers)
}

// The largest a pip can be (the width cap), and the total room the column needs
// to the right of the frame. The drawn radius never exceeds this, so a pip can
// never spill past the reserved band (see drawDealerPips).
function pipMaxRadius(barW: number): number {
  return barW * PIP_RADIUS
}

function pipReserve(barW: number): number {
  return barW * PIP_GAP + pipMaxRadius(barW) * 2
}

// A vertical column of red pips standing to the right of the bar, one per dealer
// still to defeat — so the final dealer shows a single pip. Pips are sized from
// the bar width and stacked tightly from the top; on a short bar the radius is
// shrunk further so all `totalDealers` pips still fit within the bar's height.
function drawDealerPips(
  ctx: CanvasRenderingContext2D,
  box: Box,
  dealersLeft: number,
  totalDealers: number,
): void {
  const count = clamp(Math.round(dealersLeft), 0, totalDealers)
  if (count <= 0) {
    return
  }
  const slots = Math.max(1, totalDealers)
  // Height needed for `slots` pips is r * (2 + (slots - 1) * PIP_SPACING); cap the
  // radius so that never exceeds the bar, then space and centre from that radius.
  const fit = box.h / (2 + (slots - 1) * PIP_SPACING)
  const r = Math.min(pipMaxRadius(box.w), fit)
  const cx = box.x + box.w + PAD + box.w * PIP_GAP + r
  const step = r * PIP_SPACING
  const firstCy = box.y + r

  for (let i = 0; i < count; i++) {
    drawPip(ctx, cx, firstCy + i * step, r)
  }
}

// A single glossy red token: a radial body lit from the upper-left with a dark
// rim, echoing the bar's threat-red so the pips read as part of the same gauge.
function drawPip(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  // Drawn around a local origin at (cx, cy) so the (identical) pip gradient is cached
  // once and translated to each pip rather than rebuilt per pip per frame.
  ctx.save()
  ctx.translate(cx, cy)
  const body = cachedGradient(ctx, `health-pip:${Math.round(r)}`, (c) => {
    const g = c.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r)
    g.addColorStop(0, css(shade(FILL, 0.5)))
    g.addColorStop(0.55, css(FILL))
    g.addColorStop(1, css(shade(FILL, -0.42)))
    return g
  })
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = body
  ctx.fill()
  ctx.lineWidth = Math.max(1, r * 0.14)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.stroke()
  ctx.restore()
}

// Dark metal frame with a lit top bevel — the housing the bar sits in.
function drawFrame(ctx: CanvasRenderingContext2D, box: Box): void {
  const x = box.x - PAD
  const y = box.y - PAD
  const w = box.w + PAD * 2
  const h = box.h + PAD * 2

  ctx.save()
  // The frame sits at a fixed position, so its cross-bar metal gradient is cached by
  // geometry and reused every frame (rebuilt only on a resize, when the key changes).
  const metal = cachedGradient(ctx, `health-frame:${Math.round(x)}:${Math.round(w)}`, (c) => {
    const g = c.createLinearGradient(x, 0, x + w, 0)
    g.addColorStop(0, '#3c3c48')
    g.addColorStop(0.5, '#131319')
    g.addColorStop(1, '#3c3c48')
    return g
  })
  ctx.fillStyle = metal
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, RADIUS)
  ctx.fill()

  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.stroke()

  // A thin highlight across the top edge sells the bevel.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  ctx.beginPath()
  ctx.moveTo(x + RADIUS, y + 0.5)
  ctx.lineTo(x + w - RADIUS, y + 0.5)
  ctx.stroke()
  ctx.restore()
}

// The empty channel behind the fill, with a soft shadow at the top lip.
function drawTrough(ctx: CanvasRenderingContext2D, box: Box): void {
  ctx.fillStyle = '#101017'
  ctx.fillRect(box.x, box.y, box.w, box.h)

  const shadow = cachedGradient(ctx, `health-trough:${Math.round(box.y)}:${Math.round(box.h)}`, (c) => {
    const g = c.createLinearGradient(0, box.y, 0, box.y + box.h)
    g.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
    g.addColorStop(0.18, 'rgba(0, 0, 0, 0)')
    return g
  })
  ctx.fillStyle = shadow
  ctx.fillRect(box.x, box.y, box.w, box.h)
}

// The live health fill, anchored at the bottom and rising with `level`. A left→
// right sheen gives it a tube-like roundness.
function drawFill(ctx: CanvasRenderingContext2D, box: Box, level: number): void {
  if (level <= 0) {
    return
  }
  const top = box.y + box.h * (1 - level)
  const h = box.h * level
  const col = FILL

  // The left→right sheen depends only on the bar's fixed width, not the fill level, so
  // it's cached by geometry; only the surface highlight below tracks the moving top.
  const sheen = cachedGradient(ctx, `health-sheen:${Math.round(box.x)}:${Math.round(box.w)}`, (c) => {
    const g = c.createLinearGradient(box.x, 0, box.x + box.w, 0)
    g.addColorStop(0, css(shade(col, -0.28)))
    g.addColorStop(0.5, css(shade(col, 0.14)))
    g.addColorStop(1, css(shade(col, -0.38)))
    return g
  })
  ctx.fillStyle = sheen
  ctx.fillRect(box.x, top, box.w, h)

  // A bright band at the very top of the live fill — the "energy surface" of a
  // draining gauge, fading down into the body. This, plus dropping the quarter
  // notches, is what stops the bar reading as a segmented battery cell.
  const surfaceH = clamp(box.w * 0.8, 3, h)
  const surface = ctx.createLinearGradient(0, top, 0, top + surfaceH)
  surface.addColorStop(0, rgba(shade(col, 0.65), 0.9))
  surface.addColorStop(1, rgba(col, 0))
  ctx.fillStyle = surface
  ctx.fillRect(box.x, top, box.w, surfaceH)

  // A crisp hot waterline right at the top edge.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.fillRect(box.x, top, box.w, Math.max(1, box.h * 0.006))
}

// The just-removed slice: a hot flash that cools to the fill colour as it fades.
function drawGhost(ctx: CanvasRenderingContext2D, box: Box, g: Ghost): void {
  const yTop = box.y + box.h * (1 - g.hi)
  const yBot = box.y + box.h * (1 - g.lo)
  const h = yBot - yTop
  if (h <= 0) {
    return
  }
  const hot = mixColor(FILL, { r: 255, g: 255, b: 255 }, g.fade * 0.85)
  ctx.save()
  ctx.globalAlpha = g.fade
  ctx.fillStyle = css(hot)
  ctx.fillRect(box.x, yTop, box.w, h)
  ctx.restore()
}

// The slice a heal beam is repairing: a soft green-gold wash laid over the red fill,
// brightest at its top edge (the rising waterline), drawn additively so it reads as
// restorative light rather than repainting the bar. The counterpart to drawGhost.
const HEAL_GLOW: RGB = { r: 0x30, g: 0xe4, b: 0x50 } // vivid green, matching the beam
function drawHealGlow(ctx: CanvasRenderingContext2D, box: Box, g: Ghost): void {
  const yTop = box.y + box.h * (1 - g.hi)
  const yBot = box.y + box.h * (1 - g.lo)
  const h = yBot - yTop
  if (h <= 0) {
    return
  }
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'

  // A vertical wash over the added slice, strongest at the top and easing down. Kept
  // light and see-through so it reads as a green restorative shimmer, not a repaint.
  const wash = ctx.createLinearGradient(0, yTop, 0, yBot)
  wash.addColorStop(0, rgba(HEAL_GLOW, g.fade * 0.38))
  wash.addColorStop(1, rgba(HEAL_GLOW, g.fade * 0.07))
  ctx.fillStyle = wash
  ctx.fillRect(box.x, yTop, box.w, h)

  // A crisp bright line right at the fill's top — the healing waterline.
  ctx.fillStyle = rgba({ r: 190, g: 255, b: 195 }, g.fade * 0.65)
  ctx.fillRect(box.x, yTop, box.w, Math.max(1, box.h * 0.01))
  ctx.restore()
}

// The parametric heart curve, sampled once and normalized into a unit box centered
// on the origin (nx, ny each in [-0.5, 0.5]). drawHeart just scales these points into
// its target box, so the ~360 trig calls the sampling costs run at module load, not
// every frame. Sample x = 16sin³t, y = 13cos t − 5cos2t − 2cos3t − cos4t (canvas y
// flipped), tracking the bounds so the raw curve can be rescaled cleanly.
function buildHeartPath(): ReadonlyArray<{ nx: number; ny: number }> {
  const N = 72
  const raw: Array<{ x: number; y: number }> = []
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2
    const sin = Math.sin(t)
    const px = 16 * sin * sin * sin
    const py = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    raw.push({ x: px, y: py })
    minX = Math.min(minX, px)
    maxX = Math.max(maxX, px)
    minY = Math.min(minY, py)
    maxY = Math.max(maxY, py)
  }
  const spanX = maxX - minX
  const spanY = maxY - minY
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  return raw.map(({ x, y }) => ({ nx: (x - midX) / spanX, ny: (y - midY) / spanY }))
}

const HEART_POINTS = buildHeartPath()

// White heart centered inside the bar near its bottom, painted over the fill with
// a soft shadow so its edges stay legible on both the red fill and the dark
// trough. The silhouette is the precomputed HEART_POINTS fitted to a target box
// that's taller than it is wide — a clean upright shape (round lobes, sharp point),
// not the squat bezier version.
function drawHeart(ctx: CanvasRenderingContext2D, box: Box): void {
  const s = box.w * HEART_SCALE
  const targetW = s * 0.9 // narrower than tall — tune these two for the shape
  const targetH = s * 1.02
  const cx = box.x + box.w / 2
  const cy = box.y + box.h - targetH / 2 - box.w * 0.18
  // The heart is a fixed white shape drawn every frame; its soft shadow is baked into a
  // sprite once (shadowBlur is Firefox's slowest op) and just blitted here, centred.
  const sprite = getHeartSprite(targetW, targetH, s)
  ctx.drawImage(sprite.canvas, cx - sprite.dw / 2, cy - sprite.dh / 2, sprite.dw, sprite.dh)
}

interface HeartSprite {
  canvas: HTMLCanvasElement
  dw: number // full sprite size incl. shadow padding (CSS px)
  dh: number
}

let heartSpriteCache: (HeartSprite & { key: string }) | null = null

// Build (or reuse) the shadowed white-heart sprite for the current bar size. Keyed by
// its target size + dpr, so it rebuilds only on a resize.
function getHeartSprite(targetW: number, targetH: number, s: number): HeartSprite {
  const dpr = deviceDpr()
  const key = `${Math.round(targetW)}x${Math.round(targetH)}@${dpr}`
  if (!heartSpriteCache || heartSpriteCache.key !== key) {
    const pad = s * 0.25 // room for the blur (s*0.16) + downward offset (s*0.03)
    const dw = targetW + pad * 2
    const dh = targetH + pad * 2
    const { canvas, ctx } = createSpriteCanvas(Math.round(dw * dpr), Math.round(dh * dpr))
    ctx.scale(dpr, dpr)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
    ctx.shadowBlur = s * 0.16
    ctx.shadowOffsetY = s * 0.03
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    for (let i = 0; i < HEART_POINTS.length; i++) {
      const px = dw / 2 + HEART_POINTS[i].nx * targetW
      const py = dh / 2 + HEART_POINTS[i].ny * targetH
      if (i === 0) {
        ctx.moveTo(px, py)
      } else {
        ctx.lineTo(px, py)
      }
    }
    ctx.closePath()
    ctx.fill()
    heartSpriteCache = { canvas, dw, dh, key }
  }
  return heartSpriteCache
}

// Shift a colour toward white (amt > 0) or black (amt < 0) by |amt| in [0, 1].
function shade(c: RGB, amt: number): RGB {
  const target = amt < 0 ? 0 : 255
  const p = Math.abs(amt)
  return {
    r: c.r + (target - c.r) * p,
    g: c.g + (target - c.g) * p,
    b: c.b + (target - c.b) * p,
  }
}

function mixColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

function css(c: RGB): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
}

function rgba(c: RGB, a: number): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
