import { describe, expect, it } from 'vitest'
import { MINUS } from '../format'
import { readChartTheme } from '../theme'
import {
  endLabelSide,
  GLANCE_GRID,
  glanceChartOption,
  groundTrackOption,
  HOVER_SERIES_ID,
  HOVER_STEPS,
  keepLabelInside,
  lonePositions,
  TRACK_GRID,
  valueAt,
  type GlanceChartInput,
} from './overview'

const theme = readChartTheme('paper')

type AnyRecord = Record<string, unknown>
const rec = (value: unknown) => value as AnyRecord
const list = (value: unknown) => value as AnyRecord[]

function input(patch: Partial<GlanceChartInput> = {}): GlanceChartInput {
  return {
    lines: [
      { name: 'KIAS', slot: 0, data: [[0, 200], [1, null], [2, 202]] },
      { name: '<b>KTAS</b>', slot: 1, data: [[0, 250], [1, 251], [2, -252]] },
    ],
    unit: 'kt',
    xMin: 0,
    xMax: 2,
    showXAxis: true,
    xName: 'Elapsed time [s]',
    markers: [{ x: 1, label: 'reset' }],
    labelMarkers: true,
    bands: [
      { from: 0.2, to: 0.8 },
      { from: 1.2, to: 1.8 },
    ],
    formatX: (x) => `t = ${x} s`,
    ...patch,
  }
}

/** The drawn lines of a glance chart (every series but the invisible hover instants). */
const glanceLines = (option: unknown) => list(rec(option).series).filter((s) => s.id !== HOVER_SERIES_ID)
const hoverOf = (option: unknown) => list(rec(option).series).find((s) => s.id === HOVER_SERIES_ID) as AnyRecord

