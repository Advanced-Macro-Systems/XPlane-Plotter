import { describe, expect, it } from 'vitest'
import { evalPoly, formatFit, formatMagnitude, formatNumber, polyFit, type PolyFit } from './fit'

const MINUS = '−'

describe('polyFit', () => {
  it('recovers exact polynomials of degree 1, 2 and 3', () => {
    const x = Float64Array.from({ length: 21 }, (_, i) => -3 + 0.37 * i)
    for (const coeffs of [
      [1.5, -2],
      [0.3, -1.2, 0.05],
      [2, 0.5, -0.25, 0.125],
    ]) {
      const degree = coeffs.length - 1
      const y = Float64Array.from(x, (v) => evalPoly(coeffs, v))
      const fit = polyFit(x, y, degree)
      expect(fit).not.toBeNull()
      if (!fit) continue
      expect(fit.degree).toBe(degree)
      fit.coeffs.forEach((c, k) => expect(c).toBeCloseTo(coeffs[k], 10))
      expect(fit.r2).toBeCloseTo(1, 12)
      expect(fit.rmse).toBeLessThan(1e-10)
      expect(fit.n).toBe(21)
      expect(fit.xMin).toBe(-3)
      expect(fit.xMax).toBeCloseTo(-3 + 0.37 * 20, 12)
    }
  })

  it('matches the closed-form simple linear regression, including standard errors', () => {
    const x = [1, 2, 3, 4, 5, 6]
    const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2]
    const fit = polyFit(x, y, 1) as PolyFit
    const n = x.length
    const mx = x.reduce((a, b) => a + b) / n
    const my = y.reduce((a, b) => a + b) / n
    let sxx = 0
    let sxy = 0
    for (let i = 0; i < n; i += 1) {
      sxx += (x[i] - mx) ** 2
      sxy += (x[i] - mx) * (y[i] - my)
    }
    const slope = sxy / sxx
    const intercept = my - slope * mx
    let ssr = 0
    let sst = 0
    for (let i = 0; i < n; i += 1) {
      ssr += (y[i] - intercept - slope * x[i]) ** 2
      sst += (y[i] - my) ** 2
    }
    const s2 = ssr / (n - 2)
    expect(fit.coeffs[0]).toBeCloseTo(intercept, 12)
    expect(fit.coeffs[1]).toBeCloseTo(slope, 12)
    expect(fit.stderr[1]).toBeCloseTo(Math.sqrt(s2 / sxx), 12)
    expect(fit.stderr[0]).toBeCloseTo(Math.sqrt(s2 * (1 / n + (mx * mx) / sxx)), 12)
    expect(fit.r2).toBeCloseTo(1 - ssr / sst, 12)
    expect(fit.rmse).toBeCloseTo(Math.sqrt(ssr / n), 12)
  })

  it('stays accurate with a large x offset (centred and scaled internally)', () => {
    // A quadratic in time-of-day seconds: x ≈ 50 000 with a 10 s spread.
    const x = Float64Array.from({ length: 101 }, (_, i) => 50000 + i * 0.1)
    const y = Float64Array.from(x, (v) => 3 + 0.2 * (v - 50005) - 0.01 * (v - 50005) ** 2)
    const fit = polyFit(x, y, 2) as PolyFit
    for (const v of [50000, 50003.3, 50010]) {
      expect(evalPoly(fit.coeffs, v)).toBeCloseTo(3 + 0.2 * (v - 50005) - 0.01 * (v - 50005) ** 2, 5)
    }
    expect(fit.r2).toBeCloseTo(1, 9)
  })

  it('skips NaN pairs and pairs with non-positive weights', () => {
    const x = [0, 1, NaN, 3, 4, 5]
    const y = [1, 3, 5, NaN, 9, 1000]
    const w = [1, 1, 1, 1, 1, 0]
    const fit = polyFit(x, y, 1, w) as PolyFit
    expect(fit.n).toBe(3)
    expect(fit.coeffs[0]).toBeCloseTo(1, 12)
    expect(fit.coeffs[1]).toBeCloseTo(2, 12)
    expect(fit.xMax).toBe(4)
  })

  it('applies weights (scale-invariant) like repeating samples', () => {
    const x = [0, 1, 2, 3]
    const y = [0, 1.2, 1.8, 3.3]
    const weighted = polyFit(x, y, 1, [1, 3, 1, 2]) as PolyFit
    const repeated = polyFit([0, 1, 1, 1, 2, 3, 3], [0, 1.2, 1.2, 1.2, 1.8, 3.3, 3.3], 1) as PolyFit
    expect(weighted.coeffs[0]).toBeCloseTo(repeated.coeffs[0], 12)
    expect(weighted.coeffs[1]).toBeCloseTo(repeated.coeffs[1], 12)
    expect(weighted.r2).toBeCloseTo(repeated.r2, 12)
    expect(weighted.rmse).toBeCloseTo(repeated.rmse, 12)
    const scaled = polyFit(x, y, 1, [10, 30, 10, 20]) as PolyFit
    expect(scaled.coeffs[1]).toBeCloseTo(weighted.coeffs[1], 12)
    expect(scaled.stderr[1]).toBeCloseTo(weighted.stderr[1], 12)
  })

  it('returns null with too few distinct x values and NaN standard errors without spare points', () => {
    expect(polyFit([1, 1, 1, 2], [1, 2, 3, 4], 2)).toBeNull()
    expect(polyFit([1, NaN, 2], [1, 2, NaN], 1)).toBeNull()
    expect(polyFit([], [], 1)).toBeNull()
    const exact = polyFit([0, 1, 2], [1, 3, 2], 2) as PolyFit
    expect(exact.n).toBe(3)
    expect(exact.stderr.every(Number.isNaN)).toBe(true)
    expect(exact.r2).toBeCloseTo(1, 12)
  })

  it('handles a constant y (R² = 1, zero slope)', () => {
    const fit = polyFit([1, 2, 3, 4], [0.1, 0.1, 0.1, 0.1], 1) as PolyFit
    expect(fit.coeffs[0]).toBeCloseTo(0.1, 14)
    expect(fit.coeffs[1]).toBeCloseTo(0, 14)
    expect(fit.r2).toBe(1)
  })

  it('rejects an invalid degree', () => {
    expect(() => polyFit([1, 2], [1, 2], 1.5)).toThrow(RangeError)
    expect(() => polyFit([1, 2], [1, 2], -1)).toThrow(RangeError)
  })
})

