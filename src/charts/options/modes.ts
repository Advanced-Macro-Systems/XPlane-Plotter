// Chart option for the Dynamic modes tab: the analysed window as a 1.5 px line, the fitted model as a 2 px line in the
// second slot colour, the decay envelope as thin dashed lines, the detected peaks as 9 px triangles on the raw samples,
// and (optionally) the residuals in a short second grid on the same time axis.
// OWNER: modes view. Data arrays are built once per window and fit (modesPlotData); the option is rebuilt per theme or
// layout change only (buildModesOption), so hovering never rebuilds data.

import type { EChartsOption } from '../echarts'
import { axisLabel, formatNumber, tooltipHeader, tooltipRow } from '../format'
import { baseOption, mergeOptions, seriesColor, valueAxis, type ChartTheme } from '../theme'

export interface ModesPeak {
  t: number
  value: number
  kind: 'max' | 'min'
}

export interface ModesPlotInput {
  /** Seconds since the window's first row */
  t: Float64Array
  y: Float64Array
  /** The fitted model at every t (null: no fit to draw) */
  fitted: Float64Array | null
  /** false when the fit was rejected: it is drawn dashed and named "Fit (rejected)" */
  fitOk: boolean
  envelope: { upper: Float64Array; lower: Float64Array } | null
  peaks: readonly ModesPeak[]
  /** First-order fits: the time constant and the final value, marked on the chart */
  firstOrder: { tau: number; t0: number; offset: number } | null
  /** Name of the data series (legend, tooltip), e.g. "KTAS" */
  name: string
  /** y-axis title, e.g. "KTAS [kt]" */
  yTitle: string
  /** Dataset.elapsed at t = 0 (s), shown in the tooltip */
  t0Elapsed: number
}

type Pair = [number, number | null]

export interface ModesPlotData {
  input: ModesPlotInput
  data: Pair[]
  fit: Pair[] | null
  upper: Pair[] | null
  lower: Pair[] | null
  residual: Pair[] | null
  /** Window length (s) */
  duration: number
  /**
   * Finite value range of the data and fit (the y-axis bounds: an oscillation's envelope may reach beyond them near
   * the start and is clipped) and of the residuals
   */
  yRange: [number, number]
  rRange: [number, number]
  /** Peak kind by sample time */
  peakAt: Map<number, ModesPeak>
}

export interface ModesOptionSettings {
  /** Show the residuals grid under the main plot */
  residuals: boolean
  /** Figure export (paper theme): a title, a subtitle and a legend inside the image */
  figure?: { title: string; subtitle?: string }
}

export const TIME_AXIS_TITLE = 'Time since window start [s]'

const FIT_NAME = 'Fit'
const REJECTED_FIT_NAME = 'Fit (rejected)'
const ENVELOPE_NAME = 'Envelope'
const PEAKS_NAME = 'Peaks'
const RESIDUAL_NAME = 'Residual'

function pairs(t: Float64Array, v: Float64Array): Pair[] {
  const out: Pair[] = new Array(t.length)
  for (let k = 0; k < t.length; k += 1) out[k] = [t[k], Number.isFinite(v[k]) ? v[k] : null]
  return out
}

