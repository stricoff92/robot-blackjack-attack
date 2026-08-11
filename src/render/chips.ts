// Chip rendering on the felt: the player's bankroll stack in the bottom-right
// corner and a per-hand bet stack sitting over each player hand. Winnings fly in
// from the dealer, and losing bets fly to the dealer.
//
// A stack is seen edge-on, so only the TOP chip shows its printed face (the
// poker-chip image, loaded once — see chip-sprite.ts, drawn into a perspective
// disc: scaling its height to ry < rx tips the round image into an oval). Every
// chip below it is a plain rim band, so the detailed art never repeats into
// speckled noise. Until the image loads, `drawChipStack` falls back to vector
// art (a squashed oval with a stroke border).
//
// Mirrors the split used for cards: this module owns geometry (sizes, resting
// anchors) and drawing, and interpolates flight positions from the progress a
// `ChipView` (the animator) reports. It never owns timing.

import type { HandOutcome, Round } from '../game/round'
import { BOTTOM_HUD_RESERVE, cardSize, COUNT_HOLO, drawHoloText, handCenterX, holoCountBox, PLAYER_ROW } from './cards'
import { chipImage } from './chip-sprite'
import { smoothStep } from './easing'
import { abbreviateCount } from './format'
import type { HoloRayTarget } from './nexus'
import { clampRightX, dealerBox, type Layout } from './scene'

export interface Point {
  x: number
  y: number
}

export interface ChipStyle {
  face: string // top face fill
  edge: string // darker rim showing beneath each face (the disc's side)
  stroke: string // border stroke
  accent: string // inner ring on the top chip
}

// One shared chip look for every stack — bankroll and bet match (warm gold,
// matching the action bar). Money is money.
export const CHIP_STYLE: ChipStyle = { face: '#d9a441', edge: '#a97b28', stroke: '#5e4413', accent: '#f6dc95' }

const CHIP_RATIO = 0.42 // ry / rx — how much the disc is squashed for perspective
const LIFT_RATIO = 0.2 // vertical offset per stacked chip (= visible rim thickness), × rx
const BET_GAP = 0.5 // gap between the player cards' bottom edge and the bet chips, × card height
// BOTTOM_HUD_RESERVE (px kept clear at the screen bottom for the action bar + the bet
// label below the circle) is defined in cards.ts, which sizes cards against it too.

// --- animator contract -------------------------------------------------------

// The lifecycle of a hand's bet chips. `placing` flies the bet out of the
// player's bankroll on the deal. On resolve, a win plays `winIn` (winnings fly
// from the dealer to beside the bet) then `restWin` (both sit, waiting); a
// loss/push just holds `idle`. When the next hand is called, the table settles:
// `toDealer` (loss) or `collect` (win/push → bet + winnings into the bankroll). A
// refunded loss adds `refundBack` after `toDealer`: the dealer slides part of the
// bet back to the bankroll (Anti-dealer refund upgrade).
export type BetPhase = 'placing' | 'idle' | 'winIn' | 'restWin' | 'toDealer' | 'refundBack' | 'collect' | 'done'

export interface BetChipState {
  phase: BetPhase
  progress: number // 0..1 within the current phase
  outcome: HandOutcome | null
}

export interface ChipView {
  betChip(handIndex: number, now: number): BetChipState
  isAnimating(now: number): boolean
}

// --- geometry ----------------------------------------------------------------

export function chipMetrics(l: Layout): { rx: number; ry: number; lift: number } {
  const scale = Math.min(l.width, l.height)
  const rx = clamp(scale * 0.03, 10, 22)
  return { rx, ry: rx * CHIP_RATIO, lift: rx * LIFT_RATIO }
}

// The point on the dealer that losing bets settle to and winnings fly from — the
// dealer figure's torso, centred and just above the rail.
export function dealerAnchor(l: Layout): Point {
  const d = dealerBox(l)
  return { x: d.cx, y: (d.bodyTop + d.baseY) / 2 }
}

// Player bankroll stack: bottom-right corner, clear of the action bar band. On very wide
// screens clampRightX caps its distance from centre so it doesn't strand out at the far edge
// (it lands on the same right column as the nexus).
export function playerAnchor(l: Layout): Point {
  const { rx } = chipMetrics(l)
  const rightMargin = Math.max(rx * 2, l.width * 0.055)
  const bottomReserve = clamp(l.height * 0.13, 92, 150)
  return { x: clampRightX(l, l.width - rightMargin - rx), y: l.height - bottomReserve }
}

