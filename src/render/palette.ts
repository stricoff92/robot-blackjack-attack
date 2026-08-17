// Per-dealer colour identity. Each dealer the player faces is marked by its bowtie
// AND its deck (card-back) colour, so progression reads at a glance:
//
//   dealer 1  blue      dealer 4  yellow
//   dealer 2  purple    dealer 5  red
//   dealer 3  green     dealer 6  RGB cycle (the final dealer shimmers through the wheel)
//
// Colours are derived from a single hue per dealer, holding the same saturation /
// lightness relationships as the original blue design, so every dealer's kit looks
// like a recolour of the same robot rather than an ad-hoc palette. Canvas takes
// `hsl()` fill styles directly, so no hex conversion is needed.

import { TOTAL_DEALERS } from '../game/run'

// The deck/card-back colours for a dealer. `id` discriminates the offscreen
// card-back sprite cache (see card-sprite.ts) — stable per colour so the cache
// stays bounded (one entry per dealer, plus one per RGB hue bucket).
export interface CardBack {
  id: string
  outer: string // outer card-back fill (card-sprite drawBack)
  panel: string // inner panel fill
  deckBase: string // drawShoe drop-shadow base
  deckDark: string // drawShoe even stack layer
  deckLight: string // drawShoe odd stack layer
  tech: number // 0..1, how advanced the PCB card-back looks (rises with dealer)
  seed: number // deterministic PCB layout seed (stable per dealer)
}

// The full colour kit for a dealer: the bowtie (drawn fresh each frame, so it can
// take an exact RGB hue) and the deck (a cached sprite, so its RGB hue is bucketed).
export interface DealerColors {
  bowtie: string
  bowtieKnot: string
  back: CardBack
}

// The final dealer (index === TOTAL_DEALERS, and anything past it) shimmers through
// the spectrum instead of holding a fixed hue.
const RGB_DEALER = TOTAL_DEALERS

// The Banker coda's sentinel identity: one past the last real dealer (TOTAL_DEALERS + 1).
// It sits "past" the RGB dealer but is deliberately NOT one of the shimmering bosses — it
// gets its own fixed charcoal-and-gold kit (see BANKER_COLORS / dealerColors), and the
// figure renders it as THE BANKER (drawFigure), not a robot dealer.
const BANKER_SHIFT = TOTAL_DEALERS + 1

// THE BANKER's colour kit: a distinguished house money-man in deep charcoal with gold
// accents, not a synthesised prototype colour. The figure reuses `bowtie` as the suit's
// gold (vest buttons, watch chain, monocle rim); `back` is a charcoal deck for the coda.
const BANKER_GOLD = '#e3c169'
const BANKER_GOLD_DEEP = '#b8933b'
const BANKER_COLORS: DealerColors = {
  bowtie: BANKER_GOLD,
  bowtieKnot: BANKER_GOLD_DEEP,
  back: {
    id: 'banker',
    outer: '#14161d',
    panel: '#23262f',
    deckBase: '#0f1116',
    deckDark: '#1a1d24',
    deckLight: '#2a2e38',
    tech: 1,
    seed: BANKER_SHIFT * 2654435761,
  },
}

// Fixed hues for dealers 1..5: blue, purple, green, yellow, red.
const DEALER_HUES = [220, 275, 140, 48, 2] as const

// RGB dealer: the card backs ride a true RGB cycle — three sine waves a third of a period
// out of phase sweep the colour around the wheel every RGB_PERIOD_MS, snapped to RGB_STEPS
// phase steps so the card-back sprite cache stays small and is reused every cycle (re-rendering
// a back sprite each frame would thrash the cache and allocate an offscreen per frame). The
// bowtie no longer cycles: it's a fixed light grey (RGB_BOWTIE). The sweep read as distracting
// and, worse, froze on whatever colour it last held when the render loop parked in battery-saver.
const RGB_PERIOD_MS = 600
const RGB_STEPS = 16
// The RGB dealer's fixed light grey/white bowtie (and a slightly darker knot).
const RGB_BOWTIE = '#e8ecf3'
const RGB_BOWTIE_KNOT = '#aab3c2'

export function isRgbDealer(shiftIndex: number): boolean {
  // The final dealer and anything past it shimmer — EXCEPT the Banker coda's sentinel,
  // which has its own fixed charcoal-and-gold kit and must not be treated as RGB.
  return shiftIndex >= RGB_DEALER && shiftIndex !== BANKER_SHIFT
}

// The fixed dealers' colour kits are constant per shiftIndex, but dealerColors is
// called several times per frame (deck colour, bowtie, spawn cross-fade), so they're
// built once and reused. The RGB dealer is time-varying and never cached here. Bounded
// naturally: only the handful of fixed dealer indices ever land in this map.
const fixedColorsCache = new Map<number, DealerColors>()

