// ECharts option for the X–Y plot, built from the view's model (views/xy/xyModel.ts). The same builder serves the
// screen (theme from the page, inside zoom, tooltips driven by the view's nearest-point hover) and the PNG/SVG export
// (the 'paper' theme, title and legend drawn into the figure, the on-screen zoom window kept).
// OWNER: X–Y view.
//
// Series, bottom to top: sample lines (time order), sample points (large scatter), fit halos and fit curves, the
// test-point means with ±1σ error bars (one custom series per colour entity); with range and endurance on, the guide
// lines lie just above the grid and the construction markers with their labels on top. Colour comes from the categorical slot
// of the entity (Y channel or test-point group), or from a single-hue blue ramp when colouring by time (visualMap
// with a labelled colour bar). Every series is silent: the view finds the nearest point itself and shows the tooltip
// with dispatchAction('showTip'), so hovering never rebuilds this option.

import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemReturn } from 'echarts'
import type { XYConfig } from '../../core/types'
import type { MarkerShape, XYData, XYFit, XYLabels } from '../../views/xy/xyModel'
import type { XYRange } from '../../views/xy/xyRange'
import type { EChartsOption } from '../echarts'
import { baseOption, mergeOptions, seriesColor, valueAxis, type ChartTheme } from '../theme'
import { Extent, shownRange } from './xyAxes'
import { constructionLegend, constructionSeries, hasConstructions } from './xyConstructions'

/** One axis's zoom window, as ECharts' dataZoom takes it: percent (start/end) or axis values (startValue/endValue). */
export interface XYZoomSpec {
  start?: number
  end?: number
  startValue?: number
  endValue?: number
}

/** The zoom window on each axis (absent = the whole extent). */
export interface XYZoomWindow {
  x?: XYZoomSpec
  y?: XYZoomSpec
}

export interface XYChartInput {
  data: XYData
  fits: readonly XYFit[]
  style: XYConfig['style']
  showSamples: boolean
  labels: XYLabels
  /** The colour-by-time axis: its name and how to print a value of it */
  time: { label: string; format: (value: number) => string }
  /** Screen only: a drag draws a zoom box (handled by the view) instead of panning */
  zoomBox?: boolean
  /** Axis ranges to show instead of the full extent (a few absurd samples left off the axes); null = everything */
  extent?: { x: readonly [number, number] | null; y: readonly [number, number] | null } | null
  /** Screen only: axes zoomed in by the user (their edge values are not round, so their end labels are hidden) */
  zoomed?: { x: boolean; y: boolean }
  /** Image export: draw the title and legend into the figure and keep this zoom window */
  figure?: { zoom: XYZoomWindow | null }
  /**
   * Range and endurance (XYConfig.rangeEndurance): each fit's results, drawn as constructions (charts/options/
   * xyConstructions.ts) with the fitted curves dotted. Absent or null = off.
   */
  re?: readonly XYRange[] | null
  /** Both axes start at zero (XYConfig.axesFromZero) */
  axesFromZero?: boolean
  /**
   * The chart's size in pixels (the screen's, rounded; an exported figure's), from which the plotting area the
   * construction labels are placed in is estimated when `plot` is not given
   */
  size?: { width: number; height: number } | null
  /** Screen only: the plotting area as measured on the chart (px), for the construction labels */
  plot?: { width: number; height: number } | null
  /** Screen only: the zoom window shown (as chart.getOption() holds it), so the construction labels stay inside it */
  labelZoom?: XYZoomWindow | null
}

/**
 * Pixels the axes, their labels and names and the grid's margins take from the chart's size: what is left is the
 * plotting area (an estimate; the screen measures it).
 */
const AXES_MARGIN = { width: 110, height: 70 }
/** The grid's top margin without a title or legend, and the room the colour-by-time bar takes on the right. */
const GRID_TOP = 14
const TIME_BAR_WIDTH = 82

/**
 * The part of an axis range a zoom window shows: its values (ECharts fills startValue/endValue in getOption()), else
 * its percents of the range, else the whole range.
 */
export function zoomedRange(range: readonly [number, number], spec: XYZoomSpec | null | undefined): [number, number] {
  const whole: [number, number] = [range[0], range[1]]
  if (!spec) return whole
  const { startValue, endValue, start, end } = spec
  if (Number.isFinite(startValue) && Number.isFinite(endValue)) {
    const lo = Math.max(range[0], Math.min(startValue!, endValue!))
    const hi = Math.min(range[1], Math.max(startValue!, endValue!))
    return hi > lo ? [lo, hi] : whole
  }
  const span = range[1] - range[0]
  const from = Number.isFinite(start) ? start! : 0
  const to = Number.isFinite(end) ? end! : 100
  const lo = range[0] + (span * Math.max(0, Math.min(from, to))) / 100
  const hi = range[0] + (span * Math.min(100, Math.max(from, to))) / 100
  return hi > lo ? [lo, hi] : whole
}

