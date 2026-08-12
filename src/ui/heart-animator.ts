// Timing for the player hit-point (heart-chip) VFX. Owns the pop-on-loss and heal-on-win transition
// so render/hearts.ts stays pure geometry. A pop is always one chip; a heal is one or more (beating a
// dealer heals several at once), each socket filling in a staggered cascade. Everything is a pure
// function of `now` (absolute performance.now() stamps) so a frame just samples view(now); no
// per-frame mutation, no accumulated drift.

import type { HeartsView } from '../render/hearts'
import { MAX_HEARTS } from '../game/run'

// A loss: the red laser reaches the chip fast, then the heart is blown off.
const POP_BEAM_TRAVEL = 120
const POP_BEAM_FADE = 200
const POP_GLYPH_MS = 320
// The hot spark shower off the struck chip, timed from the laser's contact (= glyphStart). Outlasts
// the glyph so the flecks are still raining down as the heart finishes popping off.
const POP_SPARK_MS = 430
// A heal: the restorative band drifts across slower, then a heart drops into the socket.
const HEAL_BEAM_TRAVEL = 300
const HEAL_BEAM_FADE = 260
const HEAL_GLYPH_MS = 380
// Delay between successive hearts filling in on a multi-heart heal (a kill), so they cascade.
const HEAL_STAGGER = 110

interface Transition {
  kind: 'pop' | 'heal'
  from: number // filled count before the change
  to: number // filled count after
  slots: number[] // the row indices that change (the popped slot, or each newly filled slot)
  beamStart: number
  beamEnd: number
  glyphStart: number // = beam contact; the first glyph begins here
  glyphStagger: number // per-slot delay for a multi-heart heal (0 for a pop)
  glyphMs: number
  commitAt: number // when `filled` flips from `from` to `to`
  end: number // when the whole effect (glyphs + beam) is done
}

export class HeartAnimation {
  // The settled filled count once no transition is running. The live view LAGS this during a pop/
  // heal (the chip only commits when its glyph finishes), so this is the source of truth between
  // effects, kept in step by every pop()/heal()/sync().
  private committed_ = MAX_HEARTS
  private t_: Transition | null = null

  // Adopt a filled count with no animation (new run, resume paint, or a round that didn't change
  // hearts). Cancels any in-flight transition.
  sync(filled: number): void {
    this.committed_ = clampCount(filled)
    this.t_ = null
  }

  // Schedule the heart lost on a losing round: a red laser strikes the last full chip at `startAt`,
  // then its heart pops. No-op if there's nothing to lose.
  pop(startAt: number): void {
    this.settle_()
    if (this.committed_ <= 0) {
      return
    }
    const from = this.committed_
    const to = from - 1
    const glyphStart = startAt + POP_BEAM_TRAVEL
    this.t_ = {
      kind: 'pop',
      from,
      to,
      slots: [to], // the emptied slot
      beamStart: startAt,
      beamEnd: startAt + POP_BEAM_TRAVEL + POP_BEAM_FADE,
      glyphStart,
      glyphStagger: 0,
      glyphMs: POP_GLYPH_MS,
      commitAt: glyphStart, // the chip empties the instant the heart is blown off
      end: Math.max(glyphStart + POP_GLYPH_MS, glyphStart + POP_SPARK_MS, startAt + POP_BEAM_TRAVEL + POP_BEAM_FADE),
    }
  }

  // Schedule the `count` hearts gained on a qualifying win: a green beam lands on the first empty
  // socket at `startAt`, then hearts fade in one-by-one. Clamped to MAX_HEARTS; no-op at full.
  heal(count: number, startAt: number): void {
    this.settle_()
    const from = this.committed_
    const to = Math.min(MAX_HEARTS, from + Math.max(0, count))
    if (to <= from) {
      return
    }
    const slots: number[] = []
    for (let i = from; i < to; i += 1) {
      slots.push(i)
    }
    const glyphStart = startAt + HEAL_BEAM_TRAVEL
    const lastGlyphEnd = glyphStart + (slots.length - 1) * HEAL_STAGGER + HEAL_GLYPH_MS
    this.t_ = {
      kind: 'heal',
      from,
      to,
      slots,
      beamStart: startAt,
      beamEnd: startAt + HEAL_BEAM_TRAVEL + HEAL_BEAM_FADE,
      glyphStart,
      glyphStagger: HEAL_STAGGER,
      glyphMs: HEAL_GLYPH_MS,
      commitAt: lastGlyphEnd, // the sockets stay empty until the incoming hearts have all faded in
      end: Math.max(lastGlyphEnd, startAt + HEAL_BEAM_TRAVEL + HEAL_BEAM_FADE),
    }
  }

  // When the current effect finishes (used by game-view to keep the Next-hand consent gate open
  // until the heart has fully popped / healed). Equal to `now` when nothing is animating.
  animEndAfter(now: number): number {
    return this.t_ ? this.t_.end : now
  }

  isAnimating(now: number): boolean {
    return this.t_ !== null && now < this.t_.end
  }

  view(now: number): HeartsView {
    const t = this.t_
    if (!t || now >= t.end) {
      // Nothing running (or the last effect just ended): draw the settled row.
      const filled = t ? t.to : this.committed_
      return { filled, max: MAX_HEARTS, transients: [], beam: null, spark: null }
    }

    const filled = now < t.commitAt ? t.from : t.to

    const transients: HeartsView['transients'] = []
    if (t.kind === 'pop') {
      // The departing heart overlays its (already-empty) slot for its fade-out window.
      if (now >= t.glyphStart && now < t.glyphStart + t.glyphMs) {
        transients.push({ slot: t.slots[0], kind: 'pop', progress: (now - t.glyphStart) / t.glyphMs })
      }
    } else if (now < t.commitAt) {
      // Each incoming heart fades in on its still-empty socket and holds full until the count commits.
      for (let i = 0; i < t.slots.length; i += 1) {
        const gs = t.glyphStart + i * t.glyphStagger
        if (now >= gs) {
          transients.push({ slot: t.slots[i], kind: 'heal', progress: clamp01((now - gs) / t.glyphMs) })
        }
      }
    }

    let beam: HeartsView['beam'] = null
    if (now >= t.beamStart && now < t.beamEnd) {
      const travelMs = t.kind === 'pop' ? POP_BEAM_TRAVEL : HEAL_BEAM_TRAVEL
      const fadeMs = t.kind === 'pop' ? POP_BEAM_FADE : HEAL_BEAM_FADE
      const dt = now - t.beamStart
      const travel = clamp01(dt / travelMs)
      const alpha = dt < travelMs ? 1 : 1 - clamp01((dt - travelMs) / fadeMs)
      beam = { slot: t.slots[0], kind: t.kind, travel, alpha }
    }

    // The spark shower off the struck chip: only on a loss, from the laser's contact for POP_SPARK_MS.
    let spark: HeartsView['spark'] = null
    if (t.kind === 'pop' && now >= t.glyphStart && now < t.glyphStart + POP_SPARK_MS) {
      spark = { slot: t.slots[0], progress: (now - t.glyphStart) / POP_SPARK_MS }
    }

    return { filled, max: MAX_HEARTS, transients, beam, spark }
  }

  // Commit an in-flight transition's end state so the next pop/heal builds off the right count.
  private settle_(): void {
    if (this.t_) {
      this.committed_ = this.t_.to
      this.t_ = null
    }
  }
}

function clampCount(n: number): number {
  return Math.min(MAX_HEARTS, Math.max(0, Math.round(n)))
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
