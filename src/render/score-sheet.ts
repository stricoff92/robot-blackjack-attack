// The FINAL SCOREBOARD (docs/scoreboards.md): the game-over "score screen" shown when the run
// ends — an early bankruptcy, a cash-out after the Banker, or a loss to the Banker (the title
// names which; see buildScore_ in game-view). Distinct from the two BANKER scoreboards (the
// double-or-nothing offer, render/coda-stake.ts), which are still mid-run.
//
// Once the ending hand's cards have been sucked into the dealer's mouth and shredded, the table
// nexus's holo projector casts a run summary onto the clear felt — the same projection the RULES
// spec sheet and Analyze readout use. A "GAME OVER" heading over a stack of label/value rows
// (points, hands played, win/loss, tokens spent, free doubles), all projected LIGHT: no panel or
// frame. It flickers in on a strike ramp and returns its text box so drawHoloProjection fans the
// holo lens's rays onto it. Type is sized to match the BANKER scoreboards (coda-stake.ts): the old
// board floored rows at 12px and then shrank them to fit the thin gap between the two hand counts,
// so it read at ~half the coda's size (worst on iOS); scoreBoardPlacement now spans the whole clear
// felt during 'over' (the cards are gone) so the rows keep their full, coda-parity size.
//
// Render-only, mirroring spec-sheet.ts: the game builds the ScoreReadout (pure strings,
// import-free of the run types) and this paints it.

import { BOTTOM_HUD_RESERVE, dealerCountAnchor, drawHoloText, holoFlicker, type HoloTextStyle } from './cards'
import { nexusHoloLight, type HoloRayTarget } from './nexus'
import { feltTopEdgeY, type Layout } from './scene'
import { measureTitleWidest, titleFont, TITLE_LINES, TITLE_RED } from './title-font'

// How long the projection takes to flicker fully in (matches SPEC_STRIKE_MS's feel).
const SCORE_STRIKE_MS = 520

// One label/value line of the summary (e.g. { label: 'POINTS', value: '4210' }).
export interface ScoreRow {
  label: string
  value: string
}

// The readout's data — pure strings, so the render layer stays decoupled from RunState.
export interface ScoreReadout {
  title: string
  // An optional CENTERED hero line drawn between the heading and the rows, label-less (e.g. the
  // performance page's star rating "★★★★☆ 3.5"). Bigger than a row, amber like a value.
  hero?: string
  rows: ScoreRow[]
}

// Holo-text styles (soft glow → translucent core): a bright heading, a dim cyan label,
// and an amber value — the same palette as the spec sheet's stat line.
const HEAD: HoloTextStyle = { glow: 'rgba(150, 245, 245, 0.95)', bloom: 'rgba(170, 248, 248, 0.55)', core: 'rgba(222, 253, 253, 0.9)' }
const AMBER: HoloTextStyle = { glow: 'rgba(255, 198, 110, 0.92)', bloom: 'rgba(255, 206, 125, 0.5)', core: 'rgba(255, 238, 195, 0.86)' }
const DIM: HoloTextStyle = { glow: 'rgba(120, 220, 230, 0.7)', bloom: 'rgba(120, 220, 230, 0.34)', core: 'rgba(180, 236, 240, 0.66)' }

// The gap between a row's label and its right-aligned value, in multiples of the row font
// size (≈ 4 monospace characters). Enough to read as a table, without the cavern the old
// fixed-fraction column stretched between the short labels and shorter values.
const LABEL_VALUE_GAP = 2.5

// Monospace so the rows line up like a terminal readout.
function monoFont(px: number, weight = 700): string {
  return `${weight} ${px}px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace`
}

// How far (× felt scale) `shiftLeft` nudges the board left of centre — matches the coda
// scoreboards' offset so the run-ending boards share one left column. Exported so the DOM page
// pager (game-view) can sit under the same shifted centre.
export const SCORE_LEFT_SHIFT = 0.08

