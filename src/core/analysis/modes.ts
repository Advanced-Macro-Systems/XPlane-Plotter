// Dynamic-mode identification from a time history: damped oscillation (phugoid, short period, dutch roll) and
// first-order response (roll subsidence, spiral). Robust initial guesses (zero crossings / peaks / spectrum), then a
// Levenberg–Marquardt refinement. Pure functions on typed arrays; time in seconds.
// OWNER: analysis agent. Public API below is a contract; keep these signatures.

import { lstsq } from './linalg'
import { levenbergMarquardt, type LMResult, type ModelFn } from './lm'

export interface Peak {
  index: number
  t: number
  value: number
  kind: 'max' | 'min'
}

/** Model: y(t) = A·e^(−σ(t−t0))·cos(ωd(t−t0) + φ) + c + b(t−t0)   (b = 0 unless detrend is 'linear') */
export interface OscillationFit {
  ok: boolean
  /** Why the fit failed or is doubtful (too few cycles, poor R², diverging...) */
  message?: string
  amplitude: number
  /** decay rate σ (1/s); negative when the oscillation grows */
  sigma: number
  /** damped natural frequency ωd (rad/s) */
  omegaD: number
  phase: number
  offset: number
  slope: number
  /** damping ratio ζ = σ / ωn */
  zeta: number
  /** undamped natural frequency ωn = √(σ² + ωd²) (rad/s) */
  omegaN: number
  /** damped period Td = 2π/ωd (s) */
  periodS: number
  /** time to half amplitude ln2/σ (s) when σ > 0; time to double −ln2/σ reported as a negative number when σ < 0 */
  halfLifeS: number
  r2: number
  /** cycles covered by the data window */
  cycles: number
  /** t0 used by the model (first sample time) */
  t0: number
  /** model evaluated at every input time */
  fitted: Float64Array
  /**
   * turning points found in the (detrended) data. `value` is the input sample y[index], so the markers sit on the
   * plotted signal.
   */
  peaks: Peak[]
  /** ζ from the logarithmic decrement of successive peaks, as a cross-check (NaN if < 2 same-sign peaks) */
  zetaLogDec: number
}

const TWO_PI = 2 * Math.PI
/** Fewest finite samples worth fitting an oscillation (6 parameters) to. */
const MIN_OSCILLATION_SAMPLES = 12
const MIN_FIRST_ORDER_SAMPLES = 6
/** Below this many cycles the fit is rejected; below DOUBTFUL_CYCLES it is flagged. */
const MIN_CYCLES = 0.9
const DOUBTFUL_CYCLES = 1.5
/** Longer series are fitted on a subsample first (multi-start), then polished on every sample. */
const SUBSAMPLE_ABOVE = 6000

/**
 * Fits a damped (or growing) sinusoid plus an offset (and a linear trend with detrend 'linear').
 *
 * Initial guesses: the signal is detrended (mean or least-squares line); the period comes from zero crossings (with
 * hysteresis) and from the peaks of a least-squares periodogram; the decay rate from successive peak amplitudes;
 * amplitude, phase, offset and slope from a linear least-squares solve at that frequency and decay. Every candidate
 * frequency is refined by Levenberg–Marquardt on all parameters (ω and σ bounded) and the best fit is kept.
 * ok is false when the window holds less than ~1 cycle, when the oscillation explains less than half of the
 * (detrended) variance, or when the solver runs to a bound.
 */
