export type CanvasRenderer = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void

export interface GameCanvas {
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
  width: number
  height: number
  dispose(): void
}

export function createGameCanvas(root: HTMLElement, render: CanvasRenderer): GameCanvas {
  const canvas = document.createElement('canvas')
  const context = requireContext(canvas)
  root.appendChild(canvas)

  const gameCanvas: GameCanvas = {
    canvas,
    context,
    width: 0,
    height: 0,
    dispose,
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    const width = root.clientWidth
    const height = root.clientHeight

    // backing store at device resolution keeps rendering crisp on high-DPI screens
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    context.setTransform(dpr, 0, 0, dpr, 0, 0)

    gameCanvas.width = width
    gameCanvas.height = height
    render(context, width, height)
  }

  const observer = new ResizeObserver(resize)
  observer.observe(root)
  resize()

  function dispose(): void {
    observer.disconnect()
    canvas.remove()
  }

  return gameCanvas
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('2d canvas context unavailable')
  }
  return context
}
