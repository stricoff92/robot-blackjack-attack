// Card rendering on the felt: dealer hand across the upper table, player
// hand(s) lower down. Card faces/backs come from the offscreen sprite cache.
//
// Cards can be drawn mid-deal: a `CardAnim` supplies, per card, its flight
// progress (shoe → slot) and flip progress (back → face). With no anim
// supplied, everything renders settled and face-up (hole card excepted).

import type { Card } from '../game/deck'
import { evaluateHand } from '../game/hand'
import type { Round } from '../game/round'
import { activeCardBack, blitCard, getCardSprite } from './card-sprite'
import { smoothEnd3, smoothStart2, smoothStep } from './easing'
import type { CardBack } from './palette'
import { dealerBox, dealerEyes, type DealerEyes, type Layout } from './scene'

const CARD_RATIO = 0.7 // width / height, roughly a real playing card

// Shoe (deck) stack geometry — also the origin point for deal animations.
const SHOE_LAYERS = 6
const SHOE_DX = 0.025 // horizontal offset per stacked card, × card width
const SHOE_DY = 0.02 // vertical offset per stacked card, × card height

// How far the shoe's offset stack steps beyond its top card's (x, y): the layers fan
// down-right, so the deck's full footprint is (w + dx) wide × (h + dy) tall. The spawn
// wrap reads this so the plastic covers the whole stack, not just the top card.
export function shoeStackExtent(w: number, h: number): { dx: number; dy: number } {
  return { dx: w * SHOE_DX * SHOE_LAYERS, dy: h * SHOE_DY * SHOE_LAYERS }
}

// Player cards' top edge, as a fraction of felt height below the felt top. Kept
// with room above (for the big count + result) and below (for the betting circle).
// chips.ts shares it.
export const PLAYER_ROW = 0.56

// Per-card animation state, supplied by the deal animator.
export interface CardState {
  flight: number // 0..1 progress from the shoe to the slot (1 = landed)
  flip: number // 0..1 reveal flip (0 = face-down, 1 = face-up)
  collect: number // 0..1 gather back to the deck at end of hand (1 = merged in)
}

export interface CardAnim {
  // Animation state for a card slot, or null if it hasn't started dealing yet.
  state(key: string): CardState | null
}

// One hand's outcome, drawn beside that hand's count. Every player hand reports
// its own, so each half of a split shows whether it won or lost.
export interface RoundResult {
  label: string // e.g. "Win +50", "Lose -50", "Push", "Bust -50"
  tone: 'win' | 'lose' | 'push'
}

// Stable identity for a card slot, shared by the renderer and the animator.
export function dealerKey(index: number): string {
  return `d:${index}`
}

export function playerKey(handIndex: number, cardIndex: number): string {
  return `p:${handIndex}:${cardIndex}`
}

// Shared card size, responsive to both dimensions: driven by felt height, but
// capped by screen width so cards don't get oversized on narrow/portrait phones.
export function cardSize(l: Layout): { w: number; h: number } {
  const byHeight = (l.height - l.edgeY) * 0.22
  const byWidth = (l.width * 0.13) / CARD_RATIO
  const h = clamp(Math.min(byHeight, byWidth), 48, 168)
  return { w: h * CARD_RATIO, h }
}

// Horizontal placement of the player's hand(s). A single hand sits at centre.
// Split hands are packed into a centred band of the felt — NOT spread to the
// screen edges — so the outer hands and their bet chips stay clear of the corner
// HUD (powerups bottom-left, bankroll bottom-right) and read like real
// side-by-side split hands. Cards shrink as more hands fill the band.
const HAND_BAND = 0.66 // widest fraction of the felt the hand group may span

function handSlot(l: Layout, count: number): number {
  const { w: cardW } = cardSize(l)
  const natural = cardW * 2.1 // comfortable width per hand when there's room
  return Math.min(natural, (l.width * HAND_BAND) / count)
}

// Centre X of hand `index` within a layout of `count` hands.
export function handCenterX(l: Layout, index: number, count: number): number {
  if (count <= 1) {
    return l.width / 2
  }
  const slot = handSlot(l, count)
  const start = l.width / 2 - (slot * count) / 2
  return start + slot * (index + 0.5)
}

// Card scale for a `count`-hand layout (1 for a single hand).
export function handCardScale(l: Layout, count: number): number {
  if (count <= 1) {
    return 1
  }
  const { w: cardW } = cardSize(l)
  return Math.min(1, handSlot(l, count) / (cardW * 1.75))
}

// Centre point of a single player card, matching drawHands' placement — the
// origin a reward token flies from when a hit is rewarded.
export function playerCardCenter(l: Layout, round: Round, handIndex: number, cardIndex: number): { x: number; y: number } {
  const count = round.hands.length
  const { w: cardW, h: cardH } = cardSize(l)
  const scale = handCardScale(l, count)
  const w = cardW * scale
  const h = cardH * scale
  const playerY = l.edgeY + (l.height - l.edgeY) * PLAYER_ROW
  const centerX = handCenterX(l, handIndex, count)
  const xs = rowXs(centerX, round.hands[handIndex].cards.length, w)
  const left = xs[cardIndex] ?? centerX - w / 2
  return { x: left + w / 2, y: playerY + h / 2 }
}

