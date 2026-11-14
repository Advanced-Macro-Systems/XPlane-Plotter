// Range and endurance from steady, level flight-test points: two physical curve fits from the parabolic drag polar,
// and the two classic constructions on a curve of power or thrust required against airspeed.
//
// Theory. With the parabolic polar CD = CD0 + K·CL² and lift = weight, level-flight drag is D = A·V² + B/V²
// (A = ½ρS·CD0, B = K·W²/(½ρS)) and the power required is P = D·V = A·V³ + B/V.
// - Propeller aircraft (fuel flow follows engine power): plot POWER against true airspeed. Its minimum is the speed for
//   maximum endurance V_E (least fuel per hour); the tangent from the origin touches the curve where P/V, i.e. the
//   drag, is least: the speed for maximum range V_R (least fuel per mile). Power model: V_E = (B/3A)^¼, V_R = (B/A)^¼.
// - Jets (fuel flow follows thrust): plot THRUST (= drag) against TAS. Its minimum (least drag) is maximum endurance;
//   the origin tangent (least T/V) is maximum range. Drag model: V_E = (B/A)^¼, V_R = (3B/A)^¼.
//   Either way V_R / V_E = 3^¼ ≈ 1.316.
// A constant scale on V (KIAS or KEAS instead of TAS at one altitude) moves neither construction: f(V/c) has its
// minimum, and its least value of y/V, at c times the speeds found in V. The results hold for the weight and altitude
// flown: nothing here reduces them to standard conditions. A physical fit gives no speeds when it does not explain the
// points (R² <= 0) or when A or B is within two standard errors of zero (physicalProblem).
//
// Polynomial fits (core/analysis/fit.ts) get the same two points numerically: a dense scan of the fitted speed range
// widened by RE_MARGIN of its span on each side, then bisection on the derivative to full precision.
// exports/matlabLibrary.ts (xppRangeEndurance) repeats exactly this procedure, so MATLAB reports the same numbers.

import { evalPoly, formatMagnitude, formatNumber, type PolyFit } from './fit'
import { invertUpperTriangular, lstsq } from './linalg'

export type PhysicalModel = 'power' | 'drag'

/** The powers of V in each model, y = A·V^p + B·V^q: power A·V³ + B/V, drag (or thrust) A·V² + B/V². */
export const MODEL_POWERS: Readonly<Record<PhysicalModel, readonly [p: number, q: number]>> = {
  power: [3, -1],
  drag: [2, -2],
}

/** V_R / V_E for both physical models: 3^¼. */
export const PHYSICAL_RATIO = 3 ** 0.25

export interface PhysicalFit {
  model: PhysicalModel
  /** y = A·V³ + B/V (power) or y = A·V² + B/V² (drag) */
  a: number
  b: number
  /** Standard errors of a and b; NaN when n <= 2 */
  aSe: number
  bSe: number
  /** (Weighted) coefficient of determination about the mean of y; NaN when y does not vary */
  r2: number
  /** Root-mean-square residual √(Σw·r² / Σw) */
  rmse: number
  /** Pairs used (finite, V > 0) */
  n: number
  /** Speed range of the pairs used */
  xMin: number
  xMax: number
}

/**
 * Least-squares fit of a physical model through (v, y): linear in A and B, so solved by Householder QR on the columns
 * [u^p, u^q] with u = V / V_ref (V_ref the geometric mean of the speed range) so that both columns are of order one.
 * Pairs are used when V > 0 and y (and, with `weights`, the weight > 0) are finite. Weights are relative, as in
 * polyFit. Returns null with fewer than 2 distinct speeds.
 */