export function fitOscillation(
  t: Float64Array,
  y: Float64Array,
  opts?: { detrend?: 'none' | 'linear' },
): OscillationFit {
  const linear = opts?.detrend === 'linear'
  const series = prepareSeries(t, y)
  const { tau, span, dt } = series
  const ys = series.y
  const n = ys.length
  if (n < MIN_OSCILLATION_SAMPLES) {
    return failedOscillation(
      t.length,
      series.t0,
      `Need at least ${MIN_OSCILLATION_SAMPLES} samples with values to fit an oscillation (the window has ${n}).`,
    )
  }
  if (!(span > 0) || !(dt > 0)) return failedOscillation(t.length, series.t0, 'The selected rows do not span any time.')

  // The trend is parameterised about the window centre (tm) to decorrelate offset and slope.
  const tm = span / 2
  const trend = fitTrend(tau, ys, linear, tm)
  const sst = sumSquaredDeviations(ys)
  if (!(trend.ssr > 1e-20 * (sst + n * meanOf(ys) ** 2)) || !(sst > 0)) {
    return failedOscillation(
      t.length,
      series.t0,
      linear
        ? 'The signal is a straight line in this window: there is no oscillation to fit.'
        : 'The signal is constant in this window: there is no oscillation to fit.',
    )
  }
  const resid = new Float64Array(n)
  for (let k = 0; k < n; k += 1) resid[k] = ys[k] - trend.c - trend.b * (tau[k] - tm)

  // Bounds: between a quarter cycle per window and the Nyquist frequency; growth limited to e^40 over the window.
  const omegaMin = (TWO_PI * 0.25) / span
  const omegaMax = Math.PI / dt
  const sigmaMin = -40 / span
  const sigmaMax = omegaMax
  const lower = linear
    ? [-Infinity, sigmaMin, omegaMin, -Infinity, -Infinity, -Infinity]
    : [-Infinity, sigmaMin, omegaMin, -Infinity, -Infinity]
  const upper = linear
    ? [Infinity, sigmaMax, omegaMax, Infinity, Infinity, Infinity]
    : [Infinity, sigmaMax, omegaMax, Infinity, Infinity]

  // Candidate frequencies: zero crossings first (precise when there are several cycles), then periodogram peaks.
  let maxAbs = 0
  for (const v of resid) maxAbs = Math.max(maxAbs, Math.abs(v))
  const omegas: number[] = []
  const omegaZc = zeroCrossingOmega(tau, resid, Math.max(0.15 * maxAbs, 3 * noiseLevel(resid)))
  if (omegaZc > omegaMin && omegaZc < omegaMax) omegas.push(omegaZc)
  omegas.push(...periodogramPeaks(tau, resid, span, linear, omegaMin, omegaMax, 3))
  const candidates = distinct(omegas, 0.04)

  // Multi-start LM (on a subsample of long series), keeping the lowest residual.
  const step = n > SUBSAMPLE_ABOVE ? Math.ceil(n / (SUBSAMPLE_ABOVE / 2)) : 1
  const work = step > 1 ? subsample(tau, ys, step) : { tau, y: ys }
  const workModel = oscillationModel(work.tau, linear, tm)
  const workTrendSsr = step > 1 ? fitTrend(work.tau, work.y, linear, tm).ssr : trend.ssr
  let best: LMResult | null = null
  for (const omega0 of candidates) {
    const sigma0 = clamp(decayFromPeaks(tau, resid, omega0, dt), -0.5 * omega0, omega0)
    for (const start of sigma0 === 0 ? [0] : [sigma0, 0]) {
      const init = linearOscillation(work.tau, work.y, omega0, start, linear, tm)
      if (!init) continue
      const result = levenbergMarquardt(workModel, work.y, init, { lower, upper, maxIterations: 150 })
      if (Number.isFinite(result.ssr) && (!best || result.ssr < best.ssr)) best = result
      // A zero-damping restart only matters when the peak-based decay estimate led nowhere good.
      if (Number.isFinite(result.ssr) && 1 - result.ssr / workTrendSsr > 0.9) break
    }
  }
  if (best && step > 1) {
    best = levenbergMarquardt(oscillationModel(tau, linear, tm), ys, best.params, { lower, upper, maxIterations: 200 })
  }
  if (!best || !Number.isFinite(best.ssr)) {
    return failedOscillation(t.length, series.t0, 'Could not find an oscillation in this window.')
  }

  const p = best.params
  let amplitude = p[0]
  let phase = p[3]
  if (amplitude < 0) {
    amplitude = -amplitude
    phase += Math.PI
  }
  phase = wrapAngle(phase)
  const sigma = p[1]
  const omegaD = p[2]
  const slope = linear ? p[5] : 0
  const offset = p[4] - slope * tm
  const omegaN = Math.hypot(sigma, omegaD)
  const periodS = TWO_PI / omegaD
  const cycles = (span * omegaD) / TWO_PI
  const r2 = 1 - best.ssr / sst
  // Share of the detrended variance the oscillation explains: a trend alone must not make a fit look good.
  const r2Oscillation = 1 - best.ssr / trend.ssr

  const t0 = series.t0
  const fitted = new Float64Array(t.length)
  for (let i = 0; i < t.length; i += 1) {
    const x = t[i] - t0
    fitted[i] = Number.isFinite(x)
      ? amplitude * Math.exp(-sigma * x) * Math.cos(omegaD * x + phase) + offset + slope * x
      : NaN
  }

  // Turning points and the log-decrement cross-check, about the fitted equilibrium.
  const detrended = new Float64Array(n)
  for (let k = 0; k < n; k += 1) detrended[k] = ys[k] - offset - slope * tau[k]
  const spacing = Math.max(1, Math.round((0.6 * periodS) / dt))
  const rawPeaks = Number.isFinite(periodS) ? detectPeaks(detrended, undefined, undefined, spacing) : []
  const peaks: Peak[] = rawPeaks.map(({ pos, kind }) => {
    const index = series.index[pos]
    return { index, t: t[index], value: y[index], kind }
  })
  const zetaLogDec = logDecrementZeta(rawPeaks, tau, detrended, periodS)

  const atBound = (value: number, lo: number, hi: number) =>
    value <= lo + 1e-9 * Math.abs(lo) || value >= hi - 1e-9 * Math.abs(hi)
  let ok = true
  let message: string | undefined
  // (ω at its lower bound means less than a cycle in the window: that is reported by the cycle check below.)
  if (!p.every(Number.isFinite) || omegaD >= omegaMax * (1 - 1e-9) || atBound(sigma, sigmaMin, sigmaMax)) {
    ok = false
    message =
      'The fit diverged (frequency or damping ran to its limit). Choose a window that starts at the disturbance ' +
      'and holds 2–5 clean cycles.'
  } else if (cycles < MIN_CYCLES) {
    ok = false
    message =
      `The window holds only ${cycles.toFixed(2)} cycles of the fitted oscillation: select at least one full ` +
      'cycle (2–5 are better).'
  } else if (!(r2Oscillation >= 0.5)) {
    ok = false
    message =
      `Poor fit: the oscillation explains only ${percent(r2Oscillation)} of the variation` +
      `${linear ? ' left after removing the trend' : ''}. The window may not contain a clear damped oscillation.`
  } else {
    const notes: string[] = []
    if (!best.converged) notes.push('The solver stopped before fully converging; treat the numbers with care.')
    if (cycles < DOUBTFUL_CYCLES) {
      notes.push(`Only ${cycles.toFixed(1)} cycles in the window: frequency and damping are uncertain.`)
    }
    if (r2Oscillation < 0.8) notes.push(`Fair fit: the oscillation explains ${percent(r2Oscillation)} of the variation.`)
    if (sigma / omegaN > 0.7) notes.push('Heavily damped (ζ > 0.7): the first-order model may describe it better.')
    if (notes.length) message = notes.join(' ')
  }

  return {
    ok,
    message,
    amplitude,
    sigma,
    omegaD,
    phase,
    offset,
    slope,
    zeta: sigma / omegaN,
    omegaN,
    periodS,
    halfLifeS: sigma === 0 ? Infinity : Math.LN2 / sigma,
    r2,
    cycles,
    t0,
    fitted,
    peaks,
    zetaLogDec,
  }
}

