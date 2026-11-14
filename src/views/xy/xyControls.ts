// Small decisions behind the X–Y controls and chart chrome: the test-point group filter, which sources and options can
// be chosen now, whether the chart is zoomed (and the zoom window an exported figure keeps), the chart's description,
// the summary line and the export file names. Pure: no React, no DOM.

import { formatNumber as formatCoefficient } from '../../core/analysis/fit'
import { safeFilename } from '../../core/export/download'
import type { RowRange, Workspace, XYConfig } from '../../core/types'
import type { XYZoomSpec, XYZoomWindow } from '../../charts/options/xy'
import { XY_ZOOM_X, XY_ZOOM_Y } from '../../charts/options/xy'
import {
  FIT_NAME,
  SAMPLE_STRIDE,
  type MarkerShape,
  type XYData,
  type XYFit,
  type XYLabels,
  type XYMean,
} from './xyModel'

// ------------------------------------------------------------------ the test-point group filter

/**
 * The group filter after clicking a group's chip: the group is toggled, at least one group stays selected, and "every
 * group" is stored as [] (so groups added later are included). Kept in workspace order.
 */
export function toggleGroupFilter(allIds: readonly string[], current: readonly string[] | undefined, id: string): string[] {
  const chosen = (current ?? []).filter((g) => allIds.includes(g))
  const selected = chosen.length ? chosen : [...allIds]
  const next = selected.includes(id) ? selected.filter((g) => g !== id) : [...selected, id]
  if (next.length === 0) return chosen
  if (allIds.every((g) => next.includes(g))) return []
  return allIds.filter((g) => next.includes(g))
}

/** Visible test points per group id (hidden points are never plotted). */
export function visiblePointCounts(ws: Pick<Workspace, 'points'>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of ws.points) if (!p.hidden) counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1)
  return counts
}

// ------------------------------------------------------------------ what can be chosen now

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  disabled: boolean
  /** Tooltip: what the option does, or why it is unavailable */
  title: string
}

/** The data sources: the zoom range needs a Time-history zoom, test points need at least one point. */
export function sourceOptions(view: RowRange | null, ws: Pick<Workspace, 'points'>): ChoiceOption<XYConfig['source']>[] {
  const points = ws.points.length
  return [
    { value: 'all', label: 'All data', disabled: false, title: 'Every row of the file' },
    {
      value: 'view',
      label: 'Zoom range',
      disabled: !view,
      title: view ? 'The rows of the zoom range in Time history' : 'Zoom in on Time history first: this plots the rows you zoomed to',
    },
    {
      value: 'points',
      label: 'Test points',
      disabled: points === 0,
      title:
        points === 0
          ? 'Save test points first (Time history → Select → drag → Save test point)'
          : 'The rows of the visible test points, with their means',
    },
  ]
}

/** Colour by: test-point groups need the test-point source. */
export function colorOptions(withPoints: boolean): ChoiceOption<XYConfig['colorBy']>[] {
  return [
    { value: 'series', label: 'Series', disabled: false, title: 'One colour per Y channel' },
    {
      value: 'group',
      label: 'Test group',
      disabled: !withPoints,
      title: withPoints ? 'One colour per test-point group' : 'Needs the Test points source',
    },
    { value: 'time', label: 'Time', disabled: false, title: 'Light to dark from early to late' },
  ]
}

/** Fit through: the means need the test-point source. */
export function fitTargetOptions(withPoints: boolean): ChoiceOption<XYConfig['fitTarget']>[] {
  return [
    { value: 'samples', label: 'Samples', disabled: false, title: 'Every plotted sample' },
    {
      value: 'means',
      label: 'Means',
      disabled: !withPoints,
      title: withPoints ? 'One mean per test point (what a trim-curve fit needs)' : 'Needs the Test points source',
    },
  ]
}

export const FIT_OPTIONS: readonly { value: XYConfig['fit']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'poly2', label: 'Quadratic' },
  { value: 'poly3', label: 'Cubic' },
]

export const STYLE_OPTIONS: readonly { value: XYConfig['style']; label: string; title: string }[] = [
  { value: 'points', label: 'Points', title: 'A dot per sample' },
  { value: 'lines', label: 'Lines', title: 'Samples joined in time order' },
  { value: 'both', label: 'Both', title: 'Dots joined in time order' },
]

// ------------------------------------------------------------------ zoom
//
// ECharts keeps a dataZoom window either as percents (start/end: wheel and pan) or as axis values
// (startValue/endValue: the zoom box), whichever was set last; the other pair is then null.

