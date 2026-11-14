// Pure maths for the Time history view: the chart's x frame (clock axes are drawn in milliseconds on an ECharts time
// axis), zoom windows <-> rows, wheel zoom, nearest rows, segment breaks, time formatting, the selection summary and
// the steadiness stats. No DOM, no React: unit-tested in timeMath.test.ts.

import { channelTitle } from '../../core/channels'
import { formatClock, formatDuration, rangeToRows, rowAtValue } from '../../core/time'
import type { Channel, Dataset, RowRange, Segment, TimeAxis } from '../../core/types'
import { MINUS, MISSING, formatNumber, tooltipHeader, tooltipRow } from '../../charts/format'
import { formatTimeRange } from '../../components/timeText'
import { windowStats } from '../points/pointsModel'

/** Clock axes (hour-of-day values) are drawn on an ECharts time axis, in milliseconds (UTC). */
export const MS_PER_HOUR = 3_600_000

/** How the chart's x relates to the time axis: chart x = axis value × factor. */
export interface XFrame {
  factor: number
  /** Chart x of the first and last row */
  min: number
  max: number
  /** Hour-of-day clock drawn on a time axis */
  clock: boolean
  /** Median sample step in axis units (NaN when unknown) */
  step: number
  /** Narrowest zoom window, chart units: a few samples */
  minSpan: number
}

/** A visible x window [lo, hi] in chart units. */
export type XWindow = readonly [lo: number, hi: number]

/** Median positive step of a non-decreasing array (sampled for long arrays); NaN when there is none. */
export function medianStep(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 2) return NaN
  const stride = Math.max(1, Math.floor((n - 1) / 4096))
  const steps: number[] = []
  for (let i = stride; i < n; i += stride) {
    const step = values[i] - values[i - stride]
    if (step > 0 && Number.isFinite(step)) steps.push(step / stride)
  }
  // Paused frames (zero steps) are rare; when striding over them the average still describes the sample rate.
  if (!steps.length) return NaN
  steps.sort((a, b) => a - b)
  return steps[steps.length >> 1]
}

export function xFrame(axis: TimeAxis): XFrame {
  const values = axis.values
  const n = values.length
  const factor = axis.clock ? MS_PER_HOUR : 1
  const min = n > 0 && Number.isFinite(values[0]) ? values[0] * factor : 0
  let max = n > 0 && Number.isFinite(values[n - 1]) ? values[n - 1] * factor : min + factor
  if (!(max > min)) max = min + factor
  const step = medianStep(values)
  const span = max - min
  const minSpan = Number.isFinite(step) && step > 0 ? Math.min(span, 4 * step * factor) : span / 1000
  return { factor, min, max, clock: axis.clock === true, step, minSpan }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  return null
}

/** [lo, hi] ordered and clamped to the frame, at least minSpan wide (shifted inside the frame when needed). */
export function normalizeWindow(window: readonly [number, number], frame: XFrame): XWindow {
  let lo = Math.min(window[0], window[1])
  let hi = Math.max(window[0], window[1])
  lo = clamp(lo, frame.min, frame.max)
  hi = clamp(hi, frame.min, frame.max)
  const minSpan = Math.min(frame.minSpan, frame.max - frame.min)
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2
    lo = clamp(mid - minSpan / 2, frame.min, frame.max - minSpan)
    hi = lo + minSpan
  }
  return [lo, hi]
}

/**
 * The visible window after an ECharts 'datazoom' event. Inside zoom sends { batch: [{ start, end }] } (percent of the
 * axis extent), the slider { start, end }, a programmatic zoom { startValue, endValue }. Missing ends keep `current`.
 */
export function windowFromZoomEvent(params: unknown, frame: XFrame, current: XWindow): XWindow | null {
  if (!isRecord(params)) return null
  const batch = Array.isArray(params.batch) && params.batch.length > 0 ? params.batch[0] : params
  if (!isRecord(batch)) return null
  const span = frame.max - frame.min
  let lo = finiteNumber(batch.startValue)
  let hi = finiteNumber(batch.endValue)
  const startPercent = finiteNumber(batch.start)
  const endPercent = finiteNumber(batch.end)
  if (lo === null && startPercent !== null) lo = frame.min + (span * startPercent) / 100
  if (hi === null && endPercent !== null) hi = frame.min + (span * endPercent) / 100
  if (lo === null && hi === null) return null
  return normalizeWindow([lo ?? current[0], hi ?? current[1]], frame)
}

