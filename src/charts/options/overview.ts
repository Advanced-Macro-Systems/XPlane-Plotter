// Option builders for the Overview tab: the compact stacked "Flight at a glance" charts and the ground track.
// Pure: the caller prepares decimated data (views/overview/overviewModel.ts) and the theme.

import type { EChartsOption } from '../echarts'
import { formatNumber, tooltipHeader, tooltipRow } from '../format'
import { baseOption, mergeOptions, seriesColor, valueAxis, type ChartTheme } from '../theme'

/** Most lines in one chart (the categorical palette has 8 slots; a 9th colour is never made up). */
const MAX_LINES = 8

/**
 * Test points show as faint neutral bands behind the lines, as in Time history: a band in a group's colour would
 * compete with the line of the same colour, and a warm slot would tint the plot like a warning.
 */
const BAND_OPACITY = 0.12

/**
 * Instants the glance crosshair can rest on: this many evenly spaced times from xMin to xMax, the same in every chart
 * of the stack (more than a plot is wide in pixels, so the steps stay below one pixel).
 */
export const HOVER_STEPS = 2001
/** Series id of the invisible series that carries those instants. */
export const HOVER_SERIES_ID = 'glance-hover'

// ------------------------------------------------------------------ "Flight at a glance"

export interface GlanceLine {
  /** Legend and tooltip name (file text: escaped in the tooltip) */
  name: string
  /** Categorical colour slot 0..7 */
  slot: number
  /** [x, y] pairs; a null y breaks the line */
  data: [number, number | null][]
}

export interface GlanceChartInput {
  lines: GlanceLine[]
  /** The y unit (every line in a chart shares it) */
  unit: string
  /** The time span shared by every chart of the stack */
  xMin: number
  xMax: number
  /** Only the bottom chart of the stack shows the time-axis labels and name */
  showXAxis: boolean
  xName: string
  /** Segment boundaries (sim resets, recording gaps), drawn as thin vertical lines */
  markers: { x: number; label: string }[]
  /** Write the markers' labels (the top chart only, so they are not repeated) */
  labelMarkers: boolean
  /** Test points as [from, to] time bands (drawn neutral, whatever their group) */
  bands: { from: number; to: number }[]
  /** Tooltip header for the hovered time */
  formatX: (x: number) => string
}

/** Left/right insets shared by the stacked charts, so their plot areas (and crosshairs) line up exactly. */
export const GLANCE_GRID = { left: 60, right: 20 } as const
/** Room under the bottom chart for the time-axis labels and name. */
const AXIS_BAND = 42
/** Room above the top chart for the marker labels. */
const MARKER_LABEL_BAND = 18
const TOP = 10
const BOTTOM = 8

/** The container height that gives a chart of the stack a plot area of `plotHeight` px (all plots equally tall). */
export function glanceChartHeight(plotHeight: number, opts: { showXAxis: boolean; labelMarkers: boolean }): number {
  return plotHeight + (opts.labelMarkers ? TOP + MARKER_LABEL_BAND : TOP) + (opts.showXAxis ? AXIS_BAND : BOTTOM)
}