/** Dimensions of the interleaved sample arrays (SAMPLE_STRIDE values per sample). */
const SAMPLE_DIMENSIONS = ['x', 'y', 't', 'row']
/** Components a new option may drop, so setOption must replace rather than merge them. */
export const XY_REPLACE_MERGE = ['series', 'visualMap', 'title', 'legend']
export const XY_ZOOM_X = 'xy-zoom-x'
export const XY_ZOOM_Y = 'xy-zoom-y'

/** Mean markers: 10 px across with a 2 px ring in the surface colour (stroke drawn under the fill). */
export const MEAN_RADIUS = 5
const MEAN_RING = 4
const ERROR_CAP = 4
/** Above this many samples in a series the sample dots shrink from 4 to 3 px. */
const SMALL_DOTS_ABOVE = 5000
/**
 * A series with at least this many samples is drawn in ECharts' large (batched) mode: one path per scatter instead
 * of one element per sample. Decided on the whole series, also when colour by time splits it into bands.
 */
export const LARGE_SCATTER_FROM = 2000

/**
 * Sequential single-hue blue ramps for colour by time (early → late): light/paper, and dark (bright = late). Each
 * end keeps at least 2:1 contrast with its chart surface (dark: #1c5cab is 2.78:1 on --chart-surface #0d1421, and
 * still 2.27:1 on a lighter #22272b), so the earliest samples stay visible.
 */
export const TIME_RAMP_LIGHT = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b']
export const TIME_RAMP_DARK = ['#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb']

export function timeRamp(theme: ChartTheme): string[] {
  return theme.mode === 'dark' ? TIME_RAMP_DARK : TIME_RAMP_LIGHT
}

