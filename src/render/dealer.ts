// The dealer robot: the figure standing behind the table, plus its glowing eyes.
//
// Geometry + paint only (mirrors health.ts / cards.ts); all timing lives in the
// dealer animator (ui), passed in as a DealerView. The figure is drawn on its
// own 'dealer' layer, BELOW the table/rail — so its lower body and any death
// debris tuck behind the rail exactly as the old placeholder did. The eyes' red
// GLOW is drawn separately on the top 'mask' (light) layer via drawDealerEyeGlow.
//
// Reads dealerBox / dealerEyes from scene.ts (the single source of truth for the
// figure's footprint, shared with the health bar, chip anchors and Analyze beams).

import { arch2, smoothEnd2, smoothEnd3, smoothStart2 } from './easing'
import { dealerBox, dealerEyes, type DealerBox, type Layout } from './scene'

// The dealer reads as a dark SILHOUETTE against the (spotlit) back wall, which is
// roughly rgb(47,51,70) behind the head — so the head + body are kept clearly
// darker than that, or they blend into the wall.
const TORSO = '#090b10'
const HEAD = '#0f1219'
const MOUTH = '#242835' // a little lighter than the head; a voice sine-wave will live here later
const BOWTIE = '#3a7bd5' // blue bowtie
const BOWTIE_KNOT = '#255aa8'
const EYE = '#ff3b3b'

// What the animator exposes to this renderer. All queries take `now`.
export interface DealerView {
  // False during the brief gap between the old dealer's death and the new one's
  // arrival — nothing is drawn then.
  alive(now: number): boolean
  // Take-damage reaction: a white flash (0..1) and a small positional jitter.
  // shakeX/shakeY are in headR-fraction units — the renderer scales by headR.
  hit(now: number): { flash: number; shakeX: number; shakeY: number }
  // Death fall-apart progress (0..1), or null when not dying.
  dying(now: number): number | null
  // Walk-in progress (0..1), or null when not arriving.
  arriving(now: number): number | null
  // Low-health ambient spark intensity (0..1); 0 when healthy.
  ambient(now: number): number
  // Eye-glow strength for the mask layer (0..1); dims on death, re-ignites on arrival.
  eyeGlow(now: number): number
}

// Paint the dealer figure for this frame. Clears the layer first (it owns it).
export function drawDealer(ctx: CanvasRenderingContext2D, layout: Layout, view: DealerView, now: number): void {
  ctx.clearRect(0, 0, layout.width, layout.height)
  if (!view.alive(now)) {
    return // the empty beat between one dealer dying and the next walking in
  }

  const d = dealerBox(layout)
  const scale = Math.min(layout.width, layout.height)

  const dying = view.dying(now)
  if (dying !== null) {
    drawDeath(ctx, d, dying, scale)
    return
  }

  const arriving = view.arriving(now)
  const hit = view.hit(now)

  ctx.save()
  if (arriving !== null) {
    // Slide in from off-screen RIGHT, with a subtle walk bob, fading in over the
    // first third so it doesn't pop.
    const slide = smoothEnd3(arriving)
    const travel = layout.width * 0.6
    const bob = Math.sin(arriving * Math.PI * 3) * d.headR * 0.05
    ctx.translate(travel * (1 - slide), bob)
    ctx.globalAlpha = smoothEnd2(Math.min(1, arriving / 0.3))
  }
  // Take-damage jitter (small; applied after the walk-in translate). The animator
  // reports shake in headR-fraction units, so scale it to pixels here.
  ctx.translate(hit.shakeX * d.headR, hit.shakeY * d.headR)

  drawFigure(ctx, d, view.ambient(now), now)

  if (hit.flash > 0.001) {
    drawHitFlash(ctx, d, hit.flash)
  }
  ctx.restore()
}