export function physicalFit(
  v: ArrayLike<number>,
  y: ArrayLike<number>,
  model: PhysicalModel,
  weights?: ArrayLike<number>,
): PhysicalFit | null {
  const [p, q] = MODEL_POWERS[model]
  const len = Math.min(v.length, y.length, weights ? weights.length : Infinity)
  const vs: number[] = []
  const ys: number[] = []
  const ws: number[] = []
  for (let i = 0; i < len; i += 1) {
    const vi = v[i]
    const yi = y[i]
    const wi = weights ? weights[i] : 1
    if (!Number.isFinite(vi) || !(vi > 0) || !Number.isFinite(yi) || !Number.isFinite(wi) || !(wi > 0)) continue
    vs.push(vi)
    ys.push(yi)
    ws.push(wi)
  }
  const m = vs.length
  let xMin = Infinity
  let xMax = -Infinity
  for (const value of vs) {
    if (value < xMin) xMin = value
    if (value > xMax) xMax = value
  }
  if (!(xMax > xMin)) return null

  const ref = Math.sqrt(xMin * xMax)
  const colA = new Float64Array(m)
  const colB = new Float64Array(m)
  const rhs = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    const u = vs[i] / ref
    const sw = Math.sqrt(ws[i])
    colA[i] = sw * u ** p
    colB[i] = sw * u ** q
    rhs[i] = sw * ys[i]
  }
  const solution = lstsq([colA, colB], rhs)
  if (!solution) return null
  const [alpha, beta] = solution.x
  const a = alpha / ref ** p
  const b = beta / ref ** q

  let wSum = 0
  let yMean = 0
  let yAbsMax = 0
  for (let i = 0; i < m; i += 1) {
    wSum += ws[i]
    yMean += (ws[i] / wSum) * (ys[i] - yMean)
    yAbsMax = Math.max(yAbsMax, Math.abs(ys[i]))
  }
  let ssr = 0
  let sst = 0
  for (let i = 0; i < m; i += 1) {
    const u = vs[i] / ref
    const r = ys[i] - (alpha * u ** p + beta * u ** q)
    const d = ys[i] - yMean
    ssr += ws[i] * r * r
    sst += ws[i] * d * d
  }
  // R² is undefined when y does not vary (the model has no constant term to reproduce it).
  const constantY = sst <= wSum * (1e-14 * yAbsMax) ** 2
  const r2 = constantY ? NaN : 1 - ssr / sst
  const rmse = Math.sqrt(ssr / wSum)

  // Covariance of (alpha, beta): s²·(MᵀWM)⁻¹ = s²·R⁻¹R⁻ᵀ; A and B are alpha and beta over constants.
  const dof = m - 2
  const s2 = dof > 0 ? ssr / dof : NaN
  const rInv = invertUpperTriangular(solution.r, 2)
  const varAlpha = s2 * (rInv[0] * rInv[0] + rInv[1] * rInv[1])
  const varBeta = s2 * (rInv[3] * rInv[3])
  return {
    model,
    a,
    b,
    aSe: dof > 0 ? Math.sqrt(Math.max(0, varAlpha)) / ref ** p : NaN,
    bSe: dof > 0 ? Math.sqrt(Math.max(0, varBeta)) / ref ** q : NaN,
    r2,
    rmse,
    n: m,
    xMin,
    xMax,
  }
}

/** The physical model's value at speed v. */
export function physicalValue(fit: Pick<PhysicalFit, 'model' | 'a' | 'b'>, v: number): number {
  const [p, q] = MODEL_POWERS[fit.model]
  return fit.a * v ** p + fit.b * v ** q
}

/**
 * "Power = 4.794×10⁻⁵·KTAS³ + 3260/KTAS   (R² = 0.998, n = 6)", like formatFit: 4 significant figures, real minus
 * signs, a name that is not a plain word wrapped in brackets. Names default to V and y.
 */
export function formatPhysical(fit: PhysicalFit, xName?: string, yName?: string): string {
  const x = xName ?? 'V'
  const xn = /^[\p{L}\p{N}_]+$/u.test(x) ? x : `(${x})`
  const [p, q] = MODEL_POWERS[fit.model]
  const power = (k: number) => (k === 2 ? '²' : k === 3 ? '³' : '')
  const first = `${fit.a < 0 ? '−' : ''}${formatMagnitude(Math.abs(fit.a))}·${xn}${power(p)}`
  const second = `${formatMagnitude(Math.abs(fit.b))}/${xn}${power(-q)}`
  const r2 = Number.isFinite(fit.r2) ? (fit.r2 >= 0.999 && fit.r2 < 1 ? fit.r2.toFixed(4) : fit.r2.toFixed(3)) : '—'
  return `${yName ?? 'y'} = ${first} ${fit.b < 0 ? '−' : '+'} ${second}   (R² = ${r2.replace('-', '−')}, n = ${fit.n})`
}

// ------------------------------------------------------------------ the two constructions

export interface REPoint {
  /** Speed (x-axis units) */
  v: number
  /** The fitted curve's value there (y-axis units) */
  y: number
  /** Outside the speed range of the data the fit used */
  extrapolated: boolean
}

export interface RangeEndurance {
  /** Maximum endurance: the curve's minimum, or null (see enduranceNote) */
  endurance: REPoint | null
  /** Maximum range: where the tangent from the origin touches the curve, or null (see rangeNote) */
  range: REPoint | null
  /** Why there is no endurance point ('' when there is one) */
  enduranceNote: string
  /** Why there is no range point ('' when there is one) */
  rangeNote: string
  /** Slope of the origin tangent: y/V at V_R (NaN without a range point) */
  slope: number
  /** V_R / V_E (NaN unless both exist) */
  ratio: number
  /** The speeds searched (the fitted range widened by RE_MARGIN of its span), or null without positive speeds */
  window: [number, number] | null
}

/** The fitted speed range is widened by this share of its span on each side for the search (and no further). */
export const RE_MARGIN = 0.5
/** Intervals of the dense scan over the search window. */
export const RE_SCAN = 2000
/** The window never reaches below this share of the slowest fitted speed (V = 0 is a singularity of y/V). */
const RE_FLOOR = 0.1

