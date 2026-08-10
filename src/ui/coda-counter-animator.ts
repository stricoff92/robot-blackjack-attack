// Timing for the Banker coda's winnings counters (render in render/coda-counters.ts).
// Pure timing, like the other animators: the game owns the pot (perTier markers of a tier;
// it doubles on each win and colours up when perTier would exceed 8) and this turns a
// wall-clock `now` into a per-marker motion frame.
//
// One transition is ever in flight:
//   reveal  — the first marker materialises at coda entry (tier 0, one marker).
//   grow    — a within-tier win: existing markers reflow to the larger grid while the
//             banker slides matching markers IN (perTier 1→2→4→8).
//   colourUp— the 4th win of a tier: the eight markers converge + FUSE into one marker of
//             the next, higher denomination.
//   collect — a bust: every marker flies BACK to the banker before he leaves.
//   fade    — a cash-out: the pot is banked, so the markers dissolve in place.
// Between/after transitions, frame() derives the resting state from the last one.

import type { CodaCounterView, CrystalMarker } from '../render/coda-counters'

const REVEAL_MS = 520

const GROW_REFLOW_MS = 300
const GROW_FLY_LEAD = 120
const GROW_FLY_MS = 440
const GROW_STAGGER = 70

// The colour-up: a win at a full row-of-8 first DOUBLES the pile — 8 matching markers fly in
// from the banker to form a 4×4 of 16 (two new rows above the two original) — HOLD a beat, then
// all 16 implode onto the centre and the next denomination blooms.
const FILL_LEAD = 100
const FILL_FLY_MS = 420
const FILL_STAGGER = 40 // the 8 arriving markers
const FILL_HOLD = 280 // a beat showing the full 16 before it condenses
const FUSE_GATHER_MS = 360
const FUSE_STAGGER = 24 // 16 markers imploding
const FUSE_BLOOM_LEAD = 300 // the new marker starts blooming while the old ones still converge
const FUSE_BLOOM_MS = 460

const COLLECT_FLY_MS = 400
const COLLECT_STAGGER = 70

const DISSOLVE_MS = 520

type Mode = 'none' | 'reveal' | 'grow' | 'colourUp' | 'collect' | 'fade'

export class CodaCounterAnimation {
  private mode_: Mode = 'none'
  private start_ = 0
  private end_ = 0
  // Transition params (meaning depends on mode).
  private fromCount_ = 0
  private toCount_ = 0
  private fromTier_ = 0
  private toTier_ = 0
  // colour-up only: the DOUBLED count (fromCount·2 = 16) shown in the 4×4 before it condenses,
  // and the wall-clock at which the condense (implode + bloom) begins.
  private fullCount_ = 0
  private condenseAt_ = 0
  // The state frame() rests at once the transition finishes.
  private restCount_ = 0
  private restTier_ = 0

  // The first marker forms in place at coda entry (tier 0). Returns when it settles.
  reveal(startAt: number): number {
    this.mode_ = 'reveal'
    this.toCount_ = 1
    this.toTier_ = 0
    this.restCount_ = 1
    this.restTier_ = 0
    this.start_ = startAt
    this.end_ = startAt + REVEAL_MS
    return this.end_
  }

  // A within-tier win: reflow the existing `fromCount` and fly the new ones in (same tier).
  grow(fromCount: number, toCount: number, tier: number, startAt: number): number {
    this.mode_ = 'grow'
    this.fromCount_ = fromCount
    this.toCount_ = toCount
    this.fromTier_ = tier
    this.toTier_ = tier
    this.restCount_ = toCount
    this.restTier_ = tier
    this.start_ = startAt
    const added = Math.max(0, toCount - fromCount)
    const flyEnd = GROW_FLY_LEAD + GROW_FLY_MS + Math.max(0, added - 1) * GROW_STAGGER
    this.end_ = startAt + Math.max(GROW_REFLOW_MS, flyEnd)
    return this.end_
  }

  // The colour-up: `fromCount` (8) markers of `fromTier` first DOUBLE — 8 more fly in to make a
  // 4×4 of 16 — then all 16 fuse into one marker of `toTier`.
  colourUp(fromCount: number, fromTier: number, toTier: number, startAt: number): number {
    this.mode_ = 'colourUp'
    this.fromCount_ = fromCount
    this.fullCount_ = fromCount * 2
    this.fromTier_ = fromTier
    this.toTier_ = toTier
    this.restCount_ = 1
    this.restTier_ = toTier
    this.start_ = startAt
    const fillEnd = FILL_LEAD + FILL_FLY_MS + Math.max(0, fromCount - 1) * FILL_STAGGER
    this.condenseAt_ = startAt + fillEnd + FILL_HOLD
    const gatherEnd = FUSE_GATHER_MS + Math.max(0, this.fullCount_ - 1) * FUSE_STAGGER
    this.end_ = this.condenseAt_ + Math.max(gatherEnd, FUSE_BLOOM_LEAD + FUSE_BLOOM_MS)
    return this.end_
  }