// The y of the betting circle / bet-chip base: a big gap below the cards, but
// capped so the circle never drops into the bottom action bar (which is a fixed
// number of px from the screen bottom, unlike the fraction-based felt positions).
// Shared by betAnchor and the table decal so the chips and circle stay together.
export function betRowY(l: Layout): number {
  const feltTop = l.edgeY
  const feltH = l.height - feltTop
  const cardH = cardSize(l).h
  const m = chipMetrics(l)
  const desired = feltTop + feltH * PLAYER_ROW + cardH + cardH * BET_GAP
  const maxY = l.height - BOTTOM_HUD_RESERVE - m.rx * 0.95
  return Math.min(desired, maxY)
}

// Bet stack for one hand: centered under that hand, sitting in the betting circle
// well below the cards. Mirrors the player-hand layout in cards.ts.
export function betAnchor(l: Layout, round: Round, handIndex: number): Point {
  return {
    x: handCenterX(l, handIndex, round.hands.length),
    y: betRowY(l),
  }
}

// The bankroll number's position + font size (below the corner pile). Kept as a helper
// so drawChips draws the label and its ray-target box at the same spot.
export function bankrollLabelAnchor(l: Layout): { x: number; y: number; size: number } {
  const m = chipMetrics(l)
  const p = playerAnchor(l)
  return { x: p.x, y: p.y + m.ry + 30, size: 22 }
}

// Every bet/winnings disc is worth CHIP_UNIT, so those stacks' heights reflect the
// wager (capped short, with the exact amount on a label below). The bankroll pile
// is different — fixed decoration; see BANK_PILE_DISCS.
export const CHIP_UNIT = 10
// The bankroll pile is FIXED-height decoration, NOT a data-bound gauge: it never
// grows or shrinks with the balance. The exact bankroll is the number below it,
// and chips fly to/from the pile's crown and fade on merge — so a constant pile
// reads correctly while the value can never make discs spawn or despawn. (A stack
// that re-quantised the fluctuating balance every frame is what jittered before.)
const BANK_PILE_DISCS = 5
// The bet stack sits in the betting circle below the cards; keep it short so a
// big bet doesn't grow back up into the cards (the exact amount rides as a label).
const MAX_BET_DISCS = 4

export function discCount(value: number, max: number): number {
  if (value <= 0) {
    return 0
  }
  return clamp(Math.round(value / CHIP_UNIT), 1, max)
}

// --- drawing -----------------------------------------------------------------

// Clear the layer and paint every chip stack for the current frame.
// The player's bankroll PILE alone — no count label, no house/bet chips. Used on the
// tap-to-start intro, where the stack shows but the number doesn't. Clears the layer first.
export function drawPlayerPile(ctx: CanvasRenderingContext2D, l: Layout, chips: number): void {
  ctx.clearRect(0, 0, l.width, l.height)
  const m = chipMetrics(l)
  const player = playerAnchor(l)
  const pileDiscs = chips > 0 ? BANK_PILE_DISCS : 0
  drawChipStack(ctx, player.x, player.y, pileDiscs, m, CHIP_STYLE)
}

export function drawChips(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  data: { chips: number; chipsScale?: number; round: Round | null },
  view: ChipView,
  now: number,
  hideCounts = false,
): HoloRayTarget[] {
  ctx.clearRect(0, 0, l.width, l.height)
  const m = chipMetrics(l)
  // The holo-projected chip-count boxes actually drawn this frame — returned so the ray
  // fans target exactly the labels on screen. Each drawn label pairs with a push here.
  const projected: HoloRayTarget[] = []

  const player = playerAnchor(l)
  // Fixed decorative pile; the number below it is the source of truth. It's a
  // constant height at any positive balance (no jitter), but drops to nothing
  // when the bankroll is empty — no phantom discs sitting over a "0" (all-in, or
  // busted out for good).
  const pileDiscs = data.chips > 0 ? BANK_PILE_DISCS : 0
  drawChipStack(ctx, player.x, player.y, pileDiscs, m, CHIP_STYLE)
  // `hideCounts` keeps every chip amount off the felt (the bankroll here, plus each
  // bet/winnings label below) — the opening hand holds them back until its cards have
  // fully landed so they reveal together (see GameView.firstHandCountsHidden). The
  // decorative stacks still animate; only their numbers wait.
  if (!hideCounts) {
    const bl = bankrollLabelAnchor(l)
    drawChipLabel(ctx, abbreviateCount(data.chips), bl.x, bl.y, now, bl.size, data.chipsScale ?? 1)
    projected.push(holoCountBox(bl.x, bl.y, bl.size))
  }
  // Where flying bet/winnings chips land and fade in: the crown of the pile.
  const playerTop: Point = { x: player.x, y: player.y - pileDiscs * m.lift }

  const round = data.round
  if (!round) {
    return projected
  }
  const dealer = dealerAnchor(l)
  for (let hi = 0; hi < round.hands.length; hi++) {
    projected.push(...drawHandChips(ctx, l, m, round, hi, dealer, playerTop, view.betChip(hi, now), now, hideCounts))
  }
  return projected
}

