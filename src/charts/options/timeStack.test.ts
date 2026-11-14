import { describe, expect, it } from 'vitest'
import { readChartTheme } from '../theme'
import { BAND_OPACITY } from './timePanel'
import {
  LABEL_LANE,
  STACK_LAYOUT,
  bandLabelRows,
  labelLaneHeight,
  labelWidth,
  timeStackLayout,
  timeStackOption,
  type BandLabelInput,
  type TimeStackInput,
} from './timeStack'

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

  it('makes room for the name lane above the first plot only', () => {
    const plain = timeStackLayout([true, true], 100)
    const laned = timeStackLayout([true, true], 100, 36)
    expect(laned.tops).toEqual(plain.tops.map((top) => top + 36))
    expect(laned.height).toBe(plain.height + 36)
  })
})

describe('labelWidth', () => {
  it('gives a name its drawn width when the text can be measured, else a generous estimate', () => {
    const fonts: string[] = []
    const measure = (text: string, font: string) => {
      fonts.push(font)
      return text.length * 5
    }
    expect(labelWidth('Dutch roll', 11, theme.font, measure)).toBe(58)
    expect(fonts).toEqual([`11px ${theme.font}`])
    const estimate = labelWidth('Dutch roll', 11)
    expect(estimate).toBeCloseTo(10 * 11 * 0.56 + 8)
    expect(labelWidth('Dutch roll', 11, theme.font, () => Number.NaN)).toBe(estimate)
  })
})

/** A band from `left` to `right` px with a name `width` px wide. */
const band = (left: number, right: number, width = 40): BandLabelInput => ({ left, right, width })

/** The px extents of the names written in each row. */
function extents(bands: readonly BandLabelInput[], rows: readonly (number | null)[]): Map<number, [number, number][]> {
  const byRow = new Map<number, [number, number][]>()
  rows.forEach((row, i) => {
    if (row === null) return
    const centre = (bands[i].left + bands[i].right) / 2
    byRow.set(row, [...(byRow.get(row) ?? []), [centre - bands[i].width / 2, centre + bands[i].width / 2]])
  })
  return byRow
}

