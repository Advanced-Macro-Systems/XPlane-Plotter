// Synthetic X-Plane-style datasets for the checklist tests (test-only: imported by *.test.ts). Every value here is
// invented for the tests; nothing comes from a flight log. Columns are named by real X-Plane 12 header tokens so the
// checklists find them as they would in a Data.txt.

import { computeStats } from '../dataset'
import type { Channel, Dataset, Segment, TestPoint } from '../types'

export type Columns = Record<string, ArrayLike<number>>

/** A channel by token (occurrence 1), with plain metadata. */
export function column(token: string, values: ArrayLike<number>, derived?: string): Channel {
  const v = Float64Array.from(values as ArrayLike<number>)
  return {
    id: derived ? token : token,
    token: derived ? '' : token,
    occurrence: 1,
    column: derived ? -1 : 0,
    meta: { label: token, short: token, unit: '', quantity: 'other', group: derived ? 'derived' : 'other', known: !derived },
    values: v,
    stats: computeStats(v),
    ...(derived ? { derived: { expression: derived } } : {}),
  }
}

export interface LogOptions {
  /** The time column elapsed is built from (default sim time); null: none */
  timeToken?: string | null
  segments?: Segment[]
  /** Formula channels: id ("fx:...") -> [expression, values] */
  formulas?: Record<string, [string, ArrayLike<number>]>
}

/** A dataset from columns sampled at `elapsed` (seconds). */
export function makeLog(elapsed: ArrayLike<number>, columns: Columns, options: LogOptions = {}): Dataset {
  const n = elapsed.length
  const timeToken = options.timeToken === undefined ? '_totl,_time' : options.timeToken
  const channels: Channel[] = []
  if (timeToken) channels.push(column(timeToken, Float64Array.from(elapsed as ArrayLike<number>, (t) => t + 100)))
  for (const [token, values] of Object.entries(columns)) {
    if (values.length !== n) throw new Error(`column ${token} has ${values.length} values, expected ${n}`)
    channels.push(column(token, values))
  }
  for (const [id, [expression, values]] of Object.entries(options.formulas ?? {})) {
    const ch = column(id, values, expression)
    ch.meta = { ...ch.meta, label: id.replace(/^fx:/, ''), short: id.replace(/^fx:/, '') }
    channels.push(ch)
  }
  const steps: number[] = []
  for (let i = 1; i < n; i += 1) steps.push(elapsed[i] - elapsed[i - 1])
  steps.sort((a, b) => a - b)
  const median = steps.length ? steps[steps.length >> 1] : NaN
  return {
    id: 'ds-test',
    name: 'synthetic.txt',
    sizeBytes: 0,
    format: 'xplane',
    rowCount: n,
    channels,
    timeSourceId: timeToken,
    elapsed: Float64Array.from(elapsed as ArrayLike<number>),
    segments: options.segments ?? [{ start: 0, end: n, reason: 'start' }],
    sampleRateHz: median > 0 ? 1 / median : NaN,
    warnings: [],
    signature: 'synthetic',
    loadedAt: 0,
  }
}

/** n samples at `rate` Hz from t0. */
export function times(seconds: number, rate: number, t0 = 0): Float64Array {
  const n = Math.round(seconds * rate) + 1
  return Float64Array.from({ length: n }, (_, i) => t0 + i / rate)
}

/** A column from a function of time. */
export function fill(t: ArrayLike<number>, f: (time: number, i: number) => number): Float64Array {
  return Float64Array.from({ length: t.length }, (_, i) => f(t[i], i))
}

/** A test point from times (seconds) on a dataset. */
export function pointAt(ds: Dataset, id: string, start: number, end: number, extra: Partial<TestPoint> = {}): TestPoint {
  let a = 0
  while (a < ds.rowCount && ds.elapsed[a] < start) a += 1
  let b = a
  while (b < ds.rowCount && ds.elapsed[b] <= end) b += 1
  return { id, name: id, groupId: 'g1', start: a, end: b, ...extra }
}

/** Smooth step 0 -> 1 between t0 and t0 + dur. */
export function ramp(t: number, t0: number, dur: number): number {
  if (t <= t0) return 0
  if (t >= t0 + dur) return 1
  const x = (t - t0) / dur
  return x * x * (3 - 2 * x)
}

/** A rectangular pulse from t0 for `width` seconds with 0.1 s ramps. */
export function pulse(t: number, t0: number, width: number): number {
  return ramp(t, t0, 0.1) - ramp(t, t0 + width, 0.1)
}

/** A doublet: +1 for `half` seconds then −1 for `half` seconds, from t0. */
export function doublet(t: number, t0: number, half: number): number {
  return pulse(t, t0, half) - pulse(t, t0 + half, half)
}