// The colour kit for the dealer at `shiftIndex` (1-based). `now` only matters for
// the RGB dealer, whose colour advances with time.
export function dealerColors(shiftIndex: number, now: number): DealerColors {
  if (shiftIndex === BANKER_SHIFT) {
    return BANKER_COLORS // THE BANKER: fixed charcoal + gold, not a shimmering boss
  }
  if (isRgbDealer(shiftIndex)) {
    // Snap the deck to the centre of the current phase step, so a whole step shares
    // one cached back sprite (and the same step recurs every cycle → cache hits).
    const step = Math.floor(rgbPos(now) * RGB_STEPS)
    const deckRgb = desaturate(cycleRgb(((step + 0.5) / RGB_STEPS) * RGB_PERIOD_MS, RGB_PERIOD_MS))
    return {
      // Fixed light-grey bowtie (no longer rides the colour cycle — see RGB_BOWTIE).
      bowtie: RGB_BOWTIE,
      bowtieKnot: RGB_BOWTIE_KNOT,
      // Top-tech board, and a seed that's constant across the RGB colour steps so the
      // layout holds steady while only the colour shimmers.
      back: rgbDeck(deckRgb, `rgb${step}`, 1, RGB_DEALER * 2654435761),
    }
  }
  const cached = fixedColorsCache.get(shiftIndex)
  if (cached) {
    return cached
  }
  const hue = DEALER_HUES[clampIndex(shiftIndex)]
  const colors: DealerColors = {
    bowtie: bowtie(hue),
    bowtieKnot: bowtieKnot(hue),
    back: deckColors(hue, `d${shiftIndex}`, techFor(shiftIndex), shiftIndex * 2654435761),
  }
  fixedColorsCache.set(shiftIndex, colors)
  return colors
}

// How advanced the dealer's board looks: dealer 1 is crudest (0), the last fixed
// dealer approaches the RGB dealer's cutting-edge (1).
function techFor(shiftIndex: number): number {
  return Math.min(Math.max((shiftIndex - 1) / (TOTAL_DEALERS - 1), 0), 1)
}

type Rgb = [number, number, number]

function rgbPos(now: number): number {
  return (now % RGB_PERIOD_MS) / RGB_PERIOD_MS
}

// A proper RGB cycle (per the requested cycleRGBVal): three sine waves 120° apart,
// each mapped from [-1, 1] to [0, 255]. The three channels sum to a constant, so the
// swept colour holds a steady overall brightness rather than pulsing light/dark.
function cycleRgb(now: number, period: number): Rgb {
  const pos = (now % period) / period
  return [channel(pos), channel((pos + 1 / 3) % 1), channel((pos + 2 / 3) % 1)]
}

function channel(phase: number): number {
  return Math.floor((Math.sin(phase * 2 * Math.PI) * 0.5 + 0.5) * 255)
}

// The raw cycle hits pure primaries at its sine peaks, which read as harsh/neon on the
// final dealer's bowtie and card backs. Pull each channel partway toward the constant
// mid-grey the cycle already averages to — muting the sweep to a softer, washed-out
// pastel while it still visibly cycles. Mixing toward the mean leaves the channel sum
// (and thus the steady overall brightness) unchanged. 1 = full colour, 0 = grey.
const RGB_SATURATION = 0.5
function desaturate([r, g, b]: Rgb): Rgb {
  const mid = 127.5 // the cycle's constant channel average (three sines 120° apart)
  const mix = (c: number): number => Math.round(mid + (c - mid) * RGB_SATURATION)
  return [mix(r), mix(g), mix(b)]
}

function scale([r, g, b]: Rgb, k: number): Rgb {
  return [Math.floor(r * k), Math.floor(g * k), Math.floor(b * k)]
}

function rgbCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`
}

// The deck kit for an RGB base: darkened variants of the swept colour, matching the
// tonal spread the fixed dealers get from their lightness ramp (outer darkest, panel
// lightest).
function rgbDeck(base: Rgb, id: string, tech: number, seed: number): CardBack {
  return {
    id,
    outer: rgbCss(scale(base, 0.42)),
    panel: rgbCss(scale(base, 0.62)),
    deckBase: rgbCss(scale(base, 0.36)),
    deckDark: rgbCss(scale(base, 0.46)),
    deckLight: rgbCss(scale(base, 0.62)),
    tech,
    seed,
  }
}

function clampIndex(shiftIndex: number): number {
  return Math.min(Math.max(shiftIndex, 1), DEALER_HUES.length) - 1
}

function bowtie(hue: number): string {
  return `hsl(${hue}, 62%, 53%)`
}

function bowtieKnot(hue: number): string {
  return `hsl(${hue}, 64%, 40%)`
}

function deckColors(hue: number, id: string, tech: number, seed: number): CardBack {
  return {
    id,
    outer: `hsl(${hue}, 55%, 27%)`,
    panel: `hsl(${hue}, 54%, 40%)`,
    deckBase: `hsl(${hue}, 47%, 24%)`,
    deckDark: `hsl(${hue}, 52%, 29%)`,
    deckLight: `hsl(${hue}, 54%, 40%)`,
    tech,
    seed,
  }
}
