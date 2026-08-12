// The Banker coda's WINNINGS COUNTERS: crystal award markers on a metal base that make
// the double-or-nothing pot physical. A casino banker marks a stake with matching glass
// markers, and COLOURS UP when they pile up — trading a rack of low markers for one of a
// higher denomination. Same here: the pot is 2^wins, which decomposes into `perTier`
// markers (1/2/4/8) of a `tier`, each tier worth 16× the last. So the felt never holds
// more than 8, and every 4th win FUSES eight markers into one grander, higher-denomination
// crystal (clear glass → aqua → gold → violet → ruby). count × base == the holo's total.
//
// Render + geometry only (mirrors chips.ts / tokens.ts): the CodaCounterAnimation owns
// timing and hands us a per-marker motion frame; we lay out the grid (sized by tier) and
// paint. Each distinct (size, tier, value) marker is baked into a cached sprite + blitted.

import { deviceDpr } from './canvas'
import { smoothEnd3, smoothStart2, smoothStep } from './easing'
import { actionBarReserve, cardSize, playerRow } from './cards'
import type { Point } from './tokens'
import { dealerBox, type Layout } from './scene'
import { createSpriteCanvas } from './sprite-canvas'

// How a marker moves this frame (from the animator); `p` (0..1) is its progress.
//   rest    — settled at its slot
//   form    — materialise in place (the entry reveal)
//   flyIn   — a matching marker arrives from the banker (a within-tier win)
//   reflow  — an existing marker shuffles to the re-laid-out grid
//   fuseOut — a colour-up: the old-tier markers converge on the new marker's spot + vanish
//   fuseIn  — a colour-up: the new higher-tier marker blooms at the centre
//   flyOut  — a bust: the marker flies back to the banker
//   fade    — a cash-out: the marker dissolves in place
export type CrystalMotion = 'rest' | 'form' | 'flyIn' | 'reflow' | 'fuseOut' | 'fuseIn' | 'flyOut' | 'fade'

export interface CrystalMarker {
  motion: CrystalMotion
  p: number
  slot: number // index within its layout group
  count: number // its layout group size (the grid it belongs to)
  tier: number // denomination tier — drives look, value (16^tier · base) and size
  fromCount: number // the grid a reflowing marker slides FROM
}

export interface CodaCounterView {
  markers: CrystalMarker[]
}

// Marker proportions, relative to the felt's card height. Kept SMALL — just big enough for
// the number to read — with a metal plinth under the crystal. Higher tiers grow modestly.
const BODY_W_OVER_CARD_H = 0.5
const BODY_H_OVER_W = 0.82
const BASE_W_OVER_BODY = 1.16
const BASE_H_OVER_BODY = 0.3
const GAP_OVER_W = 0.3 // natural horizontal gap between markers
const MAX_COLS = 4 // 8 markers form 2 ROWS OF 4, never one long row
const PAD_OVER_W = 0.3 // sprite margin — room for the marker's drop shadow
const BOTTOM_MARGIN = 10 // gap kept above the HTML action bar
const HORIZ_BUDGET = 0.9 // max fraction of the felt width a row may span (tightened only if huge)
// How much the rows' GLASS bodies overlap vertically (fraction of the crystal-body height): the
// front row tucks up over the back one by this much. Measured on the glass, not the base+glass
// footprint.
const GLASS_OVERLAP = 0.33
const TIER_GROWTH = 0.14 // each tier is this much larger (capped a few tiers up)
const TIER_MULT = 16 // one marker of tier t is worth 16^t base units (fill-to-8 colour-up)
// The vertical gap kept between the player-card row above and the top of a full two-row pot.
const FIT_GAP = 6
// A uniform per-tier shrink (fitScale) never drops a marker below this fraction of full size — on an
// extreme short viewport it's better for the pot to kiss the cards than become an unreadable speck.
const FIT_FLOOR = 0.62

interface Dims {
  bodyW: number
  bodyH: number
  baseW: number
  baseH: number
  overlap: number
  w: number // assembly footprint width (== base width)
  h: number // assembly footprint height (crystal + base − overlap)
}

function tierScale(tier: number): number {
  return 1 + TIER_GROWTH * Math.min(tier, 4)
}

