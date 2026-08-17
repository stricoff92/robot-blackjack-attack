import { afterEach, describe, expect, it } from 'vitest'

import { hostAllowed, hostToken, renderLock } from './sitelock'

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

// The suite runs DOM-free (vitest's default node environment; there is no jsdom dependency), so
// renderLock is exercised against a hand-rolled stub of exactly the four things it touches. That is
// enough to pin the regression this guards, which is structural rather than visual.
describe('sitelock renderLock', () => {
  const realDocument = globalThis.document

  afterEach(() => {
    Object.defineProperty(globalThis, 'document', { value: realDocument, configurable: true, writable: true })
  })

  it('removes the boot splash, which is a SIBLING of #app and so survives replaceChildren', () => {
    // The splash lives OUTSIDE #app (see index.html), and on the locked path main.ts halts on a
    // never-resolving await BEFORE the splash's normal removal runs. So clearing #app alone left the
    // game's wordmark + spinner pulsing forever: the branding this lock exists to withhold, and a
    // "hung game" signature if the lock ever misfired on a legitimate host. Do not drop this call.
    let splashRemoved = false
    let cleared = false
    const body = { style: {} as CSSStyleDeclaration }
    Object.defineProperty(globalThis, 'document', {
      value: {
        body,
        getElementById: (id: string) => (id === 'boot-splash' ? { remove: () => (splashRemoved = true) } : null),
      },
      configurable: true,
      writable: true,
    })
    const root = { replaceChildren: () => (cleared = true), style: {} as CSSStyleDeclaration }

    renderLock(root as unknown as HTMLElement)

    expect(splashRemoved).toBe(true)
    expect(cleared).toBe(true)
    // ...and a disallowed host is left with a plain black screen, not a half-torn-down one.
    expect(root.style.background).toBe('#000')
    expect(body.style.background).toBe('#000')
  })

  it('is a no-op on the splash when it has already been removed', () => {
    Object.defineProperty(globalThis, 'document', {
      value: { body: { style: {} }, getElementById: () => null },
      configurable: true,
      writable: true,
    })
    const root = { replaceChildren: () => {}, style: {} as CSSStyleDeclaration }

    expect(() => renderLock(root as unknown as HTMLElement)).not.toThrow()
  })
})
