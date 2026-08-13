// The dealer "hand summary": a projected row of slots, one per hand the current dealer can deal
// before it walks off (maxHands). Each slot fills as hands resolve — a green check for a win (a hit
// landed), a red X for a loss — the rest are dim gray circles. The newest symbol(s) scale down +
// fade in; a kill fills the remaining row green (the cash-in). Shown between hands.

import type { Layout } from './scene'
import type { HoloRayTarget } from './nexus'
import type { Point } from './tokens'
import { handBand } from './cards'

export type SummarySlot = 'win' | 'loss' | 'empty'

/** What a summary draw hands back: the holo ray boxes to fan light onto, and every slot's centre in
 *  canvas coords (indexed by slot) — the launch points for the fly-in score deltas. */
export interface HandSummaryDraw {
  rays: HoloRayTarget[]
  slotCenters: Point[]
}

export interface HandSummaryView {
  /** One entry per window slot, length = the dealer's maxHands. */
  slots: readonly SummarySlot[]
  /** Slots at or after this index are new this hand — they animate in. */
  revealFrom: number
  /**
   * ms since the reveal began. EVERY new slot k (from revealFrom) pops in CASH_IN_STAGGER·k later —
   * one flowing cascade over the whole run, so a split/double's two checks and a kill's cash-in all
   * fill one-by-one at the same interval (never all at once).
   */
  cashInElapsed: number
  /** 0..1 overall opacity (eases in on appear, fades to 0 on Next hand). */
  fade: number
}

const WIN = '#49b26a'
const LOSS = '#d8484b'
const EMPTY = 'rgba(180, 200, 220, 0.32)'
const MARK = '#0b0f14'
// The kill cash-in cascade: each remaining slot flips green CASH_IN_STAGGER ms after the previous,
// each popping in over CASH_IN_REVEAL_MS (they overlap into a flowing fill). Exported so game-view
// can time the Next-hand consent gate to the moment the last bonus slot lands.
export const CASH_IN_STAGGER = 100
export const CASH_IN_REVEAL_MS = 180
// How much OVER-SIZED a win/loss mark starts as it fades in, as a fraction of the pip radius: it
// pops in at (1 + MARK_POP)× and settles to 1× — a bigger value is a bigger, punchier entrance.
const MARK_POP = 2.0