// A UNIFORM shrink applied to every marker of a tier so a FULL two-row pot (up to 8 markers = 2 rows
// of 4) clears the player-card row above it, even where the usable height is short (Safari's URL +
// menu bars eat ~110px on an iPhone SE). Keyed on the LAYOUT + TIER ONLY — never the live marker
// count — so a tier's markers are always the SAME size whether the pot currently shows 1 or 8; the
// size never jumps as the pot fills within a tier (the "don't shrink 8-to-fit-the-count" rule the
// two-rows-of-4 layout was built for). Returns 1.0 (full size) whenever the two rows already fit —
// which, thanks to the lifted cards + reclaimed action-bar band, they do at an iPhone SE's real
// Safari height — so this only bites on a genuinely tiny viewport, and even then no lower than
// FIT_FLOOR. Sizing for TWO rows regardless of the current count is what keeps the size stable.
function fitScale(l: Layout, tier: number): number {
  const { h: cardH } = cardSize(l)
  const s = tierScale(tier)
  // Natural (unshrunk) two-row grid height for this tier — mirrors crystalDims + codaCounterGrid.
  const bodyH = cardH * BODY_W_OVER_CARD_H * s * BODY_H_OVER_W
  const baseH = bodyH * BASE_H_OVER_BODY
  const footprintH = bodyH + baseH - baseH * 0.4
  const twoRowH = bodyH * (1 - GLASS_OVERLAP) + footprintH
  // Room between the player cards' bottom edge and the top of the action-bar band.
  const cardBottom = l.edgeY + (l.height - l.edgeY) * playerRow(l) + cardH
  const bandBottom = l.height - actionBarReserve(l) - BOTTOM_MARGIN
  const avail = bandBottom - cardBottom - FIT_GAP
  return avail >= twoRowH ? 1 : Math.max(FIT_FLOOR, avail / twoRowH)
}

function crystalDims(l: Layout, tier: number): Dims {
  const { h: cardH } = cardSize(l)
  const s = tierScale(tier) * fitScale(l, tier)
  const bodyW = cardH * BODY_W_OVER_CARD_H * s
  const bodyH = bodyW * BODY_H_OVER_W
  const baseW = bodyW * BASE_W_OVER_BODY
  const baseH = bodyH * BASE_H_OVER_BODY
  const overlap = baseH * 0.4
  return { bodyW, bodyH, baseW, baseH, overlap, w: baseW, h: bodyH + baseH - overlap }
}

// --- layout -----------------------------------------------------------------

// The banker's hands at the felt's top edge — where new markers fly IN from on a win and
// where the whole pile flies BACK on a bust, before he leaves.
export function codaBankAnchor(l: Layout): Point {
  const d = dealerBox(l)
  return { x: d.cx, y: d.baseY }
}

// Lay out `count` markers of `tier` as a centred grid pushed to the BOTTOM of the band
// between the coin-bet row and the HUD action bar. Rows wrap upward, rebalance even (the
// count is a power of two: 8 → 4+4), and the whole grid shrinks to fit.
export function codaCounterGrid(l: Layout, count: number, tier: number): { centers: Point[]; w: number; h: number } {
  const d = crystalDims(l, tier)
  if (count <= 0) {
    return { centers: [], w: d.w, h: d.h }
  }
  // Markers stay FULL size. Up to 4 per row (8 → 2 rows of 4); a row tightens its horizontal
  // gap only if the markers are huge, and the two rows OVERLAP vertically a touch so the block
  // stays low and compact without shrinking.
  const cols = Math.min(count, MAX_COLS)
  const rows = Math.ceil(count / cols)
  const availW = l.width * HORIZ_BUDGET
  const naturalPitchX = d.w + d.w * GAP_OVER_W
  const pitchX = cols > 1 ? Math.min(naturalPitchX, (availW - d.w) / (cols - 1)) : naturalPitchX
  // Row pitch so the glass bodies overlap by GLASS_OVERLAP (bodyH — not the full footprint d.h).
  const pitchY = rows > 1 ? d.bodyH * (1 - GLASS_OVERLAP) : d.h

  const w = d.w
  const h = d.h
  const anchorX = l.width / 2
  const bandBottom = l.height - actionBarReserve(l) - BOTTOM_MARGIN
  const gridH = (rows - 1) * pitchY + h
  const top = bandBottom - gridH // bottom-align: the last row rides just above the buttons

  const centers: Point[] = []
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols)
    const c = i - r * cols
    const colsInRow = r < rows - 1 ? cols : count - cols * (rows - 1)
    const rowW = (colsInRow - 1) * pitchX + w
    const startX = anchorX - rowW / 2 + w / 2
    centers.push({ x: startX + c * pitchX, y: top + h / 2 + r * pitchY })
  }
  return { centers, w, h }
}