describe('glanceChartOption', () => {
  it('draws one thin line per channel in its slot colour, without symbols, over a fixed time span', () => {
    const option = rec(glanceChartOption(theme, input()))
    const series = glanceLines(option)
    expect(series.map((s) => s.type)).toEqual(['line', 'line'])
    expect(series.map((s) => s.color)).toEqual([theme.series[0], theme.series[1]])
    expect(series.every((s) => s.showSymbol === false && s.sampling === 'lttb')).toBe(true)
    expect(rec(series[0].lineStyle).width).toBe(1.5)
    expect(rec(option.xAxis)).toMatchObject({ min: 0, max: 2, name: 'Elapsed time [s]' })
    expect(option.animation).toBe(false)
  })

  it('keeps the plot insets identical across the stack, so crosshairs line up', () => {
    const top = rec(rec(glanceChartOption(theme, input({ showXAxis: false }))).grid)
    const bottom = rec(rec(glanceChartOption(theme, input({ labelMarkers: false }))).grid)
    expect([top.left, top.right]).toEqual([GLANCE_GRID.left, GLANCE_GRID.right])
    expect([bottom.left, bottom.right]).toEqual([GLANCE_GRID.left, GLANCE_GRID.right])
    expect(Number(bottom.bottom)).toBeGreaterThan(Number(top.bottom))
    expect(Number(top.top)).toBeGreaterThan(Number(bottom.top))
    // No time labels above the bottom chart.
    expect(rec(rec(rec(glanceChartOption(theme, input({ showXAxis: false }))).xAxis).axisLabel).show).toBe(false)
  })

  it('bands the test points in a neutral colour (never a group colour) and marks segment boundaries', () => {
    const option = glanceChartOption(theme, input())
    // Carried once per chart, by the invisible hover series, not by a line.
    const area = rec(hoverOf(option).markArea)
    const bands = area.data as AnyRecord[][]
    expect(bands).toHaveLength(2)
    expect(bands[0][0]).toMatchObject({ xAxis: 0.2, itemStyle: { color: theme.textMuted } })
    expect(bands[0][1]).toEqual({ xAxis: 0.8 })
    expect(area.silent).toBe(true)
    const markLine = rec(hoverOf(option).markLine)
    expect(markLine.data).toEqual([{ xAxis: 1, name: 'reset' }])
    expect(rec(markLine.label).show).toBe(true)
    expect(rec(markLine.label).color).toBe(theme.textMuted)
    expect(glanceLines(option).every((s) => s.markArea === undefined && s.markLine === undefined)).toBe(true)
    const unlabelled = hoverOf(glanceChartOption(theme, input({ labelMarkers: false })))
    expect(rec(rec(unlabelled.markLine).label).show).toBe(false)
  })

  it('gives every chart of the stack the same hover instants, so the linked tooltips show one time', () => {
    const top = glanceChartOption(theme, input({ xMin: 10, xMax: 610 }))
    const other = glanceChartOption(
      theme,
      input({
        xMin: 10,
        xMax: 610,
        lines: [{ name: 'pitch', slot: 0, data: [[10, -3], [300.7, 12], [610, 5]] }],
        unit: 'deg',
      }),
    )
    const series = list(rec(top).series)
    // Series 0 in every chart: a linked chart is handed the hovered sample by series and data index.
    expect(series[0].id).toBe(HOVER_SERIES_ID)
    expect(list(rec(other).series)[0].id).toBe(HOVER_SERIES_ID)
    const xs = (option: unknown) => (hoverOf(option).data as [number, number][]).map(([x]) => x)
    expect(xs(top)).toHaveLength(HOVER_STEPS)
    expect(xs(top)).toEqual(xs(other))
    expect(xs(top)[0]).toBe(10)
    expect(xs(top).at(-1)).toBe(610)
    // Less than a pixel apart on any screen.
    expect(xs(top)[1] - xs(top)[0]).toBeCloseTo(600 / (HOVER_STEPS - 1), 12)
    // The lines stay out of the axis tooltip, so ECharts snaps to the shared instants only.
    expect(glanceLines(top).every((s) => rec(s.tooltip).show === false)).toBe(true)
    // Invisible, never hit, and inside the lines' own y range (it must not stretch the axis).
    const hover = hoverOf(other)
    expect(hover).toMatchObject({ showSymbol: false, silent: true, lineStyle: { width: 0, opacity: 0 } })
    expect(new Set((hover.data as [number, number][]).map(([, y]) => y))).toEqual(new Set([4.5]))
    // A chart with no number at all still gets drawable instants.
    const empty = hoverOf(glanceChartOption(theme, input({ lines: [{ name: 'x', slot: 0, data: [[0, null]] }] })))
    expect((empty.data as [number, number][]).every(([x, y]) => Number.isFinite(x) && y === 0)).toBe(true)
  })

  it('lists every line in the tooltip, value first, names escaped, real minus signs', () => {
    const tooltip = rec(rec(glanceChartOption(theme, input())).tooltip)
    expect(tooltip.trigger).toBe('axis')
    // The shared tooltip styling from baseOption survives the merge.
    expect(tooltip.borderWidth).toBe(0)
    const formatter = tooltip.formatter as (params: unknown) => string
    const html = formatter([
      { seriesIndex: 0, value: [2, 202] },
      { seriesIndex: 1, value: [2, -252] },
    ])
    expect(html).toContain('t = 2 s')
    expect(html).toContain('202 kt')
    expect(html).toContain(`${MINUS}252 kt`)
    expect(html).toContain('&lt;b&gt;KTAS&lt;/b&gt;')
    expect(html).not.toContain('<b>KTAS')
    expect(html.indexOf('202 kt')).toBeLessThan(html.indexOf('KIAS'))
    expect(formatter([{ seriesIndex: 0, value: [1, null] }])).toContain('—')
  })

  it('reads every line at the hovered time, even when ECharts hands over only one of them', () => {
    const lines: GlanceChartInput['lines'] = [
      { name: 'pitch', slot: 0, data: [[0, 1], [0.5, 2], [1, 3]] },
      // Decimated on its own: samples at other times than the first line's.
      { name: 'roll', slot: 1, data: [[0, -1], [0.4, -2], [0.9, -3]] },
    ]
    const formatter = rec(rec(glanceChartOption(theme, input({ lines, unit: 'deg' }))).tooltip).formatter as (
      params: unknown,
    ) => string
    const html = formatter([{ seriesIndex: 0, axisValue: 0.5, value: [0.5, 2] }])
    expect(html).toContain('t = 0.5 s')
    expect(html).toContain('2 deg')
    expect(html).toContain(`${MINUS}2 deg`)
    expect(html).toContain('roll')
  })

  it('never shows more than 8 lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, slot: i % 8, data: [] as [number, number | null][] }))
    expect(glanceLines(glanceChartOption(theme, input({ lines })))).toHaveLength(8)
  })
})

