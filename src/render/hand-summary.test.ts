import { describe, expect, it } from 'vitest'

import { drawHandSummary, type HandSummaryView } from './hand-summary'
import { computeLayout } from './scene'

// Records the paint state at each fill()/stroke() so we can assert HOW opacity is applied. The bug this
// guards: on iOS/WebKit a shadowed fill IGNORES ctx.globalAlpha, so the fade must live in each colour's
// own alpha channel — never on globalAlpha — or the glowing win/loss discs snap instead of fading.
interface PaintEvent {
  op: 'fill' | 'stroke'
  fillStyle: string
  strokeStyle: string
  shadowColor: string
  shadowBlur: number
  globalAlpha: number
}

function mockCtx(): { ctx: CanvasRenderingContext2D; events: PaintEvent[] } {
  const events: PaintEvent[] = []
  const ctx = {
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    shadowColor: '',
    shadowBlur: 0,
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    snapshot(op: 'fill' | 'stroke') {
      events.push({
        op,
        fillStyle: this.fillStyle as string,
        strokeStyle: this.strokeStyle as string,
        shadowColor: this.shadowColor as string,
        shadowBlur: this.shadowBlur as number,
        globalAlpha: this.globalAlpha as number,
      })
    },
    fill() {
      this.snapshot('fill')
    },
    stroke() {
      this.snapshot('stroke')
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, events }
}

function view(over: Partial<HandSummaryView> = {}): HandSummaryView {
  // revealFrom == slots.length draws every slot at the steady board fade (no per-slot pop-in), which is
  // exactly the state that fades in/out — the one that used to snap.
  return { slots: ['win', 'loss'], revealFrom: 2, cashInElapsed: 0, fade: 1, ...over }
}

// Parse the trailing alpha out of an "rgba(r, g, b, a)" string.
function alphaOf(color: string): number {
  const m = /rgba\([^)]*,\s*([0-9.]+)\s*\)$/.exec(color)
  return m ? parseFloat(m[1]) : NaN
}

describe('drawHandSummary opacity', () => {
  const layout = computeLayout(1024, 768)
  const bounds = { left: 0, right: layout.width }

  it('carries the disc fade in the colour alpha, not globalAlpha (the iOS shadow bug)', () => {
    const { ctx, events } = mockCtx()
    drawHandSummary(ctx, layout, view({ fade: 0.5 }), bounds)

    const fills = events.filter((e) => e.op === 'fill')
    expect(fills.length).toBeGreaterThanOrEqual(2) // the win + loss discs

    for (const e of fills) {
      // The disc is a shadowed fill...
      expect(e.shadowBlur).toBeGreaterThan(0)
      // ...so its opacity MUST be in the fill + shadow colour alpha (≈ the board fade), and globalAlpha
      // must stay 1 — otherwise the shadowed fill would render fully opaque on WebKit.
      expect(e.globalAlpha).toBe(1)
      expect(alphaOf(e.fillStyle)).toBeCloseTo(0.5, 5)
      expect(alphaOf(e.shadowColor)).toBeCloseTo(0.5, 5)
    }
  })

  it('uses the win/loss rgb with the faded alpha', () => {
    const { ctx, events } = mockCtx()
    drawHandSummary(ctx, layout, view({ slots: ['win', 'loss'], fade: 0.25 }), bounds)
    const fills = events.filter((e) => e.op === 'fill').map((e) => e.fillStyle)
    expect(fills).toContain('rgba(73, 178, 106, 0.25)') // WIN
    expect(fills).toContain('rgba(216, 72, 75, 0.25)') // LOSS
  })

  it('never sets a fractional globalAlpha anywhere (empty rings included)', () => {
    const { ctx, events } = mockCtx()
    drawHandSummary(ctx, layout, view({ slots: ['win', 'empty', 'loss'], revealFrom: 3, fade: 0.4 }), bounds)
    for (const e of events) {
      expect(e.globalAlpha).toBe(1)
    }
    // The empty ring's translucency scales with the fade too (0.32 base × 0.4).
    const ring = events.find((e) => e.op === 'stroke' && e.strokeStyle.startsWith('rgba(180, 200, 220'))
    expect(ring).toBeDefined()
    expect(alphaOf(ring!.strokeStyle)).toBeCloseTo(0.32 * 0.4, 5)
  })

  it('draws nothing once fully faded', () => {
    const { ctx, events } = mockCtx()
    const out = drawHandSummary(ctx, layout, view({ fade: 0 }), bounds)
    expect(events).toHaveLength(0)
    expect(out.rays).toHaveLength(0)
  })
})