// --- paint ------------------------------------------------------------------

export function drawCodaCounters(ctx: CanvasRenderingContext2D, l: Layout, base: number, view: CodaCounterView): void {
  if (view.markers.length === 0) {
    return
  }
  const bank = codaBankAnchor(l)

  for (const m of view.markers) {
    const gridTo = codaCounterGrid(l, m.count, m.tier)
    const to = gridTo.centers[m.slot]
    if (!to) {
      continue
    }
    let x = to.x
    let y = to.y
    let w = gridTo.w
    let h = gridTo.h
    let scale = 1
    let alpha = 1

    switch (m.motion) {
      case 'rest':
        break
      case 'form': {
        const e = smoothEnd3(m.p)
        scale = 0.4 + 0.6 * e + arch(m.p) * 0.08
        alpha = clamp01(m.p * 1.6)
        break
      }
      case 'flyIn': {
        const e = smoothEnd3(m.p)
        x = lerp(bank.x, to.x, e)
        y = lerp(bank.y, to.y, e)
        scale = 0.45 + 0.55 * e + arch(m.p) * 0.1
        alpha = clamp01(m.p * 2)
        break
      }
      case 'reflow': {
        const gridFrom = codaCounterGrid(l, m.fromCount, m.tier)
        const from = gridFrom.centers[m.slot] ?? to
        const e = smoothStep(m.p)
        x = lerp(from.x, to.x, e)
        y = lerp(from.y, to.y, e)
        w = lerp(gridFrom.w, gridTo.w, e)
        h = lerp(gridFrom.h, gridTo.h, e)
        break
      }
      case 'fuseOut': {
        // Converge on the new higher-tier marker's spot (a single centred slot), shrinking
        // and fading out as they merge into it.
        const tgtGrid = codaCounterGrid(l, 1, m.tier + 1)
        const tgt = tgtGrid.centers[0] ?? to
        const e = smoothStep(m.p)
        x = lerp(to.x, tgt.x, e)
        y = lerp(to.y, tgt.y, e)
        scale = 1 - 0.8 * m.p
        alpha = m.p < 0.55 ? 1 : clamp01(1 - (m.p - 0.55) / 0.45)
        break
      }
      case 'fuseIn': {
        // The new denomination blooms at the centre with a pop.
        scale = 0.2 + 0.8 * smoothEnd3(m.p) + arch(m.p) * 0.12
        alpha = clamp01(m.p * 1.8)
        break
      }
      case 'flyOut': {
        if (m.p >= 1) {
          continue
        }
        const e = smoothStart2(m.p)
        x = lerp(to.x, bank.x, e)
        y = lerp(to.y, bank.y, e)
        scale = 1 - 0.85 * m.p
        alpha = 1 - m.p
        break
      }
      case 'fade': {
        if (m.p >= 1) {
          continue
        }
        scale = 1 - 0.35 * m.p
        alpha = 1 - m.p
        break
      }
    }

    if (alpha <= 0) {
      continue
    }
    const value = base * Math.pow(TIER_MULT, m.tier)
    const sprite = crystalSprite(l, m.tier, value)
    const dw = w * scale * sprite.scaleW
    const dh = h * scale * sprite.scaleH
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.drawImage(sprite.canvas, x - dw / 2, y - dh / 2, dw, dh)
    ctx.restore()
  }
}

// --- tier styling -----------------------------------------------------------

interface TierStyle {
  glass: [string, string, string] // crystal fill: top / mid / bottom
  coreRGB: string // smoky backing behind the number, "r,g,b"
  number: [string, string, string] // value gradient
  numberShadow: string
  base: [string, string, string, string, string] // metal plinth gradient
  baseRim: string
  baseSeam: string
  baseSide: [string, string] // cylindrical sheen: light edge / dark edge
  rim: string // crystal edge stroke
}

