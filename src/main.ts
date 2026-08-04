import { mountGameView } from './ui/game-view'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('missing #app mount element')
}

// Canvas-first UI (hybrid): the scene + cards render on the canvas layer, the
// action buttons and HUD live in the stage overlay.
mountGameView(root)
