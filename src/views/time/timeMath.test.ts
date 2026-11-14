import { describe, expect, it } from 'vitest'
import { MINUS } from '../../charts/format'
import { computeStats } from '../../core/dataset'
import type { Channel, Dataset, Segment, TimeAxis } from '../../core/types'
import {
  MS_PER_HOUR,
  axisTitle,
  boundaryMarks,
  cachedSeriesData,
  decimalsFor,
  figureTick,
  fitPlotHeight,
  formatClockPrecise,
  formatTimeRange,
  formatTimeTick,
  formatTimeValue,
  interleaveSeries,
  isWholeWindow,
  laneLabels,
  medianStep,
  nearestRow,
  normalizeWindow,
  paddedWindow,
  rowsToWindow,
  rowsToX,
  sameRows,
  segmentBreaks,
  selectionSummary,
  signedNumber,
  spanInWindow,
  steadyStats,
  tooltipHtml,
  wheelScale,
  windowFromZoomEvent,
  windowToRows,
  windowValueAt,
  windowView,
  xFrame,
  zoomAbout,
} from './timeMath'

/** 0, 0.5, 1.0 ... seconds (2 Hz) */
function ramp(n: number, step = 0.5, start = 0): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => start + i * step)
}

function elapsedAxis(values: Float64Array): TimeAxis {
  return { id: 'elapsed', label: 'Elapsed time', unit: 's', values }
}

function channel(id: string, short: string, unit: string, values: readonly number[]): Channel {
  const v = Float64Array.from(values)
  return {
    id,
    token: id,
    occurrence: 1,
    column: 0,
    meta: { label: short, short, unit, quantity: 'other', group: 'other', known: false },
    values: v,
    stats: computeStats(v),
  }
}

function dataset(elapsed: Float64Array, channels: Channel[], segments?: Segment[]): Dataset {
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 1000,
    format: 'xplane',
    rowCount: elapsed.length,
    channels,
    timeSourceId: null,
    elapsed,
    segments: segments ?? [{ start: 0, end: elapsed.length, reason: 'start' }],
    sampleRateHz: 2,
    warnings: [],
    signature: 'sig',
    loadedAt: 0,
  }
}

describe('medianStep and xFrame', () => {
  it('finds the sample step, ignoring paused frames, and NaN without steps', () => {
    expect(medianStep(Float64Array.from([0, 0.5, 1, 1, 1.5, 2]))).toBe(0.5)
    expect(medianStep(Float64Array.from([3]))).toBeNaN()
    expect(medianStep(Float64Array.from([1, 1, 1]))).toBeNaN()
  })

  it('spans the axis in chart units, a clock in milliseconds', () => {
    const frame = xFrame(elapsedAxis(ramp(101)))
    expect(frame).toMatchObject({ factor: 1, min: 0, max: 50, clock: false, step: 0.5 })
    expect(frame.minSpan).toBe(2) // four samples
    const clock: TimeAxis = { id: 'ch:_zulu,_time', label: 'Zulu clock', unit: 'h', clock: true, values: ramp(11, 0.1, 14) }
    const clockFrame = xFrame(clock)
    expect(clockFrame.factor).toBe(MS_PER_HOUR)
    expect(clockFrame.min).toBeCloseTo(14 * MS_PER_HOUR)
    expect(clockFrame.max).toBeCloseTo(15 * MS_PER_HOUR)
    expect(clockFrame.clock).toBe(true)
  })

  it('never has an empty frame', () => {
    const frame = xFrame(elapsedAxis(Float64Array.from([5])))
    expect(frame.max).toBeGreaterThan(frame.min)
  })
})

