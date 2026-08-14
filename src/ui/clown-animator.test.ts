import { describe, expect, it } from 'vitest'
import { ClownAnimation } from './clown-animator'
import { KILL_ARRIVE_MS } from './dealer-animator'
import { TOTAL_DEALERS } from '../game/run'
import { evilLaughPattern } from '../audio/voice'
import type { DealerView } from '../render/dealer'

// A stub dealer whose per-frame answers we set directly, so we can drive the clown's
// observe() through each scenario without the full DealerAnimation timeline.
function stubDealer(over: Partial<Record<keyof DealerView, unknown>> = {}): DealerView {
  const base: DealerView = {
    alive: () => true,
    hit: () => ({ flash: 0, shakeX: 0, shakeY: 0 }),
    tremor: () => ({ x: 0, y: 0 }),
    dying: () => null,
    arriving: () => null,
    leaving: () => null,
    eyeCore: () => 1,
    eyeGlow: () => 0.7,
    browFear: () => 0,
    figureShift: () => TOTAL_DEALERS,
    voice: () => null,
  }
  return { ...base, ...(over as Partial<DealerView>) }
}

describe('ClownAnimation', () => {
  it('stays hidden while a non-dealer-6 figure stands', () => {
    const clown = new ClownAnimation()
    const dealer = stubDealer({ figureShift: () => 3 })
    clown.observe(dealer, 1000)
    expect(clown.present(1000)).toBe(false)
  })

  it('follows dealer 6 in on a delay, then stands', () => {
    const clown = new ClownAnimation()
    // Dealer 6 begins its walk-in at t=1000 (arriving just became non-null).
    const arriving = stubDealer({ arriving: () => 0.01 })
    clown.observe(arriving, 1000)
    // During the follow-delay the clown is not yet on screen...
    expect(clown.present(1000)).toBe(false)
    expect(clown.arriving(1000)).toBeNull()
    // ...then it slides in (delay < 500ms), reaching its mark KILL_ARRIVE_MS later.
    expect(clown.present(1600)).toBe(true)
    expect(clown.arriving(1600)).toBeGreaterThan(0)
    // Well past the walk-in, a fresh observe settles it to standing.
    const standing = stubDealer()
    clown.observe(standing, 1000 + 600 + KILL_ARRIVE_MS + 50)
    expect(clown.arriving(1000 + 600 + KILL_ARRIVE_MS + 50)).toBeNull()
    expect(clown.present(1000 + 600 + KILL_ARRIVE_MS + 50)).toBe(true)
  })

  it('appears standing immediately when dealer 6 is already up (resume)', () => {
    const clown = new ClownAnimation()
    clown.observe(stubDealer(), 5000) // alive, shift 6, no transition
    expect(clown.present(5000)).toBe(true)
    expect(clown.arriving(5000)).toBeNull()
    expect(clown.leaving(5000)).toBeNull()
  })

  it('laughs and walks off when dealer 6 dies', () => {
    const clown = new ClownAnimation()
    clown.observe(stubDealer(), 1000) // standing beside dealer 6
    // Dealer 6 shatters: dying non-null, figure still reports shift 6.
    const event = clown.observe(stubDealer({ dying: () => 0.1 }), 2000)
    expect(event).toBe('death')
    // A beat of reacting in place, then it strides off, then it's gone.
    expect(clown.leaving(2100)).toBeNull() // react delay, not sliding yet
    expect(clown.leaving(2400)).toBeGreaterThan(0) // walking off
    clown.observe(stubDealer({ figureShift: () => TOTAL_DEALERS + 1 }), 2400 + KILL_ARRIVE_MS + 50)
    expect(clown.present(2400 + KILL_ARRIVE_MS + 50)).toBe(false)
  })

  it('follows dealer 6 off (a game-over walk-off) without a death event', () => {
    const clown = new ClownAnimation()
    clown.observe(stubDealer(), 1000)
    const event = clown.observe(stubDealer({ leaving: () => 0.02 }), 2000)
    expect(event).toBeNull()
    // Follows a beat behind, then leaves the screen.
    expect(clown.leaving(2000)).toBeNull() // still within the follow-delay
    expect(clown.leaving(2600)).toBeGreaterThan(0)
  })

  // Battery saver freezes the shared cast render clock when the (dead) dealer stops choreographing.
  // isAnimating is what keeps that clock live across the WHOLE walk-off — including the react delay
  // BEFORE the slide starts — so the clown never renders stranded mid-exit. Regression guard.
  it('reports isAnimating across the entire death walk-off, then false once hidden', () => {
    const clown = new ClownAnimation()
    clown.observe(stubDealer(), 1000)
    expect(clown.isAnimating(1000)).toBe(false) // idle standing → saver may freeze it static
    clown.observe(stubDealer({ dying: () => 0.1 }), 2000)
    expect(clown.isAnimating(2100)).toBe(true) // react delay (not sliding yet) must stay live
    expect(clown.isAnimating(2400)).toBe(true) // sliding off
    clown.observe(stubDealer({ figureShift: () => TOTAL_DEALERS + 1 }), 2400 + KILL_ARRIVE_MS + 50)
    expect(clown.isAnimating(2400 + KILL_ARRIVE_MS + 50)).toBe(false) // gone
  })

  it('reports isAnimating while walking in, and during a stand-still laugh', () => {
    const clown = new ClownAnimation()
    clown.observe(stubDealer({ arriving: () => 0.01 }), 1000)
    expect(clown.isAnimating(1000)).toBe(true) // walking in (even during the follow-delay)
    // Settled to standing: idle → not animating, but an armed laugh re-activates the clock.
    clown.observe(stubDealer(), 1000 + 600 + KILL_ARRIVE_MS + 50)
    const t = 1000 + 600 + KILL_ARRIVE_MS + 50
    expect(clown.isAnimating(t)).toBe(false)
    clown.emote(t, evilLaughPattern(1, 1))
    expect(clown.isAnimating(t)).toBe(true) // mid-laugh → keep the mouth clock live
  })
})
