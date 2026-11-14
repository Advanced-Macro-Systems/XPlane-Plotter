// Tests of the Dynamic modes chart option (src/charts/options/modes.ts, owned by the modes view).

import { describe, expect, it } from 'vitest'
import {
  TIME_AXIS_TITLE,
  buildModesOption,
  leftMargin,
  likelyTickLabels,
  modesPlotData,
  nearestIndex,
  niceBounds,
  type ModesPlotInput,
} from '../../charts/options/modes'
import { readChartTheme } from '../../charts/theme'

const theme = readChartTheme('light')

function input(overrides: Partial<ModesPlotInput> = {}): ModesPlotInput {
  const n = 200
  const t = Float64Array.from({ length: n }, (_, i) => i / 10)
  const y = t.map((x) => 250 + 5 * Math.exp(-0.05 * x) * Math.cos(x))
  const fitted = t.map((x) => 250 + 5 * Math.exp(-0.05 * x) * Math.cos(x) + 0.01)
  const upper = t.map((x) => 250 + 5 * Math.exp(-0.05 * x))
  const lower = t.map((x) => 250 - 5 * Math.exp(-0.05 * x))
  return {
    t,
    y,
    fitted,
    fitOk: true,
    envelope: { upper, lower },
    peaks: [
      { t: t[63], value: y[63], kind: 'max' },
      { t: t[31], value: y[31], kind: 'min' },
    ],
    firstOrder: null,
    name: '<b>KTAS</b>',
    yTitle: 'KTAS [kt]',
    t0Elapsed: 1000,
    ...overrides,
  }
}

type AnyRecord = Record<string, unknown>
const seriesOf = (option: unknown) => (option as { series: AnyRecord[] }).series
const byId = (option: unknown, id: string) => seriesOf(option).find((s) => s.id === id)

describe('modesPlotData', () => {
  it('pairs time with values and turns NaN into gaps', () => {
    const data = modesPlotData(input({ y: Float64Array.of(1, Number.NaN, 3), t: Float64Array.of(0, 1, 2), fitted: null, envelope: null, peaks: [] }))
    expect(data.data).toEqual([
      [0, 1],
      [1, null],
      [2, 3],
    ])
    expect(data.fit).toBeNull()
    expect(data.residual).toBeNull()
    expect(data.duration).toBe(2)
  })

  it('computes residuals as data minus fit', () => {
    const data = modesPlotData(input())
    expect(data.residual?.[0][1]).toBeCloseTo(-0.01, 9)
  })
})

