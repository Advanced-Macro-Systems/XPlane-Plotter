import { describe, expect, it } from 'vitest'
import { findPeaks, fitFirstOrder, fitOscillation } from './modes'

/** Deterministic uniform [0, 1) generator (mulberry32). */
function uniform(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic standard normal generator (Box–Muller). */
function normal(seed: number): () => number {
  const rand = uniform(seed)
  return () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
}

interface OscillationSpec {
  period: number
  zeta: number
  amplitude: number
  phase?: number
  offset?: number
  /** linear drift per second */
  drift?: number
  /** noise standard deviation */
  noise?: number
  duration: number
  rateHz: number
  t0?: number
  seed?: number
}

/** y = A·e^(−στ)·cos(ωd·τ + φ) + c + drift·τ + noise, sampled at rateHz from t0 for `duration` seconds. */
function oscillation(spec: OscillationSpec) {
  const omegaD = (2 * Math.PI) / spec.period
  const omegaN = omegaD / Math.sqrt(1 - spec.zeta ** 2)
  const sigma = spec.zeta * omegaN
  const n = Math.round(spec.duration * spec.rateHz)
  const t0 = spec.t0 ?? 0
  const noise = normal(spec.seed ?? 1)
  const t = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const tau = i / spec.rateHz
    t[i] = t0 + tau
    y[i] =
      spec.amplitude * Math.exp(-sigma * tau) * Math.cos(omegaD * tau + (spec.phase ?? 0)) +
      (spec.offset ?? 0) +
      (spec.drift ?? 0) * tau +
      (spec.noise ?? 0) * noise()
  }
  return { t, y, sigma, omegaD, omegaN }
}

describe('fitOscillation — phugoid (T ≈ 58 s, ζ ≈ 0.05) with drift and noise', () => {
  const base = {
    period: 58,
    zeta: 0.05,
    amplitude: 8,
    phase: 0.7,
    offset: 140,
    drift: 0.01,
    noise: 0.15,
    rateHz: 10,
    t0: 1234.5,
  }

  for (const [duration, periodTol, zetaTol] of [
    [60, 0.02, 0.01],
    [120, 0.01, 0.005],
    [200, 0.005, 0.003],
  ] as const) {
    it(`recovers period and damping from a ${duration} s window`, () => {
      const { t, y, sigma } = oscillation({ ...base, duration, seed: duration })
      const fit = fitOscillation(t, y, { detrend: 'linear' })
      expect(fit.ok, fit.message).toBe(true)
      expect(fit.periodS).toBeGreaterThan(58 * (1 - periodTol))
      expect(fit.periodS).toBeLessThan(58 * (1 + periodTol))
      expect(Math.abs(fit.zeta - 0.05)).toBeLessThan(zetaTol)
      expect(fit.sigma).toBeCloseTo(sigma, 2)
      expect(fit.amplitude).toBeGreaterThan(7.6)
      expect(fit.amplitude).toBeLessThan(8.4)
      expect(fit.slope).toBeCloseTo(0.01, 2)
      expect(fit.offset).toBeCloseTo(140, 0)
      expect(fit.t0).toBe(1234.5)
      expect(fit.r2).toBeGreaterThan(0.99)
      expect(fit.cycles).toBeCloseTo(((duration - 0.1) * fit.omegaD) / (2 * Math.PI), 6)
      expect(fit.halfLifeS).toBeCloseTo(Math.LN2 / fit.sigma, 9)
      expect(fit.omegaN).toBeCloseTo(Math.hypot(fit.sigma, fit.omegaD), 12)
      // The fitted curve follows the data to within the noise.
      let worst = 0
      for (let i = 0; i < t.length; i += 1) worst = Math.max(worst, Math.abs(fit.fitted[i] - y[i]))
      expect(worst).toBeLessThan(0.8)
    })
  }

  it('cross-checks damping by the logarithmic decrement over several cycles', () => {
    const { t, y } = oscillation({ ...base, duration: 200, noise: 0.05, seed: 7 })
    const fit = fitOscillation(t, y, { detrend: 'linear' })
    expect(fit.ok).toBe(true)
    expect(Math.abs(fit.zetaLogDec - 0.05)).toBeLessThan(0.01)
    // Turning points alternate and sit one half period apart.
    expect(fit.peaks.length).toBeGreaterThanOrEqual(5)
    for (let k = 1; k < fit.peaks.length; k += 1) {
      expect(fit.peaks[k].kind).not.toBe(fit.peaks[k - 1].kind)
      expect(fit.peaks[k].t - fit.peaks[k - 1].t).toBeGreaterThan(29 - 3)
      expect(fit.peaks[k].t - fit.peaks[k - 1].t).toBeLessThan(29 + 3)
    }
    // Peak values are the input samples (so they plot on the signal).
    for (const pk of fit.peaks) expect(pk.value).toBe(y[pk.index])
  })

  it('rejects a window shorter than one cycle', () => {
    const { t, y } = oscillation({ ...base, duration: 20, seed: 3 })
    const fit = fitOscillation(t, y, { detrend: 'linear' })
    expect(fit.ok).toBe(false)
    expect(fit.message).toBeTruthy()
  })
})

