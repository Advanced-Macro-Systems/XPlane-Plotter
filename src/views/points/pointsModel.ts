// The test-point table: for each point its rows, time range and duration, and for each tracked channel mean ± σ with
// a steadiness check (is the trend across the window bigger than the scatter within it?). Also sorting, the name a new
// point is offered, and the mean ± σ display format (shared with the X–Y means table). Pure: no React, no DOM.

import { MISSING, formatFixed, formatNumber } from '../../charts/format'
import { rangeStats, type RangeStats } from '../../core/analysis/stats'
import { windowStats } from '../../core/analysis/windowStats'
import { channelById } from '../../core/dataset'
import { formatAxisValue } from '../../core/time'
import type { Channel, Dataset, PointGroup, RowRange, TestPoint, TimeAxis, Workspace } from '../../core/types'

// ------------------------------------------------------------------ mean ± σ

export interface MeanSdText {
  mean: string
  /** σ, '' when unknown */
  sd: string
}

/**
 * Mean and standard deviation printed to the same decimal place: σ to 2 significant figures and the mean to match
 * ("250.31 ± 0.42", "0.4123 ± 0.0021", "12003 ± 12"). Real minus signs. σ = 0 prints the mean to 4 significant figures.
 */
export function formatMeanSd(mean: number, sd: number): MeanSdText {
  if (!Number.isFinite(mean)) return { mean: MISSING, sd: '' }
  if (!Number.isFinite(sd)) return { mean: formatNumber(mean), sd: '' }
  if (sd <= 0) return { mean: formatNumber(mean), sd: '0' }
  const decimals = 1 - Math.floor(Math.log10(sd))
  if (decimals > 6) return { mean: formatNumber(mean, 6), sd: formatNumber(sd, 2) }
  const places = Math.max(0, decimals)
  return { mean: formatFixed(mean, places), sd: formatFixed(sd, places) }
}

// ------------------------------------------------------------------ steadiness

/**
 * Physical floors (per window) below which a trend is not worth flagging, for common units. Without one, the floor is
 * a small share of the channel's spread over the whole file (fileSpread).
 */
const UNIT_FLOOR: Readonly<Record<string, number>> = {
  kt: 0.5,
  mph: 0.5,
  ft: 10,
  m: 3,
  fpm: 25,
  'm/s': 0.15,
  deg: 0.05,
  'deg/s': 0.1,
  '%': 0.5,
  rpm: 10,
}
const RELATIVE_FLOOR = 0.02

/** The unit's floor; 0 for units without one (an own key only: a unit named "constructor" is just a unit). */
function unitFloor(unit: string): number {
  return Object.hasOwn(UNIT_FLOOR, unit) ? UNIT_FLOOR[unit] : 0
}

/** At most this many samples are sorted to estimate a channel's spread. */
const SPREAD_SAMPLES = 16_384
const spreadCache = new WeakMap<ArrayLike<number>, number>()

/** Linear-interpolated quantile of sorted values. */
function quantileSorted(sorted: Float64Array, p: number): number {
  const at = p * (sorted.length - 1)
  const lo = Math.floor(at)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/**
 * How much a channel varies over the whole file, robustly: the interquartile range / 1.349 (σ for normally
 * distributed data) of its finite values, so a few absurd samples (CL of order 10^8 on the ground at zero airspeed) do
 * not inflate it the way they inflate σ. Falls back to σ when the middle half is constant. Long channels are sampled;
 * the result is cached per values array.
 */
export function fileSpread(ch: { values?: ArrayLike<number>; stats: { std: number } }): number {
  const std = Number.isFinite(ch.stats.std) ? ch.stats.std : 0
  const values = ch.values
  if (!values || values.length === 0) return std
  const cached = spreadCache.get(values)
  if (cached !== undefined) return cached
  const stride = Math.max(1, Math.ceil(values.length / SPREAD_SAMPLES))
  const picked: number[] = []
  for (let i = 0; i < values.length; i += stride) if (Number.isFinite(values[i])) picked.push(values[i])
  let spread = std
  if (picked.length >= 4) {
    const sorted = Float64Array.from(picked).sort()
    const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25)
    if (iqr > 0 && Number.isFinite(iqr)) spread = iqr / 1.349
  }
  spreadCache.set(values, spread)
  return spread
}

