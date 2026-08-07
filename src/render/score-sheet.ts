// The game-over "score screen": once the ending hand's cards have been sucked into the
// dealer's mouth and shredded, the table nexus's holo projector casts a run summary into
// the clear band between the two hands' counts — the same projection the RULES spec sheet
// and Analyze readout use. A "GAME OVER" heading over a stack of label/value rows (points,
// hands played, win/loss, tokens spent, free doubles), all projected LIGHT: no panel or
// frame. It flickers in on a strike ramp, shrinks to fit the band, and returns its text
// box so drawHoloProjection fans the holo lens's rays onto it.
//
// Render-only, mirroring spec-sheet.ts: the game builds the ScoreReadout (pure strings,
// import-free of the run types) and this paints it.

import { dealerCountAnchor, drawHoloText, playerCountAnchor, type HoloTextStyle } from './cards'
import type { HoloRayTarget } from './nexus'
import type { Layout } from './scene'

// How long the projection takes to flicker fully in (matches SPEC_STRIKE_MS's feel).
export const SCORE_STRIKE_MS = 520

// One label/value line of the summary (e.g. { label: 'POINTS', value: '4210' }).
export interface ScoreRow {
  label: string
  value: string
}

// The readout's data — pure strings, so the render layer stays decoupled from RunState.
export interface ScoreReadout {
  title: string
  rows: ScoreRow[]
}

// Holo-text styles (soft glow → translucent core): a bright heading, a dim cyan label,
// and an amber value — the same palette as the spec sheet's stat line.
const HEAD: HoloTextStyle = { glow: 'rgba(150, 245, 245, 0.95)', bloom: 'rgba(170, 248, 248, 0.55)', core: 'rgba(222, 253, 253, 0.9)' }
const AMBER: HoloTextStyle = { glow: 'rgba(255, 198, 110, 0.92)', bloom: 'rgba(255, 206, 125, 0.5)', core: 'rgba(255, 238, 195, 0.86)' }
const DIM: HoloTextStyle = { glow: 'rgba(120, 220, 230, 0.7)', bloom: 'rgba(120, 220, 230, 0.34)', core: 'rgba(180, 236, 240, 0.66)' }

// Monospace so the rows line up like a terminal readout.
function monoFont(px: number, weight = 700): string {
  return `${weight} ${px}px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace`
}

// Draw the score summary and RETURN its text box (one ray-target, so the holo lens fans
// one clean beam onto it). `age` is ms since it appeared (the strike-in), `fade` winds it
// out on dismiss, `now` positions the shared flicker.
export function drawScoreSheet(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  readout: ScoreReadout,
  age: number,
  fade = 1,
  now = 0,
): HoloRayTarget[] {
  // The clear band between the two counts — the same one the Analyze / RULES readouts use.
  const dc = dealerCountAnchor(l)
  const pc = playerCountAnchor(l, 1, 0)
  const countPx = dc.size
  const bandTop = dc.y + countPx * 0.7
  const bandBottom = pc.y - countPx * 0.7
  const bandH = Math.max(1, bandBottom - bandTop)
  const bandMid = (bandTop + bandBottom) / 2
  const cx = l.width / 2

  const scale = Math.min(l.width, l.height)
  const titlePx = clamp(scale * 0.03, 16, 28)
  const rowPx = clamp(scale * 0.02, 12, 19)
  // The row column width: labels left-aligned, values right-aligned within it.
  const contentW = Math.min(l.width * 0.7, 360)

  // Vertical budget: the heading block, a gap, then the label/value rows. Shrink to fit
  // the band so it never spills into the counts.
  const titleBlock = titlePx * 1.5
  const titleGap = rowPx * 0.9
  const rowH = rowPx * 1.7
  const contentH = titleBlock + titleGap + readout.rows.length * rowH
  const f = Math.min(1, bandH / contentH)

  const tPx = titlePx * f
  const rPx = rowPx * f
  const tBlock = titleBlock * f
  const tGap = titleGap * f
  const rH = rowH * f
  const cW = contentW * f
  const totalH = tBlock + tGap + readout.rows.length * rH

  const presence = clamp01(age / SCORE_STRIKE_MS) * fade

  ctx.save()
  ctx.globalAlpha = presence

  let y = bandMid - totalH / 2
  holoCentered(ctx, readout.title, cx, y + tBlock / 2, tPx, HEAD, now, 800)
  y += tBlock + tGap

  const left = cx - cW / 2
  const right = cx + cW / 2
  for (const row of readout.rows) {
    drawRow(ctx, left, right, y + rH / 2, rPx, row, now)
    y += rH
  }

  ctx.restore()

  const top = bandMid - totalH / 2
  return [{ left, right, top, bottom: top + totalH }]
}

// One summary line: a dim label pinned to the left of the column, the amber value to the
// right — so a stack of them reads as an aligned table.
function drawRow(ctx: CanvasRenderingContext2D, left: number, right: number, y: number, px: number, row: ScoreRow, now: number): void {
  ctx.font = monoFont(px)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  drawHoloText(ctx, row.label, left, y, px, DIM, now)
  ctx.textAlign = 'right'
  drawHoloText(ctx, row.value, right, y, px, AMBER, now)
}

// Draw centred holo text (sets font/alignment, then blits the cached glow sprite).
function holoCentered(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, px: number, style: HoloTextStyle, now: number, weight = 700): void {
  ctx.font = monoFont(px, weight)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  drawHoloText(ctx, text, cx, y, px, style, now)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
