// Whole-channel statistics (min, max, mean, std, finite count, constant). Its own module with no imports at runtime, so
// the parser worker can compute them off the main thread without pulling in the channel dictionary.

import type { ChannelStats } from './types'

/** NaN-aware stats over all values. `constant` is true when every finite value is equal or there are none. */
export function computeStats(values: Float64Array): ChannelStats {
  let finite = 0
  let min = Infinity
  let max = -Infinity
  let mean = 0
  let m2 = 0
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    finite += 1
    if (v < min) min = v
    if (v > max) max = v
    // Welford's online update: stable for large offsets (e.g. absolute times, positions in metres).
    const delta = v - mean
    mean += delta / finite
    m2 += delta * (v - mean)
  }
  if (finite === 0) return { min: NaN, max: NaN, mean: NaN, std: NaN, finite: 0, constant: true }
  return {
    min,
    max,
    mean,
    std: finite > 1 ? Math.sqrt(m2 / (finite - 1)) : 0,
    finite,
    constant: min === max,
  }
}
