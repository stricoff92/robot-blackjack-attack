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

// Fixed hues for dealers 1..5: blue, purple, green, yellow, red.
const DEALER_HUES = [220, 275, 140, 48, 2] as const

// RGB dealer: a true RGB cycle — three sine waves a third of a period out of phase
// sweep the colour around the wheel every RGB_PERIOD_MS. The bowtie takes the exact
// colour each frame (smooth); the deck snaps its colour to RGB_STEPS phase steps so
// its card-back sprite cache stays small and is reused every cycle (re-rendering a
// back sprite each frame would thrash the cache and allocate an offscreen per frame).
const RGB_PERIOD_MS = 600
const RGB_STEPS = 16

export function isRgbDealer(shiftIndex: number): boolean {
  return shiftIndex >= RGB_DEALER
}

// The colour kit for the dealer at `shiftIndex` (1-based). `now` only matters for
// the RGB dealer, whose colour advances with time.
export function dealerColors(shiftIndex: number, now: number): DealerColors {
  if (isRgbDealer(shiftIndex)) {
    const bowtieRgb = cycleRgb(now, RGB_PERIOD_MS)
    // Snap the deck to the centre of the current phase step, so a whole step shares
    // one cached back sprite (and the same step recurs every cycle → cache hits).
    const step = Math.floor(rgbPos(now) * RGB_STEPS)
    const deckRgb = cycleRgb(((step + 0.5) / RGB_STEPS) * RGB_PERIOD_MS, RGB_PERIOD_MS)
    return {
      bowtie: rgbCss(bowtieRgb),
      bowtieKnot: rgbCss(scale(bowtieRgb, 0.72)),
      // Top-tech board, and a seed that's constant across the RGB colour steps so the
      // layout holds steady while only the colour shimmers.
      back: rgbDeck(deckRgb, `rgb${step}`, 1, RGB_DEALER * 2654435761),
    }
  }
  const hue = DEALER_HUES[clampIndex(shiftIndex)]
  return {
    bowtie: bowtie(hue),
    bowtieKnot: bowtieKnot(hue),
    back: deckColors(hue, `d${shiftIndex}`, techFor(shiftIndex), shiftIndex * 2654435761),
  }
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
