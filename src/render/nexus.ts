// The table nexus: a small device floating over the right-centre of the felt with a
// VERTICAL stack of TWO emitter lenses, top and bottom —
//
//     UTILITY the multi-purpose light. Idle it sits near-black with a shiny lens
//             glint; when the nexus acts it lights up in ONE colour at a time —
//             YELLOW as the reward tokens shoot out, RED as it charges + fires the
//             damage laser, GREEN as it shoots the heal beam. The effects never
//             overlap (they're sequenced one at a time), so one lens serves them all.
//     HOLO    an RGB holo projector — dark when off, glows + cycles hues when it projects
//
// The narrow column hugs the screen's right edge. Mirrors the render convention —
// geometry + paint live here; the strike timing (a StrikeView) and the light charge (a
// NexusChargeView) are owned by the animators (ui).
//
// The device body is a PLACEHOLDER (a dark emitter box with two lenses); at rest
// both lenses sit dim, and the charge glow (drawn additively on the fx layer) brings
// the utility lens up when the nexus is about to act. The laser is a red additive beam
// modelled on the Analyze eye-beam (cards.ts).

import { arch2, smoothEnd2, smoothEnd3, smoothStart2, smoothStart3 } from './easing'
import { cachedGradient } from './gradient-cache'
import { clampRightX, dealerBox, type Layout } from './scene'
import type { Point } from './tokens'

// The nexus sits in the empty mid-right felt band: below the shoe (top-right of
// centre) and the health bar (top-right), above the bankroll pile (bottom-right),
// clear of the centred cards + bet circle. `a` (in nexusGeom) is the device's centre;
// the two lenses stack vertically along it (see nexusUtilityLight / nexusHoloLight).
export function nexusAnchor(l: Layout): Point {
  // The vertical spot: the mid-right felt band, a touch above centre. The x is anchored
  // to the screen's right edge in nexusGeom, so the stack hugs the far right.
  return { x: l.width, y: l.edgeY + (l.height - l.edgeY) * 0.45 }
}

// Shared body geometry, so the drawn device and the two emitter-light positions never
// drift apart. The body is a narrow rounded box seating a vertical column of two lenses;
// lens i (0=top utility, 1=bottom holo) sits at (a.x, a.y + (i − 0.5)·gap).
interface NexusGeom {
  a: Point // body centre (unlifted)
  w: number // body width (narrow)
  h: number // body height (tall)
  r: number // body corner radius
  lensR: number
  gap: number // vertical distance between adjacent lens centres
  bob: number // hover-amplitude reference (the base scale)
}

