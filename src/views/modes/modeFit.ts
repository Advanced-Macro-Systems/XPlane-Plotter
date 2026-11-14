// Running a Dynamic modes fit: the one step that can take seconds (a whole 200k-row file), so it runs in a background
// worker (fit.worker.ts, started by useModeFit.ts). This module imports only the fitting maths, never the channel
// dictionary or React, to keep the worker small; modesModel.ts re-exports it.

import { fitFirstOrder, fitOscillation, type FirstOrderFit, type OscillationFit } from '../../core/analysis/modes'
import type { ModesConfig } from '../../core/types'

export type ModeModel = ModesConfig['model']
export type ModeDetrend = ModesConfig['detrend']

export type ModeFit =
  | {
      model: 'oscillation'
      fit: OscillationFit
      /** The fitted trend (a constant, or a straight line) */
      detrend: ModeDetrend
      /**
       * Share of the variation left after the trend that the oscillation explains: the R² the fit is judged by (its
       * "explains N%" notes). With a constant trend it equals fit.r2.
       */
      r2Oscillation: number
    }
  | { model: 'first-order'; fit: FirstOrderFit }

/** The window to fit: seconds from its first row, and the values (NaN where missing). */
export interface FitSeries {
  t: Float64Array
  y: Float64Array
}

export function runModeFit(series: FitSeries, model: ModeModel, detrend: ModeDetrend): ModeFit {
  if (model === 'oscillation') {
    const fit = fitOscillation(series.t, series.y, { detrend })
    return { model, fit, detrend, r2Oscillation: oscillationR2(series.t, series.y, fit.fitted, detrend) }
  }
  return { model, fit: fitFirstOrder(series.t, series.y) }
}

/**
 * 1 − SSR / SSR(trend alone): how much of what the trend leaves the fitted curve explains (NaN without a usable fit).
 * The trend is the mean, or with 'linear' the least-squares line, over the samples that have a value.
 */
export function oscillationR2(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  fitted: ArrayLike<number>,
  detrend: ModeDetrend,
): number {
  const used = (k: number) => Number.isFinite(y[k]) && Number.isFinite(t[k])
  let n = 0
  let tMean = 0
  let yMean = 0
  for (let k = 0; k < y.length; k += 1) {
    if (!used(k)) continue
    n += 1
    tMean += (t[k] - tMean) / n
    yMean += (y[k] - yMean) / n
  }
  if (n < 3) return Number.NaN
  let stt = 0
  let sty = 0
  for (let k = 0; k < y.length; k += 1) {
    if (!used(k)) continue
    stt += (t[k] - tMean) ** 2
    sty += (t[k] - tMean) * (y[k] - yMean)
  }
  const slope = detrend === 'linear' && stt > 0 ? sty / stt : 0
  let trendSsr = 0
  let ssr = 0
  for (let k = 0; k < y.length; k += 1) {
    if (!used(k)) continue
    if (!Number.isFinite(fitted[k])) return Number.NaN
    trendSsr += (y[k] - yMean - slope * (t[k] - tMean)) ** 2
    ssr += (y[k] - fitted[k]) ** 2
  }
  return trendSsr > 0 ? 1 - ssr / trendSsr : Number.NaN
}

// ------------------------------------------------------------------------------------------------ worker messages

/** Main thread → fit.worker.ts */
export interface ModeFitJob extends FitSeries {
  id: number
  model: ModeModel
  detrend: ModeDetrend
}

/** fit.worker.ts → main thread: the fit, or why it threw */
export type ModeFitReply = { id: number; result: ModeFit } | { id: number; error: string }
