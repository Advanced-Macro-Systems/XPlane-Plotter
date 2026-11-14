import { describe, expect, it } from 'vitest'
import { lttb, minMaxDecimate } from './decimate'

function noisySine(n: number): { x: Float64Array; y: Float64Array } {
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const x = Float64Array.from({ length: n }, (_, i) => i * 0.01)
  const y = Float64Array.from(x, (v) => Math.sin(v) + 0.05 * (rand() - 0.5))
  return { x, y }
}

function isNonDecreasing(values: Float64Array): boolean {
  for (let i = 1; i < values.length; i += 1) if (values[i] < values[i - 1]) return false
  return true
}

/** Number of NaN-y points and whether two ever follow each other or sit at an end. */
function gapShape(y: Float64Array): { gaps: number; doubled: boolean; atEnds: boolean } {
  let gaps = 0
  let doubled = false
  for (let i = 0; i < y.length; i += 1) {
    if (!Number.isNaN(y[i])) continue
    gaps += 1
    if (i > 0 && Number.isNaN(y[i - 1])) doubled = true
  }
  return { gaps, doubled, atEnds: Number.isNaN(y[0]) || Number.isNaN(y[y.length - 1]) }
}

describe('lttb', () => {
  it('returns a copy of small inputs', () => {
    const x = Float64Array.of(0, 1, 2)
    const y = Float64Array.of(5, NaN, 7)
    const out = lttb(x, y, 10)
    expect(Array.from(out.x)).toEqual([0, 1, 2])
    expect(Array.from(out.y)).toEqual([5, NaN, 7])
    expect(out.x).not.toBe(x)
    expect(lttb([1, 2], [3, 4], 2).y).toEqual(Float64Array.of(3, 4))
  })

  it('reduces to exactly `threshold` points, keeping the first and last and following the shape', () => {
    const { x, y } = noisySine(10000)
    const out = lttb(x, y, 200)
    expect(out.x).toHaveLength(200)
    expect(out.x[0]).toBe(x[0])
    expect(out.x[199]).toBe(x[x.length - 1])
    expect(out.y[199]).toBe(y[y.length - 1])
    expect(isNonDecreasing(out.x)).toBe(true)
    // Every kept point is an input sample.
    for (let k = 0; k < out.x.length; k += 1) expect(out.y[k]).toBe(y[Math.round(out.x[k] / 0.01)])
    // The extremes of the sine survive.
    expect(Math.max(...out.y)).toBeGreaterThan(0.99)
    expect(Math.min(...out.y)).toBeLessThan(-0.99)
  })

  it('keeps an isolated spike', () => {
    const x = Float64Array.from({ length: 5000 }, (_, i) => i)
    const y = new Float64Array(5000)
    y[2345] = 50
    const out = lttb(x, y, 100)
    expect(Array.from(out.y)).toContain(50)
  })

  it('preserves NaN gaps as one NaN point each and drops leading and trailing gaps', () => {
    const n = 3000
    const x = Float64Array.from({ length: n }, (_, i) => i)
    const y = Float64Array.from(x, (v) => Math.cos(v / 100))
    for (const [a, b] of [
      [0, 50],
      [1000, 1100],
      [1500, 1501],
      [2900, 3000],
    ]) {
      for (let i = a; i < b; i += 1) y[i] = NaN
    }
    const out = lttb(x, y, 120)
    expect(out.x.length).toBeLessThanOrEqual(120)
    expect(gapShape(out.y)).toEqual({ gaps: 2, doubled: false, atEnds: false })
    expect(out.x[0]).toBe(50)
    expect(out.x[out.x.length - 1]).toBe(2899)
    // The gap markers sit where the gaps start, so a line through the result breaks in the right places.
    const gapXs = Array.from(out.x).filter((_, k) => Number.isNaN(out.y[k]))
    expect(gapXs).toEqual([1000, 1500])
    expect(isNonDecreasing(out.x)).toBe(true)
  })

  it('treats a non-finite x as missing too', () => {
    const x = Float64Array.from({ length: 100 }, (_, i) => (i === 40 ? NaN : i))
    const y = Float64Array.from({ length: 100 }, (_, i) => i % 7)
    const out = lttb(x, y, 20)
    expect(gapShape(out.y).gaps).toBe(1)
    expect(out.x.length).toBeLessThanOrEqual(20)
  })

  it('stays within budget when there are more gaps than points allowed', () => {
    const x = Float64Array.from({ length: 1000 }, (_, i) => i)
    // Alternating short runs and gaps, plus one long run at the end.
    const y = Float64Array.from(x, (v) => (v < 600 && v % 4 >= 2 ? NaN : Math.sin(v / 30)))
    const out = lttb(x, y, 25)
    expect(out.x.length).toBeLessThanOrEqual(25)
    const shape = gapShape(out.y)
    expect(shape.doubled).toBe(false)
    expect(shape.atEnds).toBe(false)
    expect(out.x[out.x.length - 1]).toBe(999)
  })

  it('handles tiny thresholds and all-NaN input', () => {
    const { x, y } = noisySine(100)
    expect(lttb(x, y, 0).x).toHaveLength(0)
    expect(Array.from(lttb(x, y, 1).x)).toEqual([0])
    expect(Array.from(lttb(x, y, 2).x)).toEqual([0, x[99]])
    const allNaN = lttb([1, 2, 3, 4], [NaN, NaN, NaN, NaN], 2)
    expect(allNaN.y).toHaveLength(1)
    expect(Number.isNaN(allNaN.y[0])).toBe(true)
  })
})

describe('minMaxDecimate', () => {
  it('returns a copy of small inputs', () => {
    const out = minMaxDecimate([0, 1, 2, 3], [4, 3, 2, 1], 2)
    expect(Array.from(out.y)).toEqual([4, 3, 2, 1])
  })

  it('keeps the min and max of every bucket in their original order', () => {
    const x = Float64Array.from({ length: 12 }, (_, i) => i)
    const y = Float64Array.of(1, 9, 5, /**/ 7, 2, 3, /**/ 4, 4, 4, /**/ 0, 8, 6)
    const out = minMaxDecimate(x, y, 4)
    expect(Array.from(out.x)).toEqual([0, 1, 3, 4, 6, 9, 10])
    expect(Array.from(out.y)).toEqual([1, 9, 7, 2, 4, 0, 8])
  })

  it('never loses the global extremes of a long noisy series', () => {
    const { x, y } = noisySine(20000)
    y[12345] = 9
    y[777] = -9
    const out = minMaxDecimate(x, y, 50)
    expect(out.x.length).toBeLessThanOrEqual(100)
    expect(Math.max(...out.y)).toBe(9)
    expect(Math.min(...out.y)).toBe(-9)
    expect(isNonDecreasing(out.x)).toBe(true)
  })

  it('marks empty (all-NaN) buckets with one NaN point, except at the ends', () => {
    const x = Float64Array.from({ length: 40 }, (_, i) => i)
    const y = Float64Array.from(x, (v) => (v < 5 || (v >= 15 && v < 25) || v >= 35 ? NaN : v))
    const out = minMaxDecimate(x, y, 8)
    expect(gapShape(out.y)).toEqual({ gaps: 1, doubled: false, atEnds: false })
    expect(out.x[0]).toBe(5)
    expect(out.x[out.x.length - 1]).toBe(34)
  })
})