describe('fitOscillation — short period and dutch roll', () => {
  it('short period: T ≈ 3 s, ζ ≈ 0.5', () => {
    const { t, y, sigma } = oscillation({
      period: 3,
      zeta: 0.5,
      amplitude: 3,
      phase: -0.4,
      offset: 2,
      noise: 0.02,
      duration: 10,
      rateHz: 20,
      seed: 11,
    })
    const fit = fitOscillation(t, y, { detrend: 'none' })
    expect(fit.ok, fit.message).toBe(true)
    expect(Math.abs(fit.periodS - 3) / 3).toBeLessThan(0.02)
    expect(Math.abs(fit.zeta - 0.5)).toBeLessThan(0.02)
    expect(fit.sigma).toBeCloseTo(sigma, 1)
    expect(fit.offset).toBeCloseTo(2, 1)
    expect(fit.slope).toBe(0)
    expect(fit.r2).toBeGreaterThan(0.99)
  })

  it('dutch roll: T ≈ 5 s, ζ ≈ 0.15', () => {
    const { t, y } = oscillation({
      period: 5,
      zeta: 0.15,
      amplitude: 4,
      phase: 2.1,
      offset: -0.3,
      noise: 0.05,
      duration: 30,
      rateHz: 10,
      seed: 5,
    })
    const fit = fitOscillation(t, y, { detrend: 'linear' })
    expect(fit.ok, fit.message).toBe(true)
    expect(Math.abs(fit.periodS - 5) / 5).toBeLessThan(0.005)
    expect(Math.abs(fit.zeta - 0.15)).toBeLessThan(0.005)
    expect(fit.amplitude).toBeCloseTo(4, 1)
    expect(Math.abs(fit.zetaLogDec - 0.15)).toBeLessThan(0.02)
    // Phase is reported in (−π, π] with a positive amplitude.
    expect(fit.amplitude).toBeGreaterThan(0)
    expect(Math.abs(fit.phase - 2.1)).toBeLessThan(0.05)
  })

  it('growing oscillation (σ < 0): negative damping and a negative time to double', () => {
    const { t, y, sigma } = oscillation({
      period: 20,
      zeta: -0.05,
      amplitude: 1,
      phase: 0.3,
      offset: 5,
      noise: 0.02,
      duration: 80,
      rateHz: 10,
      seed: 13,
    })
    expect(sigma).toBeLessThan(0)
    const fit = fitOscillation(t, y, { detrend: 'none' })
    expect(fit.ok, fit.message).toBe(true)
    expect(fit.sigma).toBeLessThan(0)
    expect(fit.sigma).toBeCloseTo(sigma, 3)
    expect(Math.abs(fit.zeta + 0.05)).toBeLessThan(0.003)
    expect(Math.abs(fit.periodS - 20) / 20).toBeLessThan(0.005)
    expect(fit.halfLifeS).toBeLessThan(0)
    expect(fit.halfLifeS).toBeCloseTo(Math.LN2 / fit.sigma, 9)
    expect(fit.zetaLogDec).toBeLessThan(0)
  })

  it('works on a long, finely sampled record (subsampled multi-start, then polished)', () => {
    const { t, y } = oscillation({
      period: 5,
      zeta: 0.1,
      amplitude: 2,
      offset: 1,
      noise: 0.05,
      duration: 120,
      rateHz: 100,
      seed: 17,
    })
    const fit = fitOscillation(t, y)
    expect(fit.ok, fit.message).toBe(true)
    expect(Math.abs(fit.periodS - 5) / 5).toBeLessThan(0.002)
    expect(Math.abs(fit.zeta - 0.1)).toBeLessThan(0.003)
  })
})

