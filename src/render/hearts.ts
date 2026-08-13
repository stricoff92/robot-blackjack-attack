// Player hit-point display: a centred row of MAX_HEARTS poker chips, each stamped with a heart,
// sitting just above the bottom action bar. Full hit points show as bright red heart-chips; spent
// ones as dim empty sockets. On a LOSS the nexus fires a red laser at the last full chip and its
// heart POPS (scales up + fades out); on a qualifying WIN a green restorative beam lands on the
// first empty socket and a heart fades IN (scales down into place).
//
// Like the other render modules this owns only geometry + paint (see [[canvas-ui]]); the pop/heal
// TIMING lives in ui/heart-animator.ts, which hands us a per-frame HeartsView snapshot. The beams
// reuse the nexus laser/heal painters so they read as the same device that strikes the dealer.

import { deviceDpr } from './canvas'
import { playerCardBox } from './cards'
import { smoothEnd2, smoothEnd3, smoothStart2 } from './easing'
import { drawBeam, drawHealBeam, nexusUtilityLight } from './nexus'
import type { Layout } from './scene'
import { createSpriteCanvas } from './sprite-canvas'
import type { Point } from './tokens'
import { MAX_HEARTS } from '../game/run'

const TAU = Math.PI * 2

// One heart being gained or lost this resolve, plus the beam that drives it. `filled` is the count
// of solid heart-chips to draw right now — it LAGS the run state during a transition (the chip only
// commits once its pop/heal glyph finishes), so the animator, not the raw hit points, owns it.
export interface HeartsView {
  filled: number
  max: number
  // The transient heart glyphs on the changing slots: a 'pop' scales up + fades out (a lost heart), a
  // 'heal' scales down + fades in (a gained heart). A pop is always one; a kill heals several at once.
  transients: { slot: number; kind: 'pop' | 'heal'; progress: number }[]
  // The beam in flight (nexus lens → the changing slot). `slot` may be FRACTIONAL: on a multi-heart
  // heal the head glides between adjacent sockets, so the renderer interpolates its target. null when
  // no beam is drawing.
  beam: { slot: number; kind: 'pop' | 'heal'; travel: number; alpha: number } | null
  // The hot spark shower thrown off a struck chip on a loss, `progress` 0..1 over its life.
  // null except during the brief window just after the loss laser lands. Only a pop sparks.
  spark: { slot: number; progress: number } | null
}

// Full heart-chip: a classic casino chip — a bright WHITE face stamped with a red heart, ringed by
// a red/black striped edge. A spent chip is the same disc drained to a dark, desaturated socket
// with a hollow heart outline, so all MAX_HEARTS slots always read as a row.
const STRIPE_RED = '#d23440'
const STRIPE_DARK = '#1a1216'
const FACE_HI = '#ffffff'
const FACE_LO = '#e7dfe4'
const FACE_RING = 'rgba(40, 26, 32, 0.85)'
const STRIPE_RED_EMPTY = '#4a3238'
const STRIPE_DARK_EMPTY = '#221b1f'
const FACE_HI_EMPTY = '#2c2530'
const FACE_LO_EMPTY = '#201a20'
const FACE_RING_EMPTY = 'rgba(120, 100, 108, 0.3)'
const STRIPE_COUNT = 8 // alternating red / dark wedges around the chip's edge
const HEART_FULL = '#ec3b46'
const HEART_GLOW = 'rgba(236, 59, 70, 0.9)'
const HEART_EMPTY = 'rgba(170, 140, 150, 0.3)'

// The heart pops OUTWARD to POP_SCALE× as it fades; a healed heart drops IN from HEAL_SCALE× to 1×.
const POP_SCALE = 2.1
const HEAL_SCALE = 2.2

// --- geometry ----------------------------------------------------------------

// The heart row: chip radius (round, face-on) and the y of every chip's centre. Anchored a fixed
// margin above the action bar so it clears the HUD buttons on desktop and mobile alike.
const GAP_RATIO = 0.85 // gap between chips, as a fraction of the chip radius
const HEART_CARD_GAP = 6 // clearance kept below the player cards
const HEART_BUTTONS_CLEAR = 66 // px above the screen bottom the row's lower edge stays (clears the action bar)

