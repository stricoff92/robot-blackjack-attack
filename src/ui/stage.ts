import './stage.css'

import { createLayeredCanvas, type LayeredCanvas } from '../render/canvas'

export interface Stage {
  /** The positioned wrapper holding the canvas layers + overlay. */
  readonly container: HTMLElement
  /** Stacked canvas layers (bottom → top in `names` order). */
  readonly canvas: LayeredCanvas
  /** The HTML layer above the canvases for DOM controls (buttons, HUD). */
  readonly overlay: HTMLElement
  dispose(): void
}

// Sets up the hybrid layout: N stacked canvas layers with an HTML overlay on
// top. `onResize` fires with the layered canvas whenever the size changes —
// callers repaint their static layers there. Layers appear in `names` order,
// bottom first.
export function createStage(
  root: HTMLElement,
  names: readonly string[],
  onResize: (canvas: LayeredCanvas) => void,
): Stage {
  const container = document.createElement('div')
  container.className = 'stage'
  root.appendChild(container)

  const canvas = createLayeredCanvas(container, names, onResize)

  const overlay = document.createElement('div')
  overlay.className = 'stage__overlay'
  container.appendChild(overlay)

  function dispose(): void {
    canvas.dispose()
    container.remove()
  }

  return { container, canvas, overlay, dispose }
}
