// The BANKER SCOREBOARD (docs/scoreboards.md): the double-or-nothing CODA offer. When the
// endgame stake is on the line, the table nexus projects the player's current score onto the
// middle of the felt as holo text — the "POINTS AT RISK", the pot they're gambling on the final
// hand. Render-only, a near-clone of combo-projection: the game hands over the points at stake
// and this paints them as projected light, returning their box so the holo lens fans rays onto it.
//
// Three looks (docs/scoreboards.md), keyed on `tax` then `wonHand`:
//   • VICTORY banker scoreboard (tax = null, wonHand = false) — the entry offer after beating all 6
//     dealers. A CENTRED holo block: "The banker says:", the offer, and the big lavender stake
//     number; the whole block pops in as one.
//   • BANKER-HAND PLAYER VICTORY scoreboard (tax = null, wonHand = true) — shown after the player
//     WINS a coda hand (in either coda). Same holo block, but LEFT-JUSTIFIED and sat slightly left
//     of centre, with the offer LAST: "The banker says:" / the doubled stake / Your best / the
//     offer. The game plays a slow hand-clap sfx as it appears.
//   • BANKRUPTCY banker scoreboard (tax set) — reached by going broke at Dealer 3+. A LEFT-ALIGNED
//     seizure statement (like a receipt), also slightly left of centre, under one "The banker says:"
//     header — Points (gross) → Bankruptcy tax −N% → Net → Your best, labels left / values right,
//     ALL one size and one holo-cyan tone with RED on the −N% deduction alone; Net is the surviving
//     stake; "Double or nothing?" last. Rows cascade in one at a time (`rowStagger`). So the whole
//     "the banker takes his cut, then offers you the rest" beat reads on ONE screen.
// The run-over summary is a DIFFERENT board — the "final scoreboard" (render/score-sheet.ts).

import { dealerCountAnchor, drawHoloText, playerCountAnchor, type HoloTextStyle } from './cards'
import type { HoloRayTarget } from './nexus'
import type { Layout } from './scene'
import { starImage } from './star-sprite'

// How long the projection takes to fade + scale fully in (the 2×→1× pop settles over this).
// In the staged (bankruptcy) panel this is the per-ROW strike window; it's exported so game-view
// can time the top-right counter's gross→net tick to the moment the Net row lands.
export const CODA_STAKE_STRIKE_MS = 300

// The one holo tone the panels are built from — a soft cyan glow over a translucent core. The
// VICTORY board draws its whole prompt in it; the BANKRUPTCY statement uses it for every row too,
// with RED reserved for the one deduction line so the seizure is the only splash of colour.
const CYAN: HoloTextStyle = { glow: 'rgba(130, 240, 236, 0.95)', bloom: 'rgba(150, 246, 242, 0.55)', core: 'rgba(214, 253, 251, 0.9)' }
// The victory stake NUMBER stands apart from the cyan prompt: a bright near-white lavender core
// over a dense BLACK halo, drawn larger than the prompt lines (see numberPx) — the pot reads as the
// hot value being gambled and stays legible against the felt. Used ONLY by the victory board (the
// bankruptcy statement keeps everything one size + one colour, so it doesn't touch this).
const PURPLE: HoloTextStyle = { glow: 'rgba(0, 0, 0, 1)', bloom: 'rgba(0, 0, 0, 0.8)', core: 'rgba(228, 216, 255, 1)' }
// The tax bite: a hot red core over a deep red-black halo, so the seizure reads as a wound. The
// only non-cyan tone on the bankruptcy statement — on the −N% deduction alone.
const RED: HoloTextStyle = { glow: 'rgba(30, 0, 0, 1)', bloom: 'rgba(12, 0, 0, 0.85)', core: 'rgba(255, 138, 138, 1)' }

// Bankruptcy STATEMENT layout (the `tax` path): a left-aligned receipt — labels left, values in a
// right-aligned column — one uniform size, cascading a row in every `rowStagger`.
const STMT_LEADING = 1.5 // row pitch, × the font size
const STMT_GROUP_GAP = 0.55 // extra space (× font size) before the table and before the offer
const STMT_LABEL_VALUE_GAP = 1.4 // gap (× font size) between the widest label and the value column
// Shift a left-justified coda readout this far (× felt scale) left of centre — shared by the
// bankruptcy statement and the banker-hand-win prompt so both sit at the same left column.
const CODA_LEFT_SHIFT = 0.08

// The bankruptcy seizure the panel leads with: the pre-tax gross, the surviving net, and the
// tax percent (whole). null for the plain between-hands stake prompt.
export interface CodaTaxBreakdown {
  gross: number
  net: number
  taxPct: number
}

// One line of the VICTORY / between-hands prompt (the centred block). The bankruptcy statement has
// its own row model (drawBankruptcyStatement) — a left-aligned table, not this.
interface StakeLine {
  text: string
  style: HoloTextStyle
  size: number
  glow: number
  starUnit?: boolean
}

