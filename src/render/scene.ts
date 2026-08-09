// The canvas scene: the physical table the game is played on.
//
// Layout: the dealer stands across the top, a curved wood rail marks the far
// edge of the table, and the green felt floods the rest of the screen —
// full width, all the way to the bottom — to leave maximum room for chips.
//
// The dealer FIGURE is drawn by render/dealer.ts on its own 'dealer' layer (so it
// can animate), which sits below this table layer's rail — so the rail still
// overlaps the dealer's lower body and it reads as standing *behind* the table.
// This module keeps the shared dealer GEOMETRY (dealerBox / dealerEyes) as the
// single source of truth that the figure and the chip anchors read.

import { deviceDpr } from './canvas'
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

// Dealer-figure sizing, kept here (not just in dealerBox) because computeLayout has
// to reserve room for the whole figure ABOVE the felt before apexY even exists.
// FIGURE_EXTENT is the figure's vertical reach below the top margin in head-radius
// units: headCenterY sits one headR down, and the bowtie's lower tip a further
// 1.72 headR (drawBowtie: cy = headCenterY + 1.5·headR, wingH/2 = 0.22·headR). Keep
// in sync with render/dealer.ts if the bowtie moves.
const FIGURE_EXTENT = 2.72
// The gap between the bowtie's lower tip and the wood rail's top edge, in head-radius units.
// This is the ONE knob setting how high the table sits relative to the dealer, and it's applied
// the same way at every screen size (see computeLayout), so the amount of hidden body is
// constant. Big enough that the rail rests a touch below the bowtie rather than flush against
// it; small enough that it still hides most of the torso.
const BOWTIE_CLEARANCE = 0.45

// Top gap above the head, and the head's natural radius — both a function of screen
// size ALONE (not apexY), so computeLayout and dealerBox agree on the figure's size.
function dealerTopMargin(h: number): number {
  return clamp(h * 0.03, 10, 34)
}
function dealerHeadRadius(w: number, h: number): number {
  return clamp(Math.min(w, h) * 0.065, 16, 96)
}
function railThickness(w: number, h: number): number {
  return clamp(Math.min(w, h) * 0.03, 12, 40)
}

export class Scene {
  private felt: FeltCanvas | null = null
  private feltKey = ''

  // Back layer: just the room. The dealer figure is drawn separately on the
  // 'dealer' layer (render/dealer.ts) so it can animate.
  drawBackground(ctx: CanvasRenderingContext2D, layout: Layout): void {
    drawRoom(ctx, layout.width, layout.height)
  }