describe('zoom windows', () => {
  const axis = elapsedAxis(ramp(201)) // 0..100 s
  const frame = xFrame(axis)

  it('orders, clamps and widens a window to the narrowest span', () => {
    expect(normalizeWindow([60, 20], frame)).toEqual([20, 60])
    expect(normalizeWindow([-10, 500], frame)).toEqual([0, 100])
    expect(normalizeWindow([50, 50.1], frame)).toEqual([49.05, 51.05])
    expect(normalizeWindow([99.9, 100], frame)).toEqual([98, 100])
  })

  it('reads inside-zoom batches, slider percentages and value ranges', () => {
    const current = [0, 100] as const
    expect(windowFromZoomEvent({ batch: [{ start: 10, end: 30 }] }, frame, current)).toEqual([10, 30])
    expect(windowFromZoomEvent({ start: 50, end: 100 }, frame, current)).toEqual([50, 100])
    expect(windowFromZoomEvent({ startValue: 12, endValue: 40 }, frame, current)).toEqual([12, 40])
    expect(windowFromZoomEvent({ start: 20 }, frame, [0, 60])).toEqual([20, 60])
    expect(windowFromZoomEvent({ type: 'datazoom' }, frame, current)).toBeNull()
    expect(windowFromZoomEvent(null, frame, current)).toBeNull()
  })

  it('knows the whole axis', () => {
    expect(isWholeWindow([0, 100], frame)).toBe(true)
    expect(isWholeWindow([0, 99], frame)).toBe(false)
  })

  it('converts windows to half-open row ranges and back', () => {
    expect(windowToRows(axis, frame, [10, 20])).toEqual([20, 41])
    expect(windowToRows(axis, frame, [10.2, 10.4])).toEqual([20, 21])
    expect(rowsToWindow(axis, frame, [20, 41])).toEqual([10, 20])
    expect(rowsToWindow(axis, frame, null)).toEqual([0, 100])
    expect(windowView(axis, frame, [0, 100])).toBeNull()
    expect(windowView(axis, frame, [10, 20])).toEqual([20, 41])
  })

  it('zooms about the pointer and never past the whole axis', () => {
    expect(zoomAbout([0, 100], frame, 0.5, 0.5)).toEqual([25, 75])
    expect(zoomAbout([0, 100], frame, 0, 0.5)).toEqual([0, 50])
    expect(zoomAbout([40, 60], frame, 0.5, 100)).toEqual([0, 100])
    const tiny = zoomAbout([40, 60], frame, 0.5, 0.0001)
    expect(tiny[1] - tiny[0]).toBeCloseTo(frame.minSpan)
  })

  it('turns wheel deltas into gentle zoom factors', () => {
    expect(wheelScale(100, 0)).toBeGreaterThan(1)
    expect(wheelScale(-100, 0)).toBeLessThan(1)
    expect(wheelScale(3, 1)).toBeCloseTo(wheelScale(99, 0))
    expect(wheelScale(1e6, 0)).toBe(2)
    expect(wheelScale(-1e6, 0)).toBe(0.5)
  })

  it('finds x across the window and the nearest row', () => {
    expect(windowValueAt([10, 20], 0.25)).toBe(12.5)
    expect(windowValueAt([10, 20], 2)).toBe(20)
    expect(nearestRow(axis.values, 10.2)).toBe(20)
    expect(nearestRow(axis.values, 10.3)).toBe(21)
    expect(nearestRow(axis.values, 1e9)).toBe(200)
    expect(nearestRow(axis.values, -5)).toBe(0)
  })

  it('pads a row range for "zoom to"', () => {
    expect(paddedWindow(axis, frame, [20, 41], 0.1)).toEqual([9, 21])
    expect(paddedWindow(axis, frame, [0, 201], 0.1)).toEqual([0, 100])
  })
})

describe('segments and series data', () => {
  const segments: Segment[] = [
    { start: 0, end: 4, reason: 'start' },
    { start: 4, end: 6, reason: 'gap' },
    { start: 6, end: 8, reason: 'reset' },
  ]

  it('lists the rows where a new segment starts and marks them halfway', () => {
    expect(segmentBreaks(segments)).toEqual([4, 6])
    const axis = elapsedAxis(ramp(8, 1))
    expect(boundaryMarks(segments, axis, xFrame(axis))).toEqual([
      { x: 3.5, row: 4, reason: 'gap' },
      { x: 5.5, row: 6, reason: 'reset' },
    ])
  })

  it('interleaves x/y pairs and breaks the line at segment starts', () => {
    const x = [0, 1, 2, 3, 4, 5]
    const y = [10, 11, 12, 13, 14, 15]
    expect(Array.from(interleaveSeries(x, y, [3], 0, 6))).toEqual([0, 10, 1, 11, 2, 12, 2.5, NaN, 3, 13, 4, 14, 5, 15])
    expect(Array.from(interleaveSeries(x, y, [3], 3, 5, 2))).toEqual([6, 13, 8, 14])
    expect(Array.from(interleaveSeries(x, y, [], 1, 3))).toEqual([1, 11, 2, 12])
  })

  it('caches whole-file series per axis and channel', () => {
    const axisValues = ramp(5, 1)
    const values = Float64Array.from([1, 2, 3, 4, 5])
    const a = cachedSeriesData(axisValues, 1, [2], values)
    expect(cachedSeriesData(axisValues, 1, [2], values)).toBe(a)
    expect(cachedSeriesData(axisValues, 1, [], values)).not.toBe(a)
    expect(a.length).toBe(12)
  })
})