function boldFont(px: number, weight = 800): string {
  return `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
}

// Draw the double-or-nothing banker scoreboard and RETURN its box (one ray-target). `age` = ms
// since it appeared (strike-in), `fade` winds it out, `now` positions the shared holo flicker.
// With `tax` set this is the BANKRUPTCY variant — a left-aligned seizure statement that cascades a
// row in every `rowStagger` (drawBankruptcyStatement). Otherwise `wonHand` picks the look: false =
// the centred VICTORY entry offer; true = the LEFT-JUSTIFIED banker-hand-win prompt (offer last).
export function drawCodaStake(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  points: number,
  wonHand: boolean,
  personalBest: number,
  age: number,
  fade: number,
  now: number,
  tax: CodaTaxBreakdown | null = null,
  rowStagger = 0,
): HoloRayTarget[] {
  const l = layout
  // Centre of the felt: the clear band between the two hand counts, horizontally centred.
  const dc = dealerCountAnchor(l)
  const pc = playerCountAnchor(l, 1, 0)
  const bandMid = (dc.y + pc.y) / 2
  const cx = l.width / 2

  const scale = Math.min(l.width, l.height)
  const px = clamp(scale * 0.03, 17, 32)

  // BANKRUPTCY variant: the taxed-seizure statement owns its own layout (left-aligned, one size),
  // sat slightly left of felt-centre so it reads as a document, not a dead-centre banner.
  if (tax) {
    const anchorX = cx - scale * CODA_LEFT_SHIFT
    return drawBankruptcyStatement(ctx, anchorX, bandMid, px, tax, personalBest, age, fade, now, rowStagger)
  }

  // VICTORY entry offer / banker-hand-win prompt. The stake NUMBER reads 30% larger than the cyan
  // prompt lines, with a wider + denser glow (NUMBER_GLOW), so the pot at risk is easiest to read.
  const numberPx = px * 1.3
  const NUMBER_GLOW = 1.35
  // Use the ROLLING counter value so on a win the projected stake ticks up to the doubled total in
  // lockstep with the HUD; locale-grouped (thousands separators per the runtime locale).
  const stake = points.toLocaleString()

  // `starUnit: true` trails a line with the yellow POINTS star as a UNIT after the number.
  const lines: StakeLine[] = []
  lines.push({ text: 'The banker says:', style: CYAN, size: px, glow: 1 })
  if (wonHand) {
    // The banker-hand-win prompt leads straight into the (now doubled) stake; the
    // "Double or nothing?" offer is appended LAST (below the best-score line) further down.
    lines.push({ text: stake, style: PURPLE, size: numberPx, glow: NUMBER_GLOW, starUnit: true })
  } else {
    lines.push({ text: 'Double or nothing?', style: CYAN, size: px, glow: 1 })
    lines.push({ text: stake, style: PURPLE, size: numberPx, glow: NUMBER_GLOW, starUnit: true })
  }
  // The player's personal best — the "score to beat" — sits below the stake as a smaller cyan line
  // so they can weigh the gamble against their record. Skipped for first-timers (best 0), and (like
  // the stake) locale-grouped. CrazyGames leaderboards are submit-only, so this is our own tracked
  // best, not a global read (see src/game/leaderboard.ts).
  if (personalBest > 0) {
    lines.push({ text: `Your best ${personalBest.toLocaleString()}`, style: CYAN, size: px * 0.85, glow: 1, starUnit: true })
  }
  // On the banker-hand-win prompt the offer is the FINAL line — the call to action sits at the
  // bottom of the stack, below the best-score line. (The centred entry offer keeps its own order
  // above.)
  if (wonHand) {
    lines.push({ text: 'Double or nothing?', style: CYAN, size: px, glow: 1 })
  }

  // Stack the lines in per-line vertical slots (each `size · leading`) rather than one uniform gap,
  // so the taller stake number claims its own room and the block stays centred on the felt band
  // whatever the mix of sizes. `centers[i]` is line i's middle baseline.
  const leading = 1.5
  const slots = lines.map((line) => line.size * leading)
  const totalH = slots.reduce((a, b) => a + b, 0)
  let cursor = bandMid - totalH / 2
  const centers = slots.map((h) => {
    const c = cursor + h / 2
    cursor += h
    return c
  })

  // Pre-measure every row's full width (text + any trailing star) so the ray-target box is stable.
  const rowWidths = lines.map((line) => {
    ctx.font = boldFont(line.size)
    const textW = ctx.measureText(line.text).width
    return line.starUnit ? textW + starUnitSpan(line.size) : textW
  })
  const maxW = Math.max(0, ...rowWidths)

  // The banker-hand-win prompt (the player just beat the Banker's hand) is LEFT-JUSTIFIED and sat
  // slightly left of felt-centre; the plain VICTORY entry offer stays centred.
  const leftJustify = wonHand
  const anchorX = leftJustify ? cx - scale * CODA_LEFT_SHIFT : cx
  const left = anchorX - maxW / 2

  // The whole block scales + fades in as one (2× → 1× ease-out settle), around its own centre.
  const strikeT = clamp01(age / CODA_STAKE_STRIKE_MS)
  const presence = strikeT * fade
  const popScale = 1 + (1 - strikeT) * (1 - strikeT)
  ctx.save()
  ctx.globalAlpha = presence
  ctx.translate(anchorX, bandMid)
  ctx.scale(popScale, popScale)
  ctx.translate(-anchorX, -bandMid)
  lines.forEach((line, i) => {
    if (leftJustify) {
      drawStakeLineLeft(ctx, line, left, centers[i], now)
    } else {
      drawStakeLine(ctx, line, anchorX, centers[i], now)
    }
  })
  ctx.restore()

  const halfW = maxW / 2 + px * 0.2
  const halfH = totalH / 2 + px * 0.4
  // clampToNexus: a scoreboard — keep its fan left of the lens (no right-of-nexus spill).
  return [{ left: anchorX - halfW, right: anchorX + halfW, top: bandMid - halfH, bottom: bandMid + halfH, clampToNexus: true }]
}

// The BANKRUPTCY banker scoreboard: a left-aligned seizure statement — Points (gross) → Bankruptcy
// tax −N% → Net → Your best — where Net IS the surviving stake the player gambles (starred; no
// separate stake row, which would just repeat it). Labels sit left, values right-align in a shared
// column, all one size and one holo-cyan tone, with RED on the −N% deduction alone. The
// "Double or nothing?" call to action sits LAST, set off below by a group gap (the other group gap
// follows the "The banker says:" header). Built around `anchorX` (slightly left of felt-centre).
// Rows cascade in `rowStagger` apart (each a 2×→1× strike), then hold through the shared fade.
// Returns the block box.
function drawBankruptcyStatement(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  bandMid: number,
  px: number,
  tax: CodaTaxBreakdown,
  personalBest: number,
  age: number,
  fade: number,
  now: number,
  rowStagger: number,
): HoloRayTarget[] {
  interface StmtRow {
    label: string // left-hand text (a prompt row's whole content; a pair row's label)
    value: string // right-aligned value ('' for a prompt row)
    red: boolean // RED value — the tax deduction alone
    star: boolean // trail the value with the POINTS star (marks a points figure)
    pair: boolean // label/value row (vs a full-width prompt line)
    gapBefore: boolean // extra group spacing above
    at: number // strike-in offset (ms)
  }

  const rows: StmtRow[] = []
  let at = 0
  const step = (): number => {
    const a = at
    at += rowStagger
    return a
  }
  const prompt = (label: string, gapBefore: boolean): void => {
    rows.push({ label, value: '', red: false, star: false, pair: false, gapBefore, at: step() })
  }
  const pair = (label: string, value: string, opts: { red?: boolean; star?: boolean; gapBefore?: boolean } = {}): void => {
    rows.push({ label, value, red: !!opts.red, star: !!opts.star, pair: true, gapBefore: !!opts.gapBefore, at: step() })
  }

  prompt('The banker says:', false)
  pair('Points', tax.gross.toLocaleString(), { gapBefore: true })
  pair('Bankruptcy tax', `−${Math.round(tax.taxPct)}%`, { red: true })
  pair('Net', tax.net.toLocaleString(), { star: true }) // the surviving stake
  if (personalBest > 0) {
    pair('Your best', personalBest.toLocaleString(), { star: true })
  }
  prompt('Double or nothing?', true) // the call to action, last

  // Column geometry: widest label + gap + widest value, plus a reserved star slot so every value's
  // number right-aligns to the same edge whether or not it carries the star. The prompt lines are
  // narrower than the table, so the table width sets the centred block.
  ctx.font = boldFont(px)
  let labelW = 0
  let valueW = 0
  let anyStar = false
  for (const r of rows) {
    if (r.pair) {
      labelW = Math.max(labelW, ctx.measureText(r.label).width)
      valueW = Math.max(valueW, ctx.measureText(r.value).width)
      anyStar = anyStar || r.star
    }
  }
  const starSlot = anyStar ? starUnitSpan(px) : 0
  const tableW = labelW + px * STMT_LABEL_VALUE_GAP + valueW + starSlot
  const left = anchorX - tableW / 2
  const numRight = left + labelW + px * STMT_LABEL_VALUE_GAP + valueW // right edge of the number column

  // Vertical: uniform row pitch, with a group gap before the flagged rows. Centred on the band.
  const rowH = px * STMT_LEADING
  const groupGap = px * STMT_GROUP_GAP
  let contentH = 0
  for (const r of rows) {
    contentH += rowH + (r.gapBefore ? groupGap : 0)
  }
  let cursor = bandMid - contentH / 2
  const centers = rows.map((r) => {
    cursor += r.gapBefore ? groupGap : 0
    const c = cursor + rowH / 2
    cursor += rowH
    return c
  })

  rows.forEach((r, i) => {
    const rowAge = age - r.at
    if (rowAge <= 0) {
      return // not yet revealed
    }
    const strikeT = clamp01(rowAge / CODA_STAKE_STRIKE_MS)
    const presence = strikeT * fade
    if (presence <= 0) {
      return
    }
    const popScale = 1 + (1 - strikeT) * (1 - strikeT) // 2×→1× ease-out settle
    const y = centers[i]
    ctx.save()
    ctx.globalAlpha = presence
    ctx.translate(anchorX, y)
    ctx.scale(popScale, popScale)
    ctx.translate(-anchorX, -y)
    ctx.font = boldFont(px)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    drawHoloText(ctx, r.label, left, y, px, CYAN, now, 1)
    if (r.pair) {
      ctx.textAlign = 'right'
      drawHoloText(ctx, r.value, numRight, y, px, r.red ? RED : CYAN, now, r.red ? 1.1 : 1)
      if (r.star) {
        drawStarUnit(ctx, numRight, y, px) // star trails the right-aligned number
      }
    }
    ctx.restore()
  })

  const padX = px * 0.3
  const top = bandMid - contentH / 2
  // clampToNexus: a scoreboard — keep its fan left of the lens (no right-of-nexus spill).
  return [{ left: left - padX, right: numRight + starSlot + padX, top: top - px * 0.4, bottom: top + contentH + px * 0.4, clampToNexus: true }]
}

// Draw one row's holo text (and its trailing star unit, if any) centred on `centerX`, vertically
// centred on `centerY`, in the caller's current transform. A points line carries the star as a
// UNIT after the number: shift the text left so the whole [number · gap · star] group stays
// centred on centerX, then paint the star after it.
function drawStakeLine(ctx: CanvasRenderingContext2D, line: StakeLine, centerX: number, centerY: number, now: number): void {
  ctx.font = boldFont(line.size)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const textW = ctx.measureText(line.text).width
  const rowW = line.starUnit ? textW + starUnitSpan(line.size) : textW
  const textCx = line.starUnit ? centerX - (rowW - textW) / 2 : centerX
  drawHoloText(ctx, line.text, textCx, centerY, line.size, line.style, now, line.glow)
  if (line.starUnit) {
    drawStarUnit(ctx, textCx + textW / 2, centerY, line.size)
  }
}

// Draw one row LEFT-JUSTIFIED: its text starts at `left`, vertically centred on `centerY`, with any
// star trailing the text's right edge. Used by the banker-hand-win prompt so every line shares one
// left margin (vs drawStakeLine's centring).
function drawStakeLineLeft(ctx: CanvasRenderingContext2D, line: StakeLine, left: number, centerY: number, now: number): void {
  ctx.font = boldFont(line.size)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const textW = ctx.measureText(line.text).width
  drawHoloText(ctx, line.text, left, centerY, line.size, line.style, now, line.glow)
  if (line.starUnit) {
    drawStarUnit(ctx, left + textW, centerY, line.size)
  }
}

// The star-unit's proportions, relative to a line's font size: an icon a touch under the number's
// full em, sat a small gap after it. `starUnitSpan` is the horizontal room it claims (gap + star)
// so the number+star group can be centred as one.
const STAR_UNIT_SIZE = 0.82
const STAR_UNIT_GAP = 0.26

function starUnitSpan(px: number): number {
  return px * (STAR_UNIT_GAP + STAR_UNIT_SIZE)
}

// Paint the yellow POINTS star as a trailing UNIT: its left edge sits `gap` past `textRight` (the
// right edge of the number it marks), vertically centred on the number. A no-op until the star
// image has loaded — the coda's render loop never parks, so it pops in on the frame it arrives.
// Drawn inside the caller's presence/pop-scale transform, so it fades + swells in with the number.
function drawStarUnit(ctx: CanvasRenderingContext2D, textRight: number, y: number, px: number): void {
  const img = starImage()
  if (!img) {
    return
  }
  const size = px * STAR_UNIT_SIZE
  const x = textRight + px * STAR_UNIT_GAP // left edge of the star
  ctx.save()
  // A warm gold bloom ties the star to the coda's gold-value theme and the holo glow.
  ctx.shadowColor = 'rgba(255, 205, 90, 0.85)'
  ctx.shadowBlur = size * 0.5
  ctx.drawImage(img, x, y - size / 2, size, size)
  ctx.restore()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