interface DataZoomState extends XYZoomSpec {
  id?: string
  dataZoomId?: string
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function records(list: unknown): DataZoomState[] {
  return Array.isArray(list) ? (list.filter((d) => typeof d === 'object' && d !== null) as DataZoomState[]) : []
}

/** Whether a window shows less than its whole axis: percents inside 0–100 when given, else any value window. */
export function windowZoomed(state: XYZoomSpec | undefined): boolean {
  if (!state) return false
  if (isNum(state.start) || isNum(state.end)) {
    const start = isNum(state.start) ? state.start : 0
    const end = isNum(state.end) ? state.end : 100
    return start > 0.001 || end < 99.999
  }
  return isNum(state.startValue) || isNum(state.endValue)
}

/** Which of the two axes are zoomed in (by dataZoom id). */
export type ZoomFlags = Readonly<Record<string, boolean>>

/** The zoom flags after a 'datazoom' event: its payload, or each item of its batch. Other dataZooms are ignored. */
export function applyZoomEvent(flags: ZoomFlags, params: unknown): ZoomFlags {
  if (typeof params !== 'object' || params === null) return flags
  const batch = (params as { batch?: unknown }).batch
  const items = Array.isArray(batch) ? records(batch) : [params as DataZoomState]
  let next = flags
  for (const item of items) {
    const id = item.dataZoomId
    if (id !== XY_ZOOM_X && id !== XY_ZOOM_Y) continue
    const zoomed = windowZoomed(item)
    if (next[id] !== zoomed) next = { ...next, [id]: zoomed }
  }
  return next
}

export const anyZoomed = (flags: ZoomFlags): boolean => Object.values(flags).some(Boolean)

/**
 * The zoom window an exported figure keeps, from the chart's current option (chart.getOption()): per zoomed axis the
 * pair ECharts holds (values or percents); null when neither axis is zoomed.
 */
export function figureZoom(option: unknown): XYZoomWindow | null {
  const list = typeof option === 'object' && option !== null ? records((option as { dataZoom?: unknown }).dataZoom) : []
  const out: XYZoomWindow = {}
  for (const d of list) {
    if (d.id !== XY_ZOOM_X && d.id !== XY_ZOOM_Y) continue
    if (!windowZoomed(d)) continue
    const spec: XYZoomSpec =
      isNum(d.startValue) && isNum(d.endValue)
        ? { startValue: d.startValue, endValue: d.endValue }
        : { start: isNum(d.start) ? d.start : 0, end: isNum(d.end) ? d.end : 100 }
    if (d.id === XY_ZOOM_X) out.x = spec
    else out.y = spec
  }
  return out.x || out.y ? out : null
}

/** Identifies what is plotted (channels, rows, groups): a new plot starts unzoomed and focused. */
export function plotKey(data: Pick<XYData, 'x' | 'ys' | 'effective'>): string {
  return [
    data.x?.id ?? '',
    data.ys.map((y) => y.ch.id).join(','),
    data.effective.source,
    data.effective.groupIds.join(','),
  ].join('|')
}

// ------------------------------------------------------------------ extreme samples

/**
 * The axes to show when a few samples sit absurdly far from the rest (X-Plane's CL while on the ground or nearly
 * stopped reaches ±10⁸), so the flight data can be read; null axes show everything. Means always stay in view.
 */
export interface AxisFocus {
  x: [number, number] | null
  y: [number, number] | null
  /** Samples left outside the axes */
  outside: number
  /** The farthest value left out on each axis (null when that axis shows everything) */
  xFar: number | null
  yFar: number | null
}

/** Quantiles come from at most this many samples. */
const FOCUS_SAMPLE = 40_000
/** Values beyond the quartiles by more than this many interquartile ranges are "far". */
const FOCUS_FENCE = 10
/**
 * Focus only when the full range is this many times the range inside the fences: absurd values are orders of magnitude
 * off (CL 10⁸ against 0.5), while real but rare excursions (a climb in a level log) are not.
 */
const FOCUS_DRAMATIC = 1000
/** Never hide more than this share of the samples. */
const FOCUS_MAX_HIDDEN = 0.05
const FOCUS_PAD = 0.04

function quantileSorted(sorted: Float64Array, q: number): number {
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

type SampleArrays = readonly { data: Float32Array; count: number }[]

/** The fenced range of one axis (offset 0 = x, 1 = y), or null when nothing is dramatically far out. */
function axisFocus(series: SampleArrays, offset: 0 | 1): { range: [number, number]; far: number } | null {
  let total = 0
  for (const s of series) total += s.count
  if (total < 20) return null
  const step = Math.max(1, Math.ceil(total / FOCUS_SAMPLE))
  const sample = new Float64Array(Math.ceil(total / step))
  let n = 0
  let k = 0
  let min = Infinity
  let max = -Infinity
  for (const s of series) {
    for (let i = 0; i < s.count; i += 1, k += 1) {
      const v = s.data[i * SAMPLE_STRIDE + offset]
      if (v < min) min = v
      if (v > max) max = v
      if (k % step === 0 && n < sample.length) sample[n++] = v
    }
  }
  const sorted = sample.subarray(0, n).sort()
  let q1 = quantileSorted(sorted, 0.25)
  let q3 = quantileSorted(sorted, 0.75)
  if (!(q3 > q1)) {
    // Mostly one value: judge by the middle 90 % instead.
    q1 = quantileSorted(sorted, 0.05)
    q3 = quantileSorted(sorted, 0.95)
    if (!(q3 > q1)) return null
  }
  const lo = q1 - FOCUS_FENCE * (q3 - q1)
  const hi = q3 + FOCUS_FENCE * (q3 - q1)
  let keptMin = Infinity
  let keptMax = -Infinity
  for (const s of series) {
    for (let i = 0; i < s.count; i += 1) {
      const v = s.data[i * SAMPLE_STRIDE + offset]
      if (v >= lo && v <= hi) {
        if (v < keptMin) keptMin = v
        if (v > keptMax) keptMax = v
      }
    }
  }
  const kept = keptMax - keptMin
  if (!(kept > 0) || !(max - min > FOCUS_DRAMATIC * kept)) return null
  const mid = (keptMin + keptMax) / 2
  return { range: [keptMin, keptMax], far: Math.abs(max - mid) >= Math.abs(min - mid) ? max : min }
}

/** A 1, 2 or 5 × 10ⁿ step near `raw`. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw))
  const f = raw / power
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power
}

/** The range widened to whole steps of a round number (about 6 steps across), without binary noise. */
export function niceRange([lo, hi]: [number, number]): [number, number] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo, hi]
  const step = niceStep((hi - lo) / 6)
  const clean = (v: number) => Number(v.toPrecision(12))
  return [clean(Math.floor(lo / step) * step), clean(Math.ceil(hi / step) * step)]
}

