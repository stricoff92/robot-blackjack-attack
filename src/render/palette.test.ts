import { describe, expect, it } from 'vitest'

import { TOTAL_DEALERS } from '../game/run'
import { dealerColors, isRgbDealer } from './palette'

describe('dealerColors', () => {
  it('gives each fixed dealer (1..5) a distinct bowtie + deck colour', () => {
    const kits = new Set<string>()
    for (let shift = 1; shift < TOTAL_DEALERS; shift += 1) {
      expect(isRgbDealer(shift)).toBe(false)
      const c = dealerColors(shift, 0)
      kits.add(`${c.bowtie}|${c.back.outer}`)
    }
    expect(kits.size).toBe(TOTAL_DEALERS - 1)
  })

  it('holds a fixed hue for a fixed dealer regardless of time', () => {
    expect(dealerColors(2, 0)).toEqual(dealerColors(2, 9999))
  })

  it('marks the final dealer as RGB, cycling its bowtie hue over time', () => {
    expect(isRgbDealer(TOTAL_DEALERS)).toBe(true)
    const a = dealerColors(TOTAL_DEALERS, 0).bowtie
    const b = dealerColors(TOTAL_DEALERS, 2000).bowtie
    expect(a).not.toBe(b)
  })

  it('buckets the RGB dealer deck colour so the sprite cache stays bounded', () => {
    // Two instants a few ms apart fall in the same hue bucket → identical cache id.
    expect(dealerColors(TOTAL_DEALERS, 0).back.id).toBe(dealerColors(TOTAL_DEALERS, 5).back.id)
  })

  it('treats any dealer past the roster as RGB too', () => {
    expect(isRgbDealer(TOTAL_DEALERS + 3)).toBe(true)
  })
})