// The DOM score pager (‹ • • ›) sits just under the board; reserve its button height (game-view.css
// .hud-score-pager__btn) so the board leaves room for it. Kept in sync with that CSS.
export const SCORE_PAGER_H = 34

// Coda-parity type sizes: rows track the banker scoreboards (coda-stake.ts rows are
// clamp(scale*0.03, 17, 32)); the heading a step larger. The old board used scale*0.02 floored at
// 12px — under the coda's 17px floor on every phone — then shrank further to fit the count gap.
function scoreSizes(scale: number): { titlePx: number; heroPx: number; rowPx: number } {
  return {
    titlePx: clamp(scale * 0.041, 20, 34),
    heroPx: clamp(scale * 0.035, 18, 30),
    rowPx: clamp(scale * 0.03, 17, 24),
  }
}

// The natural (pre-fit) height of a board with `rows` label/value rows and an optional hero line —
// the heading block, its gap, the hero block + gap, then the rows. Mirrors the vertical stack drawn
// in drawScoreSheet, so scoreBoardPlacement can reserve exactly the room the board will occupy.
function scoreContentH(rows: number, hasHero: boolean, s: { titlePx: number; heroPx: number; rowPx: number }): number {
  const titleBlock = s.titlePx * 1.5
  const titleGap = s.rowPx * 0.9
  const heroBlock = hasHero ? s.heroPx * 1.5 : 0
  const heroGap = hasHero ? s.rowPx * 0.8 : 0
  const rowH = s.rowPx * 1.7
  return titleBlock + titleGap + heroBlock + heroGap + rows * rowH
}

// Where the final scoreboard sits vertically, and how much it's scaled to fit. The old board squeezed
// into the thin gap BETWEEN the two hand counts, leaving the lower half of the felt unused; this uses
// the whole clear felt during 'over' (the cards are gone): from just under the game-title wordmark
// down to the bottom action bar, reserving room for the DOM pager beneath the board.
//
// The board + pager are centred as one group in that region, so the whitespace above and below reads
// evenly. Both are placed off a REFERENCE height (the taller of the two pager pages), NOT the live
// page's — so `centerY` / `pagerY` don't shift when the player flips ‹ ›. `f` (≤ 1) only shrinks on a
// short felt (e.g. a landscape phone); on every portrait phone it's 1, so rows render at full size.
// Exported so the DOM pager (game-view) anchors to the same `pagerY` the board leaves room for.
export function scoreBoardPlacement(l: Layout): { centerY: number; f: number; pagerY: number } {
  const dc = dealerCountAnchor(l)
  const scale = Math.min(l.width, l.height)
  const s = scoreSizes(scale)
  const regionTop = dc.y + dc.size * 0.7 // just below the wordmark's home (drawScoreTitle)
  const regionBottom = l.height - BOTTOM_HUD_RESERVE // clear of the bottom action bar ("New run")
  const available = Math.max(1, regionBottom - regionTop)
  // Reference = the taller page, so placement is page-independent. Mirrors game-view's two pages:
  // buildSummary_ (5 rows, no hero) and buildPerformance_ (a hero line + 3 rows) — keep in sync.
  const refH = Math.max(scoreContentH(5, false, s), scoreContentH(3, true, s))
  const pagerGap = dc.size * 0.7
  const f = Math.min(1, (available - pagerGap - SCORE_PAGER_H) / refH)
  const groupTop = regionTop + (available - (refH * f + pagerGap + SCORE_PAGER_H)) / 2
  return { centerY: groupTop + (refH * f) / 2, f, pagerY: groupTop + refH * f + pagerGap }
}