/** True when the window shows (practically) the whole axis. */
export function isWholeWindow(window: XWindow, frame: XFrame): boolean {
  const tolerance = (frame.max - frame.min) * 1e-9
  return window[0] <= frame.min + tolerance && window[1] >= frame.max - tolerance
}

/** The rows a window shows: [first row at or after lo, last row at or before hi] as a half-open range. */
export function windowToRows(axis: TimeAxis, frame: XFrame, window: XWindow): RowRange {
  return rangeToRows(axis.values, window[0] / frame.factor, window[1] / frame.factor)
}

/** The window for a row range (null = the whole axis), at least minSpan wide. */
export function rowsToWindow(axis: TimeAxis, frame: XFrame, rows: RowRange | null): XWindow {
  const n = axis.values.length
  if (!rows || n === 0) return [frame.min, frame.max]
  const start = clamp(Math.floor(rows[0]), 0, n - 1)
  const last = clamp(Math.ceil(rows[1]) - 1, start, n - 1)
  return normalizeWindow([axis.values[start] * frame.factor, axis.values[last] * frame.factor], frame)
}

/** Zoom by `scale` (> 1 zooms out) about the point at `fraction` (0 = left edge, 1 = right edge) of the window. */
export function zoomAbout(window: XWindow, frame: XFrame, fraction: number, scale: number): XWindow {
  const full = frame.max - frame.min
  const span = window[1] - window[0]
  const f = clamp(fraction, 0, 1)
  const nextSpan = clamp(span * scale, Math.min(frame.minSpan, full), full)
  const anchor = window[0] + f * span
  const lo = clamp(anchor - f * nextSpan, frame.min, frame.max - nextSpan)
  return [lo, lo + nextSpan]
}

/** Zoom factor for a wheel event: one notch (≈100 px) zooms by about 16 %. Down/away from you zooms out. */
export function wheelScale(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY
  return clamp(Math.exp(pixels * 0.0015), 0.5, 2)
}

/** The chart x of a pointer at `fraction` across the plot area. */
export function windowValueAt(window: XWindow, fraction: number): number {
  return window[0] + clamp(fraction, 0, 1) * (window[1] - window[0])
}

/** Row whose axis value is nearest to `value` (values non-decreasing). */
export function nearestRow(values: Float64Array, value: number): number {
  const n = values.length
  if (n === 0) return 0
  const row = rowAtValue(values, value)
  if (row + 1 < n && Math.abs(values[row + 1] - value) < Math.abs(value - values[row])) return row + 1
  return row
}

// ------------------------------------------------------------------ segments

/** Rows where a new segment starts (a sim reset or recording gap), excluding row 0. */
export function segmentBreaks(segments: readonly Segment[]): number[] {
  return segments.slice(1).map((s) => s.start).filter((row) => row > 0)
}

export interface BoundaryMark {
  /** Chart x, halfway between the last row of one segment and the first of the next */
  x: number
  row: number
  reason: 'reset' | 'gap'
}

export function boundaryMarks(segments: readonly Segment[], axis: TimeAxis, frame: XFrame): BoundaryMark[] {
  const values = axis.values
  return segments.slice(1).flatMap((segment) => {
    const row = segment.start
    if (row <= 0 || row >= values.length) return []
    const reason: 'reset' | 'gap' = segment.reason === 'reset' ? 'reset' : 'gap'
    return [{ x: ((values[row - 1] + values[row]) / 2) * frame.factor, row, reason }]
  })
}

// ------------------------------------------------------------------ series data (cached)

/**
 * Interleaved [x0, y0, x1, y1, ...] for rows [start, end) with x scaled by `factor`; a (midpoint, NaN) pair is inserted
 * before each break row inside the range, so lines stop at sim resets and recording gaps.
 */
export function interleaveSeries(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  breaks: readonly number[],
  start: number,
  end: number,
  factor = 1,
): Float64Array {
  const lo = Math.max(0, Math.min(x.length, y.length, Math.floor(start)))
  const hi = Math.max(lo, Math.min(x.length, y.length, Math.ceil(end)))
  const inner = breaks.filter((row) => row > lo && row < hi).sort((a, b) => a - b)
  const out = new Float64Array((hi - lo + inner.length) * 2)
  let k = 0
  let next = 0
  for (let i = lo; i < hi; i += 1) {
    if (next < inner.length && inner[next] === i) {
      out[k++] = ((x[i - 1] + x[i]) / 2) * factor
      out[k++] = NaN
      next += 1
    }
    out[k++] = x[i] * factor
    out[k++] = y[i]
  }
  return out
}

