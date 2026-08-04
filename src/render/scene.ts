// The canvas scene: the physical table the game is played on.
//
// Layout: the dealer stands across the top, a curved wood rail marks the far
// edge of the table, and the green felt floods the rest of the screen —
// full width, all the way to the bottom — to leave maximum room for chips.
//
// Everything here is placeholder gray-box art. Draw order matters — the dealer
// is painted before the rail so the rail overlaps its lower body and it reads
// as standing *behind* the table.

import { createFeltTexture, type FeltCanvas } from './felt'

export interface Layout {
  width: number
  height: number
  edgeY: number // felt top edge at the left/right screen edges
  apexY: number // felt top edge at the center (highest point of the arch)
  controlY: number // quadratic control point for the top-edge curve
  rail: number // wood rail thickness
}

// Small overlap so the rail seals over the felt's top edge with no seam.
const RAIL_OVERLAP = 2

export class Scene {
  private felt: FeltCanvas | null = null
  private feltKey = ''

  // Back layer: the room and the dealer standing behind the table.
  drawBackground(ctx: CanvasRenderingContext2D, layout: Layout): void {
    drawRoom(ctx, layout.width, layout.height)
    drawDealer(ctx, layout)
  }

  // Table layer: felt + rail. Drawn on a transparent canvas so the back layer
  // shows through above the rail.
  drawTable(ctx: CanvasRenderingContext2D, layout: Layout): void {
    const dpr = window.devicePixelRatio || 1
    this.drawFelt(ctx, layout, dpr)
    drawRail(ctx, layout)
  }

  private drawFelt(ctx: CanvasRenderingContext2D, layout: Layout, dpr: number): void {
    // The felt fills the screen from the arch's highest point down to the
    // bottom, full width; the clip trims it to the curved top edge.
    const top = layout.apexY
    const width = layout.width
    const height = layout.height - top

    const key = `${Math.round(width)}x${Math.round(height)}@${dpr}`
    if (!this.felt || this.feltKey !== key) {
      this.felt = createFeltTexture(width, height, dpr)
      this.feltKey = key
    }

    ctx.save()
    traceFeltRegion(ctx, layout)
    ctx.clip()
    ctx.drawImage(this.felt, 0, top, width, height)
    ctx.restore()
  }
}

export function computeLayout(w: number, h: number): Layout {
  const edgeY = h * 0.235
  const apexY = h * 0.165
  return {
    width: w,
    height: h,
    edgeY,
    apexY,
    // Control point placed so the curve's midpoint lands exactly on apexY.
    controlY: 2 * apexY - edgeY,
    rail: clamp(Math.min(w, h) * 0.03, 12, 40),
  }
}

// The felt's curved top edge (y) at a given x. The rail sits in the band just
// above this. Anything meant to stay off the table (the health bar) must keep
// below this minus the rail thickness.
export function feltTopEdgeY(l: Layout, x: number): number {
  const t = clamp(x / l.width, 0, 1)
  const mt = 1 - t
  // Quadratic Bézier y with control point at (width/2, controlY); its x maps
  // linearly (control x = width/2), so the parameter t is simply x / width.
  return l.edgeY * (mt * mt + t * t) + l.controlY * 2 * mt * t
}

function drawRoom(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const room = ctx.createLinearGradient(0, 0, 0, h)
  room.addColorStop(0, '#181824')
  room.addColorStop(1, '#0a0a10')
  ctx.fillStyle = room
  ctx.fillRect(0, 0, w, h)

  // Cool spotlight falling on the dealer.
  const spot = ctx.createRadialGradient(w / 2, h * 0.08, 10, w / 2, h * 0.08, Math.max(w, h) * 0.5)
  spot.addColorStop(0, 'rgba(130, 150, 190, 0.18)')
  spot.addColorStop(1, 'rgba(130, 150, 190, 0)')
  ctx.fillStyle = spot
  ctx.fillRect(0, 0, w, h)
}

// The closed felt region: curved top edge, then straight down to the bottom
// corners (the felt bleeds off the left, right, and bottom screen edges).
function traceFeltRegion(ctx: CanvasRenderingContext2D, l: Layout): void {
  ctx.beginPath()
  ctx.moveTo(0, l.edgeY)
  ctx.quadraticCurveTo(l.width / 2, l.controlY, l.width, l.edgeY)
  ctx.lineTo(l.width, l.height)
  ctx.lineTo(0, l.height)
  ctx.closePath()
}

