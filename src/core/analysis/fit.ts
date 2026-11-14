// Polynomial least squares (degree 1..3), optional weights, with goodness of fit. Numerically stable (centre and
// scale x, solve by QR / Householder or Cholesky on the scaled normal equations), NaN pairs skipped.
// OWNER: analysis agent. Public API below is a contract; keep these signatures.

import { invertUpperTriangular, lstsq } from './linalg'

export interface PolyFit {
  degree: number
  /** Coefficients in the ORIGINAL x units, lowest power first: y = c0 + c1 x + c2 x² + ... */
  coeffs: number[]
  /** Standard errors of coeffs (same order); NaN when n <= degree + 1 */
  stderr: number[]
  r2: number
  rmse: number
  /** finite pairs used */
  n: number
  xMin: number
  xMax: number
}

/** The app uses degrees 1..3; QR on scaled x stays accurate well beyond that, so a little headroom is allowed. */
const MAX_DEGREE = 6

/**
 * Returns null when there are fewer than degree + 1 distinct finite x values.
 *
 * Pairs are used when x and y are finite (and, with `weights`, the weight is finite and > 0). Weights are relative
 * (e.g. 1/σ² or sample counts): the standard errors use the residual scatter, so scaling every weight by the same
 * factor changes nothing. r2 is the (weighted) coefficient of determination; rmse is the root-mean-square residual
 * √(Σw·r² / Σw), i.e. the plain RMS residual without weights.
 */
export function polyFit(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  degree: number,
  weights?: ArrayLike<number>,
): PolyFit | null {
  if (!Number.isInteger(degree) || degree < 0 || degree > MAX_DEGREE) {
    throw new RangeError(`polyFit: degree must be an integer from 0 to ${MAX_DEGREE} (got ${degree})`)
  }
  const p = degree + 1
  const len = Math.min(x.length, y.length, weights ? weights.length : Infinity)
  const xs: number[] = []
  const ys: number[] = []
  const ws: number[] = []
  for (let i = 0; i < len; i += 1) {
    const xi = x[i]
    const yi = y[i]
    const wi = weights ? weights[i] : 1
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(wi) || !(wi > 0)) continue
    xs.push(xi)
    ys.push(yi)
    ws.push(wi)
  }
  const m = xs.length
  if (!hasDistinct(xs, p)) return null

  let xMin = Infinity
  let xMax = -Infinity
  for (const v of xs) {
    if (v < xMin) xMin = v
    if (v > xMax) xMax = v
  }
  // Map x onto [−1, 1]: the scaled Vandermonde matrix is well conditioned whatever the units or offset of x.
  const mid = (xMin + xMax) / 2
  const half = (xMax - xMin) / 2 || 1
  const cols = Array.from({ length: p }, () => new Float64Array(m))
  const rhs = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    const s = (xs[i] - mid) / half
    const sw = Math.sqrt(ws[i])
    let term = sw
    for (let k = 0; k < p; k += 1) {
      cols[k][i] = term
      term *= s
    }
    rhs[i] = sw * ys[i]
  }
  const solution = lstsq(cols, rhs)
  if (!solution) return null
  const a = solution.x

  // Goodness of fit from the residuals themselves (in the scaled basis, where evaluation is accurate).
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
    const s = (xs[i] - mid) / half
    let fitted = 0
    for (let k = p - 1; k >= 0; k -= 1) fitted = fitted * s + a[k]
    const r = ys[i] - fitted
    const d = ys[i] - yMean
    ssr += ws[i] * r * r
    sst += ws[i] * d * d
  }
  // y constant to rounding: the fit is exact by construction (the constant term reproduces it).
  const constantY = sst <= wSum * (1e-14 * yAbsMax) ** 2
  const r2 = constantY ? 1 : 1 - ssr / sst
  const rmse = Math.sqrt(ssr / wSum)

  // Covariance of the scaled-basis coefficients: s²·(AᵀWA)⁻¹ = s²·R⁻¹R⁻ᵀ.
  const dof = m - p
  const s2 = dof > 0 ? ssr / dof : NaN
  const rInv = invertUpperTriangular(solution.r, p)
  const covA = new Float64Array(p * p)
  for (let j = 0; j < p; j += 1) {
    for (let k = 0; k < p; k += 1) {
      let s = 0
      for (let l = Math.max(j, k); l < p; l += 1) s += rInv[j * p + l] * rInv[k * p + l]
      covA[j * p + k] = s2 * s
    }
  }

  // Back to original units: ((x − mid)/half)^k = Σ_j C(k, j)·x^j·(−mid)^(k−j) / half^k, so c = T·a.
  const tMat = new Float64Array(p * p)
  for (let k = 0; k < p; k += 1) {
    const invHalfPow = 1 / half ** k
    for (let j = 0; j <= k; j += 1) tMat[j * p + k] = binomial(k, j) * (-mid) ** (k - j) * invHalfPow
  }
  const coeffs: number[] = []
  const stderr: number[] = []
  for (let j = 0; j < p; j += 1) {
    let c = 0
    for (let k = 0; k < p; k += 1) c += tMat[j * p + k] * a[k]
    coeffs.push(c)
    // Var(c_j) = (T·Cov_a·Tᵀ)_jj
    let variance = 0
    for (let k = 0; k < p; k += 1) {
      let row = 0
      for (let l = 0; l < p; l += 1) row += covA[k * p + l] * tMat[j * p + l]
      variance += tMat[j * p + k] * row
    }
    stderr.push(dof > 0 ? Math.sqrt(Math.max(0, variance)) : NaN)
  }

  return { degree, coeffs, stderr, r2, rmse, n: m, xMin, xMax }
}

