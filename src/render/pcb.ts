// A printed-circuit-board card-back pattern, generated deterministically from a
// seed so every back of a given deck is identical. One input — `tech` (0 = crude,
// 1 = cutting-edge) — scales the whole look: low-tech boards have fat traces, big
// sparse components and few greebles; high-tech boards have fine traces, small
// dense components and lots of vias/silkscreen detail. Dealer progression raises
// `tech`, so later dealers deal visibly more advanced hardware.
//
// The board is drawn with 180° rotational symmetry: features are generated in the
// top half and rendered twice — once straight, once point-reflected through the
// centre — so the back looks composed and reads the same either way up, like a real
// playing card, while still looking like a plausibly-routed board.

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface PcbOptions {
  tech: number // 0..1, how advanced the board looks
  seed: number // deterministic layout seed
}

interface Pt {
  x: number
  y: number
}
interface Trace {
  pts: Pt[]
  width: number
}
interface Via {
  x: number
  y: number
  r: number
}
type CompKind = 'qfp' | 'soic' | 'disc' | 'conn'
interface Comp {
  kind: CompKind
  x: number
  y: number
  w: number
  h: number
  horiz: boolean // discretes/connectors: pad row orientation
}
interface Txt {
  x: number
  y: number
  s: string
  size: number
}
interface Model {
  traces: Trace[]
  vias: Via[]
  comps: Comp[]
  texts: Txt[]
}

interface Params {
  t: number
  pitch: number
  trace: number
  viaR: number
  comp: number
  walkLen: number
  nDisc: number
  nSoic: number
  nVia: number
  nWalk: number
  busLines: number
  silkText: boolean
}

const TWO_PI = Math.PI * 2

// The board's ink. Copper traces read as a faint warm light on the coloured panel;
// pads/vias are gold; silkscreen is white; component bodies are near-black chips.
// All are translucent so they tint over any dealer's panel colour.
const STYLE = {
  copper: 'rgba(238, 227, 200, 0.26)',
  pad: 'rgba(247, 209, 130, 0.85)',
  padRing: 'rgba(120, 90, 45, 0.8)',
  hole: 'rgba(18, 20, 24, 0.62)',
  body: 'rgba(10, 12, 16, 0.5)',
  silk: 'rgba(255, 255, 255, 0.34)',
  pour: 'rgba(255, 255, 255, 0.05)',
}

// Draw a full PCB pattern into the rect (bx, by, bw, bh). Caller clips to the panel.
export function drawPcb(ctx: Ctx2D, bx: number, by: number, bw: number, bh: number, opts: PcbOptions): void {
  const P = params(opts.tech, bw, bh)
  const rng = mulberry32(opts.seed >>> 0)

  drawPour(ctx, bx, by, bw, bh, P) // faint copper-pour hatch behind everything

  const model = generate(rng, bx, by, bw, bh, P)
  renderModel(ctx, model, P) // top-half features, straight

  const cx = bx + bw / 2
  const cy = by + bh / 2
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(Math.PI)
  ctx.translate(-cx, -cy)
  renderModel(ctx, model, P) // ...and point-reflected to fill the bottom half
  ctx.restore()

  drawMountHoles(ctx, bx, by, bw, bh, P) // corner mounting holes (already symmetric)
}

function params(tech: number, bw: number, bh: number): Params {
  const t = clamp(tech, 0, 1)
  const min = Math.min(bw, bh)
  return {
    t,
    pitch: min * lerp(0.15, 0.066, t),
    trace: min * lerp(0.024, 0.01, t),
    viaR: min * lerp(0.032, 0.017, t),
    comp: lerp(1.3, 0.82, t),
    walkLen: Math.round(lerp(4, 8, t)),
    nDisc: Math.round(lerp(3, 9, t)),
    nSoic: Math.round(lerp(1, 3, t)),
    nVia: Math.round(lerp(7, 24, t)),
    nWalk: Math.round(lerp(3, 9, t)),
    busLines: Math.round(lerp(3, 6, t)),
    silkText: t > 0.45,
  }
}

