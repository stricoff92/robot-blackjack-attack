// The table nexus: a small device sitting on the right-centre of the felt with
// two emitter lenses — a RED one the damage laser fires from, and a YELLOW one the
// reward tokens lift off from. Mirrors the render convention — geometry + paint
// live here; the strike timing (a StrikeView) and the light charge (a
// NexusChargeView) are owned by the animators (ui).
//
// The device body is a PLACEHOLDER (a dark emitter box with two lenses); at rest
// both lenses sit dim, and the charge glow (drawn additively on the fx layer)
// brings them up when the nexus is about to act. The laser is a red additive beam
// modelled on the Analyze eye-beam (cards.ts).

import { arch2, smoothEnd2, smoothStart3 } from './easing'
import { dealerBox, type Layout } from './scene'
import type { Point } from './tokens'

// The nexus sits in the empty mid-right felt band: below the shoe (top-right of
// centre) and the health bar (top-right), above the bankroll pile (bottom-right),
// clear of the centred cards + bet circle. This is the device's centre; the two
// emitter lenses straddle it (see nexusRedLight / nexusYellowLight).
export function nexusAnchor(l: Layout): Point {
  return { x: l.width * 0.82, y: l.edgeY + (l.height - l.edgeY) * 0.5 }
}

// Shared body geometry, so the drawn device and the two emitter-light positions
// never drift apart. The box is deliberately wide enough to seat two lenses side
// by side.
interface NexusGeom {
  a: Point // device centre
  w: number
  h: number
  r: number // body corner radius
  lensR: number
  lensY: number // both lenses share this y
  dx: number // half the gap between the two lenses
}

function nexusGeom(l: Layout): NexusGeom {
  const a = nexusAnchor(l)
  const scale = Math.min(l.width, l.height)
  const w = clamp(scale * 0.13, 56, 124)
  const h = w * 0.52
  return {
    a,
    w,
    h,
    r: h * 0.24,
    lensR: h * 0.22,
    lensY: a.y - h * 0.05,
    dx: w * 0.22,
  }
}

// The RED emitter: the muzzle the damage laser fires from (left lens, dealer side).
export function nexusRedLight(l: Layout): Point {
  const g = nexusGeom(l)
  return { x: g.a.x - g.dx, y: g.lensY }
}

// The YELLOW emitter: where the reward tokens lift off from (right lens).
export function nexusYellowLight(l: Layout): Point {
  const g = nexusGeom(l)
  return { x: g.a.x + g.dx, y: g.lensY }
}

// Where the laser lands on the dealer: the centre of its torso (a solid target
// that reads even while the figure shakes). Derived from the shared dealerBox so
// it tracks the figure's layout on resize.
function impactPoint(l: Layout): Point {
  const d = dealerBox(l)
  return { x: d.cx, y: d.bodyTop + (d.baseY - d.bodyTop) * 0.32 }
}

// --- the device body (static, on the table layer) ----------------------------

export function drawNexus(ctx: CanvasRenderingContext2D, l: Layout): void {
  const g = nexusGeom(l)
  const { a, w, h, r } = g

  ctx.save()

  // Soft contact shadow on the felt.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)'
  ctx.beginPath()
  ctx.ellipse(a.x, a.y + h * 0.5, w * 0.55, h * 0.28, 0, 0, Math.PI * 2)
  ctx.fill()

  // Body: a dark brushed-metal box.
  const body = ctx.createLinearGradient(a.x, a.y - h / 2, a.x, a.y + h / 2)
  body.addColorStop(0, '#3a4152')
  body.addColorStop(0.5, '#242833')
  body.addColorStop(1, '#15181f')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.roundRect(a.x - w / 2, a.y - h / 2, w, h, r)
  ctx.fill()
  ctx.lineWidth = Math.max(1, w * 0.02)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.stroke()

  // The two emitter lenses, seated in dark sockets on the top face and idling dim
  // — the red laser muzzle and the yellow token vent. The charge glow (fx layer)
  // brings them up to full when the nexus is about to act.
  drawDimLens(ctx, a.x - g.dx, g.lensY, g.lensR, RED_LENS)
  drawDimLens(ctx, a.x + g.dx, g.lensY, g.lensR, YELLOW_LENS)

  ctx.restore()
}