export function glanceChartOption(theme: ChartTheme, input: GlanceChartInput): EChartsOption {
  const lines = input.lines.slice(0, MAX_LINES)
  const unitSuffix = input.unit ? ` ${input.unit}` : ''
  const labelled = input.labelMarkers && input.markers.length > 0

  // The charts of the stack are linked (echarts.connect), and an axis tooltip snaps to the nearest sample of the
  // series it involves. Each line is decimated on its own, so snapping to the lines would give every chart its own
  // instant (and a linked chart that cannot place the hovered sample shows no tooltip at all). So the lines stay out
  // of the tooltip, and an invisible series with the same instants in every chart (series 0, so the sample a linked
  // chart is handed is the same one there) is what the crosshair snaps to. The formatter reads each line at that time.
  const series = [
    hoverSeries(input, lines, labelled, theme),
    ...lines.map((line) => {
      const color = seriesColor(theme, line.slot)
      return {
        type: 'line',
        name: line.name,
        data: line.data,
        showSymbol: false,
        symbol: 'none',
        sampling: 'lttb',
        connectNulls: false,
        color,
        lineStyle: { width: 1.5, color },
        emphasis: { disabled: true },
        tooltip: { show: false },
        z: 3,
      }
    }),
  ]

  return mergeOptions(baseOption(theme), {
    grid: {
      ...GLANCE_GRID,
      top: labelled ? TOP + MARKER_LABEL_BAND : TOP,
      bottom: input.showXAxis ? AXIS_BAND : BOTTOM,
    },
    xAxis: valueAxis(theme, input.showXAxis ? input.xName : '', {
      min: input.xMin,
      max: input.xMax,
      scale: false,
      axisLabel: { show: input.showXAxis, showMaxLabel: false },
    }),
    yAxis: valueAxis(theme, '', { splitNumber: 3 }),
    tooltip: {
      trigger: 'axis',
      formatter: (raw: unknown) => {
        const params = (Array.isArray(raw) ? raw : [raw]) as { axisValue?: unknown; value?: unknown }[]
        const first = params[0]
        const x = typeof first?.axisValue === 'number' ? first.axisValue : pairValue(first?.value, 0)
        // ECharts lists only the series whose nearest sample is the closest one, and each line is decimated on its
        // own: read every line at the hovered time from its own data instead.
        let html = tooltipHeader(input.formatX(x))
        for (const line of lines) {
          const y = valueAt(line.data, x)
          html += tooltipRow(
            seriesColor(theme, line.slot),
            line.name,
            y === null ? formatNumber(Number.NaN) : `${formatNumber(y)}${unitSuffix}`,
          )
        }
        return html
      },
    },
    series,
  })
}

/**
 * The invisible series of hover instants (HOVER_STEPS times from xMin to xMax). Its y sits inside the lines' own range,
 * so it never stretches the axis yet always has a point to put a linked chart's tooltip at. It also carries the
 * test-point bands and the segment markers, which belong to the chart rather than to a line.
 */
function hoverSeries(
  input: GlanceChartInput,
  lines: readonly GlanceLine[],
  labelled: boolean,
  theme: ChartTheme,
): Record<string, unknown> {
  let lo = Infinity
  let hi = -Infinity
  for (const line of lines) {
    for (const [, y] of line.data) {
      if (y === null || !Number.isFinite(y)) continue
      if (y < lo) lo = y
      if (y > hi) hi = y
    }
  }
  const y = lo <= hi ? (lo + hi) / 2 : 0
  const span = input.xMax - input.xMin
  const last = HOVER_STEPS - 1
  const data = new Array<[number, number]>(HOVER_STEPS)
  for (let i = 0; i <= last; i += 1) data[i] = [i === last ? input.xMax : input.xMin + (span * i) / last, y]
  return {
    id: HOVER_SERIES_ID,
    type: 'line',
    data,
    showSymbol: false,
    symbol: 'none',
    lineStyle: { width: 0, opacity: 0 },
    silent: true,
    emphasis: { disabled: true },
    z: 1,
    markArea: bandsArea(theme, input.bands),
    markLine: markerLines(theme, input.markers, labelled),
  }
}

/**
 * The y of the sample nearest to `x` in [x, y] pairs sorted by x: null inside a gap (a missing sample on either side
 * of x), outside the data, or when x is not a number.
 */
export function valueAt(data: readonly (readonly [number, number | null])[], x: number): number | null {
  const n = data.length
  if (!n || !Number.isFinite(x)) return null
  // First index whose x is not below the target.
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (data[mid][0] < x) lo = mid + 1
    else hi = mid
  }
  if (lo < n && data[lo][0] === x) {
    // A line break shares its x with the sample after it: take the first real sample at this x.
    for (let i = lo; i < n && data[i][0] === x; i += 1) if (data[i][1] !== null) return data[i][1]
    return null
  }
  if (lo === 0 || lo === n) return null
  const [x0, y0] = data[lo - 1]
  const [x1, y1] = data[lo]
  if (y0 === null || y1 === null) return null
  return x - x0 <= x1 - x ? y0 : y1
}

function bandsArea(theme: ChartTheme, bands: GlanceChartInput['bands']): Record<string, unknown> {
  return {
    silent: true,
    label: { show: false },
    emphasis: { disabled: true },
    data: bands.map((band) => [
      { xAxis: band.from, itemStyle: { color: theme.textMuted, opacity: BAND_OPACITY } },
      { xAxis: band.to },
    ]),
  }
}