// Build the model in the TOP HALF of the panel; the caller renders it twice
// (straight + rotated 180°) so the bottom half mirrors it.
function generate(rng: () => number, bx: number, by: number, bw: number, bh: number, P: Params): Model {
  const inset = P.pitch * 0.5
  const region = { x: bx + inset, y: by + inset, w: bw - inset * 2, h: bh / 2 - inset * 0.5 }
  const snap = (v: number, origin: number) => origin + Math.round((v - origin) / P.pitch) * P.pitch

  const comps: Comp[] = []
  const rects: { x: number; y: number; w: number; h: number }[] = []
  const margin = P.pitch * 0.42

  const place = (w: number, h: number): Comp | null => {
    for (let i = 0; i < 60; i++) {
      const x = snap(region.x + rng() * (region.w - w), bx)
      const y = snap(region.y + rng() * (region.h - h), by)
      if (x < region.x || y < region.y || x + w > region.x + region.w || y + h > region.y + region.h) {
        continue
      }
      const r = { x, y, w, h }
      if (!overlaps(rects, r, margin)) {
        rects.push(r)
        return { kind: 'qfp', x, y, w, h, horiz: true }
      }
    }
    return null
  }

  // A big processor (QFP) anchors the board.
  const qfpSize = P.pitch * 2.7 * P.comp
  const qfp = place(qfpSize, qfpSize)
  if (qfp) {
    qfp.kind = 'qfp'
    comps.push(qfp)
  }
  // A connector (row of pads) near an edge.
  const conn = place(P.pitch * 4 * P.comp, P.pitch * 1.1 * P.comp)
  if (conn) {
    conn.kind = 'conn'
    conn.horiz = true
    comps.push(conn)
  }
  // Small logic chips (SOIC).
  for (let i = 0; i < P.nSoic; i++) {
    const horiz = rng() < 0.5
    const long = P.pitch * 2.4 * P.comp
    const short = P.pitch * 1.2 * P.comp
    const c = place(horiz ? long : short, horiz ? short : long)
    if (c) {
      c.kind = 'soic'
      c.horiz = horiz
      comps.push(c)
    }
  }
  // Discretes (resistors / caps): a small body between two pads.
  for (let i = 0; i < P.nDisc; i++) {
    const horiz = rng() < 0.5
    const long = P.pitch * 1.5 * P.comp
    const short = P.pitch * 0.55 * P.comp
    const c = place(horiz ? long : short, horiz ? short : long)
    if (c) {
      c.kind = 'disc'
      c.horiz = horiz
      comps.push(c)
    }
  }

  // Vias on grid nodes clear of components.
  const vias: Via[] = []
  for (let i = 0; i < P.nVia; i++) {
    const x = snap(region.x + rng() * region.w, bx)
    const y = snap(region.y + rng() * region.h, by)
    if (!insideAny(rects, x, y, P.pitch * 0.3)) {
      vias.push({ x, y, r: P.viaR })
    }
  }

  const traces: Trace[] = []
  // A parallel bus running across the region — the board's spine.
  const busY = snap(region.y + region.h * 0.55, by)
  for (let i = 0; i < P.busLines; i++) {
    const yy = busY + (i - (P.busLines - 1) / 2) * P.trace * 2.4
    traces.push({ pts: [{ x: region.x, y: yy }, { x: region.x + region.w, y: yy }], width: P.trace })
  }
  // Routed traces walking the grid from vias, ending in fresh vias — the "routing".
  const seeds = vias.length ? vias : [{ x: snap(region.x + region.w / 2, bx), y: snap(region.y + region.h / 2, by), r: P.viaR }]
  for (let i = 0; i < P.nWalk; i++) {
    const start = seeds[Math.floor(rng() * seeds.length)]
    const pts = walk(rng, start, region, P)
    if (pts.length > 1) {
      traces.push({ pts, width: P.trace })
      const end = pts[pts.length - 1]
      if (!insideAny(rects, end.x, end.y, P.pitch * 0.3)) {
        vias.push({ x: end.x, y: end.y, r: P.viaR })
      }
    }
  }

  // Silkscreen reference designators next to components (high-tech only — a greeble).
  const texts: Txt[] = []
  if (P.silkText) {
    const tag: Record<CompKind, string> = { qfp: 'U', soic: 'U', disc: 'R', conn: 'J' }
    const counts: Record<string, number> = {}
    for (const c of comps) {
      const prefix = tag[c.kind]
      counts[prefix] = (counts[prefix] ?? 0) + 1
      texts.push({ x: c.x, y: c.y - P.pitch * 0.28, s: `${prefix}${counts[prefix]}`, size: P.pitch * 0.5 })
    }
  }

  return { traces, vias, comps, texts }
}

