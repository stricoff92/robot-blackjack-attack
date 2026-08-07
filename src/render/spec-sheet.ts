// The nexus's "RULES" projection: the table nexus's holo projector casts the current
// dealer's active ruleset — plus the live token inflation — into the clear band BETWEEN
// the two hands' counts, exactly where the Analyze readout sits. Toggled by the info
// button beside the dealer's head (see game-view.ts).
//
// Pure projected LIGHT, like the counts / Analyze rows: a "RULES" heading over a wrapped
// run of abbreviated flags (a CPU-style feature listing) — no panel, frame, or scrim. It
// flickers in on a strike ramp, shares the holoFlicker pulse, shrinks to fit the band,
// and returns its text box so drawHoloProjection fans the holo lens's rays onto it.
//
// Render-only, mirroring cards.ts: the game builds the SpecReadout (import-free of game
// logic — just strings + a colour kind) and this paints it.

import { dealerCountAnchor, drawHoloText, playerCountAnchor, type HoloTextStyle } from './cards'
import type { HoloRayTarget } from './nexus'
import type { Layout } from './scene'

// How long the projection takes to flicker fully in; also the age it rewinds through on
// the way out, so the strike-off mirrors the strike-on (see game-view's specRender).
export const SPEC_STRIKE_MS = 460

// One abbreviated flag. `kind` colours it: a HOUSE rule (the dealer's edge, cyan) or a
// PLAYER mod (a roguelite buff in the player's favour, green).
export interface SpecFlag {
  text: string
  kind: 'house' | 'player'
}

// The readout's data — pure strings (mirrors AnalysisReadout, so the render layer stays
// decoupled from the game's rules/run types). `inflation` is the pre-formatted value
// (e.g. "+12%") shown on its own "TOKEN INFLATION" line above the flags.
export interface SpecReadout {
  inflation: string
  flags: SpecFlag[]
}

// Holo-text styles (soft glow → translucent core): a bright cyan heading, cyan house
// flags, green player mods, amber for the inflation value, and a dim cyan for its label.
const HEAD: HoloTextStyle = { glow: 'rgba(150, 245, 245, 0.95)', bloom: 'rgba(170, 248, 248, 0.55)', core: 'rgba(222, 253, 253, 0.9)' }
const CYAN: HoloTextStyle = { glow: 'rgba(120, 235, 238, 0.9)', bloom: 'rgba(140, 244, 246, 0.48)', core: 'rgba(205, 250, 251, 0.82)' }
const GREEN: HoloTextStyle = { glow: 'rgba(120, 240, 150, 0.9)', bloom: 'rgba(140, 246, 165, 0.5)', core: 'rgba(210, 252, 220, 0.82)' }
const AMBER: HoloTextStyle = { glow: 'rgba(255, 198, 110, 0.92)', bloom: 'rgba(255, 206, 125, 0.5)', core: 'rgba(255, 238, 195, 0.86)' }
const DIM: HoloTextStyle = { glow: 'rgba(120, 220, 230, 0.7)', bloom: 'rgba(120, 220, 230, 0.34)', core: 'rgba(180, 236, 240, 0.66)' }

function styleFor(kind: SpecFlag['kind']): HoloTextStyle {
  return kind === 'player' ? GREEN : CYAN
}

// Monospace so the flag tokens read like a terminal feature listing.
function monoFont(px: number, weight = 700): string {
  return `${weight} ${px}px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace`
}

interface Tok {
  flag: SpecFlag
  w: number // measured advance at the trial font
}
interface Row {
  toks: Tok[]
  w: number // total row width (tokens + inter-token gaps), at the trial font
}

