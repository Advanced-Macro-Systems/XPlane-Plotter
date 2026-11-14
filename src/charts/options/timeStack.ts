// The whole Time-history panel stack as ONE publication figure (PNG / SVG export): a grid per panel, stacked, sharing
// the x range; only the bottom axis has tick labels and the axis title; a legend above each panel with two or more
// series; test-point bands and segment boundaries as on screen, the test points' names in a lane above the first
// panel (staggered in rows where names would touch, so overlapping or adjacent points never print over each other).
// Build it with readChartTheme('paper').
// OWNER: time-view agent. Pure (no DOM): unit-tested in timeStack.test.ts.

import type { EChartsOption } from '../echarts'
import { baseOption, mergeOptions, valueAxis, type ChartTheme } from '../theme'
import { BAND_OPACITY, MAX_PANEL_SERIES, timeLineSeries, type TimeSeriesInput } from './timePanel'

export interface StackPanelInput {
  series: readonly TimeSeriesInput[]
  /** y-axis title, e.g. "KIAS [kt]" or "[kt]" */
  yName: string
  yZero: boolean
}

export interface StackBandInput {
  x0: number
  x1: number
  color: string
  name: string
}

export interface TimeStackInput {
  theme: ChartTheme
  panels: readonly StackPanelInput[]
  x: {
    /** The figure's x range (chart units): the zoom window */
    min: number
    max: number
    clock: boolean
    name: string
    tick: (x: number) => string
  }
  boundaries: readonly { x: number; label: string }[]
  bands: readonly StackBandInput[]
  /** Figure width in CSS px (default 960) */
  width?: number
  /** Height of each plot area in px (default 150) */
  plotHeight?: number
  /**
   * Measures text as the browser draws it (the image export passes charts/textWidth canvasTextWidth): each test-point
   * name then gets its real width, so a band only a little wider than its name keeps it. Without it (tests, no DOM),
   * or when it gives no number, names get a generous estimate (labelWidth).
   */
  measureText?: TextMeasure
}

/** Width (px) of `text` drawn in `font`, a CSS font such as "11px 'Geist Variable', sans-serif" (NaN: unknown). */
export type TextMeasure = (text: string, font: string) => number

export interface TimeStackFigure {
  option: EChartsOption
  width: number
  height: number
}

export const STACK_LAYOUT = {
  width: 960,
  left: 84,
  right: 28,
  top: 14,
  /** Room for a legend row above a panel */
  legend: 24,
  plot: 150,
  /** Between one panel's plot and the next panel's legend / plot */
  gap: 16,
  /** Tick labels and the axis title under the bottom panel */
  bottom: 56,
} as const

/**
 * The lane of test-point names above the first plot: px per row of names, the most rows, the space between the
 * nearest row and the plot, and the least space between two names in a row.
 */
export const LABEL_LANE = { row: 16, rows: 3, pad: 4, gap: 6 } as const

/**
 * Plot-area tops and the figure height for panels with / without a legend row, and `lane` px of test-point names
 * between the first panel's legend row and its plot.
 */
export function timeStackLayout(
  legends: readonly boolean[],
  plotHeight: number = STACK_LAYOUT.plot,
  lane = 0,
): { tops: number[]; height: number } {
  const tops: number[] = []
  let cursor = STACK_LAYOUT.top
  legends.forEach((legend, i) => {
    if (i > 0) cursor += STACK_LAYOUT.gap
    if (legend) cursor += STACK_LAYOUT.legend
    if (i === 0) cursor += lane
    tops.push(cursor)
    cursor += plotHeight
  })
  return { tops, height: Math.round(cursor + STACK_LAYOUT.bottom) }
}

/**
 * Width (px) a name is given: its text as drawn in `fontSize` px `font` when `measure` can tell (the browser export),
 * else a generous estimate (Geist averages about 0.5 em a character, capitals and W/M more), plus a little room either
 * side. Names are truncated to it, so a name never reaches further than the layout below assumes.
 */
export function labelWidth(text: string, fontSize: number, font?: string, measure?: TextMeasure): number {
  const measured = measure && font ? measure(text, `${fontSize}px ${font}`) : Number.NaN
  return (Number.isFinite(measured) && measured >= 0 ? measured : text.length * fontSize * 0.56) + 8
}

/** A test point's band and name in the figure, px from the plot's left edge. */
export interface BandLabelInput {
  left: number
  right: number
  /** The name's width (labelWidth) */
  width: number
}

/**
 * Lays out the test-point names above the first plot. Each name is centred on its band and written only when it fits
 * inside the band; it goes in the lowest row (0 = nearest the plot) where it clears the names already there by `gap`
 * px, so names of overlapping or adjacent points are staggered instead of printed over each other. A name that fits
 * in none of `maxRows` rows is left out; its band stays. Returns each band's row, or null for no name.
 */
export function bandLabelRows(
  bands: readonly BandLabelInput[],
  maxRows: number = LABEL_LANE.rows,
  gap: number = LABEL_LANE.gap,
): (number | null)[] {
  const out: (number | null)[] = bands.map(() => null)
  /** The right edge of the last name in each row */
  const rowEnds: number[] = []
  const names = bands
    .map((b, i) => ({ i, left: (b.left + b.right - b.width) / 2, width: b.width, span: b.right - b.left }))
    .filter((n) => n.width <= n.span)
    // Left to right (first-fit by left edge needs the fewest rows); a wider band first where two names start together.
    .sort((a, b) => a.left - b.left || b.span - a.span || a.i - b.i)
  for (const name of names) {
    let row = rowEnds.findIndex((end) => name.left >= end + gap)
    if (row < 0 && rowEnds.length < maxRows) row = rowEnds.push(-Infinity) - 1
    if (row < 0) continue
    rowEnds[row] = name.left + name.width
    out[name.i] = row
  }
  return out
}