export function heartRowMetrics(l: Layout): { r: number; gap: number; y: number } {
  const span = Math.min(l.width, l.height)
  // Width fit: MAX_HEARTS chips span r·(2·MAX + GAP_RATIO·(MAX−1)); keep that within ~90% of the width
  // so an 8-chip row still fits a narrow phone.
  const cellsR = 2 * MAX_HEARTS + GAP_RATIO * (MAX_HEARTS - 1)
  const widthR = (l.width * 0.9) / cellsR
  // Vertical fit: sit the row in the clear band between the ACTUAL player-card bottom and the action
  // bar — the cards can bottom out well above the reserve on a tall/portrait phone, so anchor to the
  // real card box (not BOTTOM_HUD_RESERVE) or the row rides up under the cards (the iPhone SE bug).
  const box = playerCardBox(l)
  const bandTop = box.y + box.h + HEART_CARD_GAP
  const bandBottom = l.height - HEART_BUTTONS_CLEAR
  const bandR = Math.max(0, (bandBottom - bandTop) / 2)
  const r = clamp(Math.min(span * 0.034, widthR, bandR), 6, 19)
  const gap = r * GAP_RATIO
  // Centre the row in the band; when the band is tight (a short/landscape screen) clamp so the row
  // stays within it, biasing to clear the interactive buttons below.
  const y = clamp((bandTop + bandBottom) / 2, bandTop + r, bandBottom - r)
  return { r, gap, y }
}

// Every heart slot's centre, left → right, centred horizontally. Exported so the choreography can
// aim a beam at the exact slot that changed.
export function heartSlotCenters(l: Layout): Point[] {
  const { r, gap, y } = heartRowMetrics(l)
  const step = r * 2 + gap
  const totalW = MAX_HEARTS * r * 2 + (MAX_HEARTS - 1) * gap
  const startX = l.width / 2 - totalW / 2 + r
  return Array.from({ length: MAX_HEARTS }, (_, i) => ({ x: startX + i * step, y }))
}

// --- drawing -----------------------------------------------------------------

// `fade` (0..1) eases the whole row in when a run begins (hidden on the title screen). It's applied
// as a layer-wide globalAlpha that every chip / transient / beam then multiplies into, so they all
// fade together; default 1 is the steady in-play look.
export function drawHearts(ctx: CanvasRenderingContext2D, l: Layout, view: HeartsView, now: number, fade = 1): void {
  ctx.clearRect(0, 0, l.width, l.height)
  if (fade <= 0) {
    return
  }
  const { r } = heartRowMetrics(l)
  const centers = heartSlotCenters(l)

  ctx.save()
  ctx.globalAlpha = fade

  // The chips first: solid up to `filled`, empty after. The slot currently mid-transition is drawn
  // as its END state here (the animated glyph rides on top), so a popping chip's socket shows
  // beneath the departing heart and a healing chip's socket is already lit as its heart drops in.
  for (let i = 0; i < view.max; i += 1) {
    const c = centers[i]
    drawHeartChip(ctx, c.x, c.y, r, i < view.filled, 1, 1)
  }

  // The transient heart glyphs on the changing slots.
  for (const tr of view.transients) {
    const c = centers[tr.slot]
    if (tr.kind === 'pop') {
      // Scale up + fade out as it's blown off the chip.
      const p = smoothStart2(tr.progress)
      drawHeart(ctx, c.x, c.y, r * 0.52 * (1 + (POP_SCALE - 1) * p), HEART_FULL, HEART_GLOW, 1 - p)
    } else {
      // Scale down + fade in as it drops into the socket.
      const p = smoothEnd3(tr.progress)
      drawHeart(ctx, c.x, c.y, r * 0.52 * (HEAL_SCALE + (1 - HEAL_SCALE) * p), HEART_FULL, HEART_GLOW, p)
    }
  }

  // The beam last, so it reads over the chips. It flies from the nexus lens to the changing slot
  // (a fractional slot glides the head between adjacent sockets on a multi-heart heal).
  if (view.beam) {
    const from = nexusUtilityLight(l, now)
    const to = slotPoint(centers, view.beam.slot)
    const scale = Math.min(l.width, l.height)
    // A source-over core FIRST: the beam crosses the player's cards, and the nexus beams composite
    // ADDITIVELY ('lighter') — which vanishes over the bright white card faces, making the beam look
    // like it ducks BEHIND the cards. This opaque-ish core keeps it visible on any background; the
    // additive glow below then adds the energy look over the dark table.
    drawBeamCore(ctx, from, to, view.beam.travel, view.beam.alpha, view.beam.kind, scale)
    if (view.beam.kind === 'pop') {
      drawBeam(ctx, from, to, view.beam.travel, view.beam.alpha, scale)
    } else {
      drawHealBeam(ctx, from, to, view.beam.travel, view.beam.alpha, scale, now)
    }
  }

  // The impact sparks last of all — the hot shower thrown off the struck chip on a loss, drawn
  // over even the beam so it reads as the moment of impact.
  if (view.spark) {
    const c = centers[view.spark.slot]
    drawHeartSparks(ctx, c.x, c.y, view.spark.progress, r, view.spark.slot)
  }

  ctx.restore()
}