describe('valueAt', () => {
  const data: [number, number | null][] = [
    [0, 10],
    [1, 11],
    [2, 12],
    // A sim reset: the break point shares its x with the first sample after it.
    [3, null],
    [3, 20],
    [4, 21],
  ]

  it('takes the nearest sample', () => {
    expect(valueAt(data, 0)).toBe(10)
    expect(valueAt(data, 0.4)).toBe(10)
    expect(valueAt(data, 0.6)).toBe(11)
    expect(valueAt(data, 4)).toBe(21)
  })

  it('takes the real sample where a line break shares its time', () => {
    expect(valueAt(data, 3)).toBe(20)
    expect(valueAt(data, 3.4)).toBe(20)
  })

  it('gives null inside a gap, outside the data and for a bad x', () => {
    expect(valueAt(data, 2.5)).toBeNull()
    expect(valueAt(data, -1)).toBeNull()
    expect(valueAt(data, 5)).toBeNull()
    expect(valueAt(data, Number.NaN)).toBeNull()
    expect(valueAt([], 1)).toBeNull()
    expect(valueAt([[1, null]], 1)).toBeNull()
  })
})

describe('groundTrackOption', () => {
  const option = rec(
    groundTrackOption(theme, {
      path: [
        [-2.6, 51.4],
        [null, null],
        [-2.5, 51.5],
      ],
      start: { label: 'Start', lon: -2.6, lat: 51.4, time: 't = 0.00 s' },
      end: { label: 'End', lon: -2.5, lat: 51.5, time: 't = 120.0 s' },
      lonRange: [-2.7, -2.4],
      latRange: [51.35, 51.55],
      xName: 'Longitude [deg]',
      yName: 'Latitude [deg]',
      lonLabel: 'Longitude',
      latLabel: '<i>Latitude</i>',
    }),
  )

  it('draws the path and its two ends inside the given ranges', () => {
    expect(rec(option.xAxis)).toMatchObject({ min: -2.7, max: -2.4, name: 'Longitude [deg]', scale: false })
    expect(rec(option.yAxis)).toMatchObject({ min: 51.35, max: 51.55, name: 'Latitude [deg]', scale: false })
    expect(rec(option.grid)).toMatchObject(TRACK_GRID)
    const [line, ends] = list(option.series)
    expect(line).toMatchObject({ type: 'line', showSymbol: false, connectNulls: false, color: theme.series[0] })
    expect(ends.type).toBe('scatter')
    expect(list(ends.data).map((d) => [d.name, d.symbol, d.value])).toEqual([
      ['Start', 'circle', [-2.6, 51.4]],
      ['End', 'rect', [-2.5, 51.5]],
    ])
    expect(Number(ends.symbolSize)).toBeGreaterThanOrEqual(8)
    expect(rec(ends.itemStyle).borderColor).toBe(theme.surface)
  })

  it('writes each end label away from the track', () => {
    const [, ends] = list(option.series)
    // The track runs north-east (mostly north once longitude is scaled by cos 51.45°): start label below, end above.
    expect(list(ends.data).map((d) => rec(d.label).position)).toEqual(['bottom', 'top'])
  })

  it('explains the ends in an escaped tooltip and nothing else', () => {
    const formatter = rec(option.tooltip).formatter as (params: unknown) => string
    const html = formatter({ seriesIndex: 1, dataIndex: 1 })
    expect(html).toContain('End · t = 120.0 s')
    expect(html).toContain('51.5')
    expect(html).toContain(`${MINUS}2.5`)
    expect(html).toContain('&lt;i&gt;Latitude&lt;/i&gt;')
    expect(formatter({ seriesIndex: 0, dataIndex: 1 })).toBe('')
  })

  it('rings the positions a line cannot reach (one-sample segments), with no tooltip', () => {
    const lone = list(option.series)[2]
    expect(lone).toMatchObject({ type: 'scatter', silent: true, tooltip: { show: false } })
    // Both positions of this path sit alone between breaks.
    expect(lone.data).toEqual([
      [-2.6, 51.4],
      [-2.5, 51.5],
    ])
    expect(rec(lone.itemStyle)).toMatchObject({ color: theme.surface, borderColor: theme.series[0] })
  })

  it('marks where the track starts again after a reset, with its time in the tooltip', () => {
    const withRestart = rec(
      groundTrackOption(theme, {
        path: [
          [-2.6, 51.4],
          [-2.59, 51.41],
          [null, null],
          [-1.2, 52.0],
          [-1.1, 52.1],
        ],
        start: { label: 'Start', lon: -2.6, lat: 51.4, time: 't = 0.00 s' },
        end: { label: 'End', lon: -1.1, lat: 52.1, time: 't = 900.0 s' },
        restarts: [{ label: 'Restart', lon: -1.2, lat: 52.0, time: 't = 60.0 s' }],
        lonRange: [-2.8, -0.9],
        latRange: [51.3, 52.2],
        xName: 'Longitude [deg]',
        yName: 'Latitude [deg]',
        lonLabel: 'Longitude',
        latLabel: 'Latitude',
      }),
    )
    const series = list(withRestart.series)
    expect(series[2].data).toEqual([])
    expect(series[3]).toMatchObject({ type: 'scatter', symbol: 'triangle', name: 'Restarts' })
    expect(list(series[3].data)).toEqual([{ value: [-1.2, 52.0], name: 'Restart' }])
    const formatter = rec(withRestart.tooltip).formatter as (params: unknown) => string
    expect(formatter({ seriesIndex: 3, dataIndex: 0 })).toContain('Restart · t = 60.0 s')
    expect(formatter({ seriesIndex: 2, dataIndex: 0 })).toBe('')
  })
})

