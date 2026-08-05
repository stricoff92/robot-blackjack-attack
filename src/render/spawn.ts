// The dealer-spawn visuals: shredding the previous dealer's cards into the new
// dealer's mouth (paper chunks coning off left), and the fresh shrink-wrapped deck
// flying from the dealer into the shoe + the plastic tearing off.
//
// Geometry + paint only (mirrors the other render modules); all timing lives in the
// spawn animator (ui/spawn-animator.ts), passed in here as a SpawnView. Drawn on the
// cards layer, above the felt/rail — so a card lifts off the table and up into the
// mouth (which sits above the rail on the dealer's head).

import type { Round } from '../game/round'
import { blitCard, getCardSprite, setCardBack } from './card-sprite'
import { drawDepletingShoe, drawShoe, shoeAnchor, shoeStackExtent, shoeTopFor, tableCards } from './cards'
import { smoothEnd2, smoothEnd3, smoothStart2, smoothStart4, smoothStep } from './easing'
import type { CardBack } from './palette'
import { dealerBox, dealerMouth, type Layout } from './scene'

// What the spawn animator exposes to this renderer. All queries take `now`.
export interface SpawnView {
  // Card `i`'s suck-in progress (null = still resting, 0..1 = flying into the mouth).
  cardSuck(i: number, now: number): number | null
  // Card `i`'s paper-chunk spray life (0..1), or null when it isn't spraying.
  chunk(i: number, now: number): number | null
  // The previous dealer's DECK shred: how many backs it sheds, the fraction still resting
  // on the shoe (1 = full, 0 = spent), and per-card suck (null = resting / no old deck,
  // 0..1 = flying into the mouth) + paper-chunk spray life (0..1, or null).
  deckCardCount(): number
  deckRemaining(now: number): number
  deckCardSuck(k: number, now: number): number | null
  deckCardChunk(k: number, now: number): number | null
  // The fresh deck's fly-in + unwrap state, or null before it emerges.
  deckState(now: number): { fly: number; unwrap: number } | null
}

// The previous dealer's cards being drawn into the new dealer's mouth and shredded:
// each card flies from its felt slot into the mouth, shrinking to nothing, throwing
// a spray of paper chunks that cone off to the left as it's chewed up.
export function drawShred(ctx: CanvasRenderingContext2D, l: Layout, round: Round, view: SpawnView, now: number): void {
  const dpr = window.devicePixelRatio || 1
  const cards = tableCards(l, round)
  const mouth = dealerMouth(l)
  const scale = Math.min(l.width, l.height)

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    const suck = view.cardSuck(i, now)
    if (suck === null) {
      drawCardCentered(ctx, c.card, c.cx, c.cy, c.w, c.h, 1, dpr) // still resting, face-up
    } else if (suck < 1) {
      // Fly toward the mouth, shrinking as it's drawn in.
      const e = smoothStart2(suck)
      const x = c.cx + (mouth.x - c.cx) * e
      const y = c.cy + (mouth.y - c.cy) * e
      drawCardCentered(ctx, c.card, x, y, c.w, c.h, 1 - suck, dpr)
    }
    const chunk = view.chunk(i, now)
    if (chunk !== null) {
      drawPaperCone(ctx, mouth.x, mouth.y, chunk, scale, i)
    }
  }
}