/** The colour at fraction f (0 = first, 1 = last) of a ramp of hex colours, linearly interpolated. */
export function rampColor(ramp: readonly string[], f: number): string {
  if (!ramp.length) return '#888888'
  const t = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0
  const at = t * (ramp.length - 1)
  const i = Math.min(ramp.length - 2, Math.floor(at))
  if (i < 0) return ramp[0]
  const a = hexRgb(ramp[i])
  const b = hexRgb(ramp[i + 1])
  if (!a || !b) return ramp[Math.round(at)]
  const k = at - i
  const mix = a.map((v, j) => Math.round(v + (b[j] - v) * k))
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function hexRgb(hex: string): number[] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Colour by time draws the samples in this many equal time bands, one large scatter each: ECharts' large mode paints
 * a whole series in one colour (per-point visualMap colours are ignored there).
 */
export const TIME_BANDS = 12

export interface TimeBand {
  /** 0 = earliest */
  index: number
  /** Interleaved samples (SAMPLE_DIMENSIONS per sample) whose time falls in the band */
  data: Float32Array
  count: number
}

/** The samples split into `bands` equal slices of [tMin, tMax] by their time (dimension 2); empty bands left out. */
export function timeBands(data: Float32Array, count: number, tMin: number, tMax: number, bands = TIME_BANDS): TimeBand[] {
  const stride = SAMPLE_DIMENSIONS.length
  const span = tMax - tMin
  const bandOf = (t: number) => (span > 0 ? Math.min(bands - 1, Math.max(0, Math.floor(((t - tMin) / span) * bands))) : 0)
  const counts = new Array<number>(bands).fill(0)
  for (let i = 0; i < count; i += 1) counts[bandOf(data[i * stride + 2])] += 1
  const out: TimeBand[] = counts.map((n, index) => ({ index, data: new Float32Array(n * stride), count: 0 }))
  for (let i = 0; i < count; i += 1) {
    const band = out[bandOf(data[i * stride + 2])]
    band.data.set(data.subarray(i * stride, i * stride + stride), band.count * stride)
    band.count += 1
  }
  return out.filter((b) => b.count > 0)
}

/** ECharts symbol for each marker shape (path symbols are scaled to the symbol size). */
export const SYMBOLS: Record<MarkerShape, string> = {
  circle: 'circle',
  rect: 'rect',
  diamond: 'diamond',
  triangle: 'triangle',
  triangleDown: 'path://M0,0L10,0L5,9Z',
  plus: 'path://M3.5,0H6.5V3.5H10V6.5H6.5V10H3.5V6.5H0V3.5H3.5Z',
  hexagon: 'path://M2.5,0H7.5L10,5L7.5,10H2.5L0,5Z',
  star: 'path://M5,0L6.18,3.45H9.76L6.79,5.59L7.94,9.05L5,6.9L2.06,9.05L3.21,5.59L0.24,3.45H3.82Z',
}

/**
 * Corners of a marker of "radius" r centred on (cx, cy), for shapes drawn as polygons (every shape but the circle,
 * which returns []). Shapes are sized to look as heavy as a circle of radius r.
 */
export function markerPolygon(shape: MarkerShape, cx: number, cy: number, r: number): number[][] {
  const at = (pts: number[][]) => pts.map(([px, py]) => [cx + px * r, cy + py * r])
  switch (shape) {
    case 'circle':
      return []
    case 'rect':
      return at([
        [-0.88, -0.88],
        [0.88, -0.88],
        [0.88, 0.88],
        [-0.88, 0.88],
      ])
    case 'diamond':
      return at([
        [0, -1.2],
        [1.2, 0],
        [0, 1.2],
        [-1.2, 0],
      ])
    case 'triangle':
      return at([
        [0, -1.25],
        [1.15, 0.85],
        [-1.15, 0.85],
      ])
    case 'triangleDown':
      return at([
        [-1.15, -0.85],
        [1.15, -0.85],
        [0, 1.25],
      ])
    case 'plus': {
      const a = 0.38
      const b = 1.1
      return at([
        [-a, -b],
        [a, -b],
        [a, -a],
        [b, -a],
        [b, a],
        [a, a],
        [a, b],
        [-a, b],
        [-a, a],
        [-b, a],
        [-b, -a],
        [-a, -a],
      ])
    }
    case 'hexagon':
      return at(Array.from({ length: 6 }, (_, i) => [Math.cos((Math.PI / 3) * i) * 1.05, Math.sin((Math.PI / 3) * i) * 1.05]))
    case 'star':
      return at(
        Array.from({ length: 10 }, (_, i) => {
          const radius = i % 2 === 0 ? 1.3 : 0.55
          const angle = -Math.PI / 2 + (Math.PI / 5) * i
          return [Math.cos(angle) * radius, Math.sin(angle) * radius]
        }),
      )
  }
}

const FIT_LABEL: Record<XYFit['kind'], string> = {
  linear: 'linear fit',
  poly2: 'quadratic fit',
  poly3: 'cubic fit',
  'power-model': 'power model fit',
  'drag-model': 'drag model fit',
}

/** The full option. Pure: everything comes from the arguments. */
export function xyChartOption(input: XYChartInput, theme: ChartTheme): EChartsOption {
  const { data, fits, style, showSamples, labels, figure } = input
  const timeMode = data.effective.colorBy === 'time'
  const showMeans = data.effective.showMeans
  const series: Record<string, unknown>[] = []
  /** Series coloured by the time visualMap (the means; samples are drawn in time bands) */
  const timed: number[] = []
  /** Samples drawn in time bands (the colour bar then labels them) */
  let timeDrawn = false
  const ramp = timeRamp(theme)
  /** Names shown in an exported figure's legend */
  const legendNames: string[] = []

  // Time colouring needs dots: a line alone cannot carry it, so it is drawn quietly under them.
  const drawPoints = showSamples && (style !== 'lines' || timeMode)
  const drawLines = showSamples && style !== 'points'
  for (const s of data.series) {
    const color = seriesColor(theme, s.slot)
    if (drawLines && s.lineData.length) {
      series.push({
        id: `line:${s.key}`,
        name: s.name,
        type: 'line',
        data: s.lineData,
        dimensions: SAMPLE_DIMENSIONS,
        encode: { x: 0, y: 1 },
        showSymbol: false,
        symbol: 'none',
        sampling: 'lttb',
        connectNulls: false,
        silent: true,
        legendHoverLink: false,
        emphasis: { disabled: true },
        lineStyle: {
          width: 1.5,
          color: timeMode ? theme.axis : color,
          opacity: timeMode || style === 'both' ? 0.6 : 0.95,
        },
        itemStyle: { color },
        z: 2,
      })
      if (!timeMode && style === 'lines') legendNames.push(s.name)
    }
    if (drawPoints && s.count) {
      const scatter = (id: string, points: Float32Array, fill: string) => ({
        id,
        name: s.name,
        type: 'scatter',
        data: points,
        dimensions: SAMPLE_DIMENSIONS,
        encode: { x: 0, y: 1 },
        symbol: SYMBOLS[s.shape],
        symbolSize: s.count > SMALL_DOTS_ABOVE ? 3 : 4,
        // ECharts compares the threshold with each scatter's own count: a large series split into time bands of
        // fewer samples each would otherwise draw one element per sample (slow zoom and pan on a real log).
        large: true,
        largeThreshold: s.count >= LARGE_SCATTER_FROM ? 0 : LARGE_SCATTER_FROM,
        progressive: 20000,
        progressiveThreshold: 60000,
        silent: true,
        legendHoverLink: false,
        emphasis: { disabled: true },
        itemStyle: { color: fill, opacity: showMeans ? 0.4 : timeMode ? 0.8 : 0.55 },
        z: 2,
      })
      if (timeMode) {
        // One scatter per time band in its ramp colour (see TIME_BANDS).
        for (const band of timeBands(s.data, s.count, data.tRange[0], data.tRange[1])) {
          series.push(scatter(`pts:${s.key}#${band.index}`, band.data, rampColor(ramp, (band.index + 0.5) / TIME_BANDS)))
          timeDrawn = true
        }
      } else {
        series.push(scatter(`pts:${s.key}`, s.data, color))
      }
      if (!timeMode || data.ys.length > 1) legendNames.push(s.name)
    }
  }

  const results = input.re ?? null
  const fitColor = (f: XYFit) => (timeMode && data.ys.length === 1 ? theme.text : seriesColor(theme, f.slot))
  for (const f of fits) {
    if ((!f.fit && !f.physical) || f.curve.length < 4) continue
    const color = fitColor(f)
    const points: number[][] = []
    for (let i = 0; i + 1 < f.curve.length; i += 2) points.push([f.curve[i], f.curve[i + 1]])
    const name = `${f.name} – ${FIT_LABEL[f.kind] ?? 'fit'}`
    const common = { type: 'line', data: points, showSymbol: false, symbol: 'none', silent: true, legendHoverLink: false, emphasis: { disabled: true } }
    // With range and endurance on, the fitted curve is dotted, as in the classic figure (its extension past the
    // test points is dashed).
    const style = results ? { width: 2.5, type: [0.1, 4.5], cap: 'round' } : { width: 2 }
    series.push({ ...common, id: `fit-halo:${f.key}`, lineStyle: { width: 6, color: theme.surface, opacity: 0.9 }, z: 3 })
    series.push({ ...common, id: `fit:${f.key}`, name, lineStyle: { ...style, color }, itemStyle: { color }, z: 4 })
    legendNames.push(name)
  }

  // The axis ranges: ECharts' own, the focus on the bulk of the samples (extent), or, with range and endurance or
  // axes from zero, everything drawn, the construction points and the origin, with round ends.
  let xRange = input.extent?.x ?? null
  let yRange = input.extent?.y ?? null
  let xSplits: number | null = null
  let ySplits: number | null = null
  const fromZero = input.axesFromZero === true
  if (fromZero || (results && hasConstructions(results, null))) {
    const drawn = new Extent()
    if (showSamples) for (const s of data.series) drawn.addInterleaved(s.data, SAMPLE_DIMENSIONS.length, s.count)
    if (showMeans) {
      for (const m of data.means) {
        drawn.add(m.x.mean - m.x.std, m.yStats.mean - m.yStats.std)
        drawn.add(m.x.mean + m.x.std, m.yStats.mean + m.yStats.std)
      }
    }
    for (const f of fits) drawn.addInterleaved(f.curve, 2)
    const xs: number[] = []
    const ys: number[] = []
    for (const r of results ?? []) {
      for (const p of [r.re.endurance, r.re.range]) {
        if (!p) continue
        xs.push(p.v)
        ys.push(p.y)
      }
    }
    const shownX = shownRange(input.extent?.x, drawn.x, xs, fromZero)
    const shownY = shownRange(input.extent?.y, drawn.y, ys, fromZero)
    if (shownX) [xRange, xSplits] = [shownX.range, shownX.splits]
    if (shownY) [yRange, ySplits] = [shownY.range, shownY.splits]
  }

  if (showMeans && data.means.length) {
    // Keeps the error bars inside the axes: their ends count toward the axis extents.
    const ends: number[][] = []
    for (const m of data.means) {
      ends.push([m.x.mean - m.x.std, m.yStats.mean - m.yStats.std], [m.x.mean + m.x.std, m.yStats.mean + m.yStats.std])
    }
    series.push({ id: 'mean-extent', type: 'scatter', data: ends, symbolSize: 0, silent: true, itemStyle: { opacity: 0 }, z: 0 })
    for (const s of data.series) {
      const members = data.means.filter((m) => m.seriesKey === s.key)
      if (!members.length) continue
      if (timeMode) timed.push(series.length)
      const name = `${s.name} – mean ± 1σ`
      series.push({
        id: `mean:${s.key}`,
        name,
        type: 'custom',
        renderItem: meanRenderer(theme.surface, s.shape),
        data: members.map((m, i) => [m.x.mean, m.yStats.mean, m.t, m.x.std, m.yStats.std, i]),
        dimensions: ['x', 'y', 't', 'sx', 'sy', 'i'],
        encode: { x: 0, y: 1 },
        itemStyle: { color: seriesColor(theme, s.slot) },
        legendIcon: s.shape === 'circle' || s.shape === 'rect' || s.shape === 'diamond' || s.shape === 'triangle' ? s.shape : SYMBOLS[s.shape],
        clip: true,
        silent: true,
        z: 5,
      })
      legendNames.push(name)
    }
  }

  // The range and endurance constructions, last in the legend; their labels are placed in the plotting area as drawn.
  const reShown = results && results.length && xRange && yRange ? { results, x: xRange, y: yRange } : null
  const reLegend = reShown ? constructionLegend(reShown.results, reShown.x) : []
  const titleText = figure ? labels.title : ''
  const legendCount = legendNames.length + reLegend.length
  const legendShown = !!figure && legendCount >= 2
  const top = (titleText ? 40 : GRID_TOP) + (legendShown ? 28 * Math.ceil(legendCount / 4) : 0)
  const zoom = figure?.zoom ?? null
  const [tMin, tMax] = data.tRange
  // The colour bar labels the banded samples and colours the means (an empty seriesIndex still draws the bar).
  const timeBar = timeMode && (timed.length > 0 || timeDrawn) && Number.isFinite(tMin)
  if (reShown) {
    const shown = figure ? zoom : (input.labelZoom ?? null)
    const view = { x: zoomedRange(reShown.x, shown?.x), y: zoomedRange(reShown.y, shown?.y) }
    // The screen measures its plotting area; an exported figure's is its size less the axes, title, legend and bar.
    const estimate = input.size
      ? {
          width: input.size.width - AXES_MARGIN.width - (timeBar ? TIME_BAR_WIDTH : 0),
          height: input.size.height - AXES_MARGIN.height - (top - GRID_TOP),
        }
      : null
    const size = input.plot ?? estimate
    const constructions = constructionSeries({ ...reShown, data, view, showSamples, fitColor, size }, theme)
    series.push(...constructions.series)
    legendNames.push(...constructions.legend)
  }

  return mergeOptions(baseOption(theme), {
    grid: {
      left: 14,
      right: timeBar ? 22 + TIME_BAR_WIDTH : 22,
      top,
      bottom: 12,
      outerBoundsMode: 'same',
      outerBoundsContain: 'all',
    },
    tooltip: { trigger: 'item', triggerOn: 'none' },
    xAxis: valueAxis(theme, labels.x, {
      nameGap: 12,
      ...axisRange(xRange, xSplits),
      axisLabel: edgeLabels(!!(input.zoomed?.x || zoom?.x)),
    }),
    yAxis: valueAxis(theme, labels.y, {
      nameGap: 14,
      ...axisRange(yRange, ySplits),
      axisLabel: edgeLabels(!!(input.zoomed?.y || zoom?.y)),
    }),
    dataZoom: [
      zoomComponent(XY_ZOOM_X, 'xAxisIndex', !input.zoomBox, zoom?.x),
      zoomComponent(XY_ZOOM_Y, 'yAxisIndex', !input.zoomBox, zoom?.y),
    ],
    ...(timeBar
      ? {
          visualMap: [
            {
              type: 'continuous',
              id: 'xy-time',
              dimension: 2,
              seriesIndex: timed,
              min: tMin,
              max: tMax === tMin ? tMin + 1 : tMax,
              inRange: { color: ramp },
              calculable: false,
              realtime: false,
              hoverLink: false,
              orient: 'vertical',
              right: 14,
              top: 'middle',
              itemWidth: 12,
              itemHeight: 150,
              text: [`${input.time.label}\n${input.time.format(tMax)}`, input.time.format(tMin)],
              textGap: 8,
              textStyle: { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize - 1, lineHeight: 16 },
            },
          ],
        }
      : {}),
    ...(titleText
      ? {
          title: {
            text: titleText,
            left: 'center',
            top: 10,
            textStyle: { color: theme.text, fontFamily: theme.font, fontSize: theme.fontSize + 3, fontWeight: 600 },
          },
        }
      : {}),
    ...(legendShown
      ? {
          legend: {
            data: legendNames,
            top: titleText ? 38 : 10,
            left: 'center',
            width: '90%',
            itemWidth: 16,
            itemHeight: 10,
            itemGap: 16,
            textStyle: { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize - 1 },
            inactiveColor: theme.grid,
          },
        }
      : {}),
    series,
  } as EChartsOption)
}

/**
 * A fixed axis range (samples beyond it are clipped), or null min/max for the automatic extent, with the number of
 * splits to aim for: a range the app rounded spans whole steps, so the ticks fall on its ends; else ECharts' default 5.
 * Always every key: the screen chart merges each new option into the last, so an omitted min/max would keep the
 * previous plot's range.
 */
function axisRange(
  range: readonly [number, number] | null | undefined,
  splits: number | null = null,
): { min: number | null; max: number | null; splitNumber: number } {
  return range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]
    ? { min: range[0], max: range[1], splitNumber: splits ?? 5 }
    : { min: null, max: null, splitNumber: 5 }
}

