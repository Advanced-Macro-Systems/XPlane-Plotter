import { describe, expect, it } from 'vitest'
import { clampRowRange, driftPerMinute, rangeStats } from './stats'

describe('rangeStats', () => {
  it('computes n, mean, sample std, min, max and rms over a half-open range', () => {
    const v = [100, 2, 4, 4, 4, 5, 5, 7, 9, 100]
    const s = rangeStats(v, 1, 9)
    expect(s.n).toBe(8)
    expect(s.mean).toBe(5)
    // Σ(x − 5)² = 32 → sample variance 32/7
    expect(s.std).toBeCloseTo(Math.sqrt(32 / 7), 12)
    expect(s.min).toBe(2)
    expect(s.max).toBe(9)
    expect(s.rms).toBeCloseTo(Math.sqrt((4 + 16 * 3 + 25 * 2 + 49 + 81) / 8), 12)
  })

  it('skips NaN and infinite samples', () => {
    const s = rangeStats(Float64Array.of(1, NaN, 3, Infinity, -Infinity, 5), 0, 6)
    expect(s.n).toBe(3)
    expect(s.mean).toBe(3)
    expect(s.std).toBe(2)
    expect(s.min).toBe(1)
    expect(s.max).toBe(5)
  })

  it('clamps the range to the array and handles empty and single-sample ranges', () => {
    const v = Float64Array.of(1, 2, 3)
    expect(rangeStats(v, -5, 100)).toMatchObject({ n: 3, mean: 2, min: 1, max: 3 })
    const empty = rangeStats(v, 2, 2)
    expect(empty.n).toBe(0)
    for (const key of ['mean', 'std', 'min', 'max', 'rms'] as const) expect(Number.isNaN(empty[key])).toBe(true)
    expect(rangeStats(v, 3, 1).n).toBe(0)
    expect(rangeStats(v, NaN, 2).n).toBe(0)
    const one = rangeStats(v, 1, 2)
    expect(one).toEqual({ n: 1, mean: 2, std: 0, min: 2, max: 2, rms: 2 })
    expect(rangeStats([NaN, NaN], 0, 2).n).toBe(0)
  })

  it('stays accurate for a large offset (Welford)', () => {
    const offset = 1e9
    const v = Float64Array.from({ length: 1000 }, (_, i) => offset + (i % 2 === 0 ? 0.25 : -0.25))
    const s = rangeStats(v, 0, v.length)
    expect(s.mean).toBeCloseTo(offset, 6)
    expect(s.std).toBeCloseTo(0.25 * Math.sqrt(1000 / 999), 9)
    expect(s.rms).toBeCloseTo(Math.sqrt(offset * offset + 0.0625), 3)
  })

  it('reports zero spread for constant data', () => {
    const s = rangeStats(new Float64Array(50).fill(0.1), 0, 50)
    expect(s.std).toBe(0)
    expect(s.mean).toBeCloseTo(0.1, 15)
    expect(s.rms).toBeCloseTo(0.1, 15)
  })
})

describe('driftPerMinute', () => {
  it('returns the least-squares slope per minute', () => {
    const time = Float64Array.from({ length: 101 }, (_, i) => 3600 + i * 0.1)
    // 0.5 units per second → 30 per minute, with a symmetric zero-mean wiggle that does not bias the slope.
    const values = Float64Array.from(time, (t, i) => 250 + 0.5 * (t - 3600) + (i % 2 === 0 ? 0.01 : -0.01))
    expect(driftPerMinute(values, time, 0, values.length)).toBeCloseTo(30, 3)
    expect(driftPerMinute(values, time, 10, 20)).toBeCloseTo(30, 0)
  })

  it('is NaN with fewer than 3 finite pairs or no time spread', () => {
    const time = Float64Array.of(0, 1, 2, 3)
    expect(driftPerMinute(Float64Array.of(1, NaN, 3, NaN), time, 0, 4)).toBeNaN()
    expect(driftPerMinute(Float64Array.of(1, 2, 3, 4), Float64Array.of(5, 5, 5, 5), 0, 4)).toBeNaN()
    expect(driftPerMinute(Float64Array.of(1, 2, 3, 4), time, 0, 2)).toBeNaN()
  })

  it('skips pairs with a missing value or time', () => {
    const time = Float64Array.of(0, 1, NaN, 3, 4)
    const values = Float64Array.of(0, 2, 99, NaN, 8)
    expect(driftPerMinute(values, time, 0, 5)).toBeCloseTo(120, 9)
  })
})

describe('clampRowRange', () => {
  it('returns integer bounds of [start, end) inside the array', () => {
    expect(clampRowRange(10, 2, 5)).toEqual([2, 5])
    expect(clampRowRange(10, -3, 50)).toEqual([0, 10])
    expect(clampRowRange(10, 1.5, 3.2)).toEqual([2, 4])
    expect(clampRowRange(10, 7, 3)).toEqual([7, 7])
    expect(clampRowRange(10, NaN, 3)).toEqual([0, 0])
  })
})