// The previous dealer's DECK being shredded: it rests on the shoe through the death/
// walk-in, then — once the table cards are gone — sheds its cards off the top in a rapid
// flurry, 40 backs peeling away one after another into the new dealer's mouth (each
// shrinking + fading and throwing its own paper spray) while the resting stack shrinks
// beneath them, so the shoe is empty before the fresh wrapped deck lands. `back` is the
// OUTGOING dealer's card-back palette.
export function drawOldDeckShred(ctx: CanvasRenderingContext2D, l: Layout, back: CardBack, view: SpawnView, now: number): void {
  setCardBack(back) // the resting + flying deck cards stay the old dealer's colour
  drawDepletingShoe(ctx, l, view.deckRemaining(now)) // the resting remainder, shrinking as cards leave

  const mouth = dealerMouth(l)
  const scale = Math.min(l.width, l.height)
  const rest = shoeAnchor(l)
  const dpr = window.devicePixelRatio || 1
  const count = view.deckCardCount()
  for (let k = 0; k < count; k++) {
    const suck = view.deckCardSuck(k, now)
    if (suck !== null && suck < 1) {
      // Each card peels off the TOP of the deck at the height the top had when it left
      // (spent = k / count), so it rides the receding top surface — not a fixed point.
      const top = shoeTopFor(l, k / count)
      const ocx = top.x + rest.w / 2
      const ocy = top.y + rest.h / 2
      // Lift UP off the top first (a quick pop that fades over the flight) so the card is
      // clearly plucked off the top surface, then accelerate up into the mouth. It shrinks
      // only modestly (still a readable card) and fades late — holding opaque through the
      // flight, then vanishing crisply into the mouth (smoothStart4).
      const e = smoothStart2(suck)
      const lift = rest.h * 0.3 * smoothEnd3(clamp01(suck / 0.3)) * (1 - suck)
      const cardScale = 1 - 0.5 * smoothStart2(suck)
      const alpha = 1 - smoothStart4(suck)
      drawBackCentered(ctx, ocx + (mouth.x - ocx) * e, ocy + (mouth.y - ocy) * e - lift, rest.w, rest.h, cardScale, alpha, dpr)
    }
    const chunk = view.deckCardChunk(k, now)
    if (chunk !== null) {
      drawPaperCone(ctx, mouth.x, mouth.y, chunk, scale, 200 + k, DECK_CHUNK_COUNT)
    }
  }
}

// The fresh shrink-wrapped deck: it flies from the dealer's hands into the shoe —
// starting small (in the dealer's hands) and SCALING UP to full size as it lands —
// the clear plastic riding along, then the plastic tears + flies off to the right,
// leaving the bare deck at rest. `back` is the incoming dealer's card-back palette.
const DECK_START_SCALE = 0.4 // size the deck emerges at, growing to 1 as it lands

export function drawSpawnDeck(ctx: CanvasRenderingContext2D, l: Layout, back: CardBack, view: SpawnView, now: number): void {
  const st = view.deckState(now)
  if (!st) {
    return
  }
  const rest = shoeAnchor(l)
  const d = dealerBox(l)
  // Fly the deck's CENTRE from the dealer's hands (torso mid-height) to the shoe, and
  // grow it from small to full over the trip. Drawn at full (rest) size inside a scale
  // transform — so it reuses the one pre-warmed deck sprite instead of rebuilding it at
  // a new size every frame (which would thrash the sprite cache and hitch the fly-in).
  const originCX = d.cx
  const originCY = (d.bodyTop + d.baseY) / 2
  const restCX = rest.x + rest.w / 2
  const restCY = rest.y + rest.h / 2
  const e = smoothEnd3(st.fly)
  const cx = originCX + (restCX - originCX) * e
  const cy = originCY + (restCY - originCY) * e
  const scale = DECK_START_SCALE + (1 - DECK_START_SCALE) * e

  setCardBack(back) // every back drawn below uses the incoming dealer's colour
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)
  const x = -rest.w / 2
  const y = -rest.h / 2
  drawShoe(ctx, x, y, rest.w, rest.h)
  drawPlastic(ctx, x, y, rest.w, rest.h, st.unwrap, l)
  ctx.restore()
}

// Draw a card face-up, centred on (cx, cy) at uniform scale `s` (1 = full size,
// shrinking to nothing as it's swallowed).
function drawCardCentered(
  ctx: CanvasRenderingContext2D,
  card: Round['dealer'][number],
  cx: number,
  cy: number,
  w: number,
  h: number,
  s: number,
  dpr: number,
): void {
  if (s <= 0.02) {
    return
  }
  const sprite = getCardSprite(card, w, h, dpr)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(s, s)
  blitCard(ctx, sprite, -w / 2, -h / 2)
  ctx.restore()
}

