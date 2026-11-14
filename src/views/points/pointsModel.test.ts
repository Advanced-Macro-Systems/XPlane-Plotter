import { describe, expect, it } from 'vitest'
import { channel, dataset, elapsedAxis, range, workspace } from '../xy/xyFixtures'
import {
  buildPointRows,
  driftSummary,
  driftText,
  formatMeanSd,
  framedRange,
  pointCounts,
  reinsertPoint,
  sortPointRows,
  steadiness,
  suggestPointName,
} from './pointsModel'

const stats = (mean: number, std: number, n = 100) => ({ n, mean, std, min: mean, max: mean, rms: mean })
const kt = { meta: { unit: 'kt' }, stats: { std: 40 } }

describe('formatMeanSd', () => {
  it('prints σ to 2 significant figures and the mean to the same place', () => {
    expect(formatMeanSd(250.3127, 0.4231)).toEqual({ mean: '250.31', sd: '0.42' })
    expect(formatMeanSd(0.41234, 0.0021)).toEqual({ mean: '0.4123', sd: '0.0021' })
    expect(formatMeanSd(12003.4, 12.4)).toEqual({ mean: '12003', sd: '12' })
    expect(formatMeanSd(-2.5, 0.04)).toEqual({ mean: '−2.500', sd: '0.040' })
  })

  it('copes with zero, missing and tiny spreads', () => {
    expect(formatMeanSd(3, 0)).toEqual({ mean: '3', sd: '0' })
    expect(formatMeanSd(NaN, 1)).toEqual({ mean: '—', sd: '' })
    expect(formatMeanSd(1.5, NaN)).toEqual({ mean: '1.5', sd: '' })
    expect(formatMeanSd(0.5, 1.2e-9)).toEqual({ mean: '0.5', sd: '1.2e−9' })
  })
})

describe('steadiness', () => {
  it('flags a trend that moves the value more than twice its scatter', () => {
    // 3 kt/min over 40 s = 2 kt > 2σ = 1 kt
    expect(steadiness(stats(250, 0.5), -3, 40, kt)).toMatchObject({ flagged: true, change: 2, limit: 1 })
    // 1 kt/min over 40 s = 0.67 kt < 2σ
    expect(steadiness(stats(250, 0.5), 1, 40, kt).flagged).toBe(false)
  })

  it('does not flag tiny trends in very steady data (the floor)', () => {
    // σ ≈ 0: 0.3 kt/min over 60 s = 0.3 kt, under the 0.5 kt floor for knots and 2% of the file spread (0.8 kt)
    expect(steadiness(stats(250, 0.001), 0.3, 60, kt).flagged).toBe(false)
    // unknown unit: 2% of the file spread
    const other = { meta: { unit: 'zz' }, stats: { std: 10 } }
    expect(steadiness(stats(5, 0), 0.1, 60, other)).toMatchObject({ flagged: false, limit: 0.2 })
    expect(steadiness(stats(5, 0), 0.3, 60, other).flagged).toBe(true)
  })

  it('needs at least 3 samples and a finite drift', () => {
    expect(steadiness(stats(250, 0.5, 2), -30, 40, kt).flagged).toBe(false)
    expect(steadiness(stats(250, 0.5), NaN, 40, kt).flagged).toBe(false)
  })

  it('describes the drift with its sign and unit', () => {
    expect(driftText(-3.21, 'kt')).toBe('drifting −3.2 kt/min')
    expect(driftText(45, 'ft')).toBe('drifting +45 ft/min')
    expect(driftText(0.5, '')).toBe('drifting +0.5 per min')
    expect(driftText(NaN, 'kt')).toBe('')
  })
})