function markerLines(theme: ChartTheme, markers: GlanceChartInput['markers'], labelled: boolean): Record<string, unknown> {
  return {
    silent: true,
    symbol: ['none', 'none'],
    lineStyle: { color: theme.textMuted, width: 1, type: 'solid', opacity: 0.7 },
    emphasis: { disabled: true },
    label: {
      show: labelled,
      position: 'end',
      color: theme.textMuted,
      fontFamily: theme.font,
      fontSize: theme.fontSize - 1,
      formatter: (params: { name?: string }) => params.name ?? '',
    },
    data: markers.map((marker) => ({ xAxis: marker.x, name: marker.label })),
  }
}

/** Element `index` of an [x, y] data value, NaN when it is not a number. */
function pairValue(value: unknown, index: number): number {
  const v = Array.isArray(value) ? value[index] : undefined
  return typeof v === 'number' ? v : Number.NaN
}

// ------------------------------------------------------------------ ground track

export interface GroundTrackEnd {
  /** "Start" / "End" */
  label: string
  lon: number
  lat: number
  /** When, as shown in the tooltip ("t = 0.00 s") */
  time: string
}

export interface GroundTrackInput {
  /** [lon, lat] pairs; [null, null] breaks the line */
  path: [number | null, number | null][]
  start: GroundTrackEnd
  end: GroundTrackEnd
  /** Axis ranges (equal ground distance per pixel: see equalAspectRanges) */
  lonRange: [number, number]
  latRange: [number, number]
  /** Axis titles, e.g. "Longitude [deg]" */
  xName: string
  yName: string
  /** Tooltip row labels */
  lonLabel: string
  latLabel: string
  /**
   * Where the track starts again after a sim reset or a recording gap (its first sample there), marked "Restart" with
   * a hollow triangle: a reset can put the aircraft somewhere else, so the line does not simply run on.
   */
  restarts?: GroundTrackEnd[]
}

/**
 * Positions of the path that have no neighbour to draw a line to (a segment of a single sample, such as the moment
 * logged before a sim reload): a line series would not show them at all, so they are drawn as small rings.
 */
export function lonePositions(path: GroundTrackInput['path']): [number, number][] {
  const fix = (p: readonly [number | null, number | null] | undefined) => p !== undefined && p[0] !== null && p[1] !== null
  const lone: [number, number][] = []
  for (let i = 0; i < path.length; i += 1) {
    const [lon, lat] = path[i]
    if (lon !== null && lat !== null && !fix(path[i - 1]) && !fix(path[i + 1])) lone.push([lon, lat])
  }
  return lone
}

/** Plot insets of the ground track; the component needs them to work out the plot's aspect ratio. */
export const TRACK_GRID = { left: 66, right: 28, top: 22, bottom: 48 } as const

export type LabelSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Which side of the start (or end) marker its label goes: away from the track, so the text never sits on the line.
 * The start's label goes behind it (against the direction of travel), the end's ahead of it, judged from a point about
 * 5% of the way along the track. Longitude differences are scaled by cos(latitude) to compare ground distances.
 */
export function endLabelSide(path: GroundTrackInput['path'], which: 'start' | 'end', cosLat = 1): LabelSide {
  const points = path.filter((p): p is [number, number] => p[0] !== null && p[1] !== null)
  const n = points.length
  if (n < 2) return 'right'
  const step = Math.max(1, Math.ceil(n * 0.05))
  const [from, to] = which === 'start' ? [points[Math.min(step, n - 1)], points[0]] : [points[Math.max(0, n - 1 - step)], points[n - 1]]
  const dx = (to[0] - from[0]) * cosLat
  const dy = to[1] - from[1]
  if (dx === 0 && dy === 0) return 'right'
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'top' : 'bottom'
}

/**
 * Keeps an end label off the axes: a marker near the left edge cannot take its label on the left (it would sit on the
 * latitude tick labels), near the right edge not on the right (cut off at the card's edge), near the bottom not below
 * (on the longitude tick labels), nor above at the very top. Such a label goes above or below the marker instead
 * (beside it for top / bottom), which is across the track where it runs along that edge.
 */
