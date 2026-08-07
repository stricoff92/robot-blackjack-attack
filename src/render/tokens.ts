// Reward tokens flying up to the counter: geometry + paint for the bursts that
// TokenAnimation schedules. Mirrors cards.ts / chips.ts — this module owns the
// arc, sizing and drawing; the animator owns timing (the TokenView passed in).
//
// A burst is a small puff of icons that lifts off a source point (the card just
// hit, or a winning hand), arcs up-and-over, and shrinks into the top-left token
// counter. The count itself is credited by the caller as each burst lands.

import { deviceDpr } from './canvas'
import { smoothStart2, smoothStep } from './easing'
import type { Layout } from './scene'
import { createSpriteCanvas } from './sprite-canvas'
import { tokenAspect, tokenImage } from './token-sprite'

export interface Point {
  x: number
  y: number
}

export interface TokenBurst {
  from: Point
  progress: number // 0..1 along the flight
  icons: number // how many sprites make up this burst
  spin: number // fixed 0..1 seed for per-burst rotation/spread variety
}

export interface TokenView {
  isAnimating(now: number): boolean
  bursts(now: number): readonly TokenBurst[]
}

// Flying-token height, scaled to the viewport and a touch smaller than the
// counter's own icon, so arriving tokens read as feeding into it.
function tokenHeight(l: Layout): number {
  return clamp(Math.min(l.width, l.height) * 0.05, 20, 40)
}

// Clear the layer and paint every in-flight burst, all aimed at `target` (the
// counter's centre, in the same CSS-pixel space the layers draw in).
export function drawTokens(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  view: TokenView,
  now: number,
  target: Point,
): void {
  ctx.clearRect(0, 0, l.width, l.height)
  const bursts = view.bursts(now)
  if (bursts.length === 0) {
    return
  }
  const h = tokenHeight(l)
  const w = h * tokenAspect()
  // The shadowed token sprite is baked once (see getTokenSprite); every icon this frame
  // blits it instead of re-running a per-icon shadowBlur (Firefox's slowest canvas op).
  const sprite = getTokenSprite(w, h)
  for (const b of bursts) {
    drawBurst(ctx, b, target, w, h, sprite)
  }
}

const ICON_LAG = 0.05 // per-icon head start, so a burst's sprites trail slightly

function drawBurst(
  ctx: CanvasRenderingContext2D,
  b: TokenBurst,
  target: Point,
  w: number,
  h: number,
  sprite: TokenSprite | null,
): void {
  const { from } = b
  const dist = Math.hypot(target.x - from.x, target.y - from.y)
  const lift = dist * 0.18 // how high the arc bows above the straight line
  const midX = (from.x + target.x) / 2
  const midY = (from.y + target.y) / 2
  const spread = w * 0.9 // sideways fan of the burst's sprites

  for (let i = 0; i < b.icons; i++) {
    const lag = i * ICON_LAG
    const p = clamp01((b.progress - lag) / (1 - lag))
    const e = smoothStep(p)

    // Quadratic arc from `from` to `target`, control point raised above the
    // midpoint and fanned sideways per sprite so the puff isn't a single line.
    const offset = b.icons > 1 ? (i - (b.icons - 1) / 2) * spread : 0
    const cx = midX + offset
    const cy = midY - lift
    const mt = 1 - e
    const x = mt * mt * from.x + 2 * mt * e * cx + e * e * target.x
    const y = mt * mt * from.y + 2 * mt * e * cy + e * e * target.y

    // Shrink into the counter as it lands; fade in at launch, out on arrival (so
    // it's mostly gone before the opaque counter pill would occlude it).
    const scale = 1 - 0.45 * smoothStart2(p)
    const alpha = p < 0.12 ? p / 0.12 : p > 0.85 ? 1 - (p - 0.85) / 0.15 : 1
    const rot = (b.spin - 0.5) * 0.6 + e * (0.5 + b.spin) * (i % 2 === 0 ? 1 : -1)

    drawToken(ctx, x, y, w * scale, h * scale, rot, alpha, sprite)
  }
}

function drawToken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rot: number,
  alpha: number,
  sprite: TokenSprite | null,
): void {
  if (alpha <= 0) {
    return
  }
  ctx.save()
  ctx.globalAlpha = clamp01(alpha)
  ctx.translate(cx, cy)
  ctx.rotate(rot)
  if (sprite) {
    // Blit the pre-shadowed sprite, scaled from its baked base size down to this icon's
    // current size (w shrinks as it lands). The token is centred in the sprite, so the
    // whole padded bitmap is drawn centred on the origin.
    const s = w / sprite.cw
    const dw = sprite.dw * s
    const dh = sprite.dh * s
    ctx.drawImage(sprite.canvas, -dw / 2, -dh / 2, dw, dh)
  } else {
    drawVectorToken(ctx, w, h)
  }
  ctx.restore()
}

// The token image with its soft drop shadow baked in, so the flight loop never runs a
// per-icon shadowBlur. Built once at the unscaled flight size and blitted scaled; keyed
// by that size + dpr, so a resize rebuilds it. Null until the token image has loaded
// (drawToken falls back to the vector coin until then).
interface TokenSprite {
  canvas: HTMLCanvasElement
  cw: number // baked token width (CSS px), the blit's scale reference
  dw: number // full sprite width incl. shadow padding (CSS px)
  dh: number // full sprite height incl. shadow padding (CSS px)
}

let tokenSpriteCache: (TokenSprite & { key: string }) | null = null

function getTokenSprite(w: number, h: number): TokenSprite | null {
  const img = tokenImage()
  if (!img) {
    return null
  }
  const dpr = deviceDpr()
  const key = `${Math.round(h)}@${dpr}`
  if (!tokenSpriteCache || tokenSpriteCache.key !== key) {
    const padX = w * 0.3
    const padY = h * 0.3 // room for the blur (h*0.14) + downward offset (h*0.05)
    const dw = w + padX * 2
    const dh = h + padY * 2
    const { canvas, ctx } = createSpriteCanvas(Math.round(dw * dpr), Math.round(dh * dpr))
    ctx.scale(dpr, dpr)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
    ctx.shadowBlur = h * 0.14
    ctx.shadowOffsetY = h * 0.05
    ctx.drawImage(img, padX, padY, w, h)
    tokenSpriteCache = { canvas, cw: w, dw, dh, key }
  }
  return tokenSpriteCache
}

// Fallback token (a small gold coin) shown only until power.png loads.
function drawVectorToken(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = Math.min(w, h) / 2
  const body = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r)
  body.addColorStop(0, '#ffe6a3')
  body.addColorStop(0.6, '#e8b64a')
  body.addColorStop(1, '#a9761f')
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = body
  ctx.fill()
  ctx.lineWidth = Math.max(1, r * 0.12)
  ctx.strokeStyle = 'rgba(90, 60, 10, 0.7)'
  ctx.stroke()
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
