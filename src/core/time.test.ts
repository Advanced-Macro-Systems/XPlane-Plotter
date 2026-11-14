import { describe, expect, it } from 'vitest'
import { describeChannel } from './channels'
import { buildDataset, computeStats } from './dataset'
import { parseText } from './parse'
import { xplaneText } from './parse/fixtures'
import {
  buildElapsed,
  formatAxisValue,
  formatClock,
  formatDuration,
  pickTimeSource,
  rangeToRows,
  rowAtValue,
  timeAxis,
  timeBases,
} from './time'
import type { Channel, TimeAxis } from './types'

function channel(token: string, values: readonly number[], occurrence = 1): Channel {
  const array = Float64Array.from(values)
  return {
    id: occurrence > 1 ? `${token}#${occurrence}` : token,
    token,
    occurrence,
    column: 0,
    meta: describeChannel(token, occurrence),
    values: array,
    stats: computeStats(array),
  }
}

function expectClose(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((value, i) => expect(actual[i], `index ${i}`).toBeCloseTo(value, 9))
}

const elapsedOf = (values: readonly number[]) => buildElapsed(Float64Array.from(values))

/** A 10 Hz X-Plane log of the 737 situation at row 50: sim time jumps forward, mission time resets. */
function reloadedFlight(rows = 120) {
  const header = ['_real,_time', '_totl,_time', 'missn,_time', 'timer,_time', '_zulu,_time', 'local,_time', 'hobbs,_time', '_Vind,_kias']
  const data = Array.from({ length: rows }, (_, i) => {
    const after = i >= 50
    const sim = after ? 900 + i * 0.1 : i * 0.1
    return [
      20 + i * 0.1 + (after ? 12 : 0),
      sim,
      after ? 0.05 + (i - 50) * 0.1 : i * 0.1,
      0,
      13.5 + sim / 3600,
      14.5 + sim / 3600,
      13.55 + (i * 0.1) / 3600,
      120 + Math.sin(i / 10),
    ]
  })
  return buildDataset(parseText(xplaneText(header, data)), { name: 'Data.txt', size: 1 })
}

// ------------------------------------------------------------------ buildElapsed