// A solid, source-over beam core from the nexus lens to the beam head — stays visible over the
// bright player cards where the additive glow washes out. Saturated colour + a soft shadow glow so
// it still reads as an energy beam, not a flat line.
function drawBeamCore(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  travel: number,
  alpha: number,
  kind: 'pop' | 'heal',
  scale: number,
): void {
  if (alpha <= 0) {
    return
  }
  const hx = from.x + (to.x - from.x) * travel
  const hy = from.y + (to.y - from.y) * travel
  const [rr, gg, bb] = kind === 'pop' ? [255, 80, 80] : [90, 235, 140]
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.lineCap = 'round'
  ctx.strokeStyle = `rgba(${rr}, ${gg}, ${bb}, ${clamp(alpha * 0.85, 0, 1)})`
  ctx.lineWidth = clamp(scale * (kind === 'pop' ? 0.007 : 0.012), 2.5, kind === 'pop' ? 7 : 13)
  ctx.shadowColor = `rgba(${rr}, ${gg}, ${bb}, ${clamp(alpha, 0, 1)})`
  ctx.shadowBlur = clamp(scale * 0.025, 6, 22)
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(hx, hy)
  ctx.stroke()
  ctx.restore()
}

// Blit one heart-chip so its centre lands at (x, y). The chip itself (striped edge, gradient face,
// heart + glow) is far too much to re-rasterise per chip per frame — the row redraws 60×/s and the
// loop never parks — so it's pre-rendered once into an offscreen sprite (see heartChipSprite) and
// this is a single drawImage. `scale` swells the chip about its centre (a future chip-level pulse),
// `alpha` fades it; both multiply into the row-wide fade already on the context.
function drawHeartChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  full: boolean,
  alpha: number,
  scale: number,
): void {
  if (alpha <= 0) {
    return
  }
  const sprite = heartChipSprite(r, full)
  ctx.save()
  ctx.globalAlpha *= clamp(alpha, 0, 1)
  if (scale !== 1) {
    ctx.translate(x, y)
    ctx.scale(scale, scale)
    ctx.translate(-x, -y)
  }
  ctx.drawImage(sprite.canvas, x - sprite.center, y - sprite.center, sprite.size, sprite.size)
  ctx.restore()
}

// --- offscreen chip sprites --------------------------------------------------

interface ChipSprite {
  canvas: HTMLCanvasElement
  size: number // sprite side, CSS px
  center: number // the chip centre's offset within the sprite, CSS px
}

// Cache keyed by (rounded radius, fill state, dpr). The set is tiny — a handful of radii × 2 states
// — but a resize to a new dpr rebuilds, so it's bounded defensively.
const chipCache = new Map<string, ChipSprite>()

function heartChipSprite(r: number, full: boolean): ChipSprite {
  const dpr = deviceDpr()
  const rr = Math.max(1, Math.round(r))
  const key = `${rr}:${full ? 1 : 0}:${dpr}`
  let sprite = chipCache.get(key)
  if (!sprite) {
    if (chipCache.size > 64) {
      chipCache.clear()
    }
    sprite = buildChipSprite(rr, full, dpr)
    chipCache.set(key, sprite)
  }
  return sprite
}

