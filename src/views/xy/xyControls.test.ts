import { describe, expect, it } from 'vitest'
import { XY_ZOOM_X, XY_ZOOM_Y } from '../../charts/options/xy'
import {
  anyZoomed,
  applyZoomEvent,
  chartDescription,
  colorOptions,
  exportStem,
  figureZoom,
  fitTargetOptions,
  focusExtent,
  focusNote,
  focusedAxes,
  legendChips,
  niceRange,
  plotSummary,
  rampColor,
  sourceOptions,
  toggleGroupFilter,
  visiblePointCounts,
  windowZoomed,
} from './xyControls'
import { buildXYData, computeFits, defaultLabels } from './xyModel'
import { channel, dataset, elapsedAxis, range, workspace, wsArgs, xyConfig } from './xyFixtures'

describe('toggleGroupFilter', () => {
  const all = ['g1', 'g2', 'g3']

  it('turns a group off from "every group" and back on to "every group" ([])', () => {
    expect(toggleGroupFilter(all, undefined, 'g2')).toEqual(['g1', 'g3'])
    expect(toggleGroupFilter(all, ['g1', 'g3'], 'g2')).toEqual([])
  })

  it('keeps workspace order and ignores stale ids', () => {
    expect(toggleGroupFilter(all, ['g3', 'gone'], 'g1')).toEqual(['g1', 'g3'])
  })

  it('never leaves no group selected', () => {
    expect(toggleGroupFilter(all, ['g2'], 'g2')).toEqual(['g2'])
    expect(toggleGroupFilter(['g1'], [], 'g1')).toEqual([])
  })
})

describe('options', () => {
  it('disables the zoom range without a zoom and test points without points', () => {
    const none = sourceOptions(null, { points: [] })
    expect(none.map((o) => [o.value, o.disabled])).toEqual([
      ['all', false],
      ['view', true],
      ['points', true],
    ])
    expect(none[1].title).toMatch(/Time history/)
    const some = sourceOptions([10, 20], { points: [{ id: 't', name: 'A', groupId: 'g1', start: 0, end: 4 }] })
    expect(some.every((o) => !o.disabled)).toBe(true)
  })

  it('allows group colours and fits through means only with test points', () => {
    expect(colorOptions(false).find((o) => o.value === 'group')?.disabled).toBe(true)
    expect(colorOptions(true).find((o) => o.value === 'group')?.disabled).toBe(false)
    expect(fitTargetOptions(false).find((o) => o.value === 'means')?.disabled).toBe(true)
  })

  it('counts visible points per group', () => {
    const counts = visiblePointCounts({
      points: [
        { id: 'a', name: 'A', groupId: 'g1', start: 0, end: 2 },
        { id: 'b', name: 'B', groupId: 'g1', start: 2, end: 4, hidden: true },
        { id: 'c', name: 'C', groupId: 'g2', start: 4, end: 6 },
      ],
    })
    expect([...counts]).toEqual([
      ['g1', 1],
      ['g2', 1],
    ])
  })
})