/**
 * The speeds searched: [xMin − m, xMax + m] with m = RE_MARGIN·(xMax − xMin), kept above RE_FLOOR·xMin (or a
 * thousandth of xMax when the data reach V <= 0). null when no speed is positive.
 */
export function searchWindow(xMin: number, xMax: number): [number, number] | null {
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !(xMax > 0) || xMax < xMin) return null
  const margin = RE_MARGIN * (xMax - xMin)
  const floor = xMin > 0 ? RE_FLOOR * xMin : 1e-3 * xMax
  return [Math.max(xMin - margin, floor), xMax + margin]
}

const NO_SPEEDS = 'Needs test points at positive speeds.'

function point(v: number, y: number, xMin: number, xMax: number): REPoint {
  return { v, y, extrapolated: v < xMin || v > xMax }
}

function finish(
  endurance: REPoint | null,
  range: REPoint | null,
  enduranceNote: string,
  rangeNote: string,
  window: [number, number] | null,
): RangeEndurance {
  return {
    endurance,
    range,
    enduranceNote: endurance ? '' : enduranceNote,
    rangeNote: range ? '' : rangeNote,
    slope: range ? range.y / range.v : NaN,
    ratio: endurance && range ? range.v / endurance.v : NaN,
    window,
  }
}

const between = (w: [number, number]) => `between ${formatNumber(w[0])} and ${formatNumber(w[1])}`

/** A and B count as clearly positive only this many standard errors above zero (about 95 % confidence). */
export const RE_SIGNIFICANCE = 2

/**
 * Why a physical fit cannot place the two speeds, or '' when it can: it needs A > 0 and B > 0, a fit that explains
 * the points (R² > 0; none when y does not vary), and A and B each at least RE_SIGNIFICANCE standard errors above zero
 * (otherwise the minimum could be almost anywhere: a fit through a whole log, taxiing included, ends up there). Without
 * standard errors (two points: an exact solve) only the signs count.
 */
export function physicalProblem(fit: PhysicalFit): string {
  const { a, b } = fit
  const least = fit.model === 'power' ? 'power' : 'drag'
  if (!(a > 0) || !(b > 0)) {
    const shape = fit.model === 'power' ? 'A·V³ + B/V' : 'A·V² + B/V²'
    return (
      `No minimum: ${shape} has one only when A and B are both positive (here A = ${formatNumber(a)}, ` +
      `B = ${formatNumber(b)}). Test points on both sides of the minimum-${least} speed fix that.`
    )
  }
  if (Number.isNaN(fit.r2)) {
    return 'No minimum: y does not vary across these points, so the model has no curve to read the speeds from.'
  }
  if (!(fit.r2 > 0)) {
    return (
      `No minimum: the model does not fit these points (R² = ${fit.r2.toFixed(3).replace('-', '−')}), so neither ` +
      'speed can be read from it. Fit it through the means of steady level test points.'
    )
  }
  const weak = [
    a < RE_SIGNIFICANCE * fit.aSe ? 'A' : '',
    b < RE_SIGNIFICANCE * fit.bSe ? 'B' : '',
  ].filter(Boolean)
  if (weak.length) {
    return (
      `No minimum: ${weak.join(' and ')} ${weak.length > 1 ? 'are' : 'is'} within two standard errors of zero ` +
      `(A = ${formatNumber(a)} ± ${formatNumber(fit.aSe)}, B = ${formatNumber(b)} ± ${formatNumber(fit.bSe)}), so the ` +
      `minimum could be almost anywhere. Test points on both sides of the minimum-${least} speed fix that.`
    )
  }
  return ''
}

/**
 * Maximum endurance and maximum range of a physical fit, in closed form (when physicalProblem finds none). A speed
 * outside the search window (far beyond the test points) is not reported: the note says where it would be.
 */
export function physicalRangeEndurance(fit: PhysicalFit): RangeEndurance {
  const window = searchWindow(fit.xMin, fit.xMax)
  if (!window) return finish(null, null, NO_SPEEDS, NO_SPEEDS, null)
  const { a, b } = fit
  const problem = physicalProblem(fit)
  if (problem) return finish(null, null, problem, problem, window)
  // Power: V_E = (B/3A)^¼, V_R = (B/A)^¼. Drag: V_E = (B/A)^¼, V_R = (3B/A)^¼.
  const vE = fit.model === 'power' ? (b / (3 * a)) ** 0.25 : (b / a) ** 0.25
  const vR = fit.model === 'power' ? (b / a) ** 0.25 : ((3 * b) / a) ** 0.25
  const inside = (v: number) => v >= window[0] && v <= window[1]
  const far = (what: string, v: number) =>
    `The ${what} would be at V = ${formatNumber(v)}, far outside the test points (${formatNumber(fit.xMin)} to ` +
    `${formatNumber(fit.xMax)}): not shown. Fly test points nearer that speed.`
  return finish(
    inside(vE) ? point(vE, physicalValue(fit, vE), fit.xMin, fit.xMax) : null,
    inside(vR) ? point(vR, physicalValue(fit, vR), fit.xMin, fit.xMax) : null,
    far('minimum', vE),
    far('tangent point', vR),
    window,
  )
}