// A card BACK centred on (cx, cy) at uniform scale `s` and opacity `alpha` — the
// outgoing-deck cards peeling off the shoe into the mouth (uses the active card-back
// palette set by the caller).
function drawBackCentered(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, s: number, alpha: number, dpr: number): void {
  if (s <= 0.02 || alpha <= 0.02) {
    return
  }
  const sprite = getCardSprite(null, w, h, dpr)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx, cy)
  ctx.scale(s, s)
  blitCard(ctx, sprite, -w / 2, -h / 2)
  ctx.restore()
}

// A spray of cream paper chunks bursting out of the mouth and coning off to the
// LEFT: each chunk flies out on its own leftward heading to its own distance
// (smoothEnd3 — a fast burst that eases to rest), drooping a touch under gravity and
// fading out (smoothEnd2). Per-chunk randomness comes from the deterministic hash()
// keyed by the card index `seed`, so the burst is a pure function of its life and
// never jitters frame-to-frame. Staggered cards' sprays overlap into one continuous
// stream filling the cone.
const CHUNK_COUNT = 12
const DECK_CHUNK_COUNT = 7 // lighter per-card spray for the deck shred (40 cards, many overlapping)
const CHUNK_SPREAD = 0.62 // half-angle of the leftward cone, radians (~35°)

