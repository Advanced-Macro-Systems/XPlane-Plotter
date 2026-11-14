import { describe, expect, it } from 'vitest'
import { readChartTheme } from '../../charts/theme'
import {
  MEAN_RADIUS,
  SYMBOLS,
  TIME_BANDS,
  TIME_RAMP_DARK,
  TIME_RAMP_LIGHT,
  XY_ZOOM_X,
  XY_ZOOM_Y,
  markerPolygon,
  rampColor,
  timeBands,
  timeRamp,
  xyChartOption,
  type XYChartInput,
} from '../../charts/options/xy'
import { MARKER_SHAPES, buildXYData, computeFits, defaultLabels } from './xyModel'
import { channel, dataset, elapsedAxis, range, workspace, wsArgs, xyConfig } from './xyFixtures'
import type { XYConfig } from '../../core/types'

type Series = Record<string, unknown> & { id?: string; type?: string }

function option(patch: Partial<XYConfig>, extra: Partial<XYChartInput> = {}, mode: 'light' | 'paper' = 'light') {
  const x = range(20)
  const ds = dataset(
    [channel('x', x, 'CL', ''), channel('y', x.map((v) => 2 * v), 'Elevator', 'deg'), channel('y2', x.map((v) => -v), 'Stab', 'deg')],
    x,
  )
  const ws = workspace({
    points: [
      { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 5 },
      { id: 't2', name: 'B', groupId: 'g1', start: 6, end: 10 },
      { id: 't3', name: 'C', groupId: 'g2', start: 12, end: 18 },
    ],
    xy: xyConfig(patch),
  })
  const config = ws.xy
  const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: elapsedAxis(ds), lines: config.style !== 'points' || config.colorBy === 'time' })
  const fits = computeFits(data, config.fit)
  const theme = readChartTheme(mode)
  const opt = xyChartOption(
    {
      data,
      fits,
      style: config.style,
      showSamples: config.showSamples,
      labels: defaultLabels(data.x, data.ys.map((y) => y.ch)),
      time: { label: 'Elapsed time', format: (v) => `${v} s` },
      ...extra,
    },
    theme,
  ) as Record<string, unknown>
  return { opt, series: opt.series as Series[], data, theme }
}

