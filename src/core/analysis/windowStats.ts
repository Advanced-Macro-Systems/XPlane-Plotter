// Window statistics that know about directions: a heading, track or wind direction wraps at north (0/360°), so its
// mean ± σ over a window is taken on the unwrapped values. Shared by the Test points table, the selection bar, the X–Y
// means and the test-point CSV / Copy table, so they all give the same numbers; the MATLAB script mirrors it
// (export/matlab.ts marks the channels isDirectionChannel picks, matlabLibrary's xppStats / xppUnwrapDegrees unwrap
// them the same way). Pure: no React, no DOM.

import type { Channel } from '../types'
import { driftPerMinute, rangeStats, type RangeStats } from './stats'

/** Tokens of channels that wrap at 360°: headings, track, the compass, wind directions, the heading bug. */
const DIRECTION_TOKEN = /^(hding,|hpath,|__mag,_comp|_wind,__dir|__set,hding)/
const DIRECTION_LABEL = /\b(heading|hdg|track|course|bearing|wind dir(ection)?)\b/i

/** A channel in degrees that wraps at north (0/360°), whose window stats must not straddle the wrap. */
export function isDirectionChannel(ch: Pick<Channel, 'token' | 'meta'>): boolean {
  if (ch.meta.unit !== 'deg') return false
  if (/0–360/.test(ch.meta.sign ?? '') || DIRECTION_TOKEN.test(ch.token)) return true
  return !ch.meta.known && DIRECTION_LABEL.test(ch.meta.label)
}

/** values[start..end) with the 0/360° wraps taken out: ±360 wherever consecutive finite samples jump by > 180°. */
export function unwrapDegrees(values: ArrayLike<number>, start: number, end: number): Float64Array {
  const lo = Math.max(0, Math.floor(start))
  const hi = Math.max(lo, Math.min(values.length, Math.ceil(end)))
  const out = new Float64Array(hi - lo)
  let offset = 0
  let previous = NaN
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) {
      out[i - lo] = NaN
      continue
    }
    let u = v + offset
    if (Number.isFinite(previous)) {
      while (u - previous > 180) {
        offset -= 360
        u -= 360
      }
      while (u - previous < -180) {
        offset += 360
        u += 360
      }
    }
    out[i - lo] = u
    previous = u
  }
  return out
}

/**
 * Mean ± σ and drift per minute (against `time`, s) of a channel over rows [start, end). For a direction channel the
 * window is unwrapped first, so a turn through north reads as a turn (the mean is given in 0–360°, min and max with
 * it), not as a 180° average with a huge spread.
 */
export function windowStats(
  ch: Pick<Channel, 'token' | 'meta' | 'values'>,
  time: ArrayLike<number>,
  start: number,
  end: number,
): { stats: RangeStats; drift: number } {
  if (!isDirectionChannel(ch)) {
    return { stats: rangeStats(ch.values, start, end), drift: driftPerMinute(ch.values, time, start, end) }
  }
  const lo = Math.max(0, Math.floor(start))
  const unwrapped = unwrapDegrees(ch.values, lo, end)
  const times = Float64Array.from({ length: unwrapped.length }, (_, k) => time[lo + k])
  const stats = rangeStats(unwrapped, 0, unwrapped.length)
  const drift = driftPerMinute(unwrapped, times, 0, unwrapped.length)
  if (!(stats.n > 0)) return { stats, drift }
  const shift = ((stats.mean % 360) + 360) % 360 - stats.mean
  return { stats: { ...stats, mean: stats.mean + shift, min: stats.min + shift, max: stats.max + shift }, drift }
}