function extent(arrays: readonly (Float64Array | null)[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const values of arrays) {
    if (!values) continue
    for (let k = 0; k < values.length; k += 1) {
      const v = values[k]
      if (!Number.isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return lo <= hi ? [lo, hi] : [0, 1]
}

/** The arrays ECharts draws, built once per window and fit. */
export function modesPlotData(input: ModesPlotInput): ModesPlotData {
  const { t, y, fitted, envelope } = input
  let residual: Float64Array | null = null
  if (fitted) {
    residual = new Float64Array(t.length)
    for (let k = 0; k < t.length; k += 1) residual[k] = y[k] - fitted[k]
  }
  const duration = t.length > 0 ? t[t.length - 1] : 0
  return {
    input,
    data: pairs(t, y),
    fit: fitted ? pairs(t, fitted) : null,
    upper: envelope ? pairs(t, envelope.upper) : null,
    lower: envelope ? pairs(t, envelope.lower) : null,
    residual: residual ? pairs(t, residual) : null,
    duration,
    yRange: extent([y, fitted]),
    rRange: extent([residual]),
    peakAt: new Map(input.peaks.map((p) => [p.t, p])),
  }
}

// ------------------------------------------------------------------------------------------------ layout helpers

/** ECharts' "nice" interval (1, 2, 3, 5 × 10^n) for a span split into about `count` parts. */
function niceInterval(span: number, count: number): number {
  const raw = span / count
  const exponent = Math.floor(Math.log10(raw))
  const scale = 10 ** exponent
  const f = raw / scale
  const nice = f < 1.5 ? 1 : f < 2.5 ? 2 : f < 4 ? 3 : f < 7 ? 5 : 10
  return nice * scale
}

/** The tick labels a value axis will most likely show for [min, max] (about 5 intervals, nice bounds). */
export function likelyTickLabels(min: number, max: number, count = 5): string[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ['0']
  if (min === max) return [axisLabel(min)]
  const step = niceInterval(max - min, count)
  const first = Math.floor(min / step)
  const last = Math.ceil(max / step)
  const labels: string[] = []
  for (let k = first; k <= last && labels.length < 40; k += 1) labels.push(axisLabel(k * step))
  return labels
}

/** Estimated width (px) of the widest tick label of a value axis over [lo, hi]. */
export function labelWidth([lo, hi]: readonly [number, number], fontSize: number): number {
  let chars = 1
  for (const label of likelyTickLabels(lo, hi)) chars = Math.max(chars, label.length)
  return Math.ceil(chars * fontSize * 0.62)
}

const NAME_GAP = 10

/**
 * Left margin (px) that holds the widest y tick label plus the rotated axis title, so the two grids line up exactly.
 * (If the estimate is short, ECharts shrinks the grid to keep the labels on the canvas rather than clip them.)
 */
export function leftMargin(ranges: readonly [number, number][], fontSize: number): number {
  const widest = Math.max(...ranges.map((range) => labelWidth(range, fontSize)))
  // axisLabel margin 8 + labels + name gap + rotated title (one line) + breathing room.
  return widest + 8 + NAME_GAP + Math.ceil(fontSize * 1.2) + 8
}

/** A multiple of `step` without binary noise (250.20000000000002 -> 250.2), as ECharts rounds its own ticks. */
function roundToStep(value: number, step: number): number {
  const decimals = Math.min(20, Math.max(0, 1 - Math.floor(Math.log10(step))))
  return Number(value.toFixed(decimals))
}

/**
 * Nice axis bounds (ECharts' own rounding) around [lo, hi]. They are rounded to the step's decimals: ECharts checks
 * (by assertion, in development builds) that its rounded nice ticks lie inside a fixed min/max, and a bound with binary
 * noise just above a tick fails that check.
 */
export function niceBounds([lo, hi]: readonly [number, number]): [number, number] {
  if (!(hi > lo)) return [lo - 1, hi + 1]
  const step = niceInterval(hi - lo, 5)
  return [roundToStep(Math.floor(lo / step) * step, step), roundToStep(Math.ceil(hi / step) * step, step)]
}

/** Index of the sample nearest to time x (t ascending). */
export function nearestIndex(t: Float64Array, x: number): number {
  const n = t.length
  if (n === 0) return -1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] < x) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(t[lo - 1] - x) <= Math.abs(t[lo] - x)) return lo - 1
  return lo
}

// ------------------------------------------------------------------------------------------------ the option

const RIGHT = 22
const BOTTOM = 46
const RESIDUAL_HEIGHT = 74
const GRID_GAP = 18