// Centre of a whole player hand's card cluster — the origin a win/blackjack
// reward flies from on resolve.
export function playerHandCenter(l: Layout, round: Round, handIndex: number): { x: number; y: number } {
  const count = round.hands.length
  const { h: cardH } = cardSize(l)
  const h = cardH * handCardScale(l, count)
  const playerY = l.edgeY + (l.height - l.edgeY) * PLAYER_ROW
  return { x: handCenterX(l, handIndex, count), y: playerY + h / 2 }
}

// One card resting on the felt, with its slot centre + size — the layout drawHands
// paints them at.
export interface TableCard {
  card: Card
  cx: number // slot centre x
  cy: number // slot centre y
  w: number
  h: number
}

// Every card currently on the table (dealer row, then each player hand), at the
// exact centres + sizes drawHands lays them out at. Shared with the dealer-spawn
// shred, so a card gets sucked into the mouth from precisely where it sat.
export function tableCards(l: Layout, round: Round): TableCard[] {
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const { w: cardW, h: cardH } = cardSize(l)
  const out: TableCard[] = []

  const dealerY = feltTop + feltHeight * 0.05
  const dealerXs = rowXs(l.width / 2, round.dealer.length, cardW)
  round.dealer.forEach((card, i) => {
    out.push({ card, cx: dealerXs[i] + cardW / 2, cy: dealerY + cardH / 2, w: cardW, h: cardH })
  })

  const playerY = feltTop + feltHeight * PLAYER_ROW
  const count = round.hands.length
  const scale = handCardScale(l, count)
  const w = cardW * scale
  const h = cardH * scale
  round.hands.forEach((hand, hi) => {
    const centerX = handCenterX(l, hi, count)
    const xs = rowXs(centerX, hand.cards.length, w)
    hand.cards.forEach((card, ci) => {
      out.push({ card, cx: xs[ci] + w / 2, cy: playerY + h / 2, w, h })
    })
  })
  return out
}

export function drawHands(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  round: Round,
  revealHole: boolean,
  anim?: CardAnim,
  results?: readonly (RoundResult | undefined)[],
  splitPrev?: Round,
): void {
  const dpr = window.devicePixelRatio || 1
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const { w: cardW, h: cardH } = cardSize(l)
  const origin = shoeAnchor(l)

  // Dealer hand near the top; card index 1 is the hole card. The total is shown
  // BELOW the hand and updates live as cards flip face-up (hole included only
  // once it's revealed and flipping).
  const dealerY = feltTop + feltHeight * 0.05
  const dealerXs = rowXs(l.width / 2, round.dealer.length, cardW)
  round.dealer.forEach((card, i) => {
    drawDealt(ctx, dealerKey(i), dealerXs[i], dealerY, cardW, cardH, card, i === 1, revealHole, anim, origin, dpr)
  })
  const countPx = clamp(cardH * 0.32, 18, 40)
  const shownDealer = faceUpDealer(round, revealHole, anim)
  if (shownDealer.length > 0) {
    drawCount(ctx, evaluateHand(shownDealer).total, l.width / 2, dealerY + cardH + cardH * 0.22, countPx)
  }

  // Player hand(s): the cards rest on top of the bet chips, so the total goes
  // ABOVE the cards.
  const playerY = feltTop + feltHeight * PLAYER_ROW
  const count = round.hands.length
  const scale = handCardScale(l, count)
  const w = cardW * scale
  const h = cardH * scale
  // On a split, the two originally-dealt cards glide out of the single-hand
  // layout into the two new hands (rather than flying in from the shoe); their
  // pre-split slots come from `splitPrev`. Every other card flies from the shoe.
  const slideOrigin = splitSlideOrigin(l, round, splitPrev, w, h, playerY)
  round.hands.forEach((hand, hi) => {
    const centerX = handCenterX(l, hi, count)
    const xs = rowXs(centerX, hand.cards.length, w)
    // With more than one hand in play (a split), ring the active hand so it's
    // clear which one Hit/Stand/Double act on. Drawn behind that hand's cards.
    if (count > 1 && hi === round.activeIndex && round.status === 'player-turn') {
      const left = xs[0]
      const width = xs[xs.length - 1] + w - left
      drawActiveHandRing(ctx, left, playerY, width, h)
    }
    hand.cards.forEach((card, ci) => {
      const key = playerKey(hi, ci)
      const from = slideOrigin?.(key) ?? origin
      drawDealt(ctx, key, xs[ci], playerY, w, h, card, false, true, anim, from, dpr)
    })
    if (laneSettled(hand.cards.length, (ci) => playerKey(hi, ci), anim)) {
      // Each hand shows its own win/loss/push — both halves of a split settle.
      drawCount(ctx, evaluateHand(hand.cards).total, centerX, playerY - cardH * 0.34, countPx, results?.[hi])
    }
  })
}

