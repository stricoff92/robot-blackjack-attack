import { describe, expect, it } from 'vitest'

import { holoFanBase, nexusHoloLight, type HoloRayTarget } from './nexus'
import { computeLayout } from './scene'

// The holo lens sits on the RIGHT of the felt, so its ray fan must ALWAYS open leftward. If any
// triangle base vertex (or the gradient's far end) lands right of the lens, light spills out the
// RIGHT of the nexus — the "rays fire sideways" bug that recurred every time a new centred readout
// was added too close to the device. holoFanBase clamps that away for EVERY box; these tests pin
// the invariant so it can't silently regress.
describe('holoFanBase — the fan never reaches right of the nexus lens', () => {
  // Landscape desktop → narrow phone. On wide screens clampRightX reels the nexus toward centre, so
  // even a modestly wide centred readout can approach it — every size must stay safe.
  const sizes: Array<[number, number]> = [
    [1280, 720],
    [1024, 768],
    [900, 600],
    [768, 1024],
    [560, 900],
    [375, 667],
  ]

  for (const [w, h] of sizes) {
    const l = computeLayout(w, h)
    const lensX = nexusHoloLight(l, 0).x
    const cx = w / 2

    // A spread of placements, including the pathological ones the clamp exists for: a wide centred
    // board, a box shoved up against the nexus, and a box sitting entirely right of the lens.
    const boxes: Array<[string, HoloRayTarget]> = [
      ['small centred', { left: cx - w * 0.12, right: cx + w * 0.12, top: 0, bottom: 10 }],
      ['wide centred', { left: cx - w * 0.4, right: cx + w * 0.4, top: 0, bottom: 10 }],
      ['against the nexus', { left: lensX - w * 0.15, right: lensX + w * 0.05, top: 0, bottom: 10 }],
      ['entirely right of lens', { left: lensX + 10, right: lensX + w * 0.1, top: 0, bottom: 10 }],
    ]

    for (const [name, box] of boxes) {
      it(`${w}x${h} — ${name}: base + gradient never cross right of the lens`, () => {
        const fan = holoFanBase(l, 0, box)
        expect(fan.baseRight).toBeLessThanOrEqual(fan.lensX) // right base never right of the apex…
        expect(fan.midX).toBeLessThanOrEqual(fan.lensX) // …nor the gradient far end
        expect(fan.baseLeft).toBeLessThanOrEqual(fan.baseRight) // base never inverts
      })
    }

    it(`${w}x${h} — a well-placed (left-of-centre) box is untouched by the clamp`, () => {
      // A readout that already sits comfortably left keeps its natural +25%-padded base — the clamp
      // must not disturb the good case, only rescue the ones that reach the lens.
      const box: HoloRayTarget = { left: cx - w * 0.25, right: cx - w * 0.02, top: 0, bottom: 10 }
      const pad = (box.right - box.left) * 0.25
      const fan = holoFanBase(l, 0, box)
      expect(fan.baseRight).toBeCloseTo(box.right + pad, 6)
      expect(fan.baseLeft).toBeCloseTo(box.left - pad, 6)
    })

    it(`${w}x${h} — a wide box that ends well left of the lens keeps its fan at the text, not the nexus`, () => {
      // The regression: a wide readout whose +25% pad WOULD cross the lens got its fan stretched all
      // the way to the nexus (a vertical edge at the device, lighting the empty gap between the text
      // and it). The fan's right edge must sit at the text (box.right), not at the lens.
      const box: HoloRayTarget = { left: lensX - w * 0.55, right: lensX - w * 0.1, top: 0, bottom: 10 }
      const pad = (box.right - box.left) * 0.25
      expect(box.right + pad).toBeGreaterThan(lensX) // precondition: the pad alone would cross the lens
      const fan = holoFanBase(l, 0, box)
      expect(fan.baseRight).toBeCloseTo(box.right, 6) // ends at the text edge…
      expect(fan.baseRight).toBeLessThan(lensX) // …not stretched to the nexus
    })

    it(`${w}x${h} — a box ON the nexus column (the bankroll count) still fans, never a thin line`, () => {
      // The player bankroll count sits on the nexus's own right column, directly below the lens.
      // Clamping to the lens (not a margin left of it) must leave it a REAL fan — the regression was
      // a collapsed thin line / invisible rays. Try a short number and a long one, both centred on
      // the lens, since the box width varies with the value.
      for (const halfW of [w * 0.03, w * 0.12]) {
        const box: HoloRayTarget = { left: lensX - halfW, right: lensX + halfW, top: 0, bottom: 10 }
        const fan = holoFanBase(l, 0, box)
        expect(fan.baseRight).toBeLessThanOrEqual(fan.lensX)
        expect(fan.baseRight - fan.baseLeft).toBeGreaterThan(0.5) // a real fan, not a collapsed line
      }
    })
  }
})
