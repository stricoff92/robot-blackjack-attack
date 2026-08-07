// Off-screen holo-text sprites.
//
// drawHoloText's glow is two shadowBlur fillText passes — shadowBlur being the most
// expensive 2D-canvas op — and the very same labels (hand/dealer counts, the
// bet/winnings/bankroll chip counts, the Analyze rows) are repainted every frame. So
// we render each label's glow ONCE into an offscreen canvas and blit it; the per-frame
// cost drops to a single drawImage. The live holoFlicker pulse is reapplied as the
// blit's globalAlpha, so the projection looks exactly as before. Mirrors the
// card-sprite cache: build-once, blit-many, bounded Map.

import type { HoloTextStyle } from './cards'
import { createSpriteCanvas } from './sprite-canvas'

export interface GlowLabelSprite {
  canvas: HTMLCanvasElement
  cw: number // sprite width in CSS px
  ch: number // sprite height in CSS px
  anchorX: number // where the text's pen point (x) sits inside the sprite, CSS px
  anchorY: number // where the text's pen point (y) sits inside the sprite, CSS px
}

const cache = new Map<string, GlowLabelSprite>()

// Fetch (or build) the glow sprite for a label. Everything that changes the pixels —
// text, font, the three glow colours, and the caller's alignment/baseline/dpr — folds
// into the key, so distinct call sites never collide and a moving label reuses one
// sprite frame to frame.
export function getGlowLabelSprite(
  text: string,
  font: string,
  size: number,
  style: HoloTextStyle,
  align: CanvasTextAlign,
  baseline: CanvasTextBaseline,
  dpr: number,
): GlowLabelSprite {
  const key = `${text}|${font}|${align}|${baseline}|${style.glow}|${style.bloom}|${style.core}|${dpr}`
  let sprite = cache.get(key)
  if (!sprite) {
    if (cache.size > 512) {
      cache.clear() // bound memory — a run scrolls through many distinct counts/labels
    }
    sprite = renderGlowLabel(text, font, size, style, align, baseline, dpr)
    cache.set(key, sprite)
  }
  return sprite
}

// Blit a label sprite so its baked pen point lands exactly where fillText(text, x, y)
// would have drawn it. `alpha` carries the caller's globalAlpha × the holoFlicker pulse.
export function blitGlowLabel(
  ctx: CanvasRenderingContext2D,
  sprite: GlowLabelSprite,
  x: number,
  y: number,
  alpha: number,
): void {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.drawImage(sprite.canvas, x - sprite.anchorX, y - sprite.anchorY, sprite.cw, sprite.ch)
  ctx.restore()
}

function renderGlowLabel(
  text: string,
  font: string,
  size: number,
  style: HoloTextStyle,
  align: CanvasTextAlign,
  baseline: CanvasTextBaseline,
  dpr: number,
): GlowLabelSprite {
  const advance = measureAdvance(text, font)

  // The glyph ink sits at a fixed offset from the pen point for a given font +
  // alignment + baseline. We bake with those SAME settings at an internal anchor, then
  // blit anchor→(x, y), so the ink lands identically for any alignment. The box below
  // just has to be big enough to hold the ink plus the glow blur — extra room is only
  // transparent pixels, so the estimates are deliberately generous.
  const fontHeight = size * 1.3
  const blurMargin = size * 0.7 // shadowBlur peaks at size * 0.5
  const [inkLeft, inkRight] = horizontalInk(align, advance)
  const [inkTop, inkBottom] = verticalInk(baseline, fontHeight)
  const left = inkLeft - blurMargin
  const top = inkTop - blurMargin
  const cw = inkRight + blurMargin - left
  const ch = inkBottom + blurMargin - top
  const anchorX = -left
  const anchorY = -top

  const { canvas, ctx } = createSpriteCanvas(Math.round(cw * dpr), Math.round(ch * dpr))
  ctx.scale(dpr, dpr)
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = baseline

  // The same two translucent passes drawHoloText used — a soft glow bloom, then a
  // brighter but still translucent core — baked at full opacity (the flicker is applied
  // at blit time).
  ctx.shadowColor = style.glow
  ctx.shadowBlur = size * 0.5
  ctx.fillStyle = style.bloom
  ctx.fillText(text, anchorX, anchorY)
  ctx.shadowBlur = size * 0.14
  ctx.fillStyle = style.core
  ctx.fillText(text, anchorX, anchorY)

  return { canvas, cw, ch, anchorX, anchorY }
}

// The glyph ink's horizontal span relative to the pen, given the advance width.
function horizontalInk(align: CanvasTextAlign, w: number): [number, number] {
  switch (align) {
    case 'center':
      return [-w / 2, w / 2]
    case 'right':
    case 'end':
      return [-w, 0]
    default: // 'left' / 'start'
      return [0, w]
  }
}

// The glyph ink's vertical span relative to the pen, given a font-height estimate.
function verticalInk(baseline: CanvasTextBaseline, fontHeight: number): [number, number] {
  switch (baseline) {
    case 'top':
    case 'hanging':
      return [0, fontHeight]
    case 'middle':
      return [-fontHeight / 2, fontHeight / 2]
    case 'bottom':
    case 'ideographic':
      return [-fontHeight, 0]
    default: // 'alphabetic'
      return [-fontHeight * 0.8, fontHeight * 0.2]
  }
}

// One reusable 1×1 context for advance-width measurement, so building a sprite doesn't
// allocate a canvas just to measure.
let measureCtx: CanvasRenderingContext2D | null = null
function measureAdvance(text: string, font: string): number {
  if (!measureCtx) {
    measureCtx = createSpriteCanvas(1, 1).ctx
  }
  measureCtx.font = font
  return measureCtx.measureText(text).width
}