// Origin resolver for a split's gliding cards. On a fresh 1-hand → 2-hand split
// the two originals map back to their single-hand slots, so drawDealt tweens them
// from where they sat into their new hands (drawn at the new, smaller size but
// starting centred on the original). Returns null when this isn't such a split,
// so every card just flies from the shoe.
function splitSlideOrigin(
  l: Layout,
  round: Round,
  splitPrev: Round | undefined,
  w: number,
  h: number,
  playerY: number,
): ((key: string) => { x: number; y: number } | null) | null {
  if (!splitPrev || splitPrev.hands.length !== 1 || round.hands.length !== 2) {
    return null
  }
  const { w: cardW, h: cardH } = cardSize(l)
  const oldScale = handCardScale(l, 1)
  const oldW = cardW * oldScale
  const oldH = cardH * oldScale
  const oldXs = rowXs(handCenterX(l, 0, 1), splitPrev.hands[0].cards.length, oldW)
  const originFor = (oldIndex: number) => ({
    x: oldXs[oldIndex] + oldW / 2 - w / 2,
    y: playerY + oldH / 2 - h / 2,
  })
  // The left original heads to the first hand, the right original to the second.
  const map: Record<string, number> = {
    [playerKey(0, 0)]: 0,
    [playerKey(1, 0)]: 1,
  }
  return (key) => (key in map ? originFor(map[key]) : null)
}

// The dealer cards currently showing their face — the basis for the live total.
// A card counts once it has flipped past halfway (matching drawDealt's swap).
// Returns [] (so the total is dropped) the moment the hand starts gathering back
// into the deck, so the count doesn't linger through the shuffle.
function faceUpDealer(round: Round, revealHole: boolean, anim?: CardAnim): Card[] {
  const up: Card[] = []
  for (let i = 0; i < round.dealer.length; i++) {
    const card = round.dealer[i]
    let faceUp: boolean
    if (anim) {
      const st = anim.state(dealerKey(i))
      if (st && st.collect > 0) {
        return [] // being gathered — drop the total
      }
      faceUp = st !== null && st.flip >= 0.5
    } else {
      faceUp = !(i === 1 && !revealHole)
    }
    if (faceUp) {
      up.push(card)
    }
  }
  return up
}

// Draw one card: partway along its flight from the shoe, and/or mid-flip.
function drawDealt(
  ctx: CanvasRenderingContext2D,
  key: string,
  targetX: number,
  targetY: number,
  w: number,
  h: number,
  card: Card,
  isHole: boolean,
  revealed: boolean,
  anim: CardAnim | undefined,
  origin: { x: number; y: number },
  dpr: number,
): void {
  let flight = 1
  let flip = isHole && !revealed ? 0 : 1
  let collect = 0
  if (anim) {
    const st = anim.state(key)
    if (st === null) {
      return // not dealt yet
    }
    flight = st.flight
    flip = st.flip
    collect = st.collect
  }
  if (collect >= 1) {
    return // gathered back into the deck
  }

  let x = targetX
  let y = targetY
  if (collect > 0) {
    // Gather back to the deck: flip face-down IN PLACE first, then fly to the deck
    // top and land on it — no fade, the face-down card just merges into the deck's
    // top card back.
    const flipPortion = 0.4
    if (collect < flipPortion) {
      flip = 1 - collect / flipPortion
    } else {
      flip = 0
      const e = smoothStart2((collect - flipPortion) / (1 - flipPortion))
      x = targetX + (origin.x - targetX) * e
      y = targetY + (origin.y - targetY) * e
    }
  } else if (flight < 1) {
    const e = smoothEnd3(flight)
    x = origin.x + (targetX - origin.x) * e
    y = origin.y + (targetY - origin.y) * e
  }

  const blit = (sprite: ReturnType<typeof getCardSprite>, scaleX = 1): void => {
    blitCard(ctx, sprite, x, y, scaleX)
  }

  const back = () => getCardSprite(null, w, h, dpr)
  const front = () => getCardSprite(card, w, h, dpr)

  if (flip <= 0) {
    blit(back())
    return
  }
  if (flip >= 1) {
    blit(front())
    return
  }
  // Mid-flip: scaleX 1 → 0 shows the back, 0 → 1 shows the face.
  const showFace = flip >= 0.5
  const scaleX = Math.abs(flip * 2 - 1)
  blit(showFace ? front() : back(), scaleX)
}

// A glowing amber ring around the hand currently being played (shown only once a
// split has produced multiple hands), so it's obvious which hand is active.
function drawActiveHandRing(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const pad = h * 0.1
  const radius = h * 0.12
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x - pad, y - pad, w + pad * 2, h + pad * 2, radius)
  ctx.fillStyle = 'rgba(255, 206, 112, 0.14)'
  ctx.fill()
  ctx.shadowColor = 'rgba(255, 194, 90, 0.85)'
  ctx.shadowBlur = h * 0.14
  ctx.lineWidth = Math.max(2.5, h * 0.035)
  ctx.strokeStyle = '#ffce70'
  ctx.stroke()
  ctx.restore()
}

