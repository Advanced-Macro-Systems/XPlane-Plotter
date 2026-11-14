// Down-sampling for display (sparklines, exports with huge point counts). Charts rely on ECharts' own LTTB for
// interactive rendering; these are for places that need the reduced arrays themselves.
// OWNER: analysis agent. Public API below is a contract; keep these signatures.

function copyOf(x: ArrayLike<number>, y: ArrayLike<number>, n: number): { x: Float64Array; y: Float64Array } {
  return { x: Float64Array.from({ length: n }, (_, i) => x[i]), y: Float64Array.from({ length: n }, (_, i) => y[i]) }
}

/**
 * Largest-Triangle-Three-Buckets down-sampling of (x, y) to at most `threshold` points. NaN-aware: gaps (NaN runs)
 * are preserved as a single NaN point so lines still break. Returns the input unchanged when it is already small.
 *
 * A sample is missing when x or y is not finite. The finite runs between gaps are reduced separately, sharing the
 * point budget in proportion to their length (first and last point of every run kept), and joined by one NaN-y
 * point per interior gap; leading and trailing gaps are dropped. If even that minimum does not fit, the shortest
 * runs are left out. The result is always a copy.
 */
export function lttb(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  threshold: number,
): { x: Float64Array; y: Float64Array } {
  const n = Math.min(x.length, y.length)
  const limit = Number.isNaN(threshold) ? 0 : Math.max(0, Math.floor(threshold))
  if (n <= limit) return copyOf(x, y, n)
  if (limit === 0) return { x: new Float64Array(0), y: new Float64Array(0) }

  const finite = (i: number) => Number.isFinite(x[i]) && Number.isFinite(y[i])
  const runs: { start: number; end: number }[] = []
  for (let i = 0; i < n; ) {
    while (i < n && !finite(i)) i += 1
    if (i >= n) break
    const start = i
    while (i < n && finite(i)) i += 1
    runs.push({ start, end: i })
  }
  if (!runs.length) return { x: Float64Array.of(x[0]), y: Float64Array.of(NaN) }

  // Each run needs its end points (1 point for a single sample) and every gap between runs one NaN point.
  const minimum = (r: { start: number; end: number }) => Math.min(limit >= 2 ? 2 : 1, r.end - r.start)
  const byLength = runs.map((_, k) => k).sort((a, b) => runs[b].end - runs[b].start - (runs[a].end - runs[a].start))
  const keep = new Set<number>()
  let cost = 0
  for (const k of byLength) {
    const extra = minimum(runs[k]) + (keep.size > 0 ? 1 : 0)
    if (cost + extra > limit) continue
    keep.add(k)
    cost += extra
  }
  const kept = runs.filter((_, k) => keep.has(k))

  // Share the remaining budget in proportion to how many more points each run could use (largest remainder).
  const capacity = kept.map((r) => r.end - r.start - minimum(r))
  const totalCapacity = capacity.reduce((a, b) => a + b, 0)
  const spare = Math.min(limit - cost, totalCapacity)
  const share = capacity.map((c) => (totalCapacity > 0 ? (spare * c) / totalCapacity : 0))
  const counts = kept.map((r, k) => minimum(r) + Math.floor(share[k]))
  let leftover = spare - share.reduce((a, s) => a + Math.floor(s), 0)
  const byRemainder = share.map((_, k) => k).sort((a, b) => (share[b] % 1) - (share[a] % 1))
  for (const k of byRemainder) {
    if (leftover <= 0) break
    if (counts[k] < kept[k].end - kept[k].start) {
      counts[k] += 1
      leftover -= 1
    }
  }

  const outX: number[] = []
  const outY: number[] = []
  kept.forEach((run, k) => {
    if (k > 0) {
      // One NaN point for the gap, at the gap's first x when it has one.
      const previous = kept[k - 1]
      const gapX = Number.isFinite(x[previous.end]) ? x[previous.end] : (x[previous.end - 1] + x[run.start]) / 2
      outX.push(gapX)
      outY.push(NaN)
    }
    reduceRun(x, y, run.start, run.end, counts[k], outX, outY)
  })
  return { x: Float64Array.from(outX), y: Float64Array.from(outY) }
}

