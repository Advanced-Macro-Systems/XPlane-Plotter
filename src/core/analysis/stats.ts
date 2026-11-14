// Descriptive statistics over row ranges. All functions ignore NaN samples.
// OWNER: analysis agent. Public API below is a contract; keep these signatures.

export interface RangeStats {
  /** finite samples used */
  n: number
  mean: number
  /** sample standard deviation (n - 1); 0 when n === 1; NaN when n === 0 */
  std: number
  min: number
  max: number
  rms: number
}

/**
 * Integer bounds of the half-open range [start, end) clamped to [0, length]: the indices i with start <= i < end.
 * A NaN bound gives an empty range.
 */
export function clampRowRange(length: number, start: number, end: number): [number, number] {
  if (Number.isNaN(start) || Number.isNaN(end)) return [0, 0]
  const lo = Math.min(length, Math.max(0, Math.ceil(start)))
  const hi = Math.min(length, Math.max(lo, Math.ceil(end)))
  return [lo, hi]
}

/** Stats of values[start..end) (half-open, clamped to the array). Non-finite samples (NaN, ±Infinity) are skipped. */
export function rangeStats(values: ArrayLike<number>, start: number, end: number): RangeStats {
  const [lo, hi] = clampRowRange(values.length, start, end)
  let n = 0
  let mean = 0
  let m2 = 0
  let min = Infinity
  let max = -Infinity
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    n += 1
    // Welford's update: no catastrophic cancellation for large offsets (altitudes, absolute times).
    const delta = v - mean
    mean += delta / n
    m2 += delta * (v - mean)
    if (v < min) min = v
    if (v > max) max = v
  }
  if (n === 0) return { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN, rms: NaN }
  m2 = Math.max(0, m2)
  return {
    n,
    mean,
    std: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0,
    min,
    max,
    // mean square = mean² + population variance: avoids summing squares of large values.
    rms: Math.sqrt(mean * mean + m2 / n),
  }
}

/**
 * Least-squares slope of values against time over [start, end), scaled to "per minute" (time in seconds).
 * Used to judge steadiness of a test point (e.g. airspeed drift kt/min). NaN when fewer than 3 finite pairs.
 */
export function driftPerMinute(values: ArrayLike<number>, time: ArrayLike<number>, start: number, end: number): number {
  const [lo, hi] = clampRowRange(Math.min(values.length, time.length), start, end)
  // Two passes (means, then centred sums) keep the slope accurate for large time offsets.
  let n = 0
  let tMean = 0
  let vMean = 0
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    const t = time[i]
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue
    n += 1
    tMean += (t - tMean) / n
    vMean += (v - vMean) / n
  }
  if (n < 3) return NaN
  let stt = 0
  let stv = 0
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    const t = time[i]
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue
    const dt = t - tMean
    stt += dt * dt
    stv += dt * (v - vMean)
  }
  return stt > 0 ? (60 * stv) / stt : NaN
}
