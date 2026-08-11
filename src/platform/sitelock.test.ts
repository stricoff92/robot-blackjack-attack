import { describe, expect, it } from 'vitest'

import { hostAllowed, hostToken } from './sitelock'

describe('sitelock hostToken', () => {
  it('decodes to the expected host label (guards MASK/MASKED typos)', () => {
    expect(hostToken()).toBe('crazygames')
  })
})

describe('sitelock hostAllowed', () => {
  it('allows real CrazyGames hosts', () => {
    expect(hostAllowed('robot-blackjack-attack.game-files.crazygames.com')).toBe(true)
    expect(hostAllowed('www.crazygames.com')).toBe(true)
    expect(hostAllowed('crazygames.com')).toBe(true)
  })

  it('blocks the crazygames.<attacker>.com subdomain bypass', () => {
    // Passes CrazyGames' official "last 3 labels" snippet, but the 2nd-level label is `foobar`.
    expect(hostAllowed('crazygames.foobar.com')).toBe(false)
  })

  it('blocks foreign and look-alike hosts', () => {
    expect(hostAllowed('localhost')).toBe(false)
    expect(hostAllowed('evil.com')).toBe(false)
    expect(hostAllowed('mycrazygames.com')).toBe(false) // substring, not a label
  })
})