// The red eye glow, drawn on the top 'mask' layer as additive light so the eyes
// read as emissive over the whole scene (and through the Analyze darkness). Kept
// separate from the figure because it lives on a different layer.
export function drawDealerEyeGlow(ctx: CanvasRenderingContext2D, layout: Layout, glow: number): void {
  if (glow <= 0.002) {
    return
  }
  const eyes = dealerEyes(layout)
  const a = clamp01(glow)
  const r = eyes.radius * 3.5
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const e of [eyes.left, eyes.right]) {
    const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r)
    grad.addColorStop(0, `rgba(255, 70, 70, ${a * 0.95})`)
    grad.addColorStop(0.5, `rgba(255, 40, 40, ${a * 0.4})`)
    grad.addColorStop(1, 'rgba(255, 30, 30, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// --- the figure (torso + head + bowtie + eyes + ambient sparks) ---------------

function drawFigure(ctx: CanvasRenderingContext2D, d: DealerBox, ambient: number, now: number): void {
  ctx.save()

  ctx.fillStyle = TORSO
  ctx.beginPath()
  ctx.roundRect(d.bodyLeft, d.bodyTop, d.bodyRight - d.bodyLeft, d.baseY - d.bodyTop, d.headR * 0.6)
  ctx.fill()

  ctx.fillStyle = HEAD
  ctx.beginPath()
  ctx.roundRect(d.cx - d.headR, d.headCenterY - d.headR, d.headR * 2, d.headR * 2, d.headR * 0.35)
  ctx.fill()

  drawBowtie(ctx, d)

  // Eye cores, drawn from dealerBox directly (matching dealerEyes' formula) — the
  // emissive glow is a separate pass on the mask layer (drawDealerEyeGlow).
  const eyeY = d.headCenterY - d.headR * 0.18
  const eyeR = d.headR * 0.16
  ctx.fillStyle = EYE
  ctx.beginPath()
  ctx.arc(d.cx - d.headR * 0.42, eyeY, eyeR, 0, Math.PI * 2)
  ctx.arc(d.cx + d.headR * 0.42, eyeY, eyeR, 0, Math.PI * 2)
  ctx.fill()

  // Rectangular mouth panel, a little lighter than the head, set below the eyes.
  // A voice sine-wave readout will animate inside it later.
  const mouthW = d.headR * 1.02
  const mouthH = d.headR * 0.3
  const mouthY = d.headCenterY + d.headR * 0.42
  ctx.fillStyle = MOUTH
  ctx.beginPath()
  ctx.roundRect(d.cx - mouthW / 2, mouthY - mouthH / 2, mouthW, mouthH, d.headR * 0.08)
  ctx.fill()

  if (ambient > 0.001) {
    drawAmbientSparks(ctx, d, ambient, now)
  }
  ctx.restore()
}

function drawBowtie(ctx: CanvasRenderingContext2D, d: DealerBox): void {
  const cy = d.headCenterY + d.headR * 1.5 // on the upper chest, a bit down from the head
  const wingW = d.headR * 0.6
  const wingH = d.headR * 0.44
  const knot = d.headR * 0.15

  ctx.save()
  ctx.fillStyle = BOWTIE
  // Left wing — inner point pushed to the centre, inside the knot.
  ctx.beginPath()
  ctx.moveTo(d.cx, cy)
  ctx.lineTo(d.cx - wingW, cy - wingH / 2)
  ctx.lineTo(d.cx - wingW, cy + wingH / 2)
  ctx.closePath()
  ctx.fill()
  // Right wing — inner point pushed to the centre, inside the knot.
  ctx.beginPath()
  ctx.moveTo(d.cx, cy)
  ctx.lineTo(d.cx + wingW, cy - wingH / 2)
  ctx.lineTo(d.cx + wingW, cy + wingH / 2)
  ctx.closePath()
  ctx.fill()
  // Centre knot, over the pinched points.
  ctx.fillStyle = BOWTIE_KNOT
  ctx.beginPath()
  ctx.roundRect(d.cx - knot, cy - knot, knot * 2, knot * 2, knot * 0.4)
  ctx.fill()
  ctx.restore()
}

// Low-health sparks: a handful of fixed emitter points on the torso, each
// spitting a glowing fleck that rises and fades on its own repeating cycle. Time
// (not per-frame randomness) drives the cycle, so the sparks twinkle smoothly and
// scale in intensity with how low the dealer's health is.
const SPARK_EMITTERS = [
  { fx: -0.32, fy: 0.12 },
  { fx: 0.28, fy: 0.24 },
  { fx: -0.12, fy: 0.42 },
  { fx: 0.36, fy: -0.04 },
  { fx: 0.02, fy: 0.56 },
]

function drawAmbientSparks(ctx: CanvasRenderingContext2D, d: DealerBox, intensity: number, now: number): void {
  const w = d.bodyRight - d.bodyLeft
  const h = d.baseY - d.bodyTop
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < SPARK_EMITTERS.length; i++) {
    const e = SPARK_EMITTERS[i]
    const period = 620 - i * 45
    const life = ((now * (0.9 + 0.08 * i) + i * 190) % period) / period // 0..1 sawtooth
    const alpha = arch2(life) * intensity
    if (alpha <= 0.01) {
      continue
    }
    const rise = h * 0.14 * life
    const x = d.cx + e.fx * w * 0.5
    const y = d.bodyTop + e.fy * h - rise
    const r = Math.max(1.4, w * 0.022) * (0.6 + 0.4 * arch2(life))
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
    grad.addColorStop(0, `rgba(255, 225, 160, ${alpha})`)
    grad.addColorStop(0.4, `rgba(255, 150, 70, ${alpha * 0.6})`)
    grad.addColorStop(1, 'rgba(255, 120, 40, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(x, y, r * 3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// A white additive over-exposure of the figure on impact, fading with `flash`.
function drawHitFlash(ctx: CanvasRenderingContext2D, d: DealerBox, flash: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = clamp01(flash) * 0.8
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.roundRect(d.bodyLeft, d.bodyTop, d.bodyRight - d.bodyLeft, d.baseY - d.bodyTop, d.headR * 0.6)
  ctx.fill()
  ctx.beginPath()
  ctx.roundRect(d.cx - d.headR, d.headCenterY - d.headR, d.headR * 2, d.headR * 2, d.headR * 0.35)
  ctx.fill()
  ctx.restore()
}

// --- death: the figure breaks into chunks that blow outward and fall ----------

interface Chunk {
  x: number
  y: number
  w: number
  h: number
  r: number
  color: string
}

function buildChunks(d: DealerBox): Chunk[] {
  const chunks: Chunk[] = []
  // Head → 2×2 grid.
  const hx = d.cx - d.headR
  const hy = d.headCenterY - d.headR
  const hs = d.headR
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      chunks.push({ x: hx + c * hs, y: hy + r * hs, w: hs, h: hs, r: hs * 0.3, color: HEAD })
    }
  }
  // Torso → 3×2 grid.
  const bw = (d.bodyRight - d.bodyLeft) / 3
  const bh = (d.baseY - d.bodyTop) / 2
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      chunks.push({ x: d.bodyLeft + c * bw, y: d.bodyTop + r * bh, w: bw, h: bh, r: bw * 0.2, color: TORSO })
    }
  }
  return chunks
}

