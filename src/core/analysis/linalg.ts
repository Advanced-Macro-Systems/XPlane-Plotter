// Small dense linear algebra for the fitting code: Householder least squares, Cholesky solves and triangular
// inverses. Square matrices are row-major Float64Arrays; least-squares design matrices are passed as columns so the
// long dimension (samples) is contiguous in memory.

export interface LstsqResult {
  /** Solution vector, length p */
  x: Float64Array
  /** Upper-triangular factor R of A = QR (p×p, row-major) — R⁻¹R⁻ᵀ is (AᵀA)⁻¹ for covariances */
  r: Float64Array
  /** Residual sum of squares ‖A·x − b‖² */
  ssr: number
}

/**
 * Solves min ‖A·x − b‖ by Householder QR, which avoids squaring the condition number as the normal equations do.
 * `columns` are the p columns of A (each of length m ≥ p). Both `columns` and `b` are overwritten.
 * Returns null when A is (numerically) rank deficient.
 */
export function lstsq(columns: Float64Array[], b: Float64Array): LstsqResult | null {
  const p = columns.length
  const m = b.length
  if (p === 0 || m < p) return null
  const r = new Float64Array(p * p)

  // Column norms before any reflection, to judge rank deficiency relative to each column's own scale.
  const norms = columns.map((col) => norm(col, 0, m))

  for (let k = 0; k < p; k += 1) {
    const v = columns[k]
    let alpha = norm(v, k, m)
    if (!(alpha > 1e-13 * norms[k]) || !Number.isFinite(alpha)) return null
    // Reflect onto −sign(v_k)·‖v‖·e_k so the subtraction below never cancels.
    if (v[k] > 0) alpha = -alpha
    v[k] -= alpha
    // uᵀu / 2 for the Householder vector u = v[k..m) (always > 0 by the sign choice above)
    const beta = -alpha * v[k]
    for (let j = k + 1; j < p; j += 1) reflect(v, columns[j], k, m, beta)
    reflect(v, b, k, m, beta)
    r[k * p + k] = alpha
    for (let j = k + 1; j < p; j += 1) r[k * p + j] = columns[j][k]
  }

  const x = new Float64Array(p)
  for (let k = p - 1; k >= 0; k -= 1) {
    let s = b[k]
    for (let j = k + 1; j < p; j += 1) s -= r[k * p + j] * x[j]
    x[k] = s / r[k * p + k]
  }
  let ssr = 0
  for (let i = p; i < m; i += 1) ssr += b[i] * b[i]
  return { x, r, ssr }
}

/** c ← c − (uᵀc / beta)·u over rows [k, m), where u is stored in v[k..m). */
function reflect(v: Float64Array, c: Float64Array, k: number, m: number, beta: number): void {
  let dot = 0
  for (let i = k; i < m; i += 1) dot += v[i] * c[i]
  const f = dot / beta
  if (f === 0) return
  for (let i = k; i < m; i += 1) c[i] -= f * v[i]
}

/** Euclidean norm of v[from..to), scaled to avoid overflow / underflow. */
function norm(v: Float64Array, from: number, to: number): number {
  let scale = 0
  for (let i = from; i < to; i += 1) {
    const a = Math.abs(v[i])
    if (a > scale) scale = a
  }
  if (scale === 0 || !Number.isFinite(scale)) return scale
  let sum = 0
  for (let i = from; i < to; i += 1) {
    const s = v[i] / scale
    sum += s * s
  }
  return scale * Math.sqrt(sum)
}

/** Inverse of an upper-triangular p×p matrix (row-major). Diagonal entries must be non-zero. */
export function invertUpperTriangular(r: Float64Array, p: number): Float64Array {
  const inv = new Float64Array(p * p)
  for (let col = 0; col < p; col += 1) {
    // Back substitution for column `col` of R⁻¹ (R·x = e_col).
    for (let row = col; row >= 0; row -= 1) {
      let s = row === col ? 1 : 0
      for (let j = row + 1; j <= col; j += 1) s -= r[row * p + j] * inv[j * p + col]
      inv[row * p + col] = s / r[row * p + row]
    }
  }
  return inv
}

/**
 * Solves M·x = b for a symmetric positive-definite p×p matrix M (row-major; only the lower triangle is read).
 * Returns null when M is not numerically positive definite.
 */
export function choleskySolve(mat: Float64Array, b: ArrayLike<number>, p: number): Float64Array | null {
  const l = new Float64Array(p * p)
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = mat[i * p + j]
      for (let k = 0; k < j; k += 1) s -= l[i * p + k] * l[j * p + k]
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null
        l[i * p + i] = Math.sqrt(s)
      } else {
        l[i * p + j] = s / l[j * p + j]
      }
    }
  }
  const x = new Float64Array(p)
  for (let i = 0; i < p; i += 1) {
    let s = b[i]
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
