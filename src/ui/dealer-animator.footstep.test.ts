import { describe, expect, it } from 'vitest'
import { WALK_STEPS } from '../render/dealer'
import { DealerAnimation, KILL_ARRIVE_MS, KILL_DEATH_LEAD_MS, KILL_DYING_MS, KILL_GONE_MS } from './dealer-animator'

// The bob the renderer draws (render/dealer.ts): |sin| dips DOWN once per step.
const bob = (arriving: number) => Math.abs(Math.sin(arriving * Math.PI * WALK_STEPS))
// Expected footfall progress fractions the sfx must land on.
const footfalls = Array.from({ length: WALK_STEPS }, (_, i) => (i + 0.5) / WALK_STEPS)

// Walk a spawn walk-in frame by frame from t0, returning the timestamps footsteps() fired.
function stepTimes(anim: DealerAnimation, t0: number, dt = 16): number[] {
  const times: number[] = []
  for (let t = t0; t <= t0 + KILL_ARRIVE_MS + 200; t += dt) {
    const n = anim.footsteps(t)
    for (let i = 0; i < n; i += 1) {
      times.push(t)
    }
  }
  return times
}

describe('walk-in footsteps', () => {
  it('the bob dips to its DOWN peak exactly at each footfall fraction', () => {
    for (const f of footfalls) {
      expect(bob(f)).toBeCloseTo(1, 6) // full down-dip at the footfall
    }
    // ...and rests at baseline at the ends and between steps (no snap on settle).
    expect(bob(0)).toBeCloseTo(0, 6)
    expect(bob(1)).toBeCloseTo(0, 6)
  })

  it('fires exactly WALK_STEPS times, each within a frame of its footfall', () => {
    const anim = new DealerAnimation()
    const t0 = 5000
    anim.spawn(t0)
    const times = stepTimes(anim, t0)
    expect(times).toHaveLength(WALK_STEPS)
    times.forEach((t, i) => {
      const expected = t0 + footfalls[i] * KILL_ARRIVE_MS
      expect(t).toBeGreaterThanOrEqual(expected) // fires on the first frame past the dip
      expect(t - expected).toBeLessThan(16) // within one frame
    })
  })

  it('resets and re-fires for a fresh walk-in (a kill replacement after a spawn)', () => {
    const anim = new DealerAnimation()
    anim.spawn(1000)
    expect(stepTimes(anim, 1000)).toHaveLength(WALK_STEPS)

    // A kill: the replacement's arrival begins after death lead + dying + gone.
    const killAt = 40000
    anim.sync(100, 1, 100, 2, killAt) // integrity same, shift rises → kill w/ walk-in
    const arriveStart = killAt + KILL_DEATH_LEAD_MS + KILL_DYING_MS + KILL_GONE_MS
    const killSteps: number[] = []
    for (let t = killAt; t <= arriveStart + KILL_ARRIVE_MS + 200; t += 16) {
      for (let i = 0; i < anim.footsteps(t); i += 1) killSteps.push(t)
    }
    expect(killSteps).toHaveLength(WALK_STEPS)
    // No step fires before the arrival phase (during death/dying/gone).
    expect(killSteps[0]).toBeGreaterThan(arriveStart)
  })

  it('a final / death-only kill has no walk-in, so no footsteps', () => {
    const anim = new DealerAnimation()
    anim.sync(100, 1, 100, 2, 1000, /* final */ true)
    const steps: number[] = []
    for (let t = 1000; t <= 1000 + 5000; t += 16) {
      for (let i = 0; i < anim.footsteps(t); i += 1) steps.push(t)
    }
    expect(steps).toHaveLength(0)
  })

  it('the game-over walk-off strides off with WALK_STEPS footsteps', () => {
    const anim = new DealerAnimation()
    const t0 = 8000
    anim.walkOff(t0)
    expect(stepTimes(anim, t0)).toHaveLength(WALK_STEPS)
  })
})

describe('game-over walk-off', () => {
  it('stands until the start, then leaves the screen, then is gone', () => {
    const anim = new DealerAnimation()
    const t0 = 8000
    anim.walkOff(t0)
    // Before it starts: standing in place (alive, no leave progress yet).
    expect(anim.alive(t0 - 100)).toBe(true)
    expect(anim.leaving(t0 - 100)).toBeNull()
    // Striding off: leave progress ramps 0 → 1, still alive/on-screen.
    expect(anim.leaving(t0)).toBeCloseTo(0, 6)
    expect(anim.leaving(t0 + KILL_ARRIVE_MS / 2)).toBeCloseTo(0.5, 2)
    expect(anim.alive(t0 + KILL_ARRIVE_MS / 2)).toBe(true)
    // Once it clears the edge: gone (not drawn), no leave progress.
    expect(anim.alive(t0 + KILL_ARRIVE_MS + 1)).toBe(false)
    expect(anim.leaving(t0 + KILL_ARRIVE_MS + 1)).toBeNull()
  })

  it('is not a walk-IN — arriving() never fires during a walk-off', () => {
    const anim = new DealerAnimation()
    anim.walkOff(2000)
    expect(anim.arriving(2000 + KILL_ARRIVE_MS / 2)).toBeNull()
    expect(anim.isArriving(2000 + KILL_ARRIVE_MS / 2)).toBe(false)
  })
})
