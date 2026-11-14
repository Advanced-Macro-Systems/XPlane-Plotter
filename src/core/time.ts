// Time handling: picking the time source, building gap-collapsed elapsed time and segments, the time-axis choices,
// row <-> time conversion, and time formatting.
// OWNER: parser agent. Public API below is a contract; keep these signatures.

import type { Channel, Dataset, RowRange, Segment, TimeAxis, TimeBaseId } from './types'

export interface ElapsedResult {
  /** Seconds from the first row; non-decreasing; each discontinuity advances by one median interval */
  elapsed: Float64Array
  segments: Segment[]
  /** Median positive step of the source (s); NaN when it cannot be determined */
  medianDt: number
}

/** A forward step larger than max(GAP_MIN_SECONDS, GAP_FACTOR × median step) is a recording gap. */
const GAP_MIN_SECONDS = 1
const GAP_FACTOR = 20

/** Median of the positive steps between adjacent finite values; NaN when there are none. */
export function medianPositiveStep(time: Float64Array): number {
  const steps = new Float64Array(Math.max(0, time.length - 1))
  let count = 0
  for (let i = 1; i < time.length; i += 1) {
    const step = time[i] - time[i - 1]
    if (step > 0 && step < Infinity) steps[count++] = step
  }
  if (count === 0) return NaN
  const sorted = steps.subarray(0, count).sort()
  const mid = count >> 1
  return count % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Builds elapsed time from a raw time column. A new segment starts where the step is negative or NaN-bridged backwards
 * ("reset") or larger than max(1 s, 20 × median step) ("gap"). Zero steps (paused frames) are kept as zero.
 * Mirrored line for line by xppElapsed in core/export/matlabLibrary.ts (the MATLAB export checks its rows against
 * it): change both together.
 */
export function buildElapsed(time: Float64Array): ElapsedResult {
  const n = time.length
  const elapsed = new Float64Array(n)
  if (n === 0) return { elapsed, segments: [], medianDt: NaN }
  const medianDt = medianPositiveStep(time)
  // Rows without a time value, and each discontinuity, advance elapsed time by one typical step.
  const step = Number.isFinite(medianDt) ? medianDt : 0
  const gapThreshold = Math.max(GAP_MIN_SECONDS, GAP_FACTOR * step)
  const segments: Segment[] = []
  let segmentStart = 0
  let segmentReason: Segment['reason'] = 'start'
  let lastRow = -1 // row of the previous finite time value
  let lastValue = NaN
  // Within a continuous run elapsed = baseElapsed + (t - baseValue): no rounding error accumulates over long files.
  let baseValue = NaN
  let baseElapsed = 0
  for (let i = 0; i < n; i += 1) {
    const value = time[i]
    const previous = i > 0 ? elapsed[i - 1] : 0
    if (!Number.isFinite(value)) {
      elapsed[i] = i > 0 ? previous + step : 0
      continue
    }
    if (lastRow < 0) {
      elapsed[i] = i > 0 ? previous + step : 0
    } else {
      const delta = value - lastValue
      // Bridged NaN rows already advanced elapsed by one step each; only the excess can be a gap.
      const bridged = (i - lastRow - 1) * step
      if (delta < 0 || delta - bridged > gapThreshold) {
        segments.push({ start: segmentStart, end: i, reason: segmentReason })
        segmentStart = i
        segmentReason = delta < 0 ? 'reset' : 'gap'
        elapsed[i] = previous + step
      } else {
        elapsed[i] = Math.max(previous, baseElapsed + (value - baseValue))
        lastRow = i
        lastValue = value
        continue
      }
    }
    baseValue = value
    baseElapsed = elapsed[i]
    lastRow = i
    lastValue = value
  }
  segments.push({ start: segmentStart, end: n, reason: segmentReason })
  return { elapsed, segments, medianDt }
}

// ------------------------------------------------------------------ which columns are time

interface TimeKind {
  label: string
  unit: 's' | 'h'
  /** Hour-of-day clock (formatted hh:mm:ss) */
  clock: boolean
}

/** X-Plane 12 "Times" row. _zulu / local / hobbs are decimal HOURS; the others are seconds. */
const XPLANE_TIMES = new Map<string, TimeKind>([
  ['_real,_time', { label: 'Real time', unit: 's', clock: false }],
  ['_totl,_time', { label: 'Sim time (total)', unit: 's', clock: false }],
  ['missn,_time', { label: 'Mission time', unit: 's', clock: false }],
  ['timer,_time', { label: 'Timer', unit: 's', clock: false }],
  ['_zulu,_time', { label: 'Zulu clock', unit: 'h', clock: true }],
  ['local,_time', { label: 'Local clock', unit: 'h', clock: true }],
  ['hobbs,_time', { label: 'Hobbs meter', unit: 'h', clock: false }],
])

/** Elapsed-time source preference: sim time first (the physics integrates in sim time), then real time. */
const PREFERRED_SOURCES = ['_totl,_time', 'missn,_time', '_real,_time', 'timer,_time']

/**
 * CSV column names that hold seconds: "time", "t", "Time (s)", "time_s", "Elapsed time [s]", "sim time", "seconds"...
 * Not "timestamp" (often epoch or milliseconds) and not other units ("time (ms)", "time of day").
 */
const SECONDS_COLUMN =
  /^(?:(?:sim(?:ulation)?|elapsed|flight|mission|total|real|run)[\s_-]*)?(?:time|t|elapsed|seconds|secs?)(?:[\s_-]*[([]?\s*(?:s|sec|secs|seconds)\s*[)\]]?)?$/i

function isSecondsColumn(token: string): boolean {
  return SECONDS_COLUMN.test(token.trim())
}

function timeKind(ch: Channel): TimeKind | null {
  if (ch.derived || ch.column < 0) return null
  const known = XPLANE_TIMES.get(ch.token)
  if (known) return ch.occurrence > 1 ? { ...known, label: `${known.label} (${ch.occurrence})` } : known
  if (isSecondsColumn(ch.token)) return { label: ch.meta.label || ch.token, unit: 's', clock: false }
  return null
}

function usableSource(ch: Channel): boolean {
  return !ch.derived && ch.column >= 0 && ch.stats.finite >= 2 && !ch.stats.constant
}

/**
 * Chooses the channel to build elapsed time from. Preference: sim time ("_totl,_time", then "missn,_time"), then
 * real time ("_real,_time"), then any other seconds-based time column (CSV: "time", "t", "Time (s)", ...).
 * Hour-of-day clocks (zulu/local/hobbs) are never chosen. Returns null when nothing suitable exists.
 */
export function pickTimeSource(channels: Channel[]): Channel | null {
  for (const token of PREFERRED_SOURCES) {
    const ch = channels.find((c) => c.token === token && usableSource(c))
    if (ch) return ch
  }
  return channels.find((c) => isSecondsColumn(c.token) && usableSource(c)) ?? null
}

// ------------------------------------------------------------------ time bases

export interface TimeBaseOption {
  id: TimeBaseId
  label: string
  /** false when the channel is not monotonic (it resets) — shown disabled with `reason` */
  available: boolean
  reason?: string
}

/** Why a channel cannot be a time axis, or null when it is non-decreasing over its finite values and changes. */
function axisProblem(values: Float64Array): string | null {
  let finite = 0
  let previous = NaN
  let resets = 0
  let firstReset = -1
  let changes = false
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (Number.isNaN(value)) continue
    if (finite > 0) {
      if (value < previous) {
        resets += 1
        if (firstReset < 0) firstReset = i
      }
      if (value !== previous) changes = true
    }
    previous = value
    finite += 1
  }
  if (finite < 2) return 'has no values'
  if (resets === 1) return `resets at row ${firstReset}`
  if (resets > 1) return `resets ${resets} times (first at row ${firstReset})`
  if (!changes) return 'does not change'
  return null
}

