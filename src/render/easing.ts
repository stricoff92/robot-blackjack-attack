// A small family of easing functions for animation timing.
//
// All take a normalized time t in [0, 1] and return an eased value (normally
// also in [0, 1]). Named after Squirrel Eiserloh's smoothStart / smoothEnd
// convention. Written with plain multiplication rather than Math.pow — for
// small integer powers the explicit form is clearer and faster, and sidesteps
// pow's general-case (logarithm-based) overhead.

export type EasingFunc = (t: number) => number

/** No easing — constant rate. */
export const linear: EasingFunc = (t) => t

// --- smoothStart: ease in, accelerating from a standstill (slow → fast) ---

export const smoothStart2: EasingFunc = (t) => t * t
export const smoothStart3: EasingFunc = (t) => t * t * t
export const smoothStart4: EasingFunc = (t) => t * t * t * t
export const smoothStart5: EasingFunc = (t) => t * t * t * t * t

// --- smoothEnd: ease out, decelerating to a stop (fast → slow) ---
// Each is the mirror of the matching smoothStart: 1 - smoothStartN(1 - t).

export const smoothEnd2: EasingFunc = (t) => {
  const u = 1 - t
  return 1 - u * u
}
export const smoothEnd3: EasingFunc = (t) => {
  const u = 1 - t
  return 1 - u * u * u
}
export const smoothEnd4: EasingFunc = (t) => {
  const u = 1 - t
  return 1 - u * u * u * u
}
export const smoothEnd5: EasingFunc = (t) => {
  const u = 1 - t
  return 1 - u * u * u * u * u
}

// --- smoothStep: ease in and out, standstill at both ends (slow → fast → slow) ---

/** Classic smoothstep: 3t² − 2t³ (C¹ continuous). */
export const smoothStep: EasingFunc = (t) => t * t * (3 - 2 * t)

/** Perlin's smootherstep: 6t⁵ − 15t⁴ + 10t³ (C² continuous, gentler ends). */
export const smootherStep: EasingFunc = (t) => t * t * t * (t * (t * 6 - 15) + 10)

// --- arch: rises to a peak and back to zero (0 → 1 → 0) — good for pulses ---

/** Parabolic arch, peaking at 1.0 when t = 0.5. */
export const arch2: EasingFunc = (t) => 4 * t * (1 - t)

// --- combinators for building new curves from the ones above ---

/** Reverse time: turns an ease-in into its ease-out mirror, and vice versa. */
export const flip =
  (ease: EasingFunc): EasingFunc =>
  (t) =>
    1 - ease(1 - t)

/** Blend two curves by a fixed weight in [0, 1] (0 = a, 1 = b). */
export const mix =
  (a: EasingFunc, b: EasingFunc, weight: number): EasingFunc =>
  (t) => {
    const av = a(t)
    return av + weight * (b(t) - av)
  }

/** Blend two curves using t itself as the weight (a at the start, b at the end). */
export const crossfade =
  (a: EasingFunc, b: EasingFunc): EasingFunc =>
  (t) => {
    const av = a(t)
    return av + t * (b(t) - av)
  }