describe('zoom', () => {
  it('judges a window by its percents, else by its values', () => {
    expect(windowZoomed(undefined)).toBe(false)
    expect(windowZoomed({ start: 0, end: 100 })).toBe(false)
    expect(windowZoomed({ start: 10, end: 100 })).toBe(true)
    expect(windowZoomed({ startValue: 0.2, endValue: 0.6 })).toBe(true)
  })

  it('tracks the two axes from datazoom events (single or batched)', () => {
    let flags = applyZoomEvent({}, { batch: [{ dataZoomId: XY_ZOOM_X, start: 20, end: 60 }, { dataZoomId: XY_ZOOM_Y, start: 0, end: 100 }] })
    expect(flags).toEqual({ [XY_ZOOM_X]: true, [XY_ZOOM_Y]: false })
    expect(anyZoomed(flags)).toBe(true)
    flags = applyZoomEvent(flags, { dataZoomId: XY_ZOOM_Y, startValue: -1, endValue: 2 })
    expect(flags[XY_ZOOM_Y]).toBe(true)
    flags = applyZoomEvent(flags, { batch: [{ dataZoomId: XY_ZOOM_X, start: 0, end: 100 }, { dataZoomId: XY_ZOOM_Y, start: 0, end: 100 }] })
    expect(anyZoomed(flags)).toBe(false)
    // Unrelated dataZooms and junk leave the flags alone (same object).
    expect(applyZoomEvent(flags, { dataZoomId: 'other', start: 5, end: 9 })).toBe(flags)
    expect(applyZoomEvent(flags, null)).toBe(flags)
  })

  it('keeps the window ECharts holds for each zoomed axis in an exported figure', () => {
    const option = {
      dataZoom: [
        { id: XY_ZOOM_X, start: null, end: null, startValue: 0.2, endValue: 0.6 },
        { id: XY_ZOOM_Y, start: 10, end: 80, startValue: null, endValue: null },
      ],
    }
    expect(figureZoom(option)).toEqual({ x: { startValue: 0.2, endValue: 0.6 }, y: { start: 10, end: 80 } })
    expect(figureZoom({ dataZoom: [{ id: XY_ZOOM_X, start: 0, end: 100 }] })).toBeNull()
    expect(figureZoom(undefined)).toBeNull()
  })
})

describe('focusExtent', () => {
  /** One series of interleaved x, y, t, row samples. */
  const series = (pairs: [number, number][]) => {
    const data = new Float32Array(pairs.length * 4)
    pairs.forEach(([x, y], i) => data.set([x, y, i, i], i * 4))
    return { data, count: pairs.length }
  }
  const flight = Array.from({ length: 1000 }, (_, i): [number, number] => [(i % 100) / 10, 0.2 + ((i * 7) % 600) / 1000])

  it('leaves absurd samples (CL on the ground) off the axes and counts them', () => {
    const ground: [number, number][] = [
      [0, -6e8],
      [0, -2.5e8],
      [0, -1e6],
    ]
    const focus = focusExtent({ series: [series([...flight, ...ground])], means: [] })
    expect(focus.x).toBeNull()
    // 0.2 … 0.8 padded by 4 %, then out to whole steps of 0.1.
    expect(focus.y).toEqual([0.1, 0.9])
    expect(focus.outside).toBe(3)
    expect(focus.yFar).toBeCloseTo(-6e8, -3)
  })

  it('keeps legitimate wide tails (climbs in a mostly level log) in view', () => {
    const vvi = Array.from({ length: 1000 }, (_, i): [number, number] => [i, i % 10 === 0 ? (i % 20 ? 3000 : -2500) : (i % 7) * 10 - 30])
    expect(focusExtent({ series: [series(vvi)], means: [] })).toEqual({ x: null, y: null, outside: 0, xFar: null, yFar: null })
  })

  it('puts the axis ends on round numbers', () => {
    expect(niceRange([-4.69778684616, 5.76084665298])).toEqual([-6, 6])
    expect(niceRange([0.176, 0.823])).toEqual([0.1, 0.9])
    expect(niceRange([1203.5, 1288.2])).toEqual([1200, 1290])
    expect(niceRange([3, 3])).toEqual([3, 3])
  })

  it('never hides more than 5 % of the samples', () => {
    const many = Array.from({ length: 100 }, (_, i): [number, number] => [0, -1e8 - i])
    expect(focusExtent({ series: [series([...flight, ...many])], means: [] }).y).toBeNull()
  })

  it('keeps every test-point mean in view', () => {
    const mean = { x: { mean: 5, std: 0, n: 1, min: 5, max: 5, rms: 5 }, yStats: { mean: 2.5, std: 0, n: 1, min: 2.5, max: 2.5, rms: 2.5 } }
    const focus = focusExtent({ series: [series([...flight, [0, -6e8]])], means: [mean] })
    expect(focus.y?.[1]).toBe(2.5)
  })

  it('says what is off the axes, whether the fit left it out, and how to see it', () => {
    const focus = { x: null, y: [0, 1] as [number, number], outside: 297, xFar: null, yFar: -5.007e8 }
    const data = { x: channel('alpha', [0], 'α', 'deg'), ys: [{ ch: channel('cl', [0], 'CL', ''), index: 0 }] }
    const fitted = [{ fit: {} as never, target: 'samples' as const, excluded: 297 }]
    expect(focusNote(focus, data, false, fitted)).toBe(
      '297 extreme samples (CL down to −5.007×10⁸) are off the axes and out of the fit, so the rest can be read.',
    )
    expect(focusNote({ ...focus, outside: 1 }, data, false, [])).toBe(
      '1 extreme sample (CL down to −5.007×10⁸) is off the axes, so the rest can be read.',
    )
    expect(focusNote(focus, data, true, fitted)).toBe('Showing everything, the 297 extreme samples included (in the fit too).')
    expect(focusedAxes(focus, false)).toEqual({ x: null, y: [0, 1] })
    expect(focusedAxes(focus, true)).toBeNull()
    expect(focusedAxes(null, false)).toBeNull()
  })
})