const baseCache = new WeakMap<Dataset, TimeBaseOption[]>()

/** The time-axis choices for the toolbar: Elapsed, every time-like channel (sim/real/mission/zulu/local...), Row. */
export function timeBases(ds: Dataset): TimeBaseOption[] {
  const cached = baseCache.get(ds)
  if (cached) return cached
  const options: TimeBaseOption[] = [{ id: 'elapsed', label: 'Elapsed time', available: true }]
  for (const ch of ds.channels) {
    const kind = timeKind(ch)
    if (!kind) continue
    const problem = axisProblem(ch.values)
    options.push(
      problem === null
        ? { id: `ch:${ch.id}`, label: kind.label, available: true }
        : { id: `ch:${ch.id}`, label: kind.label, available: false, reason: problem },
    )
  }
  options.push({ id: 'index', label: 'Row number', available: true })
  baseCache.set(ds, options)
  return options
}

/** NaN cells of a non-decreasing channel filled by linear interpolation (ends: nearest value), so binary search works. */
function fillMissing(values: Float64Array): Float64Array {
  if (!values.some((v) => Number.isNaN(v))) return values
  const out = new Float64Array(values)
  let last = -1
  for (let i = 0; i < out.length; i += 1) {
    if (Number.isNaN(out[i])) continue
    if (last < 0) out.fill(out[i], 0, i)
    else if (i - last > 1) {
      const from = out[last]
      const slope = (out[i] - from) / (i - last)
      for (let k = last + 1; k < i; k += 1) out[k] = from + slope * (k - last)
    }
    last = i
  }
  if (last < 0) out.fill(0)
  else out.fill(out[last], last + 1)
  return out
}