function rowXs(centerX: number, count: number, cardW: number): number[] {
  const step = cardW * 0.5 // overlap successive cards (each shows its left half)
  const spread = cardW + step * Math.max(0, count - 1)
  const start = centerX - spread / 2
  const xs: number[] = []
  for (let i = 0; i < count; i++) {
    xs.push(start + step * i)
  }
  return xs
}

// A lane's total is shown only once all its cards have flown in and flipped up.
function laneSettled(count: number, key: (index: number) => string, anim?: CardAnim): boolean {
  if (!anim) {
    return true
  }
  for (let i = 0; i < count; i++) {
    const st = anim.state(key(i))
    if (!st || st.flight < 1 || st.flip < 1 || st.collect > 0) {
      return false
    }
  }
  return true
}

// A hand's total, big and centered on `centerX` (so the two hands' counts line
// up vertically). A result, when present, is drawn to the RIGHT of the count
// without moving it — the count stays put.
function drawCount(
  ctx: CanvasRenderingContext2D,
  total: number,
  centerX: number,
  y: number,
  countPx: number,
  result?: RoundResult,
): void {
  const text = String(total)
  ctx.save()
  ctx.textBaseline = 'middle'

  ctx.textAlign = 'center'
  ctx.font = `bold ${countPx}px system-ui, sans-serif`
  shadowText(ctx, text, centerX, y, '#f3e9d2')

  if (result) {
    const countW = ctx.measureText(text).width // measured with the count font
    ctx.textAlign = 'left'
    ctx.font = `bold ${Math.round(countPx * 0.78)}px system-ui, sans-serif`
    shadowText(ctx, result.label, centerX + countW / 2 + countPx * 0.35, y, resultColor(result.tone))
  }
  ctx.restore()
}

function shadowText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.fillText(text, x + 1, y + 2)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

function resultColor(tone: RoundResult['tone']): string {
  return tone === 'win' ? '#7fe08a' : tone === 'lose' ? '#f0928a' : '#e6d3a8'
}

// The Analyze readout: two probabilities, structurally compatible with the game's
// Analysis (kept import-free so the render layer stays decoupled from game logic).
export interface AnalysisReadout {
  bustChance: number // 0..1
  dealerWinChance: number // 0..1
}

// Draw the two odds rows in the empty band between the dealer's cards and the
// player's, left-aligned to the screen centre. Rendered as a red light the dealer
// projects from its eyes onto the felt: two beams fan down from the eyes to the
// text. The whole projection FLICKERS — its opacity wavers, and the flicker rate
// ramps up over the first few hundred ms so it stutters into view like a hologram
// striking on. `age` is ms since the reading appeared; the view repaints until
// it's dismissed.
// How long the projection takes to flicker fully in; also the age it rewinds
// through on the way out, so the strike-off mirrors the strike-on.
export const ANALYSIS_STRIKE_MS = 420

// How dark the world gets behind a full-strength reading (the light-mask alpha).
const ANALYSIS_DARKNESS = 0.55

export function drawAnalysis(ctx: CanvasRenderingContext2D, l: Layout, a: AnalysisReadout, age: number, fade = 1): void {
  const g = analysisGeom(ctx, l, a)
  // `fade` (1 → 0) drives the dismiss flicker-out; multiplied onto the strike
  // flicker so it keeps flickering as it dies.
  const flicker = flickerOpacity(age) * fade

  // The two eye beams, additive light, flickering as one with the text.
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  drawEyeBeam(ctx, g.eyes.left, g.left, g.right, g.bottom, g.fontPx, 0.16 * flicker)
  drawEyeBeam(ctx, g.eyes.right, g.left, g.right, g.bottom, g.fontPx, 0.15 * flicker)
  ctx.restore()

  // The red text, its opacity flickering with the beams.
  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.globalAlpha = flicker
  drawRedRow(ctx, g.row1, g.x, g.y1, g.fontPx)
  drawRedRow(ctx, g.row2, g.x, g.y2, g.fontPx)
  ctx.restore()
}