const GOLD_NUMBER: [string, string, string] = ['#fff4cf', '#ffd875', '#e9ab45']

// Denominations, low → high. Beyond ruby (tier 4 = 65536× base) is unreachable in practice.
const TIER_STYLES: TierStyle[] = [
  {
    // clear glass on bronze
    glass: ['rgba(238,248,255,0.42)', 'rgba(196,224,246,0.16)', 'rgba(210,234,252,0.32)'],
    coreRGB: '26,20,12',
    number: GOLD_NUMBER,
    numberShadow: 'rgba(6,3,0,0.6)',
    base: ['#eec48c', '#d19a5c', '#ab6f38', '#7d4b23', '#5a3416'],
    baseRim: 'rgba(255,236,200,0.75)',
    baseSeam: 'rgba(30,16,6,0.55)',
    baseSide: ['rgba(255,240,214,0.4)', 'rgba(40,22,8,0.45)'],
    rim: 'rgba(255,255,255,0.42)',
  },
  {
    // aqua crystal on steel
    glass: ['rgba(212,246,255,0.46)', 'rgba(150,216,242,0.2)', 'rgba(182,232,252,0.36)'],
    coreRGB: '10,40,55',
    number: GOLD_NUMBER,
    numberShadow: 'rgba(2,12,18,0.6)',
    base: ['#e9eef4', '#b9c4d0', '#8f9dab', '#5f6d7c', '#3f4a56'],
    baseRim: 'rgba(240,246,252,0.8)',
    baseSeam: 'rgba(20,26,34,0.5)',
    baseSide: ['rgba(245,250,255,0.45)', 'rgba(20,28,36,0.45)'],
    rim: 'rgba(220,245,255,0.5)',
  },
  {
    // gold crystal on gold
    glass: ['rgba(255,246,208,0.52)', 'rgba(242,206,120,0.24)', 'rgba(250,226,150,0.4)'],
    coreRGB: '60,40,6',
    number: ['#ffffff', '#fff2cf', '#f0d79a'],
    numberShadow: 'rgba(58,34,0,0.62)',
    base: ['#ffe7a8', '#f0c064', '#d19a34', '#9c6f1e', '#6e4c12'],
    baseRim: 'rgba(255,244,200,0.85)',
    baseSeam: 'rgba(60,40,6,0.55)',
    baseSide: ['rgba(255,246,210,0.5)', 'rgba(60,40,6,0.5)'],
    rim: 'rgba(255,250,220,0.55)',
  },
  {
    // violet crystal on dark amethyst metal
    glass: ['rgba(236,222,255,0.48)', 'rgba(182,142,232,0.22)', 'rgba(206,176,246,0.36)'],
    coreRGB: '30,14,50',
    number: GOLD_NUMBER,
    numberShadow: 'rgba(14,4,26,0.62)',
    base: ['#c9b6e0', '#9c7fc4', '#6f4f9c', '#452c66', '#2a173f'],
    baseRim: 'rgba(230,215,250,0.8)',
    baseSeam: 'rgba(20,10,34,0.55)',
    baseSide: ['rgba(235,222,252,0.45)', 'rgba(20,10,34,0.5)'],
    rim: 'rgba(238,225,255,0.5)',
  },
  {
    // ruby crystal on obsidian
    glass: ['rgba(255,216,222,0.48)', 'rgba(232,120,142,0.22)', 'rgba(246,172,186,0.36)'],
    coreRGB: '50,10,20',
    number: GOLD_NUMBER,
    numberShadow: 'rgba(28,2,8,0.62)',
    base: ['#8a8f99', '#5a5f6b', '#3a3e48', '#22252c', '#121419'],
    baseRim: 'rgba(200,206,216,0.7)',
    baseSeam: 'rgba(0,0,0,0.6)',
    baseSide: ['rgba(210,216,226,0.4)', 'rgba(0,0,0,0.5)'],
    rim: 'rgba(240,220,225,0.5)',
  },
]

function tierStyle(tier: number): TierStyle {
  return TIER_STYLES[Math.min(Math.max(0, tier), TIER_STYLES.length - 1)]
}

// --- the marker sprite ------------------------------------------------------

interface CrystalSprite {
  canvas: HTMLCanvasElement
  scaleW: number // sprite CSS width / footprint width (accounts for the shadow/glow pad)
  scaleH: number
}

