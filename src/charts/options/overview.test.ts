import { describe, expect, it } from 'vitest'
import { MINUS } from '../format'
import { readChartTheme } from '../theme'
import {
  endLabelSide,
  GLANCE_GRID,
  glanceChartOption,
  groundTrackOption,
  keepLabelInside,
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
      { from: 0.2, to: 0.8, slot: 3 },
      { from: 1.2, to: 1.8, slot: 0 },
    ],
    formatX: (x) => `t = ${x} s`,
    ...patch,
  }
}

describe('glanceChartOption', () => {
  it('draws one thin line per channel in its slot colour, without symbols, over a fixed time span', () => {
    const option = rec(glanceChartOption(theme, input()))
    const series = list(option.series)
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

  it('bands the test points in their group colour and marks segment boundaries', () => {
    const series = list(rec(glanceChartOption(theme, input())).series)
    const area = rec(series[0].markArea)
    const bands = area.data as AnyRecord[][]
    expect(bands).toHaveLength(2)
    expect(bands[0][0]).toMatchObject({ xAxis: 0.2, itemStyle: { color: theme.series[3] } })
    expect(bands[0][1]).toEqual({ xAxis: 0.8 })
    expect(area.silent).toBe(true)
    const markLine = rec(series[0].markLine)
    expect(markLine.data).toEqual([{ xAxis: 1, name: 'reset' }])
    expect(rec(markLine.label).show).toBe(true)
    expect(rec(markLine.label).color).toBe(theme.textMuted)
    expect(series[1].markArea).toBeUndefined()
    const unlabelled = list(rec(glanceChartOption(theme, input({ labelMarkers: false }))).series)
    expect(rec(rec(unlabelled[0].markLine).label).show).toBe(false)
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
    expect(list(rec(glanceChartOption(theme, input({ lines }))).series)).toHaveLength(8)
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
