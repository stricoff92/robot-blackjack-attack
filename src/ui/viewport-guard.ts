// Viewport guard — when the screen is too SHORT to show the whole control layout (the top-left
// ability column + its "?" help button + the bottom-left "i" info button), we can't let the player
// keep playing under a clipped/overlapping UI. Instead we blank play behind a full-screen modal that
// either (a) tells a phone/tablet to rotate to portrait — where the same layout has ample height —
// or (b) says the screen is simply too small when rotating wouldn't help (desktop, or a device
// already in its taller orientation).
//
// The platform's own orientation prompt is a submission-time toggle (landscape/portrait), which
// can't express "landscape is fine until the viewport gets short, then prefer portrait" — that
// conditional, height-driven decision is ours. Declare BOTH orientations at submission so the
// platform doesn't override this with its own rotate-to-landscape wall.
//
// Height comes from a caller-supplied measure() (the live ability column's rendered bottom), so this
// module carries no DOM-layout knowledge and adapts automatically to the desktop/mobile CSS
// breakpoint and DPR. Everything keys off the REAL measured height, not hard-coded pixels.

export type ViewportVerdict = 'ok' | 'rotate' | 'too-small'

export interface ViewportMetrics {
  // Usable viewport height/width in CSS px (the smaller of layout- and visual-viewport, so mobile
  // browser chrome can't make us over-report the room we have).
  availableHeight: number
  availableWidth: number
  // Height the control layout needs to fit without clipping (measured column bottom + breathing).
  requiredHeight: number
  // A device that can be rotated (touch / stylus). Desktop mice are 'fine' pointers → false.
  coarsePointer: boolean
}

// A rotate-to-portrait suggestion is cheap and high-value, so on a device that CAN rotate we prompt
// as soon as the layout is even slightly cramped (past this small deadband, which just stops the
// prompt flickering at the exact break-even height).
const ROTATE_TRIGGER_PX = 4

// "Screen too small" walls the player, so when rotating CAN'T help (desktop, or already in the
// taller orientation) we only trip once the layout is clipped by more than this — a few px of the
// help button kissing the edge shouldn't wall a legitimate desktop window.
const TOO_SMALL_TOLERANCE_PX = 24

// Pure classification — unit-tested in isolation (see viewport-guard.test.ts). Given the usable
// viewport, the height the layout needs, and whether the device can rotate, decide whether the UI
// fits, would fit after rotating to portrait, or genuinely can't fit.
export function classifyViewport(m: ViewportMetrics): ViewportVerdict {
  const deficit = m.requiredHeight - m.availableHeight
  // Rotating swaps the axes, so the post-rotation height is today's width. It only helps if that
  // taller orientation actually clears the requirement AND we're currently in the shorter one.
  const rotatingWouldFit = m.availableWidth >= m.requiredHeight && m.availableWidth > m.availableHeight
  if (m.coarsePointer && rotatingWouldFit) {
    return deficit > ROTATE_TRIGGER_PX ? 'rotate' : 'ok'
  }
  return deficit > TOO_SMALL_TOLERANCE_PX ? 'too-small' : 'ok'
}

// Once the modal is up, insist the layout clear the viewport by this much before we dismiss it — a
// little stickiness so a few px of mobile URL-bar wobble at the boundary can't flap the modal.
const HYSTERESIS_PX = 10

// How far the viewport must change (either axis) from where "Play anyway" was tapped before the guard
// re-arms. Small — just enough to ignore sub-pixel/rounding jitter, so any real resize re-prompts.
const REARM_PX = 8

const COPY: Record<Exclude<ViewportVerdict, 'ok'>, { title: string; body: string }> = {
  rotate: {
    title: 'Rotate your device',
    body: 'Turn your phone upright to portrait mode.',
  },
  'too-small': {
    title: 'Screen too small',
    body: 'This game needs a bit more height. Try enlarging the window or using a larger screen.',
  },
}

