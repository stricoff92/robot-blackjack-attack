import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the platform seam so recordRun runs without a real SDK / storage. loadValue drives the
// "previous best"; happytime / submitToCrazyGames / saveValue are spies. nextBest (pure) stays real.
const mocks = vi.hoisted(() => ({
  happytime: vi.fn(),
  submitToCrazyGames: vi.fn(),
  saveValue: vi.fn(),
  loadValue: vi.fn(),
}))

vi.mock('../platform/crazygames', () => ({
  happytime: mocks.happytime,
  submitToCrazyGames: mocks.submitToCrazyGames,
  saveValue: mocks.saveValue,
  loadValue: mocks.loadValue,
}))

describe('recordRun — happytime on a beaten high score', () => {
  let recordRun: typeof import('./leaderboard').recordRun

  beforeEach(async () => {
    // Fresh module each test so leaderboard's cached personal-best does not leak across cases.
    vi.resetModules()
    mocks.happytime.mockClear()
    mocks.submitToCrazyGames.mockClear()
    mocks.saveValue.mockClear()
    mocks.loadValue.mockReset()
    ;({ recordRun } = await import('./leaderboard'))
  })

  it('fires when the player beats an EXISTING best', () => {
    mocks.loadValue.mockReturnValue('1000')
    const res = recordRun(1500)
    expect(res).toEqual({ previousBest: 1000, isNewBest: true })
    expect(mocks.happytime).toHaveBeenCalledTimes(1)
    expect(mocks.saveValue).toHaveBeenCalledWith('rba.personalBest', '1500')
  })

  it('does NOT fire on the first-ever best (no prior high score)', () => {
    mocks.loadValue.mockReturnValue(null)
    const res = recordRun(420)
    expect(res).toEqual({ previousBest: 0, isNewBest: true })
    expect(mocks.happytime).not.toHaveBeenCalled()
  })

  it('does NOT fire on a tie or a lower score', () => {
    mocks.loadValue.mockReturnValue('1000')
    recordRun(1000) // tie
    recordRun(900) // lower
    expect(mocks.happytime).not.toHaveBeenCalled()
  })

  it('does NOT fire on a coda bust (score 0)', () => {
    mocks.loadValue.mockReturnValue('1000')
    recordRun(0)
    expect(mocks.happytime).not.toHaveBeenCalled()
  })

  it('always submits the score to the leaderboard regardless', () => {
    mocks.loadValue.mockReturnValue('1000')
    recordRun(1500)
    expect(mocks.submitToCrazyGames).toHaveBeenCalledWith(1500)
  })
})