describe('rampColor', () => {
  it('interpolates between the ramp stops', () => {
    expect(rampColor(['#000000', '#ffffff'], 0)).toBe('#000000')
    expect(rampColor(['#000000', '#ffffff'], 1)).toBe('#ffffff')
    expect(rampColor(['#000000', '#ffffff'], 0.5)).toBe('#808080')
    expect(rampColor(['#000000', '#ff0000', '#ffffff'], 0.75)).toBe('#ff8080')
    expect(rampColor(['#123456'], 0.3)).toBe('#123456')
    expect(rampColor(['#000000', '#ffffff'], NaN)).toBe('#000000')
  })
})

describe('words', () => {
  const x = range(10)
  const ds = dataset([channel('x', x, 'CL', ''), channel('y', x.map((v) => 3 - v), 'Elevator', 'deg')], x)

  it('summarises what is plotted', () => {
    const ws = workspace({
      points: [
        { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 4 },
        { id: 't2', name: 'B', groupId: 'g2', start: 5, end: 9 },
      ],
      xy: xyConfig({ source: 'points', groups: ['g1'] }),
    })
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: elapsedAxis(ds), lines: false })
    expect(plotSummary(data, ['Trim'], true)).toBe('1 test point (Trim) · 4 samples · 1 mean')
    const all = buildXYData({ ds, ...wsArgs(workspace()), view: null, axis: elapsedAxis(ds), lines: false })
    expect(plotSummary(all, [], true)).toBe('Whole file · 10 samples')
  })

  it('describes the chart for screen readers', () => {
    const ws = workspace({ xy: xyConfig({ fit: 'linear' }) })
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: elapsedAxis(ds), lines: false })
    const fits = computeFits(data, 'linear')
    const labels = defaultLabels(data.x, data.ys.map((y) => y.ch))
    expect(chartDescription(data, labels, fits, 'linear')).toBe(
      'X–Y plot of Elevator [deg] against CL: samples, linear fit through the samples',
    )
  })

  it('lists a legend chip per colour entity, then the fit and the mean markers', () => {
    const ws = workspace({
      points: [
        { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 4 },
        { id: 't2', name: 'B', groupId: 'g2', start: 5, end: 9 },
      ],
      xy: xyConfig({ source: 'points', colorBy: 'group', fit: 'linear', fitTarget: 'samples' }),
    })
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: elapsedAxis(ds), lines: false })
    const chips = legendChips(data, computeFits(data, 'linear'), 'linear', 'points')
    expect(chips.map((c) => [c.kind, c.name, c.slot])).toEqual([
      ['marker', 'Trim', 0],
      ['marker', 'Dynamic', 3],
      ['fit', 'Linear fit', null],
      ['mean', 'Test-point mean ± 1σ', null],
    ])
    const plain = buildXYData({ ds, ...wsArgs(workspace()), view: null, axis: elapsedAxis(ds), lines: true })
    expect(legendChips(plain, [], 'none', 'lines').map((c) => c.kind)).toEqual(['line'])
  })

  it('names export files after the log', () => {
    expect(exportStem('Data 737 (trim).txt')).toBe('Data_737_trim_xy')
    expect(exportStem('...', 'points')).toBe('flight_points')
  })
})