function buildChipSprite(r: number, full: boolean, dpr: number): ChipSprite {
  const pad = Math.ceil(r * 0.4) // room for the contact shadow (below) + the heart's glow bleed
  const size = (r + pad) * 2
  const center = r + pad
  const { canvas, ctx } = createSpriteCanvas(Math.ceil(size * dpr), Math.ceil(size * dpr))
  ctx.scale(dpr, dpr) // draw the chip in CSS px; the backing store is device-resolution
  paintChip(ctx, center, center, r, full)
  return { canvas, size, center }
}

// Paint a single poker-chip face centred at (cx, cy): contact shadow, red/black striped edge, white
// (or drained) gradient face, then the heart — solid + glow when full, a hollow outline when spent.
function paintChip(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, full: boolean): void {
  // Contact shadow, dropped slightly below the disc.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)'
  ctx.beginPath()
  ctx.ellipse(cx, cy + r * 0.16, r * 1.0, r * 0.9, 0, 0, TAU)
  ctx.fill()

  // Striped edge: a red base disc, then dark wedges on every other segment so the red shows through
  // as the alternating stripe. Only the outer band [rInner..r] is over-painted; the face covers rest.
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TAU)
  ctx.fillStyle = full ? STRIPE_RED : STRIPE_RED_EMPTY
  ctx.fill()
  const rInner = r * 0.68
  ctx.fillStyle = full ? STRIPE_DARK : STRIPE_DARK_EMPTY
  for (let i = 0; i < STRIPE_COUNT; i += 2) {
    const a0 = (i / STRIPE_COUNT) * TAU
    const a1 = ((i + 1) / STRIPE_COUNT) * TAU
    ctx.beginPath()
    ctx.arc(cx, cy, r, a0, a1)
    ctx.arc(cx, cy, rInner, a1, a0, true)
    ctx.closePath()
    ctx.fill()
  }

  // White gradient face over the inner edge of the stripes (a slight top-lit sheen). Kept wide so
  // the striped edge is a slim band relative to the disc rather than a heavy ring.
  const rFace = r * 0.72
  const grad = ctx.createRadialGradient(cx, cy - r * 0.22, r * 0.08, cx, cy, rFace)
  grad.addColorStop(0, full ? FACE_HI : FACE_HI_EMPTY)
  grad.addColorStop(1, full ? FACE_LO : FACE_LO_EMPTY)
  ctx.beginPath()
  ctx.arc(cx, cy, rFace, 0, TAU)
  ctx.fillStyle = grad
  ctx.fill()
  // A thin ring seating the face into the striped edge.
  ctx.beginPath()
  ctx.arc(cx, cy, rFace, 0, TAU)
  ctx.lineWidth = Math.max(1, r * 0.06)
  ctx.strokeStyle = full ? FACE_RING : FACE_RING_EMPTY
  ctx.stroke()

  if (full) {
    drawHeart(ctx, cx, cy, r * 0.5, HEART_FULL, HEART_GLOW, 1, 0.3)
  } else {
    drawHeartOutline(ctx, cx, cy, r * 0.5, HEART_EMPTY, Math.max(1.2, r * 0.1))
  }
}

// A filled heart centred at (cx, cy), `s` its overall half-size, with an additive glow. `glowScale`
// sets the blur radius as a fraction of `s`: the flying pop/heal transients use the default big,
// dramatic bloom; the heart stamped on a resting chip uses a tight glow so the white face stays white.
function drawHeart(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  fill: string,
  glow: string,
  alpha: number,
  glowScale = 0.9,
): void {
  if (alpha <= 0 || s <= 0) {
    return
  }
  ctx.save()
  ctx.globalAlpha *= clamp(alpha, 0, 1)
  heartPath(ctx, cx, cy, s)
  ctx.fillStyle = fill
  ctx.shadowColor = glow
  ctx.shadowBlur = s * glowScale
  ctx.fill()
  ctx.restore()
}

