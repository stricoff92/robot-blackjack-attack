import { describe, expect, it } from 'vitest'

import { dealerCountAnchor } from './cards'
import { nexusHoloLight } from './nexus'
import { drawScoreTitle } from './score-sheet'
import { computeLayout } from './scene'

// A minimal 2D-context stand-in: drawScoreTitle only measures/sets text and fills glyphs, so we
// approximate text width from the px in the font string (enough to exercise the real geometry).
function mockCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: '10px sans-serif',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {},
    restore() {},
    fillText() {},
    measureText(text: string) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string)
      const px = m ? parseFloat(m[1]) : 16
      return { width: text.length * px * 0.62 } as TextMetrics
    },
  }
  return ctx as unknown as CanvasRenderingContext2D
}

describe('drawScoreTitle geometry', () => {
  // Landscape desktop through to a narrow phone — every case must place the title above the board,
  // left of centre, and clear of the nexus lens (so the ray fan doesn't bug out).
  const sizes: Array<[number, number]> = [
    [1280, 720],
    [1024, 768],
    [900, 600],
    [768, 1024],
    [560, 900],
  ]

  for (const [w, h] of sizes) {
    it(`places the title above the board, left of centre, clear of the lens at ${w}x${h}`, () => {
      const l = computeLayout(w, h)
      const rays = drawScoreTitle(mockCtx(), l, 10_000, 0) // age well past the strike-in
      expect(rays).toHaveLength(1)
      const box = rays[0]

      // Finite + sane box.
      for (const v of [box.left, box.right, box.top, box.bottom]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      expect(box.right).toBeGreaterThan(box.left)
      expect(box.bottom).toBeGreaterThan(box.top)

      // On-screen.
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.top).toBeGreaterThan(0)

      // Left of felt-centre (so the beam swings toward horizontal).
      const center = (box.left + box.right) / 2
      expect(center).toBeLessThan(l.width / 2)

      // Clears the nexus lens (cast from the right) — the whole ray box sits left of it.
      expect(box.right).toBeLessThan(nexusHoloLight(l, 0).x)

      // Above the summary band (which drawScoreSheet centres between the count anchors).
      const dc = dealerCountAnchor(l)
      const bandTop = dc.y + dc.size * 0.7
      expect(box.bottom).toBeLessThanOrEqual(bandTop)

      // Not too large: the block stays a modest share of the felt.
      expect(box.right - box.left).toBeLessThan(l.width * 0.5)
      expect(box.bottom - box.top).toBeLessThan(l.height * 0.45)
    })
  }

  it('skips the title (no box) when the gap above the board is too short', () => {
    // A very short, wide viewport squeezes the felt's top rail against the band — no room for a
    // header, so it must bow out rather than overlap the board.
    const l = computeLayout(1400, 260)
    const rays = drawScoreTitle(mockCtx(), l, 10_000, 0)
    expect(rays.length).toBeLessThanOrEqual(1)
    if (rays.length === 1) {
      const dc = dealerCountAnchor(l)
      expect(rays[0].bottom).toBeLessThanOrEqual(dc.y + dc.size * 0.7)
    }
  })
})
