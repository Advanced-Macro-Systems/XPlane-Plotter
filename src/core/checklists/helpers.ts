// Shared, pure helpers of the test-validity checklists, so that a check id computes the same thing in every checklist
// (only the thresholds are each test's): channel lookup by X-Plane token, window statistics, the time base and sample
// rate, power steadiness, configuration, trim motion, settling after a power change, who flew pitch (pilot or
// autopilot) and autothrottle evidence. Rows are half-open [start, end); time is Dataset.elapsed (sim time, resets and
// gaps collapsed). No React, no DOM.

import { channelById } from '../dataset'
import type { Channel, Dataset } from '../types'
import { formatCitations, notCheckableText } from './cite'
import type { Check, CheckDef, CheckStatus, ChecklistKind } from './types'

// ------------------------------------------------------------------ channels

/** A channel by header token (or id) when it has at least one finite sample, else null. */
export function findChannel(ds: Dataset, token: string): Channel | null {
  const ch = channelById(ds, token)
  return ch && ch.stats.finite > 0 ? ch : null
}

/** The first of several tokens the log has. */
export function firstChannel(ds: Dataset, tokens: readonly string[]): Channel | null {
  for (const token of tokens) {
    const ch = findChannel(ds, token)
    if (ch) return ch
  }
  return null
}

/** Per-engine channels (engines 1..8) named by `token(k)`, e.g. k => `thrst,_${k},lb`. */
export function engineChannels(ds: Dataset, token: (k: number) => string): Channel[] {
  const out: Channel[] = []
  for (let k = 1; k <= 8; k += 1) {
    const ch = findChannel(ds, token(k))
    if (ch) out.push(ch)
  }
  return out
}

export const LEVER = (k: number) => `thro${k},handl`
export const LEVER_LEGACY = (k: number) => `thro${k},_part`
export const LEVER_ACTUAL = (k: number) => `thro${k},engin`
export const THRUST = (k: number) => `thrst,_${k},lb`
export const POWER_HP = (k: number) => `engn${k},___hp`
export const POWER_LEGACY = (k: number) => `power,_${k},hp`
export const N1 = (k: number) => `N1__${k},_pcnt`
export const FUEL_FLOW = (k: number) => `FF__${k},_lb/h`
export const TSFC = (k: number) => `SFC_${k},lblbh`
export const BSFC = (k: number) => `SFC_${k},lbhph`

/** The throttle levers: X-Plane 12's handles, else the X-Plane 10/11 token, else the throttle reaching each engine. */
export function leverChannels(ds: Dataset): Channel[] {
  const handles = engineChannels(ds, LEVER)
  if (handles.length) return handles
  const legacy = engineChannels(ds, LEVER_LEGACY)
  return legacy.length ? legacy : engineChannels(ds, LEVER_ACTUAL)
}

// ------------------------------------------------------------------ window statistics

export interface WindowSummary {
  n: number
  mean: number
  /** Sample standard deviation (n − 1); 0 for one sample */
  sd: number
  min: number
  max: number
  range: number
}

const EMPTY: WindowSummary = { n: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, range: NaN }

/** Mean, σ, min, max and range of the finite values in rows [a, b). */
export function summary(values: ArrayLike<number>, a: number, b: number): WindowSummary {
  const lo = Math.max(0, Math.floor(a))
  const hi = Math.min(values.length, Math.ceil(b))
  let n = 0
  let mean = 0
  let m2 = 0
  let min = Infinity
  let max = -Infinity
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    n += 1
    const d = v - mean
    mean += d / n
    m2 += d * (v - mean)
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!n) return EMPTY
  return { n, mean, sd: n > 1 ? Math.sqrt(Math.max(0, m2) / (n - 1)) : 0, min, max, range: max - min }
}

export interface Trend {
  n: number
  mean: number
  /** Least-squares slope per second (NaN with fewer than 3 samples) */
  slope: number
  /** σ of the residuals about the line (n − 2) */
  residualSd: number
  /** First to last sample time, s */
  seconds: number
}