function drawPaperCone(ctx: CanvasRenderingContext2D, mx: number, my: number, life: number, scale: number, seed: number, count = CHUNK_COUNT): void {
  const fade = 1 - smoothEnd2(life)
  if (fade <= 0.02) {
    return
  }
  const reach = scale * 0.45 // how far the furthest chunks fly off to the left
  const travel = smoothEnd3(life)
  const gy = scale * 0.05 * life * life // slight downward droop, growing quadratically
  const s = seed * 13 + 1
  ctx.save()
  for (let i = 0; i < count; i++) {
    const ang = Math.PI + (hash(i, s) * 2 - 1) * CHUNK_SPREAD // pointing left, fanned
    const dist = reach * (0.3 + hash(i, s + 7) * 0.7) * travel
    const x = mx + Math.cos(ang) * dist
    const y = my + Math.sin(ang) * dist + gy
    const sz = scale * (0.011 + 0.014 * hash(i, s + 3))
    const rot = (hash(i, s + 5) * 2 - 1) * 7 * life
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.globalAlpha = fade * (0.7 + 0.3 * hash(i, s + 9))
    ctx.fillStyle = i % 3 === 0 ? '#d6cfb8' : '#efe9d7' // cream paper, some torn darker
    ctx.beginPath()
    ctx.roundRect(-sz / 2, -sz * 0.35, sz, sz * 0.7, sz * 0.18)
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

// The clear plastic shrink-wrap: a tight rectangle covering the whole deck stack, with
// a serrated seal LIP (mini triangles, food-package style) along its top + bottom edges.
// While wrapped (unwrap = 0) it's one clean sheet. To open (like ripping the sealed EDGE
// off a pack of baseball cards): first the thin edge STRIP tears away — a tear line runs
// DOWN the seam (top → bottom), drawn PROGRESSIVELY as the still-attached wrap's stepped
// edge, while the peeled part folds over — then that strip is tossed fully off to the
// right; and ONLY THEN does the big sheet (which never flips) SLIDE LEFT off the cards
// (revealing them), then get flicked off the page to the RIGHT.
const SHEET_SPIN = 0.7 // radians the big sheet tumbles through as it flicks off right (~40°)

function drawPlastic(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, unwrap: number, l: Layout): void {
  // Size the wrap to the deck's FULL footprint — the offset stack fans down-right, so
  // the plastic has to cover (w + dx) × (h + dy) or the stack pokes out bottom-right.
  const { dx, dy } = shoeStackExtent(w, h)
  const pad = w * 0.05 // tight: the wrap barely oversizes the stack
  const bx = x - pad
  const by = y - pad
  const bw = w + dx + pad * 2
  const bh = h + dy + pad * 2

  if (unwrap <= 0) {
    drawWrapPiece(ctx, bx, by, bw, bh, 0, 0, 0, 1) // one clean sheet, wrapped
    return
  }

  const stripW = bw * 0.18 // the thin tear-off edge strip on the right
  const sheetW = bw - stripW
  const clear = l.width - bx + bw // toss/slide right far enough to fully clear the screen
  const lip = Math.max(5, Math.min(bh * 0.075, 13))

  // Sequenced so the pieces never move at once: the edge peels (tear line top→bottom),
  // then that strip is tossed fully away, and only after that does the sheet move.
  const peel = smoothStep(clamp01(unwrap / 0.34))
  const toss = smoothStart2(clamp01((unwrap - 0.34) / 0.16))
  // Sheet motion: SLIDE LEFT off the cards (smoothEnd — eases to a stop just clear of the
  // deck), hold a beat, then FLICK off the page to the RIGHT (smoothStart — accelerates
  // away) while fading. slideDist = sheetW so it fully clears the deck to the left.
  const slideLeft = smoothEnd2(clamp01((unwrap - 0.54) / 0.18))
  const flick = smoothStart2(clamp01((unwrap - 0.78) / 0.22))
  const sheetX = -sheetW * slideLeft + (clear + sheetW) * flick
  const tearY = by + peel * bh

  // Still-attached wrap: an L-shape while the strip peels (sheet-width ABOVE the tear
  // line, full-width BELOW it) — its stepped right edge IS the tear line, so the line is
  // drawn PROGRESSIVELY as the tear descends. Once the strip is gone it's a plain
  // sheet-width rect that slides left then TUMBLES off the page to the right — spinning
  // clockwise about its centre as it flicks away (it never flips).
  drawAttachedWrap(ctx, bx, by, bw, sheetW, bh, tearY, lip, sheetX, -flick * bh * 0.1, SHEET_SPIN * flick, 1 - flick)

  // Peeled edge strip: the part above the tear line folds over (about the descending
  // tear line); once fully peeled it's tossed off to the right.
  drawPeeledStrip(ctx, bx + sheetW, by, stripW, tearY, lip, toss * clear, -toss * bh * 0.1, 0.16 * toss, 1 - toss)
}

// The still-attached wrap while the edge peels: an L-shape — sheet-width (bx..bx+sheetW)
// ABOVE the tear line, full-width (bx..bx+bw) BELOW it — serrated lips on top + bottom.
// Its stepped right edge is the tear line (grows as `tearY` descends). Offset by (tx,ty)
// so it can slide off once the strip is gone.
function drawAttachedWrap(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  bw: number,
  sheetW: number,
  bh: number,
  tearY: number,
  lip: number,
  tx: number,
  ty: number,
  rot: number,
  alpha: number,
): void {
  if (alpha <= 0.02) {
    return
  }
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(tx, ty)
  if (rot !== 0) {
    // Spin about the sheet's centre (it's a plain sheet-width rect by the flick, the
    // strip already tossed) so it tumbles rather than sliding flat off the page.
    const cx = bx + sheetW / 2
    const cy = by + bh / 2
    ctx.translate(cx, cy)
    ctx.rotate(rot)
    ctx.translate(-cx, -cy)
  }

  traceAttached(ctx, bx, by, bw, sheetW, bh, tearY, lip)
  ctx.fillStyle = 'rgba(214, 230, 240, 0.17)'
  ctx.fill()
  ctx.lineWidth = Math.max(1, Math.min(bw, bh) * 0.02)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)'
  ctx.stroke()

  // Diagonal specular streak, clipped to the L-shape.
  ctx.save()
  traceAttached(ctx, bx, by, bw, sheetW, bh, tearY, lip)
  ctx.clip()
  const grad = ctx.createLinearGradient(bx, by, bx + bw, by + bh)
  grad.addColorStop(0.32, 'rgba(255, 255, 255, 0)')
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.34)')
  grad.addColorStop(0.64, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(bx - lip, by - lip, bw + lip * 2, bh + lip * 2)
  ctx.restore()
  ctx.restore()
}

// Trace the L-shaped attached-wrap outline: serrated top + bottom lips, and a stepped
// right edge (= the tear line). Degenerates to a plain rect before the tear starts (full
// width) / after it ends (sheet width).
function traceAttached(ctx: CanvasRenderingContext2D, bx: number, by: number, bw: number, sheetW: number, bh: number, tearY: number, lip: number): void {
  const band = lip * 0.4
  const peeled = tearY > by + 0.5 // the strip has started peeling → top is sheet-width
  const attached = tearY < by + bh - 0.5 // a full-width part still hangs below the tear
  const topW = peeled ? sheetW : bw
  const botW = attached ? bw : sheetW
  const topTeeth = Math.max(4, Math.min(Math.round(topW / 8), 30))
  const ttw = topW / topTeeth
  const botTeeth = Math.max(4, Math.min(Math.round(botW / 8), 30))
  const btw = botW / botTeeth

  ctx.beginPath()
  ctx.moveTo(bx, by - band)
  for (let i = 0; i < topTeeth; i++) {
    ctx.lineTo(bx + ttw * i + ttw * 0.5, by - lip)
    ctx.lineTo(bx + ttw * (i + 1), by - band)
  }
  if (peeled && attached) {
    ctx.lineTo(bx + sheetW, tearY) // down the seam (the tear line) to the tear front
    ctx.lineTo(bx + bw, tearY) // step out to full width
    ctx.lineTo(bx + bw, by + bh + band)
  } else {
    ctx.lineTo(bx + topW, by + bh + band) // plain rect (topW === botW)
  }
  for (let i = 0; i < botTeeth; i++) {
    ctx.lineTo(bx + botW - btw * i - btw * 0.5, by + bh + lip)
    ctx.lineTo(bx + botW - btw * (i + 1), by + bh + band)
  }
  ctx.lineTo(bx, by - band)
  ctx.closePath()
}

// The peeled edge strip: the part of the strip ABOVE the tear line ([py, tearY]) folded
// over — flipped about the (descending) tear line so it hangs down — then tossed off
// right. `pw`/`px` are the strip's width/left; `tearY` the current tear front.
function drawPeeledStrip(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, tearY: number, lip: number, tx: number, ty: number, rot: number, alpha: number): void {
  const peeledH = tearY - py
  if (peeledH <= 0.5 || alpha <= 0.02) {
    return
  }
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(tx, ty)
  ctx.rotate(rot)
  ctx.translate(0, tearY)
  ctx.scale(1, -1) // fold over the tear line
  ctx.translate(0, -tearY)
  drawStripPart(ctx, px, py, pw, peeledH, 'top', lip)
  ctx.restore()
}

// One part of a torn strip: a translucent rectangle [x,y,w,h] with a serrated lip on
// `lipSide` (its original outer edge) and a straight torn edge on the other side.
function drawStripPart(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lipSide: 'top' | 'bottom', lip: number): void {
  if (h <= 0.5) {
    return
  }
  const effLip = Math.min(lip, h * 0.7)
  const teeth = Math.max(3, Math.min(Math.round(w / 7), 20))
  const tw = w / teeth
  ctx.beginPath()
  if (lipSide === 'top') {
    const valley = y - effLip * 0.4
    ctx.moveTo(x, valley)
    for (let i = 0; i < teeth; i++) {
      ctx.lineTo(x + tw * i + tw * 0.5, y - effLip)
      ctx.lineTo(x + tw * (i + 1), valley)
    }
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
  } else {
    const valley = y + h + effLip * 0.4
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y)
    ctx.lineTo(x + w, valley)
    for (let i = 0; i < teeth; i++) {
      ctx.lineTo(x + w - tw * i - tw * 0.5, y + h + effLip)
      ctx.lineTo(x + w - tw * (i + 1), valley)
    }
    ctx.lineTo(x, valley)
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(220, 234, 243, 0.19)'
  ctx.fill()
  ctx.lineWidth = Math.max(1, w * 0.05)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)'
  ctx.stroke()
}