function drawHandChips(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  m: { rx: number; ry: number; lift: number },
  round: Round,
  handIndex: number,
  dealer: Point,
  playerTop: Point,
  st: BetChipState,
  now: number,
  hideCounts = false,
): HoloRayTarget[] {
  const boxes: HoloRayTarget[] = []
  if (st.phase === 'done') {
    return boxes
  }
  const bet = betAnchor(l, round, handIndex)
  const amount = round.hands[handIndex].bet
  const betCount = discCount(amount, MAX_BET_DISCS)

  const won = st.outcome === 'win' || st.outcome === 'blackjack'
  // The winnings must track handPayout: a blackjack pays the rules' ratio (3:2 by
  // default, 2:1 then 3:1 with the Payout upgrade), not a hardcoded 1.5x.
  const winAmount =
    st.outcome === 'blackjack'
      ? Math.floor(amount * (round.rules.blackjackPayoutNumerator / round.rules.blackjackPayoutDenominator))
      : amount
  const winCount = discCount(winAmount, MAX_BET_DISCS)

  // Winnings land to the RIGHT of the bet. Both value labels are drawn centered under
  // their stacks at a fixed 18px, so a plain rx*2.6 gap let 4+ digit bets run into the
  // winnings number. Space them by the two labels' actual widths (measured at the label
  // font) so they never touch, with rx*2.6 kept as the floor for small amounts.
  ctx.save()
  ctx.font = 'bold 18px system-ui, sans-serif'
  const betLabelW = ctx.measureText(abbreviateCount(amount)).width
  const winLabelW = ctx.measureText(abbreviateCount(winAmount)).width
  ctx.restore()
  const winGap = Math.max(m.rx * 2.6, betLabelW / 2 + winLabelW / 2 + 26)
  const winSpot: Point = { x: bet.x + winGap, y: bet.y }

  // Value labels sit BELOW the chips (just under the betting circle). The bet's
  // rides along while the bet is at rest; the winnings' label follows them as
  // they fly in and while they rest.
  const belowY = (y: number): number => y + m.rx * 0.95 + 22
  const paintBet = (x: number, y: number, alpha: number, label = false): void => {
    drawChipStack(ctx, x, y, betCount, m, CHIP_STYLE, alpha)
    if (label && !hideCounts) {
      drawChipLabel(ctx, abbreviateCount(amount), x, belowY(y), now, 18)
      boxes.push(holoCountBox(x, belowY(y), 18)) // ray target = exactly where this label was drawn
    }
  }
  const paintWin = (x: number, y: number, alpha: number, label = false): void => {
    drawChipStack(ctx, x, y, winCount, m, CHIP_STYLE, alpha)
    if (label && !hideCounts) {
      drawChipLabel(ctx, abbreviateCount(winAmount), x, belowY(y), now, 18)
      boxes.push(holoCountBox(x, belowY(y), 18))
    }
  }

  switch (st.phase) {
    case 'placing': {
      // The bet flies out of the player's bankroll stack to the bet spot.
      const e = smoothStep(st.progress)
      const alpha = st.progress < 0.2 ? st.progress / 0.2 : 1
      paintBet(lerp(playerTop.x, bet.x, e), lerp(playerTop.y, bet.y, e), alpha)
      break
    }
    case 'idle':
      paintBet(bet.x, bet.y, 1, true)
      break
    case 'toDealer': {
      const e = smoothStep(st.progress)
      const alpha = st.progress > 0.75 ? 1 - (st.progress - 0.75) / 0.25 : 1
      paintBet(lerp(bet.x, dealer.x, e), lerp(bet.y, dealer.y, e), alpha)
      break
    }
    case 'refundBack': {
      // Anti-dealer refund: the dealer slides part of the lost bet back into the
      // player's bankroll (its exact value shows on the bankroll count as it lands).
      const refundAmount = Math.floor(amount * round.rules.dealerNaturalRefundRatio)
      const refundCount = discCount(refundAmount, MAX_BET_DISCS)
      const e = smoothStep(st.progress)
      const alpha = st.progress < 0.15 ? st.progress / 0.15 : st.progress > 0.85 ? 1 - (st.progress - 0.85) / 0.15 : 1
      drawChipStack(ctx, lerp(dealer.x, playerTop.x, e), lerp(dealer.y, playerTop.y, e), refundCount, m, CHIP_STYLE, alpha)
      break
    }
    case 'winIn': {
      paintBet(bet.x, bet.y, 1, true)
      const e = smoothStep(st.progress)
      // The winnings carry their own count below them as they fly over.
      paintWin(lerp(dealer.x, winSpot.x, e), lerp(dealer.y, winSpot.y, e), 1, true)
      break
    }
    case 'restWin':
      // Bet + winnings sit together at the player's spot, waiting for next hand.
      paintBet(bet.x, bet.y, 1, true)
      paintWin(winSpot.x, winSpot.y, 1, true)
      break
    case 'collect': {
      // The bet (and any winnings beside it) fly into the player's bankroll
      // stack, fading out as they merge in at the top.
      const e = smoothStep(st.progress)
      const alpha = st.progress > 0.85 ? 1 - (st.progress - 0.85) / 0.15 : 1
      paintBet(lerp(bet.x, playerTop.x, e), lerp(bet.y, playerTop.y, e), alpha)
      if (won) {
        paintWin(lerp(winSpot.x, playerTop.x, e), lerp(winSpot.y, playerTop.y, e), alpha)
      }
      break
    }
  }
  return boxes
}