describe('buildModesOption', () => {
  it('draws data (1.5 px), fit (2 px, second slot), envelope, peaks and residuals', () => {
    const option = buildModesOption(modesPlotData(input()), theme, { residuals: true })
    expect(seriesOf(option).map((s) => s.id)).toEqual(['data', 'env-upper', 'env-lower', 'fit', 'peaks', 'residual'])
    const data = byId(option, 'data') as AnyRecord
    expect(data.lineStyle).toMatchObject({ width: 1.5, color: theme.series[0] })
    expect(data).toMatchObject({ showSymbol: false, sampling: 'lttb' })
    expect(byId(option, 'fit')?.lineStyle).toMatchObject({ width: 2, color: theme.series[1], type: 'solid' })
    const peaks = byId(option, 'peaks') as AnyRecord
    expect(peaks.symbolSize).toBeGreaterThanOrEqual(8)
    expect((peaks.data as { symbolRotate: number }[]).map((d) => d.symbolRotate)).toEqual([0, 180])
    expect((option as { animation: boolean }).animation).toBe(false)
  })

  it('stacks the residuals in a second grid on the same time axis', () => {
    const option = buildModesOption(modesPlotData(input()), theme, { residuals: true }) as AnyRecord
    const grids = option.grid as AnyRecord[]
    expect(grids).toHaveLength(2)
    expect(grids[0].left).toBe(grids[1].left)
    const xAxes = option.xAxis as AnyRecord[]
    expect(xAxes[1].name).toBe(TIME_AXIS_TITLE)
    expect((xAxes[0].axisLabel as AnyRecord).show).toBe(false)
    // Linked crosshair, and the base crosshair look kept by mergeOptions.
    expect(option.axisPointer).toMatchObject({ link: [{ xAxisIndex: 'all' }], lineStyle: { color: theme.crosshair } })
  })

  it('uses one grid without residuals', () => {
    const option = buildModesOption(modesPlotData(input()), theme, { residuals: false }) as AnyRecord
    expect(option.grid as AnyRecord[]).toHaveLength(1)
    expect((option.xAxis as AnyRecord[])[0].name).toBe(TIME_AXIS_TITLE)
    expect(byId(option, 'residual')).toBeUndefined()
  })

  it('draws a rejected fit dashed and says so', () => {
    const option = buildModesOption(modesPlotData(input({ fitOk: false })), theme, { residuals: false })
    const fit = byId(option, 'fit') as AnyRecord
    expect(fit.name).toBe('Fit (rejected)')
    expect((fit.lineStyle as AnyRecord).type).toBe('dashed')
  })

  it('marks τ and the final value of a first-order fit', () => {
    const t = Float64Array.from({ length: 60 }, (_, i) => i / 20)
    const y = t.map((x) => 1 + 20 * Math.exp(-x / 0.7))
    const option = buildModesOption(
      modesPlotData(input({ t, y, fitted: y, envelope: null, peaks: [], firstOrder: { tau: 0.7, t0: 0, offset: 1 } })),
      theme,
      { residuals: false },
    )
    expect(byId(option, 'env-upper')).toBeUndefined()
    const marks = (byId(option, 'fit')?.markLine as { data: AnyRecord[] }).data
    expect(marks).toHaveLength(2)
    expect(marks[1].xAxis).toBeCloseTo(0.7, 9)
    expect(((marks[1].label as AnyRecord).formatter as string).startsWith('τ = 0.7')).toBe(true)
  })

  it('lists every series at the hovered time, escaping names', () => {
    const plot = modesPlotData(input())
    const option = buildModesOption(plot, theme, { residuals: true }) as { tooltip: { formatter: (p: unknown) => string; trigger: string } }
    expect(option.tooltip.trigger).toBe('axis')
    const html = option.tooltip.formatter([{ axisValue: 6.3 }])
    expect(html).toContain('&lt;b&gt;KTAS&lt;/b&gt;')
    expect(html).not.toContain('<b>KTAS')
    expect(html).toContain('Fit')
    expect(html).toContain('Envelope')
    expect(html).toContain('Residual')
    expect(html).toContain('Peak (maximum)')
    expect(html).toContain('elapsed 1006.3 s')
    // Tooltip text keeps the base look (theme colours) from baseOption.
    expect((option.tooltip as unknown as AnyRecord).backgroundColor).toBeDefined()
  })

  it('adds a title and a themed legend for figure exports', () => {
    const paper = readChartTheme('paper')
    const option = buildModesOption(modesPlotData(input()), paper, {
      residuals: true,
      figure: { title: 'Phugoid', subtitle: 'T = 58 s' },
    }) as AnyRecord
    expect((option.title as AnyRecord).text).toBe('Phugoid')
    const legend = option.legend as AnyRecord
    expect((legend.textStyle as AnyRecord).color).toBe(paper.textMuted)
    const items = legend.data as { name: string; icon?: string }[]
    expect(items.map((item) => item.name)).toEqual(['<b>KTAS</b>', 'Fit', 'Envelope', 'Peaks', 'Residual'])
    // Line keys are strokes (no circle); the peaks keep their triangle.
    expect(items[0].icon).toMatch(/^path:\/\//)
    expect(items[3].icon).toBeUndefined()
    expect(option.backgroundColor).toBe('#ffffff')
  })
})

describe('layout helpers', () => {
  it('predicts nice tick labels', () => {
    expect(likelyTickLabels(242, 258)).toEqual(['240', '243', '246', '249', '252', '255', '258'])
    expect(likelyTickLabels(-0.3, 0.3).every((label) => label.length <= 5)).toBe(true)
    expect(likelyTickLabels(Number.NaN, 1)).toEqual(['0'])
  })

  it('leaves room for wider labels', () => {
    expect(leftMargin([[-0.0025, 0.0025]], 12)).toBeGreaterThan(leftMargin([[0, 10]], 12))
  })

  it('gives nice bounds without binary noise (ECharts asserts its ticks lie inside them)', () => {
    // 2502 × 0.1 is 250.20000000000002 in floating point.
    expect(niceBounds([250.24815, 250.61819])).toEqual([250.2, 250.7])
    expect(niceBounds([0.0012, 0.0049])).toEqual([0.001, 0.005])
    expect(niceBounds([-3.3, 7.9])).toEqual([-4, 8])
    expect(niceBounds([5, 5])).toEqual([4, 6])
  })

  it('finds the nearest sample', () => {
    const t = Float64Array.of(0, 1, 2, 3)
    expect(nearestIndex(t, 1.4)).toBe(1)
    expect(nearestIndex(t, 1.6)).toBe(2)
    expect(nearestIndex(t, -5)).toBe(0)
    expect(nearestIndex(t, 50)).toBe(3)
    expect(nearestIndex(new Float64Array(0), 1)).toBe(-1)
  })
})