describe('buildElapsed', () => {
  it('handles empty, single-value and all-NaN input', () => {
    expect(elapsedOf([])).toEqual({ elapsed: new Float64Array(0), segments: [], medianDt: NaN })
    const one = elapsedOf([5])
    expect(Array.from(one.elapsed)).toEqual([0])
    expect(one.segments).toEqual([{ start: 0, end: 1, reason: 'start' }])
    expect(one.medianDt).toBeNaN()
    const none = elapsedOf([NaN, NaN])
    expect(Array.from(none.elapsed)).toEqual([0, 0])
    expect(none.segments).toEqual([{ start: 0, end: 2, reason: 'start' }])
  })

  it('is time since the first sample for a continuous source', () => {
    const result = elapsedOf([10, 10.1, 10.2, 10.3])
    expectClose(result.elapsed, [0, 0.1, 0.2, 0.3])
    expect(result.medianDt).toBeCloseTo(0.1, 12)
    expect(result.segments).toEqual([{ start: 0, end: 4, reason: 'start' }])
  })

  it('keeps zero steps (paused frames) as zero', () => {
    const result = elapsedOf([0, 0.1, 0.1, 0.2])
    expect(Array.from(result.elapsed)).toEqual([0, 0.1, 0.1, 0.2])
    expect(result.segments).toHaveLength(1)
  })

  it('starts a "reset" segment where time goes backwards, advancing one median step', () => {
    const result = elapsedOf([0, 0.1, 0.2, 0.3, 0, 0.1, 0.2])
    expectClose(result.elapsed, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
    expect(result.segments).toEqual([
      { start: 0, end: 4, reason: 'start' },
      { start: 4, end: 7, reason: 'reset' },
    ])
  })

  it('starts a "gap" segment for a jump above max(1 s, 20 × median step)', () => {
    const steady = Array.from({ length: 11 }, (_, i) => i / 10)
    const result = elapsedOf([...steady, 100, 100.1])
    expectClose(result.elapsed, [...steady, 1.1, 1.2])
    expect(result.segments).toEqual([
      { start: 0, end: 11, reason: 'start' },
      { start: 11, end: 13, reason: 'gap' },
    ])
    // 1.3 s at 10 Hz is below the 2 s threshold: an irregular step, not a gap.
    expect(elapsedOf([0, 0.1, 0.2, 1.5, 1.6]).segments).toHaveLength(1)
  })

  it('uses at least 1 s as the gap threshold for fast data, and 20 × median for slow data', () => {
    const fast = Array.from({ length: 11 }, (_, i) => i / 100) // 100 Hz
    expect(elapsedOf([...fast, 0.6, 0.61]).segments).toHaveLength(1) // 0.5 s jump
    expect(elapsedOf([...fast, 1.6, 1.61]).segments.map((s) => s.reason)).toEqual(['start', 'gap'])
    const slow = Array.from({ length: 11 }, (_, i) => i) // 1 Hz
    expect(elapsedOf([...slow, 25, 26]).segments).toHaveLength(1) // 15 s < 20 s
    expect(elapsedOf([...slow, 35, 36]).segments.map((s) => s.reason)).toEqual(['start', 'gap'])
  })

  it('bridges NaN time values by one median step', () => {
    expectClose(elapsedOf([0, 0.1, NaN, 0.3, 0.4]).elapsed, [0, 0.1, 0.2, 0.3, 0.4])
    expectClose(elapsedOf([NaN, NaN, 5, 5.1]).elapsed, [0, 0.1, 0.2, 0.3])
    // A run of NaN rows is not mistaken for a gap...
    const run = [0, 0.1, 0.2, ...Array<number>(30).fill(NaN), 3.3, 3.4]
    expect(elapsedOf(run).segments).toHaveLength(1)
    // ...but going backwards across NaN rows is a reset.
    const back = elapsedOf([0, 0.1, 0.2, NaN, 0.05, 0.15])
    expect(back.segments).toEqual([
      { start: 0, end: 4, reason: 'start' },
      { start: 4, end: 6, reason: 'reset' },
    ])
    expectClose(back.elapsed, [0, 0.1, 0.2, 0.3, 0.4, 0.5])
  })

  it('is always non-decreasing, with contiguous segments covering every row', () => {
    let seed = 7
    const next = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let round = 0; round < 50; round += 1) {
      let t = next() * 100
      const values = Array.from({ length: 400 }, () => {
        const r = next()
        if (r < 0.03) t = next() * 10 // reset
        else if (r < 0.05) t += 50 + next() * 500 // gap
        else if (r < 0.1) return NaN
        else if (r > 0.15) t += 0.05 + next() * 0.1
        return t
      })
      const { elapsed, segments } = elapsedOf(values)
      for (let i = 1; i < elapsed.length; i += 1) expect(elapsed[i]).toBeGreaterThanOrEqual(elapsed[i - 1])
      expect(segments[0].start).toBe(0)
      expect(segments[segments.length - 1].end).toBe(values.length)
      for (let s = 1; s < segments.length; s += 1) expect(segments[s].start).toBe(segments[s - 1].end)
    }
  })
})

// ------------------------------------------------------------------ pickTimeSource

describe('pickTimeSource', () => {
  const ramp = [0, 0.1, 0.2, 0.3]

  it('prefers sim time, then mission time, then real time', () => {
    const real = channel('_real,_time', ramp)
    const missn = channel('missn,_time', ramp)
    const totl = channel('_totl,_time', ramp)
    expect(pickTimeSource([real, missn, totl])).toBe(totl)
    expect(pickTimeSource([real, missn])).toBe(missn)
    expect(pickTimeSource([channel('_Vind,_kias', ramp), real])).toBe(real)
  })

  it('never picks hour-of-day clocks, constant or empty columns', () => {
    const clocks = ['_zulu,_time', 'local,_time', 'hobbs,_time'].map((token) => channel(token, ramp))
    expect(pickTimeSource(clocks)).toBeNull()
    expect(pickTimeSource([channel('_totl,_time', [0, 0, 0]), channel('missn,_time', [NaN, NaN])])).toBeNull()
    expect(pickTimeSource([channel('timer,_time', [0, 0, 0]), channel('_real,_time', ramp)])?.token).toBe('_real,_time')
  })

  it('recognises seconds-based CSV time columns', () => {
    for (const name of ['time', 'Time', 't', 'Time (s)', 'time_s', 't [s]', 'Elapsed time (s)', 'sim time', 'seconds']) {
      expect(pickTimeSource([channel('alpha', ramp), channel(name, ramp)])?.token, name).toBe(name)
    }
    for (const name of ['timestamp', 'time (ms)', 'Time of day', 'tas', 'theta']) {
      expect(pickTimeSource([channel(name, ramp)]), name).toBeNull()
    }
  })
})

