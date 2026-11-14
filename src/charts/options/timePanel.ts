// ECharts option for one Time-history panel on screen. Every panel is its own chart; the view keeps their zoom,
// crosshair and tooltips in step (by axis value: see views/time/timeController.ts), and all use the same fixed grid
// padding so their x pixels line up.
// OWNER: time-view agent. Pure (no DOM): unit-tested in timePanel.test.ts.
//
// - Series data are interleaved typed arrays [x0, y0, x1, y1, ...] (ECharts reads them without copying them into
//   option objects); a NaN y breaks the line (connectNulls: false) at sim resets and recording gaps.
// - Large logs: animation off, no symbols, LTTB sampling, dataZoom in 'filter' mode so sampling sees only the window.
// - Zoom state is never part of the option: the view applies it with dispatchAction, so rebuilding the option (new
//   channel, theme switch) keeps the zoom (merge with replaceMerge: ['series']).
// - Both dataZoom components exist in every panel (the slider only shows in the bottom one) with fixed ids, so the
//   same zoom action works on every panel.

import type { EChartsOption } from '../echarts'
import { baseOption, mergeOptions, valueAxis, type ChartTheme } from '../theme'

/** Plot-area padding in px. Left/right are the same in every panel so the stacked x axes line up exactly. */
export const TIME_GRID = {
  left: 60,
  // Room for half a clock label ("14:30:00") at the right end of the axis
  right: 28,
  top: 10,
  bottom: 10,
  /** Strip above the first panel's plot for the test-point labels and segment tags */
  lane: 24,
  /** Room below the bottom panel's plot: tick labels, the axis name and the zoom slider */
  axis: 74,
} as const

export const MAX_PANEL_SERIES = 8
/** Fill opacity of a test-point band */
export const BAND_OPACITY = 0.12
export const DATAZOOM_INSIDE_ID = 'tv-inside'
export const DATAZOOM_SLIDER_ID = 'tv-slider'

export interface PanelGeometry {
  left: number
  right: number
  top: number
  bottom: number
}

/** The plot area of a panel (px from the chart container's edges). */
export function panelGeometry(opts: { lane: boolean; bottom: boolean }): PanelGeometry {
  return {
    left: TIME_GRID.left,
    right: TIME_GRID.right,
    top: TIME_GRID.top + (opts.lane ? TIME_GRID.lane : 0),
    bottom: opts.bottom ? TIME_GRID.axis : TIME_GRID.bottom,
  }
}

export interface TimeSeriesInput {
  /** Series name (aria); tooltips are built by the caller */
  name: string
  color: string
  /** Interleaved [x0, y0, x1, y1, ...] in chart units */
  data: Float64Array
}

export interface TimeXInput {
  min: number
  max: number
  /** Draw on an ECharts time axis: x in milliseconds, shown as UTC clock time */
  clock: boolean
  /** Axis title, e.g. "Elapsed time [s]" (bottom panel only) */
  name: string
  /** Narrowest zoom window (chart units) */
  minSpan: number
  /** Tick label for a chart x ("120", "09:15:15") */
  tick: (x: number) => string
  /** Pointer and slider label for a chart x ("123.45 s") */
  label: (x: number) => string
}

export interface TimeBand {
  x0: number
  x1: number
  color: string
}

