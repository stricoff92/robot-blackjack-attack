// TEMP visual harness for the 2-lens table nexus — not shipped. Draws the device in a
// few charge states so the two lenses (top utility light + bottom holo) + their colours
// can be eyeballed, plus faithfully layered Analyze panels (fx / cards / overlay stacked
// like the real game) in BOTH landscape and portrait. The holo projector is always on:
// its glowing lens cycles, and it casts 5-ray white fans onto each "count" (here: the
// analysis rows + a couple of fake card/chip count boxes). No darkness mask. Animated.
import { drawAnalysis } from './render/cards'
import { drawDealerEyeGlow } from './render/dealer'
import { drawHoloRays, drawStrikeFx, type HoloRayTarget } from './render/nexus'
import { computeLayout } from './render/scene'

const stubView = { beam: () => null, muzzle: () => null, impactSpark: () => null }

type Charge = Parameters<typeof drawStrikeFx>[3]

// One colour lights the utility (top) lens at a time — the effects are sequenced in the
// real game, so each state here shows a single one.
const states: Array<{ label: string; charge: Charge }> = [
  { label: 'idle (utility dark + shiny glint, holo off)', charge: { red: 0, heal: 0, yellow: 0, holo: 0, chargeUp: null, healBeam: null } },
  { label: 'holo projecting (glow + cycle)', charge: { red: 0, heal: 0, yellow: 0, holo: 1, chargeUp: null, healBeam: null } },
  { label: 'utility: token pulse (yellow)', charge: { red: 0, heal: 0, yellow: 0.9, holo: 1, chargeUp: null, healBeam: null } },
  { label: 'utility: laser charge (red)', charge: { red: 0.6, heal: 0, yellow: 0, holo: 1, chargeUp: null, healBeam: null } },
  { label: 'utility: heal (green beam)', charge: { red: 0, heal: 0.85, yellow: 0, holo: 1, chargeUp: null, healBeam: { travel: 1, alpha: 1 } } },
]

const root = document.getElementById('root')!

function caption(text: string): HTMLDivElement {
  const cap = document.createElement('div')
  cap.textContent = text
  cap.style.cssText = 'color:#cfe;font:14px monospace;margin:6px 0'
  return cap
}

const nexusPanels = states.map((s) => {
  const wrap = document.createElement('div')
  const canvas = document.createElement('canvas')
  canvas.width = 520
  canvas.height = 460
  canvas.style.cssText = 'background:#0b3d2e;border:1px solid #333'
  wrap.appendChild(caption(s.label))
  wrap.appendChild(canvas)
  root.appendChild(wrap)
  return { ctx: canvas.getContext('2d')!, layout: computeLayout(canvas.width, canvas.height), charge: s.charge }
})

// A layered Analyze panel: three stacked canvases (fx under, cards, overlay on top)
// over a felt-coloured div — the same order the game composites them in.
const readout = { bustChance: 0.42, dealerWinChance: 0.28 }

function buildAnalysisPanel(w: number, h: number, label: string): (now: number) => void {
  const wrap = document.createElement('div')
  wrap.style.gridColumn = '1 / -1'
  wrap.appendChild(caption(label))
  const stack = document.createElement('div')
  stack.style.cssText = `position:relative;width:${w}px;height:${h}px;background:#0b3d2e;border:1px solid #333`
  const mkLayer = (): CanvasRenderingContext2D => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.style.cssText = 'position:absolute;inset:0'
    stack.appendChild(c)
    return c.getContext('2d')!
  }
  const fxCtx = mkLayer()
  const cardsCtx = mkLayer()
  const overlayCtx = mkLayer()
  wrap.appendChild(stack)
  root.appendChild(wrap)
  const layout = computeLayout(w, h)
  // Stand-in count boxes (no real cards/chips in the harness): a card total up top and
  // a bankroll chip count bottom-right.
  const fakeCounts: HoloRayTarget[] = [
    { left: w * 0.46, right: w * 0.54, top: h * 0.28, bottom: h * 0.34 },
    { left: w * 0.78, right: w * 0.9, top: h * 0.82, bottom: h * 0.88 },
  ]
  return (now: number) => {
    drawStrikeFx(fxCtx, layout, stubView, { red: 0, heal: 0, yellow: 0, holo: 1, chargeUp: null, healBeam: null }, now)
    cardsCtx.clearRect(0, 0, w, h)
    const analysisBoxes = drawAnalysis(cardsCtx, layout, readout, now, 1, now)
    overlayCtx.clearRect(0, 0, w, h)
    drawDealerEyeGlow(overlayCtx, layout, 1)
    let fan = 0
    const targets = [...fakeCounts, ...analysisBoxes]
    for (const t of targets) {
      drawHoloRays(overlayCtx, layout, t, 5, now, fan++ * 1000)
    }
  }
}

const analysisPanels = [
  buildAnalysisPanel(700, 520, 'Analyze — landscape (holo always on, 5-ray fans per count)'),
  buildAnalysisPanel(420, 760, 'Analyze — portrait / mobile (nexus pushed right, no darkness)'),
]

function frame(now: number): void {
  for (const p of nexusPanels) {
    drawStrikeFx(p.ctx, p.layout, stubView, p.charge, now)
  }
  for (const draw of analysisPanels) {
    draw(now)
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
