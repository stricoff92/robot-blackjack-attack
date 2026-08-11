// Card rendering on the felt: dealer hand across the upper table, player
// hand(s) lower down. Card faces/backs come from the offscreen sprite cache.
//
// Cards can be drawn mid-deal: a `CardAnim` supplies, per card, its flight
// progress (shoe → slot) and flip progress (back → face). With no anim
// supplied, everything renders settled and face-up (hole card excepted).

import type { Card } from '../game/deck'
import { evaluateHand } from '../game/hand'
import { isDealerHijacked, type Round } from '../game/round'
import { activeCardBack, blitCard, getCardSprite } from './card-sprite'
import { deviceDpr } from './canvas'
import { smoothEnd3, smoothStart2, smoothStep } from './easing'
import { blitGlowLabel, getGlowLabelSprite } from './holo-text-sprite'
import type { HoloRayTarget } from './nexus'
import type { CardBack } from './palette'
import { dealerBox, feltTopEdgeY, type Layout } from './scene'

const CARD_RATIO = 0.7 // width / height, roughly a real playing card

// Score-note colour for the dealer's hijack note (see game/upgrades.ts
// UPGRADE_PATHS) — sabotage red, brightened from the button hue so it reads over
// the felt.
const NOTE_SABOTAGE = '#ff6a6a'

// Bust Block reveal (drawBustBlock): the "BUST" tag is danger-red; the shield
// ring that catches the card is gold — the same hue the armed Bust Block button
// pulses (game-view.css .is-active), so the block reads as that shield firing.
const BUST_BLOCK_RED = '#ff5a4a'
const SHIELD_GOLD = '#ffd76e'
const SHIELD_GLOW = 'rgba(255, 196, 74, 0.95)'

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
// chips.ts shares it. Raised (from 0.56) to open room below the cards for the chips.
export const PLAYER_ROW = 0.5

// The dealer cards' top edge. Anchored to the CURVED felt top near the dealer (not to
// edgeY, the felt's SIDE edge — which sits a whole curveDepth lower, leaving the cards
// floating in the mid-felt on wide screens). It hugs just below the felt-top edge at the
// hand's outer reach, so the cards sit right in front of the dealer at every size.
function dealerRowY(l: Layout): number {
  const { w: cardW } = cardSize(l)
  const reach = cardW * 2 // outer reach of a typical multi-card dealer hand, from centre
  const topAtReach = Math.max(feltTopEdgeY(l, l.width / 2 - reach), feltTopEdgeY(l, l.width / 2 + reach))
  return topAtReach + cardW * 0.12 // a small gap below the felt edge so cards clear the rail
}

// Bottom-of-felt reservation the player cards must sit clear ABOVE, so the cards never
// collide with the bet chips: the action-bar band (BOTTOM_HUD_RESERVE), plus room for
// the betting circle + the tallest bet stack, plus a small gap. The chip figures used
// to compute that room MIRROR chips.ts (chipMetrics rx, MAX_BET_DISCS, LIFT_RATIO,
// CHIP_RATIO) — keep them in sync. BOTTOM_HUD_RESERVE is exported so chips.ts shares it.
export const BOTTOM_HUD_RESERVE = 96
const CARD_BET_GAP_PX = 12 // clearance kept between the player cards' bottom and the bet stack

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

// A small status tag drawn beside a hand's count when a roguelite upgrade altered it
// — currently the dealer's hijacked natural. `'right'` sits it just right of the
// (centred) count; `'above'` stacks it over the count, left-aligned with it.
interface ScoreNote {
  text: string
  color: string
  side: 'above' | 'right'
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
  const feltH = l.height - l.edgeY
  const byHeight = feltH * 0.2
  const byWidth = (l.width * 0.13) / CARD_RATIO
  // Third limit — the vertical budget: the player cards must fit ABOVE the reserved
  // chip/HUD band at the bottom. On wide/short screens this is what actually binds, so
  // cards shrink there just enough to clear the bet chips (elsewhere it's slack).
  const rx = clamp(Math.min(l.width, l.height) * 0.03, 10, 22) // mirrors chips.ts chipMetrics
  const stackH = rx * (4 * 0.2 + 0.42) // MAX_BET_DISCS·LIFT_RATIO + CHIP_RATIO
  const betCap = l.height - BOTTOM_HUD_RESERVE - rx * 0.95
  const playerY = l.edgeY + feltH * PLAYER_ROW
  const byBottom = betCap - stackH - CARD_BET_GAP_PX - playerY
  const h = clamp(Math.min(byHeight, byWidth, byBottom), 48, 168)
  return { w: h * CARD_RATIO, h }
}