  // A bust: the whole pile flies back to the banker. Returns when the last one lands.
  collect(count: number, tier: number, startAt: number): number {
    this.mode_ = 'collect'
    this.fromCount_ = count
    this.fromTier_ = tier
    this.restCount_ = 0
    this.start_ = startAt
    this.end_ = startAt + COLLECT_FLY_MS + Math.max(0, count - 1) * COLLECT_STAGGER
    return this.end_
  }

  // A cash-out: the markers dissolve where they sit.
  fade(count: number, tier: number, startAt: number): number {
    this.mode_ = 'fade'
    this.fromCount_ = count
    this.fromTier_ = tier
    this.restCount_ = 0
    this.start_ = startAt
    this.end_ = startAt + DISSOLVE_MS
    return this.end_
  }

  isAnimating(now: number): boolean {
    return this.mode_ !== 'none' && now < this.end_
  }

  frame(now: number): CodaCounterView {
    if (this.mode_ === 'none') {
      return { markers: [] }
    }
    if (now >= this.end_) {
      return { markers: rest(this.restCount_, this.restTier_) }
    }
    const local = now - this.start_
    switch (this.mode_) {
      case 'reveal':
        return { markers: [{ motion: 'form', p: prog(local, REVEAL_MS), slot: 0, count: 1, tier: 0, fromCount: 1 }] }
      case 'grow': {
        const markers: CrystalMarker[] = []
        for (let i = 0; i < this.fromCount_; i++) {
          markers.push({ motion: 'reflow', p: prog(local, GROW_REFLOW_MS), slot: i, count: this.toCount_, tier: this.toTier_, fromCount: this.fromCount_ })
        }
        for (let i = this.fromCount_, j = 0; i < this.toCount_; i++, j++) {
          markers.push({ motion: 'flyIn', p: prog(local - GROW_FLY_LEAD - j * GROW_STAGGER, GROW_FLY_MS), slot: i, count: this.toCount_, tier: this.toTier_, fromCount: this.toCount_ })
        }
        return { markers }
      }
      case 'colourUp': {
        const full = this.fullCount_ // 16
        const half = this.fromCount_ // 8
        if (now < this.condenseAt_) {
          // FILL: 8 NEW markers fly in from the banker to the TOP two rows (slots 0..7) while the
          // existing 8 rest in the BOTTOM two rows (slots 8..15); each stays the SAME tier — the
          // pot has doubled to 16. Emit in TOP-to-BOTTOM slot order so the render (which draws in
          // array order, later = on top) paints the lower/FRONT rows OVER the upper/back ones —
          // matching the 33% glass overlap. Emitting bottom-first drew the new rows over the old.
          const markers: CrystalMarker[] = []
          for (let i = 0; i < full; i++) {
            markers.push(
              i < half
                ? { motion: 'flyIn', p: prog(local - FILL_LEAD - i * FILL_STAGGER, FILL_FLY_MS), slot: i, count: full, tier: this.fromTier_, fromCount: full }
                : { motion: 'rest', p: 1, slot: i, count: full, tier: this.fromTier_, fromCount: full },
            )
          }
          return { markers }
        }
        // CONDENSE: all 16 implode onto the centre and the next denomination blooms.
        const cl = now - this.condenseAt_
        const markers: CrystalMarker[] = []
        for (let i = 0; i < full; i++) {
          markers.push({ motion: 'fuseOut', p: prog(cl - i * FUSE_STAGGER, FUSE_GATHER_MS), slot: i, count: full, tier: this.fromTier_, fromCount: full })
        }
        markers.push({ motion: 'fuseIn', p: prog(cl - FUSE_BLOOM_LEAD, FUSE_BLOOM_MS), slot: 0, count: 1, tier: this.toTier_, fromCount: 1 })
        return { markers }
      }
      case 'collect': {
        const markers: CrystalMarker[] = []
        for (let i = 0; i < this.fromCount_; i++) {
          markers.push({ motion: 'flyOut', p: prog(local - i * COLLECT_STAGGER, COLLECT_FLY_MS), slot: i, count: this.fromCount_, tier: this.fromTier_, fromCount: this.fromCount_ })
        }
        return { markers }
      }
      case 'fade': {
        const markers: CrystalMarker[] = []
        for (let i = 0; i < this.fromCount_; i++) {
          markers.push({ motion: 'fade', p: prog(local, DISSOLVE_MS), slot: i, count: this.fromCount_, tier: this.fromTier_, fromCount: this.fromCount_ })
        }
        return { markers }
      }
      default:
        return { markers: [] }
    }
  }
}

function rest(count: number, tier: number): CrystalMarker[] {
  const out: CrystalMarker[] = []
  for (let i = 0; i < count; i++) {
    out.push({ motion: 'rest', p: 1, slot: i, count, tier, fromCount: count })
  }
  return out
}

// clamp01(x / ms); a negative x (not yet started) reads as 0.
function prog(x: number, ms: number): number {
  if (x <= 0) {
    return 0
  }
  return x >= ms ? 1 : x / ms
}
