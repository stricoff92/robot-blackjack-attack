// Diegetic dealer damage: sparks + smoke that burst off the robot as it takes
// damage, standing in for the (removed) health bar. Nothing shows above 75%
// health; from 75% → 0% the bursts fire more often and denser, so a badly wounded
// dealer visibly shorts out. Each burst erupts from a spot on the figure: the sparks
// fire as a CONE in one random direction (a directional jet, re-rolled per burst) and
// arc out hot under gravity; the smoke puffs drift out every which way and buoy upward.
//
// Geometry + paint only (mirrors dealer.ts / health.ts): the timing lives in the
// dealer animator, which hands us a list of active bursts (each an age + intensity
// + seed). Everything here is a pure function of that — no persisted particle
// state — so it survives a resize and the frozen-clock probe. Drawn on the 'dealer'
// layer, over the figure but behind the rail, so downward sparks tuck behind the
// table exactly as the robot's lower body does.

import { dealerBox, type DealerBox, type Layout } from './scene'

// One burst of sparks + smoke, as reported by the animator for the current frame.
export interface DamageBurstState {
  age: number // ms since this burst fired
  power: number // 0..1 damage intensity — scales particle count, size, and reach
  seed: number // integer; seeds the (deterministic) origin + per-particle spread
}

// Particle lifetimes (ms). The animator's burst window must outlast the longest of
// these (× the jitter cap below) so a burst isn't dropped while smoke still lingers.
const SPARK_LIFE = 480
const SMOKE_LIFE = 880
const LIFE_JITTER = 0.5 // per-particle life = base × (1 - J/2 .. 1 + J/2), so cap ≈ 1.25×
const SPARK_CONE = 1.3 // total fan width (rad, ~75°) a burst's sparks spread across its centre angle

export function drawDamageFx(ctx: CanvasRenderingContext2D, layout: Layout, bursts: readonly DamageBurstState[]): void {
  if (bursts.length === 0) {
    return
  }
  const d = dealerBox(layout)
  const scale = Math.min(layout.width, layout.height)

  // Smoke first, under the sparks, as a normal-blend wash; then the sparks on top,
  // drawn additively so overlapping streaks read as hot light.
  ctx.save()
  for (const b of bursts) {
    drawSmoke(ctx, d, scale, b)
  }
  ctx.restore()

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  for (const b of bursts) {
    drawSparks(ctx, d, scale, b)
  }
  ctx.restore()
}

// Where on the figure this burst erupts: a seeded point across the head + shoulders /
// upper chest — the part of the silhouette clearly above the rail, so bursts read as
// coming off the visible robot rather than from behind the table.
function emitOrigin(d: DealerBox, seed: number): { x: number; y: number } {
  const bodyW = d.bodyRight - d.bodyLeft
  const topY = d.headCenterY - d.headR * 0.9
  const botY = d.headCenterY + d.headR * 1.6
  return {
    x: d.cx + (rand(seed, -1, 0) - 0.5) * bodyW * 0.85,
    y: topY + (botY - topY) * rand(seed, -1, 1),
  }
}

// A jet of hot sparks fired in a cone from the burst origin, arcing under gravity and
// cooling white → orange → red as they fade. The cone's centre is a per-burst random
// angle; the sparks fan within SPARK_CONE of it. Count + reach grow with power.
function drawSparks(ctx: CanvasRenderingContext2D, d: DealerBox, scale: number, b: DamageBurstState): void {
  const origin = emitOrigin(d, b.seed)
  const count = Math.round(4 + b.power * 6) // 4 (barely hurt) → 10 (near death)
  const gravity = scale * 0.11
  const center = rand(b.seed, -2, 0) * Math.PI * 2 // this burst's jet direction
  for (let i = 0; i < count; i++) {
    const life = SPARK_LIFE * (1 + (rand(b.seed, i, 2) - 0.5) * LIFE_JITTER)
    const t = b.age / life
    if (t < 0 || t >= 1) {
      continue
    }
    const ang = center + (rand(b.seed, i, 0) - 0.5) * SPARK_CONE
    const reach = scale * 0.06 * (0.6 + rand(b.seed, i, 1) * 0.8) * (0.7 + b.power * 0.5)
    const vx = Math.cos(ang) * reach
    const vy = Math.sin(ang) * reach
    const px = origin.x + vx * t
    const py = origin.y + vy * t + gravity * t * t

    // The streak trails opposite the current velocity (the spark's motion direction),
    // so it flicks the way it's actually flying rather than straight back at the origin.
    const dvx = vx
    const dvy = vy + 2 * gravity * t
    const dlen = Math.hypot(dvx, dvy) || 1
    const len = scale * 0.014 * (1 - t * 0.5)
    const tailX = px - (dvx / dlen) * len
    const tailY = py - (dvy / dlen) * len

    const fade = 1 - t
    const g = Math.round(235 - 150 * t)
    const bl = Math.round(140 - 130 * t)
    ctx.strokeStyle = `rgba(255, ${g}, ${bl}, ${fade})`
    ctx.lineWidth = Math.max(1, scale * 0.0026) * (0.6 + fade * 0.6)
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(px, py)
    ctx.stroke()
  }
}

// Soft grey puffs that shoot out with the sparks, then buoy upward and swell as they
// thin out — the smoke off a shorting machine. Fewer, slower, and longer-lived than the
// sparks; count grows with power.
function drawSmoke(ctx: CanvasRenderingContext2D, d: DealerBox, scale: number, b: DamageBurstState): void {
  const origin = emitOrigin(d, b.seed)
  const count = Math.round(1 + b.power * 3) // 1 → 4 puffs
  const rise = scale * 0.07
  for (let j = 0; j < count; j++) {
    const life = SMOKE_LIFE * (1 + (rand(b.seed, j, 5) - 0.5) * LIFE_JITTER)
    const t = b.age / life
    if (t < 0 || t >= 1) {
      continue
    }
    const ang = rand(b.seed, j, 3) * Math.PI * 2
    const reach = scale * 0.045 * (0.5 + rand(b.seed, j, 4) * 0.7)
    const px = origin.x + Math.cos(ang) * reach * t
    const py = origin.y + Math.sin(ang) * reach * t - rise * t * t // buoys upward (canvas −y)
    const radius = scale * 0.0095 * (0.6 + t * 2.2)
    // Fade in over the first fifth, then ease out — a puff that blooms and dissipates.
    const alpha = 0.44 * b.power * (t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8)
    if (alpha <= 0.003) {
      continue
    }
    // A lighter grey than the near-black head, with a denser core, so it reads against
    // both the figure and the dark room.
    const grad = ctx.createRadialGradient(px, py, 0, px, py, radius)
    grad.addColorStop(0, `rgba(102, 105, 118, ${alpha})`)
    grad.addColorStop(0.55, `rgba(94, 97, 110, ${alpha * 0.55})`)
    grad.addColorStop(1, 'rgba(94, 97, 110, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, Math.PI * 2)
    ctx.fill()
  }
}

// Deterministic 0..1 hash — three independent streams keyed by (seed, particle index,
// salt). Sine-hash, matching the house style (nexus.ts / spawn.ts): no Math.random, so a
// burst is a pure function of its seed and every frame/probe reproduces it identically.
function rand(seed: number, i: number, salt: number): number {
  const x = Math.sin(seed * 12.9898 + i * 78.233 + salt * 37.719) * 43758.5453
  return x - Math.floor(x)
}
