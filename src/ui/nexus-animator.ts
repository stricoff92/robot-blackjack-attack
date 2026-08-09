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
// beam that lifts off, reaches the dealer, then holds while the dealer's health
// refills and fades. The three windows are EXPORTED so game-view can time the beat
// (beam travel, health refill, fade) against them — they can't drift.
export const HEAL_TRAVEL_MS = 360 // beam floats nexus → dealer (softer than the laser)
export const HEAL_RISE_MS = 840 // the dealer's health refills while the beam holds on it
export const HEAL_FADE_MS = 390 // beam + emitter glow wind down after the fill
const HEAL_GLOW_IN_MS = 130 // the utility emitter lights up green as the beam lifts off
const HEAL_GLOW_PEAK = 0.85 // how bright the green lens runs while healing

export interface NexusChargeView {
  // The utility lens glowing, 0 (dim) .. 1 (fully lit), at `now`, per colour channel.
  // Only one channel is ever non-zero at a time (the effects are sequenced).
  // The red laser charge/blast glow.
  redLight(now: number): number
  // The green heal glow — shown on the same utility lens while a heal beam is in flight.
  healLight(now: number): number
  // The yellow token-vent pulse.
  yellowLight(now: number): number
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
  private antStart_ = 0
  private antHeld_ = false

  // Firing the red laser: captured at fire().
  private fired_ = false
  private fireFrom_ = 0 // level the red blast starts from (the anticipation glow)
  private rStart_ = 0 // red blasts to full here (the laser fires)
  private rHold_ = 0 // red full until here (the strike lands)
  private fireEnd_ = 0 // everything done by here

  // Powering-up: the energy-ball stream that draws into the utility light while it
  // charges. Spawns from `chargeStart`, capped at the Next-hand click (`chargeCap`).
  private charging_ = false
  private chargeStart_ = 0
  private chargeCap_ = 0

  // Yellow token pulse.
  private pulseStart_ = 0
  private pulseEnd_ = 0

  // Green heal beam (a late dealer repairing itself): the emitter flares, a beam
  // lifts off at healStart, reaches the dealer at healContact (its bar starts
  // rising), holds through the fill until healHold, then fades out by healEnd.
  private healing_ = false
  private healStart_ = 0
  private healContact_ = 0
  private healHold_ = 0
  private healEnd_ = 0

  // The reward tokens have flown and the nexus is now waiting for Next hand: the
  // utility light comes up to a steady RED anticipation glow and holds there, powering
  // up by drawing in energy balls — until fire() (or a new deal). Scheduled to begin at
  // `now` (which the caller sets to AFTER the yellow token pulse has finished, so the
  // one lens never shows red and yellow at once).
  anticipate(now: number): void {
    this.antStart_ = now
    this.antHeld_ = true
    this.fired_ = false
    this.fireEnd_ = 0
    this.charging_ = true
    this.chargeStart_ = now
  }

  // Next hand called. `laserStart`/`laserEnd` bracket the red laser strike; the utility
  // light holds its red charge until laserStart, blasts to full, then fades after
  // laserEnd.
  fire(now: number, laserStart: number, laserEnd: number): void {
    // Stop spawning energy balls at the click; those already drawn in keep going.
    // A final blow (no prior anticipation) never charged, so there's nothing to keep.
    if (this.antHeld_) {
      this.chargeCap_ = now
    } else {
      this.charging_ = false
    }
    this.fireFrom_ = this.antHeld_ ? this.antLevel_(now) : 0
    this.antHeld_ = false
    this.fired_ = true

    this.rStart_ = laserStart
    this.rHold_ = laserEnd
    this.fireEnd_ = laserEnd + RED_FADE_MS
  }

  // A one-shot YELLOW pulse on the utility light as reward tokens shoot out of it — a
  // surviving hit, or each winning hand on the resolve. It's the ONLY thing lighting the
  // lens at that point (the red charge is scheduled for after the tokens have flown).
  pulseYellow(startAfter: number): void {
    this.pulseStart_ = startAfter
    this.pulseEnd_ = startAfter + PULSE_MS
  }