export interface Steadiness {
  /** Least-squares slope per minute */
  drift: number
  /** |drift| × duration: how much the trend moves the value across the window */
  change: number
  /** max(2σ, floor) */
  limit: number
  flagged: boolean
}

/**
 * A channel drifts in a window when the trend moves it further across the window than its own scatter does:
 * |drift| × duration(min) > max(2σ, floor).
 */
export function steadiness(
  stats: RangeStats,
  drift: number,
  seconds: number,
  ch: { meta: { unit: string }; stats: { std: number }; values?: ArrayLike<number> },
): Steadiness {
  const change = Math.abs(drift) * (seconds / 60)
  const sigma = Number.isFinite(stats.std) ? stats.std : 0
  const floor = Math.max(unitFloor(ch.meta.unit), RELATIVE_FLOOR * fileSpread(ch), 1e-9 * Math.abs(stats.mean), 1e-12)
  const limit = Math.max(2 * sigma, floor)
  return { drift, change, limit, flagged: stats.n >= 3 && Number.isFinite(change) && change > limit }
}

/** "drifting −3.2 kt/min" (sign always shown). */
export function driftText(drift: number, unit: string): string {
  if (!Number.isFinite(drift)) return ''
  const value = formatNumber(drift, 2)
  const signed = drift > 0 ? `+${value}` : value
  return `drifting ${signed} ${unit ? `${unit}/min` : 'per min'}`
}

// ------------------------------------------------------------------ directions (0–360°)

// Heading-aware window statistics live in core (the test-point CSV uses them too); re-exported for the views.
export { isDirectionChannel, unwrapDegrees, windowStats } from '../../core/analysis/windowStats'

/** Time channels always "drift": they are left out of the steadiness check. */
function timeLike(ch: Channel, ds: Dataset): boolean {
  return ch.id === ds.timeSourceId || ch.meta.quantity === 'time' || /,_time$/.test(ch.token)
}

// ------------------------------------------------------------------ rows

export interface PointCell {
  channel: Channel
  stats: RangeStats
  /** null when not judged (time channels, fewer than 3 samples) */
  steady: Steadiness | null
  /** "drifting −3.2 kt/min" when flagged, else '' */
  hint: string
}

export interface PointRow {
  point: TestPoint
  /** Position in the workspace (creation order) */
  order: number
  group: PointGroup
  /** Rows [start, end) clamped to the file */
  start: number
  end: number
  rows: number
  /** Duration from elapsed time (s) */
  seconds: number
  /** Start and end on the current time axis, formatted */
  from: string
  to: string
  cells: PointCell[]
  /** The flagged cells */
  drifting: PointCell[]
}

/** One row per test point, in workspace order. */
export function buildPointRows(
  ds: Dataset,
  ws: Pick<Workspace, 'points' | 'groups'>,
  axis: TimeAxis,
  tracked: readonly Channel[],
): PointRow[] {
  const groups = new Map(ws.groups.map((g) => [g.id, g]))
  const fallback = ws.groups[0] ?? { id: '', name: '—', slot: 0 }
  return ws.points.map((point, order) => {
    const start = Math.max(0, Math.min(ds.rowCount, Math.floor(point.start)))
    const end = Math.max(start, Math.min(ds.rowCount, Math.ceil(point.end)))
    const last = Math.max(start, end - 1)
    const seconds = end > start ? ds.elapsed[last] - ds.elapsed[start] : 0
    const cells = tracked.map((channel): PointCell => {
      const { stats, drift } = windowStats(channel, ds.elapsed, start, end)
      if (stats.n < 3 || timeLike(channel, ds)) return { channel, stats, steady: null, hint: '' }
      const steady = steadiness(stats, drift, seconds, channel)
      return { channel, stats, steady, hint: steady.flagged ? driftText(steady.drift, channel.meta.unit) : '' }
    })
    return {
      point,
      order,
      group: groups.get(point.groupId) ?? fallback,
      start,
      end,
      rows: end - start,
      seconds,
      from: end > start ? formatAxisValue(axis, axis.values[start]) : MISSING,
      to: end > start ? formatAxisValue(axis, axis.values[last]) : MISSING,
      cells,
      drifting: cells.filter((c) => c.steady?.flagged),
    }
  })
}

