import { describe, expect, it } from 'vitest'
import type { SteadyWindow } from '../../core/analysis/steady'
import { timeAxis } from '../../core/time'
import type { TestPoint } from '../../core/types'
import { channel, dataset, elapsedAxis } from '../xy/xyFixtures'
import { signedText, steadyRows, timesRows, windowText } from './steadyModel'
import { parseTimesTable } from './timesTable'

// Synthetic data only.

const found = (start: number, end: number, mean: number): SteadyWindow => ({
  start,
  end,
  seconds: (end - start - 1) / 10,
  from: start / 10,
  to: (end - 1) / 10,
  speed: { mean, std: 0.2, drift: 0.1 },
  vvi: { mean: 3, std: 10 },
  altDrift: 2,
  bank: 0.1,
  power: null,
})

const point = (id: string, start: number, end: number, name = id): TestPoint => ({ id, name, groupId: 'g1', start, end })

// 60 s at 10 rows per second: 250 kt for 30 s, then a steady climb in speed to 262 kt.
const t = Array.from({ length: 600 }, (_, i) => i / 10)
const kias = t.map((s) => (s < 30 ? 250 + 0.1 * Math.sin(10 * s) : 250 + 0.4 * (s - 30)))
const ds = dataset([channel('_Vind,_kias', kias, 'KIAS', 'kt')], t)
const axis = elapsedAxis(ds)

describe('signedText', () => {
  it('signs a number, with a real minus and no sign on zero', () => {
    expect([1.62, -0.44, 0.04, -0.04, NaN].map((v) => signedText(v, 1))).toEqual(['+1.6', '−0.4', '0.0', '0.0', '—'])
  })
})

describe('steadyRows', () => {
  it('names each window by its speed and shows it on the current axis', () => {
    const rows = steadyRows({ points: [point('a', 0, 10, '250 KIAS')] }, axis, [found(20, 220, 250.2), found(300, 500, 249.8)], 'KIAS')
    expect(rows.map((r) => [r.name, r.range, r.overlaps])).toEqual([
      ['250 KIAS (2)', '2.0 – 21.9 s', null],
      ['250 KIAS (3)', '30.0 – 49.9 s', null],
    ])
  })

  it('marks a window that would repeat a saved point (and does not name it)', () => {
    const saved = point('a', 200, 260, 'Hold')
    const rows = steadyRows({ points: [saved] }, axis, [found(20, 220, 250.2), found(300, 500, 255)], 'KIAS')
    expect(rows[0]).toMatchObject({ name: '', overlaps: saved })
    expect(rows[1]).toMatchObject({ name: '255 KIAS', overlaps: null })
  })
})

describe('timesRows', () => {
  it('gives each window its rows, mean speed, difference from the listed speed and steadiness', () => {
    const parsed = parseTimesTable('5-25 250\n40-55 256\n100-120 250\n15')
    const rows = timesRows(ds, { points: [] }, axis, axis, parsed.windows, ds.channels[0])
    expect(rows.map((r) => r.name)).toEqual(['250 KIAS', '256 KIAS', '', '250 KIAS (2)'])
    const [steady, drifting, outside, single] = rows
    expect(steady.rows).toEqual([50, 251])
    expect(steady.stats?.mean).toBeCloseTo(250, 1)
    expect(Math.abs(steady.diff)).toBeLessThan(0.1)
    expect(steady.steady?.flagged).toBe(false)
    expect(steady.range).toBe('5.0 – 25.0 s')
    expect(drifting.steady?.flagged).toBe(true)
    expect(drifting.hint).toBe('drifting +24 kt/min')
    expect(outside).toMatchObject({ rows: null, stats: null, name: '' })
    // A single time: ± 10 s around it.
    expect(single.rows).toEqual([50, 251])
    expect(single.diff).toBeNaN()
  })

  it('starts unticked what is probably not a test point, with the reason', () => {
    const parsed = parseTimesTable(['5-25 250', '15-30 250', '100-120 250', '33-41 250', '55 | not recorded', '2-20 251'].join('\n'))
    const rows = timesRows(ds, { points: [] }, axis, axis, parsed.windows, ds.channels[0])
    expect(rows.map((r) => [r.window.line, r.suggested, r.caution])).toEqual([
      [1, true, ''],
      // Shares rows with line 1.
      [2, false, 'Overlaps line 1'],
      // No sample there.
      [3, false, 'No data here'],
      // 252.8 kt on average (the speed is climbing there), 2.8 kt off the 250 listed.
      [4, false, '2.8 kt off'],
      // Every other line lists a speed.
      [5, false, 'No speed listed'],
      [6, false, 'Overlaps line 1'],
    ])
    // Named all the same, so a row ticked by hand is added under its speed.
    expect(rows[1].name).toBe('250 KIAS (2)')
  })

  it('does not call a scattered window steady, whatever its trend', () => {
    // ± 6 kt every 2 s around 250 kt: no trend, far too much scatter.
    const choppy = t.map((s) => 250 + 6 * Math.sin(Math.PI * s))
    const two = dataset([channel('_Vind,_kias', choppy, 'KIAS', 'kt')], t)
    const [row] = timesRows(two, { points: [] }, elapsedAxis(two), elapsedAxis(two), parseTimesTable('10-40 250').windows, two.channels[0])
    expect(row.steady?.flagged).toBe(false)
    expect(row.scattered).toBe(true)
    expect(row.suggested).toBe(false)
    expect(row.caution).toMatch(/^Scattered ± 4\.\d kt$/)
  })

  it('reads the windows on one axis and shows them on another', () => {
    const real = t.map((s) => s + 33)
    const two = dataset([channel('_Vind,_kias', kias, 'KIAS', 'kt'), channel('_real,_time', real, 'Real', 's')], t)
    const on = timeAxis(two, 'ch:_real,_time')
    const rows = timesRows(two, { points: [point('a', 0, 60, 'Saved')] }, on, elapsedAxis(two), parseTimesTable('38-58 250').windows, two.channels[0])
    expect(rows[0].rows).toEqual([50, 251])
    expect(rows[0].range).toBe('5.0 – 25.0 s')
    expect(rows[0].overlaps?.name).toBe('Saved')
    expect(windowText(on, [50, 251])).toBe('38.0 – 58.0 s')
  })
})
