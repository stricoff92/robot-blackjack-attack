import { sfx } from './audio/sfx'
import { music } from './audio/music'
import { voice } from './audio/voice'
import { mountGameView } from './ui/game-view'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('missing #app mount element')
}

// Download + decode every sound effect up front so a play() is instant. The
// context stays suspended until the first user gesture (autoplay policy); the
// SFX service resumes it then. Fire-and-forget — plays before it settles no-op.
void sfx.load()

// The dealer voice is fully synthesised (no assets to load), but its AudioContext must
// exist BEFORE the first user gesture so the shared unlock plumbing (context.ts) resumes
// it — otherwise the first laugh is born on a suspended context and never sounds.
voice.prime()

// Start the soundtrack on the first user gesture (autoplay policy blocks audio
// until then). "The Cannery" opens; the other tracks download lazily as each
// becomes the next to play. start() is idempotent, so the extra listener that
// doesn't fire is harmless — we remove both once music is going.
const startMusic = (): void => {
  music.start()
  window.removeEventListener('pointerdown', startMusic)
  window.removeEventListener('keydown', startMusic)
}
window.addEventListener('pointerdown', startMusic)
window.addEventListener('keydown', startMusic)

// Canvas-first UI (hybrid): the scene + cards render on the canvas layer, the
// action buttons and HUD live in the stage overlay.
mountGameView(root)