/** Height (px) of the name lane for these rows: nothing when no name is written. */
export function labelLaneHeight(rows: readonly (number | null)[]): number {
  const used = rows.reduce<number>((n, row) => (row === null ? n : Math.max(n, row + 1)), 0)
  return used > 0 ? used * LABEL_LANE.row + LABEL_LANE.pad : 0
}

export function timeStackOption(input: TimeStackInput): TimeStackFigure {
  const { theme, x } = input
  const width = input.width ?? STACK_LAYOUT.width
  const plotHeight = input.plotHeight ?? STACK_LAYOUT.plot
  const panels = input.panels.filter((p) => p.series.length > 0)
  const legends = panels.map((p) => Math.min(p.series.length, MAX_PANEL_SERIES) >= 2)
  const plotWidth = width - STACK_LAYOUT.left - STACK_LAYOUT.right
  const pxPerX = x.max > x.min ? plotWidth / (x.max - x.min) : 0
  const small = theme.fontSize - 2

  const bands = input.bands
    .map((b) => ({ ...b, x0: Math.max(b.x0, x.min), x1: Math.min(b.x1, x.max) }))
    .filter((b) => b.x1 > b.x0)
  const boundaries = input.boundaries.filter((b) => b.x > x.min && b.x < x.max)
  // The names above the first plot, staggered in rows where they would touch.
  const labels = bands.map((b) => ({
    left: (b.x0 - x.min) * pxPerX,
    right: (b.x1 - x.min) * pxPerX,
    width: labelWidth(b.name, small, theme.font, input.measureText),
  }))
  const labelRows = bandLabelRows(labels)
  const lane = labelLaneHeight(labelRows)
  const { tops, height } = timeStackLayout(legends, plotHeight, lane)
  const last = panels.length - 1

  const grids = panels.map((_, i) => ({
    left: STACK_LAYOUT.left,
    right: STACK_LAYOUT.right,
    top: tops[i],
    height: plotHeight,
    outerBoundsMode: 'none',
  }))

  const xAxes = panels.map((_, i) =>
    valueAxis(theme, i === last ? x.name : '', {
      gridIndex: i,
      type: x.clock ? 'time' : 'value',
      min: x.min,
      max: x.max,
      nameGap: 8,
      axisLabel: { show: i === last, formatter: (value: number) => x.tick(value) },
    }),
  )

  const yAxes = panels.map((p, i) =>
    valueAxis(theme, p.yName, {
      gridIndex: i,
      scale: !p.yZero,
      nameGap: 12,
      axisLabel: { width: STACK_LAYOUT.left - 30, overflow: 'truncate' },
    }),
  )

  // Legend entries are matched to series by name across the whole chart: make each panel's names unique with
  // invisible zero-width spaces, so the same channel in two panels keeps its own colour in each legend.
  const seriesName = (name: string, panel: number) => `${name}${'​'.repeat(panel)}`

  const series = panels.flatMap((p, i) =>
    p.series.slice(0, MAX_PANEL_SERIES).map((s, k) => {
      const markers =
        k === 0
          ? {
              markArea: {
                silent: true,
                animation: false,
                emphasis: { disabled: true },
                data: bands.map((b, k) => {
                  const row = i === 0 ? labelRows[k] : null
                  return [
                    {
                      xAxis: b.x0,
                      itemStyle: { color: b.color, opacity: BAND_OPACITY },
                      label:
                        row === null
                          ? { show: false }
                          : {
                              show: true,
                              formatter: b.name,
                              // Above the plot, centred on the band, in its row of the name lane.
                              position: 'top',
                              distance: LABEL_LANE.pad + row * LABEL_LANE.row,
                              color: theme.textMuted,
                              fontFamily: theme.font,
                              fontSize: small,
                              width: labels[k].width,
                              overflow: 'truncate',
                            },
                    },
                    { xAxis: b.x1 },
                  ]
                }),
              },
              markLine: {
                silent: true,
                animation: false,
                symbol: ['none', 'none'],
                emphasis: { disabled: true },
                lineStyle: { color: theme.axis, width: 1, type: 'solid' },
                data: boundaries.map((b) => ({
                  xAxis: b.x,
                  label: {
                    show: i === 0,
                    formatter: b.label,
                    position: 'insideEndTop',
                    color: theme.textMuted,
                    fontFamily: theme.font,
                    fontSize: small,
                  },
                })),
              },
            }
          : undefined
      return timeLineSeries({ ...s, name: seriesName(s.name, i) }, `p${i}s${k}`, {
        xAxisIndex: i,
        yAxisIndex: i,
        ...markers,
      })
    }),
  )

  const legend = panels.flatMap((p, i) =>
    legends[i]
      ? [
          {
            show: true,
            // Above the first panel's name lane.
            top: tops[i] - (i === 0 ? lane : 0) - STACK_LAYOUT.legend + 4,
            right: STACK_LAYOUT.right,
            orient: 'horizontal',
            icon: 'rect',
            itemWidth: 14,
            itemHeight: 3,
            itemGap: 16,
            selectedMode: false,
            textStyle: { color: theme.text, fontFamily: theme.font, fontSize: theme.fontSize - 1 },
            data: p.series.slice(0, MAX_PANEL_SERIES).map((s) => seriesName(s.name, i)),
          },
        ]
      : [],
  )

  const option = mergeOptions(baseOption(theme), {
    useUTC: x.clock,
    // The figure is static: no tooltip or pointer.
    tooltip: { show: false },
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    legend,
    series,
  }) as EChartsOption
  return { option, width, height }
}