/** Least-squares line of values against time over rows [a, b). */
export function trend(values: ArrayLike<number>, time: ArrayLike<number>, a: number, b: number): Trend {
  const lo = Math.max(0, Math.floor(a))
  const hi = Math.min(values.length, time.length, Math.ceil(b))
  let n = 0
  let tm = 0
  let vm = 0
  let tFirst = NaN
  let tLast = NaN
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    const t = time[i]
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue
    n += 1
    tm += (t - tm) / n
    vm += (v - vm) / n
    if (!Number.isFinite(tFirst)) tFirst = t
    tLast = t
  }
  const seconds = n ? tLast - tFirst : 0
  if (n < 3) return { n, mean: n ? vm : NaN, slope: NaN, residualSd: NaN, seconds }
  let stt = 0
  let stv = 0
  let svv = 0
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    const t = time[i]
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue
    stt += (t - tm) ** 2
    stv += (t - tm) * (v - vm)
    svv += (v - vm) ** 2
  }
  const slope = stt > 0 ? stv / stt : NaN
  const ssr = Number.isFinite(slope) ? Math.max(0, svv - slope * stv) : svv
  return { n, mean: vm, slope, residualSd: Math.sqrt(ssr / (n - 2)), seconds }
}

/** The largest |value| over rows [a, b) (NaN when none is finite). */
export function maxAbs(values: ArrayLike<number>, a: number, b: number): number {
  const s = summary(values, a, b)
  return s.n ? Math.max(Math.abs(s.min), Math.abs(s.max)) : NaN
}

/**
 * Rows [a, b) of `values` averaged over ±`half` seconds around each, using samples inside [a, b) only (a change just
 * outside the window must not leak in). NaN where a row has no finite neighbour. Indexed from a.
 */
export function smoothInside(values: ArrayLike<number>, time: ArrayLike<number>, a: number, b: number, half = 1): Float64Array {
  const out = new Float64Array(Math.max(0, b - a))
  let lo = a
  let hi = a
  let sum = 0
  let count = 0
  for (let i = a; i < b; i += 1) {
    while (hi < b && time[hi] <= time[i] + half) {
      if (Number.isFinite(values[hi])) {
        sum += values[hi]
        count += 1
      }
      hi += 1
    }
    while (lo < i && time[lo] < time[i] - half) {
      if (Number.isFinite(values[lo])) {
        sum -= values[lo]
        count -= 1
      }
      lo += 1
    }
    out[i - a] = count > 0 ? sum / count : NaN
  }
  return out
}

/** The element-wise sum of several channels over rows [a, b) (NaN where any is missing). Indexed from a. */
export function sumChannels(channels: readonly Channel[], a: number, b: number): Float64Array {
  const out = new Float64Array(Math.max(0, b - a))
  for (let i = a; i < b; i += 1) {
    let s = 0
    for (const ch of channels) s += ch.values[i]
    out[i - a] = s
  }
  return out
}

/** A slice of elapsed time [a, b), indexed from a. */
export function timeSlice(ds: Dataset, a: number, b: number): Float64Array {
  return ds.elapsed.subarray(Math.max(0, a), Math.min(ds.rowCount, b))
}

/** Least-squares fit y = c0 + c1·x over paired finite values; R² and the standard error of c1. */
export function linearFit(x: ArrayLike<number>, y: ArrayLike<number>): { c0: number; c1: number; seC1: number; r2: number; n: number } {
  let n = 0
  let xm = 0
  let ym = 0
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
    n += 1
    xm += (x[i] - xm) / n
    ym += (y[i] - ym) / n
  }
  if (n < 2) return { c0: NaN, c1: NaN, seC1: NaN, r2: NaN, n }
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
    sxx += (x[i] - xm) ** 2
    sxy += (x[i] - xm) * (y[i] - ym)
    syy += (y[i] - ym) ** 2
  }
  if (!(sxx > 0)) return { c0: ym, c1: NaN, seC1: NaN, r2: NaN, n }
  const c1 = sxy / sxx
  const ssr = Math.max(0, syy - c1 * sxy)
  return {
    c0: ym - c1 * xm,
    c1,
    seC1: n > 2 ? Math.sqrt(ssr / (n - 2) / sxx) : NaN,
    r2: syy > 0 ? 1 - ssr / syy : NaN,
    n,
  }
}

/**
 * Least squares y = c0 + c1·x1 + c2·x2 (normal equations, centred): coefficients and standard errors; null when the
 * columns are degenerate.
 */