describe('buildPointRows', () => {
  const t = range(121) // 0..120 s at 1 Hz
  const ds = dataset(
    [
      channel('_totl,_time', t, 'Sim time', 's'),
      channel('_Vind,_kias', t.map((s) => 250 + (s < 60 ? 0 : (s - 60) * 0.5) + (s % 2 ? 0.2 : -0.2)), 'KIAS', 'kt'),
      channel('p-alt,ftMSL', t.map(() => 12000), 'Altitude', 'ft'),
    ],
    t,
    { timeSourceId: '_totl,_time' },
  )
  const ws = workspace({
    points: [
      { id: 't1', name: 'Steady', groupId: 'g1', start: 0, end: 50 },
      { id: 't2', name: 'Accelerating', groupId: 'g2', start: 70, end: 120 },
      { id: 't3', name: 'Lost group', groupId: 'gone', start: 10, end: 20 },
    ],
  })
  const tracked = ds.channels

  it('computes range, duration and mean ± σ per tracked channel', () => {
    const rows = buildPointRows(ds, ws, elapsedAxis(ds), tracked)
    expect(rows.map((r) => [r.point.id, r.rows, r.seconds, r.from, r.to])).toEqual([
      ['t1', 50, 49, '0.00 s', '49.0 s'],
      ['t2', 50, 49, '70.0 s', '119.0 s'],
      ['t3', 10, 9, '10.0 s', '19.0 s'],
    ])
    expect(rows[0].cells[1].stats.mean).toBeCloseTo(250)
    expect(rows[2].group.id).toBe('g1') // unknown group: shown in the first group
  })

  it('flags drifting channels and never judges the time channel', () => {
    const rows = buildPointRows(ds, ws, elapsedAxis(ds), tracked)
    expect(rows[0].drifting).toHaveLength(0)
    expect(rows[0].cells[0].steady).toBeNull()
    expect(rows[1].drifting.map((c) => c.channel.id)).toEqual(['_Vind,_kias'])
    expect(rows[1].cells[1].hint).toBe('drifting +30 kt/min')
    expect(rows[1].cells[2].steady?.flagged).toBe(false)
  })

  it('counts steady, drifting and hidden points and summarises the drift', () => {
    const hidden = { ...ws, points: ws.points.map((p) => (p.id === 't3' ? { ...p, hidden: true } : p)) }
    const rows = buildPointRows(ds, hidden, elapsedAxis(ds), tracked)
    expect(pointCounts(rows)).toEqual({ total: 3, steady: 2, drifting: 1, hidden: 1, unjudged: 0 })
    expect(driftSummary(rows[1])).toBe('KIAS drifting +30 kt/min')
    expect(pointCounts(buildPointRows(ds, ws, elapsedAxis(ds), [])).unjudged).toBe(3)
  })

  it('sorts by time, name and group', () => {
    const rows = buildPointRows(ds, ws, elapsedAxis(ds), [])
    const ids = (sorted: typeof rows) => sorted.map((r) => r.point.id)
    expect(ids(sortPointRows(rows, 'time', 'asc', ws.groups))).toEqual(['t1', 't3', 't2'])
    expect(ids(sortPointRows(rows, 'time', 'desc', ws.groups))).toEqual(['t2', 't3', 't1'])
    expect(ids(sortPointRows(rows, 'name', 'asc', ws.groups))).toEqual(['t2', 't3', 't1'])
    expect(ids(sortPointRows(rows, 'group', 'asc', ws.groups))).toEqual(['t1', 't3', 't2'])
  })
})

describe('suggestPointName', () => {
  const ds = dataset([channel('_Vind,_kias', [249.6, 250.2, 250.4, 120], 'KIAS', 'kt')], [0, 1, 2, 3])

  it('names a point after its mean indicated airspeed, made unique', () => {
    expect(suggestPointName(ds, [0, 3], [])).toBe('250 KIAS')
    expect(suggestPointName(ds, [0, 3], ['250 kias', '250 KIAS (2)'])).toBe('250 KIAS (3)')
  })

  it('falls back to a numbered name', () => {
    const plain = dataset([channel('x', [1, 2], 'X', '')], [0, 1])
    expect(suggestPointName(plain, [0, 2], ['A', 'B'])).toBe('Point 3')
  })
})

describe('framedRange', () => {
  it('adds 10% each side', () => {
    expect(framedRange(100, 200)).toEqual([90, 210])
    expect(framedRange(5, 6)).toEqual([4, 7])
  })
})

describe('reinsertPoint', () => {
  const ws = workspace({
    points: [
      { id: 'a', name: 'A', groupId: 'g1', start: 0, end: 2 },
      { id: 'c', name: 'C', groupId: 'g1', start: 4, end: 6 },
    ],
  })

  it('puts a deleted point back in its place with its id', () => {
    const next = reinsertPoint(ws, { id: 'b', name: 'B', groupId: 'g2', start: 2, end: 4 }, 1)
    expect(next.points.map((p) => [p.id, p.groupId])).toEqual([
      ['a', 'g1'],
      ['b', 'g2'],
      ['c', 'g1'],
    ])
  })

  it('falls back to the first group and leaves an existing id alone', () => {
    expect(reinsertPoint(ws, { id: 'b', name: 'B', groupId: 'gone', start: 2, end: 4 }, 9).points[2].groupId).toBe('g1')
    expect(reinsertPoint(ws, { id: 'a', name: 'A', groupId: 'g1', start: 0, end: 2 }, 0)).toBe(ws)
  })
})