  // Table layer: felt + rail. Drawn on a transparent canvas so the back layer
  // shows through above the rail.
  drawTable(ctx: CanvasRenderingContext2D, layout: Layout): void {
    const dpr = deviceDpr()
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
    // Rebuild the felt whenever the cache is empty, the size changed, OR the
    // cached buffer lost its backing store. A long-lived OffscreenCanvas can be
    // silently discarded by the browser under memory pressure, leaving a blank
    // felt that previously only a resize would restore (the table read as an empty
    // dark void, most visibly right after a dealer kill). isFeltBlank() cheaply
    // detects that loss so we regenerate; the texture is only blitted a couple of
    // times per hand, so the occasional rebuild is negligible.
    if (!this.felt || this.feltKey !== key || isFeltBlank(this.felt)) {
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
  const rail = railThickness(w, h)
  // How far the felt/rail arch drops from the centre apex to the screen edges. Kept modest:
  // the rail hides the dealer's lower body, and the coverage line falls by exactly this much
  // from centre to edge — so a deep arch would expose the bottom of a dealer's body as it
  // walks in/off through the screen edges. A shallow arch keeps the rail covering a roughly
  // even slice of body all the way across (the walk-in/off path stays a straight line).
  const curveDepth = h * 0.035

  // Anchor the table DIRECTLY to the dealer figure: place the rail a fixed BOWTIE_CLEARANCE
  // below the bowtie's lower tip, so the same slice of body is hidden on every screen. The old
  // layout took max(h·fraction, figureFit) instead — on tall screens the h·fraction term shoved
  // the table low (too much torso showed), while on short/near-square screens figureFit jammed
  // the rail right under the bowtie. Because the figure is sized off min(w,h) but that fraction
  // was off h alone, which term won — and how much body showed — swung wildly with aspect ratio.
  // Sizing the figure exactly as dealerBox does keeps the two in agreement on the bowtie tip.
  const topMargin = dealerTopMargin(h)
  const headR = dealerHeadRadius(w, h)
  const figureBottom = topMargin + FIGURE_EXTENT * headR // the bowtie's lower tip
  const apexY = figureBottom + rail + headR * BOWTIE_CLEARANCE

  const edgeY = apexY + curveDepth
  return {
    width: w,
    height: h,
    edgeY,
    apexY,
    // Control point placed so the curve's midpoint lands exactly on apexY.
    controlY: apexY - curveDepth,
    rail,
  }
}

// Right-edge furniture — the table nexus and the player's bankroll stack — hugs the far right
// of the felt. On a wide screen the far right is so distant from the centred cards + score
// projections that a big void opens up in the MIDDLE of the table. Cap how far from centre that
// furniture may sit so it stays near the action: `naturalX` is its right-edge position; we pull
// it in to at most this many px past centre (the leftover felt spills to the right edge, which
// on a wide screen reads as plain table).
//
// The cap is a fraction of the SHORT edge (min(w,h)) — the same scale the cards and nexus are
// sized from — so every landscape aspect (16:9, 16:10, ultrawide) reels the furniture in by the
// SAME proportion regardless of pixel resolution: a 2560×1440 and a 1920×1080 screen (both 16:9)
// look identical. 0.4 sits just outside the widest content: a 4-way split hand band reaches only
// ~0.3·short-edge from centre, so the furniture stays clear of the cards, bet chips, scoreboard,
// and centre-projected text with margin to spare. Narrow / portrait screens keep their natural
// right edge (there the natural offset already sits inside the cap, so nothing moves). Both the
// nexus and the chip stack clamp through here, so on a wide screen they align on one right column.
export function clampRightX(l: Layout, naturalX: number): number {
  const maxOffset = Math.min(l.width, l.height) * 0.4
  return Math.min(naturalX, l.width / 2 + maxOffset)
}

// The felt's curved top edge (y) at a given x. The rail sits in the band just
// above this. Anything meant to stay off the table must keep below this minus the
// rail thickness.
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
// needs to line up with it (the eye glow, chip anchors, damage FX). Kept in one
// place so they never drift apart on resize.
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

  // Pin the head near the top margin (never touching the edge) at its natural size.
  // computeLayout already reserves room above the felt for the full figure (head +
  // bowtie) to clear the rail, so the zone cap below is only a safety net for
  // degenerate layouts and normally doesn't bind.
  const topMargin = dealerTopMargin(l.height)
  const zone = Math.max(1, l.apexY - topMargin)
  const headR = clamp(Math.min(dealerHeadRadius(l.width, l.height), zone * 0.36), 16, 96)
  const headCenterY = topMargin + headR

  const baseY = l.apexY + l.rail // tuck the body base behind the rail
  const bodyW = headR * 2.5 // shoulders a little wider than the head (headR * 2)

  return {
    cx,
    headCenterY,
    headR,
    bodyTop: headCenterY + headR, // flush with the head's bottom edge, no overlap
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

// The centre of the dealer's mouth panel — matches drawFigure's mouth geometry in
// render/dealer.ts. Anything the dealer swallows (a spawning dealer sucks the
// previous dealer's cards in here to shred them) reads it, so the art and the
// shred animation share one source of truth.
export function dealerMouth(l: Layout): { x: number; y: number } {
  const d = dealerBox(l)
  return { x: d.cx, y: d.headCenterY + d.headR * 0.42 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Whether the cached felt buffer has lost its pixels. A long-lived OffscreenCanvas
// backing store can be silently discarded by the browser under memory pressure;
// once that happens every blit of it paints nothing and the table reads as an
// empty dark void. We probe the felt's centre (always opaque green when healthy):
// a transparent centre means the buffer was discarded and must be rebuilt.
function isFeltBlank(felt: FeltCanvas): boolean {
  const w = felt.width
  const h = felt.height
  if (!w || !h) {
    return true
  }
  const ctx = (felt as HTMLCanvasElement).getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    return true
  }
  try {
    const { data } = ctx.getImageData((w / 2) | 0, (h / 2) | 0, 1, 1)
    return data[3] === 0
  } catch {
    return true // reading failed — safest to rebuild
  }
}