// A grid-walking trace: mostly straight, with occasional 45° turns — the organic
// look of hand-routed copper. Stops at the region edge.
const DIR_RING: [number, number][] = [
  [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1],
]
function walk(rng: () => number, start: Pt, region: { x: number; y: number; w: number; h: number }, P: Params): Pt[] {
  let dir = Math.floor(rng() * 8)
  const pts: Pt[] = [{ x: start.x, y: start.y }]
  let cur = { x: start.x, y: start.y }
  const steps = 3 + Math.floor(rng() * P.walkLen)
  for (let i = 0; i < steps; i++) {
    if (rng() < 0.32) {
      dir = (dir + (rng() < 0.5 ? 1 : 7)) % 8 // ±45°
    }
    const [dx, dy] = DIR_RING[dir]
    const nx = cur.x + dx * P.pitch
    const ny = cur.y + dy * P.pitch
    if (nx < region.x || nx > region.x + region.w || ny < region.y || ny > region.y + region.h) {
      break
    }
    cur = { x: nx, y: ny }
    pts.push(cur)
  }
  return pts
}

function renderModel(ctx: Ctx2D, m: Model, P: Params): void {
  for (const tr of m.traces) {
    drawTrace(ctx, tr)
  }
  for (const c of m.comps) {
    drawComp(ctx, c, P)
  }
  for (const v of m.vias) {
    drawVia(ctx, v)
  }
  if (m.texts.length) {
    ctx.fillStyle = STYLE.silk
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    for (const t of m.texts) {
      ctx.font = `${t.size}px ui-monospace, monospace`
      ctx.fillText(t.s, t.x, t.y)
    }
  }
}

function drawTrace(ctx: Ctx2D, tr: Trace): void {
  ctx.strokeStyle = STYLE.copper
  ctx.lineWidth = tr.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  tr.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.stroke()
}

function drawVia(ctx: Ctx2D, v: Via): void {
  ctx.fillStyle = STYLE.pad
  ctx.beginPath()
  ctx.arc(v.x, v.y, v.r, 0, TWO_PI)
  ctx.fill()
  ctx.fillStyle = STYLE.hole
  ctx.beginPath()
  ctx.arc(v.x, v.y, v.r * 0.42, 0, TWO_PI)
  ctx.fill()
}

function drawComp(ctx: Ctx2D, c: Comp, P: Params): void {
  switch (c.kind) {
    case 'qfp':
      return drawQfp(ctx, c, P)
    case 'soic':
      return drawSoic(ctx, c, P)
    case 'disc':
      return drawDisc(ctx, c)
    case 'conn':
      return drawConn(ctx, c, P)
  }
}

// A gull-wing pad running perpendicular to `edge`, centred at (x, y).
function pad(ctx: Ctx2D, x: number, y: number, along: number, across: number, horiz: boolean): void {
  ctx.fillStyle = STYLE.pad
  const w = horiz ? across : along
  const h = horiz ? along : across
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, Math.min(w, h) * 0.3)
  ctx.fill()
}

function pinCount(len: number, P: Params): number {
  return Math.max(2, Math.round(len / (P.pitch * 0.55)))
}

function drawQfp(ctx: Ctx2D, c: Comp, P: Params): void {
  const padLen = P.viaR * 1.5
  const padW = P.trace * 1.4
  const n = pinCount(c.w, P)
  for (let i = 0; i < n; i++) {
    const fx = c.x + c.w * ((i + 0.5) / n)
    const fy = c.y + c.h * ((i + 0.5) / n)
    pad(ctx, fx, c.y - padLen * 0.2, padLen, padW, false) // top
    pad(ctx, fx, c.y + c.h + padLen * 0.2, padLen, padW, false) // bottom
    pad(ctx, c.x - padLen * 0.2, fy, padLen, padW, true) // left
    pad(ctx, c.x + c.w + padLen * 0.2, fy, padLen, padW, true) // right
  }
  chipBody(ctx, c.x, c.y, c.w, c.h, P)
  // pin-1 dot
  ctx.fillStyle = STYLE.silk
  ctx.beginPath()
  ctx.arc(c.x + c.w * 0.2, c.y + c.h * 0.2, Math.max(1, padW * 0.7), 0, TWO_PI)
  ctx.fill()
}

function drawSoic(ctx: Ctx2D, c: Comp, P: Params): void {
  const padLen = P.viaR * 1.4
  const padW = P.trace * 1.3
  const n = pinCount(c.horiz ? c.w : c.h, P)
  for (let i = 0; i < n; i++) {
    if (c.horiz) {
      const fx = c.x + c.w * ((i + 0.5) / n)
      pad(ctx, fx, c.y - padLen * 0.15, padLen, padW, false)
      pad(ctx, fx, c.y + c.h + padLen * 0.15, padLen, padW, false)
    } else {
      const fy = c.y + c.h * ((i + 0.5) / n)
      pad(ctx, c.x - padLen * 0.15, fy, padLen, padW, true)
      pad(ctx, c.x + c.w + padLen * 0.15, fy, padLen, padW, true)
    }
  }
  chipBody(ctx, c.x, c.y, c.w, c.h, P)
}

