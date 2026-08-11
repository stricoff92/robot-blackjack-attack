import { describe, expect, it } from 'vitest'

import { abbreviateCount } from './format'

describe('abbreviateCount', () => {
  it('leaves amounts under 1000 exact', () => {
    expect(abbreviateCount(0)).toBe('0')
    expect(abbreviateCount(5)).toBe('5')
    expect(abbreviateCount(320)).toBe('320')
    expect(abbreviateCount(999)).toBe('999')
  })

  it('abbreviates thousands with a K and one decimal', () => {
    expect(abbreviateCount(1000)).toBe('1K')
    expect(abbreviateCount(1100)).toBe('1.1K') // the spec's example
    expect(abbreviateCount(1500)).toBe('1.5K')
    expect(abbreviateCount(12000)).toBe('12K')
    expect(abbreviateCount(12500)).toBe('12.5K')
    expect(abbreviateCount(100000)).toBe('100K')
  })

  it('rolls up to the next unit at the boundary', () => {
    expect(abbreviateCount(999999)).toBe('1M')
    expect(abbreviateCount(1000000)).toBe('1M')
    expect(abbreviateCount(1250000)).toBe('1.3M')
    expect(abbreviateCount(12000000)).toBe('12M')
  })

  it('never carries more than one decimal place', () => {
    expect(abbreviateCount(1234)).toBe('1.2K')
    expect(abbreviateCount(1289)).toBe('1.3K')
  })
})