describe('evalPoly', () => {
  it('evaluates lowest power first by Horner', () => {
    expect(evalPoly([1, 2, 3], 2)).toBe(1 + 4 + 12)
    expect(evalPoly([5], 100)).toBe(5)
    expect(evalPoly([], 3)).toBe(0)
  })
})

describe('formatFit', () => {
  const fit = (coeffs: number[], r2: number, n: number): PolyFit => ({
    degree: coeffs.length - 1,
    coeffs,
    stderr: coeffs.map(() => NaN),
    r2,
    rmse: 0,
    n,
    xMin: 0,
    xMax: 1,
  })

  it('formats the example in the contract', () => {
    expect(formatFit(fit([1.23, -3.01], 0.998, 4))).toBe(`y = ${MINUS}3.01·x + 1.23   (R² = 0.998, n = 4)`)
  })

  it('writes powers as superscripts, signs as real minus signs and skips zero terms', () => {
    expect(formatFit(fit([-4.5, 0, 0.0123, -2], 0.9, 30), 'α', 'CL')).toBe(
      `CL = ${MINUS}2·α³ + 0.0123·α² ${MINUS} 4.5   (R² = 0.900, n = 30)`,
    )
    expect(formatFit(fit([0, 1], 1, 2))).toBe('y = x   (R² = 1.000, n = 2)')
    expect(formatFit(fit([0, 0], 1, 2))).toBe('y = 0   (R² = 1.000, n = 2)')
  })

  it('wraps names that are not plain identifiers and shows 4 decimals for R² ≥ 0.999', () => {
    expect(formatFit(fit([2, 0.5], 0.99934, 12), 'KIAS [kt]', 'Pitch')).toBe(
      'Pitch = 0.5·(KIAS [kt]) + 2   (R² = 0.9993, n = 12)',
    )
  })

  it('formats magnitudes with 4 significant figures', () => {
    expect(formatMagnitude(3.01)).toBe('3.01')
    expect(formatMagnitude(3.014159)).toBe('3.014')
    expect(formatMagnitude(1234.56)).toBe('1235')
    expect(formatMagnitude(169205.36)).toBe('169205')
    expect(formatMagnitude(9999.7)).toBe('10000')
    expect(formatMagnitude(0.00123456)).toBe('0.001235')
    expect(formatMagnitude(1.23456e-5)).toBe('1.235×10⁻⁵')
    expect(formatMagnitude(2.5e7)).toBe('2.5×10⁷')
    expect(formatMagnitude(0)).toBe('0')
    expect(formatNumber(-0.5)).toBe(`${MINUS}0.5`)
  })
})
