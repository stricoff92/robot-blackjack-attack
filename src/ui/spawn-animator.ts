// Timing for the dealer-spawn ceremony: the previous dealer's cards are sucked
// into the new dealer's mouth and shredded (paper chunks coning off to the left),
// then a fresh shrink-wrapped deck flies from the dealer into the shoe position and
// the plastic tears off. The walk-in itself is owned by the dealer animator; this
// owns everything that happens once the new dealer has arrived.
//
// Mirrors the other animators: absolute performance.now() stamps here, the drawing
// (render/spawn.ts) reads these per-frame queries. One entry point, begin(), returns
// the timestamp the whole ceremony finishes so GameView can hold the next deal.

import { smoothStep } from '../render/easing'

// One card: fly from its felt slot into the mouth (SUCK), while paper chunks spray
// out. Cards start their suck staggered so they're drawn in one after another.
const SHRED_STAGGER_MS = 70 // between successive cards starting their suck
const SHRED_SUCK_MS = 300 // one card: slot → mouth (shrinking to nothing)
const CHUNK_LEAD_MS = SHRED_SUCK_MS * 0.5 // chunks begin halfway through the suck
const SHRED_CHUNK_MS = 850 // one card's paper-chunk spray lifetime (bits fly far + linger)
// A short tail on the shred window (sfx only) so the shredder keeps chewing a beat past
// the last card before it fades — otherwise the fade-out starts feeling a touch early.
const SHRED_SFX_TAIL_MS = 200

// The previous dealer's whole DECK is shredded too — not as one lump, but card-by-card:
// 40 backs peel off the top in rapid sequence (the resting stack shrinking as each
// leaves) and fly into the mouth, starting right after the final table card and before
// the fresh deck flies in, so the shoe is empty when the replacement lands. Rapid stagger
// + short per-card suck keep it a fast flurry that only adds a few hundred ms overall.
const DECK_SHRED_CARDS = 40
const DECK_CARD_STAGGER_MS = 13 // between successive deck cards starting their suck
const DECK_CARD_SUCK_MS = 175 // one deck card: shoe top → mouth (shrinking to nothing)
const DECK_CARD_CHUNK_LEAD_MS = DECK_CARD_SUCK_MS * 0.45 // chunks begin partway through the suck
const DECK_CARD_CHUNK_MS = 600 // one deck card's paper-chunk spray lifetime (bits fly far + linger)

// The fresh deck: it emerges from the dealer as the old deck is drawn in, flies to
// the shoe, settles, then the plastic tears off over UNWRAP_MS.
const DECK_FLY_LEAD_MS = 120 // deck leaves the dealer slightly before the shoe clears
const DECK_SPAWN_DELAY_MS = 400 // beat held on the empty shoe after the old deck is shredded, before the fresh deck flies out
const DECK_FLY_MS = 400 // dealer → shoe
const DECK_SETTLE_MS = 70 // beat on the shoe before the wrap tears
const UNWRAP_MS = 860 // plastic opens in beats: edge strip peels + tosses → sheet slides off left → sheet flicks off right
// A beat held partway through the unwrap — after the edge strip has torn + tossed
// away (unwrap = UNWRAP_HOLD_AT), before the big sheet slides off left — so that
// beat (and its rustling sfx) lands a clear UNWRAP_HOLD_MS after the tear-open,
// instead of running straight into it. It stretches the unwrap's real duration by
// UNWRAP_HOLD_MS but leaves the visual beats themselves unchanged.
const UNWRAP_HOLD_AT = 0.5
const UNWRAP_HOLD_MS = 300

// Once the fresh deck is unsealed it gets ONE riffle shuffle — the deck's only visible
// shuffle (between hands the spent cards just fly into the dealer, no riffle). It slides
// out in front of the dealer to the centre (where the split has room), riffles once, then
// slides back to the shoe. This is the sole per-deck shuffle, so it plays on every dealer
// change, not between hands.
const SHUFFLE_LEAD_MS = 100 // beat on the bare unsealed deck before it slides out
const SHUFFLE_SLIDE_MS = 190 // deck slides out to centre (and back) for the riffle
// One riffle pass, sized so its MERGE phase — the 0.7 after the 0.3 split
// (SHUFFLE_SPLIT_FRACTION) — lasts the 0.43s shuffle clip that fires as the merge begins:
// 430 / 0.7 ≈ 614. The split before it is silent.
const RIFFLE_MS = 614

export interface DeckState {
  fly: number // 0..1 dealer → shoe (0 = at the dealer, 1 = landed)
  unwrap: number // 0..1 plastic tear-off (0 = wrapped, 1 = bare deck)
}