// The scene-darkening light mask, drawn on the top 'mask' layer. While a reading
// shows, the whole world dims; the projection's beams + text then PUNCH bright
// holes back through that darkness (destination-out erases the mask where the
// light falls, revealing the lit felt + the red projection on the layers below —
// this is what actually cuts holes in an alpha mask; `lighten`/`lighter` would
// only tint). Darkness rises with the reading's presence; holes flicker in
// lockstep with the projection.
export function drawAnalysisMask(ctx: CanvasRenderingContext2D, l: Layout, a: AnalysisReadout, age: number, fade: number): void {
  const presence = Math.min(1, age / ANALYSIS_STRIKE_MS) * fade
  if (presence <= 0.002) {
    return // effectively no darkness — leave the (already-cleared) mask clear
  }
  const flicker = flickerOpacity(age) * fade
  const g = analysisGeom(ctx, l, a)

  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = `rgba(0, 0, 0, ${ANALYSIS_DARKNESS * presence})`
  ctx.fillRect(0, 0, l.width, l.height)

  // Erase the darkness in the beam cones + around the text so the light shows.
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  drawEyeBeam(ctx, g.eyes.left, g.left, g.right, g.bottom, g.fontPx, 0.85 * flicker)
  drawEyeBeam(ctx, g.eyes.right, g.left, g.right, g.bottom, g.fontPx, 0.8 * flicker)
  drawTextGlowHole(ctx, g, flicker)
  ctx.restore()
}

// Shared geometry for the projection AND its mask, so the red light and the
// punched holes always line up.
interface AnalysisGeom {
  x: number
  y1: number
  y2: number
  midY: number
  fontPx: number
  left: number
  right: number
  bottom: number
  row1: string
  row2: string
  eyes: DealerEyes
}

function analysisGeom(ctx: CanvasRenderingContext2D, l: Layout, a: AnalysisReadout): AnalysisGeom {
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const { h: cardH } = cardSize(l)
  // The band runs from the dealer's count (below its cards) to the player's count
  // (above its cards); centre the two rows within it.
  const dealerCountY = feltTop + feltHeight * 0.05 + cardH + cardH * 0.22
  const playerCountY = feltTop + feltHeight * PLAYER_ROW - cardH * 0.34
  const midY = (dealerCountY + playerCountY) / 2

  const countPx = clamp(cardH * 0.32, 18, 40) // matches drawCount's total size
  const fontPx = clamp(cardH * 0.22, 13, 24)
  const rowGap = fontPx * 1.6
  // Start just past the widest centred total (two digits) so the text never sits
  // on the "17"/"20" in the middle of the band.
  const x = l.width / 2 + countPx * 0.75
  // Percentage first, then the label — no colon. Monospace + 2-digit-padded.
  const row1 = `${pct(a.bustChance)} Bust on hit`
  const row2 = `${pct(a.dealerWinChance)} Dealer Wins`
  const y1 = midY - rowGap / 2
  const y2 = midY + rowGap / 2

  ctx.save()
  ctx.font = analysisFont(fontPx)
  const textW = Math.max(ctx.measureText(row1).width, ctx.measureText(row2).width)
  ctx.restore()

  return {
    x,
    y1,
    y2,
    midY,
    fontPx,
    left: x - fontPx * 0.4,
    right: x + textW + fontPx * 0.4,
    bottom: y2 + fontPx * 0.9,
    row1,
    row2,
    eyes: dealerEyes(l),
  }
}

