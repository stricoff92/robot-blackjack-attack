// The dealer robot: the figure standing behind the table, plus its glowing eyes.
//
// Geometry + paint only (mirrors cards.ts); all timing lives in the
// dealer animator (ui), passed in as a DealerView. The figure is drawn on its
// own 'dealer' layer, BELOW the table/rail — so its lower body and any death
// debris tuck behind the rail exactly as the old placeholder did. The eyes' red
// GLOW is drawn separately on the top 'mask' (light) layer via drawDealerEyeGlow.
//
// Reads dealerBox / dealerEyes from scene.ts (the single source of truth for the
// figure's footprint, shared with the chip anchors and Analyze beams).

import { TOTAL_DEALERS } from '../game/run'
import { smoothEnd2, smoothEnd3, smoothStart2, smoothStart3 } from './easing'
import { cachedGradient } from './gradient-cache'
import { dealerColors } from './palette'
import { dealerBox, dealerEyes, type DealerBox, type Layout } from './scene'

// The dealer reads as a dark SILHOUETTE against the (spotlit) back wall, which is
// roughly rgb(47,51,70) behind the head — so the head + body are kept clearly
// darker than that, or they blend into the wall.
const TORSO = '#090b10'
const HEAD = '#0f1219'
const MOUTH = '#242835' // a little lighter than the head; a voice sine-wave will live here later
// The bowtie colour marks which dealer this is — it's resolved per-frame from the
// figure's dealer index (see drawDealer), so it isn't a constant here.
const EYE = '#ff3b3b'
const EYE_OFF = '#2a0d0d' // dark socket shown when a flickering eye blinks off
// Menace details. Brows read as raised metal plates (a touch lighter than the
// head); the hood is a near-black bar that clips the eye tops into angry slits
// (the emissive glow stays full-round, so you get glowing slits). The grille is
// head-dark separators over the voice panel, reading as gritted teeth.
const BROW = '#232838'
const HOOD = '#070a10'
const GRILLE = '#0b0e15'
// Victorian bullion-gold epaulets on the final dealer's shoulders. A metallic ramp
// (bright crown → deep shadow) reads as polished brass against the dark figure, with
// a near-black edge so the gold separates cleanly from the torso.
const EPAULET_HI = '#f8e58c'
const EPAULET_MID = '#cfa63c'
const EPAULET_LO = '#7d5e18'
const EPAULET_EDGE = '#4f3d10'

// The Banker (the coda's sentinel shift, one past the real dealers) wears a three-piece
// charcoal suit in place of the robot's bowtie + epaulets: a lighter waistcoat panel down
// the chest, framed by two darker jacket lapels that meet in a V at the button break. Each
// tone steps up from the near-black torso so the layers separate (torso → lapel → vest).
// The gold accents (vest buttons, watch chain, monocle rim) reuse the figure's resolved
// "bowtie" colour, which the Banker's palette entry sets to gold. Absolutely no cigar.
const SUIT_LAPEL = '#181d29'
const SUIT_VEST = '#20232f'
const SUIT_VEST_EDGE = '#2b3040'
// A neutral gray silk necktie hanging in the waistcoat V: a narrow knot at the collar
// that widens to a pointed tip partway down the vest. The knot is a touch darker than the
// blade; a soft dark edge separates the gray from the charcoal vest, and a faint lighter
// crease down the centre reads as silk sheen. Deliberately gray, not gold — the tie is the
// one quiet note against the gold buttons/chain/monocle.
const TIE_SILK = '#727680'
const TIE_KNOT = '#5c606a'
const TIE_EDGE = '#3c404a'
const TIE_SHEEN = 'rgba(190, 194, 204, 0.5)'
// A pale dress shirt fills the collar V behind the tie; a near-white folded silk pocket square
// peeks from the breast pocket. Both read bright against the charcoal suit.
const SHIRT = '#c6cbd5'
const POCKET_SQUARE = '#e6e9ef'

// The walk-in gait: the figure takes this many steps crossing from the edge to its
// spot, dipping (bobbing DOWN) once per footfall. The footfalls are evenly spaced in
// the walk-in progress, centred in each step's slice — footfall i (0-based) lands at
// (i + 0.5) / WALK_STEPS. The dealer animator fires the step sfx off those SAME
// fractions (see footsteps()), so each boot-thud lands exactly on a visible dip.
export const WALK_STEPS = 3
// Bob depth at a footfall, in headR-fraction units (the renderer scales by headR).
const WALK_BOB = 0.06