describe('bandLabelRows', () => {
  it('keeps names that clear each other in one row', () => {
    expect(bandLabelRows([band(0, 100), band(200, 300), band(400, 500)])).toEqual([0, 0, 0])
  })

  it('staggers the names of overlapping and nested test points into rows', () => {
    // B overlaps A but their names (centred on the bands) clear each other; C sits inside A, under A's name.
    expect(bandLabelRows([band(0, 200), band(100, 300), band(80, 130)])).toEqual([0, 0, 1])
    // Three points whose names would all print in the same place.
    expect(bandLabelRows([band(0, 200), band(20, 220), band(80, 130)])).toEqual([0, 2, 1])
    // Adjacent points whose names, centred on their bands, would touch: the second goes up a row.
    expect(bandLabelRows([band(0, 44, 42), band(44, 88, 42), band(88, 132, 42)])).toEqual([0, 1, 0])
  })

  it('writes no name wider than its band, and leaves out names that fit in no row (the bands stay)', () => {
    expect(bandLabelRows([band(0, 30, 40)])).toEqual([null])
    const stacked = [band(0, 100), band(5, 105), band(10, 110), band(15, 115)]
    expect(bandLabelRows(stacked)).toEqual([0, 1, 2, null])
    expect(bandLabelRows(stacked, 2)).toEqual([0, 1, null, null])
  })

  it('never lets two names in a row overlap, and does not depend on the order of the points', () => {
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let trial = 0; trial < 200; trial += 1) {
      const bands = Array.from({ length: 12 }, () => {
        const left = random() * 800
        const right = left + 20 + random() * 200
        return band(left, right, 30 + random() * 80)
      })
      const rows = bandLabelRows(bands)
      expect(rows.every((row) => row === null || (row >= 0 && row < LABEL_LANE.rows))).toBe(true)
      for (const names of extents(bands, rows).values()) {
        names.sort((a, b) => a[0] - b[0])
        for (let k = 1; k < names.length; k += 1) expect(names[k][0]).toBeGreaterThanOrEqual(names[k - 1][1] + LABEL_LANE.gap)
      }
      // Same names in the same rows whatever order the points come in.
      const reversed = bandLabelRows([...bands].reverse())
      expect([...reversed].reverse()).toEqual(rows)
    }
  })

  it('gives the lane its rows’ height, or none without names', () => {
    expect(labelLaneHeight([null, null])).toBe(0)
    expect(labelLaneHeight([0, null, 1])).toBe(2 * LABEL_LANE.row + LABEL_LANE.pad)
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

  it('writes the names of overlapping test points in rows of a lane above the first plot, the legend above it', () => {
    const plain = timeStackOption(input({ bands: [] }))
    const names = timeStackOption(
      input({
        bands: [
          { x0: 1, x1: 6, color: theme.textMuted, name: 'Trim 1' },
          { x0: 1.5, x1: 6.5, color: theme.textMuted, name: 'Trim 1 again' },
          { x0: 6.5, x1: 9.5, color: theme.textMuted, name: 'Step' },
        ],
      }),
    )
    const labelsOf = (figure: typeof names) =>
      (list(rec(list(rec(figure.option).series)[0].markArea).data) as unknown as AnyRecord[][]).map((pair) => rec(pair[0].label))
    const labels = labelsOf(names)
    expect(labels.map((l) => [l.show, l.position, l.distance])).toEqual([
      [true, 'top', LABEL_LANE.pad],
      [true, 'top', LABEL_LANE.pad + LABEL_LANE.row],
      [true, 'top', LABEL_LANE.pad],
    ])
    // Each name is truncated to the width the layout gave it, so it never reaches into a neighbour.
    expect(labels[1]).toMatchObject({ width: labelWidth('Trim 1 again', theme.fontSize - 2), overflow: 'truncate' })
    // Two rows of names: the first plot moves down by the lane, and its legend stays above the lane.
    const lane = 2 * LABEL_LANE.row + LABEL_LANE.pad
    const tops = (figure: typeof names) => list(rec(figure.option).grid).map((g) => Number(g.top))
    expect(tops(names)).toEqual(tops(plain).map((top) => top + lane))
    expect(names.height).toBe(plain.height + lane)
    const legendTop = (figure: typeof names) => Number(list(rec(figure.option).legend)[0].top)
    expect(legendTop(names)).toBe(legendTop(plain))
    // No name written, no lane.
    const narrow = timeStackOption(input({ bands: [{ x0: 1, x1: 1.01, color: theme.textMuted, name: 'Narrow' }] }))
    expect(narrow.height).toBe(plain.height)
  })

  it('keeps the name of a band wider than the name as measured, which the estimate alone would leave out', () => {
    // A 64 px band; "Dutch roll" at the label size is about 49 px drawn, but about 70 px by the estimate.
    const plotWidth = STACK_LAYOUT.width - STACK_LAYOUT.left - STACK_LAYOUT.right
    const bands = [{ x0: 2, x1: 2 + (64 / plotWidth) * 10, color: theme.textMuted, name: 'Dutch roll' }]
    const label = (figure: ReturnType<typeof timeStackOption>) =>
      rec((list(rec(list(rec(figure.option).series)[0].markArea).data) as unknown as AnyRecord[][])[0][0].label)
    expect(label(timeStackOption(input({ bands }))).show).toBe(false)
    const measured = label(timeStackOption(input({ bands, measureText: () => 49 })))
    expect(measured).toMatchObject({ show: true, formatter: 'Dutch roll', width: 57, overflow: 'truncate' })
  })

  it('marks boundaries inside the range, labelled in the first panel only', () => {
    const series = list(rec(timeStackOption(input()).option).series)
    const first = list(rec(series[0].markLine).data)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ xAxis: 4, label: { show: true, formatter: 'gap', color: theme.textMuted } })
    expect(rec(list(rec(series[2].markLine).data)[0].label).show).toBe(false)
  })
})