export function drawHandSummary(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  view: HandSummaryView,
  bounds: { left: number; right: number },
): HandSummaryDraw {
  const n = view.slots.length
  if (n === 0 || view.fade <= 0) {
    return { rays: [], slotCenters: [] }
  }
  // A nexus holo projection in the band BETWEEN the dealer's cards and the player's (shared with the
  // Analyze readout). The pips WRAP into as many rows as the screen needs — derived from the
  // available width, never a fixed row count — so a full late-dealer window (or a narrow phone)
  // reflows instead of shrinking to an illegible single line.
  const band = handBand(layout)
  const regionH = Math.max(24, band.bottom - band.top)
  // `bounds` is the clear horizontal zone the pips must stay within — RIGHT of the label-driven
  // powerup column and LEFT of the table nexus (both measured in game-view). The grid centres in it,
  // so it never hides behind a button or runs past the nexus.
  const availW = Math.max(48, bounds.right - bounds.left)
  const centerX = (bounds.left + bounds.right) / 2
  const GAP = 0.34 // gap between pips, as a fraction of a pip's diameter
  // Pip size SCALES with the screen (was a fixed 12–30 px). The width/height fit below shrinks it
  // further if the wrapped rows still don't fit.
  const span = Math.min(layout.width, layout.height)
  const MAX_D = Math.min(46, Math.max(16, span * 0.055))
  const MIN_D = Math.min(18, Math.max(9, span * 0.028))

  // Pick the LARGEST pip diameter whose wrapped rows fit BOTH the available width (per row) and the
  // band height (rows tall). More rows are fine; illegibly-tiny pips are not.
  let d = MAX_D
  for (; d > MIN_D; d -= 1) {
    const cell = d * (1 + GAP)
    const perRow = Math.max(1, Math.min(n, Math.floor(availW / cell)))
    const rows = Math.ceil(n / perRow)
    if ((rows - 1) * cell + d <= regionH) {
      break
    }
  }
  const cell = d * (1 + GAP)
  const rows = Math.ceil(n / Math.max(1, Math.min(n, Math.floor(availW / cell))))
  const perRow = Math.ceil(n / rows) // balance the rows so the last one isn't lonely
  const r = d / 2
  const totalH = (rows - 1) * cell + d
  const rowCenterY = (row: number): number => band.center - totalH / 2 + r + row * cell

  ctx.save()
  ctx.globalAlpha = view.fade
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  let minX = Infinity
  let maxX = -Infinity
  const slotCenters: Point[] = []
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / perRow)
    const col = i % perRow
    const rowCount = Math.min(perRow, n - row * perRow)
    const x = centerX - ((rowCount - 1) * cell) / 2 + col * cell
    const y = rowCenterY(row)
    slotCenters.push({ x, y })
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    const slot = view.slots[i]
    if (i < view.revealFrom || slot === 'empty') {
      drawSlot(ctx, x, y, r, slot, 1)
      continue
    }
    // A newly-filled slot: the gray dot shows FIRST (the old state), then the win/loss symbol
    // scales down + fades in on top — so the player sees the result appear over the empty slot. Every
    // new slot cascades uniformly: slot k reveals CASH_IN_STAGGER·k after the first, so a split/double
    // fills its two checks one-by-one and a kill flows straight on into its cash-in.
    const k = i - view.revealFrom
    const p = clamp01((view.cashInElapsed - k * CASH_IN_STAGGER) / CASH_IN_REVEAL_MS)
    drawSlot(ctx, x, y, r, 'empty', 1)
    if (p > 0) {
      drawSlot(ctx, x, y, r * (1 + (1 - p) * MARK_POP), slot, p)
    }
  }
  ctx.restore()
  // The grid's bounding box, so the holo lens fans its rays onto it (like the other readouts). The
  // fan dims with the board's `fade` so the projection winds down WITH the pips on Next hand, instead
  // of the rays staying lit and snapping off a beat after the marks have gone.
  //
  // `clampToNexus`: this is a CENTRED board that always sits LEFT of the lens (game-view bounds it to
  // `lensX − margin`), exactly like the scoreboards — so it opts into the fan restriction. Without it,
  // a single wide row (e.g. dealer 1's full 11-pip window on a narrow-HUD portrait screen) has pips
  // that end well left of the lens, but the ray base's soft 25%-of-width pad overshoots PAST the lens
  // → light spills out the RIGHT of the nexus (the recurring "rays fire sideways" bug). The clamp
  // drops that pad so the fan lands on the pips, never right of the device. See render/nexus.ts.
  const rays: HoloRayTarget[] = [
    { left: minX - r * 1.5, right: maxX + r * 1.5, top: rowCenterY(0) - r * 1.6, bottom: rowCenterY(rows - 1) + r * 1.6, fade: view.fade, clampToNexus: true },
  ]
  return { rays, slotCenters }
}

function drawSlot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, slot: SummarySlot, alpha: number): void {
  ctx.save()
  ctx.globalAlpha *= alpha
  if (slot === 'empty') {
    ctx.strokeStyle = EMPTY
    ctx.lineWidth = Math.max(1.5, r * 0.16)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    return
  }
  const color = slot === 'win' ? WIN : LOSS
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = r * 0.8
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.strokeStyle = MARK
  ctx.lineWidth = Math.max(2, r * 0.24)
  ctx.beginPath()
  if (slot === 'win') {
    ctx.moveTo(x - r * 0.45, y + r * 0.02)
    ctx.lineTo(x - r * 0.08, y + r * 0.42)
    ctx.lineTo(x + r * 0.5, y - r * 0.4)
  } else {
    ctx.moveTo(x - r * 0.4, y - r * 0.4)
    ctx.lineTo(x + r * 0.4, y + r * 0.4)
    ctx.moveTo(x + r * 0.4, y - r * 0.4)
    ctx.lineTo(x - r * 0.4, y + r * 0.4)
  }
  ctx.stroke()
  ctx.restore()
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