/**
 * A zoomed axis ends wherever the zoom put it, and ECharts labels those ends with their raw values ("0.48244591663"):
 * hide the two end labels then (null = ECharts' default). Both keys always present, for the merged screen option.
 */
function edgeLabels(zoomed: boolean): { showMinLabel: boolean | null; showMaxLabel: boolean | null } {
  return zoomed ? { showMinLabel: false, showMaxLabel: false } : { showMinLabel: null, showMaxLabel: null }
}

function zoomComponent(
  id: string,
  axis: 'xAxisIndex' | 'yAxisIndex',
  pan: boolean,
  window: XYZoomSpec | undefined,
): Record<string, unknown> {
  return {
    type: 'inside',
    id,
    [axis]: 0,
    filterMode: 'none',
    zoomOnMouseWheel: true,
    moveOnMouseWheel: false,
    moveOnMouseMove: pan,
    preventDefaultMouseMove: true,
    ...(window ?? {}),
  }
}

/** Draws one test-point mean: ±1σ error bars in x and y with caps (on a surface halo), then the marker. */
function meanRenderer(surface: string, shape: MarkerShape) {
  return (_params: unknown, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
    const x = Number(api.value(0))
    const y = Number(api.value(1))
    const sx = Number(api.value(3))
    const sy = Number(api.value(4))
    const [cx, cy] = api.coord([x, y])
    const color = String(api.visual('color'))
    const bars: number[][] = []
    if (sx > 0) {
      const x0 = api.coord([x - sx, y])[0]
      const x1 = api.coord([x + sx, y])[0]
      bars.push([x0, cy, x1, cy], [x0, cy - ERROR_CAP, x0, cy + ERROR_CAP], [x1, cy - ERROR_CAP, x1, cy + ERROR_CAP])
    }
    if (sy > 0) {
      const y0 = api.coord([x, y - sy])[1]
      const y1 = api.coord([x, y + sy])[1]
      bars.push([cx, y0, cx, y1], [cx - ERROR_CAP, y0, cx + ERROR_CAP, y0], [cx - ERROR_CAP, y1, cx + ERROR_CAP, y1])
    }
    const line = (b: number[], stroke: string, lineWidth: number) => ({
      type: 'line' as const,
      shape: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] },
      style: { stroke, lineWidth, lineCap: 'round' as const },
    })
    const markerStyle = { fill: color, stroke: surface, lineWidth: MEAN_RING, strokeFirst: true }
    const marker =
      shape === 'circle'
        ? { type: 'circle' as const, shape: { cx, cy, r: MEAN_RADIUS }, style: markerStyle }
        : { type: 'polygon' as const, shape: { points: markerPolygon(shape, cx, cy, MEAN_RADIUS) }, style: markerStyle }
    return {
      type: 'group',
      children: [...bars.map((b) => line(b, surface, 4)), ...bars.map((b) => line(b, color, 1.5)), marker],
    }
  }
}
