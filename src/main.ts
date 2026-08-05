import { sfx } from './audio/sfx'
import { mountGameView } from './ui/game-view'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('missing #app mount element')
}

// Download + decode every sound effect up front so a play() is instant. The
// context stays suspended until the first user gesture (autoplay policy); the
// SFX service resumes it then. Fire-and-forget — plays before it settles no-op.
void sfx.load()

// Canvas-first UI (hybrid): the scene + cards render on the canvas layer, the
// action buttons and HUD live in the stage overlay.
mountGameView(root)
