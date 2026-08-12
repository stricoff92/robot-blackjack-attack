import { describe, expect, it } from 'vitest'

import { MAX_HEARTS } from '../game/run'
import { playerCardBox } from './cards'
import { heartRowMetrics, heartSlotCenters } from './hearts'
import { computeLayout } from './scene'

// Regression guard for the reported iPhone-SE bug: the heart row rode up under the player cards
// because it anchored to BOTTOM_HUD_RESERVE, but on a portrait phone the cards bottom out ABOVE that
// line. The row now anchors to the real card box, so it must clear the cards on portrait screens.
const PORTRAIT = [
  { name: 'iPhone SE (2nd/3rd gen)', w: 375, h: 667 },
  { name: 'iPhone SE (1st gen)', w: 320, h: 568 },
  { name: 'tall phone', w: 390, h: 844 },
]
const ALL = [...PORTRAIT, { name: 'desktop', w: 1280, h: 800 }]

describe('heart row layout', () => {
  for (const v of PORTRAIT) {
    it(`does not overlap the player cards on ${v.name}`, () => {
      const l = computeLayout(v.w, v.h)
      const { r, y } = heartRowMetrics(l)
      const cardBottom = playerCardBox(l).y + playerCardBox(l).h
      expect(y - r).toBeGreaterThanOrEqual(cardBottom) // top of the row sits below the cards
    })
  }

  for (const v of ALL) {
    it(`stays clear of the bottom action bar on ${v.name}`, () => {
      const l = computeLayout(v.w, v.h)
      const { r, y } = heartRowMetrics(l)
      expect(y + r).toBeLessThanOrEqual(l.height - 40) // bottom of the row is above the buttons
    })

    it(`fits all ${MAX_HEARTS} chips within the screen width on ${v.name}`, () => {
      const l = computeLayout(v.w, v.h)
      const centers = heartSlotCenters(l)
      const { r } = heartRowMetrics(l)
      expect(centers).toHaveLength(MAX_HEARTS)
      expect(centers[0].x - r).toBeGreaterThanOrEqual(0)
      expect(centers[centers.length - 1].x + r).toBeLessThanOrEqual(l.width)
    })
  }
})
