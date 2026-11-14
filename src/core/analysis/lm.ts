// Levenberg–Marquardt non-linear least squares for small parameter counts (the mode fits use 3–6 parameters).
// The normal equations are accumulated sample by sample, so memory stays O(p²) however long the series is.

import { choleskySolve } from './linalg'

/**
 * Model value at sample `i` for `params`; when `grad` is given, also writes ∂value/∂params[j] into grad[j].
 */
export type ModelFn = (params: Float64Array, i: number, grad: Float64Array | null) => number

export interface LMOptions {
  /** Default 200 */
  maxIterations?: number
  /** Box bounds; steps are projected onto them (use ±Infinity for an unbounded parameter) */
  lower?: ArrayLike<number>
  upper?: ArrayLike<number>
}

export interface LMResult {
  params: Float64Array
  /** Sum of squared residuals at `params` */
  ssr: number
  iterations: number
  /** false when the iteration cap was hit or the model produced non-finite values */
  converged: boolean
}

const RELATIVE_REDUCTION_TOL = 1e-12
const STEP_TOL = 1e-10
const GRADIENT_TOL = 1e-10

/** Minimises Σ (y[i] − model(params, i))² over i < y.length, starting from `initial`. */
export function levenbergMarquardt(
  model: ModelFn,
  y: Float64Array,
  initial: ArrayLike<number>,
  opts: LMOptions = {},
): LMResult {
  const p = initial.length
  const n = y.length
  const maxIterations = opts.maxIterations ?? 200
  const lower = opts.lower
  const upper = opts.upper

  const project = (v: Float64Array): void => {
    for (let j = 0; j < p; j += 1) {
      if (lower && v[j] < lower[j]) v[j] = lower[j]
      if (upper && v[j] > upper[j]) v[j] = upper[j]
    }
  }

  const sumSquares = (params: Float64Array): number => {
    let s = 0
    for (let i = 0; i < n; i += 1) {
      const r = y[i] - model(params, i, null)
      s += r * r
    }
    return s
  }

  const params = Float64Array.from(initial)
  project(params)
  let ssr = sumSquares(params)
  if (!Number.isFinite(ssr)) return { params, ssr, iterations: 0, converged: false }

  const jtj = new Float64Array(p * p)
  const jtr = new Float64Array(p)
  const grad = new Float64Array(p)
  const damped = new Float64Array(p * p)
  const trial = new Float64Array(p)
  const scale = new Float64Array(p)
  let lambda = 1e-3
  let nu = 2

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (ssr === 0) return { params, ssr, iterations: iteration - 1, converged: true }

    // Gauss–Newton normal equations JᵀJ·δ = Jᵀr (J = ∂model/∂params, r = y − model).
    jtj.fill(0)
    jtr.fill(0)
    for (let i = 0; i < n; i += 1) {
      const r = y[i] - model(params, i, grad)
      for (let a = 0; a < p; a += 1) {
        const ga = grad[a]
        jtr[a] += ga * r
        for (let b = 0; b <= a; b += 1) jtj[a * p + b] += ga * grad[b]
      }
    }
    let finite = true
    for (let a = 0; a < p; a += 1) {
      if (!Number.isFinite(jtr[a])) finite = false
      for (let b = 0; b <= a; b += 1) {
        if (!Number.isFinite(jtj[a * p + b])) finite = false
        jtj[b * p + a] = jtj[a * p + b]
      }
    }
    if (!finite) return { params, ssr, iterations: iteration, converged: false }

    // Marquardt scaling: damp each parameter relative to its own curvature, so units do not matter.
    let maxDiag = 0
    for (let a = 0; a < p; a += 1) maxDiag = Math.max(maxDiag, jtj[a * p + a])
    if (!(maxDiag > 0)) return { params, ssr, iterations: iteration, converged: true }
    let gradientScale = 0
    for (let a = 0; a < p; a += 1) {
      scale[a] = Math.max(jtj[a * p + a], 1e-12 * maxDiag)
      gradientScale = Math.max(gradientScale, Math.abs(jtr[a]) / Math.sqrt(scale[a] * ssr))
    }
    if (gradientScale < GRADIENT_TOL) return { params, ssr, iterations: iteration, converged: true }

    // Inner loop: raise the damping until a step reduces the sum of squares.
    for (;;) {
      damped.set(jtj)
      for (let a = 0; a < p; a += 1) damped[a * p + a] += lambda * scale[a]
      const delta = choleskySolve(damped, jtr, p)
      if (delta) {
        for (let a = 0; a < p; a += 1) trial[a] = params[a] + delta[a]
        project(trial)
        const trialSsr = sumSquares(trial)
        if (Number.isFinite(trialSsr) && trialSsr < ssr) {
          // Gain ratio: actual reduction / reduction predicted by the linear model (Nielsen's damping update).
          let predicted = 0
          for (let a = 0; a < p; a += 1) predicted += delta[a] * (lambda * scale[a] * delta[a] + jtr[a])
          const rho = predicted > 0 ? (ssr - trialSsr) / predicted : 0
          lambda *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3)
          nu = 2
          const relativeReduction = (ssr - trialSsr) / ssr
          let smallStep = true
          for (let a = 0; a < p; a += 1) {
            if (Math.abs(trial[a] - params[a]) > STEP_TOL * (Math.abs(params[a]) + STEP_TOL)) smallStep = false
          }
          params.set(trial)
          ssr = trialSsr
          if (relativeReduction < RELATIVE_REDUCTION_TOL || smallStep) {
            return { params, ssr, iterations: iteration, converged: true }
          }
          break
        }
      }
      lambda *= nu
      nu *= 2
      // No step improves the fit even when heavily damped: we are at a minimum to working precision.
      if (lambda > 1e16) return { params, ssr, iterations: iteration, converged: true }
    }
  }
  return { params, ssr, iterations: maxIterations, converged: false }
}