export interface TimePanelInput {
  theme: ChartTheme
  series: readonly TimeSeriesInput[]
  x: TimeXInput
  /** The first panel keeps a strip above its plot for labels (drawn by the page) */
  lane: boolean
  /** The bottom panel shows the x tick labels, the axis name and the zoom slider */
  bottom: boolean
  /** Force the y axis to include zero */
  yZero: boolean
  /** Segment boundaries, chart x */
  boundaries: readonly number[]
  /** Test-point bands, chart x */
  bands: readonly TimeBand[]
  /** Tooltip HTML for a hovered chart x (escape file text: tooltipHeader / tooltipRow) */
  tooltip: (x: number) => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The hovered x of an axis-trigger tooltip's params (an array of series params), or null. */
export function tooltipAxisValue(params: unknown): number | null {
  const first = Array.isArray(params) ? params[0] : params
  if (!isRecord(first)) return null
  const value = first.axisValue
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Tooltip box next to the crosshair at the top of the plot, flipped to the left near the right edge. */
export function tooltipPosition(
  point: readonly number[],
  size: { contentSize: readonly number[]; viewSize: readonly number[] },
  top: number,
): [number, number] {
  const [px] = point
  const width = size.contentSize[0] ?? 0
  const viewWidth = size.viewSize[0] ?? 0
  const gap = 14
  const right = px + gap
  const x = right + width > viewWidth - 4 ? px - gap - width : right
  return [Math.max(4, x), top + 4]
}

export function boundaryMarkLine(theme: ChartTheme, xs: readonly number[]): Record<string, unknown> {
  return {
    silent: true,
    symbol: ['none', 'none'],
    animation: false,
    label: { show: false },
    emphasis: { disabled: true },
    lineStyle: { color: theme.axis, width: 1, type: 'solid', opacity: 1 },
    data: xs.map((x) => ({ xAxis: x })),
  }
}

export function bandMarkArea(bands: readonly TimeBand[]): Record<string, unknown> {
  return {
    silent: true,
    animation: false,
    label: { show: false },
    emphasis: { disabled: true },
    data: bands.map((b) => [{ xAxis: b.x0, itemStyle: { color: b.color, opacity: BAND_OPACITY } }, { xAxis: b.x1 }]),
  }
}

/** A line series for one channel (no symbols, LTTB, gaps kept). */
export function timeLineSeries(s: TimeSeriesInput, id: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    type: 'line',
    name: s.name,
    // ECharts reads a typed array as flat [x, y] pairs once it is told the dimensions (it cannot infer them).
    dimensions: ['x', 'y'],
    encode: { x: 0, y: 1 },
    data: s.data,
    showSymbol: false,
    symbol: 'none',
    sampling: 'lttb',
    connectNulls: false,
    clip: true,
    animation: false,
    lineStyle: { width: 1.5, color: s.color, join: 'round' },
    itemStyle: { color: s.color },
    emphasis: { disabled: true },
    z: 3,
    ...extra,
  }
}

function sliderZoom(theme: ChartTheme, g: PanelGeometry, x: TimeXInput, show: boolean): Record<string, unknown> {
  return {
    id: DATAZOOM_SLIDER_ID,
    type: 'slider',
    show,
    xAxisIndex: 0,
    filterMode: 'filter',
    minValueSpan: x.minSpan,
    left: g.left,
    right: g.right,
    bottom: 6,
    height: 16,
    brushSelect: false,
    borderColor: theme.grid,
    borderRadius: 4,
    backgroundColor: 'transparent',
    fillerColor: theme.zoomWindow,
    dataBackground: {
      lineStyle: { color: theme.axis, width: 1, opacity: 0.9 },
      areaStyle: { color: theme.grid, opacity: 0.6 },
    },
    selectedDataBackground: {
      lineStyle: { color: theme.crosshair, width: 1, opacity: 0.9 },
      areaStyle: { color: theme.zoomWindow, opacity: 1 },
    },
    handleStyle: { color: theme.surface, borderColor: theme.axis, borderWidth: 1 },
    moveHandleSize: 4,
    moveHandleStyle: { color: theme.axis, opacity: 0.8 },
    emphasis: {
      handleStyle: { borderColor: theme.crosshair },
      moveHandleStyle: { color: theme.crosshair, opacity: 1 },
    },
    textStyle: { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize - 1 },
    labelFormatter: (value: number) => x.label(value),
  }
}

export function timePanelOption(input: TimePanelInput): EChartsOption {
  const { theme, x } = input
  const g = panelGeometry(input)
  const series = input.series.slice(0, MAX_PANEL_SERIES)
  const markers = { markLine: boundaryMarkLine(theme, input.boundaries), markArea: bandMarkArea(input.bands) }

  return mergeOptions(baseOption(theme), {
    // Clock axes hold hour-of-day as milliseconds since midnight: format them in UTC so no time zone is added.
    useUTC: x.clock,
    grid: { left: g.left, right: g.right, top: g.top, bottom: g.bottom, outerBoundsMode: 'none' },
    xAxis: valueAxis(theme, input.bottom ? x.name : '', {
      type: x.clock ? 'time' : 'value',
      min: x.min,
      max: x.max,
      nameGap: 6,
      // The ends of the range are rarely round numbers ("695.999"): label the nice ticks only.
      axisLabel: {
        show: input.bottom,
        showMinLabel: false,
        showMaxLabel: false,
        formatter: (value: number) => x.tick(value),
      },
      axisPointer: {
        // The crosshair sits at the pointer, not on a sampled point: every panel shows the same instant.
        snap: false,
        label: { show: input.bottom, formatter: (params: { value: unknown }) => x.label(Number(params.value)) },
      },
    }),
    yAxis: valueAxis(theme, '', {
      scale: !input.yZero,
      axisLabel: { width: g.left - 14, overflow: 'truncate' },
    }),
    tooltip: {
      trigger: 'axis',
      axisPointer: { snap: false },
      formatter: (params: unknown) => {
        const value = tooltipAxisValue(params)
        return value === null ? '' : input.tooltip(value)
      },
      position: (
        point: number[],
        _params: unknown,
        _dom: unknown,
        _rect: unknown,
        size: { contentSize: number[]; viewSize: number[] },
      ) => tooltipPosition(point, size, g.top),
    },
    dataZoom: [
      {
        id: DATAZOOM_INSIDE_ID,
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'filter',
        minValueSpan: x.minSpan,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        preventDefaultMouseMove: true,
      },
      sliderZoom(theme, g, x, input.bottom),
    ],
    series: series.map((s, i) => timeLineSeries(s, `s${i}`, i === 0 ? markers : undefined)),
  }) as EChartsOption
}
