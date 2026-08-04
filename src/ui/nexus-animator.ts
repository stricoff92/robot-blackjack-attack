// Timing for the table nexus's twin emitter lights + its cooling vent.
//
// At rest both lenses — the red laser muzzle and the yellow token vent — sit dim.
// The two lights are driven INDEPENDENTLY (render/nexus.ts owns the drawing; this
// owns timing, with absolute performance.now() stamps):
//
//   • anticipate() — the hand resolved and the nexus is WAITING for Next hand; both
//     lights hold a steady anticipation glow until then.
//   • fire() — the player called it: the YELLOW light flares while the reward
//     tokens distribute and fades the instant they land; the RED light holds its
//     charge, then blasts to full for the laser strike and fades afterwards. So the
//     two lights come down on their own schedules, not together.
//   • pulseYellow() — a one-shot pulse on the yellow light as a reward token flies
//     out after a surviving hit (the red laser light stays dim).
//
// While anticipating, the red light also "powers up": a stream of energy balls draw
// into it (see chargeUp() — the geometry/motion is render/nexus.ts's). After the
// laser, the nexus vents cooling steam for VENT_MS (see ventAge()).

import { CHARGE_MAX_LIFE_MS } from '../render/nexus'
import { arch2, smoothEnd2 } from '../render/easing'

const ANT_LEVEL = 0.6 // steady glow while waiting for Next hand
const ANT_IN_MS = 260 // dim → anticipation glow

const YELLOW_IN_MS = 90 // flare up as tokens start distributing
const YELLOW_FADE_MS = 200 // fade the instant distribution finishes
const RED_IN_MS = 130 // charge → full blast for the laser
const RED_FADE_MS = 470 // wind down after the strike

const PULSE_MS = 520 // yellow hit-token pulse
const PULSE_PEAK = 0.9

export const VENT_MS = 1000 // steam emits for this long after the laser...
const VENT_TAIL_MS = 220 // ...plus a tail so the last short-lived puffs finish

export interface NexusChargeView {
  // Each emitter light's glow, 0 (dim) .. 1 (fully lit), at `now`.
  redLight(now: number): number
  yellowLight(now: number): number
  // Elapsed ms into the cooling-steam vent (0 .. VENT_MS + tail), or null if the
  // nexus isn't venting.
  ventAge(now: number): number | null
  // The powering-up window for the energy-ball stream: `start` is when charging
  // began, `cap` the latest a ball may spawn (advances with `now` while charging,
  // freezes at the Next-hand click). Null when nothing is charging.
  chargeUp(now: number): { start: number; cap: number } | null
}

export class NexusAnimation implements NexusChargeView {
  // Anticipation (both lights), held until fired.
  private antStart = 0
  private antHeld = false

  // Firing: captured at fire(). The two lights ride separate flare windows.
  private fired = false
  private fireFrom = 0 // level both flares start from (the anticipation glow)
  private yFlare = false // whether the yellow token flare is active this fire
  private yStart = 0
  private yHold = 0 // yellow full until here (tokens distributed)
  private rStart = 0 // red blasts to full here (the laser fires)
  private rHold = 0 // red full until here (the strike lands)
  private fireEnd = 0 // everything (incl. the vent) done by here

  // Cooling vent window.
  private coolStart = 0
  private coolEnd = 0

  // Powering-up: the energy-ball stream that draws into the red light while it
  // charges. Spawns from `chargeStart`, capped at the Next-hand click (`chargeCap`).
  private charging = false
  private chargeStart = 0
  private chargeCap = 0

  // Yellow hit pulse.
  private pulseStart = 0
  private pulseEnd = 0

  // The hand resolved and the nexus is waiting for Next hand: both lights come up
  // to a steady anticipation glow and hold there, while the red light powers up by
  // drawing in energy balls — until fire() (or a new deal).
  anticipate(now: number): void {
    this.antStart = now
    this.antHeld = true
    this.fired = false
    this.fireEnd = 0
    this.charging = true
    this.chargeStart = now
  }