describe('time formatting', () => {
  const elapsed = elapsedAxis(ramp(10))
  const rows: TimeAxis = { id: 'index', label: 'Row number', unit: '', values: ramp(10, 1) }
  const clock: TimeAxis = { id: 'ch:_zulu,_time', label: 'Zulu clock', unit: 'h', clock: true, values: ramp(10, 0.01, 14.5) }

  it('chooses decimals that resolve a sample', () => {
    expect(decimalsFor(0.05)).toBe(2)
    expect(decimalsFor(0.5)).toBe(1)
    expect(decimalsFor(1)).toBe(0)
    expect(decimalsFor(NaN)).toBe(1)
    expect(decimalsFor(1e-9)).toBe(4)
  })

  it('formats clocks with optional decimals', () => {
    expect(formatClockPrecise(14.5, 0)).toBe('14:30:00')
    expect(formatClockPrecise(14.5 + 1.25 / 3600, 1)).toBe('14:30:01.3')
    expect(formatClockPrecise(NaN, 1)).toBe('—')
  })

  it('formats tooltip titles per axis kind with a real minus', () => {
    expect(formatTimeValue(elapsed, 123.456, 0.05)).toBe('123.46 s')
    expect(formatTimeValue(elapsed, -2.5, 0.5)).toBe(`${MINUS}2.5 s`)
    expect(formatTimeValue(rows, 41.6, 1)).toBe('row 42')
    expect(formatTimeValue(clock, 14.5, 0.01)).toBe('14:30:00')
    expect(formatTimeValue(elapsed, NaN, 1)).toBe('—')
  })

  it('formats ticks and ranges', () => {
    expect(formatTimeTick(xFrame(elapsed), 120)).toBe('120')
    expect(formatTimeTick(xFrame(elapsed), -0.30000000000000004)).toBe(`${MINUS}0.3`)
    expect(formatTimeTick(xFrame(clock), 14.5 * MS_PER_HOUR)).toBe('14:30:00')
    expect(formatTimeRange(elapsed, 120.43, 132.71)).toBe('t = 120.4 → 132.7 s')
    expect(formatTimeRange(elapsed, 1.234, 3.456)).toBe('t = 1.23 → 3.46 s')
    expect(formatTimeRange(rows, 1200, 1322)).toBe('rows 1200 → 1322')
    expect(formatTimeRange(clock, 14.5, 14.5 + 12 / 3600)).toBe('14:30:00 → 14:30:12')
  })

  it('labels the figure ends only when they are round numbers', () => {
    const frame = xFrame(elapsed)
    expect(figureTick(frame, [0, 2193.0608], 0)).toBe('0')
    expect(figureTick(frame, [0, 2193.0608], 2193.0608)).toBe('')
    expect(figureTick(frame, [0, 2193.0608], 1500)).toBe('1500')
    expect(figureTick(frame, [121.3, 514.1], 121.3)).toBe('')
    expect(figureTick(frame, [120, 514.1], 120)).toBe('120')
  })

  it('titles the x axis with its unit', () => {
    expect(axisTitle(elapsed)).toBe('Elapsed time [s]')
    expect(axisTitle(rows)).toBe('Row number')
    expect(axisTitle(clock)).toBe('Zulu clock [hh:mm:ss]')
  })
})

describe('selection readout', () => {
  const elapsed = ramp(121) // 0..60 s at 2 Hz
  const kias = channel('_Vind,_kias', 'KIAS', 'kt', Array.from(elapsed, (t) => 250 + t / 60))
  const alt = channel('p-alt,ftMSL', 'Altitude', 'ft', Array.from(elapsed, () => 10000))
  const ds = dataset(elapsed, [kias, alt])

  it('summarises a selection', () => {
    expect(selectionSummary(ds, elapsedAxis(elapsed), [20, 45])).toEqual({
      range: 't = 10.0 → 22.0 s',
      duration: '12.0 s',
      rows: '25 rows',
    })
    expect(selectionSummary(ds, elapsedAxis(elapsed), [3, 4]).rows).toBe('1 row')
  })

  it('signs numbers with a plus or a real minus', () => {
    expect(signedNumber(0.314)).toBe('+0.31')
    expect(signedNumber(-2.14)).toBe(`${MINUS}2.1`)
    expect(signedNumber(0)).toBe('0')
    expect(signedNumber(NaN)).toBe('—')
  })

  it('gives mean ± σ and drift per minute for each channel', () => {
    const [speed, height] = steadyStats(ds, [kias, alt], [0, 121])
    expect(speed.meanText).toBe('250.5 ± 0.29')
    expect(speed.driftText).toBe('+1 kt/min')
    expect(speed.name).toBe('KIAS')
    expect(speed.n).toBe(121)
    expect(speed.title).toContain('KIAS [kt]')
    expect(height.meanText).toBe('10000 ± 0')
    expect(height.driftText).toBe('0 ft/min')
  })
})

