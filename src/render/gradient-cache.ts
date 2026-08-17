// A tiny cache for CanvasGradients.
//
// Building a gradient (createLinear/RadialGradient + addColorStop) allocates every
// frame it runs, and most of the game's gradients are constant for a given layout —
// the nexus body, the lens bezels, the health-bar frame, the eye glow. Rebuilding them
// 60×/sec is pure GC churn. Callers whose gradient only changes with the layout build
// it once through here, keyed by a layout-derived string, and reuse it until that key
// changes (i.e. a resize).
//
// Gradients are immutable once built and safe to reuse across frames, but they are
// created BY a context, so the cache is partitioned per context (each canvas layer has
// its own). A gradient's coordinates are baked in its own local space and transformed
// by the current matrix at fill time, so a moving element (e.g. the hovering nexus)
// builds its gradient around the origin and translates the context into place instead
// of rebuilding it each frame.

const byContext = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>()

export function cachedGradient(
  ctx: CanvasRenderingContext2D,
  key: string,
  build: (ctx: CanvasRenderingContext2D) => CanvasGradient,
): CanvasGradient {
  let cache = byContext.get(ctx)
  if (!cache) {
    cache = new Map()
    byContext.set(ctx, cache)
  }
  let gradient = cache.get(key)
  if (!gradient) {
    if (cache.size > 64) {
      cache.clear() // bound across many resizes; keys are few per layout
    }
    gradient = build(ctx)
    cache.set(key, gradient)
  }
  return gradient
}