export function twoVariableFit(
  x1: readonly number[],
  x2: readonly number[],
  y: readonly number[],
): { c: [number, number, number]; se: [number, number, number]; r2: number; n: number } | null {
  const idx = y.map((_, i) => i).filter((i) => [x1[i], x2[i], y[i]].every(Number.isFinite))
  const n = idx.length
  if (n < 3) return null
  const m1 = idx.reduce((s, i) => s + x1[i], 0) / n
  const m2 = idx.reduce((s, i) => s + x2[i], 0) / n
  const my = idx.reduce((s, i) => s + y[i], 0) / n
  let s11 = 0
  let s22 = 0
  let s12 = 0
  let s1y = 0
  let s2y = 0
  let syy = 0
  for (const i of idx) {
    const a = x1[i] - m1
    const b = x2[i] - m2
    const c = y[i] - my
    s11 += a * a
    s22 += b * b
    s12 += a * b
    s1y += a * c
    s2y += b * c
    syy += c * c
  }
  const det = s11 * s22 - s12 * s12
  if (!(Math.abs(det) > 1e-12 * Math.max(1e-300, s11 * s22))) return null
  const c1 = (s22 * s1y - s12 * s2y) / det
  const c2 = (s11 * s2y - s12 * s1y) / det
  const c0 = my - c1 * m1 - c2 * m2
  const ssr = Math.max(0, syy - c1 * s1y - c2 * s2y)
  const dof = n - 3
  const s2 = dof > 0 ? ssr / dof : NaN
  return {
    c: [c0, c1, c2],
    se: [NaN, Math.sqrt((s2 * s22) / det), Math.sqrt((s2 * s11) / det)],
    r2: syy > 0 ? 1 - ssr / syy : NaN,
    n,
  }
}

// ------------------------------------------------------------------ segments

/** True when a reset or gap (a segment start) lies strictly inside rows [a, b). */
export function crossesSegment(ds: Dataset, a: number, b: number): boolean {
  return ds.segments.some((s) => s.start > a && s.start < b)
}

/** The first row of the segment that holds `row` (0 without segments). */
export function segmentStart(ds: Dataset, row: number): number {
  let start = 0
  for (const s of ds.segments) if (s.start <= row) start = s.start
  return start
}

/** The end (exclusive) of the segment that holds `row`. */
export function segmentEnd(ds: Dataset, row: number): number {
  for (const s of ds.segments) if (s.start <= row && row < s.end) return s.end
  return ds.rowCount
}

/** The first row at or after time t within [lo, hi) (binary search on elapsed time). */
export function rowAtTime(ds: Dataset, t: number, lo = 0, hi = ds.rowCount): number {
  let a = Math.max(0, lo)
  let b = Math.min(ds.rowCount, hi)
  while (a < b) {
    const mid = (a + b) >> 1
    if (ds.elapsed[mid] < t) a = mid + 1
    else b = mid
  }
  return a
}

/** Rows [a, b) widened by `seconds` on each side, never across a segment boundary. */
export function widen(ds: Dataset, a: number, b: number, seconds: number): [number, number] {
  const lo = segmentStart(ds, a)
  const hi = segmentEnd(ds, Math.max(a, b - 1))
  return [rowAtTime(ds, ds.elapsed[a] - seconds, lo, a), Math.min(hi, rowAtTime(ds, ds.elapsed[b - 1] + seconds + 1e-9, b, hi))]
}

// ------------------------------------------------------------------ shared measurements

export interface TimeBase {
  /** 'sim': elapsed from sim time (_totl,_time or missn,_time); 'real': from _real,_time; 'other': another column */
  kind: 'sim' | 'real' | 'other' | 'none'
  source: string | null
  /** A reset or gap inside the rows */
  crosses: boolean
}

/** Which clock elapsed time was built from, and whether the rows cross a reset or gap. */
export function timeBase(ds: Dataset, a: number, b: number): TimeBase {
  const id = ds.timeSourceId
  const token = id ? (channelById(ds, id)?.token ?? id) : null
  const kind = !token ? 'none' : token === '_totl,_time' || token === 'missn,_time' ? 'sim' : token === '_real,_time' ? 'real' : 'other'
  return { kind, source: token, crosses: crossesSegment(ds, a, b) }
}

export interface SampleRate {
  /** (rows − 1) / duration, Hz */
  rate: number
  /** Steps longer than 3 × the median step */
  dropouts: number
  /** First to last row, s */
  seconds: number
  rows: number
}

