import { describe, expect, it } from 'vitest'
import { sparkGeometry, sparkSeries } from './sparkline'

describe('sparkGeometry', () => {
  it('scales into the box with the largest value at the top', () => {
    const g = sparkGeometry([0, 1, 2], [0, 10, 5], 104, 24, 2)
    expect(g.empty).toBe(false)
    expect(g.flat).toBe(false)
    expect(g.paths).toEqual([
      [
        [2, 22],
        [52, 2],
        [102, 12],
      ],
    ])
  })

  it('breaks the line at missing samples', () => {
    const g = sparkGeometry([0, 1, 2, 3, 4], [1, 2, Number.NaN, 3, 4], 100, 20)
    expect(g.paths.map((p) => p.length)).toEqual([2, 2])
  })

  it('draws a flat series at mid height', () => {
    const g = sparkGeometry([0, 1, 2], [7, 7, 7], 100, 20)
    expect(g.flat).toBe(true)
    expect(g.paths[0].every(([, y]) => y === 10)).toBe(true)
  })

  it('reports a series without values as empty', () => {
    expect(sparkGeometry([0, 1], [Number.NaN, Number.NaN], 100, 20)).toEqual({ paths: [], flat: false, empty: true })
    expect(sparkGeometry([], [], 100, 20).empty).toBe(true)
  })

  it('centres a single sample', () => {
    const g = sparkGeometry([5], [3], 100, 20)
    expect(g.paths).toEqual([[[50, 10]]])
  })
})

describe('sparkSeries', () => {
  const n = 10_000
  const x = Float64Array.from({ length: n }, (_, i) => i / 10)
  const y = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 300))

  it('decimates to about two points per bucket', () => {
    const s = sparkSeries(x, y, 120)
    expect(s.x.length).toBeLessThanOrEqual(240)
    expect(s.x.length).toBeGreaterThan(120)
  })

  it('computes once per channel and bucket count', () => {
    expect(sparkSeries(x, y, 120)).toBe(sparkSeries(x, y, 120))
    expect(sparkSeries(x, y, 60)).not.toBe(sparkSeries(x, y, 120))
    expect(sparkSeries(x.slice(), y, 120)).not.toBe(sparkSeries(x, y, 120))
  })
})