// A soft elliptical hole around the text (destination-out) so the red text reads
// through the darkness.
function drawTextGlowHole(ctx: CanvasRenderingContext2D, g: AnalysisGeom, flicker: number): void {
  const cx = (g.left + g.right) / 2
  const cy = g.midY
  const rx = (g.right - g.left) / 2 + g.fontPx * 1.3
  const ry = (g.y2 - g.y1) / 2 + g.fontPx * 1.6
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(rx, ry) // unit circle → the text's ellipse
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
  grad.addColorStop(0, `rgba(255, 255, 255, ${0.95 * flicker})`)
  grad.addColorStop(0.55, `rgba(255, 255, 255, ${0.6 * flicker})`)
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(0, 0, 1, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// Monospace so digits + colons align between the two rows.
function analysisFont(fontPx: number): string {
  return `700 ${fontPx}px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace`
}

// Whole-percent, zero-padded to at least two digits (9% → "09%", 100% stays "100%").
function pct(p: number): string {
  return `${String(Math.round(clamp(p, 0, 1) * 100)).padStart(2, '0')}%`
}

// Projection opacity: a flicker whose rate accelerates over the first ~420ms so
// the light stutters in (slow blinks → fast), then settles to a shallow, steady
// waver. The phase integrates a rate that ramps linearly, so early cycles are
// long and later ones short — the "flickers into view" feel.
function flickerOpacity(age: number): number {
  const rampMs = ANALYSIS_STRIKE_MS
  const rate = 0.05 // steady angular rate (rad/ms) once warmed up
  const warm = Math.min(1, Math.max(0, age / rampMs))
  const phase = age < rampMs ? (rate * age * age) / (2 * rampMs) : rate * (age - rampMs / 2)
  // Two detuned waves give an irregular, less mechanical flicker.
  const wave = 0.65 * Math.sin(phase) + 0.35 * Math.sin(phase * 2.7 + 1.3)
  const off = 0.5 - 0.5 * Math.max(-1, Math.min(1, wave)) // 0 = full on, 1 = darkest
  const base = 0.22 + 0.78 * warm // brightness envelope: dim at strike, full once warm
  const depth = 0.5 - 0.34 * warm // deep flicker while striking, shallow when settled
  return base * (1 - depth * off)
}

// A soft red light-cone from one eye (apex) fanning down onto the text block.
function drawEyeBeam(
  ctx: CanvasRenderingContext2D,
  eye: { x: number; y: number },
  left: number,
  right: number,
  bottom: number,
  fontPx: number,
  alpha: number,
): void {
  const pad = fontPx * 0.8
  const grad = ctx.createLinearGradient(eye.x, eye.y, (left + right) / 2, bottom)
  grad.addColorStop(0, `rgba(255, 45, 45, ${alpha * 0.5})`)
  grad.addColorStop(0.55, `rgba(255, 55, 55, ${alpha})`)
  grad.addColorStop(1, `rgba(255, 90, 90, ${alpha * 0.3})`)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.moveTo(eye.x, eye.y)
  ctx.lineTo(left - pad, bottom)
  ctx.lineTo(right + pad, bottom)
  ctx.closePath()
  ctx.fill()
}

// One red row: a dark drop for contrast on the felt, then the glowing red body.
// Opacity (the flicker) is applied by the caller via globalAlpha.
function drawRedRow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fontPx: number): void {
  ctx.save()
  ctx.font = analysisFont(fontPx)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.fillText(text, x + 1.5, y + 2)
  ctx.shadowColor = 'rgba(255, 45, 45, 0.85)'
  ctx.shadowBlur = fontPx * 0.5
  ctx.fillStyle = '#ff6a6a'
  ctx.fillText(text, x, y)
  ctx.restore()
}

// One tossed card's flip + fly progress; produced by the mulligan animator (ui)
// and consumed here. Lives in the render layer so ui depends on render, not back.
export interface DiscardFrame {
  card: Card
  flip: number // 1 = face-up, 0 = face-down
  fly: number // 0 = resting in its slot, 1 = merged into the deck
}

// The mulligan discard: the tossed opening cards (frames from the mulligan
// animator) flip face-down and are swept up to the DEALER, who mucks them. Their
// slots use the same hand-0 geometry as drawHands, so they set off from where the
// cards sat.
export function drawMulliganDiscard(ctx: CanvasRenderingContext2D, l: Layout, frames: readonly DiscardFrame[]): void {
  if (frames.length === 0) {
    return
  }
  const dpr = window.devicePixelRatio || 1
  const { w, h } = cardSize(l)
  const playerY = l.edgeY + (l.height - l.edgeY) * PLAYER_ROW
  const xs = rowXs(l.width / 2, frames.length, w)
  // Sweep target: the dealer figure's torso (centred), as a top-left for the card
  // size so the card lands centred on the dealer.
  const d = dealerBox(l)
  const targetX = d.cx - w / 2
  const targetY = (d.bodyTop + d.baseY) / 2 - h / 2
  frames.forEach((frame, i) => {
    if (frame.fly >= 1) {
      return
    }
    const slotX = xs[i]
    // Ease in-out from rest (the card just finished flipping) toward the dealer.
    const e = smoothStep(frame.fly)
    const x = slotX + (targetX - slotX) * e
    const y = playerY + (targetY - playerY) * e
    // Fade out over the back half of the trip so the card dissolves into the
    // dealer's muck rather than stopping dead on arrival.
    const alpha = frame.fly < 0.5 ? 1 : Math.max(0, 1 - (frame.fly - 0.5) / 0.5)
    drawFlipCard(ctx, frame.card, x, y, w, h, frame.flip, alpha, dpr)
  })
}

// The Return toss: a single card flips face-down and flies from its slot (given
// as a centre point) back onto the deck (shoe), fading in as it merges. Reuses
// the shared flip render. `fly` 0→1 = resting slot → merged into the deck.
export function drawReturnCard(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  card: Card,
  fromCx: number,
  fromCy: number,
  flip: number,
  fly: number,
): void {
  if (fly >= 1) {
    return
  }
  const dpr = window.devicePixelRatio || 1
  const { w, h } = cardSize(l)
  const shoe = shoeAnchor(l)
  const fromX = fromCx - w / 2
  const fromY = fromCy - h / 2
  const e = smoothStep(fly)
  const x = fromX + (shoe.x - fromX) * e
  const y = fromY + (shoe.y - fromY) * e
  // Fade out over the back half so it dissolves into the deck rather than stopping.
  const alpha = fly < 0.6 ? 1 : Math.max(0, 1 - (fly - 0.6) / 0.4)
  drawFlipCard(ctx, card, x, y, w, h, flip, alpha, dpr)
}

// Peek Deck: the shoe's top card flipped up in place so the player can read the
// next card. Drawn on the cards layer directly over the static deck's top-card
// back — same anchor + size as `drawShoe`'s top card, so it registers exactly.
// `flip` 0→1 = back → face.
export function drawPeekCard(ctx: CanvasRenderingContext2D, l: Layout, card: Card, flip: number): void {
  const dpr = window.devicePixelRatio || 1
  const shoe = shoeAnchor(l)
  drawFlipCard(ctx, card, shoe.x, shoe.y, shoe.w, shoe.h, flip, 1, dpr)
}

// Draw a single card at (x, y) at a given flip (1 = face, 0 = back) and alpha —
// the shared flip render used by the deal and the mulligan discard.
function drawFlipCard(
  ctx: CanvasRenderingContext2D,
  card: Card,
  x: number,
  y: number,
  w: number,
  h: number,
  flip: number,
  alpha: number,
  dpr: number,
): void {
  const sprite = (face: boolean) => getCardSprite(face ? card : null, w, h, dpr)
  const blit = (face: boolean, scaleX = 1) => {
    if (alpha >= 1) {
      blitCard(ctx, sprite(face), x, y, scaleX)
      return
    }
    ctx.save()
    ctx.globalAlpha = Math.max(0, alpha)
    blitCard(ctx, sprite(face), x, y, scaleX)
    ctx.restore()
  }
  if (flip >= 1) {
    blit(true)
  } else if (flip <= 0) {
    blit(false)
  } else {
    // Mid-flip: scaleX collapses to 0 at the edge, showing the back past halfway.
    blit(flip >= 0.5, Math.abs(flip * 2 - 1))
  }
}

// Resting position of the top card of the shoe — the anchor deal animations
// fly cards from.
export function shoeAnchor(l: Layout): { x: number; y: number; w: number; h: number } {
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const base = cardSize(l)
  const w = base.w * 0.9
  const h = base.h * 0.9
  const stackW = w * SHOE_DX * SHOE_LAYERS
  const margin = Math.max(14, l.width * 0.03)

  // Sit the deck just right of a centered dealer hand — keeps it near the
  // dealer on wide screens — but never let it run past the right edge (mobile).
  const preferredX = l.width / 2 + base.w * 1.7
  const maxX = l.width - margin - w - stackW
  return {
    x: Math.min(preferredX, maxX),
    y: feltTop + feltHeight * 0.05,
    w,
    h,
  }
}

// The deck sitting on the felt: a stack of card backs, drawn at (x, y). Static
// placeholder — the shoe is reshuffled every deal in the logic, so it never
// depletes on screen. Position is explicit so the deck can slide during a
// shuffle; `shoeAnchor` gives its resting spot.
export function drawShoe(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const dpr = window.devicePixelRatio || 1
  const radius = w * 0.09
  const dx = w * SHOE_DX
  const dy = h * SHOE_DY
  // The stack layers take the current dealer's deck colour so the shoe matches the
  // card backs; the top card is the back sprite (same palette via the sprite cache).
  const back = activeCardBack()

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = h * 0.09
  ctx.shadowOffsetY = h * 0.05
  ctx.beginPath()
  ctx.roundRect(x + dx * SHOE_LAYERS, y + dy * SHOE_LAYERS, w, h, radius)
  ctx.fillStyle = back.deckBase
  ctx.fill()
  ctx.restore()

  for (let i = SHOE_LAYERS; i >= 1; i--) {
    ctx.beginPath()
    ctx.roundRect(x + dx * i, y + dy * i, w, h, radius)
    ctx.fillStyle = i % 2 === 0 ? back.deckDark : back.deckLight
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)'
    ctx.stroke()
  }

  blitCard(ctx, getCardSprite(null, w, h, dpr), x, y)
}