/** Model: y(t) = c + A·e^(−(t−t0)/τ) */
export interface FirstOrderFit {
  ok: boolean
  message?: string
  amplitude: number
  offset: number
  /** time constant τ (s); negative for a divergent (growing) response */
  tau: number
  /** ln2·τ (s) */
  halfLifeS: number
  r2: number
  t0: number
  fitted: Float64Array
}

/**
 * Fits y = c + A·e^(−k(t−t0)) with k = 1/τ (k < 0: divergent). Initial rate from the 63% point, from the ratio of
 * the slopes at the start and end of the window, and from a log-spaced scan of k (each scored by solving c and A
 * linearly); the best few are refined by Levenberg–Marquardt.
 */
export function fitFirstOrder(t: Float64Array, y: Float64Array): FirstOrderFit {
  const series = prepareSeries(t, y)
  const { tau, span, dt } = series
  const ys = series.y
  const n = ys.length
  if (n < MIN_FIRST_ORDER_SAMPLES) {
    return failedFirstOrder(
      t.length,
      series.t0,
      `Need at least ${MIN_FIRST_ORDER_SAMPLES} samples with values to fit a first-order response (the window has ${n}).`,
    )
  }
  if (!(span > 0) || !(dt > 0)) return failedFirstOrder(t.length, series.t0, 'The selected rows do not span any time.')
  const sst = sumSquaredDeviations(ys)
  if (!(sst > 1e-20 * n * meanOf(ys) ** 2)) {
    return failedFirstOrder(t.length, series.t0, 'The signal is constant in this window: there is nothing to fit.')
  }

  // k = 1/τ between "half the sample interval" (fast convergence) and growth by e^40 over the window.
  const kMax = 2 / dt
  const kMin = -40 / span
  const rates: number[] = []
  const k63 = rateFrom63Percent(tau, ys)
  const kSlopes = rateFromSlopes(tau, ys)
  for (const k of [k63, kSlopes]) if (Number.isFinite(k) && k > kMin && k < kMax && k !== 0) rates.push(k)
  const gridLo = Math.log(0.05 / span)
  const gridHi = Math.log(kMax)
  for (let j = 0; j < 40; j += 1) {
    const k = Math.exp(gridLo + ((gridHi - gridLo) * j) / 39)
    rates.push(k)
    if (-k > kMin) rates.push(-k)
  }
  const scored: { k: number; init: number[]; ssr: number }[] = []
  for (const k of rates) {
    const lin = linearFirstOrder(tau, ys, k)
    if (lin) scored.push({ k, init: [lin.c, lin.a, k], ssr: lin.ssr })
  }
  scored.sort((a, b) => a.ssr - b.ssr)
  const starts: number[][] = []
  for (const s of scored) {
    if (starts.length >= 3) break
    if (starts.every((other) => Math.abs(other[2] - s.k) > 0.1 * Math.abs(s.k))) starts.push(s.init)
  }

  const model: ModelFn = (p, i, g) => {
    const x = tau[i]
    const e = Math.exp(-p[2] * x)
    if (g) {
      g[0] = 1
      g[1] = e
      g[2] = -x * p[1] * e
    }
    return p[0] + p[1] * e
  }
  const lower = [-Infinity, -Infinity, kMin]
  const upper = [Infinity, Infinity, kMax]
  let best: LMResult | null = null
  for (const init of starts) {
    const result = levenbergMarquardt(model, ys, init, { lower, upper, maxIterations: 200 })
    if (Number.isFinite(result.ssr) && (!best || result.ssr < best.ssr)) best = result
  }
  if (!best) return failedFirstOrder(t.length, series.t0, 'Could not fit a first-order response to this window.')

  const [offset, amplitude, k] = best.params
  const timeConstant = 1 / k
  const r2 = 1 - best.ssr / sst
  const t0 = series.t0
  const fitted = new Float64Array(t.length)
  for (let i = 0; i < t.length; i += 1) {
    const x = t[i] - t0
    fitted[i] = Number.isFinite(x) ? offset + amplitude * Math.exp(-k * x) : NaN
  }

  let ok = true
  let message: string | undefined
  if (!best.params.every(Number.isFinite)) {
    ok = false
    message = 'The fit diverged. Choose a window that starts at the disturbance.'
  } else if (k >= kMax * (1 - 1e-9)) {
    ok = false
    message = 'The response is faster than the sample interval: the time constant cannot be resolved.'
  } else if (k <= kMin * (1 - 1e-9)) {
    ok = false
    message = 'The fit diverged (the growth rate ran to its limit). Choose a window that starts at the disturbance.'
  } else if (Math.abs(k) * span < 0.1) {
    ok = false
    message =
      `The response is nearly linear in this window (τ ≈ ${Math.abs(timeConstant).toPrecision(2)} s is far longer ` +
      `than the ${span.toPrecision(3)} s window): select a longer window.`
  } else if (!(r2 >= 0.5)) {
    ok = false
    message = `Poor fit (R² = ${r2.toFixed(2)}): the window may not contain a first-order response.`
  } else {
    const notes: string[] = []
    if (!best.converged) notes.push('The solver stopped before fully converging; treat the numbers with care.')
    if (r2 < 0.9) notes.push(`Fair fit (R² = ${r2.toFixed(2)}).`)
    if (Math.abs(timeConstant) < 2 * dt) notes.push('The time constant is close to the sample interval.')
    if (notes.length) message = notes.join(' ')
  }

  return {
    ok,
    message,
    amplitude,
    offset,
    tau: timeConstant,
    halfLifeS: Math.LN2 * timeConstant,
    r2,
    t0,
    fitted,
  }
}