/** Standard LTTB of the finite run [start, end) to `count` points, appended to outX/outY. */
function reduceRun(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  start: number,
  end: number,
  count: number,
  outX: number[],
  outY: number[],
): void {
  const len = end - start
  if (count >= len) {
    for (let i = start; i < end; i += 1) {
      outX.push(x[i])
      outY.push(y[i])
    }
    return
  }
  outX.push(x[start])
  outY.push(y[start])
  if (count === 1) return
  const every = (len - 2) / (count - 2)
  let a = start
  for (let b = 0; b < count - 2; b += 1) {
    // Average of the next bucket: the third corner of the triangle.
    const avgStart = start + Math.floor((b + 1) * every) + 1
    const avgEnd = Math.min(start + Math.floor((b + 2) * every) + 1, end)
    let avgX = 0
    let avgY = 0
    for (let j = avgStart; j < avgEnd; j += 1) {
      avgX += x[j]
      avgY += y[j]
    }
    avgX /= avgEnd - avgStart
    avgY /= avgEnd - avgStart
    // Keep the point of this bucket that makes the largest triangle with the previous pick and that average.
    const from = start + Math.floor(b * every) + 1
    const to = start + Math.floor((b + 1) * every) + 1
    const ax = x[a]
    const ay = y[a]
    let best = from
    let bestArea = -1
    for (let j = from; j < to; j += 1) {
      const area = Math.abs((ax - avgX) * (y[j] - ay) - (ax - x[j]) * (avgY - ay))
      if (area > bestArea) {
        bestArea = area
        best = j
      }
    }
    outX.push(x[best])
    outY.push(y[best])
    a = best
  }
  outX.push(x[end - 1])
  outY.push(y[end - 1])
}

/**
 * Keeps the min and max of each of `buckets` equal-width index buckets (good for sparklines of noisy data).
 *
 * Within a bucket the two points keep their original order (one point when min and max coincide). Samples with a
 * non-finite x or y are ignored; a bucket with none becomes a single NaN-y point (a line break), except at the
 * start and end. Returns a copy of the input when it has no more than 2 × buckets samples.
 */
export function minMaxDecimate(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  buckets: number,
): { x: Float64Array; y: Float64Array } {
  const n = Math.min(x.length, y.length)
  const b = Number.isNaN(buckets) ? 1 : Math.max(1, Math.floor(buckets))
  if (n <= 2 * b) return copyOf(x, y, n)
  const outX: number[] = []
  const outY: number[] = []
  const push = (i: number) => {
    outX.push(x[i])
    outY.push(y[i])
  }
  for (let k = 0; k < b; k += 1) {
    const start = Math.floor((k * n) / b)
    const end = Math.floor(((k + 1) * n) / b)
    let iMin = -1
    let iMax = -1
    for (let i = start; i < end; i += 1) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
      if (iMin < 0 || y[i] < y[iMin]) iMin = i
      if (iMax < 0 || y[i] > y[iMax]) iMax = i
    }
    if (iMin < 0) {
      if (outY.length > 0 && !Number.isNaN(outY[outY.length - 1])) {
        outX.push(Number.isFinite(x[start]) ? x[start] : NaN)
        outY.push(NaN)
      }
      continue
    }
    if (iMin === iMax) push(iMin)
    else if (iMin < iMax) {
      push(iMin)
      push(iMax)
    } else {
      push(iMax)
      push(iMin)
    }
  }
  if (outY.length > 0 && Number.isNaN(outY[outY.length - 1])) {
    outX.pop()
    outY.pop()
  }
  return { x: Float64Array.from(outX), y: Float64Array.from(outY) }
}