// A stack of chips seen edge-on, bottom disc centered at (x, yBase), growing
// upward: a contact shadow, then discs bottom-up so higher chips overlap lower.
// Only the top chip gets the printed face; the rest are rim bands (the chip above
// covers all but their lower rim), so the detailed art never repeats into noise.
export function drawChipStack(
  ctx: CanvasRenderingContext2D,
  x: number,
  yBase: number,
  count: number,
  m: { rx: number; ry: number; lift: number },
  style: ChipStyle,
  alpha = 1,
): void {
  if (alpha <= 0 || count <= 0) {
    return
  }
  const { rx, ry, lift } = m
  ctx.save()
  ctx.globalAlpha = clamp(alpha, 0, 1)

  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)' // contact shadow beneath the stack
  ctx.beginPath()
  ctx.ellipse(x + rx * 0.12, yBase + ry * 0.55, rx * 1.02, ry * 0.9, 0, 0, Math.PI * 2)
  ctx.fill()

  const sprite = chipImage()
  for (let i = 0; i < count; i++) {
    const cy = yBase - i * lift
    const isTop = i === count - 1
    if (sprite) {
      if (isTop) {
        // The face, drawn into a 2rx × 2ry box: squashing the height to ry < rx
        // scales the round image down into the perspective oval.
        ctx.drawImage(sprite, x - rx, cy - ry, rx * 2, ry * 2)
      } else {
        drawChipEdge(ctx, x, cy, m)
      }
    } else {
      drawVectorChip(ctx, x, cy, m, style, isTop)
    }
  }
  ctx.restore()
}

// One chip seen edge-on inside a stack: a body-coloured disc with a hairline
// base, matching the image chip's dark rim. Only its lower rim shows (the chip
// above covers the rest), so stacked rims read as distinct discs, not a smear.
const CHIP_BODY = '#37342f' // the image chip's dark charcoal body
function drawChipEdge(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  m: { rx: number; ry: number; lift: number },
): void {
  const { rx, ry } = m
  ctx.beginPath()
  ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = CHIP_BODY
  ctx.fill()
  ctx.lineWidth = Math.max(1, rx * 0.05)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.stroke()
}

// The loading fallback for one chip: a squashed oval with a rim crescent and, on
// the top chip, an accent ring — a stand-in until the chip image is ready.
function drawVectorChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  m: { rx: number; ry: number; lift: number },
  style: ChipStyle,
  isTop: boolean,
): void {
  const { rx, ry, lift } = m
  // Rim: a disc offset slightly down in the edge colour; the face laid on top
  // covers all but a thin crescent, which reads as the chip's side.
  ctx.beginPath()
  ctx.ellipse(x, cy + lift * 0.55, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = style.edge
  ctx.fill()

  ctx.beginPath()
  ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = style.face
  ctx.fill()
  ctx.lineWidth = Math.max(1, rx * 0.07)
  ctx.strokeStyle = style.stroke
  ctx.stroke()

  if (isTop) {
    ctx.beginPath()
    ctx.ellipse(x, cy, rx * 0.6, ry * 0.6, 0, 0, Math.PI * 2)
    ctx.lineWidth = Math.max(1, rx * 0.08)
    ctx.strokeStyle = style.accent
    ctx.stroke()
  }
}

// A value label centered at (x, y) — used above the bankroll stack and below the
// bet's betting circle. `y` is the text's baseline (bottom). `scale` swells the
// text about (x, y) so the bankroll number can pop as it rolls up (1 = no pop).
function drawChipLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  now: number,
  fontSize = 13,
  scale = 1,
): void {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.font = `bold ${fontSize}px system-ui, sans-serif`
  if (scale !== 1) {
    ctx.translate(x, y)
    ctx.scale(scale, scale)
    ctx.translate(-x, -y)
  }
  // A chip count is projected by the holo — translucent glowing light + the shared flicker.
  drawHoloText(ctx, text, x, y, fontSize, COUNT_HOLO, now)
  ctx.restore()
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