  // Fire the green heal beam at the dealer, starting at `startAfter`: the emitter
  // flares, a beam floats out over HEAL_TRAVEL_MS, then holds on the dealer for
  // HEAL_RISE_MS (the dealer's health refills over the same window) before fading. Drives
  // the green glow on the utility lens too, so it glows for the duration.
  heal(startAfter: number): void {
    this.healing_ = true
    this.healStart_ = startAfter
    this.healContact_ = startAfter + HEAL_TRAVEL_MS
    this.healHold_ = this.healContact_ + HEAL_RISE_MS
    this.healEnd_ = this.healHold_ + HEAL_FADE_MS
  }

  // The green heal beam's head-of-travel + opacity, or null. Advances to the dealer,
  // holds solid while the bar fills, then fades — mirrors the red StrikeView.beam.
  healBeam(now: number): { travel: number; alpha: number } | null {
    if (!this.healing_ || now < this.healStart_ || now >= this.healEnd_) {
      return null
    }
    if (now < this.healContact_) {
      return { travel: (now - this.healStart_) / HEAL_TRAVEL_MS, alpha: 1 }
    }
    if (now < this.healHold_) {
      return { travel: 1, alpha: 1 }
    }
    return { travel: 1, alpha: 1 - smoothEnd2((now - this.healHold_) / HEAL_FADE_MS) }
  }

  // True while the heal beam is still on screen — used to hold the Next-hand button
  // (and the result message) until the repair finishes, so it always reads in full.
  isHealing(now: number): boolean {
    return this.healing_ && now < this.healEnd_
  }

  redLight(now: number): number {
    if (this.antHeld_) {
      return this.antLevel_(now)
    }
    if (this.fired_) {
      return flareLevel(now, this.fireFrom_, this.rStart_, this.rHold_, RED_FADE_MS, RED_IN_MS)
    }
    return 0
  }

  // The green heal glow on the utility lens — lit only while a heal beam is in flight.
  healLight(now: number): number {
    return this.healGlow_(now)
  }

  // Yellow is ONLY the token-vent pulse now (the anticipation/laser glow is red's job,
  // and the two never overlap on the shared lens — the red charge is scheduled for after
  // the tokens have flown).
  yellowLight(now: number): number {
    return this.pulse_(now)
  }

  chargeUp(now: number): { start: number; cap: number } | null {
    if (!this.charging_) {
      return null
    }
    if (this.antHeld_) {
      return { start: this.chargeStart_, cap: now } // still spawning, up to now
    }
    // Fired: no new balls after the click, and the last in-flight one is done a
    // ball-lifetime later.
    if (now >= this.chargeCap_ + CHARGE_MAX_LIFE_MS) {
      return null
    }
    return { start: this.chargeStart_, cap: this.chargeCap_ }
  }

  // True while something is actively CHANGING — including the powering-up stream,
  // which animates continuously through the whole anticipation wait (so the loop
  // runs while the player deliberates, rather than parking).
  isAnimating(now: number): boolean {
    if (this.charging_) {
      if (this.antHeld_) {
        return true // powering up: energy balls spawning continuously
      }
      if (now < this.chargeCap_ + CHARGE_MAX_LIFE_MS) {
        return true // fired: the last drawn-in balls finishing
      }
    }
    if (this.fired_ && now < this.fireEnd_) {
      return true
    }
    if (this.isHealing(now)) {
      return true
    }
    return now < this.pulseEnd_
  }

  private antLevel_(now: number): number {
    return ANT_LEVEL * clamp01((now - this.antStart_) / ANT_IN_MS)
  }

  // The green emitter's glow while a heal beam is in flight: lights up as the beam
  // lifts off, holds full through the fill, then winds down with the beam's fade.
  private healGlow_(now: number): number {
    if (!this.healing_ || now < this.healStart_ || now >= this.healEnd_) {
      return 0
    }
    if (now < this.healStart_ + HEAL_GLOW_IN_MS) {
      return HEAL_GLOW_PEAK * clamp01((now - this.healStart_) / HEAL_GLOW_IN_MS)
    }
    if (now < this.healHold_) {
      return HEAL_GLOW_PEAK
    }
    return HEAL_GLOW_PEAK * (1 - smoothEnd2((now - this.healHold_) / HEAL_FADE_MS))
  }

  private pulse_(now: number): number {
    if (now < this.pulseStart_ || now >= this.pulseEnd_) {
      return 0
    }
    return PULSE_PEAK * arch2((now - this.pulseStart_) / PULSE_MS)
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
