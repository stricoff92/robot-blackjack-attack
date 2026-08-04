// Off-screen card sprites.
//
// Each card face (and the shared back) is rendered once into its own offscreen
// canvas and cached, then blitted to the table. This keeps the per-frame cost
// to a single drawImage and, crucially, makes the reveal flip crisp: we scale
// the finished bitmap horizontally rather than re-laying-out text every frame.

import type { Card, Suit } from '../game/deck'

type SpriteCanvas = HTMLCanvasElement | OffscreenCanvas
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface CardSprite {
  canvas: SpriteCanvas
  cw: number // card width in CSS px
  ch: number // card height in CSS px
  padX: number // shadow padding baked into the sprite, CSS px
  padY: number
}

const SUIT_SYMBOLS: Record<Suit, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
}

const cache = new Map<string, CardSprite>()

// Fetch (or build) the sprite for a card face, or the back when card is null.
export function getCardSprite(card: Card | null, cw: number, ch: number, dpr: number): CardSprite {
  const face = card ? `${card.rank}${card.suit}` : 'back'
  const key = `${face}:${Math.round(cw)}x${Math.round(ch)}@${dpr}`
  let sprite = cache.get(key)
  if (!sprite) {
    if (cache.size > 256) {
      cache.clear() // bound memory across many resizes
    }
    sprite = renderSprite(card, cw, ch, dpr)
    cache.set(key, sprite)
  }
  return sprite
}

// Blit a sprite so its card body's top-left lands at (x, y). scaleX < 1
// squeezes it horizontally about its center — the flip.
export function blitCard(ctx: CanvasRenderingContext2D, sprite: CardSprite, x: number, y: number, scaleX = 1): void {
  const drawW = sprite.cw + sprite.padX * 2
  const drawH = sprite.ch + sprite.padY * 2
  const dx = x - sprite.padX
  const dy = y - sprite.padY

  if (scaleX >= 0.999) {
    ctx.drawImage(sprite.canvas, dx, dy, drawW, drawH)
    return
  }

  const cx = x + sprite.cw / 2
  ctx.save()
  ctx.translate(cx, 0)
  ctx.scale(Math.max(scaleX, 0.0001), 1)
  ctx.translate(-cx, 0)
  ctx.drawImage(sprite.canvas, dx, dy, drawW, drawH)
  ctx.restore()
}

function renderSprite(card: Card | null, cw: number, ch: number, dpr: number): CardSprite {
  const padX = cw * 0.14
  const padY = ch * 0.14
  const w = cw + padX * 2
  const h = ch + padY * 2
  const { canvas, ctx } = createOffscreen(Math.round(w * dpr), Math.round(h * dpr))
  ctx.scale(dpr, dpr)

  if (card) {
    drawFace(ctx, padX, padY, cw, ch, card)
  } else {
    drawBack(ctx, padX, padY, cw, ch)
  }

  return { canvas, cw, ch, padX, padY }
}

function drawFace(ctx: Ctx2D, x: number, y: number, w: number, h: number, card: Card): void {
  const radius = w * 0.09

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = h * 0.07
  ctx.shadowOffsetY = h * 0.03
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fillStyle = '#f6f2e7'
  ctx.fill()
  ctx.restore()

  roundRectPath(ctx, x, y, w, h, radius)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.stroke()

  const red = card.suit === 'hearts' || card.suit === 'diamonds'
  ctx.fillStyle = red ? '#c0392b' : '#1b1b1b'
  const suit = SUIT_SYMBOLS[card.suit]

  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = `bold ${h * 0.2}px system-ui, sans-serif`
  ctx.fillText(card.rank, x + w * 0.1, y + h * 0.07)
  ctx.font = `${h * 0.15}px serif`
  ctx.fillText(suit, x + w * 0.1, y + h * 0.28)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${h * 0.42}px serif`
  ctx.fillText(suit, x + w * 0.5, y + h * 0.56)
}

function drawBack(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
  const radius = w * 0.09

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = h * 0.07
  ctx.shadowOffsetY = h * 0.03
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fillStyle = '#1f356b'
  ctx.fill()
  ctx.restore()

  roundRectPath(ctx, x, y, w, h, radius)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.stroke()

  const inset = w * 0.1
  const bx = x + inset
  const by = y + inset
  const bw = w - inset * 2
  const bh = h - inset * 2

  roundRectPath(ctx, bx, by, bw, bh, radius * 0.7)
  ctx.fillStyle = '#2c4d92'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.save()
  roundRectPath(ctx, bx, by, bw, bh, radius * 0.7)
  ctx.clip()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  const step = w * 0.2
  for (let i = -bh; i < bw + bh; i += step) {
    ctx.moveTo(bx + i, by)
    ctx.lineTo(bx + i + bh, by + bh)
    ctx.moveTo(bx + i, by + bh)
    ctx.lineTo(bx + i + bh, by)
  }
  ctx.stroke()
  ctx.restore()
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, radius)
}

function createOffscreen(w: number, h: number): { canvas: SpriteCanvas; ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('offscreen 2d context unavailable')
    }
    return { canvas, ctx }
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2d context unavailable')
  }
  return { canvas, ctx }
}