// Wood rail band hugging the felt's curved top edge.
function drawRail(ctx: CanvasRenderingContext2D, l: Layout): void {
  const t = l.rail
  const bottomY = l.edgeY + RAIL_OVERLAP
  const bottomCtrl = l.controlY + RAIL_OVERLAP
  const topY = l.edgeY - t
  const topCtrl = l.controlY - t

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(0, bottomY)
  ctx.quadraticCurveTo(l.width / 2, bottomCtrl, l.width, bottomY)
  ctx.lineTo(l.width, topY)
  ctx.quadraticCurveTo(l.width / 2, topCtrl, 0, topY)
  ctx.closePath()

  const wood = ctx.createLinearGradient(0, l.apexY - t, 0, l.apexY)
  wood.addColorStop(0, '#5a3921')
  wood.addColorStop(0.5, '#3f2716')
  wood.addColorStop(1, '#2a1a0e')
  ctx.fillStyle = wood
  ctx.fill()
  ctx.restore()

  // Highlight along the top of the rail, shadow where it meets the felt.
  ctx.save()
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, topY)
  ctx.quadraticCurveTo(l.width / 2, topCtrl, l.width, topY)
  ctx.strokeStyle = 'rgba(255, 200, 150, 0.18)'
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(0, l.edgeY)
  ctx.quadraticCurveTo(l.width / 2, l.controlY, l.width, l.edgeY)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.stroke()
  ctx.restore()
}

// The dealer's on-screen footprint, shared by the dealer art and anything that
// needs to stand beside it (the health bar). Kept in one place so the two never
// drift apart on resize.
export interface DealerBox {
  cx: number // horizontal centre
  headCenterY: number
  headR: number
  bodyTop: number
  bodyLeft: number
  bodyRight: number
  baseY: number // where the body tucks behind the rail
}

export function dealerBox(l: Layout): DealerBox {
  const cx = l.width / 2
  const scale = Math.min(l.width, l.height)

  // Pin the head near the top margin (never touching the edge) and keep it
  // small enough that the neck + shoulders show above the rail, so the dealer
  // reads as standing behind the table rather than peeking over it.
  const topMargin = clamp(l.height * 0.03, 10, 34)
  const zone = Math.max(1, l.apexY - topMargin)
  const headR = clamp(Math.min(scale * 0.065, zone * 0.36), 16, 96)
  const headCenterY = topMargin + headR

  const baseY = l.apexY + l.rail // tuck the body base behind the rail
  const bodyW = headR * 3.6

  return {
    cx,
    headCenterY,
    headR,
    bodyTop: headCenterY + headR * 0.7,
    bodyLeft: cx - bodyW / 2,
    bodyRight: cx + bodyW / 2,
    baseY,
  }
}

// The dealer's two eyes, in canvas space. Anything that emanates from the
// dealer's gaze (the Analyze light projection) reads these, so the placeholder
// robot and the final art can share one source of truth — swap drawDealer's art
// and keep the eyes here in step and everything downstream still lines up.
export interface DealerEyes {
  left: { x: number; y: number }
  right: { x: number; y: number }
  radius: number
}

export function dealerEyes(l: Layout): DealerEyes {
  const d = dealerBox(l)
  const y = d.headCenterY - d.headR * 0.1
  return {
    left: { x: d.cx - d.headR * 0.42, y },
    right: { x: d.cx + d.headR * 0.42, y },
    radius: d.headR * 0.16,
  }
}

// Placeholder robot dealer: boxy head + torso with glowing eyes, standing
// behind the rail (its lower body is covered by the rail and felt).
function drawDealer(ctx: CanvasRenderingContext2D, l: Layout): void {
  const d = dealerBox(l)
  const eyes = dealerEyes(l)

  ctx.save()

  ctx.fillStyle = '#343a49'
  ctx.beginPath()
  ctx.roundRect(d.bodyLeft, d.bodyTop, d.bodyRight - d.bodyLeft, d.baseY - d.bodyTop, d.headR * 0.6)
  ctx.fill()

  ctx.fillStyle = '#454c5f'
  ctx.beginPath()
  ctx.roundRect(d.cx - d.headR, d.headCenterY - d.headR, d.headR * 2, d.headR * 2, d.headR * 0.35)
  ctx.fill()

  ctx.fillStyle = '#8fd4ff'
  ctx.beginPath()
  ctx.arc(eyes.left.x, eyes.left.y, eyes.radius, 0, Math.PI * 2)
  ctx.arc(eyes.right.x, eyes.right.y, eyes.radius, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