describe('overlay geometry', () => {
  it('places a span inside the window as fractions, clipped', () => {
    expect(spanInWindow(20, 40, [0, 100])).toEqual({ left: 0.2, right: 0.4 })
    expect(spanInWindow(40, 20, [0, 100])).toEqual({ left: 0.2, right: 0.4 })
    expect(spanInWindow(-10, 10, [0, 100])).toEqual({ left: 0, right: 0.1 })
    expect(spanInWindow(110, 120, [0, 100])).toBeNull()
    expect(spanInWindow(NaN, 10, [0, 100])).toBeNull()
  })

  it('maps a row range to chart x from its first to its last row', () => {
    const axis = elapsedAxis(ramp(11))
    expect(rowsToX(axis, xFrame(axis), [2, 5])).toEqual([1, 2])
    expect(rowsToX(axis, xFrame(axis), [9, 50])).toEqual([4.5, 5])
  })

  it('names bands in the lane only when they are wide enough and clear of the previous name', () => {
    const textPx = (text: string) => text.length * 7
    const labels = laneLabels(
      [
        { id: 'b', x0: 50, x1: 52, label: 'Narrow' },
        { id: 'a', x0: 10, x1: 30, label: 'Trim 250 KIAS' },
        { id: 'c', x0: 31, x1: 45, label: 'Next to it' },
        { id: 'd', x0: 200, x1: 210, label: 'Outside' },
      ],
      [0, 100],
      1000,
      textPx,
    )
    expect(labels.map((l) => l.id)).toEqual(['a', 'c', 'b'])
    expect(labels.map((l) => l.showLabel)).toEqual([true, true, false])
    expect(labels[0]).toMatchObject({ left: 0.1, right: 0.3 })

    const crowded = laneLabels(
      [
        { id: 'a', x0: 10, x1: 30, label: 'A very long name for a band' },
        { id: 'b', x0: 12, x1: 40, label: 'Overlapping' },
      ],
      [0, 100],
      1000,
      textPx,
    )
    expect(crowded.map((l) => l.showLabel)).toEqual([true, false])
  })

  it('compares row ranges by value', () => {
    expect(sameRows([1, 2], [1, 2])).toBe(true)
    expect(sameRows([1, 2], [1, 3])).toBe(false)
    expect(sameRows(null, null)).toBe(true)
    expect(sameRows(null, undefined)).toBe(false)
    expect(sameRows(null, [0, 1])).toBe(false)
  })
})

describe('panel layout and tooltip', () => {
  const chrome = { perPanel: 60, fixed: 100, gap: 10 }

  it('fills the column with plots, within limits', () => {
    expect(fitPlotHeight(800, 2, chrome)).toBe(285)
    expect(fitPlotHeight(800, 1, chrome, 120, 320)).toBe(320)
    expect(fitPlotHeight(800, 8, chrome)).toBe(120)
    expect(fitPlotHeight(0, 3, chrome)).toBe(180)
    expect(fitPlotHeight(500, 0, chrome)).toBe(320)
  })

  it('lists every series at the nearest row, value first, names escaped', () => {
    const axis = elapsedAxis(ramp(5, 1))
    const html = tooltipHtml(
      axis,
      xFrame(axis),
      [
        { name: '<b>KIAS</b> [kt]', color: '#2a78d6', values: Float64Array.from([250, 251, 252, 253, 254]) },
        { name: 'Alt [ft]', color: '#eb6834', values: Float64Array.from([1, 2, NaN, 4, 5]) },
      ],
      2.2,
    )
    expect(html).toContain('>2 s<')
    expect(html).toContain('252')
    expect(html).toContain('&lt;b&gt;KIAS&lt;/b&gt; [kt]')
    expect(html).not.toContain('<b>KIAS')
    expect(html).toContain('—')
    expect(html.indexOf('252')).toBeLessThan(html.indexOf('KIAS'))
  })
})