export function buildModesOption(plot: ModesPlotData, theme: ChartTheme, settings: ModesOptionSettings): EChartsOption {
  const { input } = plot
  const dataColor = seriesColor(theme, 0)
  const fitColor = seriesColor(theme, 1)
  const residualColor = theme.textMuted
  const showResiduals = settings.residuals && plot.residual !== null
  const figure = settings.figure
  const markers = plot.fit ? firstOrderMarkers(plot, theme) : null
  // Room above the plot for the τ label of a first-order fit.
  const top = (figure ? (figure.subtitle ? 92 : 74) : 14) + (markers ? 14 : 0)
  const yBounds = niceBounds(plot.yRange)
  const ranges = showResiduals ? [yBounds, plot.rRange] : [yBounds]
  const left = leftMargin(ranges, theme.fontSize)
  // Both axis titles line up: each sits as far beyond its own labels as the widest labels need.
  const widest = Math.max(...ranges.map((range) => labelWidth(range, theme.fontSize)))
  const nameGap = (range: readonly [number, number]) => NAME_GAP + widest - labelWidth(range, theme.fontSize)
  const fitName = input.fitOk ? FIT_NAME : REJECTED_FIT_NAME
  const xMax = plot.duration > 0 ? plot.duration : undefined

  const grids: Record<string, unknown>[] = [
    { left, right: RIGHT, top, bottom: showResiduals ? BOTTOM + RESIDUAL_HEIGHT + GRID_GAP : BOTTOM },
  ]
  // The axis ends exactly at the last sample; its (rarely round) end value is not labelled.
  const timeAxis = (gridIndex: number, name: string, labels: boolean) =>
    valueAxis(theme, name, { gridIndex, min: 0, max: xMax, axisLabel: { show: labels, showMaxLabel: false } })
  const xAxes: Record<string, unknown>[] = []
  const yAxes: Record<string, unknown>[] = [
    valueAxis(theme, input.yTitle, { gridIndex: 0, min: yBounds[0], max: yBounds[1], nameGap: nameGap(yBounds) }),
  ]
  if (showResiduals) {
    grids.push({ left, right: RIGHT, height: RESIDUAL_HEIGHT, bottom: BOTTOM })
    xAxes.push(timeAxis(0, '', false), timeAxis(1, TIME_AXIS_TITLE, true))
    // Not scaled: the axis always includes zero, the line every residual is measured from.
    yAxes.push(
      valueAxis(theme, RESIDUAL_NAME, { gridIndex: 1, scale: false, splitNumber: 2, nameGap: nameGap(plot.rRange) }),
    )
  } else {
    xAxes.push(timeAxis(0, TIME_AXIS_TITLE, true))
  }

  // symbol 'none' also keeps the circles out of the exported figure's legend (a line key per series).
  const line = {
    type: 'line',
    symbol: 'none',
    showSymbol: false,
    sampling: 'lttb',
    animation: false,
    emphasis: { disabled: true },
  }
  const series: Record<string, unknown>[] = [
    {
      ...line,
      id: 'data',
      name: input.name,
      data: plot.data,
      z: 3,
      lineStyle: { width: 1.5, color: dataColor },
      itemStyle: { color: dataColor },
    },
  ]
  if (plot.upper && plot.lower) {
    const envelope = {
      ...line,
      name: ENVELOPE_NAME,
      silent: true,
      z: 2,
      lineStyle: { width: 1, type: [4, 4], color: fitColor, opacity: 0.6 },
      itemStyle: { color: fitColor },
    }
    series.push({ ...envelope, id: 'env-upper', data: plot.upper }, { ...envelope, id: 'env-lower', data: plot.lower })
  }
  if (plot.fit) {
    series.push({
      ...line,
      id: 'fit',
      name: fitName,
      data: plot.fit,
      z: 4,
      lineStyle: { width: 2, color: fitColor, type: input.fitOk ? 'solid' : 'dashed', opacity: input.fitOk ? 1 : 0.75 },
      itemStyle: { color: fitColor },
      ...(markers ? { markLine: markers } : {}),
    })
  }
  if (input.peaks.length) {
    series.push({
      id: 'peaks',
      name: PEAKS_NAME,
      type: 'scatter',
      animation: false,
      z: 5,
      symbol: 'triangle',
      symbolSize: 9,
      data: input.peaks.map((p) => ({ value: [p.t, p.value], symbolRotate: p.kind === 'min' ? 180 : 0 })),
      itemStyle: { color: dataColor, borderColor: theme.surface, borderWidth: 1.5 },
      emphasis: { scale: 1.25 },
    })
  }
  if (showResiduals && plot.residual) {
    series.push({
      ...line,
      id: 'residual',
      name: RESIDUAL_NAME,
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: plot.residual,
      lineStyle: { width: 1, color: residualColor },
      itemStyle: { color: residualColor },
      markLine: {
        silent: true,
        symbol: 'none',
        animation: false,
        label: { show: false },
        lineStyle: { color: theme.axis, width: 1, type: 'solid' },
        data: [{ yAxis: 0 }],
      },
    })
  }

  const option: Record<string, unknown> = {
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    series,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      formatter: tooltipFormatter(plot, { dataColor, fitColor, residualColor, fitName }),
    },
  }
  if (figure) {
    option.title = {
      text: figure.title,
      subtext: figure.subtitle ?? '',
      left: left - 4,
      top: 8,
      itemGap: 6,
      textStyle: { color: theme.text, fontFamily: theme.font, fontSize: theme.fontSize + 3, fontWeight: 600 },
      subtextStyle: { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize },
    }
    option.legend = {
      top: figure.subtitle ? 58 : 40,
      left: left - 4,
      itemWidth: 18,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize },
      data: legendItems(plot, input.fitOk, fitName, showResiduals),
    }
  }
  return mergeOptions(baseOption(theme), option) as EChartsOption
}