function drawDisc(ctx: Ctx2D, c: Comp): void {
  const padSize = Math.min(c.w, c.h) * 1.2
  if (c.horiz) {
    pad(ctx, c.x, c.y + c.h / 2, padSize, padSize, false)
    pad(ctx, c.x + c.w, c.y + c.h / 2, padSize, padSize, false)
  } else {
    pad(ctx, c.x + c.w / 2, c.y, padSize, padSize, true)
    pad(ctx, c.x + c.w / 2, c.y + c.h, padSize, padSize, true)
  }
  ctx.fillStyle = STYLE.body
  ctx.beginPath()
  const bx = c.horiz ? c.x + c.w * 0.22 : c.x
  const by = c.horiz ? c.y : c.y + c.h * 0.22
  const bw = c.horiz ? c.w * 0.56 : c.w
  const bh = c.horiz ? c.h : c.h * 0.56
  ctx.roundRect(bx, by, bw, bh, Math.min(bw, bh) * 0.25)
  ctx.fill()
  ctx.strokeStyle = STYLE.silk
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawConn(ctx: Ctx2D, c: Comp, P: Params): void {
  const n = pinCount(c.w, P)
  for (let i = 0; i < n; i++) {
    const fx = c.x + c.w * ((i + 0.5) / n)
    pad(ctx, fx, c.y + c.h / 2, c.h * 0.6, P.trace * 1.6, false)
  }
  ctx.strokeStyle = STYLE.silk
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(c.x, c.y, c.w, c.h, Math.min(c.w, c.h) * 0.14)
  ctx.stroke()
}

// A dark IC body with a silkscreen outline.
function chipBody(ctx: Ctx2D, x: number, y: number, w: number, h: number, P: Params): void {
  ctx.fillStyle = STYLE.body
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.12)
  ctx.fill()
  ctx.strokeStyle = STYLE.silk
  ctx.lineWidth = Math.max(1, P.trace * 0.7)
  ctx.stroke()
}

// A faint 45° copper-pour hatch filling the panel behind the board.
function drawPour(ctx: Ctx2D, bx: number, by: number, bw: number, bh: number, P: Params): void {
  ctx.save()
  ctx.strokeStyle = STYLE.pour
  ctx.lineWidth = 1
  ctx.beginPath()
  const step = P.pitch * 0.5
  for (let i = -bh; i < bw + bh; i += step) {
    ctx.moveTo(bx + i, by)
    ctx.lineTo(bx + i + bh, by + bh)
  }
  ctx.stroke()
  ctx.restore()
}

// Four corner mounting holes — a big drill with a gold annular ring.
function drawMountHoles(ctx: Ctx2D, bx: number, by: number, bw: number, bh: number, P: Params): void {
  const off = P.pitch * 0.85
  const r = P.viaR * 1.9
  const corners: Pt[] = [
    { x: bx + off, y: by + off },
    { x: bx + bw - off, y: by + off },
    { x: bx + off, y: by + bh - off },
    { x: bx + bw - off, y: by + bh - off },
  ]
  for (const c of corners) {
    ctx.fillStyle = STYLE.pad
    ctx.beginPath()
    ctx.arc(c.x, c.y, r, 0, TWO_PI)
    ctx.fill()
    ctx.fillStyle = STYLE.hole
    ctx.beginPath()
    ctx.arc(c.x, c.y, r * 0.55, 0, TWO_PI)
    ctx.fill()
    ctx.strokeStyle = STYLE.silk
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(c.x, c.y, r * 1.3, 0, TWO_PI)
    ctx.stroke()
  }
}

function overlaps(rects: { x: number; y: number; w: number; h: number }[], r: { x: number; y: number; w: number; h: number }, m: number): boolean {
  return rects.some((o) => !(r.x > o.x + o.w + m || r.x + r.w < o.x - m || r.y > o.y + o.h + m || r.y + r.h < o.y - m))
}

function insideAny(rects: { x: number; y: number; w: number; h: number }[], x: number, y: number, m: number): boolean {
  return rects.some((o) => x > o.x - m && x < o.x + o.w + m && y > o.y - m && y < o.y + o.h + m)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

// Small, fast, well-distributed seeded PRNG.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
