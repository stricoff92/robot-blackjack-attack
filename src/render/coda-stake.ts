// The double-or-nothing CODA: when the endgame stake is on the line, the table nexus
// projects the player's current score onto the middle of the felt as holo text — the
// "POINTS AT RISK", the pot they're gambling on the final hand. Render-only, a near-clone
// of combo-projection: the game hands over the points at stake and this paints them as
// projected light, returning their box so the holo lens fans rays onto it.

import { dealerCountAnchor, drawHoloText, playerCountAnchor, type HoloTextStyle } from './cards'
import type { HoloRayTarget } from './nexus'
import type { Layout } from './scene'

// How long the projection takes to fade + scale fully in (the 2×→1× pop settles over this).
const CODA_STAKE_STRIKE_MS = 300

const CYAN: HoloTextStyle = { glow: 'rgba(130, 240, 236, 0.95)', bloom: 'rgba(150, 246, 242, 0.55)', core: 'rgba(214, 253, 251, 0.9)' }
// The stake NUMBER stands apart from the cyan prompt: a bright near-white lavender core over a
// dense BLACK halo, drawn larger than the prompt lines (see numberPx) — the pot reads as the hot
// value being gambled and stays legible against the felt. The strong dark halo is what lets the
// core go this bright: a whiter core over a fuller, wider black glow reads far clearer than the
// old dimmer purple (which was hard to make out).
const PURPLE: HoloTextStyle = { glow: 'rgba(0, 0, 0, 1)', bloom: 'rgba(0, 0, 0, 0.8)', core: 'rgba(228, 216, 255, 1)' }

function boldFont(px: number, weight = 800): string {
  return `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
}

// Draw the points-at-risk stake and RETURN its box (one ray-target). `age` = ms since it
// appeared (strike-in), `fade` winds it out, `now` positions the shared holo flicker.
export function drawCodaStake(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  points: number,
  congrats: string | null,
  personalBest: number,
  age: number,
  fade: number,
  now: number,
): HoloRayTarget[] {
  const l = layout
  // Centre of the felt: the clear band between the two hand counts, horizontally centred.
  const dc = dealerCountAnchor(l)
  const pc = playerCountAnchor(l, 1, 0)
  const bandMid = (dc.y + pc.y) / 2
  const cx = l.width / 2

  const scale = Math.min(l.width, l.height)
  const px = clamp(scale * 0.03, 17, 32)
  // The stake NUMBER reads 30% larger than the cyan prompt lines, with a wider + denser glow
  // (NUMBER_GLOW), so the pot at risk — the whole point of the coda — is the easiest thing to read.
  const numberPx = px * 1.3
  const NUMBER_GLOW = 1.35

  // After a WIN the Banker congratulates the player over the (now doubled) stake; the plain
  // prompt just names it. `points` is the live rolling counter value, so the number climbs to
  // the doubled total. The stake number is its OWN line (purple + bigger), and — unlike the raw
  // HUD score — it's locale-grouped (thousands separators: "," or "." per the runtime locale).
  const stake = points.toLocaleString()
  const lines: { text: string; style: HoloTextStyle; size: number; glow: number }[] = congrats
    ? [
        { text: 'The banker says:', style: CYAN, size: px, glow: 1 },
        { text: congrats, style: CYAN, size: px, glow: 1 },
        { text: stake, style: PURPLE, size: numberPx, glow: NUMBER_GLOW },
        { text: 'Double or nothing?', style: CYAN, size: px, glow: 1 },
      ]
    : [
        { text: 'The banker says:', style: CYAN, size: px, glow: 1 },
        { text: 'Double or nothing?', style: CYAN, size: px, glow: 1 },
        { text: stake, style: PURPLE, size: numberPx, glow: NUMBER_GLOW },
      ]

  // The player's personal best — the "score to beat" — sits below the stake as a smaller cyan
  // line so they can weigh the gamble against their record. Skipped for first-timers (best 0), and
  // (like the stake) locale-grouped. CrazyGames leaderboards are submit-only, so this is our own
  // tracked best, not a global read (see src/game/leaderboard.ts).
  if (personalBest > 0) {
    lines.push({ text: `Your best ${personalBest.toLocaleString()}`, style: CYAN, size: px * 0.85, glow: 1 })
  }

  const strikeT = clamp01(age / CODA_STAKE_STRIKE_MS)
  const presence = strikeT * fade
  // Scale-in pop: 2× → 1× as it fades in (ease-out settle), then holds through the fade-out.
  const popScale = 1 + (1 - strikeT) * (1 - strikeT)

  // Stack the lines in per-line vertical slots (each `size · leading`) rather than one uniform
  // gap, so the taller stake number claims its own room and the block stays centred on the felt
  // band whatever the mix of sizes. `centers[i]` is line i's baseline (textBaseline is middle).
  const leading = 1.5
  const slots = lines.map((line) => line.size * leading)
  const totalH = slots.reduce((a, b) => a + b, 0)
  let cursor = bandMid - totalH / 2
  const centers = slots.map((h) => {
    const c = cursor + h / 2
    cursor += h
    return c
  })

  ctx.save()
  ctx.globalAlpha = presence
  ctx.translate(cx, bandMid)
  ctx.scale(popScale, popScale)
  ctx.translate(-cx, -bandMid)

  let maxW = 0
  lines.forEach((line, i) => {
    ctx.font = boldFont(line.size) // measure at this line's own size (the number is wider)
    maxW = Math.max(maxW, ctx.measureText(line.text).width)
    holoCentered(ctx, line.text, cx, centers[i], line.size, line.style, line.glow, now)
  })

  ctx.restore()

  const halfW = maxW / 2 + px * 0.2
  const halfH = totalH / 2 + px * 0.4
  return [{ left: cx - halfW, right: cx + halfW, top: bandMid - halfH, bottom: bandMid + halfH }]
}

// Draw centred holo text (sets font/alignment, then blits the cached glow sprite). `glowScale`
// widens/strengthens the glow halo for a label that needs to read stronger (the stake number).
function holoCentered(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, px: number, style: HoloTextStyle, glowScale: number, now: number): void {
  ctx.font = boldFont(px)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  drawHoloText(ctx, text, cx, y, px, style, now, glowScale)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