/** Sample rate over rows [a, b) and the dropouts in it. */
export function sampleRate(ds: Dataset, a: number, b: number): SampleRate {
  const rows = Math.max(0, b - a)
  const seconds = rows > 1 ? ds.elapsed[b - 1] - ds.elapsed[a] : 0
  const steps: number[] = []
  for (let i = a + 1; i < b; i += 1) steps.push(ds.elapsed[i] - ds.elapsed[i - 1])
  steps.sort((x, y) => x - y)
  const median = steps.length ? steps[steps.length >> 1] : NaN
  let dropouts = 0
  for (let i = a + 1; i < b; i += 1) if (ds.elapsed[i] - ds.elapsed[i - 1] > 3 * median) dropouts += 1
  return { rate: seconds > 0 ? (rows - 1) / seconds : NaN, dropouts, seconds, rows }
}

export interface PowerSteadiness {
  /** The force that decides: summed thrust, summed engine power, N1, else the lever; null when none is logged */
  force: 'thrust' | 'power' | 'n1' | 'lever' | null
  /** Thrust (or power) range / mean over the rows, smoothed ±1 s inside them (NaN without) */
  forceRange: number
  /** The largest N1 range of an engine, % points, smoothed (NaN without N1) */
  n1Range: number
  /** The largest raw lever range of an engine (NaN without levers) */
  leverRange: number
  /** The largest raw range of the throttle reaching each engine (thro<k>,engin; NaN without) */
  actualRange: number
  /** Largest |N1 − its mean over `reference`| over the rows, % points (dynamic spec) */
  n1Deviation: number
  /** The summed thrust's mean over the rows */
  thrustMean: number
}

/**
 * How steady the power was over rows [a, b): the summed thrust or engine power (the force) as a range over its mean,
 * N1 and the lever, each smoothed over ±1 s using samples inside the rows only (the levers raw). `reference` gives the
 * rows N1's deviation is measured from (the trim window in the dynamic checklist; default the rows themselves).
 */
export function powerSteadiness(ds: Dataset, a: number, b: number, reference?: [number, number]): PowerSteadiness {
  const time = ds.elapsed
  const relRange = (series: Float64Array): number => {
    const s = summary(series, 0, series.length)
    return s.n && Math.abs(s.mean) > 0 ? s.range / Math.abs(s.mean) : NaN
  }
  const thrusts = engineChannels(ds, THRUST)
  const powers = engineChannels(ds, POWER_HP).length ? engineChannels(ds, POWER_HP) : engineChannels(ds, POWER_LEGACY)
  const n1s = engineChannels(ds, N1)
  const levers = leverChannels(ds)
  const actual = engineChannels(ds, LEVER_ACTUAL)
  const smooth = (values: ArrayLike<number>) => smoothInside(values, time, a, b, 1)
  const thrustSum = thrusts.length ? sumChannels(thrusts, a, b) : null
  const thrustRange = thrustSum ? relRange(smoothInside(thrustSum, time.subarray(a, b), 0, b - a, 1)) : NaN
  const powerSum = powers.length ? sumChannels(powers, a, b) : null
  const powerRange = powerSum ? relRange(smoothInside(powerSum, time.subarray(a, b), 0, b - a, 1)) : NaN
  let n1Range = NaN
  let n1Deviation = NaN
  for (const ch of n1s) {
    const r = summary(smooth(ch.values), 0, b - a).range
    if (Number.isFinite(r)) n1Range = Number.isFinite(n1Range) ? Math.max(n1Range, r) : r
    const ref = summary(ch.values, reference?.[0] ?? a, reference?.[1] ?? b).mean
    const s = summary(ch.values, a, b)
    if (Number.isFinite(ref) && s.n) {
      const d = Math.max(Math.abs(s.max - ref), Math.abs(s.min - ref))
      n1Deviation = Number.isFinite(n1Deviation) ? Math.max(n1Deviation, d) : d
    }
  }
  const rawRange = (chs: readonly Channel[]) => {
    let out = NaN
    for (const ch of chs) {
      const r = summary(ch.values, a, b).range
      if (Number.isFinite(r)) out = Number.isFinite(out) ? Math.max(out, r) : r
    }
    return out
  }
  const leverRange = rawRange(levers)
  const force: PowerSteadiness['force'] = Number.isFinite(thrustRange)
    ? 'thrust'
    : Number.isFinite(powerRange)
      ? 'power'
      : Number.isFinite(n1Range)
        ? 'n1'
        : Number.isFinite(leverRange)
          ? 'lever'
          : null
  return {
    force,
    forceRange: force === 'thrust' ? thrustRange : force === 'power' ? powerRange : NaN,
    n1Range,
    leverRange,
    actualRange: rawRange(actual),
    n1Deviation,
    thrustMean: thrustSum ? summary(thrustSum, 0, thrustSum.length).mean : NaN,
  }
}