export function keepLabelInside(
  side: LabelSide,
  point: { lon: number; lat: number },
  lonRange: readonly [number, number],
  latRange: readonly [number, number],
): LabelSide {
  const fx = (point.lon - lonRange[0]) / (lonRange[1] - lonRange[0])
  const fy = (point.lat - latRange[0]) / (latRange[1] - latRange[0])
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return side
  if ((side === 'left' && fx < 0.16) || (side === 'right' && fx > 0.94)) return fy > 0.85 ? 'bottom' : 'top'
  if ((side === 'bottom' && fy < 0.1) || (side === 'top' && fy > 0.97)) return fx > 0.5 ? 'left' : 'right'
  return side
}

export function groundTrackOption(theme: ChartTheme, input: GroundTrackInput): EChartsOption {
  const color = seriesColor(theme, 0)
  const ends = [input.start, input.end]
  const restarts = input.restarts ?? []
  const cosLat = Math.cos((((input.latRange[0] + input.latRange[1]) / 2) * Math.PI) / 180)
  const sides = ends.map((end, i) =>
    keepLabelInside(endLabelSide(input.path, i === 0 ? 'start' : 'end', cosLat), end, input.lonRange, input.latRange),
  )
  const axisExtra = (range: [number, number]) => ({
    min: range[0],
    max: range[1],
    scale: false,
    splitNumber: 4,
    // The ends of an equal-aspect range are arbitrary numbers: label only the round ticks inside it.
    axisLabel: { showMinLabel: false, showMaxLabel: false },
  })
  return mergeOptions(baseOption(theme), {
    grid: { ...TRACK_GRID },
    xAxis: valueAxis(theme, input.xName, axisExtra(input.lonRange)),
    yAxis: valueAxis(theme, input.yName, axisExtra(input.latRange)),
    tooltip: {
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = raw as { seriesIndex?: number; dataIndex?: number }
        // Series 1 holds the start and end, series 3 the restarts (the line and the lone rings have no tooltip).
        const end = p.seriesIndex === 1 ? ends[p.dataIndex ?? -1] : p.seriesIndex === 3 ? restarts[p.dataIndex ?? -1] : undefined
        if (!end) return ''
        return (
          tooltipHeader(`${end.label} · ${end.time}`) +
          tooltipRow(color, input.latLabel, formatNumber(end.lat, 7)) +
          tooltipRow(color, input.lonLabel, formatNumber(end.lon, 7))
        )
      },
    },
    series: [
      {
        type: 'line',
        name: 'Ground track',
        data: input.path,
        showSymbol: false,
        symbol: 'none',
        connectNulls: false,
        color,
        lineStyle: { width: 2, color },
        emphasis: { disabled: true },
        silent: true,
        tooltip: { show: false },
        z: 2,
      },
      {
        type: 'scatter',
        name: 'Start and end',
        data: ends.map((end, i) => ({
          value: [end.lon, end.lat],
          name: end.label,
          symbol: i === 0 ? 'circle' : 'rect',
          label: { position: sides[i] },
        })),
        symbolSize: 10,
        // A ring in the surface colour keeps the markers legible where they sit on the line.
        itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
        label: {
          show: true,
          formatter: (params: { name?: string }) => params.name ?? '',
          position: 'right',
          distance: 6,
          color: theme.text,
          fontFamily: theme.font,
          fontSize: theme.fontSize,
          fontWeight: 600,
        },
        labelLayout: { hideOverlap: true },
        emphasis: { scale: 1.25 },
        z: 4,
      },
      {
        type: 'scatter',
        name: 'Lone positions',
        data: lonePositions(input.path),
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: theme.surface, borderColor: color, borderWidth: 1.5 },
        silent: true,
        tooltip: { show: false },
        z: 3,
      },
      {
        type: 'scatter',
        name: 'Restarts',
        data: restarts.map((restart) => ({ value: [restart.lon, restart.lat], name: restart.label })),
        symbol: 'triangle',
        symbolSize: 10,
        itemStyle: { color: theme.surface, borderColor: color, borderWidth: 2 },
        label: {
          show: true,
          formatter: (params: { name?: string }) => params.name ?? '',
          position: 'right',
          distance: 6,
          color: theme.textMuted,
          fontFamily: theme.font,
          fontSize: theme.fontSize - 1,
        },
        labelLayout: { hideOverlap: true },
        emphasis: { scale: 1.25 },
        z: 4,
      },
    ],
  })
}