// ------------------------------------------------------------------ time bases and axes

describe('timeBases / timeAxis', () => {
  it('lists elapsed, every time column (with availability), then row number', () => {
    const ds = reloadedFlight()
    expect(ds.timeSourceId).toBe('_totl,_time')
    expect(timeBases(ds)).toEqual([
      { id: 'elapsed', label: 'Elapsed time', available: true },
      { id: 'ch:_real,_time', label: 'Real time', available: true },
      { id: 'ch:_totl,_time', label: 'Sim time (total)', available: true },
      { id: 'ch:missn,_time', label: 'Mission time', available: false, reason: 'resets at row 50' },
      { id: 'ch:timer,_time', label: 'Timer', available: false, reason: 'does not change' },
      { id: 'ch:_zulu,_time', label: 'Zulu clock', available: true },
      { id: 'ch:local,_time', label: 'Local clock', available: true },
      { id: 'ch:hobbs,_time', label: 'Hobbs meter', available: true },
      { id: 'index', label: 'Row number', available: true },
    ])
    expect(timeBases(ds)).toBe(timeBases(ds))
  })

  it('offers CSV time columns too', () => {
    const ds = buildDataset(parseText('Time (s),alpha\n0,1\n0.5,2\n1,3\n'), { name: 'a.csv', size: 1 })
    expect(timeBases(ds).map((b) => [b.id, b.label, b.available])).toEqual([
      ['elapsed', 'Elapsed time', true],
      ['ch:Time (s)', describeChannel('Time (s)', 1).label, true],
      ['index', 'Row number', true],
    ])
  })

  it('builds axes, caches them per dataset, and falls back to elapsed', () => {
    const ds = reloadedFlight()
    const elapsed = timeAxis(ds, 'elapsed')
    expect(elapsed).toMatchObject({ id: 'elapsed', label: 'Elapsed time', unit: 's' })
    expect(elapsed.values).toBe(ds.elapsed)
    expect(timeAxis(ds, 'elapsed')).toBe(elapsed)

    const index = timeAxis(ds, 'index')
    expect(index).toMatchObject({ id: 'index', label: 'Row number', unit: '' })
    expect(Array.from(index.values.slice(0, 3))).toEqual([0, 1, 2])
    expect(index.values).toHaveLength(ds.rowCount)

    const zulu = timeAxis(ds, 'ch:_zulu,_time')
    expect(zulu).toMatchObject({ id: 'ch:_zulu,_time', label: 'Zulu clock', unit: 'h', clock: true })
    expect(timeAxis(ds, 'ch:hobbs,_time')).toMatchObject({ unit: 'h', label: 'Hobbs meter' })
    expect(timeAxis(ds, 'ch:hobbs,_time').clock).toBeUndefined()
    expect(timeAxis(ds, 'ch:_real,_time')).toMatchObject({ unit: 's', label: 'Real time' })

    expect(timeAxis(ds, 'ch:missn,_time')).toBe(elapsed) // resets: not offered
    expect(timeAxis(ds, 'ch:no-such-channel')).toBe(elapsed)
    expect(timeAxis(ds, 'ch:_Vind,_kias')).toBe(elapsed) // not a time column
  })

  it('fills NaN gaps in a channel axis so it stays sortable', () => {
    const ds = buildDataset(parseText('time,v\n,1\n1,2\n,3\n,4\n4,5\n,6\n'), { name: 'a.csv', size: 1 })
    expect(Array.from(timeAxis(ds, 'ch:time').values)).toEqual([1, 1, 2, 3, 4, 4])
  })
})