// The player's card-box region — the rectangle on the felt the dealt cards sit in.
// No longer painted as a decal; kept as the single source of truth for anything that
// aligns to the seat (the Analyze readout left-aligns to its left edge).
export function playerCardBox(l: Layout): { x: number; y: number; w: number; h: number } {
  const { w: cardW, h: cardH } = cardSize(l)
  const cardTopY = l.edgeY + (l.height - l.edgeY) * PLAYER_ROW
  const w = cardW * 1.85
  const h = cardH * 1.18
  return { x: l.width / 2 - w / 2, y: cardTopY + cardH / 2 - h / 2, w, h }
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

  const dealerY = dealerRowY(l)
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
  now: number,
  anim?: CardAnim,
  results?: readonly (RoundResult | undefined)[],
  splitPrev?: Round,
  hideCounts = false,
): HoloRayTarget[] {
  const dpr = deviceDpr()
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const { w: cardW, h: cardH } = cardSize(l)
  const origin = shoeAnchor(l)
  // The holo-projected count boxes actually drawn this call — returned so the ray fans
  // target EXACTLY the counts that are on screen (never a count without its ray, or vice
  // versa). Each `drawCount` below pairs with a push here.
  const projected: HoloRayTarget[] = []

  // Dealer hand near the top; card index 1 is the hole card. The total is shown
  // BELOW the hand and updates live as cards flip face-up (hole included only
  // once it's revealed and flipping).
  const dealerY = dealerRowY(l)
  const dealerXs = rowXs(l.width / 2, round.dealer.length, cardW)
  round.dealer.forEach((card, i) => {
    drawDealt(ctx, dealerKey(i), dealerXs[i], dealerY, cardW, cardH, card, i === 1, revealHole, anim, origin, dpr)
  })
  const shownDealer = faceUpDealer(round, revealHole, anim)
  // `hideCounts` holds every total off the felt (the opening hand keeps them back until
  // its cards have fully landed, so they appear together — see GameView.firstHandCountsHidden).
  if (shownDealer.length > 0 && !hideCounts) {
    const da = dealerCountAnchor(l)
    projected.push(
      ...drawCount(ctx, evaluateHand(shownDealer).total, da.x, da.y, da.size, now, undefined, dealerNote(round, shownDealer)),
    )
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
    if (laneSettled(hand.cards.length, (ci) => playerKey(hi, ci), anim) && !hideCounts) {
      // Each hand shows its own win/loss/push — both halves of a split settle.
      const pa = playerCountAnchor(l, count, hi)
      projected.push(...drawCount(ctx, evaluateHand(hand.cards).total, centerX, pa.y, pa.size, now, results?.[hi]))
    }
  })
  return projected
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

// The sabotage tag beside the dealer's total, or undefined — a hijacked dealt
// natural, or a voided dealer 21 (Sabotage T2). Both sit with the dealer's total
// because both describe what happened to the DEALER's 21, not the player's hand.
// Gated on `resolved` so a mid-play Peek Dealer (which reveals the hole early) never
// shows it before the round actually settles.
function dealerNote(round: Round, shownDealer: readonly Card[]): ScoreNote | undefined {
  if (round.status !== 'resolved' || shownDealer.length !== round.dealer.length) {
    return undefined
  }
  if (isDealerHijacked(round)) {
    return { text: 'Hijacked', color: NOTE_SABOTAGE, side: 'right' }
  }
  // A voided dealer 21 washes every sub-21 player hand; tag it once at the dealer's
  // total (always 21 here) rather than on each player hand.
  if (round.hands.some((hand) => hand.outcome === 'voided')) {
    return { text: 'Voided', color: NOTE_SABOTAGE, side: 'right' }
  }
  return undefined
}