/**
 * Turning points with a minimum prominence (default: 5% of the range) and minimum spacing in samples.
 *
 * Prominence is the height of a peak above the higher of the two lowest points between it and the nearest higher
 * sample on each side (as in scipy.signal.peak_prominences); minima use the inverted signal. Flat tops count once
 * (the middle sample). When two turning points of the same kind are closer than `minSpacing` samples, the more
 * prominent one is kept. The first and last samples are never turning points. NaN samples are skipped.
 */
export function findPeaks(
  t: Float64Array,
  y: Float64Array,
  opts?: { minProminence?: number; minSpacing?: number },
): Peak[] {
  const n = Math.min(t.length, y.length)
  const index: number[] = []
  for (let i = 0; i < n; i += 1) if (Number.isFinite(y[i])) index.push(i)
  const values = Float64Array.from(index, (i) => y[i])
  return detectPeaks(values, index, opts?.minProminence, opts?.minSpacing).map(({ pos, kind }) => ({
    index: index[pos],
    t: t[index[pos]],
    value: values[pos],
    kind,
  }))
}

// ---------------------------------------------------------------------------------------------- peak detection

interface RawPeak {
  /** position in the values array */
  pos: number
  kind: 'max' | 'min'
}

/** Peaks of `values` (all finite). `positions` (default: 0, 1, 2...) are the sample numbers used for spacing. */
function detectPeaks(
  values: Float64Array,
  positions: ArrayLike<number> | undefined,
  minProminence: number | undefined,
  minSpacing: number | undefined,
): RawPeak[] {
  const m = values.length
  if (m < 3) return []
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!(hi > lo)) return []
  const threshold = minProminence ?? 0.05 * (hi - lo)
  const spacing = Math.max(1, Math.floor(minSpacing ?? 1))
  const at = (k: number) => (positions ? positions[k] : k)
  const out: RawPeak[] = []
  for (const kind of ['max', 'min'] as const) {
    const w = kind === 'max' ? values : values.map((v) => -v)
    const left = baseMinima(w, false)
    const right = baseMinima(w, true)
    const kept: number[] = []
    const prominence: number[] = []
    for (const c of turningPoints(w)) {
      const prom = w[c] - Math.max(left[c], right[c])
      if (prom >= threshold && prom > 0) {
        kept.push(c)
        prominence.push(prom)
      }
    }
    const keep = spacingFilter(
      kept.map((c) => at(c)),
      prominence,
      spacing,
    )
    kept.forEach((c, k) => {
      if (keep[k]) out.push({ pos: c, kind })
    })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

/** Strict local maxima (a plateau counts once, at its middle sample); the end samples are excluded. */
function turningPoints(w: Float64Array): number[] {
  const out: number[] = []
  const m = w.length
  let i = 1
  while (i < m - 1) {
    if (w[i] > w[i - 1]) {
      let j = i
      while (j + 1 < m && w[j + 1] === w[i]) j += 1
      if (j + 1 < m && w[j + 1] < w[i]) out.push((i + j) >> 1)
      i = j + 1
    } else {
      i += 1
    }
  }
  return out
}

/**
 * For every sample i: the minimum of w between i and the nearest strictly higher sample before it (after it when
 * `reverse`), or the signal edge — the base on that side of a peak at i. O(m) with a monotonic stack whose entries
 * carry the minimum of the stretch they cover.
 */
function baseMinima(w: Float64Array, reverse: boolean): Float64Array {
  const m = w.length
  const out = new Float64Array(m)
  const stackIndex = new Int32Array(m)
  const stackMin = new Float64Array(m)
  let top = 0
  for (let s = 0; s < m; s += 1) {
    const i = reverse ? m - 1 - s : s
    let current = w[i]
    while (top > 0 && w[stackIndex[top - 1]] <= w[i]) {
      top -= 1
      if (stackMin[top] < current) current = stackMin[top]
    }
    out[i] = current
    stackIndex[top] = i
    stackMin[top] = current
    top += 1
  }
  return out
}

/** Keeps the highest-priority peaks so that no two kept ones are closer than `spacing` (positions ascending). */
function spacingFilter(positions: number[], priority: number[], spacing: number): boolean[] {
  const k = positions.length
  const keep = new Array<boolean>(k).fill(true)
  if (spacing <= 1) return keep
  const order = positions.map((_, i) => i).sort((a, b) => priority[b] - priority[a] || a - b)
  for (const j of order) {
    if (!keep[j]) continue
    for (let l = j - 1; l >= 0 && positions[j] - positions[l] < spacing; l -= 1) keep[l] = false
    for (let r = j + 1; r < k && positions[r] - positions[j] < spacing; r += 1) keep[r] = false
  }
  return keep
}

// ---------------------------------------------------------------------------------------------- shared helpers

interface Series {
  /** Original indices of the samples used (finite t and y), in time order */
  index: Int32Array
  /** Seconds since t0 */
  tau: Float64Array
  y: Float64Array
  /** Time of the first sample used (NaN when none) */
  t0: number
  /** tau of the last sample */
  span: number
  /** Median positive time step (NaN when unknown) */
  dt: number
}

function prepareSeries(t: Float64Array, y: Float64Array): Series {
  const n = Math.min(t.length, y.length)
  const used: number[] = []
  let ordered = true
  let last = -Infinity
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(t[i]) || !Number.isFinite(y[i])) continue
    if (t[i] < last) ordered = false
    last = t[i]
    used.push(i)
  }
  if (!ordered) used.sort((a, b) => t[a] - t[b] || a - b)
  const m = used.length
  const t0 = m ? t[used[0]] : NaN
  const tau = new Float64Array(m)
  const ys = new Float64Array(m)
  for (let k = 0; k < m; k += 1) {
    tau[k] = t[used[k]] - t0
    ys[k] = y[used[k]]
  }
  const steps: number[] = []
  for (let k = 1; k < m; k += 1) if (tau[k] > tau[k - 1]) steps.push(tau[k] - tau[k - 1])
  return { index: Int32Array.from(used), tau, y: ys, t0, span: m ? tau[m - 1] : 0, dt: median(steps) }
}