export interface ConfigurationState {
  /** Row 13's surfaces that are logged: flaps, slats, speedbrake (positions, else handles) */
  surfaces: { name: string; token: string; range: number; mean: number }[]
  /** Gear: the handle (row 14) or the per-gear deployment (row 67); null when not logged */
  gear: { range: number; mean: number } | null
}

/** Flaps, slats, speedbrake and gear over rows [a, b): each one's range and mean. */
export function configuration(ds: Dataset, a: number, b: number): ConfigurationState {
  const pick = (name: string, tokens: string[]) => {
    const ch = firstChannel(ds, tokens)
    if (!ch) return null
    const s = summary(ch.values, a, b)
    return { name, token: ch.token, range: s.range, mean: s.mean }
  }
  const surfaces = [
    pick('flaps', ['_flap,postn', '_flap,handl']),
    pick('slats', ['_slat,ratio']),
    pick('speedbrake', ['sbrak,postn', 'sbrak,handl']),
  ].filter((s): s is NonNullable<typeof s> => s !== null)
  const handle = findChannel(ds, '_gear,__0/1')
  let gear: ConfigurationState['gear'] = null
  if (handle) {
    const s = summary(handle.values, a, b)
    gear = { range: s.range, mean: s.mean }
  } else {
    const legs = ds.channels.filter((ch) => ch.token === '_gear,__rat' && ch.stats.finite > 0)
    if (legs.length) {
      const ss = legs.map((ch) => summary(ch.values, a, b))
      gear = { range: Math.max(...ss.map((s) => s.range)), mean: Math.max(...ss.map((s) => s.mean)) }
    }
  }
  return { surfaces, gear }
}

/** The pitch trim over rows [a, b): its range and the largest change within any 0.5 s (a step). */
export function trimMotion(ds: Dataset, a: number, b: number): { range: number; step: number } | null {
  const ch = findChannel(ds, '_trim,_elev')
  if (!ch) return null
  return { range: summary(ch.values, a, b).range, step: largestChangeWithin(ch.values, ds.elapsed, a, b, 0.5) }
}

/** The largest max − min of `values` within any `seconds`-long stretch of rows [a, b) (monotone queues). */
export function largestChangeWithin(values: ArrayLike<number>, time: ArrayLike<number>, a: number, b: number, seconds: number): number {
  const maxQ: number[] = []
  const minQ: number[] = []
  let start = a
  let best = 0
  for (let i = a; i < b; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    while (maxQ.length && values[maxQ[maxQ.length - 1]] <= v) maxQ.pop()
    maxQ.push(i)
    while (minQ.length && values[minQ[minQ.length - 1]] >= v) minQ.pop()
    minQ.push(i)
    while (time[i] - time[start] > seconds) start += 1
    while (maxQ[0] < start) maxQ.shift()
    while (minQ[0] < start) minQ.shift()
    best = Math.max(best, values[maxQ[0]] - values[minQ[0]])
  }
  return best
}

export interface Settling {
  /** Seconds from the last power change before the rows to their start; null when it cannot be told */
  tSet: number | null
  /** A change was found in the look-back (else tSet is the look-back's length) */
  found: boolean
  /** Length of the look-back actually available, s */
  lookback: number
  /** Least-squares trend of the force over the rows × their duration, % of its mean (NaN without) */
  thrustTrend: number
  /** What was read: 'lever', 'thrust', 'power', 'n1' or null */
  by: 'lever' | 'thrust' | 'power' | 'n1' | null
}

/**
 * How long before rows [a, b) the power was last changed: the last sample in the look-back (up to `lookbackS`, never
 * across a reset or gap) where any lever was more than 0.002 from its mean over the rows; without levers, where the
 * summed thrust (else engine power, else N1), smoothed ±1 s, was more than 1 % from its mean over the rows. Also the
 * force's trend over the rows (thrust, else power, else N1), as a share of its mean.
 */