function rowNumbers(n: number): Float64Array {
  const values = new Float64Array(n)
  for (let i = 0; i < n; i += 1) values[i] = i
  return values
}

const axisCache = new WeakMap<Dataset, Map<TimeBaseId, TimeAxis>>()

/** The axis for a time base; falls back to elapsed when `id` is unavailable for this dataset. Cached per dataset+id. */
export function timeAxis(ds: Dataset, id: TimeBaseId): TimeAxis {
  let cache = axisCache.get(ds)
  if (!cache) {
    cache = new Map()
    axisCache.set(ds, cache)
  }
  const hit = cache.get(id)
  if (hit) return hit
  let axis: TimeAxis | null = null
  if (id === 'index') {
    axis = { id, label: 'Row number', unit: '', values: rowNumbers(ds.rowCount) }
  } else if (id.startsWith('ch:')) {
    const option = timeBases(ds).find((o) => o.id === id)
    const ch = ds.channels.find((c) => c.id === id.slice(3))
    const kind = ch ? timeKind(ch) : null
    if (option?.available && ch && kind) {
      axis = { id, label: kind.label, unit: kind.unit, values: fillMissing(ch.values) }
      if (kind.clock) axis.clock = true
    }
  }
  if (!axis) {
    axis = id === 'elapsed' ? { id, label: 'Elapsed time', unit: 's', values: ds.elapsed } : timeAxis(ds, 'elapsed')
  }
  cache.set(id, axis)
  return axis
}

// ------------------------------------------------------------------ rows <-> axis values

/** Index of the last row whose axis value is <= value (binary search; clamped to [0, n-1]). */
export function rowAtValue(axis: Float64Array, value: number): number {
  const n = axis.length
  if (n === 0 || Number.isNaN(value)) return 0
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (axis[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return Math.min(n - 1, Math.max(0, lo - 1))
}

/** Index of the first row whose axis value is >= value (n when there is none). */
function firstRowAtOrAbove(axis: Float64Array, value: number): number {
  let lo = 0
  let hi = axis.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (axis[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Rows covering axis values [lo, hi] (order-insensitive), as a half-open range with at least one row. */
export function rangeToRows(axis: Float64Array, lo: number, hi: number): RowRange {
  const n = axis.length
  if (n === 0) return [0, 0]
  // A NaN bound means "open" on that side.
  const swap = lo > hi
  const low = swap ? hi : lo
  const high = swap ? lo : hi
  const start = Number.isNaN(low) ? 0 : Math.min(n - 1, firstRowAtOrAbove(axis, low))
  const end = Number.isNaN(high) ? n : rowAtValue(axis, high) + 1
  if (end > start) return [start, end]
  // No sample inside [lo, hi] (it falls between two rows): the row just before it.
  const row = Number.isNaN(low) ? 0 : rowAtValue(axis, low)
  return [row, row + 1]
}

// ------------------------------------------------------------------ formatting

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** "0.85 s", "12.3 s", "4 min 05 s", "1 h 02 min" */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 0) return `-${formatDuration(-seconds)}`
  // Thresholds sit where rounding would otherwise print "10.00 s" or "60.0 s".
  if (seconds < 9.995) return `${seconds.toFixed(2)} s`
  if (seconds < 59.95) return `${seconds.toFixed(1)} s`
  const totalSeconds = Math.round(seconds)
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)} min ${pad2(totalSeconds % 60)} s`
  const totalMinutes = Math.round(seconds / 60)
  return `${Math.floor(totalMinutes / 60)} h ${pad2(totalMinutes % 60)} min`
}

/** Hour-of-day (decimal hours, may exceed 24) as "hh:mm:ss" */
export function formatClock(hours: number): string {
  if (!Number.isFinite(hours)) return '—'
  const day = 24 * 3600
  const total = ((Math.round(hours * 3600) % day) + day) % day
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`
}

/** A time value as shown on this axis: "123.4 s", "09:15:15", "row 1234" */
export function formatAxisValue(axis: TimeAxis, value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (axis.clock) return formatClock(value)
  if (axis.id === 'index') return `row ${Math.round(value)}`
  if (axis.unit === 's') return `${value.toFixed(Math.abs(value) < 10 ? 2 : 1)} s`
  if (axis.unit === 'h') return `${value.toFixed(3)} h`
  const text = String(Number(value.toFixed(3)))
  return axis.unit ? `${text} ${axis.unit}` : text
}