// Draw the score summary and RETURN its text box (one ray-target, so the holo lens fans
// one clean beam onto it). `age` is ms since it appeared (the strike-in), `fade` winds it
// out on dismiss, `now` positions the shared flicker. `shiftLeft` nudges the board slightly
// left of felt-centre (the cash-out / lost-to-Banker boards, matching the coda scoreboards).
export function drawScoreSheet(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  readout: ScoreReadout,
  age: number,
  fade = 1,
  now = 0,
  shiftLeft = false,
): HoloRayTarget[] {
  const scale = Math.min(l.width, l.height)
  const s = scoreSizes(scale)
  // Vertical home + shared shrink factor, centred on the clear felt and page-independent (so a ‹ ›
  // flip doesn't nudge the board). `f` is 1 on every portrait phone (rows at full size).
  const { centerY, f } = scoreBoardPlacement(l)
  const cx = l.width / 2 - (shiftLeft ? scale * SCORE_LEFT_SHIFT : 0)

  // Type sizes: the shared vertical fit `f`, then a WIDTH fit (`fw`) so the row column never
  // overruns the felt — measured at these sizes (text width scales linearly). The column is sized to
  // its CONTENT (widest label, a readable gap, widest value), not a fixed slab, and capped at the
  // same width the old board used so the box stays clear of the mid-right nexus and its ray fan reads
  // cleanly. `fw` shrinks the type (rather than clipping the column) if the content is too wide.
  let titlePx = s.titlePx * f
  let heroPx = s.heroPx * f
  let rowPx = s.rowPx * f
  ctx.font = monoFont(rowPx)
  let labelW = 0
  let valueW = 0
  for (const row of readout.rows) {
    labelW = Math.max(labelW, ctx.measureText(row.label).width)
    valueW = Math.max(valueW, ctx.measureText(row.value).width)
  }
  ctx.font = monoFont(titlePx, 800)
  const titleW = ctx.measureText(readout.title).width
  let heroW = 0
  if (readout.hero) {
    ctx.font = monoFont(heroPx, 800)
    heroW = ctx.measureText(readout.hero).width
  }
  const naturalW = Math.max(labelW + rowPx * LABEL_VALUE_GAP + valueW, titleW, heroW)
  const widthBudget = Math.min(l.width * 0.9, 360)
  const fw = Math.min(1, widthBudget / Math.max(1, naturalW))
  titlePx *= fw
  heroPx *= fw
  rowPx *= fw
  const cW = naturalW * fw

  // Vertical stack: the heading block, a gap, an optional centered hero line + its gap, then the
  // label/value rows — centred on `centerY` (must mirror scoreContentH, which reserves its room).
  const titleBlock = titlePx * 1.5
  const titleGap = rowPx * 0.9
  const heroBlock = readout.hero ? heroPx * 1.5 : 0
  const heroGap = readout.hero ? rowPx * 0.8 : 0
  const rowH = rowPx * 1.7
  const totalH = titleBlock + titleGap + heroBlock + heroGap + readout.rows.length * rowH

  const presence = clamp01(age / SCORE_STRIKE_MS) * fade

  ctx.save()
  ctx.globalAlpha = presence

  const top = centerY - totalH / 2
  let y = top
  holoCentered(ctx, readout.title, cx, y + titleBlock / 2, titlePx, HEAD, now, 800)
  y += titleBlock + titleGap

  // The centered hero line (e.g. the star rating), drawn label-less in the amber value tone.
  if (readout.hero) {
    holoCentered(ctx, readout.hero, cx, y + heroBlock / 2, heroPx, AMBER, now, 800)
    y += heroBlock + heroGap
  }

  const left = cx - cW / 2
  const right = cx + cW / 2
  for (const row of readout.rows) {
    drawRow(ctx, left, right, y + rowH / 2, rowPx, row, now)
    y += rowH
  }

  ctx.restore()

  // clampToNexus: the final scoreboard — keep its fan left of the lens (no right-of-nexus spill).
  return [{ left, right, top, bottom: top + totalH, clampToNexus: true }]
}