function median(values: ArrayLike<number>): number {
  const sorted = Float64Array.from(values).sort()
  const n = sorted.length
  if (n === 0) return NaN
  const h = n >> 1
  return n % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2
}

function meanOf(values: Float64Array): number {
  let mean = 0
  for (let k = 0; k < values.length; k += 1) mean += (values[k] - mean) / (k + 1)
  return mean
}

function sumSquaredDeviations(values: Float64Array): number {
  const mean = meanOf(values)
  let s = 0
  for (const v of values) s += (v - mean) ** 2
  return s
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0
}

function wrapAngle(a: number): number {
  const w = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI)
  return w <= -Math.PI ? w + TWO_PI : w
}

function percent(fraction: number): string {
  return `${Math.max(0, Math.round(100 * fraction))}%`
}

/** Values within `tolerance` (relative) of an earlier one are dropped. */
function distinct(values: number[], tolerance: number): number[] {
  const out: number[] = []
  for (const v of values) {
    if (Number.isFinite(v) && out.every((o) => Math.abs(o - v) > tolerance * Math.max(Math.abs(o), Math.abs(v)))) {
      out.push(v)
    }
  }
  return out
}

function subsample(tau: Float64Array, y: Float64Array, step: number): { tau: Float64Array; y: Float64Array } {
  const m = Math.ceil(tau.length / step)
  const ts = new Float64Array(m)
  const ys = new Float64Array(m)
  for (let k = 0; k < m; k += 1) {
    ts[k] = tau[k * step]
    ys[k] = y[k * step]
  }
  return { tau: ts, y: ys }
}

/**
 * Robust noise standard deviation from second differences (insensitive to smooth signals): for white noise the
 * second difference has variance 6σ², and the median absolute deviation ignores spikes.
 */
function noiseLevel(r: Float64Array): number {
  const m = r.length
  if (m < 5) return 0
  const d2 = new Float64Array(m - 2)
  for (let k = 1; k < m - 1; k += 1) d2[k - 1] = r[k + 1] - 2 * r[k] + r[k - 1]
  const centre = median(d2)
  const deviation = d2.map((v) => Math.abs(v - centre))
  return (1.4826 * median(deviation)) / Math.sqrt(6)
}

// ---------------------------------------------------------------------------------------------- oscillation pieces

function oscillationModel(tau: Float64Array, linear: boolean, tm: number): ModelFn {
  // params: [A, σ, ω, φ, c (at the window centre), b]
  return (p, i, g) => {
    const x = tau[i]
    const e = Math.exp(-p[1] * x)
    const arg = p[2] * x + p[3]
    const cos = Math.cos(arg)
    const sin = Math.sin(arg)
    const ae = p[0] * e
    if (g) {
      g[0] = e * cos
      g[1] = -x * ae * cos
      g[2] = -x * ae * sin
      g[3] = -ae * sin
      g[4] = 1
      if (linear) g[5] = x - tm
    }
    return ae * cos + p[4] + (linear ? p[5] * (x - tm) : 0)
  }
}

