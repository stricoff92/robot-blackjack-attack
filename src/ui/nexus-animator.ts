// Timing for the table nexus's utility emitter light (render/nexus.ts owns the drawing;
// this owns timing, with absolute performance.now() stamps).
//
// The utility lens sits dim at rest and lights up in ONE colour at a time — the effects
// are sequenced so they never overlap on the shared lens:
//
//   • pulseYellow() — a one-shot YELLOW pulse as reward tokens shoot out of the vent
//     (a surviving hit, or each winning hand on the resolve).
//   • anticipate() — after the tokens have flown, the RED laser "powers up": a steady
//     anticipation glow while a stream of energy balls draw into it (see chargeUp()),
//     held until Next hand.
//   • fire() — the player called it: the RED light blasts to full for the laser strike,
//     then winds down afterwards.
//   • heal() — a GREEN heal beam on a loss: the emitter glows green while the beam
//     lifts off, reaches the dealer and holds through the repair.

import { CHARGE_MAX_LIFE_MS } from '../render/nexus'
import { arch2, smoothEnd2 } from '../render/easing'

const ANT_LEVEL = 0.6 // steady red glow while waiting for Next hand
const ANT_IN_MS = 260 // dim → anticipation glow

const RED_IN_MS = 130 // charge → full blast for the laser
const RED_FADE_MS = 470 // wind down after the strike

const PULSE_MS = 520 // yellow token pulse
const PULSE_PEAK = 0.9

// --- the heal beam (a late dealer repairing itself after a win) -----------------
// The counterpart to the red laser strike, glowing the utility lens GREEN: a gentle
// beam that lifts off, reaches the dealer, then holds while its health bar refills
// and fades. The three windows are EXPORTED so health-animator.ts locks its refill
// to the same HEAL_RISE_MS (they can't drift), and game-view can time the beat.
export const HEAL_TRAVEL_MS = 240 // beam floats nexus → dealer (softer than the laser)
export const HEAL_RISE_MS = 560 // the health bar fills while the beam holds on the dealer
export const HEAL_FADE_MS = 260 // beam + emitter glow wind down after the fill
const HEAL_GLOW_IN_MS = 130 // the utility emitter lights up green as the beam lifts off
const HEAL_GLOW_PEAK = 0.85 // how bright the green lens runs while healing

// --- the holo projector (bottom lens) -------------------------------------------
// A soft power ramp on/off. Between showHolo()/hideHolo() it holds fully lit (and
// cycling colours — the hue drift lives in render/nexus.ts) while it casts a table
// projection, e.g. the end-of-game scoreboard.
const HOLO_IN_MS = 380 // power-on ramp
const HOLO_OUT_MS = 320 // power-off fade

export interface NexusChargeView {
  // The utility lens glowing, 0 (dim) .. 1 (fully lit), at `now`, per colour channel.
  // Only one channel is ever non-zero at a time (the effects are sequenced).
  // The red laser charge/blast glow.
  redLight(now: number): number
  // The green heal glow — shown on the same utility lens while a heal beam is in flight.
  healLight(now: number): number
  // The yellow token-vent pulse.
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
  // Anticipation (the red charge glow), held until fired.
  private antStart = 0
  private antHeld = false

  // Firing the red laser: captured at fire().
  private fired = false
  private fireFrom = 0 // level the red blast starts from (the anticipation glow)
  private rStart = 0 // red blasts to full here (the laser fires)
  private rHold = 0 // red full until here (the strike lands)
  private fireEnd = 0 // everything done by here

  // Powering-up: the energy-ball stream that draws into the utility light while it
  // charges. Spawns from `chargeStart`, capped at the Next-hand click (`chargeCap`).
  private charging = false
  private chargeStart = 0
  private chargeCap = 0

  // Yellow token pulse.
  private pulseStart = 0
  private pulseEnd = 0

  // Green heal beam (a late dealer repairing itself): the emitter flares, a beam
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

  // The reward tokens have flown and the nexus is now waiting for Next hand: the
  // utility light comes up to a steady RED anticipation glow and holds there, powering
  // up by drawing in energy balls — until fire() (or a new deal). Scheduled to begin at
  // `now` (which the caller sets to AFTER the yellow token pulse has finished, so the
  // one lens never shows red and yellow at once).
  anticipate(now: number): void {
    this.antStart = now
    this.antHeld = true
    this.fired = false
    this.fireEnd = 0
    this.charging = true
    this.chargeStart = now
  }

  // Next hand called. `laserStart`/`laserEnd` bracket the red laser strike; the utility
  // light holds its red charge until laserStart, blasts to full, then fades after
  // laserEnd.
  fire(now: number, laserStart: number, laserEnd: number): void {
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

    this.rStart = laserStart
    this.rHold = laserEnd
    this.fireEnd = laserEnd + RED_FADE_MS
  }

  // A one-shot YELLOW pulse on the utility light as reward tokens shoot out of it — a
  // surviving hit, or each winning hand on the resolve. It's the ONLY thing lighting the
  // lens at that point (the red charge is scheduled for after the tokens have flown).
  pulseYellow(startAfter: number): void {
    this.pulseStart = startAfter
    this.pulseEnd = startAfter + PULSE_MS
  }

  // Fire the green heal beam at the dealer, starting at `startAfter`: the emitter
  // flares, a beam floats out over HEAL_TRAVEL_MS, then holds on the dealer for
  // HEAL_RISE_MS (its health bar refills over the same window) before fading. Drives
  // the green glow on the utility lens too, so it glows for the duration.
  heal(startAfter: number): void {
    this.healing = true
    this.healStart = startAfter
    this.healContact = startAfter + HEAL_TRAVEL_MS
    this.healHold = this.healContact + HEAL_RISE_MS
    this.healEnd = this.healHold + HEAL_FADE_MS
  }

  // The green heal beam's head-of-travel + opacity, or null. Advances to the dealer,
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

  // The green heal glow on the utility lens — lit only while a heal beam is in flight.
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

  // Yellow is ONLY the token-vent pulse now (the anticipation/laser glow is red's job,
  // and the two never overlap on the shared lens — the red charge is scheduled for after
  // the tokens have flown).
  yellowLight(now: number): number {
    return this.pulse(now)
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