function drawDeath(ctx: CanvasRenderingContext2D, d: DealerBox, p: number, scale: number): void {
  const chunks = buildChunks(d)
  const centroidX = d.cx
  const centroidY = (d.headCenterY + d.baseY) / 2
  const lift = scale * 0.14
  const gravity = scale * 0.55
  const alpha = 1 - smoothStart2(clamp01((p - 0.6) / 0.4)) // solid, then fades in the last 40%

  ctx.save()
  ctx.globalAlpha = alpha
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i]
    const chx = ch.x + ch.w / 2
    const chy = ch.y + ch.h / 2
    let nx = chx - centroidX
    let ny = chy - centroidY
    const len = Math.hypot(nx, ny) || 1
    nx /= len
    ny /= len
    const speed = scale * (0.22 + 0.12 * ((i * 7) % 5) / 5)
    const ox = nx * speed * p
    const oy = ny * speed * p - lift * p + gravity * p * p
    const spin = (i % 2 === 0 ? 1 : -1) * (0.5 + 0.5 * ((i * 3) % 4) / 4) * p * 3

    ctx.save()
    ctx.translate(chx + ox, chy + oy)
    ctx.rotate(spin)
    ctx.fillStyle = ch.color
    ctx.beginPath()
    ctx.roundRect(-ch.w / 2, -ch.h / 2, ch.w, ch.h, ch.r)
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
