// The table nexus's OPENING projection: while the game waits for the player's first tap (which
// also unlocks audio) it casts the game's NAME — ROBOT / BLACKJACK / ATTACK — high on the felt
// with a "TAP TO START" invitation projected below it. Same projected-light treatment as the
// combo / spec / score readouts: it flickers in, breathes a gentle pulse, and returns its boxes
// so the holo lens fans rays onto them. The title is black with a red shadow (the game's look);
// the tap line keeps the cyan holo. Render-only, like combo-projection: the game decides WHEN to
// show it, this just paints it.

import { drawHoloText, holoFlicker, playerCardBox, type HoloTextStyle } from './cards'
import { nexusHoloLight, type HoloRayTarget } from './nexus'
import { feltTopEdgeY, type Layout } from './scene'
import { boldSystemFont, measureTitleWidest, titleFont, TITLE_LINES, TITLE_RED } from './title-font'

// How long the projection takes to flicker + scale fully in.
const TAP_STRIKE_MS = 520

const CYAN: HoloTextStyle = { glow: 'rgba(130, 240, 236, 0.95)', bloom: 'rgba(150, 246, 242, 0.55)', core: 'rgba(214, 253, 251, 0.9)' }

// Draw the opening projection — the ROBOT / BLACKJACK / ATTACK title near the top of the felt, the
// player's best score under it, and a "TAP TO START" line below that — and RETURN their boxes
// (ray-targets). `age` = ms since it appeared (strike-in), `fade` winds it out on the tap (1 → 0),
// `now` positions the shared holo flicker + the breathing pulse.
export function drawTapToStart(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  personalBest: number,
  age: number,
  fade: number,
  now: number,
  showPrompt = true,
): HoloRayTarget[] {
  const cx = l.width / 2
  const scale = Math.min(l.width, l.height)

  const tapPx = clamp(scale * 0.046, 24, 52)

  // Phones have little vertical room, and the wide pixel font makes a full-width title dominate
  // the felt there — so on small screens hold the title to a smaller share of the width (and a
  // lower floor), which the fit-shrink below turns into a smaller font. Desktop keeps it big.
  const compact = l.width < 560

  // Title size, shrunk to fit the widest word (BLACKJACK) inside the felt if need be. Measured in
  // the same face it will draw in (the pixel font is far wider per glyph) so the fit is honest.
  let titlePx = clamp(scale * 0.068, compact ? 26 : 34, 82)
  ctx.font = titleFont(titlePx)
  let widest = measureTitleWidest(ctx)
  const maxW = l.width * (compact ? 0.7 : 0.86)
  if (widest > maxW) {
    titlePx = Math.max(24, (titlePx * maxW) / widest)
    ctx.font = titleFont(titlePx)
    widest = measureTitleWidest(ctx)
  }
  const titleLineH = titlePx * 1.02

  // drawHoloRays fans each ray's base out 25% PAST its target box on EACH side (its `pad`), so
  // the lit fan spans 1.5× the box width. For the wide title that overshoot was a bright wedge
  // reaching well past the letters toward the nexus. So the ray box is sized to 1/1.5 of the
  // reach we want — after the pad the fan lands just past the letters (titleFanReach), not far
  // to their right. titleFanReach is also the true right edge we clamp against the lens.
  const titleFanReach = widest / 2 + titlePx * 0.2
  const titleRayHalfW = titleFanReach / 1.5

  // Horizontal centre of the title block. The nexus casts its rays from its lens on the RIGHT, so
  // nudging the title LEFT of felt-centre swings that beam more counter-clockwise (more toward
  // horizontal) — the look asked for. Clamp so the block stays on the felt (left floor) and its
  // fan still clears the lens (maxCx) on narrow screens where the two would otherwise crowd.
  const nexusX = nexusHoloLight(l, now).x
  const maxCx = nexusX - titlePx * 0.7 - titleFanReach
  const titleCenterX = Math.max(titleFanReach + titlePx * 0.15, Math.min(cx - scale * 0.12, maxCx))
  const titleLeft = titleCenterX - widest / 2 // shared left edge for the left-aligned lines

  // Anchor the title near the TOP of the felt: sit its first line just below the felt's curved
  // top edge (measured at whichever end sits furthest from centre, where the arch dips lowest,
  // so no letter spills over the rail). A small margin keeps it off the wood.
  const feltTop = Math.max(feltTopEdgeY(l, titleLeft), feltTopEdgeY(l, titleLeft + widest))
  const titleTop = feltTop + titlePx * 0.3
  const firstCenter = titleTop + titlePx * 0.5
  const lineCenter = (i: number): number => firstCenter + i * titleLineH
  const titleBottom = lineCenter(TITLE_LINES.length - 1) + titlePx * 0.5

  // Best line: the player's own high score, projected in the gap between the wordmark and whatever
  // stands below it (the tap prompt, or the Continue / New game buttons). Skipped for first-timers
  // (best 0). It hangs off the TITLE, so it holds the same spot whether the prompt or the menu is
  // below it. CrazyGames leaderboards are submit-only, so this is our local best — see game/leaderboard.
  const bestPx = clamp(scale * 0.034, 15, 30)
  const bestY = titleBottom + titlePx * 0.34 + bestPx * 0.5
  const bestBottom = bestY + bestPx * 0.5

  // Tap line: a gap below the block above it, but never allowed onto the player's card-box outline —
  // clamp it to stay a margin ABOVE that outline (this is the overlap the player saw). On a felt too
  // short to hold both, that clamp would pull the prompt up onto the best line, so the best line is
  // dropped instead of overlapped (on the menu screen there is no prompt, so the card box is what it
  // must clear).
  const cardTop = playerCardBox(l).y
  const tapYMax = cardTop - tapPx * 0.85 - tapPx * 0.35
  const tapWithBest = Math.min(bestBottom + titlePx * 0.55 + tapPx * 0.5, tapYMax)
  const showBest = personalBest > 0 && bestBottom <= (showPrompt ? tapWithBest - tapPx * 0.85 : cardTop - bestPx * 0.5)
  const tapY = showBest ? tapWithBest : Math.min(titleBottom + titlePx * 0.55 + tapPx * 0.5, tapYMax)

  const strikeT = clamp01(age / TAP_STRIKE_MS)
  // A gentle breathing pulse once struck in — never fully off, so it reads as a live invitation.
  const breathe = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.0042))
  const presence = strikeT * clamp01(fade) * breathe
  // Scale-in pop (2×→1×), then it holds at 1× while breathing.
  const popScale = 1 + (1 - strikeT) * (1 - strikeT)
  const pivotY = (titleTop + tapY + tapPx * 0.85) / 2

  ctx.save()
  // Scale the whole group about its centre so the pop grows/shrinks in place.
  ctx.translate(titleCenterX, pivotY)
  ctx.scale(popScale, popScale)
  ctx.translate(-titleCenterX, -pivotY)
  ctx.textBaseline = 'middle'

  // --- Title: LEFT-aligned black letters with a projected red shadow, sharing the holo flicker. ---
  ctx.textAlign = 'left'
  ctx.font = titleFont(titlePx)
  ctx.globalAlpha = presence * holoFlicker(now)
  for (let i = 0; i < TITLE_LINES.length; i++) {
    const y = lineCenter(i)
    // Red shadow pass: black fill casting a blurred, slightly offset red glow.
    ctx.fillStyle = '#000000'
    ctx.shadowColor = TITLE_RED
    ctx.shadowBlur = titlePx * 0.34
    ctx.shadowOffsetX = titlePx * 0.05
    ctx.shadowOffsetY = titlePx * 0.08
    ctx.fillText(TITLE_LINES[i], titleLeft, y)
    // Crisp black pass on top so the letters stay solidly black over their own red halo.
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.fillText(TITLE_LINES[i], titleLeft, y)
  }

  // --- Best line: cyan holo, centred under the title block, locale-grouped like every other score. ---
  let bestW = 0
  if (showBest) {
    ctx.textAlign = 'center'
    ctx.globalAlpha = presence
    ctx.font = boldSystemFont(bestPx)
    const best = `BEST ${personalBest.toLocaleString()}`
    bestW = ctx.measureText(best).width
    drawHoloText(ctx, best, titleCenterX, bestY, bestPx, CYAN, now)
  }

  // --- Tap line: cyan holo, centred under the title block (drawHoloText applies its own
  // flicker on top of the alpha). Suppressed when the Continue / New game menu is showing — the
  // HTML buttons stand in for the prompt, but the wordmark above still projects. ---
  let tapW = 0
  if (showPrompt) {
    ctx.textAlign = 'center'
    ctx.globalAlpha = presence
    ctx.font = boldSystemFont(tapPx)
    tapW = ctx.measureText('TAP TO START').width
    drawHoloText(ctx, 'TAP TO START', titleCenterX, tapY, tapPx, CYAN, now)
  }
  ctx.restore()

  // Ray-targets: the title block always, plus the best line and the tap line (each centred under
  // it) when shown, each sized to 1/1.5 of its fan reach so the 25% pad in drawHoloRays lands the
  // lit fan just past the letters, not to the side.
  const targets: HoloRayTarget[] = [
    { left: titleCenterX - titleRayHalfW, right: titleCenterX + titleRayHalfW, top: titleTop, bottom: titleBottom },
  ]
  if (showBest) {
    const bestRayHalfW = (bestW / 2 + bestPx * 0.2) / 1.5
    targets.push({ left: titleCenterX - bestRayHalfW, right: titleCenterX + bestRayHalfW, top: bestY - bestPx * 0.85, bottom: bestY + bestPx * 0.85 })
  }
  if (showPrompt) {
    const tapRayHalfW = (tapW / 2 + tapPx * 0.2) / 1.5
    targets.push({ left: titleCenterX - tapRayHalfW, right: titleCenterX + tapRayHalfW, top: tapY - tapPx * 0.85, bottom: tapY + tapPx * 0.85 })
  }
  return targets
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