// The top (front) card's top-left position when the deck is `spent` (0..1) depleted:
// 0 = full, the top card sits at the anchor; 1 = empty, the top has descended all the way
// onto the fixed bottom card. The shred flies each card off from the top at the instant it
// leaves (spent = its index / count), and drawDepletingShoe rests its top card here — so
// cards peel off the same receding top surface the stack is shrinking down to.
export function shoeTopFor(l: Layout, spent: number): { x: number; y: number } {
  const a = shoeAnchor(l)
  return { x: a.x + a.w * SHOE_DX * SHOE_LAYERS * spent, y: a.y + a.h * SHOE_DY * SHOE_LAYERS * spent }
}

// The shoe with only `remaining` (0..1) of its deck left: the BOTTOM card stays fixed on
// the felt (carrying the shadow) while the TOP card DESCENDS onto it — the stack loses its
// upper layers so the top surface recedes downward, card by card, exactly like a deck being
// dealt off the top. The dealer-spawn shred uses this to shrink the outgoing dealer's deck
// as its 40 backs are fed off the top into the new dealer's mouth.
export function drawDepletingShoe(ctx: CanvasRenderingContext2D, l: Layout, remaining: number): void {
  if (remaining <= 0.001) {
    return
  }
  const { x, y, w, h } = shoeAnchor(l)
  const dpr = window.devicePixelRatio || 1
  const radius = w * 0.09
  const dx = w * SHOE_DX
  const dy = h * SHOE_DY
  const back = activeCardBack()
  const topGone = SHOE_LAYERS * (1 - remaining) // layers the top has descended toward the base

  // Bottom card FIXED at full depth, carrying the drop shadow — it rests on the felt to the
  // very end, so the deck shrinks by the top coming down, not by the bottom being eaten.
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = h * 0.09
  ctx.shadowOffsetY = h * 0.05
  ctx.beginPath()
  ctx.roundRect(x + dx * SHOE_LAYERS, y + dy * SHOE_LAYERS, w, h, radius)
  ctx.fillStyle = back.deckBase
  ctx.fill()
  ctx.restore()

  // The layers still under the top card — from the fixed base up to the descending top.
  for (let i = SHOE_LAYERS; i > topGone; i--) {
    ctx.beginPath()
    ctx.roundRect(x + dx * i, y + dy * i, w, h, radius)
    ctx.fillStyle = i % 2 === 0 ? back.deckDark : back.deckLight
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)'
    ctx.stroke()
  }

  // Top/front card at its DESCENDED position — it visibly recedes toward the base as the
  // deck is sucked away, so the removal unmistakably reads at the top.
  blitCard(ctx, getCardSprite(null, w, h, dpr), x + dx * topGone, y + dy * topGone)
}