// The unsealed deck's one-time riffle: how far it's slid from the shoe toward centre
// (0 = shoe, 1 = centre) and, once there, the 0..1 riffle progress (null outside it).
export interface DeckShuffle {
  shift: number
  riffle: number | null
}

export class SpawnAnimation {
  private begun_ = false
  private t0_ = 0
  private n_ = 0 // cards on the table to shred
  private hasOldDeck_ = false // whether the previous dealer's deck gets shredded too
  private deckShredStart_ = 0 // old deck: first card peels off the top
  private deckShredEnd_ = 0 // old deck: last card fully drawn in (shoe clear)
  private shredStartAt_ = 0 // first card begins being sucked into the mouth
  private shredEndAt_ = 0 // last card drawn in + a short sfx tail; 0 = nothing to shred
  private deckFlyStart_ = 0 // fresh deck: dealer → shoe
  private deckFlyEnd_ = 0
  private unwrapStart_ = 0
  private unwrapEnd_ = 0
  // The unsealed deck's riffle: slide out to centre → riffle → slide back to the shoe.
  private shuffleSlideOutStart_ = 0
  private shuffleStart_ = 0
  private shuffleStop_ = 0
  private shuffleSlideBackEnd_ = 0
  private endAt_ = 0

  // Start the ceremony at `now`, shredding `cardCount` table cards (0 on page load,
  // where there are no previous cards). `shredOldDeck` also sucks the previous dealer's
  // resting deck into the mouth before the fresh one flies in (a kill / New run — false
  // on the opening intro, which has no old deck). Returns the timestamp the deck is
  // fully unwrapped and ready — the moment the next hand may deal. Every dealer (including
  // the final dealer + the Banker) shares one timing — there's no grander/slower variant.
  // `shredOnly` (game over): shred the table cards but fly NO fresh deck in — the run is
  // over, so there's no replacement. endAt is just the shred (+ its lingering chunks).
  begin(now: number, cardCount: number, shredOldDeck = false, shredOnly = false): number {
    this.begun_ = true
    this.t0_ = now
    this.n_ = Math.max(0, cardCount)
    this.hasOldDeck_ = shredOldDeck

    const spawnDelayMs = DECK_SPAWN_DELAY_MS
    const settleMs = DECK_SETTLE_MS

    const lastCardSuckStart = this.n_ > 0 ? (this.n_ - 1) * SHRED_STAGGER_MS : 0
    const lastCardSuckEnd = this.n_ > 0 ? lastCardSuckStart + SHRED_SUCK_MS : 0

    // The old deck starts shredding one stagger step after the last table card starts, so its
    // cards are drawn in last; the fresh deck then flies once the shoe is clear.
    this.deckShredStart_ = now + this.n_ * SHRED_STAGGER_MS
    const lastDeckCardStart = this.deckShredStart_ + (DECK_SHRED_CARDS - 1) * DECK_CARD_STAGGER_MS
    this.deckShredEnd_ = lastDeckCardStart + DECK_CARD_SUCK_MS

    // The shred window (for the shredder sfx): the cards being sucked into the mouth,
    // ending a short tail past the last one being fully drawn in — the lingering paper
    // chunks aren't part of it. Empty on the opening intro (nothing to shred).
    const hasCards = this.n_ > 0 || this.hasOldDeck_
    this.shredStartAt_ = hasCards ? now : 0
    const lastCardIn = this.hasOldDeck_ ? this.deckShredEnd_ : now + lastCardSuckEnd
    this.shredEndAt_ = hasCards ? lastCardIn + SHRED_SFX_TAIL_MS : 0

    // The fresh deck flies out once the shoe is clear. With an old deck shredded, hold a
    // DECK_SPAWN_DELAY_MS beat on the empty shoe first (a clear gap between the old deck
    // vanishing and the new one arriving); on the intro (no old deck) it instead leaves the
    // dealer DECK_FLY_LEAD_MS before the last table card lands, as before.
    const deckFlyBase = this.hasOldDeck_
      ? this.deckShredEnd_ + spawnDelayMs
      : now + lastCardSuckEnd - DECK_FLY_LEAD_MS
    this.deckFlyStart_ = Math.max(now, deckFlyBase)
    this.deckFlyEnd_ = this.deckFlyStart_ + DECK_FLY_MS
    this.unwrapStart_ = this.deckFlyEnd_ + settleMs
    this.unwrapEnd_ = this.unwrapStart_ + UNWRAP_MS + UNWRAP_HOLD_MS

    // The unsealed deck's one riffle: a beat, slide out to centre, riffle, slide back.
    this.shuffleSlideOutStart_ = this.unwrapEnd_ + SHUFFLE_LEAD_MS
    this.shuffleStart_ = this.shuffleSlideOutStart_ + SHUFFLE_SLIDE_MS
    this.shuffleStop_ = this.shuffleStart_ + RIFFLE_MS
    this.shuffleSlideBackEnd_ = this.shuffleStop_ + SHUFFLE_SLIDE_MS

    const lastCardChunkEnd =
      this.n_ > 0 ? now + lastCardSuckStart + CHUNK_LEAD_MS + SHRED_CHUNK_MS : 0
    const deckChunkEnd = this.hasOldDeck_
      ? lastDeckCardStart + DECK_CARD_CHUNK_LEAD_MS + DECK_CARD_CHUNK_MS
      : 0
    if (shredOnly) {
      // No fresh deck: park the deck + shuffle timeline past the end so deckState() /
      // deckShuffle() never fire, and finish once the shred + its chunks have settled.
      this.deckFlyStart_ = Number.POSITIVE_INFINITY
      this.deckFlyEnd_ = Number.POSITIVE_INFINITY
      this.unwrapStart_ = Number.POSITIVE_INFINITY
      this.unwrapEnd_ = Number.POSITIVE_INFINITY
      this.shuffleSlideOutStart_ = Number.POSITIVE_INFINITY
      this.shuffleStart_ = Number.POSITIVE_INFINITY
      this.shuffleStop_ = Number.POSITIVE_INFINITY
      this.shuffleSlideBackEnd_ = Number.POSITIVE_INFINITY
      this.endAt_ = Math.max(this.shredEndAt_, lastCardChunkEnd, deckChunkEnd)
      return this.endAt_
    }
    // The ceremony runs through the riffle's slide-back — that's when the deck is ready to deal.
    this.endAt_ = Math.max(this.shuffleSlideBackEnd_, lastCardChunkEnd, deckChunkEnd)
    return this.endAt_
  }