/** Where to point the axes so a handful of absurd samples do not flatten the rest (see AxisFocus). */
export function focusExtent(data: { series: SampleArrays; means: readonly Pick<XYMean, 'x' | 'yStats'>[] }): AxisFocus {
  const fx = axisFocus(data.series, 0)
  const fy = axisFocus(data.series, 1)
  if (!fx && !fy) return { x: null, y: null, outside: 0, xFar: null, yFar: null }
  const padded = (r: [number, number]): [number, number] => {
    const pad = (r[1] - r[0]) * FOCUS_PAD
    return [r[0] - pad, r[1] + pad]
  }
  let x = fx ? padded(fx.range) : null
  let y = fy ? padded(fy.range) : null
  for (const m of data.means) {
    if (x && Number.isFinite(m.x.mean)) x = [Math.min(x[0], m.x.mean), Math.max(x[1], m.x.mean)]
    if (y && Number.isFinite(m.yStats.mean)) y = [Math.min(y[0], m.yStats.mean), Math.max(y[1], m.yStats.mean)]
  }
  // Axis ends on round numbers (a fixed min/max is printed as it is).
  x = x && niceRange(x)
  y = y && niceRange(y)
  let outside = 0
  let total = 0
  for (const s of data.series) {
    total += s.count
    for (let i = 0; i < s.count; i += 1) {
      const vx = s.data[i * SAMPLE_STRIDE]
      const vy = s.data[i * SAMPLE_STRIDE + 1]
      if ((x && (vx < x[0] || vx > x[1])) || (y && (vy < y[0] || vy > y[1]))) outside += 1
    }
  }
  if (outside > FOCUS_MAX_HIDDEN * total) return { x: null, y: null, outside: 0, xFar: null, yFar: null }
  return { x, y, outside, xFar: fx ? fx.far : null, yFar: fy ? fy.far : null }
}

/** The axis ranges to apply: the focus, unless there is none or everything was asked for. */
export function focusedAxes(
  focus: AxisFocus | null,
  showAll: boolean,
): { x: [number, number] | null; y: [number, number] | null } | null {
  if (!focus || showAll || (!focus.x && !focus.y)) return null
  return { x: focus.x, y: focus.y }
}

/**
 * "3 extreme samples (CL down to −6×10⁸) are off the axes and out of the fit, so the rest can be read." With
 * everything shown: "Showing everything, the 3 extreme samples included (in the fit too)."
 */
