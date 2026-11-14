// The whole Time-history panel stack as ONE publication figure (PNG / SVG export): a grid per panel, stacked, sharing
// the x range; only the bottom axis has tick labels and the axis title; a legend above each panel with two or more
// series; test-point bands and segment boundaries as on screen. Build it with readChartTheme('paper').
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
}

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

/** Plot-area tops and the figure height for panels with / without a legend row. */
export function timeStackLayout(
  legends: readonly boolean[],
  plotHeight: number = STACK_LAYOUT.plot,
): { tops: number[]; height: number } {
  const tops: number[] = []
  let cursor = STACK_LAYOUT.top
  legends.forEach((legend, i) => {
    if (i > 0) cursor += STACK_LAYOUT.gap
    if (legend) cursor += STACK_LAYOUT.legend
    tops.push(cursor)
    cursor += plotHeight
  })
  return { tops, height: Math.round(cursor + STACK_LAYOUT.bottom) }
}

/** Rough label width (px) for deciding whether a band is wide enough to name. */
function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.56 + 8
}

export function timeStackOption(input: TimeStackInput): TimeStackFigure {
  const { theme, x } = input
  const width = input.width ?? STACK_LAYOUT.width
  const plotHeight = input.plotHeight ?? STACK_LAYOUT.plot
  const panels = input.panels.filter((p) => p.series.length > 0)
  const legends = panels.map((p) => Math.min(p.series.length, MAX_PANEL_SERIES) >= 2)
  const { tops, height } = timeStackLayout(legends, plotHeight)
  const last = panels.length - 1
  const plotWidth = width - STACK_LAYOUT.left - STACK_LAYOUT.right
  const pxPerX = x.max > x.min ? plotWidth / (x.max - x.min) : 0
  const small = theme.fontSize - 2

  const bands = input.bands
    .map((b) => ({ ...b, x0: Math.max(b.x0, x.min), x1: Math.min(b.x1, x.max) }))
    .filter((b) => b.x1 > b.x0)
  const boundaries = input.boundaries.filter((b) => b.x > x.min && b.x < x.max)

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
                data: bands.map((b) => {
                  const bandPx = (b.x1 - b.x0) * pxPerX
                  const named = i === 0 && bandPx >= textWidth(b.name, small)
                  return [
                    {
                      xAxis: b.x0,
                      itemStyle: { color: b.color, opacity: BAND_OPACITY },
                      label: {
                        show: named,
                        formatter: b.name,
                        position: 'insideTop',
                        distance: 4,
                        color: theme.textMuted,
                        fontFamily: theme.font,
                        fontSize: small,
                        width: Math.max(0, bandPx - 6),
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
            top: tops[i] - STACK_LAYOUT.legend + 4,
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