// Rotate = a LANDSCAPE phone turning into a PORTRAIT one (left→right, with a direction arrow) so the
// icon matches the instruction "turn upright to portrait" — NOT a generic spin that could read as the
// opposite. Too-small = a screen frame with inward chevrons. Teal holo line-art matching the nexus
// readouts; currentColor so CSS owns the tint.
const GLYPH: Record<Exclude<ViewportVerdict, 'ok'>, string> = {
  rotate:
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="18" width="26" height="16" rx="3"/>' + // landscape phone (current)
    '<circle cx="8" cy="26" r="1.2" fill="currentColor" stroke="none"/>' +
    '<rect x="42" y="14" width="17" height="28" rx="3"/>' + // portrait phone (target)
    '<circle cx="50.5" cy="18.5" r="1.2" fill="currentColor" stroke="none"/>' +
    // sweep from under the landscape phone up toward the portrait one; the arrowhead's tip meets the
    // stem end and sits in the clear gap (never under the portrait rect).
    '<path d="M17 39 C 24 47, 33 47, 38.5 40.5"/><path d="M36.6 47 L38.9 40.3 L32.4 42.9"/>' +
    '</svg>',
  'too-small':
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="14" y="16" width="36" height="32" rx="4"/>' +
    '<path d="M24 28l-6 6 6 6"/><path d="M40 28l6 6-6 6"/>' +
    '</svg>',
}

// Drives the modal: measures via the supplied callback, classifies, and shows/hides + blocks input.
// The measure callback returns the required height, or null when the column isn't laid out right now
// (e.g. hidden behind another modal) — in which case the last good measurement is kept.
//
// A "Play anyway" escape hatch is always present: it's a last-resort safety valve for the guard's own
// failure modes — a bad measurement on some device, or a player whose OS rotation-lock makes the
// "rotate" prompt un-actionable — so we never hard-lock someone out with no recourse. Dismissing only
// holds for the viewport size it was tapped at: resize/rotate to a meaningfully different unrecommended
// dimension and the guard re-arms and prompts again.
export class ViewportGuard {
  private readonly root_: HTMLElement
  private readonly glyphEl_: HTMLElement
  private readonly titleEl_: HTMLElement
  private readonly bodyEl_: HTMLElement
  private readonly measure_: () => number | null
  private readonly onChange_: () => void
  private readonly coarse_: boolean
  private required_ = 0
  private verdict_: ViewportVerdict = 'ok'
  // The viewport size at which the player last tapped "Play anyway", or null. The dismissal holds
  // only while the size stays ~the same; a resize/rotate to a meaningfully different viewport re-arms
  // the guard, so landing on a fresh unrecommended dimension prompts again.
  private dismissedSize_: { w: number; h: number } | null = null
  // Dev override (?guard=rotate|small|off) to force a state for a visual playtest without contriving
  // a tiny viewport. null = normal behaviour.
  private readonly forced_: ViewportVerdict | null

  // `mount` is the element to append the modal to — the stage CONTAINER, not the HUD overlay: the
  // overlay fades to opacity 0 during the intro, which would drag a nested modal invisible with it.
  constructor(mount: HTMLElement, measure: () => number | null) {
    this.measure_ = measure
    this.coarse_ = coarsePointer()
    this.forced_ = readForcedVerdict()

    const root = document.createElement('div')
    root.className = 'viewport-guard is-hidden'
    root.setAttribute('role', 'alertdialog')
    root.setAttribute('aria-live', 'assertive')
    const card = document.createElement('div')
    card.className = 'viewport-guard__card'
    this.glyphEl_ = document.createElement('div')
    this.glyphEl_.className = 'viewport-guard__glyph'
    this.titleEl_ = document.createElement('div')
    this.titleEl_.className = 'viewport-guard__title'
    this.bodyEl_ = document.createElement('div')
    this.bodyEl_.className = 'viewport-guard__body'
    // Escape hatch — deliberately low-emphasis (small underlined link) so it reads as a last resort,
    // not the default action. Holds only for the current viewport size (see dismissedSize_).
    const dismiss = document.createElement('button')
    dismiss.className = 'viewport-guard__dismiss'
    dismiss.type = 'button'
    dismiss.textContent = 'Play anyway'
    dismiss.addEventListener('click', () => {
      this.dismissedSize_ = this.currentSize_()
      this.apply_('ok')
    })
    card.append(this.glyphEl_, this.titleEl_, this.bodyEl_, dismiss)
    root.appendChild(card)
    mount.appendChild(root)
    this.root_ = root

    this.onChange_ = () => this.evaluate()
    window.addEventListener('resize', this.onChange_)
    window.addEventListener('orientationchange', this.onChange_)
    window.visualViewport?.addEventListener('resize', this.onChange_)
    this.evaluate()
  }

