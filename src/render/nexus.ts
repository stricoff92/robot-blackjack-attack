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

import { arch2, smoothEnd2, smoothEnd3, smoothStart3 } from './easing'
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

// The device never rests on the felt — it floats in a slow, perpetual hover.
// `hoverLift` is how far (px) it sits above its base at `now`, oscillating gently
// between HOVER_MIN and HOVER_MAX of its body height. Everything that reads the
// device's position — the body, the two emitter lenses, the laser muzzle, the token
// vent — subtracts this same lift, so they rise and fall as one and the laser always
// fires from the muzzle wherever it currently floats (no separate beam-origin to
// drift). The contact shadow (drawNexus) instead stays pinned to the felt, spreading
// and fading as the device climbs.
const HOVER_PERIOD_MS = 3400
const HOVER_MIN = 0.4 // low point of the bob, as a fraction of body height h
const HOVER_MAX = 0.72 // high point of the bob

function hoverLift(g: NexusGeom, now: number): number {
  const phase = (Math.sin((now / HOVER_PERIOD_MS) * Math.PI * 2) + 1) * 0.5 // 0..1
  return g.h * (HOVER_MIN + (HOVER_MAX - HOVER_MIN) * phase)
}

// The RED emitter: the muzzle the damage laser fires from (left lens, dealer side),
// lifted to wherever the device is floating at `now`.
export function nexusRedLight(l: Layout, now: number): Point {
  const g = nexusGeom(l)
  return { x: g.a.x - g.dx, y: g.lensY - hoverLift(g, now) }
}

// The YELLOW emitter: where the reward tokens lift off from (right lens), floating
// with the device at `now`.
export function nexusYellowLight(l: Layout, now: number): Point {
  const g = nexusGeom(l)
  return { x: g.a.x + g.dx, y: g.lensY - hoverLift(g, now) }
}

// Where the laser lands on the dealer: the centre of its torso (a solid target
// that reads even while the figure shakes). Derived from the shared dealerBox so
// it tracks the figure's layout on resize.
function impactPoint(l: Layout): Point {
  const d = dealerBox(l)
  return { x: d.cx, y: d.bodyTop + (d.baseY - d.bodyTop) * 0.32 }
}

// --- the floating device body (transient, on the fx layer) -------------------
// The device hovers, so — unlike the felt/rail — it can't live on the static table
// layer; it's repainted every frame on the fx layer (drawStrikeFx), bobbing with
// `now`, beneath its own charge glow + laser.

export function drawNexus(ctx: CanvasRenderingContext2D, l: Layout, now: number): void {
  const g = nexusGeom(l)
  const { a, w, h, r } = g
  const lift = hoverLift(g, now)
  const cy = a.y - lift // the floating body's centre

  ctx.save()

  // A soft shadow blob on the felt, a little smaller than the body and pinned under
  // its base. It's a radial gradient (not a hard disc) so the edge reads as a real,
  // diffuse shadow. As the device climbs it spreads a touch and dims — the subtle
  // "further from the surface" cue — but only gently, so the bob doesn't make the
  // shadow visibly throb. `t` is the bob phase: 0 at the low point, 1 at the high.
  const t = (lift / h - HOVER_MIN) / (HOVER_MAX - HOVER_MIN)
  const rx = w * 0.4 * (1 + t * 0.16)
  const ry = w * 0.12 * (1 + t * 0.16)
  const alpha = 0.34 - t * 0.1 // 0.34 (low, tighter/darker) .. 0.24 (high, softer)
  ctx.save()
  ctx.translate(a.x, a.y + h * 0.46)
  ctx.scale(1, ry / rx) // squash the circular gradient into a flat felt ellipse
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  shadow.addColorStop(0, `rgba(0, 0, 0, ${alpha})`)
  shadow.addColorStop(0.55, `rgba(0, 0, 0, ${alpha * 0.55})`)
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = shadow
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // Body: a dark brushed-metal box, lifted to its floating height.
  const body = ctx.createLinearGradient(a.x, cy - h / 2, a.x, cy + h / 2)
  body.addColorStop(0, '#3a4152')
  body.addColorStop(0.5, '#242833')
  body.addColorStop(1, '#15181f')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.roundRect(a.x - w / 2, cy - h / 2, w, h, r)
  ctx.fill()
  ctx.lineWidth = Math.max(1, w * 0.02)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.stroke()

  // The two emitter lenses, seated in dark sockets on the top face and idling dim
  // — the red laser muzzle and the yellow token vent. The charge glow (fx layer)
  // brings them up to full when the nexus is about to act. Lifted with the body.
  drawDimLens(ctx, a.x - g.dx, g.lensY - lift, g.lensR, RED_LENS)
  drawDimLens(ctx, a.x + g.dx, g.lensY - lift, g.lensR, YELLOW_LENS)

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
  charge: {
    red: number
    yellow: number
    chargeUp: { start: number; cap: number } | null
    healBeam: { travel: number; alpha: number } | null
  },
  now: number,
): void {
  ctx.clearRect(0, 0, l.width, l.height)
  // The floating device body itself — it hovers, so it rides this per-frame layer
  // rather than the static table, drawn under its charge glow + laser below.
  drawNexus(ctx, l, now)
  const from = nexusRedLight(l, now)
  const to = impactPoint(l)
  const scale = Math.min(l.width, l.height)

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
      const yellow = nexusYellowLight(l, now)
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
    drawSparkBurst(ctx, to.x, to.y, spark, scale)
  }

  // The yellow heal beam (a late dealer repairing itself after a win): a gentle
  // green-gold stream from the YELLOW emitter to the dealer, opposite in feel to the
  // red laser. Never overlaps a strike — a heal is a loss, a strike is a win.
  if (charge.healBeam) {
    const heal = nexusYellowLight(l, now)
    drawHealBeam(ctx, heal, to, charge.healBeam.travel, charge.healBeam.alpha, scale, now)
  }
}