export function settling(ds: Dataset, a: number, b: number, lookbackS: number): Settling {
  const time = ds.elapsed
  const lo = rowAtTime(ds, time[a] - lookbackS, segmentStart(ds, a), a)
  const lookback = time[a] - time[lo]
  const levers = leverChannels(ds)
  const thrusts = engineChannels(ds, THRUST)
  // Engine power as powerSteadiness reads it: X-Plane 12's engn hp, else the legacy power,_k,hp.
  const powers = engineChannels(ds, POWER_HP).length ? engineChannels(ds, POWER_HP) : engineChannels(ds, POWER_LEGACY)
  const n1s = engineChannels(ds, N1)
  const forceChannels = thrusts.length ? thrusts : powers.length ? powers : n1s
  let thrustTrend = NaN
  if (forceChannels.length) {
    const sum = sumChannels(forceChannels, a, b)
    const t = trend(sum, time.subarray(a, b), 0, b - a)
    if (Number.isFinite(t.slope) && Math.abs(t.mean) > 0) thrustTrend = (100 * t.slope * t.seconds) / Math.abs(t.mean)
  }
  let last = -1
  let by: Settling['by'] = null
  if (levers.length) {
    by = 'lever'
    const means = levers.map((ch) => summary(ch.values, a, b).mean)
    for (let i = a - 1; i >= lo && last < 0; i -= 1) {
      if (levers.some((ch, k) => Math.abs(ch.values[i] - means[k]) > 0.002)) last = i
    }
  } else if (forceChannels.length) {
    by = thrusts.length ? 'thrust' : powers.length ? 'power' : 'n1'
    const sum = sumChannels(forceChannels, lo, b)
    const smoothed = smoothInside(sum, time.subarray(lo, b), 0, b - lo, 1)
    const mean = summary(sum, a - lo, b - lo).mean
    for (let i = a - 1; i >= lo && last < 0; i -= 1) {
      if (Math.abs(smoothed[i - lo] - mean) > 0.01 * Math.abs(mean)) last = i
    }
  }
  if (!by) return { tSet: null, found: false, lookback, thrustTrend, by }
  if (last >= 0) return { tSet: time[a] - time[last], found: true, lookback, thrustTrend, by }
  return { tSet: lookback, found: false, lookback, thrustTrend, by }
}

export type PitchSource = 'autopilot' | 'pilot' | 'hands-off' | 'unknown'

export interface PitchControl {
  source: PitchSource
  /** R² of the surface (less augmentation) against the servo and against the stick (NaN without them) */
  r2Servo: number
  r2Stick: number
  /** The rows looked at: the point ± widenS (30 s unless given), cut at resets and gaps */
  rows: [number, number]
}

/**
 * Who flew pitch over rows [a, b) (judged on the rows ± `widenS` seconds, default 30, never across a reset or gap):
 * 'autopilot' when the stick is still (range ≤ 0.02), the servo moves (range ≥ 0.005) and the elevator surface (less
 * any augmentation) follows the servo (least-squares R² ≥ 0.9 at any gain, so a surface scaled below the servo command
 * still counts); 'pilot' when the stick moves and the surface follows it (R² ≥ 0.9); 'hands-off' when stick, servo and
 * surface are all still near 0; else 'unknown'. A servo holding a constant value (it can after a disconnect) never makes
 * 'autopilot'. The dynamic checklist passes `widenS` 0: it judges its own spans (the trim window, the response).
 */