/** Least-squares offset (at tm) and slope (0 unless linear), with the residual sum of squares. */
function fitTrend(tau: Float64Array, y: Float64Array, linear: boolean, tm: number): { c: number; b: number; ssr: number } {
  if (!linear) return { c: meanOf(y), b: 0, ssr: sumSquaredDeviations(y) }
  const cols = [new Float64Array(tau.length).fill(1), tau.map((x) => x - tm)]
  const solution = lstsq(cols, Float64Array.from(y))
  if (!solution) return { c: meanOf(y), b: 0, ssr: sumSquaredDeviations(y) }
  return { c: solution.x[0], b: solution.x[1], ssr: solution.ssr }
}

/** Amplitude, phase, offset (and slope) by linear least squares for a given ω and σ: the LM starting point. */
function linearOscillation(
  tau: Float64Array,
  y: Float64Array,
  omega: number,
  sigma: number,
  linear: boolean,
  tm: number,
): number[] | null {
  const m = tau.length
  const ones = new Float64Array(m).fill(1)
  const cosCol = new Float64Array(m)
  const sinCol = new Float64Array(m)
  for (let k = 0; k < m; k += 1) {
    const e = Math.exp(-sigma * tau[k])
    cosCol[k] = e * Math.cos(omega * tau[k])
    sinCol[k] = e * Math.sin(omega * tau[k])
  }
  const cols = linear ? [ones, tau.map((x) => x - tm), cosCol, sinCol] : [ones, cosCol, sinCol]
  const solution = lstsq(cols, Float64Array.from(y))
  if (!solution) return null
  const x = solution.x
  const c = x[0]
  const b = linear ? x[1] : 0
  const pc = x[linear ? 2 : 1]
  const qs = x[linear ? 3 : 2]
  // A·cos(ωτ + φ) = A·cosφ·cos ωτ − A·sinφ·sin ωτ
  const amplitude = Math.hypot(pc, qs)
  const phase = Math.atan2(-qs, pc)
  return linear ? [amplitude, sigma, omega, phase, c, b] : [amplitude, sigma, omega, phase, c]
}

/**
 * ω from zero crossings of the detrended signal. A crossing counts only once the signal has moved beyond
 * ±hysteresis on the other side (noise near zero cannot add crossings); the crossing time is interpolated at the
 * last sign change. Needs ≥ 4 crossings (1.5 cycles); NaN otherwise.
 */
function zeroCrossingOmega(tau: Float64Array, r: Float64Array, hysteresis: number): number {
  const crossings: number[] = []
  let state = 0
  let lastCross = NaN
  for (let k = 0; k < r.length; k += 1) {
    if (k > 0) {
      const a = r[k - 1]
      const b = r[k]
      if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) lastCross = tau[k - 1] + ((tau[k] - tau[k - 1]) * a) / (a - b)
    }
    if (r[k] > hysteresis) {
      if (state < 0 && Number.isFinite(lastCross)) crossings.push(lastCross)
      state = 1
    } else if (r[k] < -hysteresis) {
      if (state > 0 && Number.isFinite(lastCross)) crossings.push(lastCross)
      state = -1
    }
  }
  if (crossings.length < 4) return NaN
  const intervals = crossings.slice(1).map((c, k) => c - crossings[k])
  const typical = median(intervals)
  const regular = intervals.filter((d) => d > 0.6 * typical && d < 1.4 * typical)
  if (regular.length < 3) return NaN
  return Math.PI / meanOf(Float64Array.from(regular))
}

/**
 * The strongest peaks of a least-squares periodogram: at each trial ω the binned residual is fitted with
 * {1, (t − tm), cos ωt, sin ωt} ({1, cos, sin} without a trend), which behaves well even with ~1 cycle in the window
 * (unlike an FFT). Returns up to `count` frequencies, strongest first, refined by parabolic interpolation.
 */
