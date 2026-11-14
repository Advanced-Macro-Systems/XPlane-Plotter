import { describe, expect, it } from 'vitest'
import { readChartTheme } from '../theme'
import { BAND_OPACITY } from './timePanel'
import { STACK_LAYOUT, timeStackLayout, timeStackOption, type TimeStackInput } from './timeStack'

const theme = readChartTheme('paper')

type AnyRecord = Record<string, unknown>
const rec = (value: unknown) => value as AnyRecord
const list = (value: unknown) => value as AnyRecord[]

function input(patch: Partial<TimeStackInput> = {}): TimeStackInput {
  const line = (slot: number, name: string) => ({
    name,
    color: theme.series[slot],
    data: Float64Array.from([0, 1, 5, 2, 10, 3]),
  })
  return {
    theme,
    panels: [
      { yName: '[kt]', yZero: false, series: [line(0, 'KIAS [kt]'), line(1, 'KTAS [kt]')] },
      { yName: 'Altitude [ft]', yZero: true, series: [line(0, 'Altitude [ft]')] },
      { yName: '', yZero: false, series: [] },
    ],
    x: { min: 0, max: 10, clock: false, name: 'Elapsed time [s]', tick: (x) => String(x) },
    boundaries: [
      { x: 4, label: 'gap' },
      { x: 20, label: 'reset' },
    ],
    bands: [
      { x0: -5, x1: 2, color: theme.series[2], name: 'Trim 1' },
      { x0: 6, x1: 6.01, color: theme.series[2], name: 'A long name in a narrow band' },
      { x0: 30, x1: 40, color: theme.series[2], name: 'Outside' },
    ],
    ...patch,
  }
}

describe('timeStackLayout', () => {
  it('stacks plots with a legend row where needed', () => {
    const { tops, height } = timeStackLayout([true, false], 100)
    expect(tops).toEqual([STACK_LAYOUT.top + STACK_LAYOUT.legend, STACK_LAYOUT.top + STACK_LAYOUT.legend + 100 + STACK_LAYOUT.gap])
    expect(height).toBe(tops[1] + 100 + STACK_LAYOUT.bottom)
  })
})

describe('timeStackOption', () => {
  it('makes one grid and axis pair per non-empty panel, sharing the x range', () => {
    const { option, width, height } = timeStackOption(input())
    const o = rec(option)
    expect(width).toBe(STACK_LAYOUT.width)
    expect(height).toBeGreaterThan(300)
    expect(list(o.grid)).toHaveLength(2)
    const xAxes = list(o.xAxis)
    expect(xAxes.map((a) => [a.min, a.max])).toEqual([
      [0, 10],
      [0, 10],
    ])
    // Only the bottom axis has tick labels and the title.
    expect(xAxes.map((a) => rec(a.axisLabel).show)).toEqual([false, true])
    expect(xAxes.map((a) => a.name)).toEqual(['', 'Elapsed time [s]'])
    expect(list(o.yAxis).map((a) => [a.name, a.scale])).toEqual([
      ['[kt]', true],
      ['Altitude [ft]', false],
    ])
    expect(rec(o.tooltip).show).toBe(false)
  })

  it('draws every series in its panel with the on-screen line style', () => {
    const series = list(rec(timeStackOption(input()).option).series)
    expect(series.map((s) => [s.xAxisIndex, s.yAxisIndex])).toEqual([
      [0, 0],
      [0, 0],
      [1, 1],
    ])
    expect(series.every((s) => s.showSymbol === false && s.connectNulls === false)).toBe(true)
    expect(rec(series[1].lineStyle).color).toBe(theme.series[1])
  })

  it('adds a legend above a panel with two or more series only, with names unique per panel', () => {
    const o = rec(timeStackOption(input()).option)
    const legends = list(o.legend)
    expect(legends).toHaveLength(1)
    expect(legends[0].data).toEqual(['KIAS [kt]', 'KTAS [kt]'])
    expect(rec(legends[0].textStyle).color).toBe(theme.text)
    const names = list(o.series).map((s) => s.name)
    expect(names[2]).toBe('Altitude [ft]​')
  })

  it('clips test-point bands to the range and names only the wide ones, in the first panel', () => {
    const series = list(rec(timeStackOption(input()).option).series)
    const firstBands = list(rec(series[0].markArea).data) as unknown as AnyRecord[][]
    expect(firstBands).toHaveLength(2)
    expect(firstBands[0][0]).toMatchObject({ xAxis: 0, itemStyle: { opacity: BAND_OPACITY } })
    expect(firstBands[0][1]).toEqual({ xAxis: 2 })
    expect(rec(firstBands[0][0].label)).toMatchObject({ show: true, formatter: 'Trim 1' })
    expect(rec(firstBands[1][0].label).show).toBe(false)
    const secondPanelBands = list(rec(series[2].markArea).data) as unknown as AnyRecord[][]
    expect(rec(secondPanelBands[0][0].label).show).toBe(false)
    expect(series[1].markArea).toBeUndefined()
  })

  it('marks boundaries inside the range, labelled in the first panel only', () => {
    const series = list(rec(timeStackOption(input()).option).series)
    const first = list(rec(series[0].markLine).data)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ xAxis: 4, label: { show: true, formatter: 'gap', color: theme.textMuted } })
    expect(rec(list(rec(series[2].markLine).data)[0].label).show).toBe(false)
  })
})
