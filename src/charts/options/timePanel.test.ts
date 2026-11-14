import { describe, expect, it } from 'vitest'
import { readChartTheme } from '../theme'
import {
  BAND_OPACITY,
  DATAZOOM_INSIDE_ID,
  DATAZOOM_SLIDER_ID,
  TIME_GRID,
  panelGeometry,
  timePanelOption,
  tooltipAxisValue,
  tooltipPosition,
  type TimePanelInput,
} from './timePanel'

const theme = readChartTheme('light')

type AnyRecord = Record<string, unknown>
const rec = (value: unknown) => value as AnyRecord
const list = (value: unknown) => value as AnyRecord[]

function input(patch: Partial<TimePanelInput> = {}): TimePanelInput {
  return {
    theme,
    series: [
      { name: 'KIAS [kt]', color: theme.series[0], data: Float64Array.from([0, 250, 1, 251, 1.5, NaN, 2, 252]) },
      { name: 'KTAS [kt]', color: theme.series[1], data: Float64Array.from([0, 300, 1, 301]) },
    ],
    x: {
      min: 0,
      max: 2,
      clock: false,
      name: 'Elapsed time [s]',
      minSpan: 0.2,
      tick: (x) => `${x}`,
      label: (x) => `${x} s`,
    },
    lane: false,
    bottom: false,
    yZero: false,
    boundaries: [1.5],
    bands: [{ x0: 0.2, x1: 0.6, color: theme.series[3] }],
    tooltip: (x) => `<b>t = ${x}</b>`,
    ...patch,
  }
}

describe('timePanelOption', () => {
  it('uses the same left/right padding in every panel so stacked x axes line up', () => {
    const top = rec(timePanelOption(input({ lane: true })).grid)
    const middle = rec(timePanelOption(input()).grid)
    const bottom = rec(timePanelOption(input({ bottom: true })).grid)
    for (const grid of [top, middle, bottom]) {
      expect(grid.left).toBe(TIME_GRID.left)
      expect(grid.right).toBe(TIME_GRID.right)
    }
    expect(top.top).toBe(TIME_GRID.top + TIME_GRID.lane)
    expect(middle.top).toBe(TIME_GRID.top)
    expect(bottom.bottom).toBe(TIME_GRID.axis)
    expect(panelGeometry({ lane: false, bottom: false })).toEqual({
      left: TIME_GRID.left,
      right: TIME_GRID.right,
      top: TIME_GRID.top,
      bottom: TIME_GRID.bottom,
    })
  })

  it('draws thin lines without symbols, LTTB-sampled, broken at gaps, no animation', () => {
    const series = list(timePanelOption(input()).series)
    expect(series).toHaveLength(2)
    for (const s of series) {
      expect(s).toMatchObject({ type: 'line', showSymbol: false, sampling: 'lttb', connectNulls: false, animation: false })
      expect(rec(s.lineStyle).width).toBe(1.5)
    }
    expect(rec(series[1].lineStyle).color).toBe(theme.series[1])
    expect(series[0].data).toBeInstanceOf(Float64Array)
  })

  it('caps a panel at 8 series', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, color: theme.series[i % 8], data: new Float64Array(0) }))
    expect(list(timePanelOption(input({ series: many })).series)).toHaveLength(8)
  })

  it('marks segment boundaries and test-point bands once per panel', () => {
    const [first, second] = list(timePanelOption(input()).series)
    const markLine = rec(first.markLine)
    expect(list(markLine.data)).toEqual([{ xAxis: 1.5 }])
    expect(rec(markLine.lineStyle)).toMatchObject({ type: 'solid', width: 1 })
    const band = list(rec(first.markArea).data)[0] as unknown as AnyRecord[]
    expect(band[0]).toMatchObject({ xAxis: 0.2, itemStyle: { color: theme.series[3], opacity: BAND_OPACITY } })
    expect(band[1]).toEqual({ xAxis: 0.6 })
    expect(second.markLine).toBeUndefined()
    expect(second.markArea).toBeUndefined()
  })

  it('shows x labels, the axis title and the slider only on the bottom panel', () => {
    const middle = rec(timePanelOption(input()))
    const bottom = rec(timePanelOption(input({ bottom: true })))
    expect(rec(rec(middle.xAxis).axisLabel).show).toBe(false)
    expect(rec(middle.xAxis).name).toBe('')
    expect(rec(rec(bottom.xAxis).axisLabel).show).toBe(true)
    expect(rec(bottom.xAxis).name).toBe('Elapsed time [s]')
    const zooms = (option: AnyRecord) => list(option.dataZoom)
    expect(zooms(middle).map((z) => z.id)).toEqual([DATAZOOM_INSIDE_ID, DATAZOOM_SLIDER_ID])
    expect(zooms(middle)[1].show).toBe(false)
    expect(zooms(bottom)[1].show).toBe(true)
    expect(zooms(bottom)[0]).toMatchObject({ type: 'inside', filterMode: 'filter', minValueSpan: 0.2 })
    // The slider's text follows the theme (ECharts' default grey vanishes in dark mode).
    expect(rec(zooms(bottom)[1].textStyle).color).toBe(theme.textMuted)
  })

  it('fixes the x range, never stores the zoom, and draws clocks on a UTC time axis', () => {
    const option = rec(timePanelOption(input()))
    expect(rec(option.xAxis)).toMatchObject({ type: 'value', min: 0, max: 2 })
    for (const zoom of list(option.dataZoom)) {
      expect(zoom.start).toBeUndefined()
      expect(zoom.startValue).toBeUndefined()
    }
    const clock = rec(timePanelOption(input({ x: { ...input().x, clock: true } })))
    expect(rec(clock.xAxis).type).toBe('time')
    expect(clock.useUTC).toBe(true)
  })

  it('lets the y axis include zero on request', () => {
    expect(rec(rec(timePanelOption(input()).yAxis)).scale).toBe(true)
    expect(rec(rec(timePanelOption(input({ yZero: true })).yAxis)).scale).toBe(false)
  })

  it('builds the tooltip from the hovered x with an axis trigger', () => {
    const tooltip = rec(timePanelOption(input()).tooltip)
    expect(tooltip.trigger).toBe('axis')
    // The look from baseOption survives the merge.
    expect(tooltip.borderWidth).toBe(0)
    const formatter = tooltip.formatter as (params: unknown) => string
    expect(formatter([{ axisValue: 1.25 }])).toBe('<b>t = 1.25</b>')
    expect(formatter([])).toBe('')
  })
})

describe('tooltip helpers', () => {
  it('reads the hovered axis value', () => {
    expect(tooltipAxisValue([{ axisValue: 12 }])).toBe(12)
    expect(tooltipAxisValue({ axisValue: 3 })).toBe(3)
    expect(tooltipAxisValue([{ axisValue: 'x' }])).toBeNull()
    expect(tooltipAxisValue(null)).toBeNull()
  })

  it('puts the tooltip beside the crosshair, flipped near the right edge', () => {
    expect(tooltipPosition([100, 50], { contentSize: [120, 60], viewSize: [800, 200] }, 10)).toEqual([114, 14])
    expect(tooltipPosition([750, 50], { contentSize: [120, 60], viewSize: [800, 200] }, 10)).toEqual([616, 14])
    expect(tooltipPosition([20, 50], { contentSize: [400, 60], viewSize: [300, 200] }, 10)).toEqual([4, 14])
  })
})