// One piece of the wrap — a rectangular BODY at (px,py,pw,ph) with a serrated seal
// LIP (mini triangles, like a food-package tear edge) along its TOP and BOTTOM. Offset
// by (tx,ty), rotated `rot`, at `alpha`. Used for the intact wrapped deck (unwrap = 0);
// the tearing pieces have their own drawers (drawAttachedWrap / drawPeeledStrip).
function drawWrapPiece(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  pw: number,
  ph: number,
  tx: number,
  ty: number,
  rot: number,
  alpha: number,
): void {
  if (alpha <= 0.02) {
    return
  }
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(px + pw / 2 + tx, py + ph / 2 + ty)
  ctx.rotate(rot)
  const x0 = -pw / 2
  const y0 = -ph / 2
  const lip = Math.max(5, Math.min(ph * 0.075, 13)) // seal-lip reach beyond the body, top+bottom

  tracePiece(ctx, x0, y0, pw, ph, lip)
  ctx.fillStyle = 'rgba(214, 230, 240, 0.17)'
  ctx.fill()
  ctx.lineWidth = Math.max(1, Math.min(pw, ph) * 0.03)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)'
  ctx.stroke()

  // Sell the sealed lips: a frosted band along the top + bottom (clipped to the
  // serrated outline) with a faint crimp line where each lip meets the deck.
  ctx.save()
  tracePiece(ctx, x0, y0, pw, ph, lip)
  ctx.clip()
  ctx.fillStyle = 'rgba(236, 243, 249, 0.15)'
  ctx.fillRect(x0, y0 - lip, pw, lip)
  ctx.fillRect(x0, y0 + ph, pw, lip)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x0 + pw, y0)
  ctx.moveTo(x0, y0 + ph)
  ctx.lineTo(x0 + pw, y0 + ph)
  ctx.stroke()

  // A crisp diagonal specular streak (still under the same clip) sells the shine.
  const grad = ctx.createLinearGradient(x0, y0, x0 + pw, y0 + ph)
  grad.addColorStop(0.32, 'rgba(255, 255, 255, 0)')
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.36)')
  grad.addColorStop(0.64, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(x0, y0 - lip, pw, ph + lip * 2)
  ctx.restore()
  ctx.restore()
}