// The game title (ROBOT / BLACKJACK / ATTACK) projected ABOVE the score board on the game-over
// screen — the same Sixtyfour pixel-font wordmark the opening TAP-TO-START screen shows. It sits
// in the empty upper felt between the felt's top rail and the summary band, so it never crowds the
// board (sufficient space), sized modestly (it's a header, not the opening hero art). Drawn LEFT
// of felt-centre so the nexus ray fan (cast from the lens on the RIGHT) swings toward horizontal
// and clears the lens — the fan bugs out if a box sits too wide or too far right. Returns its
// ray-target box (sized to 1/1.5 of the fan reach so drawHoloRays' 25% pad lands the fan just
// past the letters, not off to the side). `age` is ms since the score screen appeared.
export function drawScoreTitle(ctx: CanvasRenderingContext2D, l: Layout, age: number, now = 0): HoloRayTarget[] {
  const cx = l.width / 2
  const scale = Math.min(l.width, l.height)
  const compact = l.width < 560

  // Size — a header, smaller than the opening hero wordmark; shrunk to a modest width share so
  // the widest word (BLACKJACK) fits well left of the nexus. Measured in the face it draws in.
  let px = clamp(scale * 0.04, compact ? 16 : 20, 44)
  ctx.font = titleFont(px)
  let widest = measureTitleWidest(ctx)
  const maxW = l.width * (compact ? 0.62 : 0.5)
  if (widest > maxW) {
    px = Math.max(14, (px * maxW) / widest)
    ctx.font = titleFont(px)
    widest = measureTitleWidest(ctx)
  }

  // Vertical home: the empty gap between the felt's top edge and the summary band. Measure the
  // rail near where the block actually sits (left of centre, where the curved edge dips lower) so
  // no letter overhangs it, then fit + centre the block there so it clears the rail and the board.
  const dc = dealerCountAnchor(l)
  const bandTop = dc.y + dc.size * 0.7
  const estCenterX = cx - scale * 0.12 // the left-of-centre target the block lands near (pre-clamp)
  const feltTop = Math.max(feltTopEdgeY(l, estCenterX - widest / 2), feltTopEdgeY(l, estCenterX + widest / 2))
  const gapTop = feltTop + px * 0.4
  const gapBottom = bandTop - px * 0.4
  const gap = gapBottom - gapTop
  if (gap <= px * 0.9) {
    return [] // no meaningful room (very short screen) — skip the header rather than overlap
  }
  let lineH = px * 1.02
  let blockH = TITLE_LINES.length * lineH
  if (blockH > gap) {
    px *= gap / blockH
    ctx.font = titleFont(px)
    widest = measureTitleWidest(ctx)
    lineH = px * 1.02
    blockH = TITLE_LINES.length * lineH
  }

  // Left-of-centre placement + fan clearance (mirrors tap-to-start): push the block left of
  // felt-centre, then clamp so its fan still clears the nexus lens on narrow screens.
  const fanReach = widest / 2 + px * 0.2
  const rayHalfW = fanReach / 1.5
  const nexusX = nexusHoloLight(l, now).x
  const maxCx = nexusX - px * 0.7 - fanReach
  const centerX = Math.max(fanReach + px * 0.15, Math.min(cx - scale * 0.12, maxCx))
  const left = centerX - widest / 2

  const top = (gapTop + gapBottom) / 2 - blockH / 2
  const firstCenter = top + px * 0.5

  const presence = clamp01(age / SCORE_STRIKE_MS)
  ctx.save()
  ctx.globalAlpha = presence * holoFlicker(now)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = titleFont(px)
  for (let i = 0; i < TITLE_LINES.length; i++) {
    const y = firstCenter + i * lineH
    // Red shadow pass: black fill casting a blurred, slightly offset red glow.
    ctx.fillStyle = '#000000'
    ctx.shadowColor = TITLE_RED
    ctx.shadowBlur = px * 0.34
    ctx.shadowOffsetX = px * 0.05
    ctx.shadowOffsetY = px * 0.08
    ctx.fillText(TITLE_LINES[i], left, y)
    // Crisp black pass on top so the letters stay solidly black over their own red halo.
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.fillText(TITLE_LINES[i], left, y)
  }
  ctx.restore()

  return [{ left: centerX - rayHalfW, right: centerX + rayHalfW, top, bottom: top + blockH }]
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
