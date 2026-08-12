// Timing/state for the dealer-6 clown sidekick. Mirrors DealerAnimation ↔ render/dealer.ts:
// this owns the clown's state (absolute performance.now() stamps), render/clown.ts owns the
// drawing. Unlike the dealer, the clown isn't driven by the game's action sequencing — it simply
// SHADOWS dealer 6. Once per frame the view calls observe(dealer, now), which reads the dealer's
// public state (which dealer is on screen, and whether it's arriving / dying / leaving) and runs
// the clown's little walk-in → stand → walk-off state machine off those edges:
//
//   • dealer 6 walks in            → the clown trots on a beat behind it (CLOWN_FOLLOW_DELAY)
//   • dealer 6 stands              → the clown stands to its right
//   • dealer 6 dies (is destroyed) → the clown laughs, then strides off  (observe returns 'death')
//   • dealer 6 walks off (a loss)  → the clown follows it off a beat behind
//
// The clown's LAUGH (mouth + audio) is triggered from the view: on the 'death' event it returns,
// and whenever the dealer's own laugh emote changes (the view mirrors it onto the clown, delayed).

import { TOTAL_DEALERS } from '../game/run'
import { voiceEnvelope, type VoicePattern } from '../audio/voice'
import { KILL_ARRIVE_MS } from './dealer-animator'
import type { DealerView, VoiceEmote } from '../render/dealer'
import type { ClownView } from '../render/clown'

// The clown trails the dealer by this long — both entering (it trots on a beat late) and leaving
// (it follows the dealer off). Long enough to read as "following", short enough to feel attached.
const CLOWN_FOLLOW_DELAY = 420
// On dealer 6's DEATH the clown reacts in place — a beat of cackling at the wreckage — before it
// turns and strides off. Its laugh (fired by the view) lands at the death; the walk-off starts here.
const CLOWN_DEATH_REACT_DELAY = 300

type Mode = 'hidden' | 'walkin' | 'stand' | 'walkoff'

export class ClownAnimation implements ClownView {
  private mode_: Mode = 'hidden'
  private walkInStart_ = 0
  private walkOffStart_ = 0
  private emoteStart_ = 0
  private emotePattern_: VoicePattern | null = null

  // Advance the clown's state from the dealer's, once per frame. Returns 'death' on the single
  // frame it reacts to dealer 6 being destroyed (so the caller can fire the clown's death laugh),
  // otherwise null. Idempotent per transition — the mode change stops it re-firing.
  observe(dealer: DealerView, now: number): 'death' | null {
    // figureShift is the dealer on screen right NOW; TOTAL_DEALERS (6) is the RGB final dealer.
    // A dying dealer 6 keeps reporting shift 6 (no replacement walks in), so the death is caught.
    const isD6 = dealer.figureShift(now) === TOTAL_DEALERS
    const arriving = dealer.arriving(now)
    const dying = dealer.dying(now)
    const leaving = dealer.leaving(now)
    const alive = dealer.alive(now)

    switch (this.mode_) {
      case 'hidden':
        if (isD6 && dying === null) {
          if (arriving !== null) {
            // Dealer 6 is walking in — trot on a beat behind it.
            this.mode_ = 'walkin'
            this.walkInStart_ = now + CLOWN_FOLLOW_DELAY
          } else if (alive && leaving === null) {
            // Dealer 6 is already standing (a resumed run / dev start at dealer 6): just appear.
            this.mode_ = 'stand'
          }
        }
        break
      case 'walkin':
        if (isD6 && dying !== null) {
          return this.startDeathWalkOff_(now)
        }
        if (isD6 && leaving !== null) {
          this.mode_ = 'walkoff'
          this.walkOffStart_ = now + CLOWN_FOLLOW_DELAY
        } else if (now >= this.walkInStart_ + KILL_ARRIVE_MS) {
          this.mode_ = 'stand'
        }
        break
      case 'stand':
        if (isD6 && dying !== null) {
          return this.startDeathWalkOff_(now)
        }
        if (isD6 && leaving !== null) {
          // Dealer 6 strode off (game over): follow it off a beat behind.
          this.mode_ = 'walkoff'
          this.walkOffStart_ = now + CLOWN_FOLLOW_DELAY
        } else if (!isD6 && dying === null && leaving === null) {
          // The figure is no longer dealer 6 and isn't transitioning — nothing to shadow.
          this.mode_ = 'hidden'
        }
        break
      case 'walkoff':
        if (now >= this.walkOffStart_ + KILL_ARRIVE_MS) {
          this.mode_ = 'hidden'
        }
        break
    }
    return null
  }

  private startDeathWalkOff_(now: number): 'death' {
    this.mode_ = 'walkoff'
    this.walkOffStart_ = now + CLOWN_DEATH_REACT_DELAY // laugh in place, then turn and go
    return 'death'
  }

  // Arm a laugh emote at `start` (absolute), shaped by `pattern` — the mouth reads the shared
  // voiceEnvelope so its grin opens in step with the audio. Overwriting simply restarts.
  emote(start: number, pattern: VoicePattern): void {
    this.emoteStart_ = start
    this.emotePattern_ = pattern
  }

  // --- ClownView ---------------------------------------------------------------

  present(now: number): boolean {
    switch (this.mode_) {
      case 'hidden':
        return false
      case 'walkin':
        return now >= this.walkInStart_ // hidden during the follow-delay, before the slide starts
      case 'stand':
        return true
      case 'walkoff':
        return now < this.walkOffStart_ + KILL_ARRIVE_MS
    }
  }

  arriving(now: number): number | null {
    if (this.mode_ !== 'walkin') {
      return null
    }
    const p = (now - this.walkInStart_) / KILL_ARRIVE_MS
    return p >= 0 && p < 1 ? p : null
  }

  leaving(now: number): number | null {
    if (this.mode_ !== 'walkoff') {
      return null
    }
    const p = (now - this.walkOffStart_) / KILL_ARRIVE_MS
    return p >= 0 && p < 1 ? p : null
  }

  voice(now: number): VoiceEmote | null {
    const pattern = this.emotePattern_
    if (!pattern) {
      return null
    }
    const env = voiceEnvelope(pattern, now - this.emoteStart_)
    if (!env) {
      return null
    }
    return {
      open: env.open,
      energy: env.energy,
      tint: pattern.tint,
      waveCount: pattern.waveCount,
      cycles: pattern.waveCycles,
      flowHz: pattern.waveFlowHz,
    }
  }
}