// The ray-target box for one projected readout, centred (roughly) on (cx, cy) at font
// size `size`. The number-drawing code returns these for the numbers it actually drew,
// so a ray fan lands exactly where — and only when — a number is on screen.
export function holoCountBox(cx: number, cy: number, size: number): HoloRayTarget {
  const w = size * 1.4
  return { left: cx - w / 2, right: cx + w / 2, top: cy - size / 2, bottom: cy + size / 2 }
}

// The dealer's total readout — its box centre + font size. Single source of truth so
// drawHands and the holo ray fan target the same spot.
export function dealerCountAnchor(l: Layout): { x: number; y: number; size: number } {
  const { h: cardH } = cardSize(l)
  return { x: l.width / 2, y: dealerRowY(l) + cardH + cardH * 0.22, size: clamp(cardH * 0.2, 20, 28) }
}

// A player hand's total readout (box centre + font size) for a `count`-hand layout — x
// tracks that hand's centre; y/size are shared with the dealer's count.
export function playerCountAnchor(l: Layout, count: number, hi: number): { x: number; y: number; size: number } {
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const { h: cardH } = cardSize(l)
  return { x: handCenterX(l, hi, count), y: feltTop + feltHeight * PLAYER_ROW - cardH * 0.34, size: clamp(cardH * 0.2, 20, 28) }
}

