// The dealer's health bar: a vertical, fighting-game-style gauge (Street Fighter
// / Mortal Kombat energy) standing to the right of the dealer. The fill sinks as
// the dealer takes damage; the slice that was just removed flashes white-hot and
// fades away. A white heart sits centered near the bar's bottom.
//
// Mirrors cards.ts / chips.ts: this module owns geometry + paint, while
// ui/health-animator.ts owns the timing (the HealthView passed in here).

import { dealerBox, feltTopEdgeY, type Layout } from './scene'

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
  const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r)
  body.addColorStop(0, css(shade(FILL, 0.5)))
  body.addColorStop(0.55, css(FILL))
  body.addColorStop(1, css(shade(FILL, -0.42)))

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
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
  const metal = ctx.createLinearGradient(x, 0, x + w, 0)
  metal.addColorStop(0, '#3c3c48')
  metal.addColorStop(0.5, '#131319')
  metal.addColorStop(1, '#3c3c48')
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

  const shadow = ctx.createLinearGradient(0, box.y, 0, box.y + box.h)
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
  shadow.addColorStop(0.18, 'rgba(0, 0, 0, 0)')
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

  const sheen = ctx.createLinearGradient(box.x, 0, box.x + box.w, 0)
  sheen.addColorStop(0, css(shade(col, -0.28)))
  sheen.addColorStop(0.5, css(shade(col, 0.14)))
  sheen.addColorStop(1, css(shade(col, -0.38)))
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

// White heart centered inside the bar near its bottom, painted over the fill with
// a soft shadow so its edges stay legible on both the red fill and the dark
// trough. Built by sampling the classic parametric heart curve and fitting it to
// a target box that's taller than it is wide — a clean upright silhouette (round
// lobes, sharp point), not the squat bezier version.
function drawHeart(ctx: CanvasRenderingContext2D, box: Box): void {
  const s = box.w * HEART_SCALE
  const targetW = s * 0.9 // narrower than tall — tune these two for the shape
  const targetH = s * 1.02
  const cx = box.x + box.w / 2
  const cy = box.y + box.h - targetH / 2 - box.w * 0.18

  // Sample x = 16sin³t, y = 13cos t − 5cos2t − 2cos3t − cos4t (canvas y flipped),
  // tracking the bounds so the raw curve can be rescaled into targetW × targetH.
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
  const sx = targetW / (maxX - minX)
  const sy = targetH / (maxY - minY)
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = s * 0.16
  ctx.shadowOffsetY = s * 0.03
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  for (let i = 0; i < raw.length; i++) {
    const px = cx + (raw[i].x - midX) * sx
    const py = cy + (raw[i].y - midY) * sy
    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
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
