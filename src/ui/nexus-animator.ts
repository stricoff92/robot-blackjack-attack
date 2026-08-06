// Timing for the table nexus's twin emitter lights.
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
// into it (see chargeUp() — the geometry/motion is render/nexus.ts's).

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

// --- the heal beam (a late dealer repairing itself after a win) -----------------
// The counterpart to the red laser strike, fired from the GREEN emitter: a gentle
// beam that lifts off, reaches the dealer, then holds while its health bar refills
// and fades. The three windows are EXPORTED so health-animator.ts locks its refill
// to the same HEAL_RISE_MS (they can't drift), and game-view can time the beat.
export const HEAL_TRAVEL_MS = 240 // beam floats nexus → dealer (softer than the laser)
export const HEAL_RISE_MS = 560 // the health bar fills while the beam holds on the dealer
export const HEAL_FADE_MS = 260 // beam + emitter glow wind down after the fill
const HEAL_GLOW_IN_MS = 130 // the yellow emitter lights up as the beam lifts off
const HEAL_GLOW_PEAK = 0.85 // how bright the yellow lens runs while healing

// --- the holo projector (bottom-left lens) --------------------------------------
// A soft power ramp on/off. Between showHolo()/hideHolo() it holds fully lit (and
// cycling colours — the hue drift lives in render/nexus.ts) while it casts a table
// projection, e.g. the end-of-game scoreboard.
const HOLO_IN_MS = 380 // power-on ramp
const HOLO_OUT_MS = 320 // power-off fade

export interface NexusChargeView {
  // Each emitter light's glow, 0 (dim) .. 1 (fully lit), at `now`.
  redLight(now: number): number
  // The heal glow (green) — shown on the RED lens, which also fires the laser.
  healLight(now: number): number
  yellowLight(now: number): number
  // The holo projector's power level, 0 (dark) .. 1 (fully lit + cycling), at `now`.
  holoLight(now: number): number
  // The powering-up window for the energy-ball stream: `start` is when charging
  // began, `cap` the latest a ball may spawn (advances with `now` while charging,
  // freezes at the Next-hand click). Null when nothing is charging.
  chargeUp(now: number): { start: number; cap: number } | null
  // The yellow heal beam's head-of-travel (0..1 from nexus to dealer) + its opacity,
  // or null when no heal is in flight.
  healBeam(now: number): { travel: number; alpha: number } | null
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
  private fireEnd = 0 // everything done by here

  // Powering-up: the energy-ball stream that draws into the red light while it
  // charges. Spawns from `chargeStart`, capped at the Next-hand click (`chargeCap`).
  private charging = false
  private chargeStart = 0
  private chargeCap = 0

  // Yellow hit pulse.
  private pulseStart = 0
  private pulseEnd = 0

  // Yellow heal beam (a late dealer repairing itself): the emitter flares, a beam
  // lifts off at healStart, reaches the dealer at healContact (its bar starts
  // rising), holds through the fill until healHold, then fades out by healEnd.
  private healing = false
  private healStart = 0
  private healContact = 0
  private healHold = 0
  private healEnd = 0

  // Holo projector: on/off with a soft power ramp. `holoOn` holds it lit; when turned
  // off it eases down from `holoOffFrom` (its level at the moment it was hidden).
  private holoOn = false
  private holoStart = 0 // when the power-on ramp began
  private holoOffAt = 0 // when the power-off began (0 while on / never shown)
  private holoOffFrom = 0 // level at power-off, so the fade eases from wherever it was

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
  // laserEnd. `tokensEnd` is when the yellow token distribution finishes (yellow
  // fades then) — pass null for the final blow, which pays out no tokens.
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

    this.fireEnd = Math.max(yEnd, rEnd)
  }

  // A one-shot pulse on the yellow light as a reward token lifts off (surviving
  // hit). Independent of the shared glow, so it reads even from the dim state.
  pulseYellow(startAfter: number): void {
    this.pulseStart = startAfter
    this.pulseEnd = startAfter + PULSE_MS
  }

  // Fire the yellow heal beam at the dealer, starting at `startAfter`: the emitter
  // flares, a beam floats out over HEAL_TRAVEL_MS, then holds on the dealer for
  // HEAL_RISE_MS (its health bar refills over the same window) before fading. Drives
  // the yellow light itself too, so the lens glows for the duration.
  heal(startAfter: number): void {
    this.healing = true
    this.healStart = startAfter
    this.healContact = startAfter + HEAL_TRAVEL_MS
    this.healHold = this.healContact + HEAL_RISE_MS
    this.healEnd = this.healHold + HEAL_FADE_MS
  }

  // The yellow heal beam's head-of-travel + opacity, or null. Advances to the dealer,
  // holds solid while the bar fills, then fades — mirrors the red StrikeView.beam.
  healBeam(now: number): { travel: number; alpha: number } | null {
    if (!this.healing || now < this.healStart || now >= this.healEnd) {
      return null
    }
    if (now < this.healContact) {
      return { travel: (now - this.healStart) / HEAL_TRAVEL_MS, alpha: 1 }
    }
    if (now < this.healHold) {
      return { travel: 1, alpha: 1 }
    }
    return { travel: 1, alpha: 1 - smoothEnd2((now - this.healHold) / HEAL_FADE_MS) }
  }

  // True while the heal beam is still on screen — used to hold the Next-hand button
  // (and the result message) until the repair finishes, so it always reads in full.
  isHealing(now: number): boolean {
    return this.healing && now < this.healEnd
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

  // The heal glow (green, shown on the red lens) — lit only while a heal beam is in flight.
  healLight(now: number): number {
    return this.healGlow(now)
  }

  // Power the holo projector on at `startAfter` (ramps up over HOLO_IN_MS, then holds
  // lit + cycling until hideHolo). Used when it starts casting a table projection.
  showHolo(startAfter: number): void {
    this.holoOn = true
    this.holoStart = startAfter
    this.holoOffAt = 0
  }

  // Power the holo projector off from `now` (eases down from its current level).
  hideHolo(now: number): void {
    if (!this.holoOn && this.holoOffAt === 0) {
      return
    }
    this.holoOffFrom = this.holoLight(now)
    this.holoOn = false
    this.holoOffAt = now
  }

  // The holo projector's power level, 0 (dark) .. 1 (fully lit). Ramps up on show,
  // holds while lit, eases out on hide.
  holoLight(now: number): number {
    if (this.holoOn) {
      return clamp01((now - this.holoStart) / HOLO_IN_MS)
    }
    if (this.holoOffAt > 0) {
      return this.holoOffFrom * (1 - smoothEnd2(clamp01((now - this.holoOffAt) / HOLO_OUT_MS)))
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
    if (this.isHealing(now)) {
      return true
    }
    return now < this.pulseEnd
  }

  private antLevel(now: number): number {
    return ANT_LEVEL * clamp01((now - this.antStart) / ANT_IN_MS)
  }

  // The green emitter's glow while a heal beam is in flight: lights up as the beam
  // lifts off, holds full through the fill, then winds down with the beam's fade.
  private healGlow(now: number): number {
    if (!this.healing || now < this.healStart || now >= this.healEnd) {
      return 0
    }
    if (now < this.healStart + HEAL_GLOW_IN_MS) {
      return HEAL_GLOW_PEAK * clamp01((now - this.healStart) / HEAL_GLOW_IN_MS)
    }
    if (now < this.healHold) {
      return HEAL_GLOW_PEAK
    }
    return HEAL_GLOW_PEAK * (1 - smoothEnd2((now - this.healHold) / HEAL_FADE_MS))
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
