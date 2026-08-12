// The clown bot: a smaller robot sidekick that shadows dealer 6 (the RGB final dealer),
// standing just to its right. Geometry + paint only — all timing/state lives in the clown
// animator (ui/clown-animator.ts), handed in as a ClownView, exactly the way render/dealer.ts
// pairs with the dealer animator. Drawn on its own 'clown' layer, right beside the 'dealer'
// layer and below the table/rail, so its lower body tucks behind the rail like the dealer's.
//
// It wears the SAME RGB bowtie the dealer 6 kit cycles through, but at FULL colour intensity
// (render/palette.ts rgbFullColor — the dealer's is desaturated to a pastel), plus a bright red
// clown wig and a red ball nose. When the dealer laughs, the clown laughs too (its grin opens
// and glows) — the animator mirrors the dealer's emote onto its mouth on a slight delay.

import { smoothEnd2, smoothEnd3, smoothStart3 } from './easing'
import { rgbFullColor } from './palette'
import { dealerBox, type Layout } from './scene'
import { drawVoiceMouth, type VoiceEmote } from './dealer'

// The clown is a darker, rounder little robot — a touch lighter than the dealer's near-black
// silhouette so the two figures separate where they stand side by side.
const TORSO = '#11131b'
const HEAD = '#171a24'
// Bright circus red for the wig tufts (with a shaded tone for depth) and the ball nose.
const WIG = '#e5231f'
const WIG_DARK = '#a5120f'
const NOSE = '#ff2d2d'
const NOSE_HI = 'rgba(255, 190, 190, 0.9)'
// Wide clown eyes: flat bright whites with dark pupils (goggling, not the dealer's menacing red slits).
const EYE_WHITE = '#f6f8ff'
const PUPIL = '#0b0d13'

// Same three-step walk as the dealer (render/dealer.ts): WALK_STEPS bob dips over the slide.
const WALK_STEPS = 3
const WALK_BOB = 0.06

// What the animator exposes to this renderer. All queries take `now`.
export interface ClownView {
  // False whenever the clown shouldn't be on screen (no dealer-6 present, or mid-delay
  // before its trailing walk-in actually begins).
  present(now: number): boolean
  // Trailing walk-IN progress (0..1) as it follows the dealer on, or null when not arriving.
  arriving(now: number): number | null
  // Walk-OFF progress (0..1) as it strides off (dealer 6 died or left), or null otherwise.
  leaving(now: number): number | null
  // The clown's active laugh emote (mirrored from the dealer, delayed), or null when silent.
  voice(now: number): VoiceEmote | null
}

// The clown's on-screen footprint, derived from the dealer's so the two always line up on
// resize. A smaller figure standing to the RIGHT of the dealer and a little shorter (its head
// sits lower), with its body tucking behind the same rail line (baseY).
export interface ClownBox {
  cx: number
  headCenterY: number
  headR: number
  bodyTop: number
  bodyLeft: number
  bodyRight: number
  baseY: number
}

export function clownBox(l: Layout): ClownBox {
  const d = dealerBox(l)
  const headR = d.headR * 0.72
  const cx = d.cx + d.headR * 3.0 // stand well clear to the right of the dealer's torso
  const headCenterY = d.headCenterY + d.headR * 0.7 // a shorter sidekick
  const bodyW = headR * 2.3
  return {
    cx,
    headCenterY,
    headR,
    bodyTop: headCenterY + headR,
    bodyLeft: cx - bodyW / 2,
    bodyRight: cx + bodyW / 2,
    baseY: d.baseY,
  }
}

// Paint the clown for this frame. Clears the layer first (it owns it). No-op when the clown
// isn't present (dealer 6 not on screen, or its trailing walk-in hasn't started yet).
export function drawClown(ctx: CanvasRenderingContext2D, layout: Layout, view: ClownView, now: number): void {
  ctx.clearRect(0, 0, layout.width, layout.height)
  if (!view.present(now)) {
    return
  }

  const c = clownBox(layout)
  const arriving = view.arriving(now)
  const leaving = view.leaving(now)

  ctx.save()
  if (arriving !== null) {
    // Slide in from off-screen right (decelerating), fading in over the first third, the
    // same bob gait as the dealer's walk-in — it trots on a beat behind the dealer.
    const slide = smoothEnd3(arriving)
    const travel = layout.width * 0.6
    const bob = Math.abs(Math.sin(arriving * Math.PI * WALK_STEPS)) * c.headR * WALK_BOB
    ctx.translate(travel * (1 - slide), bob)
    ctx.globalAlpha = smoothEnd2(Math.min(1, arriving / 0.3))
  } else if (leaving !== null) {
    // The mirror: accelerate off to the right (no fade — it clears the edge), same bob.
    const slide = smoothStart3(leaving)
    const travel = layout.width * 0.6
    const bob = Math.abs(Math.sin(leaving * Math.PI * WALK_STEPS)) * c.headR * WALK_BOB
    ctx.translate(travel * slide, bob)
  }

  const colors = rgbFullColor(now)
  drawFigure(ctx, c, colors.color, colors.dark, view.voice(now), now)
  ctx.restore()
}