// The dim, idle look of a lens: a dark socket with a muted core — barely lit, so
// the additive charge glow reads as the light powering up.
interface LensStyle {
  core: string
  mid: string
  edge: string
  rim: string
}
const RED_LENS: LensStyle = { core: '#8a3232', mid: '#571c1c', edge: '#230c0c', rim: 'rgba(255, 130, 130, 0.16)' }
const YELLOW_LENS: LensStyle = { core: '#8a7a30', mid: '#574a18', edge: '#231e0a', rim: 'rgba(255, 225, 140, 0.16)' }

function drawDimLens(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, s: LensStyle): void {
  // Dark socket the lens is recessed into.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.beginPath()
  ctx.arc(cx, cy, r * 1.14, 0, Math.PI * 2)
  ctx.fill()

  // The dim lens itself, lit from the upper-left.
  const lens = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.1, cx, cy, r)
  lens.addColorStop(0, s.core)
  lens.addColorStop(0.55, s.mid)
  lens.addColorStop(1, s.edge)
  ctx.fillStyle = lens
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  // Faint rim so the lens edge catches a little light even when idle.
  ctx.lineWidth = Math.max(1, r * 0.12)
  ctx.strokeStyle = s.rim
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
}

// --- the laser strike (transient, on the fx layer) ---------------------------

export interface StrikeView {
  // The beam's head-of-travel (0..1 from nexus to dealer) + its opacity, or null.
  beam(now: number): { travel: number; alpha: number } | null
  // The muzzle flash pulse at the nexus (0..1), or null.
  muzzle(now: number): number | null
  // The impact spark burst at the dealer (0..1), or null.
  impactSpark(now: number): number | null
}

export function drawStrikeFx(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  view: StrikeView,
  charge: { red: number; yellow: number; vent: number | null; chargeUp: { start: number; cap: number } | null },
  now: number,
): void {
  ctx.clearRect(0, 0, l.width, l.height)
  const from = nexusRedLight(l)
  const to = impactPoint(l)
  const scale = Math.min(l.width, l.height)

  // Cooling steam venting from the two sides after the strike. Drawn first (plain
  // vapour, below the additive lights) so a still-fading red glow reads over it.
  if (charge.vent !== null) {
    drawNexusVent(ctx, l, charge.vent, scale)
  }

  // "Powering up": red energy balls drawn in from around the red light while it
  // charges an attack. Under the light glow so they read as being absorbed by it.
  if (charge.chargeUp !== null) {
    drawChargeUp(ctx, l, charge.chargeUp.start, charge.chargeUp.cap, now)
  }

  // The emitter lenses glowing — the red laser muzzle and the yellow token vent,
  // each on its own level (anticipation, firing, or the yellow's hit pulse). Drawn
  // first so the beam's muzzle flash (also at the red lens) still punches over it.
  if (charge.red > 0.001 || charge.yellow > 0.001) {
    const g = nexusGeom(l)
    if (charge.red > 0.001) {
      drawLightCharge(ctx, from.x, from.y, g.lensR, charge.red, RED_GLOW)
    }
    if (charge.yellow > 0.001) {
      const yellow = nexusYellowLight(l)
      drawLightCharge(ctx, yellow.x, yellow.y, g.lensR, charge.yellow, YELLOW_GLOW)
    }
  }

  const beam = view.beam(now)
  if (beam) {
    drawBeam(ctx, from, to, beam.travel, beam.alpha, scale)
  }
  const muzzle = view.muzzle(now)
  if (muzzle !== null && muzzle > 0.001) {
    drawGlow(ctx, from.x, from.y, scale * 0.09 * (0.6 + 0.4 * muzzle), muzzle)
  }
  const spark = view.impactSpark(now)
  if (spark !== null && spark > 0.001) {
    drawGlow(ctx, to.x, to.y, scale * 0.06 * arch2(spark) + scale * 0.02, arch2(spark))
    drawSparkSpray(ctx, to.x, to.y, spark, scale)
  }
}