const spriteCache = new Map<string, CrystalSprite>()

function crystalSprite(l: Layout, tier: number, value: number): CrystalSprite {
  const dpr = deviceDpr()
  const d = crystalDims(l, tier)
  const key = `${Math.round(d.w)}:${tier}:${Math.round(value)}@${dpr}`
  let sprite = spriteCache.get(key)
  if (!sprite) {
    if (spriteCache.size > 32) {
      spriteCache.clear()
    }
    sprite = buildCrystalSprite(d, tier, value, dpr)
    spriteCache.set(key, sprite)
  }
  return sprite
}

function buildCrystalSprite(d: Dims, tier: number, value: number, dpr: number): CrystalSprite {
  const style = tierStyle(tier)
  const pad = d.baseW * PAD_OVER_W
  const cw = d.w + pad * 2
  const ch = d.h + pad * 2
  const { canvas, ctx } = createSpriteCanvas(Math.round(cw * dpr), Math.round(ch * dpr))
  ctx.scale(dpr, dpr)

  const bodyX = pad + (d.w - d.bodyW) / 2
  const bodyY = pad
  const baseX = pad + (d.w - d.baseW) / 2
  const baseY = pad + d.bodyH - d.overlap
  const bodyR = Math.min(d.bodyW, d.bodyH) * 0.16

  // Drop shadow — a soft dark ellipse the marker casts on the felt, so it sits ON the table
  // (and, where the two rows overlap, the front row reads clearly above the back one).
  ctx.save()
  ctx.globalAlpha = 0.55
  ctx.filter = `blur(${d.baseW * 0.11}px)`
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.ellipse(pad + d.w / 2 + d.baseW * 0.05, baseY + d.baseH * 0.7, d.baseW * 0.6, d.baseH * 1.1, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  drawBase(ctx, baseX, baseY, d.baseW, d.baseH, style)
  drawCrystal(ctx, bodyX, bodyY, d.bodyW, d.bodyH, bodyR, value, style)

  return { canvas, scaleW: cw / d.w, scaleH: ch / d.h }
}

function drawBase(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, style: TierStyle): void {
  const r = Math.min(h * 0.34, w * 0.12)
  const body = ctx.createLinearGradient(x, y, x, y + h)
  body.addColorStop(0, style.base[0])
  body.addColorStop(0.16, style.base[1])
  body.addColorStop(0.5, style.base[2])
  body.addColorStop(0.84, style.base[3])
  body.addColorStop(1, style.base[4])
  roundRect(ctx, x, y, w, h, r)
  ctx.fillStyle = body
  ctx.fill()

  ctx.save()
  roundRect(ctx, x, y, w, h, r)
  ctx.clip()
  const side = ctx.createLinearGradient(x, 0, x + w, 0)
  side.addColorStop(0, style.baseSide[0])
  side.addColorStop(0.3, 'rgba(255,255,255,0)')
  side.addColorStop(0.75, 'rgba(0,0,0,0)')
  side.addColorStop(1, style.baseSide[1])
  ctx.fillStyle = side
  ctx.fillRect(x, y, w, h)
  ctx.restore()

  ctx.lineWidth = Math.max(1, h * 0.09)
  ctx.strokeStyle = style.baseRim
  ctx.beginPath()
  ctx.moveTo(x + r, y + ctx.lineWidth / 2)
  ctx.lineTo(x + w - r, y + ctx.lineWidth / 2)
  ctx.stroke()
  ctx.lineWidth = Math.max(1, h * 0.06)
  ctx.strokeStyle = style.baseSeam
  ctx.beginPath()
  ctx.moveTo(x + r, y + h - ctx.lineWidth / 2)
  ctx.lineTo(x + w - r, y + h - ctx.lineWidth / 2)
  ctx.stroke()
}

function drawCrystal(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, value: number, style: TierStyle): void {
  // Glass body — a faint tint, low alpha so the felt reads through it.
  const glass = ctx.createLinearGradient(x, y, x, y + h)
  glass.addColorStop(0, style.glass[0])
  glass.addColorStop(0.5, style.glass[1])
  glass.addColorStop(1, style.glass[2])
  roundRect(ctx, x, y, w, h, r)
  ctx.fillStyle = glass
  ctx.fill()

  // Smoky core behind the number so it reads on clear glass over the felt.
  const core = ctx.createRadialGradient(x + w / 2, y + h * 0.46, 0, x + w / 2, y + h * 0.46, w * 0.5)
  core.addColorStop(0, `rgba(${style.coreRGB},0.34)`)
  core.addColorStop(0.7, `rgba(${style.coreRGB},0.14)`)
  core.addColorStop(1, `rgba(${style.coreRGB},0)`)
  ctx.save()
  roundRect(ctx, x, y, w, h, r)
  ctx.clip()
  ctx.fillStyle = core
  ctx.fillRect(x, y, w, h)
  ctx.restore()

  // The number, embedded in the crystal.
  const text = formatCrystalValue(value)
  const fontPx = fitFont(ctx, text, w * 0.78, h * 0.56)
  const cx = x + w / 2
  const cy = y + h * 0.46
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`
  ctx.fillStyle = style.numberShadow
  ctx.fillText(text, cx, cy + fontPx * 0.06)
  const num = ctx.createLinearGradient(cx, cy - fontPx * 0.5, cx, cy + fontPx * 0.5)
  num.addColorStop(0, style.number[0])
  num.addColorStop(0.5, style.number[1])
  num.addColorStop(1, style.number[2])
  ctx.fillStyle = num
  ctx.fillText(text, cx, cy)

  // Glass specular (additive), clipped to the body.
  ctx.save()
  roundRect(ctx, x, y, w, h, r)
  ctx.clip()
  ctx.globalCompositeOperation = 'lighter'

  ctx.save()
  ctx.translate(x + w * 0.3, y + h * 0.26)
  ctx.rotate(-0.7)
  ctx.scale(1, 0.5)
  const streak = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.55)
  streak.addColorStop(0, 'rgba(255, 255, 255, 0.72)')
  streak.addColorStop(0.5, 'rgba(236, 244, 255, 0.22)')
  streak.addColorStop(1, 'rgba(236, 244, 255, 0)')
  ctx.fillStyle = streak
  ctx.beginPath()
  ctx.arc(0, 0, w * 0.55, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  const sheen = ctx.createLinearGradient(x, y, x, y + h * 0.26)
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.55)')
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = sheen
  roundRect(ctx, x + w * 0.06, y + h * 0.04, w * 0.88, h * 0.24, r * 0.7)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.lineWidth = Math.max(1, w * 0.025)
  ctx.beginPath()
  ctx.moveTo(x + w * 0.16, y + h * 0.36)
  ctx.lineTo(x + w * 0.44, y + h * 0.08)
  ctx.stroke()

  const dot = ctx.createRadialGradient(x + w * 0.76, y + h * 0.74, 0, x + w * 0.76, y + h * 0.74, w * 0.16)
  dot.addColorStop(0, 'rgba(240, 246, 255, 0.55)')
  dot.addColorStop(1, 'rgba(240, 246, 255, 0)')
  ctx.fillStyle = dot
  ctx.beginPath()
  ctx.arc(x + w * 0.76, y + h * 0.74, w * 0.16, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // A crisp bright rim so the block reads as cut crystal, not a soft blob.
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r)
  ctx.lineWidth = Math.max(1, w * 0.02)
  ctx.strokeStyle = style.rim
  ctx.stroke()
}

// Largest whole-pixel font that fits `text` within (maxW, maxH).
function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxH: number): number {
  let size = Math.floor(maxH)
  ctx.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`
  const w = ctx.measureText(text).width
  if (w > maxW) {
    size = Math.max(6, Math.floor(size * (maxW / w)))
  }
  return size
}

// The marker shows the score in whole THOUSANDS below a million, and whole MILLIONS at or above
// one — no unit suffix (the holo carries the precise total; the tier colour/size conveys scale):
//   37,842 → "37"   250,500 → "250"   11,000,000 → "11"   9,687,000 → "9"
export function formatCrystalValue(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v >= 1_000_000) {
    return String(Math.floor(v / 1_000_000))
  }
  if (v >= 1000) {
    return String(Math.floor(v / 1000))
  }
  return String(v)
}

// --- helpers ----------------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

// A 0→1→0 hump for a subtle pop overshoot mid-motion.
function arch(t: number): number {
  return 4 * t * (1 - t)
}