// A riffle shuffle, a single pass: the deck splits into two piles that slide
// apart, then cards fly from both piles into a single deck reforming in the
// centre. Drawn on the cards layer (the static table-layer deck is hidden while
// this plays, so the split leaves no ghost deck behind).
const SHUFFLE_PASSES = 1
const SPLIT_FRACTION = 0.3 // portion of each pass spent splitting apart
const FLYERS = 8 // cards riffling across per pass

export function drawShuffle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  incoming?: CardBack,
): void {
  const dpr = window.devicePixelRatio || 1
  // On a dealer change the riffle is the deck swap: the outgoing deck (current
  // palette) splits and fades out while the incoming deck (the new dealer's colour)
  // riffles in, so the colour cross-fades right where the cards are already flying.
  // Without an `incoming` it's a plain same-colour reshuffle between hands.
  const outBack = getCardSprite(null, w, h, dpr)
  const inBack = incoming ? getCardSprite(null, w, h, dpr, incoming) : outBack
  const offset = w * 0.9 // how far the two piles sit from centre

  const pass = Math.min(SHUFFLE_PASSES - 1, Math.floor(t * SHUFFLE_PASSES))
  const ct = t * SHUFFLE_PASSES - pass // 0..1 within this pass

  if (ct < SPLIT_FRACTION) {
    // Split: the centre (outgoing) deck divides into two piles sliding apart.
    const p = smoothEnd3(ct / SPLIT_FRACTION)
    drawStack(ctx, outBack, x - offset * p, y, 1)
    drawStack(ctx, outBack, x + offset * p, y, 1)
    return
  }

  // Riffle: the two outgoing piles deplete as a single incoming deck reforms between them.
  const mt = (ct - SPLIT_FRACTION) / (1 - SPLIT_FRACTION)
  const sideAlpha = 1 - smoothStart2(mt)
  drawStack(ctx, outBack, x - offset, y, sideAlpha)
  drawStack(ctx, outBack, x + offset, y, sideAlpha)
  drawStack(ctx, inBack, x, y, smoothEnd3(mt)) // the merged deck growing in

  for (let i = 0; i < FLYERS; i++) {
    const delay = (i / FLYERS) * 0.6
    const ft = clamp((mt - delay) / 0.4, 0, 1)
    if (ft <= 0 || ft >= 1) {
      continue
    }
    const fromLeft = i % 2 === 0
    const startX = x + (fromLeft ? -offset : offset)
    const cx = startX + (x - startX) * smoothEnd3(ft)
    const cy = y - h * 0.4 * Math.sin(ft * Math.PI) // arc up and back down
    const rot = (fromLeft ? 1 : -1) * 0.35 * (1 - ft)
    drawRotatedSprite(ctx, inBack, cx, cy, w, h, rot)
  }
}

// A short deck of card backs (offset stack) at (x, y) on the cards layer.
function drawStack(ctx: CanvasRenderingContext2D, sprite: ReturnType<typeof getCardSprite>, x: number, y: number, alpha: number): void {
  if (alpha <= 0) {
    return
  }
  ctx.save()
  ctx.globalAlpha = Math.min(1, alpha)
  const dx = sprite.cw * 0.03
  const dy = sprite.ch * 0.02
  for (let i = 3; i >= 1; i--) {
    blitCard(ctx, sprite, x + dx * i, y + dy * i)
  }
  blitCard(ctx, sprite, x, y)
  ctx.restore()
}

function drawRotatedSprite(
  ctx: CanvasRenderingContext2D,
  sprite: ReturnType<typeof getCardSprite>,
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
): void {
  const cx = x + w / 2
  const cy = y + h / 2
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rot)
  ctx.translate(-cx, -cy)
  blitCard(ctx, sprite, x, y)
  ctx.restore()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