// nexusGeom is called several times per frame (the body plus each emitter light) but
// only changes with the layout, so the last result is memoized. Callers treat it as
// read-only — do not mutate the returned geometry.
let cachedGeom: NexusGeom | null = null
let cachedGeomKey = ''
function nexusGeom(l: Layout): NexusGeom {
  const key = `${l.width}x${l.height}x${l.edgeY}`
  if (cachedGeom && cachedGeomKey === key) {
    return cachedGeom
  }
  const base = nexusAnchor(l)
  const scale = Math.min(l.width, l.height)
  // Base scale (≈ the old square side); capped small so it doesn't dominate big desktops.
  const s = clamp(scale * 0.12, 54, 84)
  const lensR = s * 0.1275 // 25% smaller than the old 0.17·s
  const socket = lensR * 1.14
  const gap = lensR * 2.5 // vertical spacing between the two lens centres
  const w = socket * 2 + lensR * 0.9 // narrow body: one lens wide + side padding
  const h = gap + socket * 2 + lensR // two stacked lenses + top/bottom padding
  // Hug the screen's right edge (a small margin in), so the narrow stack sits at the far
  // right; keep the same vertical centre (a full base-scale above the anchor). On very wide
  // screens clampRightX reels the far-right position back toward centre so the device stays
  // related to the middle of the table.
  const rightMargin = Math.max(10, l.width * 0.02)
  const a = { x: clampRightX(l, l.width - rightMargin - w / 2), y: base.y - s }
  cachedGeom = { a, w, h, r: w * 0.3, lensR, gap, bob: s }
  cachedGeomKey = key
  return cachedGeom
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
const HOVER_MIN = 0.26 // low point of the bob, as a fraction of the bob reference
const HOVER_MAX = 0.43 // high point of the bob

// The bob phase, 0 (low point) .. 1 (high point).
function hoverPhase(now: number): number {
  return (Math.sin((now / HOVER_PERIOD_MS) * Math.PI * 2) + 1) * 0.5
}

function hoverLift(g: NexusGeom, now: number): number {
  return g.bob * (HOVER_MIN + (HOVER_MAX - HOVER_MIN) * hoverPhase(now))
}

// The y of stacked lens `row` (0=top utility, 1=bottom holo) at `now`, floating with
// the device — the two lenses straddle the centre a.y, half a gap above and below.
function lensY(g: NexusGeom, row: number, now: number): number {
  return g.a.y + (row - 0.5) * g.gap - hoverLift(g, now)
}

// The UTILITY emitter (top lens): the one muzzle the reward tokens lift off from, the
// damage laser fires from on a win, and the heal beam fires from on a loss. Only one of
// those runs at a time (they're sequenced), so a single lens serves them all.
export function nexusUtilityLight(l: Layout, now: number): Point {
  const g = nexusGeom(l)
  return { x: g.a.x, y: lensY(g, 0, now) }
}

// The HOLO emitter (bottom lens): the RGB holo projector. Dark when off; when it
// projects it glows and cycles washed pastel colours (holoGlowStyle). Exposed so the
// projection (e.g. the end-of-game scoreboard) can anchor to its muzzle.
export function nexusHoloLight(l: Layout, now: number): Point {
  const g = nexusGeom(l)
  return { x: g.a.x, y: lensY(g, 1, now) }
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
  const { a, w, h } = g
  const lift = hoverLift(g, now)
  const cy = a.y - lift // the floating body's centre

  ctx.save()

  // A soft shadow blob on the felt, a little smaller than the body and pinned under
  // its base. It's a radial gradient (not a hard disc) so the edge reads as a real,
  // diffuse shadow. As the device climbs it spreads a touch and dims — the subtle
  // "further from the surface" cue — but only gently, so the bob doesn't make the
  // shadow visibly throb. `t` is the bob phase: 0 at the low point, 1 at the high.
  const t = hoverPhase(now)
  const rx = w * 0.78 * (1 + t * 0.16)
  const ry = w * 0.27 * (1 + t * 0.16)
  const alpha = 0.45 - t * 0.1 // 0.45 (low, tighter/darker) .. 0.35 (high, softer)
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

  // The hover thrust — blue light discs pulsing down from the base — drawn UNDER the
  // body so they read as emerging from beneath it (this is how it floats).
  drawHoverThrust(ctx, g, cy, lift, now)

  const top = cy - h / 2
  const bottom = cy + h / 2
  const ch = Math.min(w * 0.36, h * 0.1) // corner chamfer

  // Body: a chamfered (octagonal) alien-metal casing — cool teal-tinted steel, cross-lit.
  // Drawn in the body's own local frame (origin at its centre) so the cross-lit gradient
  // can be cached once and just translated up/down with the hover bob each frame.
  ctx.save()
  ctx.translate(a.x, cy)
  traceBodyOctagon(ctx, 0, -h / 2, h / 2, w, ch)
  const body = cachedGradient(ctx, `nexus-body:${Math.round(w)}:${Math.round(h)}`, (c) => {
    const g = c.createLinearGradient(-w * 0.45, -h / 2, w * 0.45, h / 2)
    g.addColorStop(0, '#33424b')
    g.addColorStop(0.5, '#171f27')
    g.addColorStop(1, '#0d1218')
    return g
  })
  ctx.fillStyle = body
  ctx.fill()
  ctx.lineWidth = Math.max(1, w * 0.04)
  ctx.strokeStyle = `rgba(${ALIEN_ENERGY}, 0.22)` // an energised teal edge — powered, not inert
  ctx.stroke()
  ctx.restore()

  // A teal energy conduit down the right flank — a pulse flowing toward the emitter, the
  // power feeding the hover thrust.
  drawEdgeConduit(ctx, a.x + w / 2 - w * 0.09, top + ch, bottom - ch, w)

  // The two emitter lenses, each set in a hexagonal alien bezel — top: the utility light
  // (idle near-black with a shiny lens glint; the charge glow on the fx layer brings it
  // up in yellow/red/green when the nexus acts), bottom: the RGB holo projector.
  const lensStyles = [UTILITY_LENS, HOLO_OFF_LENS]
  for (let i = 0; i < 2; i++) {
    const ly = lensY(g, i, now)
    drawHexBezel(ctx, a.x, ly, g.lensR * 1.38)
    drawDimLens(ctx, a.x, ly, g.lensR, lensStyles[i])
  }

  // The emitter collar at the base — a metal lip with a teal-glowing nozzle slot the
  // hover thrust pours from.
  drawEmitterCollar(ctx, a.x, bottom, w, ch, now)

  ctx.restore()
}

// --- alien-tech greeble --------------------------------------------------------
// Teal "alien energy" colour, as an "r, g, b" triple for rgba() templates.
const ALIEN_ENERGY = '116, 236, 224'

// Trace the body's chamfered-octagon outline into the current path (an angular,
// machined-alien silhouette instead of a plain rounded box).
function traceBodyOctagon(ctx: CanvasRenderingContext2D, cx: number, top: number, bottom: number, w: number, ch: number): void {
  const left = cx - w / 2
  const right = cx + w / 2
  ctx.beginPath()
  ctx.moveTo(left + ch, top)
  ctx.lineTo(right - ch, top)
  ctx.lineTo(right, top + ch)
  ctx.lineTo(right, bottom - ch)
  ctx.lineTo(right - ch, bottom)
  ctx.lineTo(left + ch, bottom)
  ctx.lineTo(left, bottom - ch)
  ctx.lineTo(left, top + ch)
  ctx.closePath()
}

// A flat-top hexagonal metal bezel framing a lens — a raised ring so the round lens reads
// as an alien optic set into segmented casing plate.
function drawHexBezel(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
  // Drawn around a local origin at (cx, cy) so the (identical) bezel gradient is built
  // once and reused for all three lenses across every frame.
  ctx.save()
  ctx.translate(cx, cy)
  ctx.beginPath()
  for (let k = 0; k < 6; k++) {
    const ang = (k * Math.PI) / 3 // flat-top hexagon
    const x = Math.cos(ang) * R
    const y = Math.sin(ang) * R
    if (k === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.closePath()
  const grad = cachedGradient(ctx, `nexus-bezel:${Math.round(R)}`, (c) => {
    const g = c.createLinearGradient(0, -R, 0, R)
    g.addColorStop(0, '#3c4952')
    g.addColorStop(0.5, '#222a31')
    g.addColorStop(1, '#161c22')
    return g
  })
  ctx.fillStyle = grad
  ctx.fill()
  ctx.lineWidth = Math.max(1, R * 0.07)
  ctx.strokeStyle = `rgba(${ALIEN_ENERGY}, 0.16)`
  ctx.stroke()
  ctx.restore()
}

// A faint teal energy conduit line down one flank — static greeble suggesting a power
// channel. Additive, so it reads as a lit seam.
function drawEdgeConduit(ctx: CanvasRenderingContext2D, x: number, top: number, bottom: number, w: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = `rgba(${ALIEN_ENERGY}, 0.16)`
  ctx.lineWidth = Math.max(1, w * 0.045)
  ctx.beginPath()
  ctx.moveTo(x, top)
  ctx.lineTo(x, bottom)
  ctx.stroke()
  ctx.restore()
}

// The emitter collar at the base: a dark metal lip with a teal-glowing nozzle slot the
// hover thrust pours from — so the float reads as engine exhaust, not free glow.
function drawEmitterCollar(ctx: CanvasRenderingContext2D, cx: number, bottom: number, w: number, ch: number, now: number): void {
  const lipW = w * 0.64
  const lipH = w * 0.16
  const lipY = bottom - ch * 0.35
  ctx.fillStyle = '#1c232a'
  ctx.beginPath()
  ctx.roundRect(cx - lipW / 2, lipY - lipH / 2, lipW, lipH, lipH * 0.4)
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.stroke()
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const pulse = 0.45 + 0.3 * (0.5 + 0.5 * Math.sin(now / 420))
  ctx.strokeStyle = `rgba(${ALIEN_ENERGY}, ${pulse})`
  ctx.lineWidth = Math.max(1.5, w * 0.06)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - lipW * 0.3, lipY)
  ctx.lineTo(cx + lipW * 0.3, lipY)
  ctx.stroke()
  ctx.restore()
}

// The hover thrust: soft blue light discs streaming DOWN from the device's base toward
// the felt — the "anti-grav" that keeps it aloft. Each disc loops on its own staggered
// phase (deterministic from `now`, no Math.random): born just under the base, sinking a
// flattened ellipse toward the felt while it widens and fades. Additive, so it reads as
// light. `cy` is the floating body centre; `lift` its current altitude (the discs sink a
// little past that, so the column always reaches the felt/shadow).
const THRUST_DISCS = 3
const THRUST_PERIOD_MS = 1200
function drawHoverThrust(ctx: CanvasRenderingContext2D, g: NexusGeom, cy: number, lift: number, now: number): void {
  const top = cy + g.h / 2 - g.lensR * 0.2 // just under the body base
  const drop = lift + g.w * 0.35 // sink to a touch past the resting shadow
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < THRUST_DISCS; i++) {
    const phase = ((now / THRUST_PERIOD_MS) % 1 + i / THRUST_DISCS) % 1
    const y = top + phase * drop
    const rx = g.w * (0.34 + phase * 1.2) // scale X out a LOT as it sinks — spreads on the "ground"
    const ry = g.w * (0.11 + phase * 0.05) // Y stays flat, so the disc flattens as it widens
    const fade = phase < 0.12 ? phase / 0.12 : 1 - (phase - 0.12) / 0.88 // ramp in, then fade out
    const a = clamp01(fade) * 0.5
    if (a <= 0.01) {
      continue
    }
    ctx.save()
    ctx.translate(g.a.x, y)
    ctx.scale(1, ry / rx) // squash the circular gradient into a flat ellipse
    // Create the gradient AFTER the transform, centred at (0,0), so its centre isn't
    // pushed off by the CTM (a translated gradient centre samples all-transparent).
    const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
    disc.addColorStop(0, `rgba(160, 210, 255, ${a})`)
    disc.addColorStop(0.5, `rgba(90, 170, 255, ${a * 0.5})`)
    disc.addColorStop(1, 'rgba(70, 150, 255, 0)')
    ctx.fillStyle = disc
    ctx.beginPath()
    ctx.arc(0, 0, rx, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

// The dim, idle look of a lens: a dark socket with a muted core — barely lit, so
// the additive charge glow reads as the light powering up. `glint` adds a bright
// specular catch-light so the lens reads as a shiny convex optic even when unlit.
interface LensStyle {
  core: string
  mid: string
  edge: string
  rim: string
  glint?: boolean
}
// The utility light at rest: near-black, neutral, with a shiny reflective glint — so it
// reads as a dark glassy lens waiting to fire (yellow tokens / red laser / green heal).
const UTILITY_LENS: LensStyle = { core: '#26282f', mid: '#121317', edge: '#050507', rim: 'rgba(185, 192, 208, 0.16)', glint: true }

// The RGB holo projector's lens when it's OFF: a neutral dark-grey socket that reads
// as unlit. When the projector powers on to cast a table projection (e.g. the
// end-of-game scoreboard), holoGlowStyle drives an additive glow over this that lights
// it up and cycles through washed pastel colours — see drawStrikeFx.
const HOLO_OFF_LENS: LensStyle = { core: '#2b2d33', mid: '#17181d', edge: '#0a0a0d', rim: 'rgba(150, 152, 165, 0.12)' }

// HSL (h in degrees, s/l in 0..1) → [r, g, b] 0..255. Local to the holo colour cycle.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = ((((h % 360) + 360) % 360) / 60)
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function drawDimLens(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, s: LensStyle): void {
  // Drawn around a local origin at (cx, cy) so the upper-left-lit lens gradient can be
  // cached per (radius, style) and translated to each lens instead of rebuilt per frame.
  ctx.save()
  ctx.translate(cx, cy)

  // Dark socket the lens is recessed into.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.beginPath()
  ctx.arc(0, 0, r * 1.14, 0, Math.PI * 2)
  ctx.fill()

  // The dim lens itself, lit from the upper-left. `s.core` distinguishes the three lens
  // palettes (red / yellow / holo-off), so it keys the cache alongside the radius.
  const lens = cachedGradient(ctx, `nexus-lens:${Math.round(r)}:${s.core}`, (c) => {
    const g = c.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r)
    g.addColorStop(0, s.core)
    g.addColorStop(0.55, s.mid)
    g.addColorStop(1, s.edge)
    return g
  })
  ctx.fillStyle = lens
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()

  // Faint rim so the lens edge catches a little light even when idle.
  ctx.lineWidth = Math.max(1, r * 0.12)
  ctx.strokeStyle = s.rim
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.stroke()

  // A shiny specular catch-light, so a dark idle lens still reads as a glossy convex
  // optic (the "reflective artifact inside" the utility light waits behind).
  if (s.glint) {
    drawLensGlint(ctx, r)
  }
  ctx.restore()
}

// A reflective glint on a lens: a soft elongated specular streak in the upper-left plus
// a tiny secondary catch-light lower-right, drawn additively so it reads as light caught
// on curved glass. Drawn in the lens's own local frame (origin already at its centre).
function drawLensGlint(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  // Main specular: an angled oval highlight offset toward the upper-left.
  ctx.save()
  ctx.translate(-r * 0.3, -r * 0.32)
  ctx.rotate(-0.7)
  ctx.scale(1, 0.46) // squash into a streak
  const main = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.62)
  main.addColorStop(0, 'rgba(226, 234, 248, 0.62)')
  main.addColorStop(0.5, 'rgba(210, 222, 242, 0.22)')
  main.addColorStop(1, 'rgba(210, 222, 242, 0)')
  ctx.fillStyle = main
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  // Secondary pinprick catch-light, lower-right — sells the curvature.
  const dot = ctx.createRadialGradient(r * 0.34, r * 0.36, 0, r * 0.34, r * 0.36, r * 0.22)
  dot.addColorStop(0, 'rgba(210, 220, 240, 0.4)')
  dot.addColorStop(1, 'rgba(210, 220, 240, 0)')
  ctx.fillStyle = dot
  ctx.beginPath()
  ctx.arc(r * 0.34, r * 0.36, r * 0.22, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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
    heal: number
    yellow: number
    holo: number
    chargeUp: { start: number; cap: number } | null
    healBeam: { travel: number; alpha: number } | null
  },
  now: number,
): void {
  ctx.clearRect(0, 0, l.width, l.height)
  // The floating device body itself — it hovers, so it rides this per-frame layer
  // rather than the static table, drawn under its charge glow + laser below.
  drawNexus(ctx, l, now)
  const from = nexusUtilityLight(l, now)
  const to = impactPoint(l)
  const scale = Math.min(l.width, l.height)

  // "Powering up": red energy balls drawn in from around the utility light while it
  // charges an attack. Under the light glow so they read as being absorbed by it.
  if (charge.chargeUp !== null) {
    drawChargeUp(ctx, l, charge.chargeUp.start, charge.chargeUp.cap, now)
  }

  // The utility lens glowing — the reward-token vent (yellow), the laser muzzle
  // (red, incl. its anticipation charge), and the heal emitter (green) all light up
  // this ONE top lens, one colour at a time (they're sequenced so they never overlap).
  // Drawn first so the beam's muzzle flash (also at this lens) still punches over it.
  if (charge.red > 0.001 || charge.heal > 0.001 || charge.yellow > 0.001 || charge.holo > 0.001) {
    const g = nexusGeom(l)
    if (charge.yellow > 0.001) {
      drawLightCharge(ctx, from.x, from.y, g.lensR, charge.yellow, YELLOW_GLOW)
    }
    if (charge.red > 0.001) {
      drawLightCharge(ctx, from.x, from.y, g.lensR, charge.red, RED_GLOW)
    }
    // A heal glows the same utility lens, but green — the heal beam fires on a loss and
    // never overlaps the red laser (a win) or the yellow tokens, so one lens serves all.
    if (charge.heal > 0.001) {
      drawLightCharge(ctx, from.x, from.y, g.lensR, charge.heal, GREEN_GLOW)
    }
    // The holo projector (bottom lens): a cycling pastel glow filling most of its dark
    // lens (a bright disc with a thin black lens ring), its hue drifting with `now`.
    if (charge.holo > 0.001) {
      const holo = nexusHoloLight(l, now)
      drawLightCharge(ctx, holo.x, holo.y, g.lensR * 0.7, charge.holo, holoGlowStyle(now))
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

  // The heal beam (a late dealer repairing itself after a loss): a gentle green-gold
  // stream from the utility emitter to the dealer, opposite in feel to the red laser.
  // Never overlaps a strike — a heal is a loss, a strike is a win — so both use it.
  if (charge.healBeam) {
    drawHealBeam(ctx, from, to, charge.healBeam.travel, charge.healBeam.alpha, scale, now)
  }
}

// A restorative beam from the red emitter: a soft green-gold glow with a warm
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
// The heal glow — green, soft and cool, matching the restorative beam. Drawn on the
// utility lens (which serves tokens, laser and heal in turn) while a heal fires.
const GREEN_GLOW: GlowStyle = {
  core: 'rgba(170, 255, 150,',
  halo: 'rgba(80, 220, 90,',
  hot: 'rgba(225, 255, 215,',
  bloom: 1.1,
  intensity: 1.0,
}

// The holo projector's glow, built fresh from `now` so its hue drifts round the wheel
// as it holds lit. Kept muted + washed — a light, near-white core with only a
// moderately saturated halo — so it reads as a soft pastel projector, not a strobe.
const HOLO_CYCLE_MS = 400 // one full trip round the hue wheel

function holoGlowStyle(now: number): GlowStyle {
  const hue = (now / HOLO_CYCLE_MS) * 360 // hslToRgb wraps this into 0..360
  const rgb = (s: number, l: number): string => {
    const [r, g, b] = hslToRgb(hue, s, l)
    return `rgba(${r}, ${g}, ${b},`
  }
  return {
    core: rgb(0.4, 0.82), // washed, near-white centre
    halo: rgb(0.72, 0.55), // the visible cycling colour in the bloom
    hot: rgb(0.18, 0.92), // white-hot pinprick, faintly tinted
    bloom: 0.85, // soft bloom that reaches a little past the lens edge for a gentle glow
    intensity: 1.3, // punchier, so the light keeps the brightness that read well
  }
}

// A box a holo ray fan targets — the on-felt region of one projected readout number.
export interface HoloRayTarget {
  left: number
  right: number
  top: number
  bottom: number
}

// The holo projector casting one readout: `count` faint WHITE light rays from the holo
// lens to `box`. The apex is pinned to the lens; each ray's flat base JUMPS to a random
// height within the box every frame and its opacity flickers in [0.02, 0.05], so the fan
// shimmers like a projector scanning. White at the lens → transparent at the target,
// drawn additively so it shines over the (undimmed) scene. `seedBase` decorrelates fans.
export function drawHoloRays(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  box: HoloRayTarget,
  count: number,
  now: number,
  seedBase: number,
): void {
  const src = nexusHoloLight(l, now)
  const pad = (box.right - box.left) * 0.25
  const midX = (box.left + box.right) / 2
  const span = box.bottom - box.top
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < count; i++) {
    const seed = seedBase + i
    // Each ray owns one horizontal slice of the box and jumps within it — so the fan
    // always SPANS the number (never leaves it un-lit) while still shimmering.
    const baseY = box.top + (span * (i + hash(now, seed))) / count
    const alpha = 0.02 + 0.03 * hash(now, seed + 500)
    // Fade the ray along a 1 − smoothStart2(t) curve (t: apex → base), so it holds near
    // full for most of its length and only drops off near the END — more of the ray reads
    // as light. Approximated with a few evenly-spaced stops (canvas lerps between them).
    const grad = ctx.createLinearGradient(src.x, src.y, midX, baseY)
    const STEPS = 5
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS
      grad.addColorStop(t, `rgba(255, 255, 255, ${alpha * (1 - smoothStart2(t))})`)
    }
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(src.x, src.y)
    ctx.lineTo(box.left - pad, baseY)
    ctx.lineTo(box.right + pad, baseY)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
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

// While the utility light charges an attack it draws in a stream of red energy balls
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
  const c = nexusUtilityLight(l, now)
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