  isAnimating(now: number): boolean {
    return this.begun_ && now < this.endAt_
  }

  // The moment the previous dealer's DECK starts being shredded (after every table card has begun
  // its own suck) — for effects that should land as the deck goes in, not the cards.
  get oldDeckShredStart(): number {
    return this.deckShredStart_
  }

  // The moment the shredding FINISHES: the last card (table + old deck) fully chewed into the mouth,
  // plus the short sfx tail — but BEFORE the lingering paper chunks fade (that's endAt). For a beat
  // that should follow the shred itself, e.g. the Banker's laugh landing a moment after he's done.
  get shredEnd(): number {
    return this.shredEndAt_
  }

  // True while cards are being sucked into the mouth + shredded — drives the shredder
  // sfx. False before it starts, once the last card is in, and on the intro (nothing
  // to shred).
  isShredding(now: number): boolean {
    return this.begun_ && this.shredEndAt_ > this.shredStartAt_ && now >= this.shredStartAt_ && now < this.shredEndAt_
  }

  // Card `i`'s suck-in progress: null while it's still resting on the felt (draw it
  // settled), else 0..1 as it flies into the mouth (1 = fully drawn in / gone).
  cardSuck(i: number, now: number): number | null {
    if (!this.begun_) {
      return null
    }
    const start = this.t0_ + i * SHRED_STAGGER_MS
    if (now < start) {
      return null
    }
    return clamp01((now - start) / SHRED_SUCK_MS)
  }

  // Card `i`'s paper-chunk spray life (0..1), or null when nothing is spraying for it.
  chunk(i: number, now: number): number | null {
    if (!this.begun_) {
      return null
    }
    const start = this.t0_ + i * SHRED_STAGGER_MS + CHUNK_LEAD_MS
    if (now < start) {
      return null
    }
    const p = (now - start) / SHRED_CHUNK_MS
    return p >= 1 ? null : p
  }

  // How many backs the outgoing deck sheds in its shred (fixed count the renderer loops).
  deckCardCount(): number {
    return DECK_SHRED_CARDS
  }

  // Fraction of the outgoing deck still resting on the shoe (1 = full, 0 = spent) — drives
  // the shrinking resting stack. Full until the shred reaches it; then depletes as each
  // card begins its peel-off, reaching 0 once the last card has left the top.
  deckRemaining(now: number): number {
    if (!this.begun_ || !this.hasOldDeck_ || now < this.deckShredStart_) {
      return 1
    }
    const head = (now - this.deckShredStart_) / DECK_CARD_STAGGER_MS // cards that have begun leaving
    return clamp01(1 - head / DECK_SHRED_CARDS)
  }