export function focusNote(
  focus: AxisFocus,
  data: Pick<XYData, 'x' | 'ys'>,
  showAll: boolean,
  fits: readonly Pick<XYFit, 'fit' | 'target' | 'excluded'>[],
): string {
  const n = focus.outside
  const what = `${count(n)} extreme sample${n === 1 ? '' : 's'}`
  if (showAll) {
    const fitted = fits.some((f) => f.fit && f.target === 'samples')
    return `Showing everything, the ${what} included${fitted ? ' (in the fit too)' : ''}.`
  }
  const far = (name: string, value: number | null) =>
    value === null ? '' : `${name} ${value < 0 ? 'down' : 'up'} to ${formatCoefficient(value)}`
  const where = [
    far(data.ys.length === 1 ? data.ys[0].ch.meta.short : 'Y', focus.yFar),
    far(data.x?.meta.short ?? 'X', focus.xFar),
  ]
    .filter(Boolean)
    .join(', ')
  const outOfFit = fits.some((f) => f.excluded > 0) ? ' and out of the fit' : ''
  return `${what}${where ? ` (${where})` : ''} ${n === 1 ? 'is' : 'are'} off the axes${outOfFit}, so the rest can be read.`
}

// ------------------------------------------------------------------ colour by time

/** The colour at fraction f of the time ramp (lives with the chart option, which draws the bands in it). */
export { rampColor } from '../../charts/options/xy'

// ------------------------------------------------------------------ legend chips

export interface LegendChip {
  key: string
  name: string
  /** marker: a marker in the slot colour (or neutral ink); line: a line key; fit: the fit-line key; mean: mean ± 1σ */
  kind: 'marker' | 'line' | 'fit' | 'mean'
  /** Colour slot 0..7, or null for neutral ink */
  slot: number | null
  shape: MarkerShape
}

/**
 * The chips above the chart: one per colour entity (Y channel or test-point group) and per Y channel shape when shape
 * tells channels apart, then the fit line and the mean marker. Samples drawn only as lines get a line key.
 */
export function legendChips(data: XYData, fits: readonly XYFit[], fit: XYConfig['fit'], style: XYConfig['style']): LegendChip[] {
  const asLine = style === 'lines' && data.effective.colorBy !== 'time'
  const chips: LegendChip[] = data.legend.map((e) => ({
    key: e.key,
    name: e.name,
    kind: e.kind === 'colour' && asLine ? 'line' : 'marker',
    slot: e.kind === 'colour' ? e.slot : null,
    shape: e.shape,
  }))
  if (fit !== 'none' && fits.some((f) => f.fit && f.curve.length >= 4)) {
    chips.push({ key: 'fit', name: FIT_NAME[fit], kind: 'fit', slot: null, shape: 'circle' })
  }
  if (data.effective.showMeans && data.means.length) {
    chips.push({ key: 'mean', name: 'Test-point mean ± 1σ', kind: 'mean', slot: null, shape: 'circle' })
  }
  return chips
}

// ------------------------------------------------------------------ words

const count = (n: number) => n.toLocaleString('en-GB')
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/** What is plotted, for the heading: "5 test points (Trim points) · 4 821 samples · 5 means". */
export function plotSummary(data: XYData, groupNames: readonly string[], showSamples: boolean): string {
  const e = data.effective
  const parts: string[] = []
  if (e.source === 'points') {
    const names = e.groupFiltered && groupNames.length ? ` (${groupNames.join(', ')})` : ''
    parts.push(`${plural(e.points.length, 'test point')}${names}`)
  } else {
    parts.push(e.source === 'view' ? 'Zoom range' : 'Whole file')
  }
  if (showSamples) parts.push(plural(data.sampleCount, 'sample'))
  if (e.showMeans && data.means.length) parts.push(plural(data.means.length, 'mean'))
  return parts.join(' · ')
}

/** The chart's accessible description: what is plotted against what, how, and with which fit. */
export function chartDescription(data: XYData, labels: XYLabels, fits: readonly XYFit[], fit: XYConfig['fit']): string {
  const e = data.effective
  const what = e.showMeans && data.means.length ? 'samples and test-point means (± 1σ)' : 'samples'
  const fitted = fits.filter((f) => f.fit).length
  const fitText = fit !== 'none' && fitted ? `, ${FIT_NAME[fit].toLowerCase()}${fitted > 1 ? 's' : ''} through the ${e.fitTarget === 'means' ? 'means' : 'samples'}` : ''
  return `X–Y plot of ${labels.y} against ${labels.x}: ${what}${fitText}`
}

/** File-name stem for exports: "<file>_xy", e.g. "Data_737_xy". */
export function exportStem(datasetName: string, suffix = 'xy'): string {
  return `${safeFilename(datasetName.replace(/\.[A-Za-z0-9]{1,5}$/, ''), 'flight')}_${suffix}`
}