// A wrap-piece outline: a plain rectangular BODY [x,y,w,h] with a serrated seal LIP on
// the TOP and BOTTOM edges — a row of mini triangles reaching `lip` px out, over a thin
// solid band. Left/right edges stay straight (the clean vertical tear seam).
function tracePiece(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lip: number): void {
  const band = lip * 0.4 // solid part of the lip, between the teeth and the body
  const teeth = Math.max(4, Math.min(Math.round(w / 8), 30))
  const tw = w / teeth
  const topValley = y - band
  const topTip = y - lip
  const botValley = y + h + band
  const botTip = y + h + lip

  ctx.beginPath()
  ctx.moveTo(x, topValley)
  for (let i = 0; i < teeth; i++) {
    const xa = x + tw * i
    ctx.lineTo(xa + tw * 0.5, topTip) // up to the tooth tip
    ctx.lineTo(xa + tw, topValley) // back down to the valley
  }
  ctx.lineTo(x + w, botValley) // straight right edge
  for (let i = 0; i < teeth; i++) {
    const xa = x + w - tw * i
    ctx.lineTo(xa - tw * 0.5, botTip) // down to the tooth tip
    ctx.lineTo(xa - tw, botValley) // back up to the valley
  }
  ctx.lineTo(x, topValley) // straight left edge
  ctx.closePath()
}

// Cheap deterministic hash → [0, 1), so per-chunk attributes are stable across
// frames (same convention as render/nexus.ts's spark burst).
function hash(i: number, seed: number): number {
  const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
  return v - Math.floor(v)
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
