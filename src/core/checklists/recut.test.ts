import { describe, expect, it } from 'vitest'
import { fill, makeLog, pointAt, ramp, times } from './fixtures'
import { recutFailing, recutPlan, recutPoint } from './recut'
import { runPerfChecks } from './performance'
import type { Check, PointReport } from './types'

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

  it('keeps a slow trim drift inside the 0.02 trim band of a performance point, which the strict 0.002 band would split', () => {
    const t = times(100, 10)
    const lever = fill(t, (tt) => 0.4 + 0.012 * ramp(tt, 21, 0.5) - 0.006 * ramp(tt, 30, 0.5))
    const thrust = fill(t, (_, i) => 10000 * (lever[i] / 0.4))
    // The trim drifts 0.019 over the last 50 s of the point, at a steady rate.
    const trim = fill(t, (tt) => 0.2 + 0.019 * Math.min(1, Math.max(0, (tt - 30) / 50)))
    const ds = makeLog(t, { 'thro1,handl': lever, 'thro2,handl': lever, 'thrst,_1,lb': thrust, 'thrst,_2,lb': thrust, '_trim,_elev': trim })
    const point = pointAt(ds, 'P', 20, 80)
    const perf = recutPoint(ds, point, { trim: true, trimBand: 0.02 })
    expect(perf?.level).toBe('pass')
    expect(ds.elapsed[perf!.start]).toBeGreaterThanOrEqual(30.3)
    expect(ds.elapsed[perf!.end - 1]).toBeCloseTo(80, 0)
    expect(recutPoint(ds, point, { trim: true })?.level).toBe('warn')
  })

  it('hands a performance point’s re-cut the 0.02 trim band (its trim-fixed check warns only on a step), a static point none', () => {
    const report = (status: 'warn' | 'fail'): PointReport[] => [{ pointId: 'p1', name: 'P1', groupId: 'g', status: 'used', label: 'Use', reasons: [], checks: [{ id: 'trim-fixed', status } as Check], worst: status }]
    expect(recutFailing(report('warn'), 'performance').get('p1')).toEqual({ throttle: false, trim: true, trimBand: 0.02 })
    expect(recutFailing(report('warn'), 'static').get('p1')).toEqual({ throttle: false, trim: false, kind: 'static' })
    expect(recutFailing(report('fail'), 'static').get('p1')).toEqual({ throttle: false, trim: true, kind: 'static' })
  })

  it('re-cuts a static point on the setting only: a thrust drift with the lever still does not shorten it', () => {
    const t = times(100, 10)
    // Invented values: the lever is re-set once at 30 s, then stays put while the thrust drifts 4 % (a fixed lever in a
    // slow descent), which the static throttle-fixed check does not judge beside a still setting.
    const lever = fill(t, (tt) => 0.4 + 0.03 * ramp(tt, 30, 0.5))
    const thrust = fill(t, (tt) => 10000 * (1 + (0.04 * Math.max(0, tt - 31)) / 49))
    const ds = makeLog(t, { 'thro1,handl': lever, 'thro2,handl': lever, 'thrst,_1,lb': thrust, 'thrst,_2,lb': thrust })
    const point = pointAt(ds, 'P', 20, 80)
    const st = recutPoint(ds, point, { kind: 'static' })
    expect(st?.level).toBe('pass')
    expect(ds.elapsed[st!.start]).toBeGreaterThanOrEqual(30.4)
    expect(ds.elapsed[st!.end - 1]).toBeCloseTo(80, 0)
    // The performance re-cut also bands the thrust (1 %, else 3 %), so it keeps a shorter stretch.
    const perf = recutPoint(ds, point)
    expect(perf!.seconds).toBeLessThan(st!.seconds)
    // recutPlan hands the static kind through from recutFailing.
    const p = { ...point, id: 'p1', name: 'P1', groupId: 'g' }
    const plan = recutPlan(ds, [p], new Map([['p1', { throttle: true, trim: false, kind: 'static' as const }]]))
    expect(plan[0]?.recut.seconds).toBeCloseTo(st!.seconds, 5)
  })
})
