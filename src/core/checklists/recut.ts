// "Re-cut this point": the longest stretch of a test point where the power setting (and, when asked, the pitch trim)
// stayed still, for a point the checklist failed because the throttle or the trim moved inside it. Find steady points
// accepts the power within ± 3 % of its level, so a window it finds can start while the pilot is still trimming the
// throttle; this keeps only the part the throttle-fixed check passes (or, failing that, warns about). Pure.

import type { Dataset, TestPoint } from '../types'
import type { Check, PointReport } from './types'
import {
  engineChannels,
  findChannel,
  leverChannels,
  N1,
  POWER_HP,
  smoothInside,
  sumChannels,
  THRUST,
} from './helpers'

/** A series over rows [a, b) (indexed from a) and the width its values must stay within. */
interface Band {
  values: ArrayLike<number>
  width: number
}

/** The longest stretch [start, end) of rows [a, b) where every band holds (max − min ≤ width), by two pointers. */
function longestStill(bands: readonly Band[], time: ArrayLike<number>, a: number, b: number): [number, number] | null {
  const n = b - a
  const queues = bands.map(() => ({ max: [] as number[], min: [] as number[] }))
  let start = 0
  let best: [number, number] | null = null
  let bestSeconds = -1
  for (let end = 0; end < n; end += 1) {
    if (!bands.every((band) => Number.isFinite(band.values[end]))) {
      // A gap in any series ends the stretch.
      start = end + 1
      for (const q of queues) {
        q.max.length = 0
        q.min.length = 0
      }
      continue
    }
    bands.forEach(({ values }, i) => {
      const q = queues[i]
      const v = values[end]
      while (q.max.length && values[q.max[q.max.length - 1]] <= v) q.max.pop()
      q.max.push(end)
      while (q.min.length && values[q.min[q.min.length - 1]] >= v) q.min.pop()
      q.min.push(end)
    })
    const outside = () => bands.some(({ values, width }, i) => values[queues[i].max[0]] - values[queues[i].min[0]] > width)
    while (outside()) {
      start += 1
      for (const q of queues) {
        while (q.max.length && q.max[0] < start) q.max.shift()
        while (q.min.length && q.min[0] < start) q.min.shift()
      }
    }
    const seconds = time[a + end] - time[a + start]
    if (seconds > bestSeconds) {
      best = [a + start, a + end + 1]
      bestSeconds = seconds
    }
  }
  return best
}

export interface Recut {
  start: number
  end: number
  seconds: number
  /** The bands it met: the throttle-fixed pass limits, or its warn limits when no 10 s stretch meets those */
  level: 'pass' | 'warn'
}

/**
 * The longest still stretch of a point: every lever within 0.002 (else 0.01) and the summed thrust (else engine power,
 * smoothed over ±1 s inside the point) within 1 % (else 3 %) of its median; N1 within 0.5 (else 1.5) %pt without either;
 * with `trim`, the pitch trim within 0.002 (else 0.02) too. A stretch that ends before the point does ends a second
 * short of the change (thrust and speed follow the lever). Null when no stretch of at least `minSeconds` exists.
 */