  // Old-deck card `k`'s suck-in progress: null while it's still resting on the shoe (no
  // old deck, or its stagger hasn't come up yet), else 0..1 as it flies into the mouth
  // (1 = fully drawn in / gone).
  deckCardSuck(k: number, now: number): number | null {
    if (!this.begun_ || !this.hasOldDeck_) {
      return null
    }
    const start = this.deckShredStart_ + k * DECK_CARD_STAGGER_MS
    if (now < start) {
      return null
    }
    return clamp01((now - start) / DECK_CARD_SUCK_MS)
  }

  // Old-deck card `k`'s paper-chunk spray life (0..1), or null when it isn't spraying.
  deckCardChunk(k: number, now: number): number | null {
    if (!this.begun_ || !this.hasOldDeck_) {
      return null
    }
    const start = this.deckShredStart_ + k * DECK_CARD_STAGGER_MS + DECK_CARD_CHUNK_LEAD_MS
    if (now < start) {
      return null
    }
    const p = (now - start) / DECK_CARD_CHUNK_MS
    return p >= 1 ? null : p
  }

  // The fresh deck's fly-in + unwrap state, or null before it emerges (during the
  // shred). Once past the unwrap it holds at { fly: 1, unwrap: 1 } — a bare resting
  // deck — EXCEPT during the riffle (slide-out → riffle → slide-back), where it returns
  // null so the shuffle renderer (deckShuffle) draws the moving/riffling deck instead.
  deckState(now: number): DeckState | null {
    if (!this.begun_ || now < this.deckFlyStart_) {
      return null
    }
    if (now < this.deckFlyEnd_) {
      return { fly: (now - this.deckFlyStart_) / DECK_FLY_MS, unwrap: 0 }
    }
    if (now < this.unwrapStart_) {
      return { fly: 1, unwrap: 0 }
    }
    if (now < this.unwrapEnd_) {
      return { fly: 1, unwrap: this.unwrapProgress_(now - this.unwrapStart_) }
    }
    if (now >= this.shuffleSlideOutStart_ && now < this.shuffleSlideBackEnd_) {
      return null // the riffle owns the deck's draw for this window
    }
    return { fly: 1, unwrap: 1 }
  }

  // The fresh deck's unwrap fraction alone (0 wrapped → 1 bare), MONOTONIC: 0 until the
  // deck lands, climbs through the tear-off, then holds at 1 — including through the
  // riffle and after. The tear-open / rustling sfx edge off THIS, not deckState().unwrap:
  // deckState() dips to null (→ 0) during the riffle, which would re-fire those sfx late
  // as it climbs back to 1. Only the SFX needs this; the renderer uses deckState().
  unwrap(now: number): number {
    if (!this.begun_ || now < this.unwrapStart_) {
      return 0
    }
    if (now < this.unwrapEnd_) {
      return this.unwrapProgress_(now - this.unwrapStart_)
    }
    return 1
  }

  // The unsealed deck's one riffle, or null outside it: while sliding out/back it's a
  // resting deck at a partial `shift` (0 = shoe, 1 = centre); at centre it riffles once.
  deckShuffle(now: number): DeckShuffle | null {
    if (!this.begun_ || now < this.shuffleSlideOutStart_ || now >= this.shuffleSlideBackEnd_) {
      return null
    }
    if (now < this.shuffleStart_) {
      return { shift: smoothStep((now - this.shuffleSlideOutStart_) / SHUFFLE_SLIDE_MS), riffle: null }
    }
    if (now < this.shuffleStop_) {
      return { shift: 1, riffle: (now - this.shuffleStart_) / RIFFLE_MS }
    }
    return { shift: 1 - smoothStep((now - this.shuffleStop_) / SHUFFLE_SLIDE_MS), riffle: null }
  }

  // Real elapsed unwrap time → unwrap fraction (0..1), with a plateau at
  // UNWRAP_HOLD_AT: the fraction climbs at the base rate, freezes there for
  // UNWRAP_HOLD_MS (the strip is gone, the sheet not yet sliding), then resumes —
  // so the slide-left beat is pushed UNWRAP_HOLD_MS later without altering its shape.
  private unwrapProgress_(elapsed: number): number {
    const holdStart = UNWRAP_HOLD_AT * UNWRAP_MS
    if (elapsed < holdStart) {
      return elapsed / UNWRAP_MS
    }
    if (elapsed < holdStart + UNWRAP_HOLD_MS) {
      return UNWRAP_HOLD_AT
    }
    return (elapsed - UNWRAP_HOLD_MS) / UNWRAP_MS
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
