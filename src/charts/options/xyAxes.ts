// Axis ranges the X–Y plot sets itself rather than leaving to ECharts: round ends (niceRange), and the extent of
// everything drawn, widened to the origin ("Axes from zero") and to the range and endurance points. Pure.

/** A 1, 2 or 5 × 10ⁿ step near `raw`. */
export function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw))
  const f = raw / power
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power
}

/** The range widened to whole steps of a round number (about 6 steps across), without binary noise. */
export function niceRange([lo, hi]: readonly [number, number]): [number, number] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo, hi]
  const step = niceStep((hi - lo) / 6)
  const clean = (v: number) => Number(v.toPrecision(12))
  return [clean(Math.floor(lo / step) * step), clean(Math.ceil(hi / step) * step)]
}

/** A growing [min, max] pair per axis; starts empty (min > max). */
export class Extent {
  x: [number, number] = [Infinity, -Infinity]
  y: [number, number] = [Infinity, -Infinity]

  add(x: number, y: number): void {
    if (Number.isFinite(x)) {
      if (x < this.x[0]) this.x[0] = x
      if (x > this.x[1]) this.x[1] = x
    }
    if (Number.isFinite(y)) {
      if (y < this.y[0]) this.y[0] = y
      if (y > this.y[1]) this.y[1] = y
    }
  }

  /** Every pair of an interleaved array (x, y first in each group of `stride` values). */
  addInterleaved(values: ArrayLike<number>, stride: number, count = Math.floor(values.length / stride)): void {
    for (let i = 0; i < count; i += 1) this.add(values[i * stride], values[i * stride + 1])
  }
}

/** An axis range set by the app, and how many of its round steps it spans (ECharts' splitNumber: ticks fall on them). */
export interface ShownRange {
  range: [number, number]
  splits: number
}

/**
 * The axis range to show: `base` (a fixed range such as the focus on the bulk of the samples) or the extent of what is
 * drawn, widened to `include` and, with `fromZero`, to 0, then rounded (niceRange). null when there is nothing finite
 * to show or it has no width (ECharts then chooses).
 */
export function shownRange(
  base: readonly [number, number] | null | undefined,
  drawn: readonly [number, number],
  include: readonly number[],
  fromZero: boolean,
): ShownRange | null {
  let [lo, hi] = base && base[1] > base[0] ? base : drawn
  for (const v of include) {
    if (!Number.isFinite(v)) continue
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  if (fromZero) {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null
  const range = niceRange([lo, hi])
  // A 1, 2 or 5 × 10ⁿ step is its own "nice" interval in ECharts, so span / splits gives exactly this step.
  return { range, splits: Math.max(1, Math.round((range[1] - range[0]) / niceStep((hi - lo) / 6))) }
}