// Draw the RULES readout and RETURN its text box (one ray-target, so the holo lens fans
// one clean beam onto it). `age` is ms since it appeared (the strike-in), `fade` winds it
// out on dismiss, `now` positions the shared flicker.
export function drawSpecSheet(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  spec: SpecReadout,
  age: number,
  fade = 1,
  now = 0,
): HoloRayTarget[] {
  // The clear band between the two counts — the same one the Analyze readout uses.
  const dc = dealerCountAnchor(l)
  const pc = playerCountAnchor(l, 1, 0)
  const countPx = dc.size
  const bandTop = dc.y + countPx * 0.7
  const bandBottom = pc.y - countPx * 0.7
  const bandH = Math.max(1, bandBottom - bandTop)
  const bandMid = (bandTop + bandBottom) / 2
  const cx = l.width / 2

  const scale = Math.min(l.width, l.height)
  const headPx = clamp(scale * 0.026, 14, 24)
  const statPx = clamp(scale * 0.019, 11, 17)
  const flagPx = clamp(scale * 0.02, 11, 18)
  // A deliberately NARROW column so the flags stack into several short lines (a tall
  // ruleset readout) rather than a couple of wide ones.
  const contentW = Math.min(l.width * 0.72, 340)
  const gap = flagPx * 1.1 // space between adjacent tokens

  // Measure every token, then greedily pack them into centred rows that fit the width —
  // the CPU-feature-list wrap.
  ctx.save()
  ctx.font = monoFont(flagPx)
  const toks: Tok[] = spec.flags.map((flag) => ({ flag, w: ctx.measureText(flag.text).width }))
  ctx.restore()

  const rows: Row[] = []
  let cur: Tok[] = []
  let curW = 0
  for (const t of toks) {
    const add = cur.length === 0 ? t.w : gap + t.w
    if (cur.length > 0 && curW + add > contentW) {
      rows.push({ toks: cur, w: curW })
      cur = [t]
      curW = t.w
    } else {
      cur.push(t)
      curW += add
    }
  }
  if (cur.length > 0) {
    rows.push({ toks: cur, w: curW })
  }

  // Vertical budget: the heading, the TOKEN INFLATION line, a gap, then the flag rows.
  // Shrink to fit the band so it never spills into the counts (the flags stay narrower
  // than contentW when scaled, so the row packing above still holds).
  const headBlock = headPx * 1.3
  const statBlock = statPx * 1.5
  const headGap = flagPx * 0.7
  const rowH = flagPx * 1.35
  const contentH = headBlock + statBlock + headGap + rows.length * rowH
  const f = Math.min(1, bandH / contentH)

  const hPx = headPx * f
  const sPx = statPx * f
  const fPx = flagPx * f
  const hBlock = headBlock * f
  const sBlock = statBlock * f
  const hGap = headGap * f
  const rH = rowH * f
  const tGap = gap * f
  const totalH = hBlock + sBlock + hGap + rows.length * rH

  const presence = clamp01(age / SPEC_STRIKE_MS) * fade

  ctx.save()
  ctx.globalAlpha = presence

  let y = bandMid - totalH / 2
  holoCentered(ctx, 'RULES', cx, y + hBlock / 2, hPx, HEAD, now, 800)
  y += hBlock

  // The token inflation on its own labelled line: "TOKEN INFLATION" (dim) + value (amber).
  drawStat(ctx, cx, y + sBlock / 2, sPx, spec.inflation, now)
  y += sBlock + hGap

  let maxRowW = ctx.measureText('TOKEN INFLATION').width // measured at the stat font just set
  for (const row of rows) {
    const rowW = row.w * f
    maxRowW = Math.max(maxRowW, rowW)
    let x = cx - rowW / 2
    const rowCY = y + rH / 2
    for (const t of row.toks) {
      const tw = t.w * f
      holoCentered(ctx, t.flag.text, x + tw / 2, rowCY, fPx, styleFor(t.flag.kind), now)
      x += tw + tGap
    }
    y += rH
  }

  ctx.restore()

  const top = bandMid - totalH / 2
  return [{ left: cx - maxRowW / 2, right: cx + maxRowW / 2, top, bottom: top + totalH }]
}

// The token-inflation line: a dim "TOKEN INFLATION" label with the amber value beside it,
// the pair centred on `cx`.
function drawStat(ctx: CanvasRenderingContext2D, cx: number, y: number, px: number, value: string, now: number): void {
  const label = 'TOKEN INFLATION'
  const gap = px * 0.6
  ctx.font = monoFont(px)
  ctx.textBaseline = 'middle'
  const labelW = ctx.measureText(label).width
  const valueW = ctx.measureText(value).width
  const startX = cx - (labelW + gap + valueW) / 2
  ctx.textAlign = 'left'
  drawHoloText(ctx, label, startX, y, px, DIM, now)
  drawHoloText(ctx, value, startX + labelW + gap, y, px, AMBER, now)
}

// Draw centred holo text (sets font/alignment, then blits the cached glow sprite).
function holoCentered(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, px: number, style: HoloTextStyle, now: number, weight = 700): void {
  ctx.font = monoFont(px, weight)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  drawHoloText(ctx, text, cx, y, px, style, now)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
