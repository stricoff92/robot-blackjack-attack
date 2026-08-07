// The table nexus projects the COMBO multiplier into the middle of the felt as holo text on
// each HIT: 'up' (a surviving hit grew the combo — ticks up, cyan) or 'down' (a bust reset
// it — ticks back to ×1.00, red). Hand-end points are NOT projected (they read as chips);
// they show as the top-right delta instead. Render-only, like spec-sheet / score-sheet: the
// game hands over a ComboProjection (the already-ticked multiplier + tone) and this paints
// it as projected light, returning its box so the holo lens fans rays onto it.

import { dealerCountAnchor, drawHoloText, playerCountAnchor, type HoloTextStyle } from './cards'
import type { HoloRayTarget } from './nexus'
import type { Layout } from './scene'

// How long the projection takes to fade + scale fully in (the 2×→1× pop settles over this).
export const COMBO_PROJ_STRIKE_MS = 300

export interface ComboProjection {
  /** The multiplier to show this frame (already interpolated toward its target). */
  mult: number
  tone: 'up' | 'down'
}

const CYAN: HoloTextStyle = { glow: 'rgba(130, 240, 236, 0.95)', bloom: 'rgba(150, 246, 242, 0.55)', core: 'rgba(214, 253, 251, 0.9)' }
const RED: HoloTextStyle = { glow: 'rgba(255, 120, 104, 0.95)', bloom: 'rgba(255, 138, 120, 0.55)', core: 'rgba(255, 216, 208, 0.9)' }

function boldFont(px: number, weight = 800): string {
  return `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
}

// Draw the combo projection and RETURN its box (one ray-target). `age` = ms since it
// appeared (strike-in), `fade` winds it out, `now` positions the shared holo flicker.
export function drawComboProjection(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  proj: ComboProjection,
  age: number,
  fade: number,
  now: number,
): HoloRayTarget[] {
  // Centre of the felt: the clear band between the two hand counts (the same band the
  // other readouts use), horizontally centred.
  const dc = dealerCountAnchor(l)
  const pc = playerCountAnchor(l, 1, 0)
  const bandMid = (dc.y + pc.y) / 2
  const cx = l.width / 2

  const scale = Math.min(l.width, l.height)
  const px = clamp(scale * 0.036, 20, 40)

  const bust = proj.tone === 'down'
  const style = bust ? RED : CYAN
  const multText = `×${proj.mult.toFixed(2)}`
  const strikeT = clamp01(age / COMBO_PROJ_STRIKE_MS)
  const presence = strikeT * fade
  // Scale-in pop: the text springs from 2× down to 1× as it fades in (ease-out settle),
  // then holds at 1× through the hold + fade-out.
  const popScale = 1 + (1 - strikeT) * (1 - strikeT)

  ctx.save()
  ctx.globalAlpha = presence
  // Scale about the projection's centre so the pop grows/shrinks in place.
  ctx.translate(cx, bandMid)
  ctx.scale(popScale, popScale)
  ctx.translate(-cx, -bandMid)

  // Measure the multiplier so the ray box hugs it.
  ctx.font = boldFont(px)
  const textW = ctx.measureText(multText).width

  if (bust) {
    // A bust wiped the combo: a small red "RESET" label over the ×1.00 it's ticking to.
    const resetPx = px * 0.62
    holoCentered(ctx, 'RESET', cx, bandMid - px * 0.6, resetPx, RED, now)
    holoCentered(ctx, multText, cx, bandMid + resetPx * 0.5, px, style, now)
  } else {
    holoCentered(ctx, multText, cx, bandMid, px, style, now)
  }

  ctx.restore()

  const halfW = textW / 2 + px * 0.15
  const halfH = bust ? px * 1.35 : px * 0.9
  return [{ left: cx - halfW, right: cx + halfW, top: bandMid - halfH, bottom: bandMid + halfH }]
}

// Draw centred holo text (sets font/alignment, then blits the cached glow sprite).
function holoCentered(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, px: number, style: HoloTextStyle, now: number): void {
  ctx.font = boldFont(px)
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