export function recutPoint(ds: Dataset, point: Pick<TestPoint, 'start' | 'end'>, options: { trim?: boolean; minSeconds?: number } = {}): Recut | null {
  const a = Math.max(0, point.start)
  const b = Math.min(ds.rowCount, point.end)
  if (b - a < 3) return null
  const time = ds.elapsed
  const minSeconds = options.minSeconds ?? 5
  const levers = leverChannels(ds)
  const thrusts = engineChannels(ds, THRUST)
  const powers = engineChannels(ds, POWER_HP)
  const n1s = engineChannels(ds, N1)
  const trim = options.trim ? findChannel(ds, '_trim,_elev') : null
  const force = thrusts.length ? thrusts : powers
  const forceSum = force.length ? smoothInside(sumChannels(force, a, b), time.subarray(a, b), 0, b - a, 1) : null
  const forceLevel = forceSum ? Math.abs(medianOf(forceSum)) : NaN
  const bandsFor = (level: 'pass' | 'warn'): Band[] => {
    const w = level === 'pass' ? { lever: 0.002, force: 0.01, n1: 0.5, trim: 0.002 } : { lever: 0.01, force: 0.03, n1: 1.5, trim: 0.02 }
    const bands: Band[] = levers.map((ch) => ({ values: ch.values.subarray(a, b), width: w.lever }))
    if (forceSum && forceLevel > 0) bands.push({ values: forceSum, width: w.force * forceLevel })
    else for (const ch of n1s) bands.push({ values: smoothInside(ch.values, time, a, b, 1), width: w.n1 })
    if (trim) bands.push({ values: trim.values.subarray(a, b), width: w.trim })
    return bands
  }
  const pick = (level: 'pass' | 'warn'): Recut | null => {
    const bands = bandsFor(level)
    if (!bands.length) return null
    const found = longestStill(bands, time, a, b)
    if (!found) return null
    const start = found[0]
    let end = found[1]
    // A change follows: end a second before it.
    if (end < b) while (end - start > 2 && time[end - 1] > time[found[1] - 1] - 1) end -= 1
    const seconds = time[end - 1] - time[start]
    return seconds >= minSeconds ? { start, end, seconds, level } : null
  }
  const strict = pick('pass')
  if (strict && strict.seconds >= Math.min(10, 0.5 * (time[b - 1] - time[a]))) return strict
  const loose = pick('warn')
  if (loose && (!strict || loose.seconds > strict.seconds)) return loose
  return strict
}

function medianOf(values: ArrayLike<number>): number {
  const xs = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y)
  if (!xs.length) return NaN
  const mid = xs.length >> 1
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

/** The points a re-cut would change: those whose throttle-fixed (or trim-fixed) check failed, with their new rows. */
export function recutPlan(
  ds: Dataset,
  points: readonly TestPoint[],
  failing: ReadonlyMap<string, { throttle: boolean; trim: boolean }>,
): { point: TestPoint; recut: Recut }[] {
  const out: { point: TestPoint; recut: Recut }[] = []
  for (const point of points) {
    const why = failing.get(point.id)
    if (!why || (!why.throttle && !why.trim)) continue
    const recut = recutPoint(ds, point, { trim: why.trim })
    if (recut && (recut.start !== point.start || recut.end !== point.end)) out.push({ point, recut })
  }
  return out
}

/**
 * What recutPlan takes, from a set checklist's point reports: throttle-fixed failed, or trim-fixed failed (in the
 * performance checklist, where trim-fixed never fails, also when it warned). The Test points panel's "Re-cut … flagged
 * points" and the set verdicts use the same map, so they count the same points.
 */
export function recutFailing(reports: readonly PointReport[], kind: 'static' | 'performance'): Map<string, { throttle: boolean; trim: boolean }> {
  return new Map(
    reports.map((p) => [
      p.pointId,
      {
        throttle: p.checks.some((c) => c.id === 'throttle-fixed' && c.status === 'fail'),
        trim: p.checks.some((c) => c.id === 'trim-fixed' && (c.status === 'fail' || (kind === 'performance' && c.status === 'warn'))),
      },
    ]),
  )
}

/**
 * For a set verdict: how many points a re-cut would change (`flagged`, as the panel's button counts them) and how many
 * of those failed no critical check but throttle-fixed or trim-fixed (`fixable`: a re-cut alone may make them usable,
 * without flying again).
 */
export function recutCounts(
  ds: Dataset,
  points: readonly TestPoint[],
  reports: readonly PointReport[],
  kind: 'static' | 'performance',
  isCritical: (c: Check) => boolean,
): { flagged: number; fixable: number } {
  const plan = recutPlan(ds, points, recutFailing(reports, kind))
  const byId = new Map(reports.map((r) => [r.pointId, r]))
  const fixable = plan.filter(({ point }) => {
    const r = byId.get(point.id)
    return r?.status === 'excluded' && r.checks.every((c) => c.status !== 'fail' || !isCritical(c) || c.id === 'throttle-fixed' || c.id === 'trim-fixed')
  }).length
  return { flagged: plan.length, fixable }
}
