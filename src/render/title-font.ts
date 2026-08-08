// The retro display font used for the game's NAME on the tap-to-start screen — and only there.
// Sixtyfour is loaded once at page load via the FontFace API and registered on document.fonts so
// the canvas can render with it. Vite fingerprints the imported .ttf so the browser fetches it a
// single time.
//
// Same "ready flag" shape as the sprite loaders (see token-sprite.ts): callers fall back to the
// bold system font until the face arrives, and the continuously-running render loop simply picks
// up the display font on the first frame after it loads.

import titleFontUrl from '../assets/Sixtyfour-Regular-VariableFont_BLED,SCAN.ttf'

// The family name the canvas asks for. Kept in one place so the loader and callers agree.
export const TITLE_FONT_FAMILY = 'Sixtyfour'

let ready = false

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

// Whether the pixel title font has finished loading and is safe to draw with.
export function titleFontReady(): boolean {
  return ready
}