// What the animator exposes to this renderer. All queries take `now`.
export interface DealerView {
  // False during the brief gap between the old dealer's death and the new one's
  // arrival — nothing is drawn then.
  alive(now: number): boolean
  // Take-damage reaction: a white flash (0..1) and a small positional jitter.
  // shakeX/shakeY are in headR-fraction units — the renderer scales by headR.
  hit(now: number): { flash: number; shakeX: number; shakeY: number }
  // Ambient low-health tremor: a small positional shudder (headR-fraction units, like
  // hit's shake) that fades in below 50% health and grows stronger + longer toward death.
  // Fires on an organic, un-scheduled cadence, capped at ~1/sec. Zero when healthy or
  // mid-transition (death / walk-in / walk-off).
  tremor(now: number): { x: number; y: number }
  // Death fall-apart progress (0..1), or null when not dying.
  dying(now: number): number | null
  // Walk-in progress (0..1), or null when not arriving.
  arriving(now: number): number | null
  // Walk-OFF progress (0..1) as the dealer strides off to the right at game over
  // (a loss), or null when not leaving.
  leaving(now: number): number | null
  // Eye-core brightness for the figure (0..1); 1 when healthy, stutters toward 0 as
  // a low-health dealer's eyes flicker. Shares its flicker with eyeGlow.
  eyeCore(now: number): number
  // Eye-glow strength for the mask layer (0..1); dims on death, re-ignites on
  // arrival, and flickers with the eye cores when the dealer is badly damaged.
  eyeGlow(now: number): number
  // Brow reaction to a hit: 0 = the resting angry brows, 1 = the fully "scared"
  // tilt (left brow swings CCW, right CW, inner tips lifting into a worried /\).
  // Spikes on impact off the same event as hit(), then rolls back to 0.
  browFear(now: number): number
  // Which dealer the figure on screen right now IS (1-based) — its colour identity.
  // A dying dealer keeps its own colour; once the replacement walks in, this flips
  // to the new dealer, so the bowtie colour marks progression.
  figureShift(now: number): number
  // The dealer's active voice emote (an evil laugh when the house wins), or null when
  // silent. Drives the mouth panel: it lights up and one or more waves ripple across
  // it, pulsing with each syllable. Dealer 1 never emotes (see voiceSeedFor).
  voice(now: number): VoiceEmote | null
}

// A frame of the dealer's voice readout, mirrored in the mouth panel. `open` is the
// overall glow gate (fades the panel light in/out at the emote's edges); `energy` folds
// the per-syllable pulse into it (surging on each syllable). `tint` picks the colour
// family (cool = laugh, hot = angry). The rest are the per-dealer wave look — how many
// waves cross the mouth, their spatial density, and travel rate.
export interface VoiceEmote {
  open: number
  energy: number
  tint: 'cool' | 'hot'
  waveCount: number
  cycles: number
  flowHz: number
}