// ------------------------------------------------------------------ row <-> value

describe('rowAtValue / rangeToRows', () => {
  const axis = Float64Array.from([0, 1, 1, 2, 3])

  it('finds the last row at or below a value, clamped', () => {
    expect(rowAtValue(axis, -1)).toBe(0)
    expect(rowAtValue(axis, 0)).toBe(0)
    expect(rowAtValue(axis, 0.5)).toBe(0)
    expect(rowAtValue(axis, 1)).toBe(2)
    expect(rowAtValue(axis, 2.5)).toBe(3)
    expect(rowAtValue(axis, 99)).toBe(4)
    expect(rowAtValue(axis, NaN)).toBe(0)
    expect(rowAtValue(new Float64Array(0), 1)).toBe(0)
  })

  it('converts an axis interval to a half-open row range with at least one row', () => {
    const ramp = Float64Array.from([0, 1, 2, 3, 4])
    expect(rangeToRows(ramp, 1, 3)).toEqual([1, 4])
    expect(rangeToRows(ramp, 3, 1)).toEqual([1, 4])
    expect(rangeToRows(ramp, 0.5, 3.5)).toEqual([1, 4])
    expect(rangeToRows(ramp, 1.2, 1.8)).toEqual([1, 2])
    expect(rangeToRows(ramp, -5, -1)).toEqual([0, 1])
    expect(rangeToRows(ramp, 10, 20)).toEqual([4, 5])
    expect(rangeToRows(ramp, -Infinity, Infinity)).toEqual([0, 5])
    expect(rangeToRows(ramp, NaN, 2)).toEqual([0, 3])
    expect(rangeToRows(ramp, 2, NaN)).toEqual([2, 5])
    expect(rangeToRows(axis, 1, 1)).toEqual([1, 3])
    expect(rangeToRows(new Float64Array(0), 0, 1)).toEqual([0, 0])
  })
})

// ------------------------------------------------------------------ formatting

describe('formatting', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0.00 s')
    expect(formatDuration(0.85)).toBe('0.85 s')
    expect(formatDuration(9.996)).toBe('10.0 s')
    expect(formatDuration(12.34)).toBe('12.3 s')
    expect(formatDuration(59.96)).toBe('1 min 00 s')
    expect(formatDuration(245)).toBe('4 min 05 s')
    expect(formatDuration(3599.6)).toBe('1 h 00 min')
    expect(formatDuration(3720)).toBe('1 h 02 min')
    expect(formatDuration(-5)).toBe('-5.00 s')
    expect(formatDuration(NaN)).toBe('—')
  })

  it('formatClock', () => {
    expect(formatClock(9.25417)).toBe('09:15:15')
    expect(formatClock(16.76262)).toBe('16:45:45')
    expect(formatClock(25.5)).toBe('01:30:00')
    expect(formatClock(-1)).toBe('23:00:00')
    expect(formatClock(23.99999)).toBe('00:00:00')
    expect(formatClock(Infinity)).toBe('—')
  })

  it('formatAxisValue', () => {
    const values = new Float64Array(0)
    const seconds: TimeAxis = { id: 'elapsed', label: 'Elapsed time', unit: 's', values }
    expect(formatAxisValue(seconds, 123.44)).toBe('123.4 s')
    expect(formatAxisValue(seconds, 5.678)).toBe('5.68 s')
    expect(formatAxisValue(seconds, NaN)).toBe('—')
    expect(formatAxisValue({ id: 'ch:_zulu,_time', label: 'Zulu clock', unit: 'h', values, clock: true }, 9.25417)).toBe(
      '09:15:15',
    )
    expect(formatAxisValue({ id: 'ch:hobbs,_time', label: 'Hobbs meter', unit: 'h', values }, 2.34567)).toBe('2.346 h')
    expect(formatAxisValue({ id: 'index', label: 'Row number', unit: '', values }, 1234)).toBe('row 1234')
  })
})
