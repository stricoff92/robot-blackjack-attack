// The BANKER SCOREBOARD (docs/scoreboards.md): the double-or-nothing CODA offer. When the
// endgame stake is on the line, the table nexus projects the player's current score onto the
// middle of the felt as holo text — the "POINTS AT RISK", the pot they're gambling on the final
// hand. Render-only, a near-clone of combo-projection: the game hands over the points at stake
// and this paints them as projected light, returning their box so the holo lens fans rays onto it.
//
// Both looks share one row order (docs/scoreboards.md): "The banker says:" / the big lavender stake
// number / "Double or nothing?" / the best-score line last. They differ only in justification,
// keyed on `wonHand`:
//   • VICTORY banker scoreboard (wonHand = false) — the entry offer after beating all 6 dealers.
//     A CENTRED holo block; the whole block pops in as one.
//   • BANKER-HAND PLAYER VICTORY scoreboard (wonHand = true) — shown after the player WINS a coda
//     hand (in either coda). Same holo block, but LEFT-JUSTIFIED and sat slightly left of centre.
//     The game plays a slow hand-clap sfx as it appears.
// The run-over summary is a DIFFERENT board — the "final scoreboard" (render/score-sheet.ts).

import { drawHoloText, handBand, type HoloTextStyle } from './cards'
import type { HoloRayTarget } from './nexus'
import type { Layout } from './scene'
import { starImage } from './star-sprite'

// How long the projection takes to fade + scale fully in (the 2×→1× pop settles over this).
// In the staged (bankruptcy) panel this is the per-ROW strike window; it's exported so game-view
// can time the top-right counter's gross→net tick to the moment the Net row lands.
export const CODA_STAKE_STRIKE_MS = 300

// The one holo tone the panels are built from — a soft cyan glow over a translucent core. The
// VICTORY board draws its whole prompt in it.
const CYAN: HoloTextStyle = { glow: 'rgba(130, 240, 236, 0.95)', bloom: 'rgba(150, 246, 242, 0.55)', core: 'rgba(214, 253, 251, 0.9)' }
// The victory stake NUMBER stands apart from the cyan prompt: a bright near-white lavender core
// over a dense BLACK halo, drawn larger than the prompt lines (see numberPx) — the pot reads as the
// hot value being gambled and stays legible against the felt.
const PURPLE: HoloTextStyle = { glow: 'rgba(0, 0, 0, 1)', bloom: 'rgba(0, 0, 0, 0.8)', core: 'rgba(228, 216, 255, 1)' }

// Shift the left-justified banker-hand-win prompt this far (× felt scale) left of centre, so it
// reads as a document rather than a dead-centre banner.
const CODA_LEFT_SHIFT = 0.08

// One line of the VICTORY / between-hands prompt (the centred block).
interface StakeLine {
  text: string
  style: HoloTextStyle
  size: number
  glow: number
  starUnit?: boolean
  // Extra vertical margin ABOVE this row (px), on top of the normal `leading` slot — used to set
  // the "Your best" high-score line apart from the offer above it.
  gapBefore?: number
}

function boldFont(px: number, weight = 800): string {
  return `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
}

// Draw the double-or-nothing banker scoreboard and RETURN its box (one ray-target). `age` = ms
// since it appeared (strike-in), `fade` winds it out, `now` positions the shared holo flicker.
// `wonHand` picks the look: false = the centred VICTORY entry offer; true = the LEFT-JUSTIFIED
// banker-hand-win prompt (offer last).
export function drawCodaStake(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  points: number,
  wonHand: boolean,
  personalBest: number,
  age: number,
  fade: number,
  now: number,
): HoloRayTarget[] {
  const l = layout
  // Centre of the felt: the clear band between the two hand counts, horizontally centred.
  const bandMid = handBand(l).center
  const cx = l.width / 2

  const scale = Math.min(l.width, l.height)
  const px = clamp(scale * 0.03, 17, 32)

  // VICTORY entry offer / banker-hand-win prompt. The stake NUMBER reads 30% larger than the cyan
  // prompt lines, with a wider + denser glow (NUMBER_GLOW), so the pot at risk is easiest to read.
  const numberPx = px * 1.3
  const NUMBER_GLOW = 1.35
  // Use the ROLLING counter value so on a win the projected stake ticks up to the doubled total in
  // lockstep with the HUD; locale-grouped (thousands separators per the runtime locale).
  const stake = points.toLocaleString()

  // `starUnit: true` trails a line with the yellow POINTS star as a UNIT after the number. Both
  // looks share one row order: the stake (point score) leads straight after the banker's line, then
  // the "Double or nothing?" call to action, then the best-score line last. `wonHand` only changes
  // the justification/anchor below, not the rows.
  const lines: StakeLine[] = []
  lines.push({ text: 'The banker says:', style: CYAN, size: px, glow: 1 })
  lines.push({ text: stake, style: PURPLE, size: numberPx, glow: NUMBER_GLOW, starUnit: true })
  lines.push({ text: 'Double or nothing?', style: CYAN, size: px, glow: 1 })
  // The player's personal best — the "score to beat" — sits LAST as a smaller cyan line so they can
  // weigh the gamble against their record, set apart from the offer by an extra `gapBefore` margin.
  // Skipped for first-timers (best 0), and (like the stake) locale-grouped. CrazyGames leaderboards
  // are submit-only, so this is our own tracked best, not a global read (see src/game/leaderboard.ts).
  if (personalBest > 0) {
    lines.push({ text: `Your best ${personalBest.toLocaleString()}`, style: CYAN, size: px * 0.85, glow: 1, starUnit: true, gapBefore: px * 0.7 })
  }

  // Stack the lines in per-line vertical slots (each `size · leading`) rather than one uniform gap,
  // so the taller stake number claims its own room and the block stays centred on the felt band
  // whatever the mix of sizes. `centers[i]` is line i's middle baseline.
  const leading = 1.5
  const slots = lines.map((line) => line.size * leading)
  const gaps = lines.map((line) => line.gapBefore ?? 0)
  const totalH = slots.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0)
  let cursor = bandMid - totalH / 2
  const centers = slots.map((h, i) => {
    cursor += gaps[i]
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