  // Re-measure, re-classify, and show/hide the modal. Cheap and idempotent — safe to call from a
  // resize/orientation event or after a layout change (e.g. the opening buttons revealing).
  evaluate(): void {
    const measured = this.measure_()
    if (measured !== null && measured > 0) {
      this.required_ = measured
    }
    const { w: width, h: height } = this.currentSize_()
    // "Play anyway" holds only for the size it was dismissed at: while the viewport stays ~the same,
    // stay out of the way; a resize/rotate past the re-arm threshold clears it so a fresh
    // unrecommended dimension prompts again.
    if (this.dismissedSize_) {
      if (Math.abs(width - this.dismissedSize_.w) <= REARM_PX && Math.abs(height - this.dismissedSize_.h) <= REARM_PX) {
        this.apply_('ok')
        return
      }
      this.dismissedSize_ = null
    }
    if (this.forced_ !== null) {
      this.apply_(this.forced_)
      return
    }
    // Nothing measured yet (column never laid out) → assume it fits; don't wall on a guess.
    if (this.required_ <= 0) {
      this.apply_('ok')
      return
    }
    // Stickiness once shown: pretend we have a touch less height so a few px of wobble can't flap it.
    const availableHeight = this.verdict_ !== 'ok' ? height - HYSTERESIS_PX : height
    this.apply_(
      classifyViewport({
        availableHeight,
        availableWidth: width,
        requiredHeight: this.required_,
        coarsePointer: this.coarse_,
      }),
    )
  }

  // Usable viewport size in CSS px — the smaller of layout- and visual-viewport on each axis, so
  // mobile browser chrome can't make us over-report the room we have. (No text inputs exist here, so
  // the on-screen keyboard never shrinks this.)
  private currentSize_(): { w: number; h: number } {
    const vv = window.visualViewport
    return {
      w: Math.min(window.innerWidth, vv?.width ?? window.innerWidth),
      h: Math.min(window.innerHeight, vv?.height ?? window.innerHeight),
    }
  }

  // Whether the guard is currently blocking play (modal up). Callers can use this to suppress input.
  isBlocking(): boolean {
    return this.verdict_ !== 'ok'
  }

  dispose(): void {
    window.removeEventListener('resize', this.onChange_)
    window.removeEventListener('orientationchange', this.onChange_)
    window.visualViewport?.removeEventListener('resize', this.onChange_)
    this.root_.remove()
  }

  private apply_(verdict: ViewportVerdict): void {
    if (verdict === this.verdict_) {
      return
    }
    this.verdict_ = verdict
    if (verdict === 'ok') {
      this.root_.classList.add('is-hidden')
      return
    }
    const copy = COPY[verdict]
    this.glyphEl_.innerHTML = GLYPH[verdict]
    this.titleEl_.textContent = copy.title
    this.bodyEl_.textContent = copy.body
    this.root_.classList.remove('is-hidden')
  }
}

// Touch/stylus devices report a coarse primary pointer; desktop mice report fine. maxTouchPoints is
// a fallback for engines without the media query. Guarded so it's safe in a non-DOM test env.
function coarsePointer(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
    return true
  }
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
}

// Dev-only: ?guard=rotate | small | off forces the modal state for a visual playtest.
function readForcedVerdict(): ViewportVerdict | null {
  if (typeof window === 'undefined' || !import.meta.env.DEV) {
    return null
  }
  const v = new URLSearchParams(window.location.search).get('guard')
  if (v === 'rotate') return 'rotate'
  if (v === 'small') return 'too-small'
  if (v === 'off') return 'ok'
  return null
}