export type PointSortKey = 'time' | 'name' | 'group'
export type SortDirection = 'asc' | 'desc'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Sorted copy: by time (start row), name (natural order: "Trim 90" before "Trim 210") or group (workspace order). */
export function sortPointRows(
  rows: readonly PointRow[],
  key: PointSortKey,
  direction: SortDirection,
  groups: readonly PointGroup[],
): PointRow[] {
  const groupOrder = new Map(groups.map((g, i) => [g.id, i]))
  const byTime = (a: PointRow, b: PointRow) => a.start - b.start || a.end - b.end || a.order - b.order
  const compare = (a: PointRow, b: PointRow): number => {
    if (key === 'name') return collator.compare(a.point.name, b.point.name) || byTime(a, b)
    if (key === 'group') return (groupOrder.get(a.group.id) ?? 0) - (groupOrder.get(b.group.id) ?? 0) || byTime(a, b)
    return byTime(a, b)
  }
  const sorted = [...rows].sort(compare)
  return direction === 'desc' ? sorted.reverse() : sorted
}

/** Most tracked (mean ± σ) columns: what a saved workspace keeps (store/defaults.ts sanitizeWorkspace). */
export const MAX_TRACKED = 24

/** Names of the 8 categorical colour slots, in slot order (styles/global.css --series-1..8). */
export const SLOT_NAMES = ['Blue', 'Orange', 'Aqua', 'Yellow', 'Magenta', 'Green', 'Violet', 'Red'] as const

/** The row badge's tooltip: every drifting channel and its drift ("KIAS drifting −3.2 kt/min; ..."). */
export function driftSummary(row: Pick<PointRow, 'drifting'>): string {
  return row.drifting.map((c) => `${c.channel.meta.short} ${c.hint}`).join('; ')
}

export interface PointCounts {
  total: number
  /** Judged steady on every tracked channel it could be judged on */
  steady: number
  drifting: number
  hidden: number
  /** Not judged at all (no tracked channel with 3+ samples) */
  unjudged: number
}

/** Counts for the heading: "7 steady · 2 drifting · 1 hidden". */
export function pointCounts(rows: readonly PointRow[]): PointCounts {
  const counts: PointCounts = { total: rows.length, steady: 0, drifting: 0, hidden: 0, unjudged: 0 }
  for (const r of rows) {
    if (r.point.hidden) counts.hidden += 1
    if (r.drifting.length) counts.drifting += 1
    else if (r.cells.some((c) => c.steady)) counts.steady += 1
    else counts.unjudged += 1
  }
  return counts
}

/**
 * The workspace with a deleted point put back (Undo): same id, same place in the list, its group if that still
 * exists (else the first group). Unchanged when a point with that id is already there.
 */
export function reinsertPoint<W extends Pick<Workspace, 'points' | 'groups'>>(ws: W, point: TestPoint, index: number): W {
  if (ws.points.some((p) => p.id === point.id) || ws.groups.length === 0) return ws
  const groupId = ws.groups.some((g) => g.id === point.groupId) ? point.groupId : ws.groups[0].id
  const points = [...ws.points]
  points.splice(Math.max(0, Math.min(points.length, index)), 0, { ...point, groupId })
  return { ...ws, points }
}

// ------------------------------------------------------------------ new points

const KIAS = '_Vind,_kias'

/**
 * A name for a new test point: its mean indicated airspeed ("250 KIAS") when the file has it, else "Point N"; made
 * unique among `taken` with " (2)", " (3)"...
 */
export function suggestPointName(ds: Dataset, range: RowRange, taken: readonly string[]): string {
  let base = ''
  const kias = channelById(ds, KIAS)
  if (kias) {
    const stats = rangeStats(kias.values, range[0], range[1])
    if (stats.n > 0 && Number.isFinite(stats.mean)) base = `${Math.round(stats.mean)} KIAS`
  }
  if (!base) base = `Point ${taken.length + 1}`
  const names = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let k = 2; ; k += 1) {
    const candidate = `${base} (${k})`
    if (!names.has(candidate.toLowerCase())) return candidate
  }
}

/** The zoom range that frames a point with 10% margin each side (Time history's "Zoom to"). */
export function framedRange(start: number, end: number): RowRange {
  const margin = Math.max(1, Math.round((end - start) * 0.1))
  return [start - margin, end + margin]
}