interface SeriesCacheEntry {
  factor: number
  breaks: readonly number[]
  byValues: WeakMap<Float64Array, Float64Array>
}

const seriesCache = new WeakMap<Float64Array, SeriesCacheEntry>()

/** Whole-file series data for one channel on one axis, memoised per (axis values, channel values, breaks). */
export function cachedSeriesData(
  axisValues: Float64Array,
  factor: number,
  breaks: readonly number[],
  values: Float64Array,
): Float64Array {
  let entry = seriesCache.get(axisValues)
  if (!entry || entry.factor !== factor || !sameNumbers(entry.breaks, breaks)) {
    entry = { factor, breaks: [...breaks], byValues: new WeakMap() }
    seriesCache.set(axisValues, entry)
  }
  let data = entry.byValues.get(values)
  if (!data) {
    data = interleaveSeries(axisValues, values, breaks, 0, axisValues.length, factor)
    entry.byValues.set(values, data)
  }
  return data
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// ------------------------------------------------------------------ level of detail (what the charts are handed)

/**
 * Coarser copies of an interleaved series for drawing. Each level halves the one below: every bucket of up to 4 points
 * keeps its lowest and highest point, in time order, so peaks and spikes survive; (x, NaN) pairs (breaks, missing
 * values) pass through and are never merged across. Level 0 is `base` itself; levels stop once one holds at most
 * `floor` points. O(n) in all.
 */
export function minMaxLevels(base: Float64Array, floor = 1024): Float64Array[] {
  const levels = [base]
  let current = base
  while (current.length / 2 > floor) {
    const next = halveMinMax(current)
    if (next.length >= current.length) break
    levels.push(next)
    current = next
  }
  return levels
}

function halveMinMax(src: Float64Array): Float64Array {
  const n = src.length / 2
  const out = new Float64Array(src.length)
  let k = 0
  let i = 0
  while (i < n) {
    if (Number.isNaN(src[2 * i + 1])) {
      out[k++] = src[2 * i]
      out[k++] = NaN
      i += 1
      continue
    }
    let end = i + 1
    while (end < n && end < i + 4 && !Number.isNaN(src[2 * end + 1])) end += 1
    let lo = i
    let hi = i
    for (let j = i + 1; j < end; j += 1) {
      if (src[2 * j + 1] < src[2 * lo + 1]) lo = j
      if (src[2 * j + 1] > src[2 * hi + 1]) hi = j
    }
    const a = Math.min(lo, hi)
    const b = Math.max(lo, hi)
    out[k++] = src[2 * a]
    out[k++] = src[2 * a + 1]
    if (b !== a) {
      out[k++] = src[2 * b]
      out[k++] = src[2 * b + 1]
    }
    i = end
  }
  return out.slice(0, k)
}

const levelCache = new WeakMap<Float64Array, Float64Array[]>()

/** minMaxLevels of the whole-file series (cachedSeriesData), memoised per series. */
export function cachedSeriesLevels(
  axisValues: Float64Array,
  factor: number,
  breaks: readonly number[],
  values: Float64Array,
): Float64Array[] {
  const base = cachedSeriesData(axisValues, factor, breaks, values)
  let levels = levelCache.get(base)
  if (!levels) {
    levels = minMaxLevels(base)
    levelCache.set(base, levels)
  }
  return levels
}

/**
 * The coarsest level that still gives `perPixel` points per device pixel across the visible window (`fraction` of the
 * whole axis, drawn `plotWidthPx` wide). The charts draw from it, so zooming and panning cost what the screen shows,
 * not the length of the log (ECharts' LTTB then samples the window as before).
 */
export function levelFor(levelLengths: readonly number[], fraction: number, plotWidthPx: number, perPixel = 2): number {
  const f = Math.min(1, Math.max(0, fraction))
  for (let k = levelLengths.length - 1; k > 0; k -= 1) {
    if ((levelLengths[k] / 2) * f >= perPixel * plotWidthPx) return k
  }
  return 0
}

// ------------------------------------------------------------------ overlay geometry (fractions of the plot width)

/** Where [x0, x1] (chart units) sits in the window, as fractions of the plot width, clipped; null when outside. */
export function spanInWindow(x0: number, x1: number, window: XWindow): { left: number; right: number } | null {
  const span = window[1] - window[0]
  if (!(span > 0) || !Number.isFinite(x0) || !Number.isFinite(x1)) return null
  const lo = Math.min(x0, x1)
  const hi = Math.max(x0, x1)
  if (hi < window[0] || lo > window[1]) return null
  return { left: clamp((lo - window[0]) / span, 0, 1), right: clamp((hi - window[0]) / span, 0, 1) }
}

/** The chart x range [x0, x1] of a row range: from its first row to its last row. */
export function rowsToX(axis: TimeAxis, frame: XFrame, range: RowRange): [number, number] {
  const n = axis.values.length
  if (n === 0) return [frame.min, frame.min]
  const start = clamp(Math.floor(range[0]), 0, n - 1)
  const last = clamp(Math.ceil(range[1]) - 1, start, n - 1)
  return [axis.values[start] * frame.factor, axis.values[last] * frame.factor]
}

export interface LaneBand {
  id: string
  x0: number
  x1: number
  label: string
}

export interface LaneLabel {
  id: string
  /** Fractions of the plot width */
  left: number
  right: number
  /** The name fits inside the band and clears the previous written name */
  showLabel: boolean
}

/** Narrowest band (px) that gets its name written in the lane. */
export const LANE_MIN_LABEL_PX = 30

/**
 * Test-point bands in the label lane above the first panel: where each visible band sits, and whether its name is
 * written (wide enough, and clear of the previous written name). `textPx` estimates a name's width.
 */
export function laneLabels(
  bands: readonly LaneBand[],
  window: XWindow,
  plotWidthPx: number,
  textPx: (text: string) => number,
): LaneLabel[] {
  const placed = bands
    .map((band) => ({ band, span: spanInWindow(band.x0, band.x1, window) }))
    .filter((e): e is { band: LaneBand; span: { left: number; right: number } } => e.span !== null)
    .sort((a, b) => a.span.left - b.span.left)
  let lastRightPx = -Infinity
  return placed.map(({ band, span }) => {
    const leftPx = span.left * plotWidthPx
    const widthPx = (span.right - span.left) * plotWidthPx
    const textWidth = Math.min(widthPx, textPx(band.label))
    const showLabel = widthPx >= LANE_MIN_LABEL_PX && leftPx >= lastRightPx + 4
    if (showLabel) lastRightPx = leftPx + textWidth
    return { id: band.id, left: span.left, right: span.right, showLabel }
  })
}

/** The x-axis title: "Elapsed time [s]", "Zulu clock [hh:mm:ss]", "Row number". */
export function axisTitle(axis: TimeAxis): string {
  if (axis.clock) return `${axis.label} [hh:mm:ss]`
  return axis.unit ? `${axis.label} [${axis.unit}]` : axis.label
}

/** Row ranges equal by value (null = whole file; undefined = never set). */
export function sameRows(a: RowRange | null | undefined, b: RowRange | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a[0] === b[0] && a[1] === b[1]
}

/** The view a zoom window stands for: its rows, or null when it shows the whole axis (as setView stores it). */
export function windowView(axis: TimeAxis, frame: XFrame, window: XWindow): RowRange | null {
  if (isWholeWindow(window, frame)) return null
  const rows = windowToRows(axis, frame, window)
  return rows[0] <= 0 && rows[1] >= axis.values.length ? null : rows
}

/** The window for "zoom to" a row range, with `pad` (fraction of its width) either side, inside the frame. */
export function paddedWindow(axis: TimeAxis, frame: XFrame, rows: RowRange, pad = 0.05): XWindow {
  const [x0, x1] = rowsToX(axis, frame, rows)
  const margin = Math.max((x1 - x0) * pad, frame.minSpan / 2)
  return normalizeWindow([x0 - margin, x1 + margin], frame)
}

// ------------------------------------------------------------------ panel layout

export interface StackChrome {
  /** Fixed px per panel besides its plot: card header and borders, grid padding above and below the plot */
  perPanel: number
  /** Fixed px for the whole stack: padding, the status row, the first panel's label lane, the bottom axis */
  fixed: number
  /** Between panels */
  gap: number
}

/**
 * Plot height (px) so `count` panels fill `available` px, kept between `min` and `max` (beyond `min` the stack
 * scrolls). A sensible height when the space is not measured yet (0).
 */
export function fitPlotHeight(available: number, count: number, chrome: StackChrome, min = 120, max = 320): number {
  if (count <= 0) return max
  if (!(available > 0)) return Math.max(min, Math.min(max, 180))
  const room = available - chrome.fixed - chrome.gap * (count - 1) - chrome.perPanel * count
  return Math.round(clamp(room / count, min, max))
}

// ------------------------------------------------------------------ tooltip

export interface TooltipSeries {
  /** Plain text: "KIAS [kt]" (escaped by tooltipRow) */
  name: string
  color: string
  values: Float64Array
}

/** The tooltip at chart x: the nearest row's time as the title, then each series' value (strong) and name. */
export function tooltipHtml(axis: TimeAxis, frame: XFrame, series: readonly TooltipSeries[], x: number): string {
  if (axis.values.length === 0) return ''
  const row = nearestRow(axis.values, x / frame.factor)
  let html = tooltipHeader(formatTimeValue(axis, axis.values[row], frame.step))
  for (const s of series) html += tooltipRow(s.color, s.name, formatNumber(s.values[row]))
  return html
}

// ------------------------------------------------------------------ formatting

function withMinus(text: string): string {
  return text.replace(/-/g, MINUS)
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Decimals that resolve one sample step (0.05 s -> 2), clamped to 0..4. */
export function decimalsFor(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 1
  return clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 4)
}

/** Hour-of-day as "hh:mm:ss" or, with decimals, "hh:mm:ss.s". */
export function formatClockPrecise(hours: number, decimals: number): string {
  if (!Number.isFinite(hours)) return MISSING
  if (decimals <= 0) return formatClock(hours)
  const day = 24 * 3600
  const scale = 10 ** decimals
  const total = ((Math.round(hours * 3600 * scale) / scale) % day + day) % day
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total - h * 3600 - m * 60
  return `${pad2(h)}:${pad2(m)}:${s.toFixed(decimals).padStart(decimals + 3, '0')}`
}

/** One time value as the tooltip header shows it: "123.45 s", "09:15:15.4", "row 1234". */
export function formatTimeValue(axis: TimeAxis, value: number, step: number): string {
  if (!Number.isFinite(value)) return MISSING
  if (axis.clock) return formatClockPrecise(value, step > 0 && step * 3600 < 1 ? 1 : 0)
  if (axis.id === 'index') return `row ${Math.round(value)}`
  const text = withMinus(value.toFixed(decimalsFor(step)))
  return axis.unit ? `${text} ${axis.unit}` : text
}

/** A short tick / slider label for a chart x: "120", "09:15:15", "1.844". */
export function formatTimeTick(frame: XFrame, x: number): string {
  if (!Number.isFinite(x)) return ''
  if (frame.clock) return formatClock(x / frame.factor)
  const value = x / frame.factor
  return withMinus(String(Number(value.toPrecision(10))))
}

/**
 * A tick label for a fixed window (the exported figure). ECharts also puts ticks at the ends of a window; an end that
 * is not a round number for the span ("2193.0608") gets no label, a round one ("0") keeps it.
 */
export function figureTick(frame: XFrame, window: XWindow, x: number): string {
  const span = window[1] - window[0]
  if (span > 0) {
    const tolerance = span * 1e-9
    const atEnd = Math.abs(x - window[0]) <= tolerance || Math.abs(x - window[1]) <= tolerance
    const unit = 10 ** Math.floor(Math.log10(span / 5))
    const steps = x / unit
    if (atEnd && Math.abs(steps - Math.round(steps)) > 1e-6) return ''
  }
  return formatTimeTick(frame, x)
}

/** The app's one range format ("120.4 – 132.7 s"), shared with components/hooks rangeText. */
export { formatTimeRange }

// ------------------------------------------------------------------ typed times (Set window dialog)

/** The digits a typed time needs to resolve one sample step on this axis. */
function inputDecimals(axis: TimeAxis, step: number): number {
  if (axis.unit === 'h') return clamp(decimalsFor(step), 4, 6)
  return decimalsFor(step)
}

/** An axis value as text to edit in a time field: "123.45", "09:15:15", "1234" (row). ASCII minus. */
export function axisInputText(axis: TimeAxis, value: number, step: number): string {
  if (!Number.isFinite(value)) return ''
  if (axis.clock) return formatClockPrecise(value, step > 0 && step * 3600 < 1 ? 1 : 0)
  if (axis.id === 'index') return String(Math.round(value))
  return String(Number(value.toFixed(inputDecimals(axis, step))))
}

/**
 * A typed time on this axis, or null when it does not read as one: a number ("120", "120.5 s", "−3") on second, hour
 * and row axes ("row 1200" too), a clock time ("09:15", "09:15:30.5") on hour-of-day axes. A clock time is put on
 * the day the axis covers (clock axes may run past 24 h when the flight crosses midnight).
 */
export function parseAxisInput(axis: TimeAxis, text: string): number | null {
  const typed = text.trim().replace(/[−–]/g, '-').replace(/,/g, '.')
  if (!typed) return null
  if (axis.clock) {
    const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?$/.exec(typed)
    if (!match) return null
    const h = Number(match[1])
    const m = Number(match[2])
    const sec = match[3] === undefined ? 0 : Number(match[3])
    if (h > 23 || m > 59 || !(sec < 60)) return null
    const hours = h + m / 60 + sec / 3600
    const values = axis.values
    if (!values.length) return hours
    const lo = values[0]
    const hi = values[values.length - 1]
    // The day offset (…, −24, 0, 24, 48) that puts the time closest to the axis.
    let best = hours
    let bestDistance = Infinity
    for (let day = Math.floor(lo / 24) - 1; day <= Math.floor(hi / 24) + 1; day += 1) {
      const candidate = hours + 24 * day
      const distance = candidate < lo ? lo - candidate : candidate > hi ? candidate - hi : 0
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }
    return best
  }
  let body = typed
  if (axis.id === 'index') body = body.replace(/^rows?\s*/i, '')
  else if (axis.unit && body.toLowerCase().endsWith(axis.unit.toLowerCase())) {
    body = body.slice(0, body.length - axis.unit.length).trim()
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(body)) return null
  const value = Number(body)
  return Number.isFinite(value) ? value : null
}

export interface SelectionSummary {
  range: string
  duration: string
  rows: string
}

/** The selection bar's "120.4 – 132.7 s · 12.3 s · 123 rows", in parts. */
export function selectionSummary(ds: Dataset, axis: TimeAxis, range: RowRange): SelectionSummary {
  const n = Math.max(0, Math.min(ds.rowCount, range[1]) - Math.max(0, range[0]))
  const start = clamp(range[0], 0, Math.max(0, ds.rowCount - 1))
  const last = clamp(range[1] - 1, start, Math.max(0, ds.rowCount - 1))
  return {
    range: formatTimeRange(axis, axis.values[start], axis.values[last]),
    duration: formatDuration(ds.elapsed[last] - ds.elapsed[start]),
    rows: `${n} ${n === 1 ? 'row' : 'rows'}`,
  }
}

// ------------------------------------------------------------------ steadiness stats

export interface SteadyStat {
  id: string
  name: string
  unit: string
  /** "252.3 ± 0.42" */
  meanText: string
  /** "+0.31 kt/min", "−2.1/min" */
  driftText: string
  title: string
  n: number
}

/** Signed with a real minus or a plus: "+0.31", "−2.1"; "—" for NaN. */
export function signedNumber(value: number, significant = 2): string {
  if (Number.isNaN(value)) return MISSING
  const text = formatNumber(value, significant)
  return value > 0 && text !== '0' ? `+${text}` : text
}

/** Mean ± σ and drift per minute (against elapsed time) of each channel over the rows. */
export function steadyStats(ds: Dataset, channels: readonly Channel[], range: RowRange): SteadyStat[] {
  return channels.map((ch) => {
    // Headings across north are unwrapped first, as in the Test points table.
    const { stats, drift } = windowStats(ch, ds.elapsed, range[0], range[1])
    const unit = ch.meta.unit
    const meanText = stats.n > 0 ? `${formatNumber(stats.mean)} ± ${formatNumber(stats.std, 2)}` : MISSING
    const driftText = Number.isNaN(drift) ? MISSING : `${signedNumber(drift)} ${unit ? `${unit}/min` : '/min'}`
    return {
      id: ch.id,
      name: ch.meta.short,
      unit,
      meanText,
      driftText,
      title: `${channelTitle(ch)}: mean ${meanText}${unit ? ` ${unit}` : ''} (±1σ) over ${stats.n} samples, drift ${driftText}`,
      n: stats.n,
    }
  })
}
