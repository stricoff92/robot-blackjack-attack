import { describe, expect, it } from 'vitest'

import { classifyViewport, type ViewportMetrics } from './viewport-guard'

// Defaults describe a comfortably-large landscape desktop; each test overrides only what it probes.
function metrics(over: Partial<ViewportMetrics> = {}): ViewportMetrics {
  return { availableHeight: 900, availableWidth: 1600, requiredHeight: 730, coarsePointer: false, ...over }
}

describe('classifyViewport', () => {
  it('fits when the layout is shorter than the viewport', () => {
    expect(classifyViewport(metrics({ availableHeight: 900, requiredHeight: 730 }))).toBe('ok')
  })

  it('prompts a rotate on a short landscape phone whose portrait height would fit', () => {
    // 800x450 — CrazyGames\' default mobile iframe. Portrait (height := 800) clears the 462 the
    // layout needs, and the device can rotate, so suggest it.
    expect(
      classifyViewport({ availableHeight: 450, availableWidth: 800, requiredHeight: 462, coarsePointer: true }),
    ).toBe('rotate')
  })

  it('does not wall a desktop window for a few clipped pixels (rotating is not an option)', () => {
    // 1280x720 desktop, layout wants 726 — 6px over, but a mouse can\'t rotate and it\'s within the
    // "too small" tolerance, so keep playing rather than throw up a wall.
    expect(
      classifyViewport({ availableHeight: 720, availableWidth: 1280, requiredHeight: 726, coarsePointer: false }),
    ).toBe('ok')
  })

  it('walls a desktop window that is genuinely too short to fit the layout', () => {
    expect(
      classifyViewport({ availableHeight: 520, availableWidth: 1000, requiredHeight: 726, coarsePointer: false }),
    ).toBe('too-small')
  })

  it('walls (not rotate) a touch device that is too small even in its taller orientation', () => {
    // Portrait phone (already the taller axis) that still can\'t fit — rotating to landscape would
    // only make it shorter, so a rotate prompt would be a lie.
    expect(
      classifyViewport({ availableHeight: 500, availableWidth: 360, requiredHeight: 726, coarsePointer: true }),
    ).toBe('too-small')
  })

  it('ignores the rotate hint on a touch device already in its taller orientation but comfortably fitting', () => {
    expect(
      classifyViewport({ availableHeight: 800, availableWidth: 450, requiredHeight: 462, coarsePointer: true }),
    ).toBe('ok')
  })

  it('does not flap at the exact break-even height (rotate deadband)', () => {
    // Cramped by only 1-2px on a rotatable device: within the deadband, so no prompt yet.
    expect(
      classifyViewport({ availableHeight: 460, availableWidth: 800, requiredHeight: 462, coarsePointer: true }),
    ).toBe('ok')
  })

  it('routes a short landscape TABLET to rotate (coarse pointer, portrait fits)', () => {
    // 1080x607 — CrazyGames\' tablet iframe. Portrait (1080) fits the 726 the layout wants.
    expect(
      classifyViewport({ availableHeight: 607, availableWidth: 1080, requiredHeight: 726, coarsePointer: true }),
    ).toBe('rotate')
  })
})