function periodogramPeaks(
  tau: Float64Array,
  r: Float64Array,
  span: number,
  linear: boolean,
  omegaMin: number,
  omegaMax: number,
  count: number,
): number[] {
  const m = tau.length
  const bins = Math.min(m, 1024)
  const width = span / bins
  const sum = new Float64Array(bins)
  const used = new Int32Array(bins)
  for (let k = 0; k < m; k += 1) {
    const b = Math.min(bins - 1, Math.floor(tau[k] / width))
    sum[b] += r[k]
    used[b] += 1
  }
  let nonEmpty = 0
  const value = new Float64Array(bins)
  const u = new Float64Array(bins)
  for (let b = 0; b < bins; b += 1) {
    if (used[b]) {
      value[b] = sum[b] / used[b]
      nonEmpty += 1
    }
    // Trend regressor scaled to [−0.5, 0.5] so the small normal-equation systems are well conditioned.
    u[b] = ((b + 0.5) * width - span / 2) / span
  }
  if (nonEmpty < 6) return []
  const omegaHi = Math.min(omegaMax, (0.8 * Math.PI) / width)
  if (!(omegaHi > omegaMin)) return []
  const spacing = TWO_PI / (6 * span)
  const nf = Math.max(3, Math.min(3000, Math.ceil((omegaHi - omegaMin) / spacing) + 1))
  const dOmega = (omegaHi - omegaMin) / (nf - 1)

  // Frequency-independent sums for the constant and trend regressors.
  let s0 = 0
  let su = 0
  let suu = 0
  let sv = 0
  let suv = 0
  for (let b = 0; b < bins; b += 1) {
    if (!used[b]) continue
    s0 += 1
    su += u[b]
    suu += u[b] * u[b]
    sv += value[b]
    suv += u[b] * value[b]
  }
  const p = linear ? 4 : 3
  const gram = new Float64Array(p * p)
  const rhs = new Float64Array(p)
  const power = new Float64Array(nf)
  for (let f = 0; f < nf; f += 1) {
    const omega = omegaMin + f * dOmega
    // Phasor recurrence across the uniform bin centres instead of a cos/sin call per bin.
    const rotC = Math.cos(omega * width)
    const rotS = Math.sin(omega * width)
    let c = Math.cos(omega * 0.5 * width)
    let s = Math.sin(omega * 0.5 * width)
    let sc = 0
    let ss = 0
    let suc = 0
    let sus = 0
    let scc = 0
    let sss = 0
    let scs = 0
    let svc = 0
    let svs = 0
    for (let b = 0; b < bins; b += 1) {
      if (used[b]) {
        const v = value[b]
        sc += c
        ss += s
        suc += u[b] * c
        sus += u[b] * s
        scc += c * c
        sss += s * s
        scs += c * s
        svc += v * c
        svs += v * s
      }
      const nc = c * rotC - s * rotS
      s = s * rotC + c * rotS
      c = nc
    }
    // Normal equations for [1, (u), cos, sin].
    const entries = linear
      ? [s0, su, sc, ss, su, suu, suc, sus, sc, suc, scc, scs, ss, sus, scs, sss]
      : [s0, sc, ss, sc, scc, scs, ss, scs, sss]
    gram.set(entries)
    if (linear) rhs.set([sv, suv, svc, svs])
    else rhs.set([sv, svc, svs])
    const beta = solveSmall(gram, rhs, p)
    let explained = 0
    if (beta) for (let j = 0; j < p; j += 1) explained += beta[j] * rhs[j]
    power[f] = explained
  }

  const peaks: { omega: number; power: number }[] = []
  for (let f = 0; f < nf; f += 1) {
    const left = f > 0 ? power[f - 1] : -Infinity
    const right = f < nf - 1 ? power[f + 1] : -Infinity
    if (!(power[f] > left && power[f] >= right)) continue
    let omega = omegaMin + f * dOmega
    if (f > 0 && f < nf - 1) {
      const denominator = left - 2 * power[f] + right
      if (denominator < 0) omega += clamp((0.5 * (left - right)) / denominator, -0.5, 0.5) * dOmega
    }
    peaks.push({ omega, power: power[f] })
  }
  peaks.sort((a, b) => b.power - a.power)
  return peaks.slice(0, count).map((pk) => pk.omega)
}

/** Cholesky solve that tolerates the occasional singular system (returns null). */
function solveSmall(gram: Float64Array, rhs: Float64Array, p: number): Float64Array | null {
  // Tiny ridge relative to the diagonal guards against rounding when two regressors are nearly collinear.
  const a = Float64Array.from(gram)
  for (let j = 0; j < p; j += 1) a[j * p + j] *= 1 + 1e-12
  const l = new Float64Array(p * p)
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = a[i * p + j]
      for (let k = 0; k < j; k += 1) s -= l[i * p + k] * l[j * p + k]
      if (i === j) {
        if (!(s > 0)) return null
        l[i * p + i] = Math.sqrt(s)
      } else {
        l[i * p + j] = s / l[j * p + j]
      }
    }
  }
  const x = new Float64Array(p)
  for (let i = 0; i < p; i += 1) {
    let s = rhs[i]
    for (let k = 0; k < i; k += 1) s -= l[i * p + k] * x[k]
    x[i] = s / l[i * p + i]
  }
  for (let i = p - 1; i >= 0; i -= 1) {
    let s = x[i]
    for (let k = i + 1; k < p; k += 1) s -= l[k * p + i] * x[k]
    x[i] = s / l[i * p + i]
  }
  return x
}

/**
 * Decay rate σ from the amplitudes of successive turning points (alternating maxima and minima, about zero):
 * the slope of ln|peak| against time is −σ. 0 when fewer than two usable peaks.
 */