function drawFigure(
  ctx: CanvasRenderingContext2D,
  c: ClownBox,
  bowtie: string,
  bowtieKnot: string,
  voice: VoiceEmote | null,
  now: number,
): void {
  const r = c.headR

  // Torso (behind the rail below).
  ctx.fillStyle = TORSO
  ctx.beginPath()
  ctx.roundRect(c.bodyLeft, c.bodyTop, c.bodyRight - c.bodyLeft, c.baseY - c.bodyTop, r * 0.22)
  ctx.fill()

  // Red clown wig — drawn BEFORE the head so the tufts frame it: a puffy arc of overlapping
  // circles hugging the head's top + sides. A darker back layer gives the frizz some depth.
  drawWig(ctx, c, WIG_DARK, 1.04, r * 0.06)
  drawWig(ctx, c, WIG, 1.0, 0)

  // Head (a rounder box than the dealer's — friendlier).
  ctx.fillStyle = HEAD
  ctx.beginPath()
  ctx.roundRect(c.cx - r, c.headCenterY - r, r * 2, r * 2, r * 0.45)
  ctx.fill()

  drawBowtie(ctx, c, bowtie, bowtieKnot)

  // Wide goggling eyes, set a touch high on the face: a flat white disc with a small dark pupil.
  const eyeY = c.headCenterY - r * 0.18
  const eyeR = r * 0.26
  for (const sx of [-1, 1]) {
    const ex = c.cx + sx * r * 0.4
    ctx.fillStyle = EYE_WHITE
    ctx.beginPath()
    ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = PUPIL
    ctx.beginPath()
    ctx.arc(ex + sx * eyeR * 0.15, eyeY + eyeR * 0.12, eyeR * 0.44, 0, Math.PI * 2)
    ctx.fill()
  }

  // Eyebrows: a short, flat red bar over each eye. Drawn over the eyes so they read as brows.
  drawBrows(ctx, c, eyeY, eyeR)

  // Mouth: the SAME vocoder panel the dealers use (lights up + waves flow when it laughs), framed
  // by a red clown lip ring. Sits below the nose line.
  const mouthW = r * 1.0
  const mouthH = r * 0.32
  const mouthTop = c.headCenterY + r * 0.62 - mouthH / 2
  const mouthR = r * 0.14
  const mouthX = c.cx - mouthW / 2
  drawVoiceMouth(ctx, mouthX, mouthTop, mouthW, mouthH, mouthR, voice, now)
  ctx.strokeStyle = NOSE
  ctx.lineWidth = Math.max(2, r * 0.09)
  ctx.beginPath()
  ctx.roundRect(mouthX, mouthTop, mouthW, mouthH, mouthR)
  ctx.stroke()

  // Red ball nose, at the centre of the face between eyes and mouth — drawn last so it sits proud
  // of everything, with a small highlight for a glossy ball read.
  const noseY = c.headCenterY + r * 0.14
  const noseR = r * 0.19
  ctx.fillStyle = NOSE
  ctx.beginPath()
  ctx.arc(c.cx, noseY, noseR, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = NOSE_HI
  ctx.beginPath()
  ctx.arc(c.cx - noseR * 0.32, noseY - noseR * 0.34, noseR * 0.34, 0, Math.PI * 2)
  ctx.fill()
}

// A short, flat red eyebrow bar over each eye.
function drawBrows(ctx: CanvasRenderingContext2D, c: ClownBox, eyeY: number, eyeR: number): void {
  const browW = eyeR * 1.7
  const browH = eyeR * 0.4
  const browY = eyeY - eyeR * 1.5
  ctx.fillStyle = WIG
  for (const sx of [-1, 1]) {
    const ex = c.cx + sx * c.headR * 0.4
    ctx.beginPath()
    ctx.roundRect(ex - browW / 2, browY - browH / 2, browW, browH, browH * 0.5)
    ctx.fill()
  }
}

// A puffy wig: a fan of overlapping circles arcing over the top + down the sides of the head.
// `spread` scales the puff outward (the darker back layer sits a hair wider); `grow` fattens
// each tuft (again, wider on the back layer) so the dark frizz peeks out behind the red.
function drawWig(ctx: CanvasRenderingContext2D, c: ClownBox, color: string, spread: number, grow: number): void {
  const r = c.headR
  ctx.fillStyle = color
  const tufts = 9
  for (let i = 0; i < tufts; i++) {
    // Fan the tufts across a ~200° arc over the head's upper half (from lower-left, over the
    // top, to lower-right), so they crown the top and bunch down past the ears.
    const a = Math.PI * (1.1 - 1.2 * (i / (tufts - 1)))
    const rad = r * 1.02 * spread
    const px = c.cx + Math.cos(a) * rad
    const py = c.headCenterY - Math.sin(a) * rad * 0.92
    const puff = r * (0.34 + 0.1 * Math.sin(i * 1.7)) + grow
    ctx.beginPath()
    ctx.arc(px, py, puff, 0, Math.PI * 2)
    ctx.fill()
  }
}

// An oversized clown bowtie (bigger than the dealer's), in the full-intensity RGB colour.
function drawBowtie(ctx: CanvasRenderingContext2D, c: ClownBox, bowtie: string, bowtieKnot: string): void {
  const cy = c.headCenterY + c.headR * 1.5
  const wingW = c.headR * 0.78
  const wingH = c.headR * 0.58
  const knot = c.headR * 0.18

  ctx.save()
  ctx.fillStyle = bowtie
  for (const sx of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(c.cx, cy)
    ctx.lineTo(c.cx + sx * wingW, cy - wingH / 2)
    ctx.lineTo(c.cx + sx * wingW, cy + wingH / 2)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = bowtieKnot
  ctx.beginPath()
  ctx.roundRect(c.cx - knot, cy - knot, knot * 2, knot * 2, knot * 0.4)
  ctx.fill()
  ctx.restore()
}