export function pitchControlSource(
  ds: Dataset,
  a: number,
  b: number,
  axis: 'elev' | 'ailrn' | 'ruddr' = 'elev',
  widenS = 30,
): PitchControl | null {
  const prefix = axis === 'elev' ? '_elev' : axis
  const surf = findChannel(ds, `${prefix},_surf`)
  const stick = findChannel(ds, `${prefix},stick`)
  const servo = findChannel(ds, `${prefix},servo`)
  if (!surf || (!stick && !servo)) return null
  const astab = findChannel(ds, `${prefix},astab`)
  const [lo, hi] = widenS > 0 ? widen(ds, a, b, widenS) : [Math.max(0, a), Math.min(ds.rowCount, b)]
  if (widenS <= 0 && hi - lo < 3) return { source: 'unknown', r2Servo: NaN, r2Stick: NaN, rows: [lo, hi] }
  const y = new Float64Array(hi - lo)
  for (let i = lo; i < hi; i += 1) y[i - lo] = surf.values[i] - (astab ? astab.values[i] : 0)
  const slice = (ch: Channel | null) => (ch ? ch.values.subarray(lo, hi) : null)
  const st = slice(stick)
  const sv = slice(servo)
  const stickRange = st ? summary(st, 0, st.length).range : NaN
  const servoRange = sv ? summary(sv, 0, sv.length).range : NaN
  const surfSummary = summary(y, 0, y.length)
  const r2Servo = sv && servoRange >= 0.005 ? linearFit(sv, y).r2 : NaN
  const r2Stick = st && stickRange > 0.02 ? linearFit(st, y).r2 : NaN
  let source: PitchSource = 'unknown'
  if (!(stickRange > 0.02) && servoRange >= 0.005 && r2Servo >= 0.9) source = 'autopilot'
  else if (stickRange > 0.02 && r2Stick >= 0.9) source = 'pilot'
  else if (
    (!st || stickRange <= 0.005) &&
    (!sv || servoRange <= 0.005) &&
    surfSummary.range <= 0.005 &&
    Math.abs(surfSummary.mean) <= 0.005
  ) {
    source = 'hands-off'
  }
  return { source, r2Servo, r2Stick, rows: [lo, hi] }
}

export interface AutothrottleEvidence {
  /** 'logged': row 117's _auto,throt; 'levers': the inference from the lever trace; 'none' */
  basis: 'logged' | 'levers' | 'none'
  /** _auto,throt not 0 anywhere (logged) */
  codeOn: boolean
  /** Share of samples where any lever changed by more than 1e-5 */
  share: number
  leverRange: number
  /** Levers move together (|thro1 − thro2| ≤ 0.002 in ≥ 90 % of samples), or a single lever */
  together: boolean
  /** The A/T-like pattern: share ≥ 20 %, lever range ≤ 0.02, levers together, speed 2σ ≤ 1 kt */
  atLike: boolean
}

/** Whether an autothrottle was moving the levers over rows [a, b). */
export function autothrottleEvidence(ds: Dataset, a: number, b: number, speed: Channel | null): AutothrottleEvidence {
  const code = findChannel(ds, '_auto,throt')
  const levers = leverChannels(ds)
  let changes = 0
  let samples = 0
  for (let i = a + 1; i < b; i += 1) {
    samples += 1
    if (levers.some((ch) => Math.abs(ch.values[i] - ch.values[i - 1]) > 1e-5)) changes += 1
  }
  const share = samples ? changes / samples : NaN
  let leverRange = NaN
  for (const ch of levers) {
    const r = summary(ch.values, a, b).range
    if (Number.isFinite(r)) leverRange = Number.isFinite(leverRange) ? Math.max(leverRange, r) : r
  }
  let together = true
  if (levers.length >= 2) {
    let close = 0
    let n = 0
    for (let i = a; i < b; i += 1) {
      n += 1
      if (Math.abs(levers[0].values[i] - levers[1].values[i]) <= 0.002) close += 1
    }
    together = n > 0 && close / n >= 0.9
  }
  const speedScatter = speed ? 2 * trend(speed.values, ds.elapsed, a, b).residualSd : NaN
  const atLike = levers.length > 0 && share >= 0.2 && leverRange <= 0.02 && together && !(speedScatter > 1)
  const codeOn = code ? summary(code.values, a, b).max !== 0 || summary(code.values, a, b).min !== 0 : false
  return { basis: code ? 'logged' : levers.length ? 'levers' : 'none', codeOn, share, leverRange, together, atLike }
}

// ------------------------------------------------------------------ building results

/** Number to `digits` significant figures, typographic minus, no trailing exponent noise ("—" when missing). */
export function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const abs = Math.abs(value)
  const text = abs >= 10 ** digits ? String(Math.round(value)) : String(Number(value.toPrecision(digits)))
  return text.replace('-', '−')
}

/** Number with fixed decimals and a typographic minus. */
export function fix(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—'
  const text = value.toFixed(decimals)
  return (Number(text) === 0 ? text.replace('-', '') : text).replace('-', '−')
}

/** Signed number with "+" for positive values. */
export function signed(value: number, decimals = 1): string {
  const text = fix(value, decimals)
  return value > 0 && Number(value.toFixed(decimals)) !== 0 ? `+${text}` : text
}

/** A percentage of a ratio ("2.3 %"). */
export function pct(ratio: number, decimals = 1): string {
  return Number.isFinite(ratio) ? `${fix(100 * ratio, decimals)} %` : '—'
}