function decayFromPeaks(tau: Float64Array, r: Float64Array, omega: number, dt: number): number {
  const spacing = Math.max(1, Math.round((0.6 * TWO_PI) / omega / dt))
  const peaks = detectPeaks(r, undefined, undefined, spacing)
  let maxAbs = 0
  for (const pk of peaks) maxAbs = Math.max(maxAbs, Math.abs(r[pk.pos]))
  const xs: number[] = []
  const ls: number[] = []
  for (const pk of peaks) {
    const v = r[pk.pos]
    const signOk = pk.kind === 'max' ? v > 0 : v < 0
    if (signOk && Math.abs(v) >= 0.1 * maxAbs) {
      xs.push(tau[pk.pos])
      ls.push(Math.log(Math.abs(v)))
    }
  }
  if (xs.length < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const ml = ls.reduce((a, b) => a + b, 0) / ls.length
  let sxx = 0
  let sxl = 0
  for (let k = 0; k < xs.length; k += 1) {
    sxx += (xs[k] - mx) ** 2
    sxl += (xs[k] - mx) * (ls[k] - ml)
  }
  return sxx > 0 ? -sxl / sxx : 0
}

/**
 * Damping ratio from the logarithmic decrement δ = (1/n)·ln(x0/xn) over runs of successive same-sign peaks of the
 * detrended signal (maxima above zero, minima below; consecutive peaks about one period apart), combined over all
 * runs weighted by their cycle counts: ζ = δ/√(4π² + δ²). Peaks below 10% of the largest are ignored (noise).
 */
function logDecrementZeta(peaks: RawPeak[], tau: Float64Array, d: Float64Array, period: number): number {
  if (!(period > 0)) return NaN
  let maxAbs = 0
  for (const pk of peaks) maxAbs = Math.max(maxAbs, Math.abs(d[pk.pos]))
  const floor = 0.1 * maxAbs
  let sumLog = 0
  let cycles = 0
  for (const kind of ['max', 'min'] as const) {
    let run: number[] = []
    const flush = () => {
      if (run.length >= 2) {
        sumLog += Math.log(Math.abs(d[run[0]]) / Math.abs(d[run[run.length - 1]]))
        cycles += run.length - 1
      }
      run = []
    }
    for (const pk of peaks) {
      if (pk.kind !== kind) continue
      const v = d[pk.pos]
      if ((kind === 'max' ? v <= 0 : v >= 0) || Math.abs(v) < floor) {
        flush()
        continue
      }
      if (run.length) {
        const gap = tau[pk.pos] - tau[run[run.length - 1]]
        if (gap < 0.6 * period || gap > 1.5 * period) flush()
      }
      run.push(pk.pos)
    }
    flush()
  }
  if (cycles === 0) return NaN
  const delta = sumLog / cycles
  return delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta)
}

function failedOscillation(length: number, t0: number, message: string): OscillationFit {
  return {
    ok: false,
    message,
    amplitude: NaN,
    sigma: NaN,
    omegaD: NaN,
    phase: NaN,
    offset: NaN,
    slope: NaN,
    zeta: NaN,
    omegaN: NaN,
    periodS: NaN,
    halfLifeS: NaN,
    r2: NaN,
    cycles: NaN,
    t0,
    fitted: new Float64Array(length).fill(NaN),
    peaks: [],
    zetaLogDec: NaN,
  }
}

// ---------------------------------------------------------------------------------------------- first-order pieces

/** c and A by linear least squares for y = c + A·e^(−kτ), with the residual sum of squares. */
function linearFirstOrder(tau: Float64Array, y: Float64Array, k: number): { c: number; a: number; ssr: number } | null {
  const m = tau.length
  const e = new Float64Array(m)
  for (let j = 0; j < m; j += 1) e[j] = Math.exp(-k * tau[j])
  const solution = lstsq([new Float64Array(m).fill(1), e], Float64Array.from(y))
  if (!solution || !Number.isFinite(solution.ssr)) return null
  return { c: solution.x[0], a: solution.x[1], ssr: solution.ssr }
}

/** 1/τ from the time the response covers 63.2% (1 − 1/e) of its change from the first to the final value. */
function rateFrom63Percent(tau: Float64Array, y: Float64Array): number {
  const m = y.length
  const tail = Math.max(3, Math.floor(m / 10))
  let final = 0
  for (let k = m - tail; k < m; k += 1) final += y[k] / tail
  const start = y[0]
  const change = final - start
  if (!(Math.abs(change) > 0)) return NaN
  const target = 1 - Math.exp(-1)
  for (let k = 1; k < m; k += 1) {
    const f = (y[k] - start) / change
    if (f >= target) {
      const fPrev = (y[k - 1] - start) / change
      const when = tau[k - 1] + ((tau[k] - tau[k - 1]) * (target - fPrev)) / (f - fPrev || 1)
      return when > 0 ? 1 / when : NaN
    }
  }
  return NaN
}

/**
 * Rate from the slopes of the first and last thirds: for c + A·e^(−kτ) the slope ratio over a time Δ is e^(−kΔ).
 * Handles divergent responses (ratio > 1 → k < 0). NaN when the slopes differ in sign.
 */
function rateFromSlopes(tau: Float64Array, y: Float64Array): number {
  const m = y.length
  const third = Math.floor(m / 3)
  if (third < 2) return NaN
  const first = lineSlope(tau, y, 0, third)
  const last = lineSlope(tau, y, m - third, m)
  const ratio = last.slope / first.slope
  const gap = last.tMean - first.tMean
  if (!(ratio > 0) || !Number.isFinite(ratio) || !(gap > 0)) return NaN
  return -Math.log(ratio) / gap
}

function lineSlope(tau: Float64Array, y: Float64Array, from: number, to: number): { slope: number; tMean: number } {
  let tMean = 0
  let yMean = 0
  const n = to - from
  for (let k = from; k < to; k += 1) {
    tMean += tau[k] / n
    yMean += y[k] / n
  }
  let stt = 0
  let sty = 0
  for (let k = from; k < to; k += 1) {
    stt += (tau[k] - tMean) ** 2
    sty += (tau[k] - tMean) * (y[k] - yMean)
  }
  return { slope: stt > 0 ? sty / stt : NaN, tMean }
}

function failedFirstOrder(length: number, t0: number, message: string): FirstOrderFit {
  return {
    ok: false,
    message,
    amplitude: NaN,
    offset: NaN,
    tau: NaN,
    halfLifeS: NaN,
    r2: NaN,
    t0,
    fitted: new Float64Array(length).fill(NaN),
  }
}