// A red energy beam: an outer glow plus a hot white core, drawn additively so it
// reads as light. The head advances with `travel` (the strike-on), the whole
// thing fading as `alpha` drops (the strike-off).
function drawBeam(ctx: CanvasRenderingContext2D, from: Point, to: Point, travel: number, alpha: number, scale: number): void {
  const hx = from.x + (to.x - from.x) * travel
  const hy = from.y + (to.y - from.y) * travel
  const outer = clamp(scale * 0.02, 5, 16)

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  const grad = ctx.createLinearGradient(from.x, from.y, hx, hy)
  grad.addColorStop(0, `rgba(255, 70, 70, ${alpha * 0.18})`)
  grad.addColorStop(1, `rgba(255, 120, 120, ${alpha * 0.55})`)
  ctx.strokeStyle = grad
  ctx.lineWidth = outer
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(hx, hy)
  ctx.stroke()

  ctx.strokeStyle = `rgba(255, 225, 225, ${alpha * 0.9})`
  ctx.lineWidth = outer * 0.34
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(hx, hy)
  ctx.stroke()
  ctx.restore()
}

// An emitter lens powering up: a hot additive core filling the lens plus an outer
// bloom that swells with `level` (0 dim .. 1 fully lit). Added over the dim base
// lens on the table layer, so the light reads as glowing on. `bloom` scales the
// halo's reach and `intensity` its brightness — the RED laser muzzle runs both hot
// so its blast reads far more dramatic than the yellow token vent.
interface GlowStyle {
  core: string // "rgba(r, g, b," — alpha is appended per stop
  halo: string
  hot: string // the white-hot centre struck at full charge
  bloom: number
  intensity: number
}
const RED_GLOW: GlowStyle = {
  core: 'rgba(255, 150, 140,',
  halo: 'rgba(255, 60, 45,',
  hot: 'rgba(255, 240, 235,',
  bloom: 1.7,
  intensity: 1.35,
}
const YELLOW_GLOW: GlowStyle = {
  core: 'rgba(255, 236, 150,',
  halo: 'rgba(255, 200, 60,',
  hot: 'rgba(255, 250, 225,',
  bloom: 1.0,
  intensity: 1.0,
}

function drawLightCharge(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, level: number, s: GlowStyle): void {
  const a = clamp01(level)
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'

  // Outer bloom, growing as the light charges.
  const bloomR = r * (1.2 + 0.9 * a) * s.bloom
  const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloomR)
  bloom.addColorStop(0, `${s.halo} ${clamp01(0.5 * a * s.intensity)})`)
  bloom.addColorStop(0.5, `${s.halo} ${clamp01(0.22 * a * s.intensity)})`)
  bloom.addColorStop(1, `${s.halo} 0)`)
  ctx.fillStyle = bloom
  ctx.beginPath()
  ctx.arc(cx, cy, bloomR, 0, Math.PI * 2)
  ctx.fill()

  // Hot core filling the lens.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  core.addColorStop(0, `${s.core} ${clamp01(0.95 * a * s.intensity)})`)
  core.addColorStop(0.6, `${s.core} ${clamp01(0.5 * a * s.intensity)})`)
  core.addColorStop(1, `${s.core} 0)`)
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  // A white-hot pinprick at the centre once the light nears full — the extra punch
  // that sells the red blast (barely there at the anticipation glow).
  const hot = clamp01((a - 0.55) / 0.45) * s.intensity
  if (hot > 0.001) {
    const dot = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.7)
    dot.addColorStop(0, `${s.hot} ${clamp01(0.85 * hot)})`)
    dot.addColorStop(1, `${s.hot} 0)`)
    ctx.fillStyle = dot
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

// --- the cooling vent (transient steam, on the fx layer) ---------------------

// After the laser fires, the nexus vents cooling steam from its two sides for
// VENT_MS. It's a deterministic puff system (like the impact spark spray): each
// puff's spawn time, direction, speed and life are a fixed function of its index,
// so it never jitters frame-to-frame. `age` is ms since venting began.
const VENT_EMIT_MS = 1000 // keep spawning puffs across this window (matches the animator)
const VENT_SPAWN_MS = 24 // a fresh puff every this-many ms, per side
const PUFF_MIN_LIFE = 100 // each puff fades out within 100..200ms of spawning
const PUFF_MAX_LIFE = 200

function drawNexusVent(ctx: CanvasRenderingContext2D, l: Layout, age: number, scale: number): void {
  const g = nexusGeom(l)
  const ventY = g.a.y - g.h * 0.14
  const reach = scale * 0.1 // decent velocity: puffs cover this in their short life
  const puffR = scale * 0.014
  ctx.save()
  ventSide(ctx, g.a.x - g.w * 0.5, ventY, -1, age, reach, puffR)
  ventSide(ctx, g.a.x + g.w * 0.5, ventY, 1, age, reach, puffR)
  ctx.restore()
}