describe('lonePositions', () => {
  it('finds the positions with no neighbour on either side', () => {
    expect(
      lonePositions([
        [0, 0],
        [null, null],
        [1, 1],
        [2, 2],
        [null, null],
        [3, 3],
      ]),
    ).toEqual([
      [0, 0],
      [3, 3],
    ])
    expect(lonePositions([[5, 5]])).toEqual([[5, 5]])
    expect(lonePositions([])).toEqual([])
  })
})

describe('endLabelSide', () => {
  const west: [number | null, number | null][] = [
    [0, 0],
    [-1, 0.1],
    [null, null],
    [-2, 0.2],
    [-3, 0.2],
  ]

  it('puts the start label behind the start and the end label ahead of the end', () => {
    expect(endLabelSide(west, 'start')).toBe('right')
    expect(endLabelSide(west, 'end')).toBe('left')
    const north: [number | null, number | null][] = [
      [0, 0],
      [0.1, 1],
      [0.1, 2],
    ]
    expect(endLabelSide(north, 'start')).toBe('bottom')
    expect(endLabelSide(north, 'end')).toBe('top')
  })

  it('compares ground distances: east–west degrees shrink with latitude', () => {
    const diagonal: [number | null, number | null][] = [
      [0, 0],
      [1, 0.8],
    ]
    expect(endLabelSide(diagonal, 'end', 1)).toBe('right')
    // At 60° a degree of longitude is half as long: the track runs mostly north.
    expect(endLabelSide(diagonal, 'end', 0.5)).toBe('top')
  })

  it('falls back to the right without a direction', () => {
    expect(endLabelSide([[1, 1]], 'start')).toBe('right')
    expect(endLabelSide([[1, 1], [1, 1]], 'end')).toBe('right')
    expect(endLabelSide([], 'end')).toBe('right')
  })
})

describe('keepLabelInside', () => {
  const lon: [number, number] = [0, 10]
  const lat: [number, number] = [50, 60]

  it('keeps a side that has room', () => {
    expect(keepLabelInside('left', { lon: 5, lat: 55 }, lon, lat)).toBe('left')
    expect(keepLabelInside('right', { lon: 5, lat: 55 }, lon, lat)).toBe('right')
    expect(keepLabelInside('bottom', { lon: 5, lat: 55 }, lon, lat)).toBe('bottom')
    expect(keepLabelInside('top', { lon: 5, lat: 55 }, lon, lat)).toBe('top')
  })

  it('moves a label that would sit on the tick labels or run off the card', () => {
    // Near the left edge (the latitude labels): above the marker, or below it near the top.
    expect(keepLabelInside('left', { lon: 0.5, lat: 53 }, lon, lat)).toBe('top')
    expect(keepLabelInside('left', { lon: 0.5, lat: 59 }, lon, lat)).toBe('bottom')
    // Right at the right edge.
    expect(keepLabelInside('right', { lon: 9.8, lat: 51 }, lon, lat)).toBe('top')
    // Near the bottom (the longitude labels): beside the marker, towards the middle.
    expect(keepLabelInside('bottom', { lon: 2, lat: 50.5 }, lon, lat)).toBe('right')
    expect(keepLabelInside('bottom', { lon: 8, lat: 50.5 }, lon, lat)).toBe('left')
    expect(keepLabelInside('top', { lon: 8, lat: 59.9 }, lon, lat)).toBe('left')
  })

  it('leaves the side alone for an empty range', () => {
    expect(keepLabelInside('left', { lon: 1, lat: 1 }, [1, 1], [1, 1])).toBe('left')
  })
})