/**
 * The result of one check, from its definition. An advisory check never fails (types.ts: "a note; never fails, never
 * blocks the verdict"), so its worst status is a warning, whatever the check computed.
 */
export function result(
  def: CheckDef,
  kind: ChecklistKind,
  status: CheckStatus,
  measured: string,
  criterion: string,
  hint = '',
  extra: Partial<Pick<Check, 'pointId' | 'severity' | 'title'>> = {},
): Check {
  const severity = extra.severity ?? def.severity
  return {
    id: def.id,
    kind,
    title: extra.title ?? def.title,
    status: severity === 'advisory' && status === 'fail' ? 'warn' : status,
    severity,
    scope: def.scope,
    measured,
    criterion,
    hint,
    why: def.why,
    citations: formatCitations(def.cite),
    judgement: def.judgement,
    ...(def.sourced ? { sourced: def.sourced } : {}),
    ...(def.follows ? { follows: def.follows } : {}),
    interval: def.interval,
    ...(extra.pointId ? { pointId: extra.pointId } : {}),
  }
}

/** A "not checkable" result: the rows the check needs (from its definition, or `needs`). */
export function notCheckable(def: CheckDef, kind: ChecklistKind, extra: Partial<Pick<Check, 'pointId' | 'severity'>> & { needs?: string } = {}): Check {
  return result(def, kind, 'not-checkable', '', notCheckableText(extra.needs ?? def.needs), '', extra)
}

/**
 * A sample rate (or a count per period) reaches `limit`, with a 2 % allowance: a recording set to 10 per second arrives a
 * little under it (frame timing, float32 time stamps), and that is still 10 Hz.
 */
export function atLeast(value: number, limit: number): boolean {
  return value >= 0.98 * limit
}

/**
 * A test point's note that says who flew it or which automatic modes were on (autopilot, A/T, ALT HOLD, HDG, hand-flown,
 * flight director ...): it counts as that point's declaration. The notes the app writes itself ("Found steady: … VS
 * within ± 100 fpm …") do not.
 */
export function declaresModes(note: string | undefined): boolean {
  return !!note && /\b(auto-?pilot|a\/p|auto-?throttle|a\/t|alt(itude)?\s*hold|hdg|heading\s*hold|hand[- ]?flown|by\s*hand|manual(ly)?|flight\s*director|fd\s*(on|off))\b/i.test(note)
}

/** "flaps 0, speedbrake 0 (moved 0.0012), gear not logged": each surface's mean, and its range when it moved. */
export function configText(config: ConfigurationState, limit: number): string {
  const part = (name: string, mean: number, range: number) => `${name} ${fmt(mean, 2)}${range > limit ? ` (moved ${fmt(range, 2)})` : ''}`
  const surfaces = config.surfaces.map((s) => part(s.name, s.mean, s.range))
  return [...surfaces, config.gear ? part('gear', config.gear.mean, config.gear.range) : 'gear not logged'].join(', ')
}

/** pass / warn / fail from a value and two limits (value ≤ pass → pass, ≤ warn → warn, else fail; NaN → null). */
export function grade(value: number, passLimit: number, warnLimit: number): CheckStatus | null {
  if (!Number.isFinite(value)) return null
  return value <= passLimit ? 'pass' : value <= warnLimit ? 'warn' : 'fail'
}

/** The worse of two statuses among pass / warn / fail (null ignored). */
export function worse(...statuses: (CheckStatus | null)[]): CheckStatus {
  const rank: Record<string, number> = { pass: 0, info: 0, warn: 1, fail: 2 }
  let out: CheckStatus = 'pass'
  for (const s of statuses) if (s && (rank[s] ?? 0) > (rank[out] ?? 0)) out = s
  return out
}

/** Spec-style row list for a "Cannot confirm — tick rows …" verdict, from NA checks' criterion text. */
export function rowsFromNotCheckable(checks: readonly Check[]): string[] {
  const rows: string[] = []
  for (const c of checks) {
    if (c.status !== 'not-checkable') continue
    for (const m of c.criterion.matchAll(/(\d+\*?) \(([^()]*(?:\([^()]*\))?[^()]*)\)/g)) {
      const text = `${m[1]} (${m[2]})`
      if (!rows.includes(text)) rows.push(text)
    }
  }
  return rows
}
