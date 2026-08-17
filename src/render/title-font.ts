// The retro display font used for the game's NAME on the tap-to-start screen and the game-over
// score screen. Sixtyfour is loaded once at page load via the FontFace API and registered on
// document.fonts so the canvas can render with it. Vite fingerprints the imported .ttf so the
// browser fetches it a single time. The shared wordmark constants + font/measure helpers live
// here too, so the tap-to-start and score screens draw an identical title.
//
// Same "ready flag" shape as the sprite loaders (see token-sprite.ts): callers fall back to the
// bold system font until the face arrives, and the continuously-running render loop simply picks
// up the display font on the first frame after it loads.

import titleFontUrl from '../assets/Sixtyfour-Regular-VariableFont_BLED,SCAN.ttf'

// The family name the canvas asks for. Kept in one place so the loader and callers agree.
export const TITLE_FONT_FAMILY = 'Sixtyfour'

let ready = false

// Guard the browser-only FontFace API so this module is safe to import outside a browser (unit
// tests / SSR): there it simply stays not-ready and callers use the bold system fallback.
if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
  const face = new FontFace(TITLE_FONT_FAMILY, `url(${titleFontUrl})`)
  face.load().then(
    (loaded) => {
      document.fonts.add(loaded)
      ready = true
    },
    () => {
      // Load failed (offline / decode error): stay not-ready so the title keeps the bold fallback.
    },
  )
}

// Whether the pixel title font has finished loading and is safe to draw with.
export function titleFontReady(): boolean {
  return ready
}

// The game's wordmark, one word per projected line (drawn near the top of the felt on both the
// opening TAP-TO-START screen and the game-over score screen).
export const TITLE_LINES = ['ROBOT', 'BLACKJACK', 'ATTACK']

// The red cast projected behind the black title letters (the game's look).
export const TITLE_RED = 'rgba(226, 26, 26, 0.95)'

// A bold system font — the tap line, and the title's fallback until the pixel .ttf loads.
// NOTE: the family stack uses CONCRETE names only — NEVER `system-ui` / `-apple-system` here.
// iOS/iPadOS Safari's canvas 2D `font` setter rejects those generic keywords outright (the whole
// assignment is ignored, so the text draws in a leftover/default face). This stack resolves in
// every platform's canvas. Same rule applies to every other canvas `ctx.font` in the render code.
export function boldSystemFont(px: number, weight = 800): string {
  return `${weight} ${px}px "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif`
}

// The title's own face: the Sixtyfour display font once loaded, else the bold system fallback so
// the layout still measures + draws while the .ttf is in flight. Normal weight — the font ships a
// single Regular master, and synthetic bolding smears its retro glyphs.
export function titleFont(px: number): string {
  return ready ? `${px}px "${TITLE_FONT_FAMILY}"` : boldSystemFont(px, 900)
}

// Width of the widest title word in the ctx's current font — for fit-shrinking the block to width.
export function measureTitleWidest(ctx: CanvasRenderingContext2D): number {
  let widest = 0
  for (const line of TITLE_LINES) {
    widest = Math.max(widest, ctx.measureText(line).width)
  }
  return widest
}