describe('xyChartOption', () => {
  it('draws samples as a large scatter, silent, from the typed sample array', () => {
    const { opt, series, data } = option({})
    expect(series.map((s) => s.id)).toEqual(['pts:*|y'])
    const pts = series[0]
    expect(pts).toMatchObject({ type: 'scatter', large: true, largeThreshold: 2000, silent: true, symbolSize: 4 })
    expect(pts.data).toBe(data.series[0].data)
    expect(pts.encode).toEqual({ x: 0, y: 1 })
    // Hover is the view's own nearest-point search: ECharts never shows or hides the tooltip by itself.
    expect(opt.tooltip).toMatchObject({ trigger: 'item', triggerOn: 'none', borderWidth: 0 })
    expect(opt.animation).toBe(false)
    expect(opt.visualMap).toBeUndefined()
  })

  it('draws lines in time order with LTTB sampling and no symbols', () => {
    const { series } = option({ style: 'both' })
    expect(series.map((s) => s.id)).toEqual(['line:*|y', 'pts:*|y'])
    expect(series[0]).toMatchObject({ type: 'line', sampling: 'lttb', showSymbol: false, connectNulls: false })
  })

  it('colours by slot: the group slot with test points', () => {
    const { series, theme } = option({ source: 'points', colorBy: 'group' })
    expect(series.filter((s) => s.type === 'scatter' && String(s.id).startsWith('pts:')).map((s) => (s.itemStyle as { color: string }).color)).toEqual([
      theme.series[0],
      theme.series[3],
    ])
  })

  it('adds fit halos and curves above the samples and the means on top', () => {
    const { series } = option({ source: 'points', colorBy: 'group', fit: 'linear', fitTarget: 'means' })
    expect(series.map((s) => s.id)).toEqual([
      'pts:g1|y',
      'pts:g2|y',
      'fit-halo:g1|y',
      'fit:g1|y',
      'mean-extent',
      'mean:g1|y',
      'mean:g2|y',
    ])
    const fit = series.find((s) => s.id === 'fit:g1|y')
    expect(fit).toMatchObject({ type: 'line', lineStyle: { width: 2 } })
    expect((fit?.data as number[][]).length).toBe(2)
    const mean = series.find((s) => s.id === 'mean:g1|y')
    expect(mean).toMatchObject({ type: 'custom', encode: { x: 0, y: 1 }, clip: true })
    expect((mean?.data as number[][]).length).toBe(2)
    expect(typeof mean?.renderItem).toBe('function')
  })

  it('colours by time with a sequential ramp: samples in time bands, means through the colour bar', () => {
    const { opt, series } = option({ source: 'points', colorBy: 'time', style: 'lines' })
    const visualMap = (opt.visualMap as Record<string, unknown>[])[0]
    const indices = visualMap.seriesIndex as number[]
    // A large scatter paints one colour per series, so the bar's visualMap only colours the means.
    expect(indices.map((i) => series[i].id)).toEqual(['mean:*|y'])
    expect(visualMap).toMatchObject({ type: 'continuous', dimension: 2, min: 0, inRange: { color: TIME_RAMP_LIGHT } })
    expect((visualMap.text as string[])[0]).toMatch(/^Elapsed time\n/)
    const bands = series.filter((s) => String(s.id).startsWith('pts:*|y#'))
    expect(bands.length).toBeGreaterThan(3)
    const colours = bands.map((s) => (s.itemStyle as { color: string }).color)
    expect(new Set(colours).size).toBe(bands.length)
    expect(colours[0]).toBe(rampColor(TIME_RAMP_LIGHT, 0.5 / TIME_BANDS))
    // a line alone cannot show time: dots are drawn over a quiet line
    expect(series.map((s) => s.id)).toContain('line:*|y')
  })

  it('splits samples into equal time bands', () => {
    const data = new Float32Array([0, 0, 0, 0, 1, 1, 5, 1, 2, 2, 10, 2, 3, 3, 9.99, 3])
    const bands = timeBands(data, 4, 0, 10, 2)
    expect(bands.map((b) => [b.index, b.count])).toEqual([
      [0, 1],
      [1, 3],
    ])
    expect(Array.from(bands[1].data.subarray(0, 4))).toEqual([1, 1, 5, 1])
    expect(timeBands(data, 4, 3, 3, 4).map((b) => b.count)).toEqual([4])
  })

  it('pans by dragging unless the zoom box is on', () => {
    const { opt } = option({})
    const zooms = opt.dataZoom as Record<string, unknown>[]
    expect(zooms.map((z) => [z.id, z.type, z.filterMode, z.moveOnMouseMove])).toEqual([
      [XY_ZOOM_X, 'inside', 'none', true],
      [XY_ZOOM_Y, 'inside', 'none', true],
    ])
    const boxed = option({}, { zoomBox: true }).opt.dataZoom as Record<string, unknown>[]
    expect(boxed.map((z) => z.moveOnMouseMove)).toEqual([false, false])
  })

  it('draws the title and legend into an exported figure and keeps the zoom window', () => {
    const { opt } = option(
      { source: 'points', colorBy: 'group', fit: 'linear' },
      { figure: { zoom: { x: { start: 10, end: 60 } } } },
      'paper',
    )
    expect(opt.title).toMatchObject({ text: 'Elevator vs CL' })
    const legend = opt.legend as { data: string[] }
    expect(legend.data).toContain('Trim')
    expect(legend.data).toContain('Trim – linear fit')
    expect((opt.dataZoom as Record<string, unknown>[])[0]).toMatchObject({ start: 10, end: 60 })
    expect(opt.backgroundColor).toBe('#ffffff')
  })

  it('names both axes after the channels', () => {
    const { opt } = option({})
    expect(opt.xAxis).toMatchObject({ type: 'value', name: 'CL', scale: true })
    expect(opt.yAxis).toMatchObject({ type: 'value', name: 'Elevator [deg]' })
  })

  it('fixes the axis ranges of a focus, and always says min/max so a merged option drops the last ones', () => {
    const focused = option({}, { extent: { x: null, y: [-6, 6] } }).opt
    expect(focused.xAxis).toMatchObject({ min: null, max: null })
    expect(focused.yAxis).toMatchObject({ min: -6, max: 6 })
    const free = option({}).opt
    expect(free.yAxis).toMatchObject({ min: null, max: null })
  })

  it('hides the raw end labels of a zoomed axis, on screen and in a figure that keeps the zoom', () => {
    const screen = option({}, { zoomed: { x: true, y: false } }).opt
    expect(screen.xAxis).toMatchObject({ axisLabel: { showMinLabel: false, showMaxLabel: false } })
    expect(screen.yAxis).toMatchObject({ axisLabel: { showMinLabel: null, showMaxLabel: null } })
    const figure = option({}, { figure: { zoom: { y: { startValue: 0, endValue: 3 } } } }, 'paper').opt
    expect(figure.yAxis).toMatchObject({ axisLabel: { showMinLabel: false, showMaxLabel: false } })
    expect(figure.xAxis).toMatchObject({ axisLabel: { showMinLabel: null } })
    // The value formatter survives the merge.
    expect(typeof (screen.xAxis as { axisLabel: { formatter: unknown } }).axisLabel.formatter).toBe('function')
  })
})

describe('markers', () => {
  it('has a symbol for every shape and polygons for all but the circle', () => {
    for (const shape of MARKER_SHAPES) {
      expect(SYMBOLS[shape]).toBeTruthy()
      const points = markerPolygon(shape, 10, 20, MEAN_RADIUS)
      if (shape === 'circle') expect(points).toEqual([])
      else {
        expect(points.length).toBeGreaterThanOrEqual(3)
        for (const [x, y] of points) {
          expect(Math.abs(x - 10)).toBeLessThanOrEqual(MEAN_RADIUS * 1.4)
          expect(Math.abs(y - 20)).toBeLessThanOrEqual(MEAN_RADIUS * 1.4)
        }
      }
    }
  })

  it('ramps time light to dark on paper, dark to light on a dark surface', () => {
    expect(timeRamp(readChartTheme('paper'))).toBe(TIME_RAMP_LIGHT)
    expect(timeRamp({ ...readChartTheme('paper'), mode: 'dark' })).toBe(TIME_RAMP_DARK)
  })
})