  // Next hand called. `laserStart`/`laserEnd` bracket the red laser strike; the red
  // light holds its charge until laserStart, blasts to full, then fades after
  // laserEnd (with the steam vent). `tokensEnd` is when the yellow token
  // distribution finishes (yellow fades then) — pass null for the final blow, which
  // pays out no tokens.
  fire(now: number, laserStart: number, laserEnd: number, tokensEnd: number | null): void {
    // Stop spawning energy balls at the click; those already drawn in keep going.
    // A final blow (no prior anticipation) never charged, so there's nothing to keep.
    if (this.antHeld) {
      this.chargeCap = now
    } else {
      this.charging = false
    }
    this.fireFrom = this.antHeld ? this.antLevel(now) : 0
    this.antHeld = false
    this.fired = true

    this.yFlare = tokensEnd !== null
    this.yStart = now
    this.yHold = tokensEnd ?? now
    const yEnd = this.yHold + YELLOW_FADE_MS

    this.rStart = laserStart
    this.rHold = laserEnd
    const rEnd = laserEnd + RED_FADE_MS

    this.coolStart = laserEnd
    this.coolEnd = laserEnd + VENT_MS + VENT_TAIL_MS
    this.fireEnd = Math.max(yEnd, rEnd, this.coolEnd)
  }

  // A one-shot pulse on the yellow light as a reward token lifts off (surviving
  // hit). Independent of the shared glow, so it reads even from the dim state.
  pulseYellow(startAfter: number): void {
    this.pulseStart = startAfter
    this.pulseEnd = startAfter + PULSE_MS
  }

  redLight(now: number): number {
    if (this.antHeld) {
      return this.antLevel(now)
    }
    if (this.fired) {
      return flareLevel(now, this.fireFrom, this.rStart, this.rHold, RED_FADE_MS, RED_IN_MS)
    }
    return 0
  }

  yellowLight(now: number): number {
    let y = 0
    if (this.antHeld) {
      y = this.antLevel(now)
    } else if (this.fired) {
      if (this.yFlare) {
        y = flareLevel(now, this.fireFrom, this.yStart, this.yHold, YELLOW_FADE_MS, YELLOW_IN_MS)
      } else {
        // No token flare this fire (the reward already flew on the resolve): just
        // ease the anticipation glow out instead of snapping it off.
        y = this.fireFrom * (1 - smoothEnd2(clamp01((now - this.yStart) / YELLOW_FADE_MS)))
      }
    }
    return Math.max(y, this.pulse(now))
  }

  ventAge(now: number): number | null {
    if (!this.fired || now < this.coolStart || now >= this.coolEnd) {
      return null
    }
    return now - this.coolStart
  }

  chargeUp(now: number): { start: number; cap: number } | null {
    if (!this.charging) {
      return null
    }
    if (this.antHeld) {
      return { start: this.chargeStart, cap: now } // still spawning, up to now
    }
    // Fired: no new balls after the click, and the last in-flight one is done a
    // ball-lifetime later.
    if (now >= this.chargeCap + CHARGE_MAX_LIFE_MS) {
      return null
    }
    return { start: this.chargeStart, cap: this.chargeCap }
  }

  // True while something is actively CHANGING — including the powering-up stream,
  // which animates continuously through the whole anticipation wait (so the loop
  // runs while the player deliberates, rather than parking).
  isAnimating(now: number): boolean {
    if (this.charging) {
      if (this.antHeld) {
        return true // powering up: energy balls spawning continuously
      }
      if (now < this.chargeCap + CHARGE_MAX_LIFE_MS) {
        return true // fired: the last drawn-in balls finishing
      }
    }
    if (this.fired && now < this.fireEnd) {
      return true
    }
    return now < this.pulseEnd
  }

  private antLevel(now: number): number {
    return ANT_LEVEL * clamp01((now - this.antStart) / ANT_IN_MS)
  }

  private pulse(now: number): number {
    if (now < this.pulseStart || now >= this.pulseEnd) {
      return 0
    }
    return PULSE_PEAK * arch2((now - this.pulseStart) / PULSE_MS)
  }
}

// A light flaring to full: sits at `from` until `start`, ramps to 1 over `inMs`,
// holds until `hold`, then fades to 0 over `fade`.
function flareLevel(now: number, from: number, start: number, hold: number, fade: number, inMs: number): number {
  if (now < start) {
    return from
  }
  if (now >= hold + fade) {
    return 0
  }
  if (now < hold) {
    return from + (1 - from) * clamp01((now - start) / inMs)
  }
  return 1 - smoothEnd2(clamp01((now - hold) / fade))
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
