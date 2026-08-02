import { mountGame } from './ui/game'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('missing #app mount element')
}

mountGame(root)