function drawHeartOutline(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, stroke: string, width: number): void {
  ctx.save()
  heartPath(ctx, cx, cy, s)
  ctx.strokeStyle = stroke
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.restore()
}

// Trace a symmetric heart into the current path: bottom tip at (cx, cy + 0.75s), two lobes reaching
// up to ~cy − 0.7s, meeting in a dimple at (cx, cy − 0.25s). Width ≈ ±0.9s.
function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.beginPath()
  ctx.moveTo(cx, cy + s * 0.75)
  ctx.bezierCurveTo(cx + s * 1.1, cy + s * 0.1, cx + s * 0.6, cy - s * 0.95, cx, cy - s * 0.25)
  ctx.bezierCurveTo(cx - s * 0.6, cy - s * 0.95, cx - s * 1.1, cy + s * 0.1, cx, cy + s * 0.75)
  ctx.closePath()
}

// --- impact sparks -----------------------------------------------------------

// A hot spark shower thrown off a heart-chip the instant the loss laser lands — the same pyrotechnic
// burst the nexus throws off the dealer on a strike (render/nexus drawSparkBurst), tuned smaller and
// redder for the little chip: flecks fly out on every heading, streak with motion blur, arc down
// under gravity, and cool from white-hot to red as they fade. `p` is 0..1 over the burst's life.
//
// Deterministic per (slot, spark index) — seeded off the slot so neighbouring chips differ, no
// Math.random — so a frame is a pure function of `p` and the shower never jitters between frames.
const HEART_SPARK_COUNT = 16

function drawHeartSparks(ctx: CanvasRenderingContext2D, cx: number, cy: number, p: number, r: number, slot: number): void {
  const fade = 1 - smoothEnd2(p) // brightness: fast dim, then a faint tail
  if (fade <= 0.001) {
    return
  }
  const travel = smoothEnd3(p) // outward distance: a hard burst easing to rest
  const reach = r * 4.6 // flecks are thrown well clear of the chip
  const gy = r * 1.4 * p * p // gravity droop, growing quadratically
  const seed = slot * 97
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  for (let i = 0; i < HEART_SPARK_COUNT; i += 1) {
    const angle = sparkHash(i + seed, 71) * TAU
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const dist = reach * (0.45 + sparkHash(i + seed, 83) * 0.55) * travel
    const px = cx + cos * dist
    const py = cy + sin * dist + gy
    // A motion-blur streak trailing back toward the burst origin, shrinking as the spark fades.
    const len = r * (0.6 + 0.8 * sparkHash(i + seed, 97)) * fade
    const tx = px - cos * len
    const ty = py - sin * len
    // White-hot core shading per-spark toward orange/red, drawn additively.
    const g = 90 + Math.floor(sparkHash(i + seed, 51) * 130) //  90..220
    const bl = 40 + Math.floor(sparkHash(i + seed, 29) * 70) //  40..110
    const a = fade * (0.7 + 0.3 * sparkHash(i + seed, 41))
    ctx.strokeStyle = `rgba(255, ${g}, ${bl}, ${a})`
    ctx.lineWidth = Math.max(1.2, r * 0.14) * (0.6 + 0.5 * fade)
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(px, py)
    ctx.stroke()
    // A bright pin-head at the leading tip.
    ctx.fillStyle = `rgba(255, 232, 196, ${a})`
    ctx.beginPath()
    ctx.arc(px, py, Math.max(1, r * 0.12) * (0.6 + 0.6 * fade), 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

// Cheap deterministic 0..1 hash (sine-hash, house style), so each spark's heading + reach are stable
// frame-to-frame.
function sparkHash(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// The point for a (possibly fractional) slot index: an integer index is that socket's centre; a
// fractional one lerps between the two adjacent sockets, so the heal beam's head glides along the
// row from one chip to the next. Clamped to the row so a stray index can't index out of bounds.
function slotPoint(centers: Point[], slot: number): Point {
  const last = centers.length - 1
  const i0 = Math.max(0, Math.min(Math.floor(slot), last))
  const i1 = Math.min(i0 + 1, last)
  const f = clamp(slot - i0, 0, 1)
  const a = centers[i0]
  const b = centers[i1]
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