/** true when `values` holds at least `count` distinct numbers (stops early). */
function hasDistinct(values: readonly number[], count: number): boolean {
  const seen: number[] = []
  for (const v of values) {
    if (!seen.includes(v)) {
      seen.push(v)
      if (seen.length >= count) return true
    }
  }
  return false
}

function binomial(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i
  return result
}

/** Horner evaluation of c0 + c1·x + c2·x² + ... (0 for no coefficients). */
export function evalPoly(coeffs: readonly number[], x: number): number {
  let acc = 0
  for (let k = coeffs.length - 1; k >= 0; k -= 1) acc = acc * x + coeffs[k]
  return acc
}

const MINUS = '−'
const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
}

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((ch) => SUPERSCRIPTS[ch] ?? ch)
    .join('')
}

function stripZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * A magnitude (≥ 0) with 4 significant figures, trailing zeros dropped: 3.01, 0.0123, 1235, 12346 (integers keep
 * every digit), 1.235×10⁻⁵ and 2.5×10⁶ outside [0.001, 10⁶).
 */
export function formatMagnitude(a: number): string {
  if (Number.isNaN(a)) return 'NaN'
  if (!Number.isFinite(a)) return '∞'
  if (a === 0) return '0'
  if (a >= 1e6 || a < 1e-3) {
    const [mantissa, exponent] = a.toExponential(3).split('e')
    return `${stripZeros(mantissa)}×10${superscript(Number(exponent))}`
  }
  if (a >= 1e4) return Math.round(a).toString()
  const text = a.toPrecision(4)
  return text.includes('e') ? Math.round(a).toString() : stripZeros(text)
}

/** A signed number for display with a real minus sign (U+2212). */
export function formatNumber(v: number): string {
  return (v < 0 ? MINUS : '') + formatMagnitude(Math.abs(v))
}

/** "y = −3.01·x + 1.23   (R² = 0.998, n = 4)" with sensible significant figures; names default to x and y. */
export function formatFit(fit: PolyFit, xName?: string, yName?: string): string {
  const x = xName ?? 'x'
  // Wrap labels such as "KIAS [kt]" so a power or product cannot be misread.
  const xn = /^[\p{L}\p{N}_]+$/u.test(x) ? x : `(${x})`
  let expression = ''
  for (let k = fit.coeffs.length - 1; k >= 0; k -= 1) {
    const c = fit.coeffs[k]
    if (c === 0) continue
    const magnitude = formatMagnitude(Math.abs(c))
    const variable = k === 0 ? '' : k === 1 ? xn : `${xn}${superscript(k)}`
    const term = !variable ? magnitude : magnitude === '1' ? variable : `${magnitude}·${variable}`
    if (!expression) expression = c < 0 ? MINUS + term : term
    else expression += c < 0 ? ` ${MINUS} ${term}` : ` + ${term}`
  }
  if (!expression) expression = '0'
  const r2 = Number.isFinite(fit.r2) ? (fit.r2 >= 0.999 && fit.r2 < 1 ? fit.r2.toFixed(4) : fit.r2.toFixed(3)) : '—'
  return `${yName ?? 'y'} = ${expression}   (R² = ${r2.replace('-', MINUS)}, n = ${fit.n})`
}