describe('fitOscillation — failures', () => {
  it('reports ok = false for pure noise', () => {
    const noise = normal(99)
    const n = 600
    const t = Float64Array.from({ length: n }, (_, i) => i / 10)
    const y = Float64Array.from({ length: n }, () => 3 + noise())
    for (const detrend of ['none', 'linear'] as const) {
      const fit = fitOscillation(t, y, { detrend })
      expect(fit.ok).toBe(false)
      expect(fit.message).toBeTruthy()
    }
  })

  it('does not let a trend make noise look like a good fit', () => {
    const noise = normal(5)
    const t = Float64Array.from({ length: 600 }, (_, i) => i / 10)
    const y = Float64Array.from(t, (x) => 100 + 2 * x + noise())
    const fit = fitOscillation(t, y, { detrend: 'linear' })
    expect(fit.ok).toBe(false)
  })

  it('rejects too few samples, constant signals and empty time', () => {
    const t = Float64Array.from({ length: 8 }, (_, i) => i)
    const short = fitOscillation(t, Float64Array.from(t, Math.sin))
    expect(short.ok).toBe(false)
    expect(short.message).toMatch(/at least/)
    expect(short.fitted).toHaveLength(8)
    expect(Number.isNaN(short.fitted[0])).toBe(true)

    const t2 = Float64Array.from({ length: 50 }, (_, i) => i / 10)
    const constant = fitOscillation(t2, new Float64Array(50).fill(4))
    expect(constant.ok).toBe(false)
    expect(constant.message).toMatch(/constant/)

    const sameTime = fitOscillation(new Float64Array(50).fill(3), Float64Array.from(t2, Math.sin))
    expect(sameTime.ok).toBe(false)
  })

  it('skips NaN samples and evaluates the model at every finite input time', () => {
    const { t, y } = oscillation({ period: 5, zeta: 0.1, amplitude: 2, duration: 30, rateHz: 10, noise: 0.01 })
    y[40] = NaN
    y[41] = NaN
    t[100] = NaN
    const fit = fitOscillation(t, y)
    expect(fit.ok, fit.message).toBe(true)
    expect(Math.abs(fit.periodS - 5)).toBeLessThan(0.02)
    expect(fit.fitted).toHaveLength(t.length)
    expect(Number.isFinite(fit.fitted[40])).toBe(true)
    expect(Number.isNaN(fit.fitted[100])).toBe(true)
  })
})

describe('fitFirstOrder', () => {
  it('recovers τ = 0.8 s (roll subsidence step response)', () => {
    const noise = normal(21)
    const n = 100 // 5 s at 20 Hz
    const t = Float64Array.from({ length: n }, (_, i) => 10 + i / 20)
    const y = Float64Array.from(t, (x) => 20 * (1 - Math.exp(-(x - 10) / 0.8)) + 0.1 * noise())
    const fit = fitFirstOrder(t, y)
    expect(fit.ok, fit.message).toBe(true)
    expect(Math.abs(fit.tau - 0.8) / 0.8).toBeLessThan(0.02)
    expect(fit.offset).toBeCloseTo(20, 0)
    expect(fit.amplitude).toBeCloseTo(-20, 0)
    expect(fit.halfLifeS).toBeCloseTo(Math.LN2 * fit.tau, 12)
    expect(fit.t0).toBe(10)
    expect(fit.r2).toBeGreaterThan(0.99)
    expect(fit.fitted[0]).toBeCloseTo(fit.offset + fit.amplitude, 10)
  })

  it('recovers a divergent response (spiral, τ = −15 s)', () => {
    const noise = normal(23)
    const t = Float64Array.from({ length: 300 }, (_, i) => i / 10)
    const y = Float64Array.from(t, (x) => 5 + 2 * Math.exp(x / 15) + 0.05 * noise())
    const fit = fitFirstOrder(t, y)
    expect(fit.ok, fit.message).toBe(true)
    expect(fit.tau).toBeLessThan(0)
    expect(Math.abs(fit.tau + 15) / 15).toBeLessThan(0.03)
    expect(fit.halfLifeS).toBeLessThan(0)
    expect(fit.offset).toBeCloseTo(5, 0)
    expect(fit.amplitude).toBeCloseTo(2, 0)
  })

  it('recovers a decay towards a non-zero value', () => {
    const t = Float64Array.from({ length: 200 }, (_, i) => i / 10)
    const y = Float64Array.from(t, (x) => -3 + 7 * Math.exp(-x / 4))
    const fit = fitFirstOrder(t, y)
    expect(fit.ok).toBe(true)
    expect(fit.tau).toBeCloseTo(4, 6)
    expect(fit.offset).toBeCloseTo(-3, 6)
    expect(fit.amplitude).toBeCloseTo(7, 6)
  })

  it('reports ok = false for noise, a straight line and too few samples', () => {
    const noise = normal(31)
    const t = Float64Array.from({ length: 200 }, (_, i) => i / 10)
    expect(fitFirstOrder(t, Float64Array.from(t, () => noise())).ok).toBe(false)
    const line = fitFirstOrder(t, Float64Array.from(t, (x) => 2 + 0.5 * x))
    expect(line.ok).toBe(false)
    expect(line.message).toBeTruthy()
    const few = fitFirstOrder(t.subarray(0, 4), Float64Array.of(1, 2, 3, 4))
    expect(few.ok).toBe(false)
    expect(few.fitted).toHaveLength(4)
  })
})

