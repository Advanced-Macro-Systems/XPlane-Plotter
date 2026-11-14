import { describe, expect, it } from 'vitest'
import { timeAxis } from '../../core/time'
import type { Dataset } from '../../core/types'
import { channel, dataset } from '../xy/xyFixtures'
import {
  MATCH_LIMIT,
  SINGLE_TIME_PAD,
  baseName,
  clockVerdict,
  matchTimeBases,
  parseTimesTable,
  timeBaseChoices,
  windowRows,
} from './timesTable'

// Synthetic tables and flights only: no times or speeds from any real log.

const windows = (text: string) => parseTimesTable(text).windows.map((w) => [w.from, w.to, w.single, w.speed])

describe('parseTimesTable', () => {
  it('reads a window and its speed in the usual ways', () => {
    expect(windows('120-150 250')).toEqual([[120, 150, false, 250]])
    expect(windows('120 150')).toEqual([[120, 150, false, null]])
    expect(windows('180–210, 240 kt')).toEqual([[180, 210, false, 240]])
    expect(windows('180 — 210\t240')).toEqual([[180, 210, false, 240]])
    expect(windows('180 to 210 | 240 KIAS')).toEqual([[180, 210, false, 240]])
    expect(windows('180 210 240')).toEqual([[180, 210, false, 240]])
    expect(windows('125.5-140.25 251.5')).toEqual([[125.5, 140.25, false, 251.5]])
    // Ends typed the wrong way round, a label in front, the speed first.
    expect(windows('150-120 250')).toEqual([[120, 150, false, 250]])
    expect(windows('Point 1: 120-150 250')).toEqual([[120, 150, false, 250]])
    expect(windows('250 | 120-150')).toEqual([[120, 150, false, 250]])
  })

  it('takes a single time as a short window around it', () => {
    expect(windows('300')).toEqual([[300, 300, true, null]])
    expect(windows('300 260 kt')).toEqual([[300, 300, true, 260]])
  })

  it('reads clock times', () => {
    const parsed = parseTimesTable('14:30:00-14:30:40 250\n6:40-7:00')
    expect(parsed.clock).toBe(true)
    expect(parsed.windows.map((w) => [w.from, w.to])).toEqual([
      [52200, 52240],
      [400, 420],
    ])
  })

  it('uses a header to tell the time column from the speed column', () => {
    const parsed = parseTimesTable(['Time (s) | IAS', '100 | 260', '150-180 | 250', '210–240 | 240'].join('\n'))
    expect(parsed.header).toBe('Time (s) | IAS')
    expect(parsed.speedKind).toBe('ias')
    expect(parsed.windows.map((w) => [w.line, w.from, w.to, w.single, w.speed])).toEqual([
      [2, 100, 100, true, 260],
      [3, 150, 180, false, 250],
      [4, 210, 240, false, 240],
    ])
    // Start and end in two columns, the speed first.
    expect(windows('KTAS\tStart (s)\tEnd (s)\n280\t60\t95')).toEqual([[60, 95, false, 280]])
    expect(parseTimesTable('KTAS\tStart (s)\tEnd (s)\n280\t60\t95').speedKind).toBe('tas')
  })

  it('reads a table flattened onto one line, header run into the first row, and skips lines without a time', () => {
    const parsed = parseTimesTable('Time (s) | IAS: 100 | 260 · 150-180 | 250 · 210–240 | 240 · (not flown, buffet) | 230')
    expect(parsed.header).toBe('Time (s) | IAS')
    expect(parsed.windows.map((w) => [w.from, w.to, w.single, w.speed])).toEqual([
      [100, 100, true, 260],
      [150, 180, false, 250],
      [210, 240, false, 240],
    ])
    expect(parsed.skipped).toEqual([{ line: 4, text: '(not flown, buffet) | 230', reason: 'no time on it' }])
  })

  it('reads the "time | speed" layout without a header, from the other lines', () => {
    expect(windows('100 | 260\n150-180 | 250')).toEqual([
      [100, 100, true, 260],
      [150, 180, false, 250],
    ])
  })

  it('reads a Markdown table and ignores blank and rule lines', () => {
    const text = ['| Time (s) | KIAS |', '|---|---|', '| 150-180 | 250 |', '', '| 210-240 | 240 |'].join('\n')
    const parsed = parseTimesTable(text)
    expect(parsed.windows.map((w) => [w.from, w.to, w.speed])).toEqual([
      [150, 180, 250],
      [210, 240, 240],
    ])
    expect(parsed.skipped).toEqual([])
  })

  it('skips what it cannot read, with the reason', () => {
    const parsed = parseTimesTable('Notes\n10 20 30 40\nlater: none')
    expect(parsed.windows).toEqual([])
    expect(parsed.skipped.map((s) => [s.line, s.reason])).toEqual([
      [2, 'more numbers than a window and a speed'],
      [3, 'no time on it'],
    ])
  })

  it('skips a line whose only number stands where the speed goes, without a header', () => {
    const rows = ['100 | 260', '150-180 | 250', '210-240 | 240']
    for (const last of ['(not recorded, buffet) | 230', 'n/a | 230', '(not flown)\t230', '\t\t230']) {
      const parsed = parseTimesTable([...rows, last].join('\n'))
      expect(parsed.windows.map((w) => [w.from, w.to, w.speed])).toEqual([
        [100, 100, 260],
        [150, 180, 250],
        [210, 240, 240],
      ])
      expect(parsed.skipped).toEqual([{ line: 4, text: last.trim(), reason: 'no time on it' }])
    }
    // Pasted from a spreadsheet (tabs), or typed with spaces.
    const tabs = parseTimesTable(['100\t260', '150-180\t250', '(not recorded, buffet)\t230'].join('\n'))
    expect(tabs.windows.map((w) => [w.from, w.speed])).toEqual([
      [100, 260],
      [150, 250],
    ])
    expect(tabs.skipped.map((s) => s.line)).toEqual([3])
    const spaces = parseTimesTable(['100 260', '150-180 250', '(not recorded) 230'].join('\n'))
    expect(spaces.windows.map((w) => [w.from, w.to, w.single, w.speed])).toEqual([
      [100, 100, true, 260],
      [150, 180, false, 250],
    ])
    expect(spaces.skipped.map((s) => [s.line, s.reason])).toEqual([[3, 'no time on it']])
    // A speed with its unit and no time.
    expect(parseTimesTable('150-180 250\n(not recorded) 230 kt').skipped.map((s) => s.reason)).toEqual(['no time on it'])
  })

  it('keeps the columns of a spreadsheet row with an empty cell', () => {
    const parsed = parseTimesTable(['Start (s)\tEnd (s)\tKIAS', '300\t\t260', '150\t180\t250', '\t\t240'].join('\n'))
    expect(parsed.windows.map((w) => [w.from, w.to, w.single, w.speed])).toEqual([
      [300, 300, true, 260],
      [150, 180, false, 250],
    ])
    expect(parsed.skipped).toEqual([{ line: 4, text: '240', reason: 'no time on it' }])
  })

  it('reads a header’s time column by its name, or the other cells when it names none', () => {
    expect(windows('Run | Elapsed | KIAS\n1 | 100 | 260\n2 | 150-180 | 250')).toEqual([
      [100, 100, true, 260],
      [150, 180, false, 250],
    ])
    expect(windows('t1\tt2\tIAS\n150\t180\t250')).toEqual([[150, 180, false, 250]])
    expect(windows('Run | Moment | KIAS\n1 | 100 | 260\n2 | 150-180 | 250')).toEqual([
      [100, 100, true, 260],
      [150, 180, false, 250],
    ])
  })

  it('does not read a label in front of a line as a time', () => {
    const parsed = parseTimesTable(['Point 1: 100 260', 'Point 2: 150-180 250', 'Point 3: (not recorded) 240', '4) 210-240 230'].join('\n'))
    expect(parsed.windows.map((w) => [w.from, w.to, w.single, w.speed])).toEqual([
      [100, 100, true, 260],
      [150, 180, false, 250],
      [210, 240, false, 230],
    ])
    expect(parsed.skipped.map((s) => s.line)).toEqual([3])
  })
})