// Legend keys drawn as strokes (ECharts' own key for a line series adds a circle even without symbols). The legend keeps
// a path's aspect ratio, so these stay thin bars centred in the key box.
const LINE_KEY = 'path://M0,0h18v2h-18z'
const DASHED_KEY = 'path://M0,0h4v2h-4zM7,0h4v2h-4zM14,0h4v2h-4z'

interface LegendItem {
  name: string
  icon?: string
}

function legendItems(plot: ModesPlotData, fitOk: boolean, fitName: string, residuals: boolean): LegendItem[] {
  const items: LegendItem[] = [{ name: plot.input.name, icon: LINE_KEY }]
  if (plot.fit) items.push({ name: fitName, icon: fitOk ? LINE_KEY : DASHED_KEY })
  if (plot.upper) items.push({ name: ENVELOPE_NAME, icon: DASHED_KEY })
  if (plot.input.peaks.length) items.push({ name: PEAKS_NAME })
  if (residuals && plot.residual) items.push({ name: RESIDUAL_NAME, icon: LINE_KEY })
  return items
}

/** First-order fits: a dashed line at t0 + τ (63% of the change done) and at the final value c. */
function firstOrderMarkers(plot: ModesPlotData, theme: ChartTheme): Record<string, unknown> | null {
  const fo = plot.input.firstOrder
  if (!fo || !plot.input.fitOk || !(fo.tau > 0) || !Number.isFinite(fo.offset)) return null
  const at = fo.t0 + fo.tau
  const label = { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize - 1 }
  const data: Record<string, unknown>[] = [
    { yAxis: fo.offset, label: { ...label, formatter: `c = ${formatNumber(fo.offset, 3)}`, position: 'insideEndTop' } },
  ]
  if (at >= 0 && at <= plot.duration) {
    data.push({ xAxis: at, label: { ...label, formatter: `τ = ${formatNumber(fo.tau, 3)} s`, position: 'end' } })
  }
  return {
    silent: true,
    symbol: 'none',
    animation: false,
    lineStyle: { color: theme.crosshair, width: 1, type: 'dashed', opacity: 0.6 },
    data,
  }
}

interface TooltipColors {
  dataColor: string
  fitColor: string
  residualColor: string
  fitName: string
}

/**
 * Every series at the hovered time, read from the arrays (so hovering either grid lists the same rows): the value in
 * strong ink, then the escaped name (tooltipRow escapes; names come from file headers).
 */
function tooltipFormatter(plot: ModesPlotData, colors: TooltipColors): (params: unknown) => string {
  const { t, y, fitted, envelope, name, t0Elapsed } = plot.input
  return (params: unknown) => {
    const first = (Array.isArray(params) ? params[0] : params) as { axisValue?: unknown; value?: unknown } | undefined
    const x =
      typeof first?.axisValue === 'number'
        ? first.axisValue
        : Array.isArray(first?.value)
          ? Number(first.value[0])
          : Number.NaN
    const k = Number.isFinite(x) ? nearestIndex(t, x) : -1
    if (k < 0) return ''
    const rows = [tooltipHeader(`t = ${formatNumber(t[k])} s · elapsed ${formatNumber(t0Elapsed + t[k], 6)} s`)]
    rows.push(tooltipRow(colors.dataColor, name, formatNumber(y[k])))
    if (fitted) rows.push(tooltipRow(colors.fitColor, colors.fitName, formatNumber(fitted[k])))
    if (envelope) {
      rows.push(
        tooltipRow(colors.fitColor, ENVELOPE_NAME, `${formatNumber(envelope.lower[k])} … ${formatNumber(envelope.upper[k])}`),
      )
    }
    if (fitted) rows.push(tooltipRow(colors.residualColor, RESIDUAL_NAME, formatNumber(y[k] - fitted[k])))
    const peak = plot.peakAt.get(t[k])
    if (peak) {
      rows.push(tooltipRow(colors.dataColor, peak.kind === 'max' ? 'Peak (maximum)' : 'Peak (minimum)', formatNumber(peak.value)))
    }
    return rows.join('')
  }
}