function ventSide(ctx: CanvasRenderingContext2D, ox: number, oy: number, dir: number, age: number, reach: number, puffR: number): void {
  const seed = dir > 0 ? 17 : 4
  const count = Math.ceil(VENT_EMIT_MS / VENT_SPAWN_MS)
  for (let i = 0; i < count; i++) {
    const spawn = i * VENT_SPAWN_MS
    const local = age - spawn
    if (local < 0) {
      break // this puff (and all later ones) haven't spawned yet
    }
    const life = PUFF_MIN_LIFE + hash(i, seed) * (PUFF_MAX_LIFE - PUFF_MIN_LIFE)
    if (local >= life) {
      continue
    }
    const p = local / life
    // Fan out and upward, outward from the vent side (dir), with per-puff spread.
    const theta = (20 + hash(i, seed + 1) * 50) * (Math.PI / 180)
    const speed = 0.7 + hash(i, seed + 2) * 0.6
    const dist = reach * speed * smoothEndFast(p)
    const x = ox + dir * Math.cos(theta) * dist
    const y = oy - Math.sin(theta) * dist
    const radius = puffR * (0.7 + 1.3 * p) // puffs swell as they disperse
    // Quick appearance, then fade — a soft grey vapour blob.
    const alpha = Math.min(1, p * 5) * (1 - p) * 0.5
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
    grad.addColorStop(0, `rgba(228, 236, 244, ${alpha})`)
    grad.addColorStop(1, 'rgba(205, 220, 235, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
}

// Cheap deterministic hash → [0, 1), so puff attributes are stable per index.
function hash(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// Ease-out for the puff distance (fast off the vent, then coasts).
function smoothEndFast(t: number): number {
  const u = 1 - t
  return 1 - u * u
}

// --- the "powering up" charge (transient, on the fx layer) -------------------

// While the red light charges an attack it draws in a stream of red energy balls
// that spawn out around it and rush into its centre — the anime gun-charge look.
// Deterministic per ball index (like the vent), so no frame-to-frame jitter. Balls
// spawn every CHARGE_SPAWN_MS from `start` up to `cap` (which advances with `now`
// while charging, then freezes at the Next-hand click so no new balls appear —
// though in-flight ones still finish). Each lives CHARGE_*_LIFE_MS.
const CHARGE_SPAWN_MS = 140 // sparse — only a few balls converging at once
const CHARGE_MIN_LIFE_MS = 460
export const CHARGE_MAX_LIFE_MS = 820
// The final "absorbed" beat: once a ball reaches the centre it spends its last
// 150..200ms blooming to POP_SCALE of its size as it fades — a little burst of it
// being drawn into the light.
const CHARGE_POP_MIN_MS = 150
const CHARGE_POP_MAX_MS = 200
const CHARGE_POP_SCALE = 2.5

function drawChargeUp(ctx: CanvasRenderingContext2D, l: Layout, start: number, cap: number, now: number): void {
  const c = nexusRedLight(l)
  const g = nexusGeom(l)
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  // Only balls that could be alive now: spawned within the last MAX_LIFE, and no
  // later than `cap`. That keeps this a small fixed window however long the charge.
  const kEnd = Math.floor((Math.min(now, cap) - start) / CHARGE_SPAWN_MS)
  const kStart = Math.max(0, Math.ceil((now - CHARGE_MAX_LIFE_MS - start) / CHARGE_SPAWN_MS))
  for (let k = kStart; k <= kEnd; k++) {
    const age = now - (start + k * CHARGE_SPAWN_MS)
    const life = CHARGE_MIN_LIFE_MS + hash(k, 91) * (CHARGE_MAX_LIFE_MS - CHARGE_MIN_LIFE_MS)
    if (age < 0 || age >= life) {
      continue
    }
    // Random (but stable) start point on a ring around the light + base size.
    const angle = hash(k, 13) * Math.PI * 2
    const dist = g.lensR * (2.2 + hash(k, 29) * 2.6)
    const sx = c.x + Math.cos(angle) * dist
    const sy = c.y + Math.sin(angle) * dist
    const baseR = g.lensR * (0.3 + hash(k, 47) * 0.45)

    // The ball rushes to the centre over most of its life, then spends its final
    // 150..200ms there: pinned, blooming to POP_SCALE while it fades out.
    const popTtl = CHARGE_POP_MIN_MS + hash(k, 61) * (CHARGE_POP_MAX_MS - CHARGE_POP_MIN_MS)
    const travelEnd = Math.max(1, life - popTtl)

    if (age < travelEnd) {
      // Rush toward the centre — smoothStart3, so it hangs, then snaps sharply in.
      const tp = age / travelEnd
      const traveled = smoothStart3(tp)
      const x = sx + (c.x - sx) * traveled
      const y = sy + (c.y - sy) * traveled
      drawEnergyBall(ctx, x, y, baseR, smoothEnd2(clamp01(tp / 0.35))) // fade in
    } else {
      // Absorbed: bloom out from the centre (smoothEnd — bursts fast) and fade.
      const sp = clamp01((age - travelEnd) / popTtl)
      const radius = baseR * (1 + (CHARGE_POP_SCALE - 1) * smoothEnd2(sp))
      drawEnergyBall(ctx, c.x, c.y, radius, 1 - sp)
    }
  }
  ctx.restore()
}

// A crisp energy orb, drawn additively so it reads as light being gathered: a soft
// red halo with a small, well-defined white-hot core punched over it — the core is
// what keeps the ball sharp rather than a fuzzy smear.
function drawEnergyBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
  const a = clamp01(alpha)
  if (a <= 0.001) {
    return
  }
  // Soft red halo.
  const halo = ctx.createRadialGradient(x, y, 0, x, y, r)
  halo.addColorStop(0, `rgba(255, 120, 92, ${0.55 * a})`)
  halo.addColorStop(0.6, `rgba(240, 55, 42, ${0.24 * a})`)
  halo.addColorStop(1, 'rgba(225, 40, 30, 0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()

  // Crisp white-hot core: bright and near-solid out to most of its radius, then a
  // quick edge — a defined disc, not a gradient blur.
  const cr = r * 0.55
  const core = ctx.createRadialGradient(x, y, 0, x, y, cr)
  core.addColorStop(0, `rgba(255, 247, 238, ${a})`)
  core.addColorStop(0.62, `rgba(255, 178, 138, ${0.95 * a})`)
  core.addColorStop(1, 'rgba(255, 120, 88, 0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(x, y, cr, 0, Math.PI * 2)
  ctx.fill()
}

// A soft additive radial flash (muzzle / impact bloom).
function drawGlow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, alpha: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  grad.addColorStop(0, `rgba(255, 210, 180, ${clamp01(alpha) * 0.9})`)
  grad.addColorStop(0.4, `rgba(255, 90, 70, ${clamp01(alpha) * 0.5})`)
  grad.addColorStop(1, 'rgba(255, 60, 40, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// A short-lived spray of flecks radiating from the impact point. Directions are
// deterministic (golden-angle spread) so they don't jitter frame-to-frame;
// distance + fade ride the burst progress.
const SPARK_COUNT = 12
const GOLDEN_ANGLE = 2.399963

function drawSparkSpray(ctx: CanvasRenderingContext2D, cx: number, cy: number, p: number, scale: number): void {
  const reach = scale * 0.14
  const len = scale * 0.03
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(1.5, scale * 0.006)
  for (let i = 0; i < SPARK_COUNT; i++) {
    const angle = i * GOLDEN_ANGLE
    const spread = 0.6 + 0.4 * ((i * 7) % 11) / 11 // varied reach per fleck
    const dist = reach * spread * smoothEndDist(p)
    const x = cx + Math.cos(angle) * dist
    const y = cy + Math.sin(angle) * dist
    const tx = cx + Math.cos(angle) * (dist + len)
    const ty = cy + Math.sin(angle) * (dist + len)
    ctx.strokeStyle = `rgba(255, ${170 + ((i * 13) % 60)}, 120, ${(1 - p) * 0.9})`
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(tx, ty)
    ctx.stroke()
  }
  ctx.restore()
}

// Ease-out for the fleck distance (fast burst then coast) without importing a
// combinator — the spray is the one place we want a bespoke curve.
function smoothEndDist(t: number): number {
  const u = 1 - t
  return 1 - u * u
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
