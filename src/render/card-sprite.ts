// Off-screen card sprites.
//
// Each card face (and the shared back) is rendered once into its own offscreen
// canvas and cached, then blitted to the table. This keeps the per-frame cost
// to a single drawImage and, crucially, makes the reveal flip crisp: we scale
// the finished bitmap horizontally rather than re-laying-out text every frame.

import type { Card, Suit } from '../game/deck'
import { dealerColors, type CardBack } from './palette'
import { drawPcb } from './pcb'
import { createSpriteCanvas } from './sprite-canvas'

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

// The card-back colour every back is drawn with, unless a call passes an explicit
// override. Dealer progression recolours the deck by pointing this at the current
// dealer's palette (see game-view). Callers that draw a back — the deal, the shoe,
// the discard/return/peek flips — need no changes: they pick this up automatically.
let activeBack: CardBack = dealerColors(1, 0).back

export function setCardBack(back: CardBack): void {
  activeBack = back
}

export function activeCardBack(): CardBack {
  return activeBack
}

// Fetch (or build) the sprite for a card face, or the back when card is null. A
// back may be drawn with an explicit palette (`back`) — the cross-fade riffles the
// outgoing deck out and the incoming deck in at once — otherwise it uses the active
// palette. The palette id is folded into the cache key so recolours don't collide.
export function getCardSprite(card: Card | null, cw: number, ch: number, dpr: number, back?: CardBack): CardSprite {
  const palette = back ?? activeBack
  const face = card ? `${card.rank}${card.suit}` : `back:${palette.id}`
  const key = `${face}:${Math.round(cw)}x${Math.round(ch)}@${dpr}`
  let sprite = cache.get(key)
  if (!sprite) {
    if (cache.size > 256) {
      cache.clear() // bound memory across many resizes
    }
    sprite = renderSprite(card, cw, ch, dpr, palette)
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

function renderSprite(card: Card | null, cw: number, ch: number, dpr: number, back: CardBack): CardSprite {
  const padX = cw * 0.14
  const padY = ch * 0.14
  const w = cw + padX * 2
  const h = ch + padY * 2
  const { canvas, ctx } = createSpriteCanvas(Math.round(w * dpr), Math.round(h * dpr))
  ctx.scale(dpr, dpr)

  if (card) {
    drawFace(ctx, padX, padY, cw, ch, card)
  } else {
    drawBack(ctx, padX, padY, cw, ch, back, dpr)
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

function drawBack(ctx: Ctx2D, x: number, y: number, w: number, h: number, back: CardBack, dpr: number): void {
  const radius = w * 0.09

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = h * 0.07
  ctx.shadowOffsetY = h * 0.03
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fillStyle = back.outer
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
  ctx.fillStyle = back.panel
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.lineWidth = 1
  ctx.stroke()

  // A printed-circuit-board pattern fills the panel — its complexity rises with the
  // dealer's `tech`, seeded so every back of a deck is identical. Clipped to the
  // panel so traces/pads don't spill past the rounded inner border.
  ctx.save()
  roundRectPath(ctx, bx, by, bw, bh, radius * 0.7)
  ctx.clip()
  if (back.id === BANKER_BACK_ID) {
    // THE BANKER's deck: the same greebles etched in SHINY GOLD instead of copper. Baked with a
    // soft gold bloom UNDER a crisp second pass, so the paths/pads read as bright polished metal
    // (a static shine — no per-frame glow). The double draw also lifts the faint traces so the
    // whole circuit reads bright, not just the pads.
    const gold = renderGoldGreebles(bw, bh, dpr, back.tech, back.seed)
    ctx.save()
    ctx.shadowColor = GOLD_GLOW
    ctx.shadowBlur = Math.min(bw, bh) * 0.06
    ctx.drawImage(gold, bx, by, bw, bh) // bloom pass (casts the gold halo)
    ctx.shadowBlur = 0
    ctx.drawImage(gold, bx, by, bw, bh) // crisp etch on top
    ctx.restore()
  } else {
    drawPcb(ctx, bx, by, bw, bh, { tech: back.tech, seed: back.seed })
  }
  ctx.restore()
}

// THE BANKER's deck id (see palette.ts BANKER_COLORS.back.id) — the discriminator that
// switches the card back to the gold-greeble + at-rest-glow treatment.
const BANKER_BACK_ID = 'banker'

// The Banker's shiny-gold ramp (reuses BANKER_COLORS' #e3c169, with a brighter crown and a
// deeper foot so the etch reads as polished metal down the card).
const GOLD_HI = '#ffe9a0'
const GOLD_MID = '#f0cf78'
const GOLD_LO = '#d4ad57'
// Baked bloom: a soft gold halo baked UNDER the crisp etch so the greebles read as bright,
// shiny polished metal at rest (a static shine — the old per-frame pulse was removed).
const GOLD_GLOW = 'rgba(255, 226, 150, 0.9)'

// Render the PCB greebles for a bw×bh panel onto a fresh offscreen, then recolour the whole
// etch to GOLD: `source-in` keeps each feature's own alpha (traces faint, pads/chips bright)
// as the gold's brightness, so the board reads as a gold-etched circuit rather than copper.
// A top→bottom gold gradient gives it a metallic sheen. Returned alpha-masked on transparent.
function renderGoldGreebles(bw: number, bh: number, dpr: number, tech: number, seed: number): HTMLCanvasElement {
  const { canvas, ctx } = createSpriteCanvas(Math.round(bw * dpr), Math.round(bh * dpr))
  ctx.scale(dpr, dpr)
  drawPcb(ctx, 0, 0, bw, bh, { tech, seed })
  ctx.globalCompositeOperation = 'source-in' // repaint every drawn pixel gold, keeping its alpha
  const g = ctx.createLinearGradient(0, 0, 0, bh)
  g.addColorStop(0, GOLD_HI)
  g.addColorStop(0.5, GOLD_MID)
  g.addColorStop(1, GOLD_LO)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, bw, bh)
  return canvas
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, radius)
}