// A hand's total, big and centered on `centerX` (so the two hands' counts line
// up vertically). A result, when present, is drawn to the RIGHT of the count
// without moving it — the count stays put. An upgrade `note` sits on its own side.
function drawCount(
  ctx: CanvasRenderingContext2D,
  total: number,
  centerX: number,
  y: number,
  countPx: number,
  now: number,
  result?: RoundResult,
  note?: ScoreNote,
): HoloRayTarget[] {
  const boxes: HoloRayTarget[] = []
  const text = String(total)
  ctx.save()
  ctx.textBaseline = 'middle'

  ctx.textAlign = 'center'
  ctx.font = `bold ${countPx}px system-ui, sans-serif`
  // Everything the readout shows is projected by the holo — the count, the Win/Lose/Push
  // result, and any score note — all rendered as translucent glowing light + the shared
  // flicker, and each returning a ray-target box so the fans land on exactly this text.
  drawHoloText(ctx, text, centerX, y, countPx, COUNT_HOLO, now)
  boxes.push(holoCountBox(centerX, y, countPx))
  const countW = ctx.measureText(text).width // measured with the count font
  const gap = countPx * 0.35

  if (result) {
    ctx.textAlign = 'left'
    const rSize = Math.round(countPx * 0.78)
    ctx.font = `bold ${rSize}px system-ui, sans-serif`
    const lx = centerX + countW / 2 + gap
    drawHoloText(ctx, result.label, lx, y, rSize, holoStyleFromHex(resultColor(result.tone)), now)
    boxes.push(leftTextBox(ctx, result.label, lx, y, rSize))
  }

  if (note) {
    const nSize = Math.round(countPx * 0.6)
    ctx.font = `bold ${nSize}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    // Stacked over the count (left edges aligned) or off to its side.
    const nx = note.side === 'above' ? centerX - countW / 2 : centerX + countW / 2 + gap
    const ny = note.side === 'above' ? y - countPx * 0.75 : y
    drawHoloText(ctx, note.text, nx, ny, nSize, holoStyleFromHex(note.color), now)
    boxes.push(leftTextBox(ctx, note.text, nx, ny, nSize))
  }
  ctx.restore()
  return boxes
}

// Build a holo-text style (glow / bloom / core) from a solid hex colour, so a coloured
// readout (a Win/Lose result, a score note) projects like the rest: a translucent core
// lightened toward white, a soft bloom in the base colour, and a bright glow halo.
function holoStyleFromHex(hex: string): HoloTextStyle {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lite = (c: number, t: number): number => Math.round(c + (255 - c) * t)
  return {
    glow: `rgba(${lite(r, 0.15)}, ${lite(g, 0.15)}, ${lite(b, 0.15)}, 0.85)`,
    bloom: `rgba(${r}, ${g}, ${b}, 0.42)`,
    core: `rgba(${lite(r, 0.35)}, ${lite(g, 0.35)}, ${lite(b, 0.35)}, 0.78)`,
  }
}

// A ray-target box around LEFT-aligned text starting at (lx, cy) (baseline middle) at
// font `size` — for the result / note drawn beside a count.
function leftTextBox(ctx: CanvasRenderingContext2D, text: string, lx: number, cy: number, size: number): HoloRayTarget {
  const w = ctx.measureText(text).width
  const pad = size * 0.35
  return { left: lx - pad, right: lx + w + pad, top: cy - size / 2, bottom: cy + size / 2 }
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
// player's, left-aligned to the screen centre. Rendered as a red light the table
// nexus's holo projector casts onto the felt: a beam fans from the holo lens to the
// text. The whole projection FLICKERS — its opacity wavers, and the flicker rate
// ramps up over the first few hundred ms so it stutters into view like a hologram
// striking on. `age` is ms since the reading appeared; `now` (absolute) positions the
// projector on the hovering nexus. The view repaints until it's dismissed.
// How long the projection takes to flicker fully in; also the age it rewinds
// through on the way out, so the strike-off mirrors the strike-on.
export const ANALYSIS_STRIKE_MS = 420

// Draws the two odds rows and RETURNS their ray-target boxes, so the rays are projected
// onto exactly the rows that were drawn (never out of sync).
export function drawAnalysis(ctx: CanvasRenderingContext2D, l: Layout, a: AnalysisReadout, age: number, fade = 1, now = 0): HoloRayTarget[] {
  const g = analysisGeom(ctx, l, a)
  // Presence ramps in with the strike and fades on dismiss; a subtle opacity flicker on
  // top makes the readout read as a live hologram (kept shallow so it stays legible).
  const presence = Math.min(1, age / ANALYSIS_STRIKE_MS) * fade

  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = analysisFont(g.fontPx)
  ctx.globalAlpha = presence // the strike ramp / dismiss fade; drawHoloText adds the flicker
  drawHoloText(ctx, g.row1, g.x, g.y1, g.fontPx, ANALYSIS_HOLO, now)
  drawHoloText(ctx, g.row2, g.x, g.y2, g.fontPx, ANALYSIS_HOLO, now)
  ctx.restore()

  const pad = g.fontPx * 0.6
  return [
    { left: g.left, right: g.right, top: g.y1 - pad, bottom: g.y1 + pad },
    { left: g.left, right: g.right, top: g.y2 - pad, bottom: g.y2 + pad },
  ]
}

// A GENTLE opacity flicker shared by ALL the holo-projected readouts — the analysis
// rows AND the hand counts AND the chip counts — so they pulse together like one
// (slightly unstable) projection. Kept subtle, ~0.72..1.0, so it reads as a live
// projection without hurting legibility. Deterministic in `now` (no Math.random).
export function holoFlicker(now: number): number {
  const waver = 0.6 * Math.sin(now / 70) + 0.4 * Math.sin(now / 26 + 1.3) // [-1, 1]
  return 0.86 + 0.14 * waver // ~0.72 .. 1.0
}

// Shared geometry for the readout text + its ray-target boxes, so both use the same
// positions.
interface AnalysisGeom {
  x: number
  y1: number
  y2: number
  fontPx: number
  left: number
  right: number
  row1: string
  row2: string
}

function analysisGeom(ctx: CanvasRenderingContext2D, l: Layout, a: AnalysisReadout): AnalysisGeom {
  const feltTop = l.edgeY
  const feltHeight = l.height - feltTop
  const { h: cardH } = cardSize(l)
  const countPx = clamp(cardH * 0.2, 20, 28) // the hand-count font size (matches drawCount)
  const dealerCountY = dealerRowY(l) + cardH + cardH * 0.22
  const playerCountY = feltTop + feltHeight * PLAYER_ROW - cardH * 0.34
  // Fit the two rows in the CLEAR band BETWEEN the counts' text — each count reaches
  // ~countPx/2 from its centre, so leave that plus a margin. On tight (wide/short)
  // screens the band is small, so the font shrinks to fit rather than crowding the counts.
  const bandTop = dealerCountY + countPx * 0.7
  const bandBottom = playerCountY - countPx * 0.7
  const midY = (bandTop + bandBottom) / 2
  // Size to the band, but never bigger than the hand count — that stays the primary
  // number. With the counts now smaller + the dealer at the felt top, the band is roomy,
  // so on big screens this is countPx-limited rather than starved.
  const fontPx = clamp(Math.min(cardH * 0.24, (bandBottom - bandTop) / 2.6, countPx * 0.95), 11, 26)
  const rowGap = fontPx * 1.5
  // Left-align the readout to the left edge of the player's card-box decal, so it reads
  // as a caption for that seat — and on narrow phones it sits well left of the
  // (right-pushed) table nexus instead of overlapping it.
  const x = playerCardBox(l).x
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
    fontPx,
    left: x - fontPx * 0.4,
    right: x + textW + fontPx * 0.4,
    row1,
    row2,
  }
}

// Monospace so the digits align between the two rows.
function analysisFont(fontPx: number): string {
  return `700 ${fontPx}px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace`
}

// Whole-percent, zero-padded to at least two digits (9% → "09%", 100% stays "100%").
function pct(p: number): string {
  return `${String(Math.round(clamp(p, 0, 1) * 100)).padStart(2, '0')}%`
}

// A holo-text render style: a soft glow halo, a translucent bloom, and a brighter (but
// still translucent) core — projected LIGHT, not paint.
export interface HoloTextStyle {
  glow: string
  bloom: string
  core: string
}
// The red Analyze rows; and the warm cream hand/chip counts. Both kept see-through so the
// felt reads through them and they glow like a projection rather than a painted decal.
const ANALYSIS_HOLO: HoloTextStyle = { glow: 'rgba(255, 70, 70, 0.9)', bloom: 'rgba(255, 85, 85, 0.5)', core: 'rgba(255, 145, 145, 0.66)' }
export const COUNT_HOLO: HoloTextStyle = { glow: 'rgba(255, 236, 196, 0.85)', bloom: 'rgba(250, 240, 210, 0.42)', core: 'rgba(252, 246, 226, 0.75)' }

// Render `text` as translucent projected LIGHT — a soft glow bloom, then a brighter but
// still TRANSLUCENT core (no hard outline, so the felt shows through and it never reads as
// a solid decal). Applies the shared holoFlicker on top of the current globalAlpha, so
// every readout pulses together. The caller sets ctx.font + alignment; `size` is the font
// px (the glow radius scales off it).
export function drawHoloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  style: HoloTextStyle,
  now: number,
  glowScale = 1, // >1 widens/strengthens this label's glow halo (default: the standard holo glow)
): void {
  // The glow (two shadowBlur passes) is expensive and identical frame to frame, so it's
  // baked into a cached sprite; only the per-frame holoFlicker pulse stays live, applied
  // as the blit alpha on top of the caller's current globalAlpha. The caller's font +
  // alignment + baseline are read straight off the context, exactly as fillText used them.
  const sprite = getGlowLabelSprite(text, ctx.font, size, style, ctx.textAlign, ctx.textBaseline, deviceDpr(), glowScale)
  blitGlowLabel(ctx, sprite, x, y, holoFlicker(now))
}

// One tossed card's flip + fly progress; produced by the mulligan animator (ui)
// and consumed here. Lives in the render layer so ui depends on render, not back.
export interface DiscardFrame {
  card: Card
  flip: number // 1 = face-up, 0 = face-down
  fly: number // 0 = resting in its slot, 1 = merged into the deck
}

// The Bust Block reveal's progress at a moment; produced by the bust-block
// animator (ui) and consumed by drawBustBlock. Same render-owns-the-shape
// arrangement as DiscardFrame.
export interface BustBlockFrame {
  flight: number // 0→1 shoe → slot
  flip: number // 1 = face-up, 0 = face-down
  fly: number // 0→1 slot → dealer muck (0 until the eject)
  shield: number // 0→1 shield-catch intensity (the ring + "BUST" tag)
}

// The mulligan discard: the tossed opening cards (frames from the mulligan
// animator) flip face-down and are swept up to the DEALER, who mucks them. Their
// slots use the same hand-0 geometry as drawHands, so they set off from where the
// cards sat.
export function drawMulliganDiscard(ctx: CanvasRenderingContext2D, l: Layout, frames: readonly DiscardFrame[]): void {
  if (frames.length === 0) {
    return
  }
  const dpr = deviceDpr()
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
  const dpr = deviceDpr()
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

// The Bust Block reveal: the busting draw the shield caught, shown on the active
// hand's next slot so the player sees the bust they hit. It flies in from the
// shoe, flips up inside a gold shield ring (with a red "BUST" tag), then flips
// down and is swept off to the dealer's muck. Drawn ON TOP of the settled hand
// (after drawHands); GameView holds any replacement card back until this ends, so
// the slot stays free while the busting card occupies it. `cardIndex` may be one
// past the hand's last card (a replacement that also busted leaves it shorter).
export function drawBustBlock(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  round: Round,
  handIndex: number,
  cardIndex: number,
  card: Card,
  frame: BustBlockFrame,
): void {
  const dpr = deviceDpr()
  const count = round.hands.length
  const { w: cardW, h: cardH } = cardSize(l)
  const scale = handCardScale(l, count)
  const w = cardW * scale
  const h = cardH * scale
  const playerY = l.edgeY + (l.height - l.edgeY) * PLAYER_ROW
  const centerX = handCenterX(l, handIndex, count)
  // Slot it among the hand's cards, matching rowXs' overlap — but extended so the
  // index can sit one past the last card (rowXs itself stops at the hand's end).
  const handLen = round.hands[handIndex].cards.length
  const step = w * 0.5
  const spread = w + step * Math.max(0, handLen - 1)
  const slotX = centerX - spread / 2 + step * cardIndex

  const shoe = shoeAnchor(l)
  let x = slotX
  let y = playerY
  let alpha = 1
  if (frame.fly > 0) {
    // Ejecting: sweep to the dealer's muck (same target as the mulligan discard),
    // fading into it over the back half of the trip.
    const d = dealerBox(l)
    const targetX = d.cx - w / 2
    const targetY = (d.bodyTop + d.baseY) / 2 - h / 2
    const e = smoothStep(frame.fly)
    x = slotX + (targetX - slotX) * e
    y = playerY + (targetY - playerY) * e
    alpha = frame.fly < 0.6 ? 1 : Math.max(0, 1 - (frame.fly - 0.6) / 0.4)
  } else if (frame.flight < 1) {
    // Flying in from the shoe.
    const e = smoothEnd3(frame.flight)
    x = shoe.x + (slotX - shoe.x) * e
    y = shoe.y + (playerY - shoe.y) * e
  }

  // The gold shield ring catching the card, drawn behind it so the card sits
  // inside. Only while the card rests on the slot (not in flight, not ejecting).
  if (frame.shield > 0 && frame.fly <= 0) {
    drawShieldCatch(ctx, x, y, w, h, frame.shield)
  }
  drawFlipCard(ctx, card, x, y, w, h, frame.flip, alpha, dpr)

  // "BUST" over the card once its face has turned up, so the blocked bust reads
  // at a glance. Tied to the card (not the hand's count line, which a second
  // split hand or a surviving replacement may be using).
  if (frame.shield > 0 && frame.fly <= 0 && frame.flip >= 0.5) {
    ctx.save()
    ctx.globalAlpha = Math.min(1, frame.shield)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'center'
    ctx.font = `bold ${Math.round(clamp(cardH * 0.2, 20, 28) * 0.9)}px system-ui, sans-serif`
    shadowText(ctx, 'BUST', x + w / 2, y - h * 0.14, BUST_BLOCK_RED)
    ctx.restore()
  }
}

// The gold ring (themed to the armed Bust Block button's glow) that snaps around
// the busting card as the shield catches it; `intensity` 0→1 drives its presence.
function drawShieldCatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  intensity: number,
): void {
  const pad = h * 0.08
  const radius = h * 0.12
  ctx.save()
  ctx.globalAlpha = Math.min(1, intensity)
  ctx.beginPath()
  ctx.roundRect(x - pad, y - pad, w + pad * 2, h + pad * 2, radius)
  ctx.fillStyle = 'rgba(255, 214, 110, 0.12)'
  ctx.fill()
  ctx.lineWidth = Math.max(2.5, h * 0.05)
  ctx.strokeStyle = SHIELD_GOLD
  ctx.shadowColor = SHIELD_GLOW
  ctx.shadowBlur = h * 0.22
  ctx.stroke()
  ctx.restore()
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
  const base = cardSize(l)
  const w = base.w * 0.9
  const h = base.h * 0.9
  const stackW = w * SHOE_DX * SHOE_LAYERS
  const margin = Math.max(14, l.width * 0.03)

  // Sit the deck just right of a centered dealer hand — keeps it near the
  // dealer on wide screens — but never let it run past the right edge (mobile).
  const preferredX = l.width / 2 + base.w * 1.7
  const maxX = l.width - margin - w - stackW
  const x = Math.min(preferredX, maxX)
  // Hug the curved felt top at the deck's own right extent (like the dealer cards), so
  // the deck sits up near the dealer and follows the arch instead of the low side edge.
  return {
    x,
    y: feltTopEdgeY(l, x + w + stackW) + base.w * 0.12,
    w,
    h,
  }
}

// The deck sitting on the felt: a stack of card backs, drawn at (x, y). Static
// placeholder — the shoe is reshuffled every deal in the logic, so it never
// depletes on screen. Position is explicit so the deck can slide during a
// shuffle; `shoeAnchor` gives its resting spot.
export function drawShoe(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const dpr = deviceDpr()
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
  const dpr = deviceDpr()
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
// Portion of each riffle pass spent splitting apart (before the piles merge back
// together). Exported so the shuffle sfx can fire exactly when the merge begins.
export const SHUFFLE_SPLIT_FRACTION = 0.3
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
  const dpr = deviceDpr()
  // On a dealer change the riffle is the deck swap: the outgoing deck (current
  // palette) splits and fades out while the incoming deck (the new dealer's colour)
  // riffles in, so the colour cross-fades right where the cards are already flying.
  // Without an `incoming` it's a plain same-colour reshuffle between hands.
  const outBack = getCardSprite(null, w, h, dpr)
  const inBack = incoming ? getCardSprite(null, w, h, dpr, incoming) : outBack
  const offset = w * 0.9 // how far the two piles sit from centre

  const ct = t // 0..1 through the single riffle pass

  if (ct < SHUFFLE_SPLIT_FRACTION) {
    // Split: the centre (outgoing) deck divides into two piles sliding apart.
    const p = smoothEnd3(ct / SHUFFLE_SPLIT_FRACTION)
    drawStack(ctx, outBack, x - offset * p, y, 1)
    drawStack(ctx, outBack, x + offset * p, y, 1)
    return
  }

  // Riffle: the two outgoing piles deplete as a single incoming deck reforms between them.
  const mt = (ct - SHUFFLE_SPLIT_FRACTION) / (1 - SHUFFLE_SPLIT_FRACTION)
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
