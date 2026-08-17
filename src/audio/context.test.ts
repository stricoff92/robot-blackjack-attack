import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// These tests drive the iOS background/foreground reconciler in ./context without
// a DOM: we stub window/document/navigator and CAPTURE the timer callback so a
// heartbeat "poll tick" is just `poll()`. AudioContext is faked with a mutable
// state plus vi.fn suspend/resume, so we can assert the suspend/resume choreography.

type FakeCtx = {
  state: string
  suspend: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  addEventListener: (type: string, cb: () => void) => void
  fire: (type: string) => void
}

let poll: (() => void) | null
let listeners: Record<string, Array<() => void>>
let hidden: boolean
let hasBeenActive: boolean
let nextCtx: FakeCtx | null

function makeCtx(initial = 'suspended'): FakeCtx {
  const handlers: Record<string, Array<() => void>> = {}
  const ctx: FakeCtx = {
    state: initial,
    suspend: vi.fn(() => {
      ctx.state = 'suspended'
      return Promise.resolve()
    }),
    resume: vi.fn(() => {
      ctx.state = 'running'
      return Promise.resolve()
    }),
    addEventListener: (type: string, cb: () => void) => {
      ;(handlers[type] ??= []).push(cb)
    },
    fire: (type: string) => {
      for (const cb of handlers[type] ?? []) {
        cb()
      }
    },
  }
  return ctx
}

// Let queued microtasks (suspend/resume .finally) settle so the in-flight guard clears.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

function dispatch(type: string): void {
  for (const cb of listeners[type] ?? []) {
    cb()
  }
}

beforeEach(() => {
  poll = null
  listeners = {}
  hidden = false
  hasBeenActive = true
  nextCtx = null

  const addTo = (type: string, cb: () => void): void => {
    ;(listeners[type] ??= []).push(cb)
  }

  vi.stubGlobal('performance', { now: () => 0 })
  vi.stubGlobal('setInterval', (cb: () => void) => {
    poll = cb
    return 1
  })
  vi.stubGlobal('clearInterval', () => {})
  vi.stubGlobal('navigator', {
    get userActivation() {
      return { hasBeenActive }
    },
  })
  vi.stubGlobal('document', {
    get hidden() {
      return hidden
    },
    addEventListener: addTo,
  })
  vi.stubGlobal('window', {
    // `new Ctor()` returns this object (a function returning an object wins over `this`).
    AudioContext: function AudioContext(this: unknown) {
      return nextCtx
    },
    addEventListener: addTo,
    location: { search: '' },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('heartbeat — hidden', () => {
  it('suspends a running context', async () => {
    const ctx = makeCtx('running')
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    hidden = true
    poll!()

    expect(ctx.suspend).toHaveBeenCalledTimes(1)
    expect(ctx.state).toBe('suspended')
  })

  it('does not re-suspend an already-suspended context', async () => {
    const ctx = makeCtx('suspended')
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    hidden = true
    poll!()

    expect(ctx.suspend).not.toHaveBeenCalled()
  })
})

describe('heartbeat — visible', () => {
  it('retries resume() every tick until the context is running (the iOS fix)', async () => {
    // A context that stays suspended (resume "rejected" — state never flips) until
    // the 3rd attempt, modeling iOS refusing the first resumes after an interruption.
    let attempts = 0
    const ctx = makeCtx('suspended')
    ctx.resume = vi.fn(() => {
      attempts++
      if (attempts >= 3) {
        ctx.state = 'running'
      }
      return Promise.resolve()
    })
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    poll!()
    await flush()
    expect(ctx.state).toBe('suspended')
    poll!()
    await flush()
    expect(ctx.state).toBe('suspended')
    poll!()
    await flush()
    expect(ctx.state).toBe('running')
    expect(ctx.resume).toHaveBeenCalledTimes(3)

    // Once running, no further resume calls.
    poll!()
    await flush()
    expect(ctx.resume).toHaveBeenCalledTimes(3)
  })

  it('does not resume before the page has been activated', async () => {
    const ctx = makeCtx('suspended')
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    hasBeenActive = false
    poll!()

    expect(ctx.resume).not.toHaveBeenCalled()
  })
})

describe('in-flight guard', () => {
  it('does not overlap resume() calls while one is pending', async () => {
    // A resume that never resolves and never flips state, so the context stays
    // non-running and in-flight across ticks.
    const ctx = makeCtx('suspended')
    ctx.suspend = vi.fn(() => new Promise<void>(() => {}))
    ctx.resume = vi.fn(() => new Promise<void>(() => {}))
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    poll!()
    poll!()

    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })
})

describe('statechange resume (the iOS fix)', () => {
  it('resumes when WebKit fires statechange after the interruption ends', async () => {
    // Models iOS: while "interrupted" the state reads 'suspended' but resume()
    // rejects with InvalidStateError; once the interruption ends, resume() works.
    let interruptionOver = false
    const ctx = makeCtx('suspended')
    ctx.resume = vi.fn(() => {
      if (!interruptionOver) {
        return Promise.reject(new DOMException('bad state', 'InvalidStateError'))
      }
      ctx.state = 'running'
      return Promise.resolve()
    })
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    // Poll while still interrupted → resume attempted, rejected, stays suspended.
    poll!()
    await flush()
    expect(ctx.state).toBe('suspended')

    // WebKit ends the interruption and fires statechange; the handler resumes now.
    interruptionOver = true
    ctx.fire('statechange')
    await flush()
    expect(ctx.state).toBe('running')
  })
})

describe('gesture unlock', () => {
  it('resumes synchronously on a pointer gesture, bypassing the activation gate', async () => {
    const ctx = makeCtx('suspended')
    nextCtx = ctx
    const mod = await import('./context')
    mod.createAudioContext('test')

    hasBeenActive = false
    dispatch('pointerdown')

    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })
})

describe('shared context (consolidation)', () => {
  it('hands every caller the SAME context, so all audio rides one recovering session', async () => {
    const a = makeCtx('running')
    nextCtx = a
    const mod = await import('./context')
    const first = mod.createAudioContext('sfx')
    // A different fake would be used only if a second context were created — it must not be.
    nextCtx = makeCtx('running')
    const second = mod.createAudioContext('music')

    expect(second).toBe(first)
    expect(second).toBe(a)

    hidden = true
    poll!()
    await flush()
    expect(a.state).toBe('suspended')

    hidden = false
    poll!()
    await flush()
    expect(a.state).toBe('running')
  })
})
