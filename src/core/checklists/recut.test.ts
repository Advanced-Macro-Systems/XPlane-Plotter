import { describe, expect, it } from 'vitest'
import { fill, makeLog, pointAt, ramp, times } from './fixtures'
import { recutPlan, recutPoint } from './recut'
import { runPerfChecks } from './performance'

// A synthetic 60 s record at 10 Hz (invented values) with the throttle trimmed twice in its first 12 s.
function hunting(trimStepAt?: number) {
  const t = times(100, 10)
  const lever = fill(t, (tt) => 0.4 + 0.012 * ramp(tt, 21, 0.5) - 0.006 * ramp(tt, 30, 0.5))
  const thrust = fill(t, (_, i) => 10000 * (lever[i] / 0.4))
  const ds = makeLog(t, {
    'thro1,handl': lever,
    'thro2,handl': lever,
    'thrst,_1,lb': thrust,
    'thrst,_2,lb': thrust,
    '_trim,_elev': fill(t, (tt) => (trimStepAt !== undefined && tt >= trimStepAt ? 0.3 : 0.2)),
  })
  return { ds, point: pointAt(ds, 'P', 20, 80) }
}

describe('recutPoint', () => {
  it('keeps the longest stretch after the last throttle change', () => {
    const { ds, point } = hunting()
    const r = recutPoint(ds, point)
    expect(r?.level).toBe('pass')
    expect(ds.elapsed[r!.start]).toBeGreaterThanOrEqual(30.3)
    expect(ds.elapsed[r!.end - 1]).toBeCloseTo(80, 0)
    // The re-cut point passes throttle-fixed.
    const x = ds.channels[0]
    const report = runPerfChecks({ ds, points: [{ ...point, id: 'p', name: 'P', groupId: 'g', start: r!.start, end: r!.end }], x, y: x, fit: 'none' })
    expect(report.points[0].checks.find((c) => c.id === 'throttle-fixed')?.status).toBe('pass')
  })

  it('also splits at a trim step when asked, ending a second before it', () => {
    const { ds, point } = hunting(70)
    const r = recutPoint(ds, point, { trim: true })
    expect(ds.elapsed[r!.start]).toBeGreaterThanOrEqual(30.3)
    expect(ds.elapsed[r!.end - 1]).toBeLessThanOrEqual(69)
  })

  it('plans only the failing points that change', () => {
    const { ds, point } = hunting()
    const p = { ...point, id: 'p1', name: 'P1', groupId: 'g' }
    expect(recutPlan(ds, [p], new Map([['p1', { throttle: true, trim: false }]]))).toHaveLength(1)
    expect(recutPlan(ds, [p], new Map())).toHaveLength(0)
  })
})
