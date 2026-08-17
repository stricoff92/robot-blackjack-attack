// Timing for the player hit-point (heart-chip) VFX. Owns the pop-on-loss and heal-on-win transition
// so render/hearts.ts stays pure geometry. A pop is always one chip; a heal is one or more (beating a
// dealer restores up to two), the beam reviving the sockets ONE AT A TIME — fill a chip, glide to the
// next, fill that. Everything is a pure function of `now` (absolute performance.now() stamps) so a
// frame just samples view(now); no per-frame mutation, no accumulated drift.

import type { HeartsView } from '../render/hearts'
import { smoothEnd2 } from '../render/easing'
import { MAX_HEARTS } from '../game/run'

// A loss: the red laser reaches the chip fast, then the heart is blown off.
const POP_BEAM_TRAVEL = 120
const POP_BEAM_FADE = 200
const POP_GLYPH_MS = 320
// The hot spark shower off the struck chip, timed from the laser's contact (= glyphStart). Outlasts
// the glyph so the flecks are still raining down as the heart finishes popping off.
const POP_SPARK_MS = 430
// A heal: the restorative band drifts across slower, then a heart drops into the socket. The beam
// holds on the socket through the fill and only eases off (HEAL_BEAM_FADE) once the chip has
// committed to full colour, so the beam is still landing as the socket lights up.
const HEAL_BEAM_TRAVEL = 300
const HEAL_BEAM_FADE = 300
const HEAL_GLYPH_MS = 380
// A multi-heart heal (a kill restores up to two) revives the sockets ONE AT A TIME: the beam fills
// one chip, then its head glides along the row to the next and fills that one. HEAL_SWEEP_MS is that
// glide between adjacent sockets; a heart's full cycle (fill → glide to the next) is GLYPH + SWEEP.
const HEAL_SWEEP_MS = 240

