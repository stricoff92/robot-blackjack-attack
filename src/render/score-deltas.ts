// The fly-in SCORE DELTAS: geometry + paint for the "+N" texts that ScoreDeltaFly schedules. Each
// launches from a winning green check in the hand-summary, arcs up-and-over to a stacked row below
// the top-right score counter, then holds in an ascending list until the next hand fades it. Mirrors
// render/tokens.ts — this module owns the arc + drawing, the animator (ui) owns the timing.

import { smoothStep } from './easing'
import type { Layout } from './scene'
import type { Point } from './tokens'

// A delta's flight time and the settled list's fade-out — owned here (render timing) and imported by
// the animator so the two never drift. (TTL bumped ~30% for a slower, more readable arc.)
export const DELTA_FLY_MS = 676
export const DELTA_FADE_MS = 338

interface FlightLike {
  value: number
  from: Point
  rowIndex: number
  launchAt: number
  landAt: number
}

export interface ScoreDeltaView {
  flights(): readonly FlightLike[]
  clearAt(): number
}

// Bright mint green (tied to the green checks it flies from) over a dark halo, so it reads over the
// felt and the holo readouts.
const CORE = 'rgba(190, 255, 214, 1)'
const GLOW = 'rgba(73, 178, 106, 0.9)'
const HALO = 'rgba(0, 0, 0, 0.85)'

// Paint every delta this frame: those in the air arc from their check to their row; those landed sit
// in the stack (fading once cleared). `target` is where row 0 sits (just below the counter), each
// later row a line lower — an ascending list. Same CSS-pixel space the other layers draw in.
export function drawScoreDeltas(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  view: ScoreDeltaView,
  now: number,
  target: Point,
): void {
  ctx.clearRect(0, 0, layout.width, layout.height)
  const flights = view.flights()
  if (flights.length === 0) {
    return
  }
  const clearAt = view.clearAt()
  const fontPx = clamp(Math.min(layout.width, layout.height) * 0.03, 15, 28)
  const rowH = fontPx * 1.2
  ctx.save()
  // Right-anchored to the counter's right edge (it lives at the screen's top-right), so wide late-
  // game "+N"s grow leftward instead of clipping off-screen.
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const f of flights) {
    if (now < f.launchAt) {
      continue
    }
    const landX = target.x
    const landY = target.y + f.rowIndex * rowH
    let x: number
    let y: number
    let alpha: number
    let px: number
    if (now < f.landAt) {
      // In the air: a quadratic arc bowed above the straight line, starting a touch large and
      // settling to size, fading in off the launch.
      const p = clamp01((now - f.launchAt) / DELTA_FLY_MS)
      const e = smoothStep(p)
      const lift = Math.hypot(landX - f.from.x, landY - f.from.y) * 0.16
      const cx = (f.from.x + landX) / 2
      const cy = (f.from.y + landY) / 2 - lift
      const mt = 1 - e
      x = mt * mt * f.from.x + 2 * mt * e * cx + e * e * landX
      y = mt * mt * f.from.y + 2 * mt * e * cy + e * e * landY
      alpha = p < 0.14 ? p / 0.14 : 1
      px = fontPx * (1.35 - 0.35 * e)
    } else {
      // Landed: sit in the row; fade the whole list once the next hand is called.
      x = landX
      y = landY
      px = fontPx
      alpha = clearAt > 0 ? clamp01(1 - (now - clearAt) / DELTA_FADE_MS) : 1
    }
    if (alpha <= 0) {
      continue
    }
    drawDelta(ctx, `+${f.value.toLocaleString()}`, x, y, px, alpha)
  }
  ctx.restore()
}

function drawDelta(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, alpha: number): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `800 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`
  // Dark halo first (a couple of offset strokes' worth via shadow), then the glowing green core.
  ctx.shadowColor = HALO
  ctx.shadowBlur = px * 0.5
  ctx.fillStyle = HALO
  ctx.fillText(text, x, y)
  ctx.shadowColor = GLOW
  ctx.shadowBlur = px * 0.6
  ctx.fillStyle = CORE
  ctx.fillText(text, x, y)
  ctx.restore()
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