// A restorative beam from the yellow emitter: a soft green-gold glow with a warm
// (not hot) core, healing motes streaming up it toward the dealer, and a gentle
// aura blooming on the dealer once it lands. Drawn additively like the laser, but
// softer and cooler-edged so it reads as nourishing light, not a blast. `travel`
// advances the head nexus → dealer; `alpha` fades the whole thing on the wind-down.
function drawHealBeam(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  travel: number,
  alpha: number,
  scale: number,
  now: number,
): void {
  const hx = from.x + (to.x - from.x) * travel
  const hy = from.y + (to.y - from.y) * travel
  const outer = clamp(scale * 0.022, 5, 18)

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  // Soft green-gold outer glow, brightening toward the head.
  const grad = ctx.createLinearGradient(from.x, from.y, hx, hy)
  grad.addColorStop(0, `rgba(150, 240, 130, ${alpha * 0.16})`)
  grad.addColorStop(1, `rgba(180, 255, 150, ${alpha * 0.42})`)
  ctx.strokeStyle = grad
  ctx.lineWidth = outer
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(hx, hy)
  ctx.stroke()

  // A warm white-green core — thinner and gentler than the laser's hot white spine.
  ctx.strokeStyle = `rgba(235, 255, 215, ${alpha * 0.78})`
  ctx.lineWidth = outer * 0.3
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(hx, hy)
  ctx.stroke()

  // Healing motes flowing up the beam toward the dealer — energy being delivered.
  // Each cycles along the beam on a shared clock at its own hashed phase + lane, so
  // the stream is deterministic per frame (no Math.random) yet visibly moves.
  const dx = hx - from.x
  const dy = hy - from.y
  const len = Math.hypot(dx, dy)
  if (len > 1) {
    const nx = dx / len
    const ny = dy / len
    const perpX = -ny
    const perpY = nx
    const MOTES = 7
    for (let i = 0; i < MOTES; i++) {
      const phase = (now / 900 + hash(i, 17)) % 1
      const along = phase * len
      const fade = Math.sin(phase * Math.PI) // fade in/out at the beam's ends
      const off = (hash(i, 33) - 0.5) * outer * 0.7
      const mx = from.x + nx * along + perpX * off
      const my = from.y + ny * along + perpY * off
      const r = outer * (0.14 + hash(i, 51) * 0.16)
      const a = alpha * 0.9 * fade
      const m = ctx.createRadialGradient(mx, my, 0, mx, my, r)
      m.addColorStop(0, `rgba(240, 255, 220, ${a})`)
      m.addColorStop(1, 'rgba(160, 240, 140, 0)')
      ctx.fillStyle = m
      ctx.beginPath()
      ctx.arc(mx, my, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // A soft restorative aura blooming on the dealer once the beam has landed, plus a
  // fountain of green sparks shooting off the impact point.
  if (travel >= 0.999) {
    const auraR = scale * 0.07
    const aura = ctx.createRadialGradient(to.x, to.y, 0, to.x, to.y, auraR)
    aura.addColorStop(0, `rgba(205, 255, 190, ${alpha * 0.5})`)
    aura.addColorStop(0.5, `rgba(130, 240, 130, ${alpha * 0.22})`)
    aura.addColorStop(1, 'rgba(120, 230, 120, 0)')
    ctx.fillStyle = aura
    ctx.beginPath()
    ctx.arc(to.x, to.y, auraR, 0, Math.PI * 2)
    ctx.fill()

    drawHealSparks(ctx, to.x, to.y, alpha, scale, now)
  }

  ctx.restore()
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

// Cheap deterministic hash → [0, 1), so per-index attributes (energy balls, spark
// flecks) are stable frame-to-frame.
function hash(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// --- the "powering up" charge (transient, on the fx layer) -------------------

// While the red light charges an attack it draws in a stream of red energy balls
// that spawn out around it and rush into its centre — the anime gun-charge look.
// Deterministic per ball index (via hash()), so no frame-to-frame jitter. Balls
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
  const c = nexusRedLight(l, now)
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

// A Power Rangers–style pyrotechnic spark shower bursting off the impact point:
// a cloud of hot flecks thrown outward when the laser lands, each on its own
// random heading to its own random distance, streaking out fast then raining down.
//
//   • outward travel rides smoothEnd3(p) — a hard burst that decelerates to rest;
//   • the flecks fade out on smoothEnd2(p) (i.e. 1 − smoothEnd2, a fast dim then
//     a faint tail), matching the "fade to 0" curve used elsewhere in this file;
//   • a light gravity droop grows with p² so the shower arcs down as it dies.
//
// The per-spark "rand" for heading + distance comes from the deterministic hash()
// (not Math.random), so — like the charge system — the whole burst is a pure
// function of `p` and never jitters frame-to-frame.
const SPARK_COUNT = 28
const SPARK_GRAVITY = 0.06 // downward droop at full life, as a fraction of `scale`

const HEAL_SPARK_COUNT = 16
const HEAL_SPARK_PERIOD_MS = 640 // one heal spark's fly-out-and-fade lifetime
const HEAL_SPARK_REACH = 0.13 // outward distance as a fraction of `scale`

function drawSparkBurst(ctx: CanvasRenderingContext2D, cx: number, cy: number, p: number, scale: number): void {
  const fade = 1 - smoothEnd2(p) // brightness: fades out on smoothEnd2
  if (fade <= 0.001) {
    return
  }
  const reach = scale * 0.2
  const travel = smoothEnd3(p) // outward distance: fast burst, eases to rest
  const gy = scale * SPARK_GRAVITY * p * p // gravity droop, growing quadratically
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(1.2, scale * 0.0045)
  for (let i = 0; i < SPARK_COUNT; i++) {
    // Stable per-spark randomness: which way it flies, and how far it throws.
    const angle = hash(i, 71) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const dist = reach * (0.3 + hash(i, 83) * 0.7) * travel
    const x = cx + cos * dist
    const y = cy + sin * dist + gy
    // A motion-blur streak trailing back toward the burst origin, shrinking as the
    // spark slows and fades.
    const len = scale * (0.018 + 0.022 * hash(i, 97)) * fade
    const tx = x - cos * len
    const ty = y - sin * len
    // White-hot core shading per-spark toward yellow/orange, drawn additively.
    const g = 205 + Math.floor(hash(i, 51) * 50) // 205..255
    const b = 90 + Math.floor(hash(i, 29) * 95) //  90..185
    const a = fade * (0.7 + 0.3 * hash(i, 41))
    ctx.strokeStyle = `rgba(255, ${g}, ${b}, ${a})`
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(x, y)
    ctx.stroke()
    // A bright pin-head at the leading tip.
    ctx.fillStyle = `rgba(255, 246, 224, ${a})`
    ctx.beginPath()
    ctx.arc(x, y, Math.max(0.8, scale * 0.004) * (0.6 + 0.6 * fade), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// Green sparks/bubbles bursting off the dealer where the heal beam lands — a
// continuous fountain while the beam holds. Each spark loops on its own staggered
// phase (deterministic per frame from hash(), no Math.random) so it streams smoothly:
// born at the impact, shooting outward with a gentle buoyant lift, then fading. `alpha`
// winds the whole thing down with the beam.
function drawHealSparks(ctx: CanvasRenderingContext2D, cx: number, cy: number, alpha: number, scale: number, now: number): void {
  if (alpha <= 0.001) {
    return
  }
  const reach = scale * HEAL_SPARK_REACH
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  for (let i = 0; i < HEAL_SPARK_COUNT; i++) {
    const phase = (now / HEAL_SPARK_PERIOD_MS + hash(i, 13)) % 1
    const fade = Math.sin(phase * Math.PI) * alpha // born at the impact, brighten, fade
    if (fade <= 0.01) {
      continue
    }
    const angle = hash(i, 71) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const dist = reach * smoothEnd3(phase) * (0.45 + hash(i, 83) * 0.9) // fast out, easing
    const rise = scale * 0.05 * phase * phase // a gentle buoyant lift as it flies
    const x = cx + cos * dist
    const y = cy + sin * dist - rise
    // A round green bubble with a soft glowing halo.
    const r = scale * (0.006 + hash(i, 51) * 0.008) * (0.6 + 0.7 * fade)
    const gc = 232 + Math.floor(hash(i, 29) * 23) // green 232..255
    const rc = 70 + Math.floor(hash(i, 37) * 70) //  red   70..140 (a touch of variety)
    const bc = 95 + Math.floor(hash(i, 43) * 55) //  blue  95..150
    const bub = ctx.createRadialGradient(x, y, 0, x, y, r)
    bub.addColorStop(0, `rgba(${rc}, ${gc}, ${bc}, ${fade})`)
    bub.addColorStop(1, 'rgba(70, 220, 110, 0)')
    ctx.fillStyle = bub
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    // A short motion streak trailing back toward the impact — the "shoot away" read.
    const len = scale * (0.012 + 0.016 * hash(i, 97)) * fade
    ctx.strokeStyle = `rgba(190, 255, 190, ${fade * 0.45})`
    ctx.lineWidth = Math.max(1, scale * 0.003)
    ctx.beginPath()
    ctx.moveTo(x - cos * len, y - sin * len)
    ctx.lineTo(x, y)
    ctx.stroke()
  }
  ctx.restore()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
