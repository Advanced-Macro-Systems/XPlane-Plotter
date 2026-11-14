// Geometry of the table sparklines (components/Sparkline.tsx draws it on a canvas): the min/max-decimated series,
// cached per channel, scaled into pixel polylines that break at missing samples. No DOM here (unit-tested in node).

import { minMaxDecimate } from '../../core/analysis/decimate'

export interface SparkGeometry {
  /** Polylines in CSS pixels; a new one starts after every gap */
  paths: [number, number][][]
  /** Every finite value is equal: drawn as a flat line at mid height */
  flat: boolean
  /** No finite value at all */
  empty: boolean
}

type Series = { x: Float64Array; y: Float64Array }

/** Decimated copies, cached per values array (channels are immutable; formulas get new arrays when re-evaluated). */
const cache = new WeakMap<object, { x: ArrayLike<number>; buckets: number; series: Series }>()

/** minMaxDecimate(x, y, buckets), computed once per (y array, x array, buckets). */
export function sparkSeries(x: ArrayLike<number>, y: ArrayLike<number>, buckets: number): Series {
  const key = y as unknown as object
  const hit = cache.get(key)
  if (hit && hit.x === x && hit.buckets === buckets) return hit.series
  const series = minMaxDecimate(x, y, buckets)
  cache.set(key, { x, buckets, series })
  return series
}

/** Scales a series into `width` × `height` CSS pixels with `pad` pixels kept clear at the edges. */
export function sparkGeometry(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  width: number,
  height: number,
  pad = 2,
): SparkGeometry {
  const n = Math.min(x.length, y.length)
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
    if (x[i] < xMin) xMin = x[i]
    if (x[i] > xMax) xMax = x[i]
    if (y[i] < yMin) yMin = y[i]
    if (y[i] > yMax) yMax = y[i]
  }
  if (!(xMin <= xMax)) return { paths: [], flat: false, empty: true }
  const flat = yMin === yMax
  const innerW = Math.max(1, width - 2 * pad)
  const innerH = Math.max(1, height - 2 * pad)
  const sx = xMax > xMin ? innerW / (xMax - xMin) : 0
  const sy = flat ? 0 : innerH / (yMax - yMin)
  const paths: [number, number][][] = []
  let current: [number, number][] = []
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      if (current.length) paths.push(current)
      current = []
      continue
    }
    const px = xMax > xMin ? pad + (x[i] - xMin) * sx : width / 2
    // Canvas y grows downwards: the largest value at the top.
    const py = flat ? height / 2 : pad + (yMax - y[i]) * sy
    current.push([px, py])
  }
  if (current.length) paths.push(current)
  return { paths, flat, empty: false }
}