interface Transition {
  kind: 'pop' | 'heal'
  from: number // filled count before the change
  to: number // filled count after
  slots: number[] // the row indices that change (the popped slot, or each newly filled slot)
  beamStart: number
  beamEnd: number
  glyphStart: number // = the first beam contact; the first glyph begins here
  glyphStep: number // heal: a heart's full cycle (fill + glide to the next socket); 0 for a pop
  glyphMs: number
  commitAt: number // pop: when the chip empties; heal: when the LAST socket has filled
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
      glyphStep: 0,
      glyphMs: POP_GLYPH_MS,
      commitAt: glyphStart, // the chip empties the instant the heart is blown off
      end: Math.max(glyphStart + POP_GLYPH_MS, glyphStart + POP_SPARK_MS, startAt + POP_BEAM_TRAVEL + POP_BEAM_FADE),
    }
  }

  // Schedule the `count` hearts gained on a qualifying win: a green beam lands on the first empty
  // socket at `startAt` and fills it, then glides along the row to the next and fills that, one after
  // another. Clamped to MAX_HEARTS; no-op at full.
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
    // Sockets revive one at a time: contact_j = travel + j·step; the beam holds on socket j for the
    // fill (GLYPH), then glides (SWEEP) to socket j+1. Each socket commits when ITS OWN fill ends, so
    // the first chip is already lit before the second one starts. After the last fill the beam eases
    // off over HEAL_BEAM_FADE — its exit is the last thing to finish, not the first.
    const glyphStart = startAt + HEAL_BEAM_TRAVEL
    const glyphStep = HEAL_GLYPH_MS + HEAL_SWEEP_MS
    const lastCommit = glyphStart + (slots.length - 1) * glyphStep + HEAL_GLYPH_MS
    const beamEnd = lastCommit + HEAL_BEAM_FADE
    this.t_ = {
      kind: 'heal',
      from,
      to,
      slots,
      beamStart: startAt,
      beamEnd,
      glyphStart,
      glyphStep,
      glyphMs: HEAL_GLYPH_MS,
      commitAt: lastCommit,
      end: beamEnd, // the beam's ease-off outlasts the fill
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

    const transients: HeartsView['transients'] = []
    let filled: number
    let beam: HeartsView['beam'] = null

    if (t.kind === 'pop') {
      filled = now < t.commitAt ? t.from : t.to
      // The departing heart overlays its (already-empty) slot for its fade-out window.
      if (now >= t.glyphStart && now < t.glyphStart + t.glyphMs) {
        transients.push({ slot: t.slots[0], kind: 'pop', progress: (now - t.glyphStart) / t.glyphMs })
      }
      if (now >= t.beamStart && now < t.beamEnd) {
        const dt = now - t.beamStart
        const travel = clamp01(dt / POP_BEAM_TRAVEL)
        // The loss laser retracts right after it strikes: full through the travel, then a quick fade.
        const alpha = dt < POP_BEAM_TRAVEL ? 1 : 1 - clamp01((dt - POP_BEAM_TRAVEL) / POP_BEAM_FADE)
        beam = { slot: t.slots[0], kind: 'pop', travel, alpha }
      }
    } else {
      // Heal: each socket commits when its OWN fill finishes, so `filled` climbs one chip at a time —
      // the first is already solid before the beam glides on to fill the second.
      filled = t.from
      for (let i = 0; i < t.slots.length; i += 1) {
        const contact = t.glyphStart + i * t.glyphStep
        if (now >= contact + t.glyphMs) {
          filled += 1 // this socket has fully filled and committed
        } else if (now >= contact) {
          // Mid-fill: the incoming heart rides as a fading-in glyph on its still-empty socket.
          transients.push({ slot: t.slots[i], kind: 'heal', progress: clamp01((now - contact) / t.glyphMs) })
        }
      }
      beam = this.healBeam_(t, now)
    }

    // The spark shower off the struck chip: only on a loss, from the laser's contact for POP_SPARK_MS.
    let spark: HeartsView['spark'] = null
    if (t.kind === 'pop' && now >= t.glyphStart && now < t.glyphStart + POP_SPARK_MS) {
      spark = { slot: t.slots[0], progress: (now - t.glyphStart) / POP_SPARK_MS }
    }

    return { filled, max: MAX_HEARTS, transients, beam, spark }
  }

  // The heal beam's head as it revives sockets one at a time: it launches from the nexus to the
  // first socket, holds while that chip fills, glides to the next, and once the last chip commits
  // eases off in place. `slot` is a possibly-fractional row position the renderer interpolates so the
  // head glides smoothly between adjacent sockets.
  private healBeam_(t: Transition, now: number): HeartsView['beam'] {
    if (now < t.beamStart || now >= t.beamEnd) {
      return null
    }
    // Launch: nexus → the first socket.
    if (now < t.glyphStart) {
      const travel = clamp01((now - t.beamStart) / HEAL_BEAM_TRAVEL)
      return { slot: t.slots[0], kind: 'heal', travel, alpha: 1 }
    }
    const last = t.slots.length - 1
    const lastCommit = t.glyphStart + last * t.glyphStep + t.glyphMs
    // Ease off in place once the final chip has regained its colour (smoothEnd, so it settles out
    // instead of snapping) — the beam is still present as that last socket lights up.
    if (now >= lastCommit) {
      const alpha = 1 - smoothEnd2(clamp01((now - lastCommit) / HEAL_BEAM_FADE))
      return { slot: t.slots[last], kind: 'heal', travel: 1, alpha }
    }
    // Otherwise the head is fully extended (travel 1), either holding on socket j while it fills or
    // gliding from socket j toward j+1. Slots are consecutive, so slots[j] + fraction lands on j+1.
    const rel = now - t.glyphStart
    const j = Math.floor(rel / t.glyphStep)
    const within = rel - j * t.glyphStep
    const slot = within < t.glyphMs ? t.slots[j] : t.slots[j] + clamp01((within - t.glyphMs) / HEAL_SWEEP_MS)
    return { slot, kind: 'heal', travel: 1, alpha: 1 }
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