/** Coefficients (lowest power first) of the derivative of a polynomial. */
function derivative(coeffs: readonly number[]): number[] {
  return coeffs.slice(1).map((c, k) => (k + 1) * c)
}

/**
 * Coefficients of h(V) = V·f'(V) − f(V) = Σ (k − 1)·c_k·V^k: d/dV (f/V) = h/V², so h changes sign from − to + where
 * f/V is least (the tangent from the origin).
 */
function tangentCondition(coeffs: readonly number[]): number[] {
  return coeffs.map((c, k) => (k - 1) * c)
}

/**
 * The lowest interior local minimum of `values` on the scan (a sample lower than the one before and not higher than
 * the one after; never an end sample), or -1 when there is none.
 */
function interiorMinimum(values: Float64Array): number {
  let best = -1
  for (let i = 1; i < values.length - 1; i += 1) {
    if (values[i] < values[i - 1] && values[i] <= values[i + 1] && (best < 0 || values[i] < values[best])) best = i
  }
  return best
}

/**
 * The root of `d` in [lo, hi] where it goes from <= 0 to >= 0, by bisection to full double precision; `guess` when the
 * bracket does not hold (the scan's sample, for a curve flat to rounding there).
 */
function bisect(d: (v: number) => number, lo: number, hi: number, guess: number): number {
  let a = lo
  let b = hi
  const da = d(a)
  const db = d(b)
  if (da === 0) return a
  if (db === 0) return b
  if (!(da < 0 && db > 0)) return guess
  for (let k = 0; k < 200; k += 1) {
    const mid = a + (b - a) / 2
    if (!(mid > a && mid < b)) break
    const dm = d(mid)
    if (dm === 0) return mid
    if (dm < 0) a = mid
    else b = mid
  }
  return a + (b - a) / 2
}

/** The scan's speeds: lo + (hi − lo)·i / RE_SCAN, i = 0 … RE_SCAN. */
function scanSpeeds(window: [number, number]): Float64Array {
  const [lo, hi] = window
  const out = new Float64Array(RE_SCAN + 1)
  for (let i = 0; i <= RE_SCAN; i += 1) out[i] = lo + ((hi - lo) * i) / RE_SCAN
  return out
}

/**
 * Maximum endurance (the lowest interior minimum of the fitted polynomial) and maximum range (the lowest interior
 * minimum of f(V)/V, where the tangent from the origin touches; the curve must be positive there), found by a dense
 * scan of the search window and refined by bisection on f' and on V·f' − f. "None" when the minimum would lie on the
 * window's edge (the curve keeps falling) — a straight line never has either.
 */
export function polyRangeEndurance(fit: PolyFit): RangeEndurance {
  const window = searchWindow(fit.xMin, fit.xMax)
  if (!window) return finish(null, null, NO_SPEEDS, NO_SPEEDS, null)
  const c = fit.coeffs
  if (fit.degree < 2 || c.slice(2).every((k) => k === 0)) {
    const note = 'A straight line has neither a minimum nor a tangent from the origin: fit a curve.'
    return finish(null, null, note, note, window)
  }
  const speeds = scanSpeeds(window)
  const f = speeds.map((v) => evalPoly(c, v))
  const g = speeds.map((v, i) => f[i] / v)

  let endurance: REPoint | null = null
  const iE = interiorMinimum(f)
  if (iE > 0) {
    const fPrime = derivative(c)
    const v = bisect((x) => evalPoly(fPrime, x), speeds[iE - 1], speeds[iE + 1], speeds[iE])
    endurance = point(v, evalPoly(c, v), fit.xMin, fit.xMax)
  }

  let range: REPoint | null = null
  let rangeNote = `No tangent from the origin touches the fitted curve ${between(window)}.`
  const iR = interiorMinimum(g)
  if (iR > 0) {
    const h = tangentCondition(c)
    const v = bisect((x) => evalPoly(h, x), speeds[iR - 1], speeds[iR + 1], speeds[iR])
    const y = evalPoly(c, v)
    if (y > 0) range = point(v, y, fit.xMin, fit.xMax)
    else rangeNote = 'The tangent from the origin would touch the curve where it is not positive.'
  }
  return finish(
    endurance,
    range,
    `No minimum ${between(window)}: the fitted curve keeps falling or rising there.`,
    rangeNote,
    window,
  )
}