describe('findPeaks', () => {
  it('finds the maxima and minima of a sine wave', () => {
    const t = Float64Array.from({ length: 401 }, (_, i) => i / 100)
    const y = Float64Array.from(t, (x) => Math.sin(2 * Math.PI * x))
    const peaks = findPeaks(t, y)
    expect(peaks.map((p) => p.kind)).toEqual(['max', 'min', 'max', 'min', 'max', 'min', 'max', 'min'])
    for (const p of peaks) {
      const expected = p.kind === 'max' ? 0.25 : 0.75
      expect(Math.abs((p.t % 1) - expected)).toBeLessThan(0.006)
      expect(p.value).toBe(y[p.index])
      expect(p.t).toBe(t[p.index])
    }
  })

  it('ignores ripples below the prominence threshold and the end samples', () => {
    // Big hump with a small ripple on its flank, rising at both ends.
    const y = Float64Array.of(0, 5, 10, 9.8, 10.1, 6, 2, 0.5, 4, 12)
    const t = Float64Array.from(y, (_, i) => i)
    const peaks = findPeaks(t, y, { minProminence: 1 })
    expect(peaks).toEqual([
      { index: 4, t: 4, value: 10.1, kind: 'max' },
      { index: 7, t: 7, value: 0.5, kind: 'min' },
    ])
    // With no threshold the ripple appears too.
    expect(findPeaks(t, y, { minProminence: 0 }).map((p) => p.index)).toEqual([2, 3, 4, 7])
  })

  it('measures prominence against the higher of the two bases', () => {
    // Peak at 3 (value 6): towards the higher sample at 0 the lowest point is 2, towards the higher peak at 7 it is
    // 1, so its prominence is 6 − max(2, 1) = 4 (not 5). Peak at 5 (value 3): 3 − max(1, 2) = 1. Peak at 7 (the
    // highest): 9 − max(1, 0) = 8. Index 0 is an end sample and never a peak.
    const y = Float64Array.of(8, 2, 4, 6, 1, 3, 2, 9, 0)
    const t = Float64Array.from(y, (_, i) => i)
    const maxima = (minProminence: number) =>
      findPeaks(t, y, { minProminence })
        .filter((p) => p.kind === 'max')
        .map((p) => p.index)
    expect(maxima(4.5)).toEqual([7])
    expect(maxima(4)).toEqual([3, 7])
    expect(maxima(1)).toEqual([3, 5, 7])
    expect(maxima(8.5)).toEqual([])
  })

  it('reports a flat top once, at its middle', () => {
    const y = Float64Array.of(0, 1, 3, 3, 3, 3, 3, 1, 0)
    const t = Float64Array.from(y, (_, i) => i)
    expect(findPeaks(t, y)).toEqual([{ index: 4, t: 4, value: 3, kind: 'max' }])
  })

  it('keeps the more prominent of two peaks closer than minSpacing', () => {
    const y = Float64Array.of(0, 5, 1, 7, 0, 0, 0, 6, 0)
    const t = Float64Array.from(y, (_, i) => i)
    const maxima = (spacing: number) =>
      findPeaks(t, y, { minProminence: 0.5, minSpacing: spacing })
        .filter((p) => p.kind === 'max')
        .map((p) => p.index)
    expect(maxima(1)).toEqual([1, 3, 7])
    expect(maxima(3)).toEqual([3, 7])
    expect(maxima(5)).toEqual([3])
  })

  it('skips NaN samples and handles degenerate input', () => {
    const y = Float64Array.of(0, 1, NaN, 2, 0, NaN, -2, 0)
    const t = Float64Array.from(y, (_, i) => i)
    expect(findPeaks(t, y).map((p) => [p.index, p.kind])).toEqual([
      [3, 'max'],
      [6, 'min'],
    ])
    expect(findPeaks(new Float64Array(0), new Float64Array(0))).toEqual([])
    expect(findPeaks(Float64Array.of(0, 1), Float64Array.of(1, 1))).toEqual([])
    expect(findPeaks(Float64Array.of(0, 1, 2), Float64Array.of(4, 4, 4))).toEqual([])
  })
})