// A flight logged with two clocks: sim time (elapsed) and a real-time clock 33 s ahead of it. Holds at 260, 250 and
// 240 kt of 40 s each, 30 s decelerations between them, 10 rows per second.
function twoClocks(): Dataset {
  const t: number[] = []
  const real: number[] = []
  const kias: number[] = []
  const legs = [
    { s: 40, from: 260, to: 260 },
    { s: 30, from: 260, to: 250 },
    { s: 40, from: 250, to: 250 },
    { s: 30, from: 250, to: 240 },
    { s: 40, from: 240, to: 240 },
  ]
  for (const leg of legs) {
    for (let k = 0; k < leg.s * 10; k += 1) {
      const time = t.length / 10
      t.push(time)
      real.push(time + 33)
      kias.push(leg.from + ((leg.to - leg.from) * k) / (leg.s * 10) + 0.1 * Math.sin(k))
    }
  }
  return dataset(
    [channel('_totl,_time', t, 'Sim', 's'), channel('_real,_time', real, 'Real', 's'), channel('_Vind,_kias', kias, 'KIAS', 'kt')],
    t,
    { timeSourceId: '_totl,_time' },
  )
}

describe('time axes', () => {
  const ds = twoClocks()
  const kias = ds.channels[2]

  it('offers every available time axis but row numbers', () => {
    expect(timeBaseChoices(ds).map((b) => b.id)).toEqual(['elapsed', 'ch:_totl,_time', 'ch:_real,_time'])
  })

  it('finds the rows of a window, a single time ± the pad, nothing outside the log', () => {
    const axis = timeAxis(ds, 'ch:_real,_time')
    const rows = windowRows(axis, { from: 43, to: 63, single: false })
    expect(rows).not.toBeNull()
    if (!rows) return
    expect(axis.values[rows[0]]).toBeCloseTo(43, 1)
    expect(axis.values[rows[1] - 1]).toBeCloseTo(63, 1)
    const single = windowRows(axis, { from: 53, to: 53, single: true })
    expect(single && axis.values[single[1] - 1] - axis.values[single[0]]).toBeCloseTo(2 * SINGLE_TIME_PAD, 0)
    expect(windowRows(axis, { from: 900, to: 950, single: false })).toBeNull()
    expect(windowRows(axis, { from: 0, to: 20, single: false })).toBeNull()
  })

  it('works out which clock the times were read on from the listed speeds', () => {
    // Times read off the real-time clock (33 s ahead of sim time), each hold's middle 20 s.
    const parsed = parseTimesTable('Time | IAS\n43-63 260\n113-133 250\n183-203 240')
    const matches = matchTimeBases(ds, parsed.windows, kias)
    expect(matches[0].id).toBe('ch:_real,_time')
    expect(matches[0].max).toBeLessThan(0.2)
    const elapsed = matches.find((m) => m.id === 'elapsed')
    expect(elapsed?.median).toBeGreaterThan(MATCH_LIMIT)
    const verdict = clockVerdict(matches, 'elapsed', 'kt')
    expect(verdict.confirmed).toBe(true)
    expect(verdict.id).toBe('ch:_real,_time')
    expect(verdict.message).toMatch(/^These times match Real time \(X-Plane _real,_time\): speeds agree within 0\.\d kt \(median 0\.\d kt\)\. On elapsed time they would be \d+(\.\d)? kt off\.$/)
    expect(baseName(matches[0])).toBe('Real time (X-Plane _real,_time)')
  })

  it('keeps the current axis when no speeds are listed or none matches', () => {
    const plain = parseTimesTable('43-63\n113-133')
    const none = clockVerdict(matchTimeBases(ds, plain.windows, kias), 'elapsed', 'kt')
    expect(none).toMatchObject({ id: 'elapsed', confirmed: false })
    expect(none.message).toMatch(/^No speeds are listed/)
    const wrong = parseTimesTable('43-63 300\n113-133 310')
    const bad = clockVerdict(matchTimeBases(ds, wrong.windows, kias), 'elapsed', 'kt')
    expect(bad).toMatchObject({ id: 'elapsed', confirmed: false })
    expect(bad.message).toMatch(/^No time axis matches the listed speeds well/)
  })

  it('confirms the clock when most speeds agree, and names the lines that do not', () => {
    // Line 3 was read off in the deceleration: about 4 kt off on real time, where the others agree.
    const parsed = parseTimesTable('Time | IAS\n43-63 260\n85-95 250\n113-133 250\n183-203 240')
    const matches = matchTimeBases(ds, parsed.windows, kias)
    expect(matches[0]).toMatchObject({ id: 'ch:_real,_time', agree: 3 })
    expect(matches[0].off.map((o) => o.line)).toEqual([3])
    const verdict = clockVerdict(matches, 'elapsed', 'kt')
    expect(verdict).toMatchObject({ id: 'ch:_real,_time', confirmed: true })
    expect(verdict.message).toMatch(
      /^These times match Real time \(X-Plane _real,_time\): 3 of 4 speeds agree within 0\.\d kt \(median 0\.\d kt\); line 3 is 4\.\d kt off\./,
    )
    // Half the speeds off: no axis is confirmed.
    const half = parseTimesTable('Time | IAS\n43-63 260\n85-95 250')
    expect(clockVerdict(matchTimeBases(ds, half.windows, kias), 'elapsed', 'kt').confirmed).toBe(false)
  })

  it('reports a window outside the log apart instead of ruling the clock out', () => {
    const parsed = parseTimesTable('Time | IAS\n43-63 260\n113-133 250\n183-203 240\n18300-18400 235')
    const verdict = clockVerdict(matchTimeBases(ds, parsed.windows, kias), 'elapsed', 'kt')
    expect(verdict).toMatchObject({ id: 'ch:_real,_time', confirmed: true })
    expect(verdict.message).toContain('speeds agree within')
    expect(verdict.message).toContain('Line 5 lies outside the log on this axis.')
  })

  it('finds no rows for a window in a gap of the time axis', () => {
    // A clock that jumps 500 s ten seconds in.
    const t = Array.from({ length: 300 }, (_, i) => i / 10)
    const jumpy = dataset(
      [channel('_totl,_time', t.map((s) => (s < 10 ? s : s + 500)), 'Sim', 's'), channel('_Vind,_kias', t.map(() => 250), 'KIAS', 'kt')],
      t,
    )
    const axis = timeAxis(jumpy, 'ch:_totl,_time')
    expect(windowRows(axis, { from: 100, to: 120, single: false })).toBeNull()
    expect(windowRows(axis, { from: 200, to: 200, single: true })).toBeNull()
    expect(windowRows(axis, { from: 512, to: 515, single: false })).toEqual([120, 151])
  })
})