// Mouth colours per emote tint: the panel lerps from its resting near-black grey toward
// `lit` with the voice energy, and the travelling waves glow in `wave` (drawn additively).
// Cool = the laugh (pale blue-white light); hot = the angry growl (angry red/orange).
const MOUTH_TINTS: Record<VoiceEmote['tint'], { lit: string; wave: string }> = {
  cool: { lit: '#7e8bad', wave: '206, 220, 248' },
  hot: { lit: '#a65a4c', wave: '255, 138, 80' },
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
  const leaving = view.leaving(now)
  const hit = view.hit(now)

  ctx.save()
  if (arriving !== null) {
    // Slide in from off-screen RIGHT, taking WALK_STEPS steps, fading in over the
    // first third so it doesn't pop. Each step dips the figure DOWN then back to
    // baseline: |sin| gives WALK_STEPS positive lobes peaking at (i + 0.5)/WALK_STEPS
    // — the footfalls the step sfx is fired on — and rests at 0 at both ends, so the
    // walk-in settles onto its mark with no snap.
    const slide = smoothEnd3(arriving)
    const travel = layout.width * 0.6
    const bob = Math.abs(Math.sin(arriving * Math.PI * WALK_STEPS)) * d.headR * WALK_BOB
    ctx.translate(travel * (1 - slide), bob)
    ctx.globalAlpha = smoothEnd2(Math.min(1, arriving / 0.3))
  } else if (leaving !== null) {
    // The mirror of the walk-in: stride off to the right, ACCELERATING away
    // (smoothStart3, the flip of the walk-in's decelerating ease), same WALK_STEPS bob. NO
    // fade — the figure walks fully off the right edge at full opacity (travel clears it).
    const slide = smoothStart3(leaving)
    const travel = layout.width * 0.6
    const bob = Math.abs(Math.sin(leaving * Math.PI * WALK_STEPS)) * d.headR * WALK_BOB
    ctx.translate(travel * slide, bob)
  }
  // Take-damage jitter + the ambient low-health tremor (both small, applied after the
  // walk-in translate). The animator reports both in headR-fraction units, so scale to
  // pixels here. The tremor is zero mid-transition, so this stays a no-op during a walk-in.
  const tremor = view.tremor(now)
  ctx.translate((hit.shakeX + tremor.x) * d.headR, (hit.shakeY + tremor.y) * d.headR)

  // The bowtie's colour is this dealer's identity (RGB dealers shimmer with `now`).
  const shift = view.figureShift(now)
  const colors = dealerColors(shift, now)
  // The Banker coda sets the figure's shift to the sentinel one past the real dealers
  // (TOTAL_DEALERS + 1): it renders as THE BANKER (charcoal suit + monocle), not a robot.
  const banker = shift > TOTAL_DEALERS
  drawFigure(ctx, d, view.eyeCore(now), view.browFear(now), angerFor(shift), colors.bowtie, colors.bowtieKnot, shift >= TOTAL_DEALERS, banker, view.voice(now), now)

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
  // The glow gradient's alpha scales linearly with `a`, and the blend is additive, so a
  // single full-strength gradient drawn at globalAlpha = a reproduces every intensity —
  // letting it be cached (built at the origin) and translated onto each eye.
  ctx.globalAlpha *= a
  const grad = cachedGradient(ctx, `dealer-eye:${Math.round(r)}`, (c) => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r)
    g.addColorStop(0, 'rgba(255, 70, 70, 0.95)')
    g.addColorStop(0.5, 'rgba(255, 40, 40, 0.4)')
    g.addColorStop(1, 'rgba(255, 30, 30, 0)')
    return g
  })
  ctx.fillStyle = grad
  for (const e of [eyes.left, eyes.right]) {
    ctx.save()
    ctx.translate(e.x, e.y)
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

// The Banker is a portly, well-fed house man — his torso + suit are drawn this much wider than
// a standard dealer's. His head/face keep their geometry, so only the body reads broader.
const BANKER_BODY_WIDEN = 1.26

// --- the figure (torso + head + bowtie + eyes) --------------------------------

function drawFigure(
  ctx: CanvasRenderingContext2D,
  d: DealerBox,
  eyeCore: number,
  browFear: number,
  anger: number,
  bowtie: string,
  bowtieKnot: string,
  imposing: boolean,
  banker: boolean,
  voice: VoiceEmote | null,
  now: number,
): void {
  ctx.save()

  // The Banker is stouter than the robots — widen his torso about its centre. Only the body
  // bounds change here (the suit is widened to match, below); the head/eyes/mouth keep their
  // geometry, so a normal-sized head sits on a broader body.
  if (banker) {
    const half = ((d.bodyRight - d.bodyLeft) / 2) * BANKER_BODY_WIDEN
    d = { ...d, bodyLeft: d.cx - half, bodyRight: d.cx + half }
  }

  ctx.fillStyle = TORSO
  ctx.beginPath()
  ctx.roundRect(d.bodyLeft, d.bodyTop, d.bodyRight - d.bodyLeft, d.baseY - d.bodyTop, d.headR * 0.18)
  ctx.fill()

  if (banker) {
    // THE BANKER: a three-piece charcoal suit over the torso, in place of the robot's
    // epaulets. Its gold accent reuses the resolved bowtie colour. Widened to match the torso.
    drawBankerSuit(ctx, d, bowtie, bowtieKnot, BANKER_BODY_WIDEN)
  } else if (imposing) {
    // The final dealer wears ceremonial epaulets — an old-guard officer. Anchored well
    // inboard of the torso's top corners so the pair sits close together across the
    // shoulders rather than flaring out to the arms.
    const shoulderInset = d.headR * -0.16
    drawEpaulets(ctx, d, d.bodyLeft + shoulderInset, d.bodyRight - shoulderInset, d.bodyTop)
  }

  ctx.fillStyle = HEAD
  ctx.beginPath()
  ctx.roundRect(d.cx - d.headR, d.headCenterY - d.headR, d.headR * 2, d.headR * 2, d.headR * 0.35)
  ctx.fill()

  // The Banker has no bowtie — his suit does the talking. Every other dealer wears one,
  // its colour marking which dealer this is.
  if (!banker) {
    drawBowtie(ctx, d, bowtie, bowtieKnot)
  }

  // Eye cores — same geometry as dealerEyes() in scene.ts (−0.1·headR y, ±0.42·headR
  // x, 0.16·headR r), so the cores sit exactly under the emissive glow, which is a
  // separate pass on the mask layer (drawDealerEyeGlow) that reads dealerEyes. Keep
  // these coefficients in sync with it. A dark socket is always painted; the bright
  // red LED is layered over it at `eyeCore` opacity, so a flickering low-health
  // dealer's eyes read as blinking off (down to the dead socket) and back on.
  const eyeY = d.headCenterY - d.headR * 0.1
  const eyeR = d.headR * 0.16
  ctx.beginPath()
  ctx.arc(d.cx - d.headR * 0.42, eyeY, eyeR, 0, Math.PI * 2)
  ctx.arc(d.cx + d.headR * 0.42, eyeY, eyeR, 0, Math.PI * 2)
  ctx.fillStyle = EYE_OFF
  ctx.fill()
  if (eyeCore > 0.001) {
    ctx.globalAlpha = clamp01(eyeCore)
    ctx.fillStyle = EYE
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // Angry brows: a hood shadow clips each eye's top-inner into a slit, then a
  // raised brow plate sits above it. Both angle DOWN toward the centre (\ /), the
  // classic menace read — steeper for each later dealer (`anger`), so the first
  // dealer's brows sit level and the last's bear down hardest. Drawn after the eyes
  // so the hood cuts the red core. On a hit they swing up into a scared /\
  // (browFear 0..1) and roll back.
  drawBrows(ctx, d, eyeY, browFear, banker ? 0 : anger) // the Banker is amused/indifferent — level brows, never menacing

  // Rectangular mouth panel, a little lighter than the head, set below the eyes. When
  // the dealer emotes (an evil laugh), the panel LIGHTS UP — the resting near-black grey
  // lerps toward a lit grey with the voice's energy — and travelling waves ripple across
  // it, pulsing per syllable. The grille separators read as gritted teeth at rest and
  // give the readout its "vocoder bars", drawn LAST so the waves flow behind them.
  const mouthW = d.headR * 1.02
  const mouthH = d.headR * 0.3
  const mouthY = d.headCenterY + d.headR * 0.42
  const mouthX = d.cx - mouthW / 2
  const mouthTop = mouthY - mouthH / 2
  const mouthR = d.headR * 0.08

  const energy = voice ? clamp01(voice.energy) : 0
  const litColor = voice ? MOUTH_TINTS[voice.tint].lit : MOUTH_TINTS.cool.lit
  ctx.fillStyle = energy > 0.001 ? mixHex(MOUTH, litColor, energy) : MOUTH
  ctx.beginPath()
  ctx.roundRect(mouthX, mouthTop, mouthW, mouthH, mouthR)
  ctx.fill()

  if (voice && voice.open > 0.001) {
    drawMouthWaves(ctx, mouthX, mouthTop, mouthW, mouthH, mouthR, voice, now)
  }

  ctx.fillStyle = GRILLE
  const teeth = 5
  const sepW = d.headR * 0.055
  for (let i = 1; i <= teeth; i++) {
    const x = mouthX + (mouthW * i) / (teeth + 1) - sepW / 2
    ctx.fillRect(x, mouthTop, sepW, mouthH)
  }

  // THE BANKER's monocle, over the right eye (same eye geometry as above). Drawn last so
  // its gold rim sits cleanly over the eye and brow.
  if (banker) {
    drawMonocle(ctx, d, eyeY, eyeR, bowtie, bowtieKnot)
  }

  ctx.restore()
}

// The voice readout: one or more emissive waves travelling across the lit mouth panel,
// clipped to it (so nothing spills past the rounded rect) and drawn additively so they
// glow. Amplitude + brightness swell with the voice energy (loudest on each syllable);
// count / density / travel direction are the dealer's per-voice look. Sits UNDER the
// grille teeth, which the caller paints next.
function drawMouthWaves(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  voice: VoiceEmote,
  now: number,
): void {
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.clip()

  const cy = y + h / 2
  const e = clamp01(voice.energy)
  const open = clamp01(voice.open)
  const waveColor = MOUTH_TINTS[voice.tint].wave
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  const k = (Math.PI * 2 * voice.cycles) / w // radians per pixel → `cycles` full waves across the mouth
  // Travelling phase: TIME drives it (not position), so the wave visibly slides across the
  // mouth. `sin(k·local − ωt)` is a wave moving in +x; flipping ω's sign moves it the other
  // way. ω is well above the spatial rate, so the crests clearly flow rather than standing.
  const omega = (now / 1000) * voice.flowHz * Math.PI * 2
  // Amplitude keeps a steady, open-gated floor so the flow reads even between syllables,
  // then swells with each "HA".
  const maxAmp = h * (0.14 * open + 0.26 * e)
  const steps = 30
  for (let wi = 0; wi < voice.waveCount; wi++) {
    // A second wave travels the OPPOSITE way (and offset), so the two crossing ripples make
    // the motion unmistakable rather than reading as one wave pulsing in place.
    const dir = wi % 2 === 0 ? 1 : -1
    const phase = dir * omega + wi * 1.9
    const amp = maxAmp * (wi === 0 ? 1 : 0.72)
    const yOff = wi === 0 ? 0 : h * 0.1
    const alpha = (0.3 + 0.55 * e) * open * (wi === 0 ? 1 : 0.75)
    ctx.strokeStyle = `rgba(${waveColor}, ${alpha})`
    ctx.lineWidth = Math.max(1, h * 0.12)
    ctx.beginPath()
    for (let s = 0; s <= steps; s++) {
      const local = (w * s) / steps
      const py = cy + yOff + Math.sin(local * k - phase) * amp
      if (s === 0) {
        ctx.moveTo(x + local, py)
      } else {
        ctx.lineTo(x + local, py)
      }
    }
    ctx.stroke()
  }
  ctx.restore()
}

// Lerp between two #rrggbb colours, returning an rgb() string. Used to brighten the
// mouth panel toward its lit grey as the voice energy rises.
function mixHex(a: string, b: string, t: number): string {
  const ca = parseInt(a.slice(1), 16)
  const cb = parseInt(b.slice(1), 16)
  const r = Math.round((ca >> 16 & 255) + ((cb >> 16 & 255) - (ca >> 16 & 255)) * t)
  const g = Math.round((ca >> 8 & 255) + ((cb >> 8 & 255) - (ca >> 8 & 255)) * t)
  const bl = Math.round((ca & 255) + ((cb & 255) - (ca & 255)) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

// The full-fear brow swing, in radians (left CCW, right CW). Scaled by browFear.
const BROW_FEAR_ANGLE = (40 * Math.PI) / 180

// How much the inner brow tip drops below its bar's midline at full anger, in headR
// units. Scaled by `anger` (0 = level brows, 1 = the full menace) so each later
// dealer's brows bear down harder; the outer tip lifts by the same amount, pivoting
// each bar about its midline so its average height stays put.
const BROW_INNER_DROP = 0.12

// Angry brows + hooded eye-slits. Each is an angled bar rendered as a rotated
// rounded rect (helper below). Geometry is all in headR units off the eye line.
// `anger` (0..1) sets the resting downward tilt toward centre — level for the first
// dealer, steepest for the last. `fear` (0..1) then hinges the whole brow unit at
// its OUTER corner so the inner tips lift into a worried /\ — left brow CCW, right
// CW. Canvas angles are CW-positive, so the per-side sign is just `sx` (-1 =
// left/CCW, +1 = right/CW). Lifting the hood off the eye at the same time widens the
// slit, reinforcing the scared read.
function drawBrows(ctx: CanvasRenderingContext2D, d: DealerBox, eyeY: number, fear: number, anger: number): void {
  const r = d.headR
  const drop = r * BROW_INNER_DROP * anger
  for (const sx of [-1, 1]) {
    const outerX = d.cx + sx * r * 0.72
    const innerX = d.cx + sx * r * 0.14
    ctx.save()
    if (fear > 0.001) {
      const pivotX = outerX
      const pivotY = eyeY - r * 0.35
      ctx.translate(pivotX, pivotY)
      ctx.rotate(sx * BROW_FEAR_ANGLE * fear)
      ctx.translate(-pivotX, -pivotY)
    }
    // Hood: near-black, sits low enough to shave the eye's top-inner into a slit.
    drawBar(ctx, outerX, eyeY - r * 0.16 - drop, innerX, eyeY - r * 0.16 + drop, r * 0.2, HOOD)
    // Brow plate: raised metal, angled the same way, riding just above the hood.
    drawBar(ctx, outerX, eyeY - r * 0.34 - drop, innerX, eyeY - r * 0.34 + drop, r * 0.13, BROW)
    ctx.restore()
  }
}

// This dealer's brow anger, 0..1: the first dealer's brows sit level (0), the last
// fixed dealer's (and the RGB dealer past it) bear down hardest (1). Mirrors the
// board-tech ramp in palette.ts so menace and gear advance together.
function angerFor(shiftIndex: number): number {
  return Math.min(Math.max((shiftIndex - 1) / (TOTAL_DEALERS - 1), 0), 1)
}

// A thick angled bar drawn as a rotated rounded rect between two points.
function drawBar(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thick: number,
  color: string,
): void {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.hypot(x2 - x1, y2 - y1) + thick
  ctx.save()
  ctx.translate(mx, my)
  ctx.rotate(ang)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(-len / 2, -thick / 2, len, thick, thick * 0.4)
  ctx.fill()
  ctx.restore()
}

function drawBowtie(ctx: CanvasRenderingContext2D, d: DealerBox, bowtie: string, bowtieKnot: string): void {
  const cy = d.headCenterY + d.headR * 1.5 // on the upper chest, a bit down from the head
  const wingW = d.headR * 0.6
  const wingH = d.headR * 0.44
  const knot = d.headR * 0.15

  ctx.save()
  ctx.fillStyle = bowtie
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
  ctx.fillStyle = bowtieKnot
  ctx.beginPath()
  ctx.roundRect(d.cx - knot, cy - knot, knot * 2, knot * 2, knot * 0.4)
  ctx.fill()
  ctx.restore()
}

// Old-school Victorian dress epaulets on each shoulder of the imposing final dealer:
// a gold shoulder board capped at its outer end by an oval crescent, with a skirt of
// bullion fringe (many thin hanging gold strands) beneath it. Mirrored per side.
// `leftX`/`rightX` are the shoulder anchor points, `topY` the torso top edge — the
// epaulets ride on those corners.
function drawEpaulets(ctx: CanvasRenderingContext2D, d: DealerBox, leftX: number, rightX: number, topY: number): void {
  drawEpaulet(ctx, d.headR, -1, leftX, topY)
  drawEpaulet(ctx, d.headR, 1, rightX, topY)
}

// One epaulet. `sx` is the side (-1 left, +1 right); `shoulderX` the shoulder anchor on
// that side; `topY` the torso top. The board runs INWARD (toward the neck) from the
// crescent, which sits at the outer shoulder point with the fringe hanging beneath it.
function drawEpaulet(ctx: CanvasRenderingContext2D, r: number, sx: number, shoulderX: number, topY: number): void {
  const boardLen = r * 0.66
  const boardH = r * 0.3
  const boardTop = topY - r * 0.02
  const outerX = shoulderX + sx * r * 0.06 // cap a touch past the shoulder point
  const innerX = shoulderX - sx * boardLen // run inward toward the collar
  const left = Math.min(outerX, innerX)
  const width = Math.abs(outerX - innerX)

  // Metallic ramp, cached per size. Coords are baked in the figure's local space; the
  // whole dealer is translated as a unit during walk-in/tremor, so the sheen tracks it.
  const grad = cachedGradient(ctx, `epaulet:${Math.round(r)}:${Math.round(boardTop)}`, (c) => {
    const g = c.createLinearGradient(0, boardTop, 0, boardTop + boardH + r * 0.6)
    g.addColorStop(0, EPAULET_HI)
    g.addColorStop(0.42, EPAULET_MID)
    g.addColorStop(1, EPAULET_LO)
    return g
  })

  // The crescent is a flattened oval (wider than tall) — the classic epaulet pad, not
  // a ball. Its half-width bounds the fringe so no strand ever pokes out past it.
  const crescentCX = shoulderX - sx * r * 0.16
  const crescentCY = boardTop + boardH * 0.5
  const crescentRX = r * 0.42
  const crescentRY = r * 0.28

  // Bullion fringe first, so the board + crescent overlap the strand tops (the fringe
  // reads as spilling out from under the crescent). Many thin strands; a gentle length
  // arch (longest in the middle) skirts the bottom. The span stays well inside the
  // oval's half-width so the outermost strands hang UNDER it, never beyond its edge.
  ctx.fillStyle = grad
  const strands = 11
  const fringeSpan = crescentRX * 2 * 0.78
  const fringeW = r * 0.028
  const fringeTop = crescentCY + crescentRY * 0.4
  for (let i = 0; i < strands; i++) {
    const t = i / (strands - 1)
    const fx = crescentCX - fringeSpan / 2 + t * fringeSpan
    const len = r * 0.48 * (0.7 + 0.3 * Math.sin(t * Math.PI))
    ctx.beginPath()
    ctx.roundRect(fx - fringeW / 2, fringeTop, fringeW, len, fringeW * 0.5)
    ctx.fill()
  }

  ctx.strokeStyle = EPAULET_EDGE
  ctx.lineWidth = Math.max(1, r * 0.03)

  // The shoulder board (strap).
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.roundRect(left, boardTop, width, boardH, boardH * 0.45)
  ctx.fill()
  ctx.stroke()

  // The oval crescent at the outer end.
  ctx.beginPath()
  ctx.ellipse(crescentCX, crescentCY, crescentRX, crescentRY, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // A bright button/pip fastening the crescent's centre.
  ctx.fillStyle = EPAULET_HI
  ctx.beginPath()
  ctx.arc(crescentCX, crescentCY, crescentRY * 0.34, 0, Math.PI * 2)
  ctx.fill()
}

// THE BANKER's three-piece suit, painted over the black torso in place of the robot's
// bowtie + epaulets: a charcoal waistcoat panel down the chest, framed by two darker
// jacket lapels that meet in a V at the button break, with gold vest buttons and a
// watch-chain swag. `gold`/`goldDark` are the figure's resolved bowtie colours (the
// Banker's palette sets them to gold). All geometry is anchored on the torso box, so the
// suit rides the walk-in / tremor / break-apart with the rest of the figure for free.
function drawBankerSuit(ctx: CanvasRenderingContext2D, d: DealerBox, gold: string, goldDark: string, xScale = 1): void {
  const r = d.headR
  const topY = d.bodyTop
  const breakY = topY + r * 1.7 // where the jacket closes and the lapels meet
  const vestHalf = r * 0.52
  const neckHalf = r * 0.3 // half-width of the collar gap at the top
  const shoulderHalf = r * 0.98 // lapel outer edge, just inside the torso corners

  ctx.save()

  // Widen the whole suit horizontally about the torso centre (the Banker is stout), matched to
  // the torso's own widening in drawFigure so the jacket fills the broader body. Vertical
  // extents (collar, break, tie) are unchanged — he's wider, not taller.
  if (xScale !== 1) {
    ctx.translate(d.cx, 0)
    ctx.scale(xScale, 1)
    ctx.translate(-d.cx, 0)
  }

  // A pale dress shirt fills the collar V behind the tie — drawn first so the tie, waistcoat,
  // and lapels all layer over it. A touch wider than the lapel gap so the lapels overlap its
  // edges cleanly (no seam).
  ctx.fillStyle = SHIRT
  ctx.beginPath()
  ctx.moveTo(d.cx - neckHalf * 1.15, topY)
  ctx.lineTo(d.cx + neckHalf * 1.15, topY)
  ctx.lineTo(d.cx, breakY)
  ctx.closePath()
  ctx.fill()

  // Gray silk necktie, hanging from the collar. Drawn BEFORE the waistcoat so its lower blade
  // TUCKS BEHIND the vest neckline (a real three-piece look) rather than sitting on top of the
  // vest; the knot goes on later, over the collar. Anchored on topY/breakY so it rides the
  // walk-in / tremor / break-apart with the figure.
  const knotTop = topY + r * 0.02
  const knotBot = topY + r * 0.3
  const knotTopHalf = r * 0.1
  const knotBotHalf = r * 0.13
  const bladeTopHalf = r * 0.08
  const bladeHalf = r * 0.2 // widest, just above where the vest neckline swallows the blade
  const tipY = breakY + r * 0.12 // pointed tip, tucked behind the vest (below the neckline point)
  const wideY = tipY - r * 0.42 // the blade's widest point, above the tuck

  // Blade (narrow under the knot → widest → centre point).
  ctx.fillStyle = TIE_SILK
  ctx.beginPath()
  ctx.moveTo(d.cx - bladeTopHalf, knotBot - r * 0.02)
  ctx.lineTo(d.cx + bladeTopHalf, knotBot - r * 0.02)
  ctx.lineTo(d.cx + bladeHalf, wideY)
  ctx.lineTo(d.cx, tipY)
  ctx.lineTo(d.cx - bladeHalf, wideY)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = TIE_EDGE
  ctx.lineWidth = Math.max(1, r * 0.02)
  ctx.stroke()

  // A faint lighter crease down the blade's centre — a hint of silk sheen.
  ctx.strokeStyle = TIE_SHEEN
  ctx.lineWidth = Math.max(1, r * 0.02)
  ctx.beginPath()
  ctx.moveTo(d.cx, knotBot)
  ctx.lineTo(d.cx, tipY - r * 0.05)
  ctx.stroke()

  // Waistcoat: the two front panels rise to the shoulders and the neckline dips to a point at
  // the button break — the tie disappears behind the vest here. Drawn OVER the tie's lower
  // blade and UNDER the lapels; runs to baseY so it tucks behind the rail like the torso.
  ctx.fillStyle = SUIT_VEST
  ctx.beginPath()
  ctx.moveTo(d.cx - vestHalf, topY)
  ctx.lineTo(d.cx, breakY)
  ctx.lineTo(d.cx + vestHalf, topY)
  ctx.lineTo(d.cx + vestHalf, d.baseY)
  ctx.lineTo(d.cx - vestHalf, d.baseY)
  ctx.closePath()
  ctx.fill()

  // Jacket lapels: a triangle per side, from the collar/shoulder down to the button break,
  // framing the shirt/tie V between them. Lighter than the near-black torso so the fold reads
  // against the jacket shoulders that stay torso-dark outside them.
  ctx.fillStyle = SUIT_LAPEL
  for (const sx of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(d.cx + sx * neckHalf, topY) // inner collar point
    ctx.lineTo(d.cx + sx * shoulderHalf, topY) // outer shoulder
    ctx.lineTo(d.cx + sx * shoulderHalf, breakY) // down the torso side
    ctx.lineTo(d.cx, breakY) // in to the button break
    ctx.closePath()
    ctx.fill()
  }

  // A thin highlight down each lapel's inner (V) edge — the folded-collar seam.
  ctx.strokeStyle = SUIT_VEST_EDGE
  ctx.lineWidth = Math.max(1, r * 0.03)
  for (const sx of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(d.cx + sx * neckHalf, topY)
    ctx.lineTo(d.cx, breakY)
    ctx.stroke()
  }

  // Knot, over the collar where the lapels meet the neck — a small trapezoid a shade darker
  // than the blade, capping the shirt V.
  ctx.fillStyle = TIE_KNOT
  ctx.beginPath()
  ctx.moveTo(d.cx - knotTopHalf, knotTop)
  ctx.lineTo(d.cx + knotTopHalf, knotTop)
  ctx.lineTo(d.cx + knotBotHalf, knotBot)
  ctx.lineTo(d.cx - knotBotHalf, knotBot)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = TIE_EDGE
  ctx.lineWidth = Math.max(1, r * 0.02)
  ctx.stroke()

  // Gold vest buttons down the centre, from the button break downward (stopping before the
  // rail line).
  ctx.fillStyle = gold
  const buttonR = r * 0.06
  for (let i = 0; i < 3; i++) {
    const by = breakY + r * 0.3 + i * r * 0.42
    if (by > d.baseY) {
      break
    }
    ctx.beginPath()
    ctx.arc(d.cx, by, buttonR, 0, Math.PI * 2)
    ctx.fill()
  }

  // Gold watch-chain swag across the waistcoat, dipping between two anchor points.
  ctx.strokeStyle = goldDark
  ctx.lineWidth = Math.max(1, r * 0.035)
  const chainY = breakY + r * 0.5
  ctx.beginPath()
  ctx.moveTo(d.cx - vestHalf * 0.85, chainY)
  ctx.quadraticCurveTo(d.cx, chainY + r * 0.42, d.cx + vestHalf * 0.85, chainY)
  ctx.stroke()

  // A folded silk pocket square in the jacket's breast pocket (the wearer's-left lapel, i.e.
  // viewer's right). Three pale peaks poke up from a short dark welt — a dressy flourish.
  const psCx = d.cx + r * 0.58
  const psY = topY + r * 0.86 // the pocket welt line
  const psW = r * 0.32
  const psPeakH = r * 0.17
  ctx.fillStyle = POCKET_SQUARE
  for (const k of [-1, 0, 1]) {
    const peakCx = psCx + k * psW * 0.28
    ctx.beginPath()
    ctx.moveTo(peakCx - psW * 0.17, psY)
    ctx.lineTo(peakCx, psY - psPeakH)
    ctx.lineTo(peakCx + psW * 0.17, psY)
    ctx.closePath()
    ctx.fill()
  }
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.lineWidth = Math.max(1, r * 0.05)
  ctx.beginPath()
  ctx.moveTo(psCx - psW / 2, psY)
  ctx.lineTo(psCx + psW / 2, psY)
  ctx.stroke()

  ctx.restore()
}

// THE BANKER's monocle: a stroked gold ring over the RIGHT eye (the existing eye
// geometry passed in), a small bright glint on the rim, and a short cord dropping from
// it. `gold`/`goldDark` are the figure's resolved bowtie colours (gold for the Banker).
function drawMonocle(ctx: CanvasRenderingContext2D, d: DealerBox, eyeY: number, eyeR: number, gold: string, goldDark: string): void {
  const ex = d.cx + d.headR * 0.42 // over the right eye
  const rimR = eyeR * 1.95

  ctx.save()

  // Rim.
  ctx.strokeStyle = gold
  ctx.lineWidth = Math.max(1, d.headR * 0.05)
  ctx.beginPath()
  ctx.arc(ex, eyeY, rimR, 0, Math.PI * 2)
  ctx.stroke()

  // Glint: a short bright arc on the upper-left of the rim.
  ctx.strokeStyle = 'rgba(255, 250, 230, 0.85)'
  ctx.lineWidth = Math.max(1, d.headR * 0.03)
  ctx.beginPath()
  ctx.arc(ex, eyeY, rimR * 0.78, Math.PI * 1.02, Math.PI * 1.34)
  ctx.stroke()

  // Cord: a short strand dropping from the rim's outer-bottom down the cheek.
  ctx.strokeStyle = goldDark
  ctx.lineWidth = Math.max(1, d.headR * 0.028)
  ctx.beginPath()
  ctx.moveTo(ex + rimR * 0.62, eyeY + rimR * 0.62)
  ctx.quadraticCurveTo(ex + rimR * 0.9, eyeY + rimR * 1.7, ex + rimR * 0.5, eyeY + rimR * 2.4)
  ctx.stroke()

  ctx.restore()
}

// A white additive over-exposure of the figure on impact, fading with `flash`.
function drawHitFlash(ctx: CanvasRenderingContext2D, d: DealerBox, flash: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = clamp01(flash) * 0.8
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.roundRect(d.bodyLeft, d.bodyTop, d.bodyRight - d.bodyLeft, d.baseY - d.bodyTop, d.headR * 0.18)
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
