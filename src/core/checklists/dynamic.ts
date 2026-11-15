// Test validity of a dynamic-mode run (short period, phugoid, dutch roll, roll subsidence, spiral): was the mode
// excited and recorded the way the lectures (FD12b, FD13), Cook (ch. 7, 10) and NATO AG-300 Vol. 14 (ch. 15) ask?
// Windows: R = the Dynamic modes window (selection, zoom or test point), I = the input found before it on the mode's
// control axis (or given), T = the trim window before the input, TIR = T.start to R.end. Every check gives the
// measured value, the criterion and its citations; numbers no source gives are flagged as engineering judgement.
// Pure: no React, no DOM; the fit comes in as a FitSummary (the Modes tab fits in a worker).

import type { FirstOrderFit, OscillationFit } from '../analysis/modes'
import type { Channel, Dataset, DynamicModeId, ModesCheckSettings, RowRange } from '../types'
import {
  configuration,
  engineChannels,
  findChannel,
  firstChannel,
  fix,
  fmt,
  grade,
  linearFit,
  maxAbs,
  notCheckable,
  pct,
  pitchControlSource,
  powerSteadiness,
  result,
  rowAtTime,
  rowsFromNotCheckable,
  sampleRate,
  segmentStart,
  signed,
  summary,
  timeBase,
  trend,
  worse,
  atLeast,
  configText,
  LEVER,
  LEVER_ACTUAL,
  type PitchSource,
} from './helpers'
import { MODE_NAMES } from './names'
import type { Check, CheckDef, CheckStatus, Verdict } from './types'

export type ModeId = DynamicModeId

export { MODE_NAMES }

export const MODE_IDS = Object.keys(MODE_NAMES) as ModeId[]

type Short = 'SP' | 'PH' | 'DR' | 'RS' | 'SPI'
const SHORT: Readonly<Record<ModeId, Short>> = {
  'short-period': 'SP',
  phugoid: 'PH',
  'dutch-roll': 'DR',
  'roll-subsidence': 'RS',
  spiral: 'SPI',
}

/** A tolerance: its value, unit, the documents behind it and whether it is engineering judgement. */
export interface Threshold {
  value: number
  unit: string
  source: string
  judgement: boolean
}

const ej = (value: number, unit: string, source = 'EJ'): Threshold => ({ value, unit, source, judgement: true })

/** The dynamic checklist's named tolerances (the run takes overrides by name). */
export const CHECK_THRESHOLDS = {
  trimGapS: ej(0.5, 's'),
  tMinS: ej(5, 's'),
  tMinRollS: ej(2, 's'),
  inputStick: ej(0.02, 'ratio'),
  inputDeg: ej(0.3, 'deg'),
  rateFastHz: { value: 20, unit: 'Hz', source: 'App guide.ts (20–25 /s for dynamic modes)', judgement: true },
  rateMinHz: { value: 10, unit: 'Hz', source: 'NATO 15-3, NATO 15-5', judgement: false },
  leverRange: ej(0.01, 'ratio'),
  n1Dev: ej(1.0, '%'),
  astabOff: ej(1e-4, 'ratio'),
  astabOn: ej(1e-3, 'ratio'),
  configRange: ej(0.001, 'ratio'),
  trimRange: ej(0.002, 'ratio'),
  trimRangeWarn: ej(0.005, 'ratio'),
  speedDriftKt: ej(2, 'kt'),
  vviMeanFpm: ej(200, 'fpm'),
  vviSdFpm: ej(150, 'fpm'),
  rateDegS: ej(1, 'deg/s'),
  thetaSdDeg: ej(0.5, 'deg'),
  bankDeg: ej(3, 'deg'),
  stickMedian: ej(0.03, 'ratio'),
  stickDev: ej(0.02, 'ratio'),
  stillFraction: ej(0.95, ''),
  stillMax: ej(0.05, 'ratio'),
  windowGapS: ej(1, 's'),
  r2: ej(0.9, ''),
  turbulence: ej(0.01, 'ratio'),
  windRangeKt: ej(2, 'kt'),
  verticalWindFpm: ej(50, 'fpm'),
  heightAglFt: ej(5000, 'ft'),
} satisfies Record<string, Threshold>

export type DynamicThresholdName = keyof typeof CHECK_THRESHOLDS

/** What the checklist needs from the Modes fit (built from the app's fit by fitSummary). */
export interface FitSummary {
  model: 'oscillation' | 'first-order'
  ok: boolean
  /** R² the fit is judged by (with a linear trend: the oscillation's share of what the trend leaves) */
  r2: number
  message?: string
  periodS: number
  zeta: number
  zetaLogDec: number
  omegaN: number
  sigma: number
  cycles: number
  peaks: number
  tau: number
  halfLifeS: number
}

/** The checklist's view of a core fit. */
export function fitSummary(
  fit: { model: 'oscillation'; fit: OscillationFit; r2Oscillation?: number } | { model: 'first-order'; fit: FirstOrderFit },
): FitSummary {
  if (fit.model === 'oscillation') {
    const f = fit.fit
    return {
      model: 'oscillation',
      ok: f.ok,
      r2: Number.isFinite(fit.r2Oscillation ?? NaN) ? (fit.r2Oscillation as number) : f.r2,
      message: f.message,
      periodS: f.periodS,
      zeta: f.zeta,
      zetaLogDec: f.zetaLogDec,
      omegaN: f.omegaN,
      sigma: f.sigma,
      cycles: f.cycles,
      peaks: f.peaks.length,
      tau: NaN,
      halfLifeS: f.halfLifeS,
    }
  }
  const f = fit.fit
  return {
    model: 'first-order',
    ok: f.ok,
    r2: f.r2,
    message: f.message,
    periodS: NaN,
    zeta: NaN,
    zetaLogDec: NaN,
    omegaN: NaN,
    sigma: NaN,
    cycles: NaN,
    peaks: 0,
    tau: f.tau,
    halfLifeS: f.halfLifeS,
  }
}

/** Optional settings (ModesConfig.check): declared yaw damper, an input override and the test envelope. */
export type DynamicSettings = Omit<ModesCheckSettings, 'mode'>

export interface DynamicInput {
  ds: Dataset
  mode: ModeId
  /** The Dynamic modes window R */
  rows: RowRange
  fit: FitSummary | null
  settings?: DynamicSettings
  /** Other same-mode test points with accepted fits (repeats); absent = not checked */
  repeats?: { name: string; periodS: number; zeta: number }[]
  thresholds?: Partial<Record<DynamicThresholdName, number>>
}

export interface InputDetection {
  /** Rows [start, end) of the input */
  start: number
  end: number
  /** Elapsed time at the 10 %-of-peak onset and end (interpolated), s */
  startT: number
  endT: number
  duration: number
  /** Signed peak deviation from the baseline */
  peak: number
  shape: 'pulse' | 'step' | 'doublet' | 'cyclic'
  lobes: number
  cycles: number
  /** First lobe's area over the second's (doublets) */
  areaRatio: number
  /** Width above half the peak of a single lobe, s */
  halfWidth: number
  channelId: string
  source: 'stick' | 'surface' | 'deg' | 'response' | 'override'
  variant: 'decay' | 'onset'
  /** Bursts found in the look-back (more than one: "several bursts") */
  bursts: number
  /** Other stick axes that moved in the look-back ("an input on an unexpected axis") */
  otherAxes: string[]
}

export interface TrimWindow {
  start: number
  end: number
  seconds: number
  /** What cut it below its full length: an earlier input, or the log start / a reset or gap */
  cut: 'input' | 'boundary' | null
  /** Cut by an earlier input, T starts where that input's free response had settled (not at the input's end) */
  settled?: boolean
}

export interface DynamicReport {
  mode: ModeId
  checks: Check[]
  verdict: Verdict
  notes: string[]
  input: InputDetection | null
  trim: TrimWindow | null
  /** "bare airframe (yaw damper off)" or "augmented" */
  label: string
  /** Without a control channel: the elapsed time (s) the input was estimated at from the response; else null */
  estimatedInput: number | null
}

// ------------------------------------------------------------------ definitions (the registry entries)

const def = (d: CheckDef): CheckDef => d

export const DYNAMIC_DEFS: readonly CheckDef[] = [
  def({
    id: 'time-base', title: 'Continuous sim-time record', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'The flight model integrates in sim time; real time keeps running through pauses; a reset or gap inside a run breaks the fit.',
    cite: ['App src/core/time.ts', 'App src/views/modes/modesModel.ts'], judgement: false, needs: 'row {1}',
  }),
  def({
    id: 'sample-rate', title: 'Sample rate fits the mode', severity: 'critical', scope: 'run', interval: 'TIR + fit',
    why: 'At least 10 samples/s are required for dynamic manoeuvres such as Dutch rolls, and more if derivatives are identified by computer; the app’s recording guide asks 20–25/s. Per-period counts are engineering judgement.',
    cite: ['NATO 15-3', 'NATO 15-5', 'App src/core/channels/guide.ts'], judgement: true, needs: 'row {1}',
  }),
  def({
    id: 'autopilot-off', title: 'Autopilot off', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'An autopilot loop raises damping artificially and attitude hold suppresses the phugoid; stability tests are open-loop; autopilot status is part of every test point. The servo can keep a value after disconnect, so the evidence is whether each surface follows the stick or the servo. Tolerances are engineering judgement.',
    cite: ['FD13 p.13', 'MIL p.48', 'NATO 15-4', 'NATO 29-1', 'NATO 29-2', 'App dictionary.ts line 204'], judgement: true,
    needs: 'rows {8} and {11}; add {138} and {10} to tell pilot from autopilot',
  }),
  def({
    id: 'throttle-fixed', title: 'Autothrottle off, power fixed', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'Engine power must not be changed from the trim setting during the block; power changes during a phugoid add power damping. Tolerances are engineering judgement.',
    cite: ['NATO 15-6', 'Cook p.177', 'FD12b p.32', 'FD12b p.33'], judgement: true, needs: 'row {25}; add {26} and {41}',
  }),
  def({
    id: 'yaw-damper-off', title: 'Yaw damper off', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'The yaw damper is the Dutch roll’s fix, so it changes the mode being measured; record SAS status. MIL-F-8785C evaluates the aircraft with its augmentation, so a yaw-damper-off result is a failure-state (bare-airframe) result. Thresholds are engineering judgement.',
    cite: ['FD13 p.25', 'NATO 15-3', 'NATO 29-1', 'MIL p.16', 'Cook p.271'], judgement: true, needs: 'row {10}',
  }),
  def({
    id: 'other-augmentation', title: 'Roll and pitch augmentation off', severity: 'advisory', scope: 'run', interval: 'TIR',
    why: 'Record SAS status; any roll or pitch augmentation also changes the measured modes.',
    cite: ['NATO 29-1', 'MIL p.16'], judgement: true, needs: 'row {10}',
  }),
  def({
    id: 'configuration-constant', title: 'Configuration unchanged', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'Record flaps and gear to establish the configuration; one block at one condition; the handling-qualities category follows the flight phase. No source gives a number for “unchanged”: the 0.001 range tolerance is engineering judgement.',
    cite: ['NATO 15-5', 'NATO 8-4', 'NATO 15-6', 'Cook p.272', 'MIL p.17'], judgement: true,
    needs: 'row {13}; gear needs row {14}',
  }),
  def({
    id: 'trim-fixed', title: 'Trim not touched', severity: 'critical', scope: 'run', interval: 'I+R',
    why: 'No further control inputs after the disturbance; a large aircraft has only the controls-fixed response, and trim moving the stabiliser is a control input. Tolerances are engineering judgement.',
    cite: ['NATO 15-6', 'Cook p.177', 'Cook p.178'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'trimmed-start', title: 'Trimmed and steady before the input', severity: 'critical', scope: 'run', interval: 'T',
    why: 'Every procedure starts from trimmed flight; stabilised data before a manoeuvre is a tare; the spiral starts from wings-level, zero-yaw-rate trim. For roll subsidence a steady turn first is usual, to keep the excursion in bank small, not required. With power fixed, speed is held by a small climb or descent, so a modest VVI is tolerated. Numbers are engineering judgement, close to the app’s steady-point defaults.',
    cite: ['FD12b p.30', 'FD12b p.32', 'FD12b p.37', 'FD12b p.38', 'FD12b p.39', 'Cook p.175-177', 'Cook p.211-212', 'NATO 15-6', 'NATO 11-11', 'MIL p.99', 'App src/core/analysis/steady.ts'],
    judgement: true, needs: 'rows {3}, {4}, {16} and {17}',
  }),
  def({
    id: 'hands-off-trim', title: 'Trimmed with trim, not held', severity: 'advisory', scope: 'run', interval: 'T',
    why: 'A released spring-centred stick returns to centre, which is the trim position only if the aircraft was trimmed to hold the condition with the stick centred. Engineering judgement.',
    cite: ['FD12b p.31', 'Cook p.177', 'NATO 15-6'], judgement: true, needs: 'row {8}',
  }),
  def({
    id: 'input-detected', title: 'Input found', severity: 'critical', scope: 'run', interval: 'look-back before R',
    why: 'Each mode test is defined by an input applied from trim.',
    cite: ['FD12b p.30-39', 'Cook p.176-177', 'Cook p.211-213', 'NATO 15-5', 'NATO 15-6'], judgement: true,
    needs: 'row {8}; fallback row {11}',
  }),
  def({
    id: 'input-shape', title: 'Input shape and duration suit the mode', severity: 'advisory', scope: 'run', interval: 'I',
    why: 'Short period: an elevator pulse of a second or less, or a doublet at the short-period frequency. Phugoid: elevator held until the speed has changed about 5 %. Dutch roll: a rudder doublet matched to the mode, or cyclic pedalling then release. Roll: a lateral step with no pedal. Spiral: a small step to about 20° of bank, then controls to datum. Bands beyond the sources are engineering judgement.',
    cite: ['FD12b p.30', 'Cook p.176', 'NATO 15-6', 'FD12b p.32', 'Cook p.177', 'FD12b p.39', 'Cook p.213', 'NATO 12-10', 'NATO 15-5', 'Cook p.211', 'FD12b p.36', 'FD12b p.38', 'Cook p.212'],
    judgement: true, needs: 'row {8}',
  }),
  def({
    id: 'input-size', title: 'Response in the linear range and above noise', severity: 'advisory', scope: 'run', interval: 'I+R vs T',
    why: 'Inputs must be large relative to noise yet small enough to stay linear; the analysis assumes small perturbations; about 5 % speed change for the phugoid; spiral disturbance 5–20°; roll from about 30° of bank, the usual steady turn (a start from wings level is allowed). Other bands are engineering judgement for a transport aircraft.',
    cite: ['NATO 15-13', 'Cook p.177', 'FD12b p.32', 'FD12b p.37', 'MIL p.99', 'NATO 15-7', 'Cook p.211', 'MIL p.51', 'MIL p.96'], judgement: true,
    needs: 'rows {18}, {4}, {3} and {17}',
  }),
  def({
    id: 'controls-fixed', title: 'Hands and feet off during the response', severity: 'critical', scope: 'run', interval: 'R',
    why: 'The aircraft responds without further control inputs; tests are open-loop; the remaining controls stay at trim; the spiral is left to its own devices with controls free; a large aircraft is controls-fixed. Tolerances are engineering judgement.',
    cite: ['NATO 15-6', 'NATO 15-4', 'FD12b p.31', 'FD12b p.38', 'FD12b p.39', 'Cook p.177', 'Cook p.178', 'Cook p.212', 'MIL p.99'], judgement: true,
    needs: 'row {8}',
  }),
  def({
    id: 'window-start', title: 'Window starts at the free response', severity: 'advisory', scope: 'run', interval: 'I.end to R.start',
    why: 'The free transient is the response after the input has ceased; the time section analysed starts there.',
    cite: ['FD12b p.34', 'FD12b p.39', 'Cook p.213'], judgement: true, needs: 'Needs input-detected',
  }),
  def({
    id: 'record-length', title: 'Long enough to measure damping', severity: 'advisory', scope: 'run', interval: 'R',
    why: 'Damping needs several cycles: the textbook phugoid record covers about 1.6 cycles and the lecture’s X-Plane example 4 periods; the app rejects fits under about 0.9 cycle. Counts are engineering judgement.',
    cite: ['Cook p.178', 'FD12b p.34', 'Cook p.214', 'NATO 15-7', 'App src/core/analysis/modes.ts'], judgement: true, needs: 'Needs a fit',
  }),
  def({
    id: 'fit-quality', title: 'Fit accepted and consistent', severity: 'critical', scope: 'run', interval: 'R',
    why: 'The report gives damping and frequency from the time section used, for example by logarithmic decrement; a fit the app rejects cannot support a number. Agreement bands are engineering judgement.',
    cite: ['FD12b p.34', 'FD13 p.33', 'App src/core/analysis/modes.ts'], judgement: true, needs: 'Needs a fit',
  }),
  def({
    id: 'mode-purity', title: 'Response looks like the intended mode', severity: 'advisory', scope: 'run', interval: 'R',
    why: 'Short period: α and q with virtually no change in speed, typically 1–4 s. Phugoid: speed-height exchange at nearly constant α, periods typically 15–100 s; Lanchester gives the order of the period. Dutch roll couples yaw, roll and sideslip; roll subsidence is almost pure rolling; the spiral is a slow real root. Bands are engineering judgement.',
    cite: ['FD13 p.9', 'Cook p.255', 'FD13 p.11-13', 'NATO 15-5', 'Cook p.160', 'FD13 p.21-25', 'MIL p.96'], judgement: true,
    needs: 'Needs rows {3}, {18} and {16}',
  }),
  def({
    id: 'weather', title: 'Calm air', severity: 'advisory', scope: 'run', interval: 'TIR',
    why: 'State the weather requirements for each block; weather affects the quality of a test; turbulence is an external disturbance the analysis does not model. Tolerances are engineering judgement.',
    cite: ['NATO 8-3', 'NATO 15-4', 'FD12 p.7'], judgement: true, needs: 'row {152}',
  }),
  def({
    id: 'envelope', title: 'Inside the test envelope', severity: 'advisory', scope: 'run', interval: 'TIR',
    why: 'The test plan states the test envelope and the source of its limits. Default limits are engineering judgement.',
    cite: ['NATO 8-3', 'Cook p.271-272'], judgement: true, needs: 'Needs rows {3}, {4}, {18} and {20}',
  }),
  def({
    id: 'weight-cg', title: 'Weight and CG', severity: 'info', scope: 'run', interval: 'I.start and R',
    why: 'Weight and CG belong to each test point and are stated as assumptions.',
    cite: ['NATO 8-3', 'NATO 29-1', 'B p.4'], judgement: false, needs: 'row {63}',
  }),
  def({
    id: 'repeats', title: 'Repeat consistency', severity: 'info', scope: 'run', interval: 'workspace',
    why: 'Multiple attempts are normal, and consistent repeats support the result. Bands are engineering judgement.',
    cite: ['FD12b p.19', 'Cook p.175'], judgement: true, needs: 'Needs two or more test points of the mode with accepted fits',
  }),
  def({
    id: 'hq-level', title: 'Handling-qualities level (MIL-F-8785C)', severity: 'info', scope: 'run', interval: 'fit',
    why: 'Places the accepted result against Class III, Category B (C if flaps or gear are down); augmentation counts as part of the aircraft, so yaw-damper-off levels describe a failure state.',
    cite: ['MIL p.51', 'MIL p.53', 'MIL p.47', 'Cook p.278', 'MIL p.96', 'Cook p.282', 'MIL p.99', 'Cook p.270-272', 'MIL p.16-17', 'Cook p.271'], judgement: false,
    needs: 'Needs an accepted fit',
  }),
]

const DEF = new Map(DYNAMIC_DEFS.map((d) => [d.id, d]))
const d = (id: string): CheckDef => DEF.get(id) as CheckDef

// ------------------------------------------------------------------ mode constants

const LTRIM: Readonly<Record<Short, number>> = { SP: 10, PH: 15, DR: 10, RS: 3, SPI: 15 }
const LOOKBACK: Readonly<Record<Short, number>> = { SP: 15, PH: 90, DR: 30, RS: 20, SPI: 60 }

/** Input channels per mode, best first: the stick, then the row-11 surface, then the surface in degrees. */
const INPUT_AXES: Readonly<Record<Short, readonly Axis[]>> = {
  SP: ['elev'],
  PH: ['elev'],
  DR: ['ruddr', 'ailrn'],
  RS: ['ailrn'],
  SPI: ['ruddr', 'ailrn'],
}
type Axis = 'elev' | 'ailrn' | 'ruddr'
const STICK: Readonly<Record<Axis, string>> = { elev: '_elev,stick', ailrn: 'ailrn,stick', ruddr: 'ruddr,stick' }
const SURF: Readonly<Record<Axis, string>> = { elev: '_elev,_surf', ailrn: 'ailrn,_surf', ruddr: 'ruddr,_surf' }
const DEG: Readonly<Record<Axis, string>> = { elev: 'elev1,__deg', ailrn: 'Lailn,1,deg', ruddr: 'rudr1,__deg' }
const AXIS_NAME: Readonly<Record<Axis, string>> = { elev: 'elevator', ailrn: 'aileron', ruddr: 'rudder' }

// ------------------------------------------------------------------ input detection (B2)

interface Burst {
  a: number
  b: number
  peak: number
}

function median(values: number[]): number {
  if (!values.length) return NaN
  const s = [...values].sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Baseline (median), noise (1.4826 × MAD) and threshold of a channel over rows [lo, hi). */
function level(values: ArrayLike<number>, lo: number, hi: number, floor: number): { base: number; noise: number; h: number } {
  const xs: number[] = []
  for (let i = lo; i < hi; i += 1) if (Number.isFinite(values[i])) xs.push(values[i])
  const base = median(xs)
  const noise = 1.4826 * median(xs.map((x) => Math.abs(x - base)))
  return { base, noise, h: Math.max(floor, 5 * (Number.isFinite(noise) ? noise : 0)) }
}

/** Bursts of samples more than h from the baseline over [lo, hi), merged when less than `mergeS` apart. */
function bursts(ds: Dataset, values: ArrayLike<number>, lo: number, hi: number, base: number, h: number, mergeS: number): Burst[] {
  const out: Burst[] = []
  let i = lo
  while (i < hi) {
    if (!(Math.abs(values[i] - base) > h)) {
      i += 1
      continue
    }
    const a = i
    let peak = values[i] - base
    while (i < hi && Math.abs(values[i] - base) > h) {
      if (Math.abs(values[i] - base) > Math.abs(peak)) peak = values[i] - base
      i += 1
    }
    const last = out[out.length - 1]
    if (last && ds.elapsed[a] - ds.elapsed[last.b - 1] < mergeS) {
      last.b = i
      if (Math.abs(peak) > Math.abs(last.peak)) last.peak = peak
    } else {
      out.push({ a, b: i, peak })
    }
  }
  return out
}

/** Onset and end of a burst at 10 % of its peak, interpolated in time; rows widened to that level. */
function refine(ds: Dataset, values: ArrayLike<number>, burst: Burst, base: number, lo: number, hi: number) {
  const limit = 0.1 * Math.abs(burst.peak)
  const dev = (i: number) => Math.abs(values[i] - base)
  let a = burst.a
  while (a > lo && dev(a - 1) > limit) a -= 1
  let b = burst.b
  while (b < hi && dev(b) > limit) b += 1
  const at = (i: number, j: number) => {
    const di = dev(i)
    const dj = dev(j)
    if (!Number.isFinite(di) || !Number.isFinite(dj) || di === dj) return ds.elapsed[j]
    const f = (limit - di) / (dj - di)
    return ds.elapsed[i] + Math.min(1, Math.max(0, f)) * (ds.elapsed[j] - ds.elapsed[i])
  }
  const startT = a > lo ? at(a - 1, a) : ds.elapsed[a]
  const endT = b < hi ? at(b, b - 1) : ds.elapsed[b - 1]
  return { a, b, startT, endT }
}

/** Lobes above 25 % of the peak (consecutive same-sign runs merged), their areas and the half-amplitude width. */
function lobes(ds: Dataset, values: ArrayLike<number>, a: number, b: number, base: number, peak: number) {
  const limit = 0.25 * Math.abs(peak)
  const found: { sign: number; area: number }[] = []
  let halfWidth = 0
  for (let i = a; i < b; i += 1) {
    const v = values[i] - base
    const dt = i + 1 < b ? ds.elapsed[i + 1] - ds.elapsed[i] : 0
    if (Math.abs(v) >= 0.5 * Math.abs(peak)) halfWidth += dt
    if (!(Math.abs(v) > limit)) continue
    const sign = Math.sign(v)
    const last = found[found.length - 1]
    if (last && last.sign === sign) last.area += Math.abs(v) * dt
    else found.push({ sign, area: Math.abs(v) * dt })
  }
  return { found, halfWidth }
}

interface InputSearch {
  detection: InputDetection | null
  /** Bursts before I on the same channel (for T's truncation) */
  earlierEnd: number | null
  /** No control channel at all: I.start was estimated from the response */
  estimated: boolean
  /** The channel searched (null: no control channel) */
  channel: Channel | null
  axis: Axis | null
}

function detectInput(ds: Dataset, mode: ModeId, rows: RowRange, settings: DynamicSettings | undefined, t: Thresholds): InputSearch {
  const short = SHORT[mode]
  const [r0, r1] = rows
  const segLo = segmentStart(ds, r0)
  const lo = rowAtTime(ds, ds.elapsed[r0] - LOOKBACK[short], segLo, r0)
  const mergeS = short === 'PH' ? 3 : 1
  // Candidates: each axis's stick, then its surface, then its degrees column.
  const candidates: { ch: Channel; axis: Axis; source: InputDetection['source']; floor: number }[] = []
  for (const axis of INPUT_AXES[short]) {
    const stick = findChannel(ds, STICK[axis])
    if (stick) candidates.push({ ch: stick, axis, source: 'stick', floor: t.inputStick })
  }
  if (!candidates.length) {
    for (const axis of INPUT_AXES[short]) {
      const surf = findChannel(ds, SURF[axis])
      if (surf) candidates.push({ ch: surf, axis, source: 'surface', floor: t.inputStick })
      else {
        const deg = findChannel(ds, DEG[axis])
        if (deg) candidates.push({ ch: deg, axis, source: 'deg', floor: t.inputDeg })
      }
    }
  }
  if (!candidates.length) return { detection: null, earlierEnd: null, estimated: true, channel: null, axis: null }

  for (const cand of candidates) {
    const { ch, axis, source, floor } = cand
    const { base, h } = level(ch.values, lo, r1, floor)
    if (!Number.isFinite(base)) continue
    const found = bursts(ds, ch.values, lo, r1, base, h, mergeS)
    let chosen: Burst | null = null
    let variant: InputDetection['variant'] = 'decay'
    let earlierEnd: number | null = null
    if (settings?.input) {
      const [ia, ib] = settings.input
      const s = summary(ch.values, ia, ib)
      chosen = { a: ia, b: ib, peak: Math.abs(s.max - base) >= Math.abs(s.min - base) ? s.max - base : s.min - base }
      variant = ia <= r0 && r0 < ib ? 'onset' : 'decay'
    } else {
      const active = found.find((bu) => bu.a <= r0 && r0 < bu.b)
      if (active) {
        chosen = active
        variant = 'onset'
      } else {
        const before = found.filter((bu) => ds.elapsed[bu.b - 1] <= ds.elapsed[r0] + 0.5)
        chosen = before[before.length - 1] ?? null
      }
    }
    if (!chosen) {
      if (cand === candidates[candidates.length - 1]) {
        return { detection: null, earlierEnd: null, estimated: false, channel: candidates[0].ch, axis: candidates[0].axis }
      }
      continue
    }
    const index = found.indexOf(chosen)
    if (index > 0) earlierEnd = found[index - 1].b
    const refined = settings?.input
      ? { a: chosen.a, b: chosen.b, startT: ds.elapsed[chosen.a], endT: ds.elapsed[chosen.b - 1] }
      : refine(ds, ch.values, chosen, base, lo, r1)
    const shapeData = lobes(ds, ch.values, refined.a, refined.b, base, chosen.peak)
    const n = shapeData.found.length
    const duration = refined.endT - refined.startT
    const shape: InputDetection['shape'] = n >= 3 ? 'cyclic' : n === 2 ? 'doublet' : duration <= 3 ? 'pulse' : 'step'
    const areaRatio = n >= 2 && shapeData.found[1].area > 0 ? shapeData.found[0].area / shapeData.found[1].area : NaN
    // Other stick axes that moved in the look-back.
    const otherAxes: string[] = []
    for (const other of ['elev', 'ailrn', 'ruddr'] as Axis[]) {
      if (other === axis || INPUT_AXES[short].includes(other)) continue
      const stick = findChannel(ds, STICK[other])
      if (!stick) continue
      const lv = level(stick.values, lo, r1, t.inputStick)
      if (bursts(ds, stick.values, refined.a, Math.min(r1, refined.b), lv.base, Math.max(lv.h, 0.05), mergeS).length) {
        otherAxes.push(AXIS_NAME[other])
      }
    }
    return {
      detection: {
        start: refined.a,
        end: refined.b,
        startT: refined.startT,
        endT: refined.endT,
        duration,
        peak: chosen.peak,
        shape,
        lobes: n,
        cycles: n / 2,
        areaRatio,
        halfWidth: shapeData.halfWidth,
        channelId: ch.id,
        source: settings?.input ? 'override' : source,
        variant,
        bursts: found.filter((bu) => ds.elapsed[bu.b - 1] <= ds.elapsed[r0] + 0.5 || bu === chosen).length,
        otherAxes,
      },
      earlierEnd,
      estimated: false,
      channel: ch,
      axis,
    }
  }
  return { detection: null, earlierEnd: null, estimated: false, channel: candidates[0].ch, axis: candidates[0].axis }
}

/**
 * The rate of change of `values` over rows [lo, hi) (central differences, one-sided at the ends), indexed from 0 =
 * row lo: dθ/dt or dφ/dt when the rates themselves are not logged.
 */
function derivative(values: ArrayLike<number>, time: ArrayLike<number>, lo: number, hi: number): Float64Array {
  const out = new Float64Array(Math.max(0, hi - lo))
  for (let i = lo; i < hi; i += 1) {
    const a = Math.max(lo, i - 1)
    const b = Math.min(hi - 1, i + 1)
    const dt = time[b] - time[a]
    out[i - lo] = b > a && dt > 0 ? (values[b] - values[a]) / dt : NaN
  }
  return out
}

/**
 * Without a control channel: the last time before R at which the mode's response left its earlier level by 5σ (B2):
 * q, else dθ/dt, for the short period and phugoid; β, else R, for the dutch roll; P, else dφ/dt, for roll subsidence
 * and the spiral. A rate, not an attitude: an attitude wanders by degrees in "trimmed" flight, so its 5σ band can hold
 * the whole response.
 */
function estimateFromResponse(ds: Dataset, mode: ModeId, rows: RowRange): number | null {
  const short = SHORT[mode]
  const [r0] = rows
  const lo = rowAtTime(ds, ds.elapsed[r0] - LOOKBACK[short], segmentStart(ds, r0), r0)
  const third = lo + Math.max(3, Math.floor((r0 - lo) / 3))
  if (third >= r0) return null
  const [rate, attitude] =
    short === 'SP' || short === 'PH'
      ? ['____Q,deg/s', 'pitch,__deg']
      : short === 'DR'
        ? ['_beta,__deg', '____R,deg/s']
        : ['____P,deg/s', '_roll,__deg']
  let series: ArrayLike<number>
  const direct = findChannel(ds, rate)
  if (direct) series = direct.values.subarray(lo, r0)
  else {
    const other = findChannel(ds, attitude)
    if (!other) return null
    // The dutch roll's fallback is itself a rate (R); the others' are attitudes, differentiated.
    series = short === 'DR' ? other.values.subarray(lo, r0) : derivative(other.values, ds.elapsed, lo, r0)
  }
  const { base, noise } = level(series, 0, third - lo, 0)
  const limit = 5 * Math.max(noise, 1e-6)
  const value = (i: number) => series[i - lo]
  // Walking back from R: the response left its level where the last quiet stretch (2 s inside the band) ends.
  let quietFrom = -1
  for (let i = r0 - 1; i >= lo; i -= 1) {
    if (Math.abs(value(i) - base) <= limit) {
      if (quietFrom < 0) quietFrom = i
      if (ds.elapsed[quietFrom] - ds.elapsed[i] >= 2) return quietFrom + 1 < r0 ? quietFrom + 1 : null
    } else quietFrom = -1
  }
  for (let i = third; i < r0; i += 1) if (Math.abs(value(i) - base) > limit) return i
  return null
}

/** The angular rates trimmed-start judges: P, Q and R (roll subsidence starts in a turn: P only). */
function rateChannels(ds: Dataset, short: Short): Channel[] {
  const tokens = short === 'RS' ? ['____P,deg/s'] : ['____P,deg/s', '____Q,deg/s', '____R,deg/s']
  return tokens.map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
}

/**
 * The first row of [a, b) from which every rate stays within ±limit to b: just after the last sample beyond it (a when
 * none is; b when the rates never settle). Without rate channels, a.
 */
function settledFrom(a: number, b: number, rates: readonly Channel[], limit: number): number {
  if (!rates.length) return a
  for (let i = b - 1; i >= a; i -= 1) {
    if (rates.some((c) => Math.abs(c.values[i]) > limit)) return i + 1
  }
  return a
}

// ------------------------------------------------------------------ the checks

type Thresholds = Record<DynamicThresholdName, number>

function thresholds(overrides: DynamicInput['thresholds']): Thresholds {
  const out = {} as Thresholds
  for (const key of Object.keys(CHECK_THRESHOLDS) as DynamicThresholdName[]) {
    const v = overrides?.[key]
    out[key] = typeof v === 'number' && Number.isFinite(v) ? v : CHECK_THRESHOLDS[key].value
  }
  return out
}

const KIND = 'dynamic' as const

/** Runs the dynamic checklist on one window. */
export function runDynamicChecks(input: DynamicInput): DynamicReport {
  const { ds, mode, fit } = input
  const settings = input.settings ?? {}
  const t = thresholds(input.thresholds)
  const short = SHORT[mode]
  const rows: RowRange = [Math.max(0, input.rows[0]), Math.min(ds.rowCount, input.rows[1])]
  const [r0, r1] = rows
  const time = ds.elapsed
  const checks: Check[] = []
  const notes: string[] = []

  // ---- input and trim windows
  const search = detectInput(ds, mode, rows, settings, t)
  const det = search.detection
  let estimatedStart: number | null = null
  if (search.estimated) estimatedStart = estimateFromResponse(ds, mode, rows)
  /** No control channel: I.start comes from the response, so T (and TIR) are only as good as that estimate. */
  const estimated = estimatedStart !== null
  const iStart = det ? det.start : estimatedStart
  const iStartT = det ? det.startT : estimatedStart !== null ? time[estimatedStart] : null
  let trimWin: TrimWindow | null = null
  if (iStartT !== null && iStart !== null) {
    const segLo = segmentStart(ds, iStart)
    const wantStart = iStartT - LTRIM[short] - t.trimGapS
    const endRow = rowAtTime(ds, iStartT - t.trimGapS, segLo, iStart + 1)
    let startRow = rowAtTime(ds, wantStart, segLo, endRow)
    let cut: TrimWindow['cut'] = null
    let settled = false
    if (search.earlierEnd !== null && search.earlierEnd > startRow) {
      startRow = Math.min(endRow, search.earlierEnd)
      cut = 'input'
      // The earlier input's own free response follows it: T starts once the angular rates have settled for good
      // (within twice the trimmed-start limit, beyond which that check fails, to T's end), not at the end of that
      // input; what is left of the transient is then graded like any other unsteadiness in T.
      const from = settledFrom(startRow, endRow, rateChannels(ds, short), 2 * t.rateDegS)
      settled = from > startRow
      startRow = from
    } else if (time[startRow] - wantStart > 0.5 && startRow === segLo) {
      cut = 'boundary'
    }
    const seconds = endRow > startRow ? time[endRow - 1] - time[startRow] : 0
    trimWin = { start: startRow, end: endRow, seconds, cut: seconds >= LTRIM[short] - 0.25 ? null : cut, ...(settled ? { settled: true } : {}) }
  }
  const tir: [number, number] = [trimWin ? trimWin.start : iStart ?? r0, r1]
  const ir: [number, number] = [iStart ?? r0, r1]
  /**
   * A critical check over TIR (or I+R) with an estimated input: a failure inside R itself stands; one only in the part
   * before R, placed by the estimate, is capped at warn and says so.
   */
  const guarded = (make: (a: number, b: number) => Check, a: number): Check => {
    const c = make(a, r1)
    if (!estimated || c.status !== 'fail' || a >= r0) return c
    const inR = make(r0, r1)
    if (inR.status === 'fail') return inR
    return {
      ...c,
      status: 'warn',
      measured: `${c.measured} (before the window, placed by the input estimated from the response)`,
      hint: 'No control channel is logged, so the input (and the trim window before it) was estimated from the response: log row 8 (Joystick) to place it.',
    }
  }

  // ---- time-base
  checks.push(
    guarded((a, b) => {
      const tb = timeBase(ds, a, b)
      if (tb.kind === 'none') return notCheckable(d('time-base'), KIND)
      const status: CheckStatus = tb.crosses ? 'fail' : tb.kind === 'sim' ? 'pass' : 'warn'
      return result(
        d('time-base'), KIND, status,
        `time from ${tb.source}${tb.crosses ? '; a reset or gap lies inside the run' : ''}`,
        'pass: sim time (_totl,_time or missn,_time) and no reset or gap; warn: real or another clock; fail: a reset or gap inside',
        status === 'fail' ? 'Choose a run inside one continuous stretch of sim time.' : status === 'warn' ? 'Log row 1 (Times) so sim time is the time axis.' : '',
      )
    }, tir[0]),
  )

  // ---- sample-rate
  {
    const sr = sampleRate(ds, tir[0], tir[1])
    const rate = Number.isFinite(ds.sampleRateHz) ? ds.sampleRateHz : sr.rate
    const fast = short === 'SP' || short === 'DR' || short === 'RS'
    let status: CheckStatus
    let measured = `${fmt(rate, 3)} Hz`
    if (fast) {
      status = atLeast(rate, t.rateFastHz) ? 'pass' : atLeast(rate, t.rateMinHz) ? 'warn' : 'fail'
      if (fit?.ok && fit.model === 'oscillation' && Number.isFinite(fit.periodS)) {
        const perPeriod = fit.periodS * rate
        measured += `, ${fmt(perPeriod, 3)} samples per period`
        status = worse(status, atLeast(perPeriod, 20) ? 'pass' : atLeast(perPeriod, 10) ? 'warn' : 'fail')
      } else if (fit?.model === 'first-order' && Number.isFinite(fit.tau)) {
        const perPeriod = Math.abs(fit.tau) * rate
        measured += `, ${fmt(perPeriod, 3)} samples per time constant`
        status = worse(status, atLeast(perPeriod, 10) ? 'pass' : atLeast(perPeriod, 5) ? 'warn' : 'fail')
      }
      if (fit?.message?.includes('faster than the sample interval')) status = 'fail'
    } else {
      status = atLeast(rate, t.rateMinHz) ? 'pass' : atLeast(rate, 2) ? 'warn' : 'fail'
    }
    if (sr.dropouts > 0) {
      measured += `, ${sr.dropouts} dropout${sr.dropouts === 1 ? '' : 's'}`
      status = worse(status, 'warn')
    }
    checks.push(
      result(
        d('sample-rate'), KIND, status, measured,
        fast
          ? 'pass ≥ 20 Hz and ≥ 20 samples per period (roll: ≥ 10 per τ); warn 10–20; fail < 10 Hz; no dropouts'
          : 'pass ≥ 10 Hz; warn 2–10 Hz; fail < 2 Hz; no dropouts',
        status === 'pass' ? '' : 'Raise the Disk Rate (Data Output → Output rates) to 20–25 per second for dynamic modes.',
      ),
    )
  }

  // ---- autopilot-off (the shared rule, judged on this run's own spans: the surface follows a moving servo while the
  // stick is still). Without the ±30 s widening the static and performance checklists use: over the trim window T and
  // the response R, whole and every 2 s of them, the stick is still even on the axis the input was given on, so an
  // autopilot that took over after the input is found there; over TIR a surface that follows the stick is the pilot.
  {
    const fdir = findChannel(ds, '_fdir,_mode')
    // No input found on the stick: the stretch searched before R (where the surfaces may have been moved without it).
    const lookback: [number, number] | null = det || estimated ? null : [rowAtTime(ds, time[r0] - LOOKBACK[short], segmentStart(ds, r0), r0), r0]
    const make = (a: number, b: number): Check => {
      const fdirOn = fdir ? summary(fdir.values, a, b).max >= 2 : false
      const spans = autopilotSpans(ds, a < r0 ? trimWin : null, rows, [a, b], lookback)
      const verdicts: { axis: Axis; text: string; source: PitchSource | 'no servo row' }[] = []
      let anyRow = false
      for (const axis of AXES) {
        const surf = findChannel(ds, SURF[axis])
        const stick = findChannel(ds, STICK[axis])
        if (!surf || !stick) continue
        anyRow = true
        if (!findChannel(ds, `${axis === 'elev' ? '_elev' : axis},servo`)) {
          verdicts.push({ axis, text: 'no servo row', source: 'no servo row' })
          continue
        }
        verdicts.push({ axis, ...axisSource(ds, axis, spans, [a, b]) })
      }
      if (!anyRow && !fdir) return notCheckable(d('autopilot-off'), KIND)
      const ap = verdicts.some((v) => v.source === 'autopilot')
      const pilot = verdicts.some((v) => v.source === 'pilot')
      const status: CheckStatus = fdirOn || ap ? 'fail' : pilot ? 'pass' : 'warn'
      const measured = [
        ...verdicts.map((v) => `${AXIS_NAME[v.axis]}: ${v.text}`),
        ...(fdir ? [`_fdir,_mode ${fdirOn ? '= 2 (autopilot)' : '< 2'}`] : []),
      ].join('; ')
      return result(
        d('autopilot-off'), KIND, status, measured,
        'pass: a surface follows the stick (R² ≥ 0.9) and none follows a moving servo; fail: a surface follows a moving servo while the stick is still (over T, R or any 2 s of them), or _fdir,_mode = 2; warn: inconclusive',
        status === 'fail'
          ? 'Disconnect the autopilot before the input and fly the run again.'
          : status === 'warn'
            ? 'Inconclusive: log rows 8, 11 and 138 (servos), or fly a calibration (autopilot on, then off).'
            : '',
      )
    }
    checks.push(guarded(make, tir[0]))
  }

  // ---- throttle-fixed
  {
    const levers = engineChannels(ds, LEVER)
    const actual = engineChannels(ds, LEVER_ACTUAL)
    const n1 = engineChannels(ds, (k) => `N1__${k},_pcnt`)
    if (!levers.length && !actual.length && !n1.length) checks.push(notCheckable(d('throttle-fixed'), KIND))
    else {
      const make = (a: number, b: number): Check => {
        // N1 is measured from its mean over T (over the rows themselves when T is not part of them).
        const ps = powerSteadiness(ds, a, b, a < r0 && trimWin ? [trimWin.start, trimWin.end] : undefined)
        const lever = Math.max(Number.isFinite(ps.leverRange) ? ps.leverRange : 0, Number.isFinite(ps.actualRange) ? ps.actualRange : 0)
        const status = worse(
          levers.length || actual.length ? grade(lever, t.leverRange, 2 * t.leverRange) : null,
          n1.length ? grade(ps.n1Deviation, t.n1Dev, 2 * t.n1Dev) : null,
        )
        return result(
          d('throttle-fixed'), KIND, status,
          [levers.length || actual.length ? `lever range ${fmt(lever, 2)}` : '', n1.length ? `N1 within ${fix(ps.n1Deviation, 2)} %pt of trim` : '']
            .filter(Boolean)
            .join('; '),
          'pass: lever ranges ≤ 0.01 and N1 within 1 % of trim; warn ≤ 0.02 or 2 %; fail beyond',
          status === 'pass' ? '' : 'Keep the throttles at the trim setting through the input and response (autothrottle off).',
        )
      }
      checks.push(guarded(make, tir[0]))
    }
  }

  // ---- yaw-damper-off
  {
    const astab = findChannel(ds, 'ruddr,astab')
    const lateral = short === 'DR' || short === 'SPI' || short === 'RS'
    const severity = lateral ? 'critical' : 'info'
    if (!astab) checks.push(notCheckable(d('yaw-damper-off'), KIND, { severity }))
    else {
      const a = maxAbs(astab.values, tir[0], tir[1])
      const rCh = findChannel(ds, '____R,deg/s')
      const r = rCh ? maxAbs(rCh.values, r0, r1) : NaN
      let status: CheckStatus
      if (settings.yawDamper === 'on') status = 'info'
      else if (a > t.astabOn) status = 'fail'
      else if (a > t.astabOff || !(r >= 0.5)) status = 'warn'
      else status = 'pass'
      if (!lateral && status !== 'pass') status = 'info'
      checks.push(
        result(
          d('yaw-damper-off'), KIND, status,
          `max |ruddr,astab| ${fmt(a, 2)}; max |R| ${fmt(r, 2)} deg/s${settings.yawDamper === 'on' ? '; declared augmented run' : ''}`,
          'pass: |ruddr,astab| ≤ 1e−4 with |R| ≥ 0.5 deg/s; warn: unproven (|R| < 0.5) or ≤ 1e−3; fail > 1e−3',
          status === 'fail' ? 'Switch the yaw damper off (or declare an augmented run in the settings).' : '',
          { severity },
        ),
      )
    }
  }

  // ---- other-augmentation
  {
    const token = short === 'SP' || short === 'PH' ? '_elev,astab' : 'ailrn,astab'
    const ch = findChannel(ds, token)
    if (!ch) checks.push(notCheckable(d('other-augmentation'), KIND))
    else {
      const a = maxAbs(ch.values, tir[0], tir[1])
      const status: CheckStatus = a <= t.astabOff ? 'pass' : 'warn'
      checks.push(
        result(
          d('other-augmentation'), KIND, status, `max |${token}| ${fmt(a, 2)}`, 'pass ≤ 1e−4; warn above (never fails)',
          status === 'warn' ? 'If it cannot be switched off, state "augmentation present (X-Plane model)".' : '',
        ),
      )
    }
  }

  // ---- configuration-constant
  const config = configuration(ds, tir[0], tir[1])
  {
    if (!config.surfaces.length) checks.push(notCheckable(d('configuration-constant'), KIND, { needs: 'row {13}' }))
    else {
      const make = (a: number, b: number): Check => {
        const cfg = configuration(ds, a, b)
        const moved = cfg.surfaces.filter((s) => s.range > t.configRange)
        const gearMoved = cfg.gear !== null && cfg.gear.range > t.configRange
        const status: CheckStatus = moved.length || gearMoved ? 'fail' : cfg.gear ? 'pass' : 'warn'
        const clean = cfg.surfaces.every((s) => Math.abs(s.mean) <= 0.01) && (!cfg.gear || cfg.gear.mean <= 0.01)
        return result(
          d('configuration-constant'), KIND, status,
          `${configText(cfg, t.configRange)}; ${clean ? 'clean (Category B proxy)' : 'flaps or gear down (Category C)'}`,
          'pass: every range ≤ 0.001 (engineering judgement); warn: gear not logged; fail: anything moved',
          status === 'fail' ? 'Keep flaps, slats, speedbrake and gear fixed through the run.' : status === 'warn' ? 'Log row 14 (Gear & brakes).' : '',
        )
      }
      checks.push(guarded(make, tir[0]))
    }
  }

  // ---- trim-fixed
  {
    const tokens = ['_trim,_elev', '_trim,ailrn', '_trim,ruddr']
    const chs = tokens.map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
    if (!chs.length) checks.push(notCheckable(d('trim-fixed'), KIND))
    else {
      const make = (a: number, b: number): Check => {
        const worst = Math.max(...chs.map((c) => summary(c.values, a, b).range).filter(Number.isFinite), 0)
        const status = grade(worst, t.trimRange, t.trimRangeWarn) ?? 'pass'
        return result(
          d('trim-fixed'), KIND, status, `largest trim range ${fmt(worst, 2)}`, 'pass ≤ 0.002; warn ≤ 0.005; fail above (pilot trim, autotrim or speed trim)',
          status === 'fail' ? 'Leave the trim alone after the input; switch off autotrim or speed trim.' : '',
        )
      }
      checks.push(guarded(make, ir[0]))
    }
  }

  // ---- trimmed-start
  checks.push(trimmedStart(ds, mode, trimWin, iStart !== null, t, estimatedStart !== null ? time[estimatedStart] : null))

  // ---- hands-off-trim
  {
    const sticks = (['elev', 'ailrn', 'ruddr'] as Axis[]).map((ax) => ({ ax, ch: findChannel(ds, STICK[ax]) }))
    if (!sticks.some((s) => s.ch) || !trimWin || trimWin.end <= trimWin.start) {
      checks.push(sticks.some((s) => s.ch) ? notCheckable(d('hands-off-trim'), KIND, { needs: 'Needs the trim window T before the input' }) : notCheckable(d('hands-off-trim'), KIND))
    } else {
      let status: CheckStatus = 'pass'
      const parts: string[] = []
      for (const { ax, ch } of sticks) {
        if (!ch) continue
        const xs: number[] = []
        for (let i = trimWin.start; i < trimWin.end; i += 1) if (Number.isFinite(ch.values[i])) xs.push(ch.values[i])
        const med = median(xs)
        const dev = Math.max(0, ...xs.map((x) => Math.abs(x - med)))
        const heldInTurn = short === 'RS' && ax !== 'ruddr'
        const mStatus = heldInTurn ? 'pass' : (grade(Math.abs(med), t.stickMedian, 0.1) ?? 'pass')
        status = worse(status, mStatus, grade(dev, t.stickDev, 0.05))
        parts.push(`${AXIS_NAME[ax]} median ${signed(med, 3)}, deviation ${fmt(dev, 2)}`)
      }
      checks.push(
        result(
          d('hands-off-trim'), KIND, status, parts.join('; '), 'pass: |median| ≤ 0.03 and deviation ≤ 0.02; warn ≤ 0.10 or ≤ 0.05; fail beyond (roll: pitch and lateral may be held in the turn)',
          status === 'pass' ? '' : 'Trim the aircraft so it holds the condition with the stick centred and still.',
        ),
      )
    }
  }

  // ---- input-detected
  {
    if (!search.channel) {
      checks.push(
        notCheckable(d('input-detected'), KIND, {
          needs: `row {8}; fallback row {11}${estimatedStart !== null ? ` (input estimated from the response at ${fix(time[estimatedStart], 1)} s)` : ''}`,
        }),
      )
      if (estimatedStart !== null) notes.push('Input estimated from the response: no control channel is logged.')
    } else if (!det) {
      checks.push(
        result(d('input-detected'), KIND, 'fail', `no input on ${search.channel.token} in the ${LOOKBACK[short]} s before the window`, 'a deliberate input on the mode’s axis before the window',
          'Start the window after the input, or choose the window that follows one (Time history → Select).'),
      )
    } else {
      const gap = det.variant === 'onset' ? Math.abs(time[r0] - det.startT) : time[r0] - det.endT
      const limit = det.variant === 'onset' ? 0.5 : short === 'PH' ? 5 : 2
      let status: CheckStatus = gap <= limit ? 'pass' : 'warn'
      if (det.variant === 'onset' && short !== 'RS') status = 'warn'
      if (det.bursts > 1 || det.otherAxes.length) status = worse(status, 'warn')
      checks.push(
        result(
          d('input-detected'), KIND, status,
          `${det.shape} on ${det.channelId} at ${fix(det.startT, 1)}–${fix(det.endT, 1)} s (${fix(det.duration, 2)} s, peak ${signed(det.peak, 3)}), ${det.variant === 'onset' ? 'window starts at its onset' : `ends ${fix(gap, 1)} s before the window`}${det.bursts > 1 ? `; ${det.bursts} bursts` : ''}${det.otherAxes.length ? `; also ${det.otherAxes.join(', ')}` : ''}`,
          det.variant === 'onset' ? 'roll: the window starts within 0.5 s of the step onset' : `one burst ending ≤ ${limit} s before the window`,
          status === 'pass' ? '' : 'Use one clean input on the mode’s axis only, then hands off.',
        ),
      )
    }
  }

  // ---- input-shape
  checks.push(inputShape(ds, mode, det, fit, rows))

  // ---- input-size
  checks.push(inputSize(ds, mode, det, trimWin, rows))

  // ---- controls-fixed
  checks.push(controlsFixed(ds, mode, rows, t, det))

  // ---- window-start
  {
    if (!det) checks.push(notCheckable(d('window-start'), KIND))
    else {
      const onsetRs = det.variant === 'onset' && short === 'RS'
      const gap = onsetRs ? time[r0] - det.startT : time[r0] - det.endT
      const maxGap = short === 'PH' ? 5 : t.windowGapS
      const status: CheckStatus = onsetRs
        ? Math.abs(gap) <= 0.2 ? 'pass' : 'warn'
        : gap < -0.2 ? 'fail' : gap <= maxGap ? 'pass' : 'warn'
      checks.push(
        result(
          d('window-start'), KIND, status,
          onsetRs ? `window starts ${fix(gap, 2)} s from the step onset` : gap < -0.2 ? `the window starts ${fix(-gap, 2)} s before the input ends (it holds the forced input)` : `window starts ${fix(gap, 2)} s after the input ends`,
          onsetRs ? '|gap| ≤ 0.2 s from the step edge' : `pass 0 ≤ gap ≤ ${maxGap} s after the input ends; fail when the window holds the input (gap < −0.2 s)`,
          status === 'pass' ? '' : gap < -0.2 ? 'Start the window after the input has ended: fit the free response.' : 'Start the window sooner after the input ends.',
        ),
      )
    }
  }

  // ---- record-length
  checks.push(recordLength(ds, mode, rows, fit))

  // ---- fit-quality
  {
    if (!fit) checks.push(notCheckable(d('fit-quality'), KIND))
    else if (!fit.ok) {
      checks.push(result(d('fit-quality'), KIND, 'fail', fit.message ? `fit rejected: ${fit.message}` : 'fit rejected', 'an accepted fit (ok) with R² ≥ 0.9', 'Choose a cleaner window: start after the input, include enough cycles.'))
    } else {
      let status: CheckStatus = grade(-fit.r2, -t.r2, -0.7) ?? 'warn'
      if (status === 'fail') status = 'warn'
      let measured = `R² ${fix(fit.r2, 3)}`
      if (fit.model === 'oscillation') {
        const agree = Math.abs(fit.zeta - fit.zetaLogDec) <= Math.max(0.03, 0.25 * Math.abs(fit.zeta))
        measured += `, ζ ${fmt(fit.zeta, 3)} vs log decrement ${fmt(fit.zetaLogDec, 3)}, ${fit.peaks} peaks`
        if (!Number.isFinite(fit.zetaLogDec) || !agree || fit.peaks < 3) status = worse(status, 'warn')
      }
      if (fit.message) status = worse(status, 'warn')
      checks.push(
        result(d('fit-quality'), KIND, status, measured, 'pass: accepted, R² ≥ 0.9 and (oscillation) |ζ − ζ_logdec| ≤ max(0.03, 0.25ζ) with ≥ 3 peaks; warn R² 0.7–0.9 or disagreement; fail: rejected',
          status === 'pass' ? '' : 'Check the window: start, length and trend setting.'),
      )
    }
  }

  // ---- mode-purity
  checks.push(modePurity(ds, mode, det, rows, fit))

  // ---- weather
  checks.push(weather(ds, tir, t))

  // ---- envelope
  checks.push(envelope(ds, tir, settings, t))

  // ---- weight-cg
  {
    const w = findChannel(ds, 'total,___lb')
    const cg = findChannel(ds, '___cg,ftref')
    if (!w && !cg) checks.push(notCheckable(d('weight-cg'), KIND))
    else {
      const at = iStart ?? r0
      const wr = w ? summary(w.values, r0, r1) : null
      checks.push(
        result(
          d('weight-cg'), KIND, 'info',
          [w ? `W ${fmt(w.values[at], 5)} lb` : '', cg ? `CG ${fmt(cg.values[at], 4)} ft` : '', wr && wr.n ? `W change over R ${fmt(wr.range, 3)} lb (${pct(wr.range / wr.mean, 2)})` : '']
            .filter(Boolean)
            .join('; '),
          'report only',
        ),
      )
    }
  }

  // ---- repeats
  {
    const reps = input.repeats?.filter((r) => Number.isFinite(r.zeta) && Number.isFinite(r.periodS)) ?? []
    if (reps.length < 2) checks.push(notCheckable(d('repeats'), KIND))
    else {
      const zs = reps.map((r) => r.zeta)
      const ts = reps.map((r) => r.periodS)
      const zr = Math.max(...zs) - Math.min(...zs)
      const tm = ts.reduce((s, v) => s + v, 0) / ts.length
      const tr = (Math.max(...ts) - Math.min(...ts)) / tm
      checks.push(
        result(d('repeats'), KIND, 'info', `${reps.length} points: ζ range ${fmt(zr, 2)}, Td range ${pct(tr, 0)}${zr > 0.05 || tr > 0.1 ? ' (flagged)' : ''}`, 'report only; flag a ζ range > 0.05 or a Td range > 10 %'),
      )
    }
  }

  // ---- hq-level
  checks.push(hqLevel(ds, mode, rows, fit, config, settings))

  // ---- verdict
  const label = settings.yawDamper === 'on' ? 'augmented' : 'X-Plane model, one condition, yaw damper off = failure state (bare airframe)'
  const verdict = dynamicVerdict(checks, { estimated })
  for (const c of checks) {
    if (c.status === 'warn' && c.severity !== 'info') notes.push(`${c.title}: ${c.measured}`)
  }
  return { mode, checks, verdict, notes, input: det, trim: trimWin, label, estimatedInput: estimatedStart !== null ? time[estimatedStart] : null }
}

const AXES: readonly Axis[] = ['elev', 'ailrn', 'ruddr']

interface Span {
  where: 'T' | 'R' | 'TIR' | 'L'
  a: number
  b: number
}

/**
 * The spans autopilot-off judges: T and R whole and every `block` seconds of them (2 s, or 20 samples at low sample
 * rates; stepped by half a block), so an autopilot that held a surface for part of a span is not averaged away; then
 * TIR (rows [tir0, tir1)) whole. Without an input on the stick, also the look-back searched before R (`lookback`).
 */
function autopilotSpans(ds: Dataset, trim: TrimWindow | null, rows: RowRange, tir: [number, number], lookback: [number, number] | null = null): Span[] {
  const time = ds.elapsed
  const rate = Number.isFinite(ds.sampleRateHz) && ds.sampleRateHz > 0 ? ds.sampleRateHz : 10
  const block = Math.max(2, 20 / rate)
  const out: Span[] = []
  const add = (where: Span['where'], a: number, b: number) => {
    if (b - a < 3) return
    out.push({ where, a, b })
    if (time[b - 1] - time[a] <= block) return
    for (let t0 = time[a]; t0 < time[b - 1]; t0 += block / 2) {
      const s = rowAtTime(ds, t0, a, b)
      const e = rowAtTime(ds, t0 + block, s, b)
      if (e - s >= 3) out.push({ where, a: s, b: e })
      if (e >= b) break
    }
  }
  if (trim && trim.end > trim.start) add('T', trim.start, trim.end)
  add('R', rows[0], rows[1])
  if (tir[1] - tir[0] >= 3) out.push({ where: 'TIR', a: tir[0], b: tir[1] })
  if (lookback) add('L', lookback[0], lookback[1])
  return out
}

/**
 * Who moved one axis's surface (the shared rule, pitchControlSource, without widening): 'autopilot' as soon as one span
 * shows the surface following a moving servo while the stick was still; otherwise its verdict over TIR ('pilot' when
 * the surface follows the stick there: the input moved it).
 */
function axisSource(ds: Dataset, axis: Axis, spans: readonly Span[], tir: [number, number]): { source: PitchSource; text: string } {
  const time = ds.elapsed
  for (const span of spans) {
    if (pitchControlSource(ds, span.a, span.b, axis, 0)?.source !== 'autopilot') continue
    const where =
      span.where === 'T' ? 'before the input' : span.where === 'R' ? 'during the response' : span.where === 'L' ? 'before the window' : 'during the run'
    return {
      source: 'autopilot',
      text: `autopilot ${where}, ${fix(time[span.a], 1)}–${fix(time[span.b - 1], 1)} s (the surface followed the moving servo, stick still)`,
    }
  }
  const source = pitchControlSource(ds, tir[0], tir[1], axis, 0)?.source ?? 'unknown'
  return { source, text: source }
}

/** NATO 29-2's milestones: "Retest required" / "Cannot confirm — tick rows …" / "Acceptable for analysis (N notes)". */
/** What a failed critical check means for the run, in the verdict's words. */
export const DYNAMIC_REASON: Readonly<Record<string, string>> = {
  'time-base': 'a reset or gap inside the run',
  'sample-rate': 'the sample rate is too low for the mode',
  'autopilot-off': 'the autopilot moved the surfaces',
  'throttle-fixed': 'the throttle moved',
  'yaw-damper-off': 'the yaw damper was on',
  'configuration-constant': 'the configuration changed',
  'trim-fixed': 'the trim moved',
  'trimmed-start': 'not trimmed and steady before the input',
  'input-detected': 'no input found before the window',
  'input-shape': 'the input does not suit the mode',
  'controls-fixed': 'the controls moved during the response',
  'record-length': 'too few cycles recorded',
  'fit-quality': 'the fit was rejected (try another window or trend)',
}

/**
 * The run's verdict. With `estimated` (no control channel: the input was estimated from the response) a "Cannot
 * confirm" says so; the checks that depend on the estimate never fail critically (they are capped at warn).
 */
export function dynamicVerdict(checks: readonly Check[], options: { estimated?: boolean } = {}): Verdict {
  const critical = checks.filter((c) => c.severity === 'critical')
  const failed = critical.filter((c) => c.status === 'fail')
  if (failed.length) return { kind: 'retest', text: `Retest required — ${failed.map((c) => DYNAMIC_REASON[c.id] ?? c.title.toLowerCase()).join('; ')}` }
  const na = critical.filter((c) => c.status === 'not-checkable')
  if (na.length) {
    const rows = rowsFromNotCheckable(na)
    return {
      kind: 'cannot-confirm',
      text: `Cannot confirm — ${rows.length ? `tick rows ${rows.join(', ')}` : na.map((c) => c.title.toLowerCase()).join('; ')}${options.estimated ? '; the input was estimated from the response' : ''}`,
    }
  }
  const notes = checks.filter((c) => c.status === 'warn' && c.severity !== 'info').length
  return { kind: 'acceptable', text: `Acceptable for analysis (${notes} note${notes === 1 ? '' : 's'})` }
}

// ------------------------------------------------------------------ individual checks

/**
 * trimmed-start over T. `estimatedAt` (s): no control channel, so the input, and T before it, were estimated from the
 * response; the result is labelled so and never fails (capped at warn): the estimate, not the flight, may be wrong.
 */
function trimmedStart(ds: Dataset, mode: ModeId, trimWin: TrimWindow | null, haveInput: boolean, t: Thresholds, estimatedAt: number | null): Check {
  const short = SHORT[mode]
  const def0 = d('trimmed-start')
  if (!haveInput || !trimWin) return notCheckable(def0, KIND, { needs: 'Needs the input (the trim window T ends 0.5 s before it)' })
  const tMin = short === 'RS' ? t.tMinRollS : t.tMinS
  if (trimWin.seconds < tMin) {
    if (trimWin.cut === 'input') {
      return result(def0, KIND, 'fail', `T only ${fix(trimWin.seconds, 1)} s: an earlier input or its response was still in progress`, `T ≥ ${tMin} s of steady trimmed flight before the input`, 'Wait for the previous transient to die out, then trim before the input.')
    }
    return notCheckable(def0, KIND, { needs: `Not checkable — T reaches the log start or a reset or gap (${fix(trimWin.seconds, 1)} s)` })
  }
  const time = ds.elapsed
  const { start: a, end: b } = trimWin
  const speed = firstChannel(ds, ['_Vind,_kias', '_Vind,_keas', 'Vtrue,_ktas'])
  const vvi = findChannel(ds, '__VVI,__fpm')
  const r = findChannel(ds, '____R,deg/s')
  const theta = findChannel(ds, 'pitch,__deg')
  const phi = findChannel(ds, '_roll,__deg')
  const beta = findChannel(ds, '_beta,__deg')
  if (!speed && !vvi && !phi) return notCheckable(def0, KIND)
  const parts: string[] = []
  let status: CheckStatus = trimWin.seconds >= LTRIM[short] - 0.25 ? 'pass' : 'warn'
  if (estimatedAt !== null) parts.push(`input estimated from the response at ${fix(estimatedAt, 1)} s`)
  parts.push(`T ${fix(trimWin.seconds, 1)} s${trimWin.settled ? ' (from where the previous input’s response settled)' : ''}`)
  const two = (value: number, limit: number) => grade(Math.abs(value), limit, 2 * limit)
  const rs = short === 'RS'
  let hint = 'Trim and let the aircraft settle before the input.'
  if (speed) {
    const tr = trend(speed.values, time, a, b)
    const drift = Math.abs(tr.slope * tr.seconds)
    const scatter = 2 * tr.residualSd
    const lim = rs ? 3 : t.speedDriftKt
    status = worse(status, two(drift, lim), rs ? null : two(scatter, t.speedDriftKt))
    parts.push(`speed drift ${fix(drift, 2)} kt, 2σ ${fix(scatter, 2)} kt`)
  }
  if (vvi) {
    const s = summary(vvi.values, a, b)
    status = worse(status, two(s.mean, rs ? 300 : t.vviMeanFpm), rs ? null : two(s.sd, t.vviSdFpm))
    parts.push(`VVI ${signed(s.mean, 0)} ± ${fix(s.sd, 0)} fpm`)
  }
  const rates = rateChannels(ds, short).map((c) => maxAbs(c.values, a, b))
  if (rates.length) {
    const worst = Math.max(...rates)
    status = worse(status, two(worst, t.rateDegS))
    parts.push(`rates ≤ ${fix(worst, 2)} deg/s`)
  }
  if (theta && !rs) {
    const s = summary(theta.values, a, b)
    status = worse(status, two(s.sd, t.thetaSdDeg))
    parts.push(`σθ ${fix(s.sd, 2)}°`)
  }
  if (phi) {
    const s = summary(phi.values, a, b)
    if (rs) {
      // FD12b p.37: a steady turn of about 30° first is usual (it keeps the bank excursion small), not required, so
      // a start from wings level or a shallow bank is a note; a steep turn (beyond 45°) fails. Steadiness stays critical.
      const bank = Math.abs(s.mean)
      const bankStatus: CheckStatus = bank >= 20 && bank <= 35 ? 'pass' : bank <= 45 ? 'warn' : 'fail'
      status = worse(status, bankStatus, two(s.sd, 1.5))
      parts.push(`bank ${fix(s.mean, 1)} ± ${fix(s.sd, 1)}°${bank < 15 ? ' (from wings level: a steady turn of about 30° is usual, to limit the bank excursion)' : ''}`)
      if (bank < 20) hint = 'Let the aircraft settle before the step; a steady turn of about 30° first is usual (FD12b p.37): it keeps the bank excursion small.'
    } else {
      const bank = Math.abs(s.mean)
      status = worse(status, bank <= t.bankDeg ? 'pass' : bank <= 5 ? 'warn' : 'fail')
      parts.push(`bank ${fix(s.mean, 1)}°`)
    }
  }
  if (short === 'DR' && beta) {
    const s = summary(beta.values, a, b)
    status = worse(status, two(Math.abs(s.mean), 1))
    parts.push(`|β| ${fix(Math.abs(s.mean), 2)}°`)
  }
  if (short === 'SPI' && r) {
    const s = summary(r.values, a, b)
    status = worse(status, two(Math.abs(s.mean), 0.3))
    parts.push(`mean R ${fix(s.mean, 2)} deg/s`)
  }
  if (estimatedAt !== null && status === 'fail') {
    // The trim window sits where the estimate put it: not proof that the flight was unsteady.
    status = 'warn'
    hint = 'The input was estimated from the response (no control channel logged), so T may be misplaced: log row 8 (Joystick) to place it.'
  }
  return result(
    def0, KIND, status, parts.join('; '),
    (rs
      ? 'steady turn (usual, FD12b p.37): T ≥ 3 s, 20–35° bank (σ ≤ 1.5°), |P| ≤ 1 deg/s, drift ≤ 3 kt, |VVI| ≤ 300 fpm; warn within twice, or from wings level; fail beyond twice or a bank over 45°'
      : `T ≥ ${LTRIM[short]} s; drift and 2σ ≤ 2 kt; |VVI| ≤ 200 fpm (σ ≤ 150); rates ≤ 1 deg/s; σθ ≤ 0.5°; |φ| ≤ 3°${short === 'DR' ? '; |β| ≤ 1°' : ''}${short === 'SPI' ? '; |mean R| ≤ 0.3 deg/s' : ''}; warn within twice`) +
      (estimatedAt !== null ? '; with the input estimated from the response, never worse than warn' : ''),
    status === 'pass' ? '' : hint,
  )
}

function inputShape(ds: Dataset, mode: ModeId, det: InputDetection | null, fit: FitSummary | null, rows: RowRange): Check {
  const short = SHORT[mode]
  const def0 = d('input-shape')
  if (!det) return notCheckable(def0, KIND, { needs: 'Needs input-detected' })
  const td = fit?.ok && fit.model === 'oscillation' ? fit.periodS : NaN
  let status: CheckStatus = 'pass'
  let severity: Check['severity'] = 'advisory'
  let measured = `${det.shape}, ${fix(det.duration, 2)} s`
  let criterion: string
  if (short === 'SP') {
    criterion = 'pulse ≤ 1 s, or a doublet 0.6–1.4 × Td with lobe areas 0.7–1.4; warn pulse 1–3 s; fail a step (> 3 s) or > 2 cycles'
    if (det.shape === 'step' || (det.shape === 'cyclic' && det.cycles > 2)) {
      status = 'fail'
      severity = 'critical'
    } else if (det.shape === 'pulse') {
      measured += `, half-amplitude width ${fix(det.halfWidth, 2)} s`
      status = det.halfWidth <= 1 ? 'pass' : 'warn'
    } else if (det.shape === 'doublet' || det.shape === 'cyclic') {
      if (det.shape === 'cyclic') severity = 'critical'
      const ratio = det.duration / td
      measured += `, ${Number.isFinite(ratio) ? `${fix(ratio, 2)} × Td` : 'Td unknown'}, lobe areas ${fix(det.areaRatio, 2)}`
      const inBand = ratio >= 0.6 && ratio <= 1.4 && det.areaRatio >= 0.7 && det.areaRatio <= 1.4
      status = det.shape === 'doublet' && inBand ? 'pass' : 'warn'
    }
  } else if (short === 'PH') {
    criterion = 'one held lobe ≥ 3 s (about 5 % speed change); warn a pulse or doublet < 3 s'
    status = det.lobes === 1 && det.duration >= 3 ? 'pass' : 'warn'
  } else if (short === 'DR') {
    criterion = 'a doublet 0.5–1.5 × Td, or ≤ 2 forcing cycles each 0.7–1.3 × Td, then release; warn otherwise'
    const ratio = det.duration / td
    measured += Number.isFinite(ratio) ? `, ${fix(ratio, 2)} × Td` : ', Td unknown'
    if (det.shape === 'doublet') status = ratio >= 0.5 && ratio <= 1.5 ? 'pass' : 'warn'
    else if (det.shape === 'cyclic') {
      const each = det.duration / det.cycles / td
      status = det.cycles <= 2 && each >= 0.7 && each <= 1.3 ? 'pass' : 'warn'
    } else status = 'warn'
  } else if (short === 'RS') {
    criterion = 'a lateral step held ≥ max(2 s, 3|τ|) with pedal change ≤ 0.03; warn a shorter hold or pedal used'
    const tau = fit?.model === 'first-order' && fit.ok ? Math.abs(fit.tau) : NaN
    const need = Math.max(2, Number.isFinite(tau) ? 3 * tau : 2)
    const pedal = findChannel(ds, 'ruddr,stick')
    const pedalChange = pedal ? summary(pedal.values, det.start, det.end).range : 0
    measured += `, held ${fix(det.duration, 2)} s (needs ${fix(need, 1)} s)${pedal ? `, pedal change ${fmt(pedalChange, 2)}` : ''}`
    status = det.duration >= need && pedalChange <= 0.03 ? 'pass' : 'warn'
  } else {
    criterion = 'an entry, then every control back at its baseline (± 0.03) before the window'
    const sticks = ['_elev,stick', 'ailrn,stick', 'ruddr,stick'].map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
    const pre = det.start > 0 ? det.start - 1 : det.start
    const back = sticks.every((c) => Math.abs(c.values[rows[0]] - c.values[pre]) <= 0.03)
    measured += back ? ', controls back at baseline' : ', controls not back at baseline'
    status = back ? 'pass' : 'warn'
  }
  return result(def0, KIND, status, measured, criterion, status === 'pass' ? '' : 'Use the input the lectures give for this mode.', { severity })
}

function inputSize(ds: Dataset, mode: ModeId, det: InputDetection | null, trimWin: TrimWindow | null, rows: RowRange): Check {
  const short = SHORT[mode]
  const def0 = d('input-size')
  const [r0, r1] = rows
  const from = det ? det.start : r0
  const ref: [number, number] = trimWin && trimWin.end > trimWin.start ? [trimWin.start, trimWin.end] : [Math.max(0, from - 10), from]
  const peakDev = (ch: Channel, a: number, b: number) => {
    const base = summary(ch.values, ref[0], ref[1]).mean
    const s = summary(ch.values, a, b)
    return s.n ? Math.max(Math.abs(s.max - base), Math.abs(s.min - base)) : NaN
  }
  if (short === 'SP') {
    const alpha = findChannel(ds, 'alpha,__deg')
    const nz = findChannel(ds, 'Gload,norml')
    if (!alpha && !nz) return notCheckable(def0, KIND)
    const da = alpha ? peakDev(alpha, from, r1) : NaN
    const dn = nz ? peakDev(nz, from, r1) : NaN
    const nzMin = nz ? summary(nz.values, from, r1).min : NaN
    let status: CheckStatus = 'pass'
    if (alpha) status = worse(status, da >= 0.5 && da <= 3 ? 'pass' : 'warn')
    if (nz) status = worse(status, grade(dn, 0.5, 1.0), nzMin < 0 ? 'fail' : null)
    return result(def0, KIND, status, `peak |Δα| ${fix(da, 2)}°, peak |Δn_z| ${fix(dn, 2)} g, min n_z ${fix(nzMin, 2)} g`,
      'pass 0.5 ≤ |Δα| ≤ 3° and |Δn_z| ≤ 0.5 g; warn |Δα| 3–5° or < 0.5°, |Δn_z| 0.5–1 g; fail |Δn_z| > 1 g or n_z < 0', status === 'pass' ? '' : 'Size the input so the response stays small and linear.')
  }
  if (short === 'PH') {
    const v = firstChannel(ds, ['Vtrue,_ktas', '_Vind,_kias'])
    if (!v) return notCheckable(def0, KIND, { needs: 'row {3}' })
    const vt = summary(v.values, ref[0], ref[1]).mean
    const at = det ? Math.min(ds.rowCount - 1, det.end) : r0
    const dv = Math.abs(v.values[at] - vt) / vt
    const status: CheckStatus = dv >= 0.03 && dv <= 0.1 ? 'pass' : dv >= 0.01 && dv <= 0.2 ? 'warn' : 'fail'
    return result(def0, KIND, status, `|ΔV|/V ${pct(dv)} at the input’s end`, 'pass 3–10 %; warn 1–3 % or 10–20 %; fail < 1 % or > 20 %', status === 'pass' ? '' : 'Hold the elevator until the speed has changed about 5 %.')
  }
  if (short === 'DR') {
    const beta = findChannel(ds, '_beta,__deg')
    const phi = findChannel(ds, '_roll,__deg')
    if (!beta) return notCheckable(def0, KIND, { needs: 'row {18}' })
    const db = peakDev(beta, from, r1)
    const ph = phi ? maxAbs(phi.values, from, r1) : NaN
    let status: CheckStatus = db >= 1 && db <= 5 ? 'pass' : db >= 0.5 && db <= 10 ? 'warn' : 'fail'
    if (phi) status = worse(status, grade(ph, 15, 30))
    return result(def0, KIND, status, `peak |Δβ| ${fix(db, 2)}°, max |φ| ${fix(ph, 1)}°`, 'pass 1–5° with |φ| ≤ 15°; warn 0.5–1° or 5–10°; fail > 10° or |φ| > 30°', status === 'pass' ? '' : 'Size the rudder doublet for a few degrees of sideslip.')
  }
  const phi = findChannel(ds, '_roll,__deg')
  if (!phi) return notCheckable(def0, KIND, { needs: 'row {17}' })
  if (short === 'RS') {
    const start = phi.values[det ? det.start : r0]
    const end = phi.values[Math.min(ds.rowCount - 1, det ? det.end : r0)]
    const a = Math.abs(start)
    // From about 30° of bank to the other side is the usual technique (FD12b p.37: usual, not required), so a start
    // from wings level is a note, not a failure; a steep start (over 60°) is not small-perturbation.
    let status: CheckStatus = a >= 20 && a <= 35 ? 'pass' : a > 60 ? 'fail' : 'warn'
    if (status === 'pass' && !(Math.sign(end) === -Math.sign(start))) status = 'warn'
    return result(def0, KIND, status, `bank ${fix(start, 1)}° at the input, ${fix(end, 1)}° at its end${a < 10 ? ' (from wings level)' : ''}`, 'pass: from 20–35° of bank to the opposite side; warn otherwise up to 60°, a start from wings level included (the steady turn is usual, not required: FD12b p.37); fail > 60°', status === 'pass' ? '' : 'Roll from about 30° of bank through wings level (the usual technique), so the bank excursion stays small.')
  }
  const bank = Math.abs(phi.values[rows[0]])
  const status: CheckStatus = bank >= 5 && bank <= 20 ? 'pass' : bank >= 3 && bank <= 30 ? 'warn' : 'fail'
  return result(def0, KIND, status, `|φ| ${fix(bank, 1)}° at release`, 'pass 5–20°; warn 3–5° or 20–30°; fail < 3° or > 30°', status === 'pass' ? '' : 'Release at 5–20° of bank.')
}

function controlsFixed(ds: Dataset, mode: ModeId, rows: RowRange, t: Thresholds, det: InputDetection | null): Check {
  const short = SHORT[mode]
  const def0 = d('controls-fixed')
  const [r0, r1] = rows
  const time = ds.elapsed
  // Roll subsidence, onset variant: R starts on the step's edge and the lateral stick is held through it (FD12b p.36),
  // so that axis is judged against its held value, from where the step has risen to it.
  const onset = short === 'RS' && det?.variant === 'onset'
  const axes: { ax: Axis; ch: Channel | null; primary: boolean }[] = AXES.map((ax) => ({
    ax,
    ch: findChannel(ds, STICK[ax]),
    primary:
      short === 'DR' || short === 'SPI' ? true : short === 'RS' ? ax !== 'elev' : ax === 'elev',
  }))
  if (!axes.some((a) => a.ch)) return notCheckable(def0, KIND)
  let status: CheckStatus = 'pass'
  const parts: string[] = []
  for (const { ax, ch, primary } of axes) {
    if (!ch) continue
    let from = r0
    let v0 = ch.values[r0]
    let held = ''
    if (onset && ax === 'ailrn') {
      // The held level: the median over R. The rise to it may take up to 1 s after R starts (samples still rising
      // after that count as movement).
      const xs: number[] = []
      for (let i = r0; i < r1; i += 1) if (Number.isFinite(ch.values[i])) xs.push(ch.values[i])
      v0 = median(xs)
      const riseEnd = rowAtTime(ds, time[r0] + 1, r0, r1)
      while (from < riseEnd && !(Math.abs(ch.values[from] - v0) <= 0.02)) from += 1
      held = ` (held at ${signed(v0, 2)} from ${fix(time[Math.min(from, r1 - 1)], 2)} s)`
    }
    let within = 0
    let n = 0
    let dmax = 0
    for (let i = from; i < r1; i += 1) {
      const v = ch.values[i]
      if (!Number.isFinite(v)) continue
      n += 1
      const dv = Math.abs(v - v0)
      if (dv <= 0.02) within += 1
      dmax = Math.max(dmax, dv)
    }
    const f = n ? within / n : NaN
    parts.push(`${AXIS_NAME[ax]}${held} ${pct(f, 0)} still, max ${fmt(dmax, 2)}`)
    const axisStatus: CheckStatus = f >= t.stillFraction && dmax <= t.stillMax ? 'pass' : f >= 0.9 && dmax <= 0.1 ? 'warn' : 'fail'
    if (primary) status = worse(status, axisStatus)
    else if ((short === 'SP' || short === 'PH') && dmax > 0.1) status = 'fail'
    else status = worse(status, axisStatus === 'pass' ? 'pass' : 'warn')
  }
  if (short === 'SP' || short === 'PH') {
    const phi = findChannel(ds, '_roll,__deg')
    if (phi) {
      const change = summary(phi.values, r0, r1).range
      parts.push(`bank change ${fix(change, 1)}°`)
      if (change > 15) status = 'fail'
    }
  }
  return result(def0, KIND, status, parts.join('; '),
    `primary axes ≥ 95 % within 0.02 of the start and max change ≤ 0.05; warn ≥ 90 % and ≤ 0.10; fail beyond (or lateral inputs > 0.10 / bank change > 15° in SP and PH)${onset ? '; roll onset: the lateral stick against its held value once the step has risen (within 1 s)' : ''}`,
    status === 'pass' ? '' : onset ? 'Hold the lateral step constant and keep the pedals and elevator still through the window.' : 'Hands and feet off (or fixed) for the whole response window.')
}

function recordLength(ds: Dataset, mode: ModeId, rows: RowRange, fit: FitSummary | null): Check {
  const short = SHORT[mode]
  const def0 = d('record-length')
  const severity = short === 'PH' || short === 'DR' ? 'critical' : 'advisory'
  const len = ds.elapsed[rows[1] - 1] - ds.elapsed[rows[0]]
  if (short === 'SPI') {
    const phi = findChannel(ds, '_roll,__deg')
    if (!phi) return notCheckable(def0, KIND, { needs: 'row {17}', severity })
    const start = Math.abs(phi.values[rows[0]])
    const s = summary(phi.values, rows[0], rows[1])
    const doubled = Math.max(Math.abs(s.max), Math.abs(s.min)) >= 2 * start || Math.abs(phi.values[rows[1] - 1]) <= 0.5 * start
    const status: CheckStatus = doubled || len >= 60 ? 'pass' : len >= 30 ? 'warn' : 'fail'
    return result(def0, KIND, status, `${fix(len, 1)} s; bank ${doubled ? 'doubled or halved' : 'neither doubled nor halved'}`, 'pass: |φ| doubles or halves, or R ≥ 60 s; warn 30–60 s; fail < 30 s', status === 'pass' ? '' : 'Record longer: until the bank doubles or halves.', { severity })
  }
  if (!fit || !fit.ok) return notCheckable(def0, KIND, { severity })
  if (fit.model === 'first-order') {
    const ratio = len / Math.abs(fit.tau)
    const status = grade(-ratio, -4, -2) ?? 'warn'
    return result(def0, KIND, status, `R = ${fix(ratio, 1)} |τ|`, 'pass R ≥ 4|τ|; warn 2–4|τ|; fail < 2|τ|', status === 'pass' ? '' : 'Lengthen the window to four time constants.', { severity })
  }
  const cycles = fit.cycles
  const envelope = Math.exp(-fit.sigma * len)
  let status: CheckStatus
  if (short === 'SP') status = len >= 1.5 * fit.periodS || envelope < 0.1 ? 'pass' : 'warn'
  else if (short === 'PH') status = grade(-cycles, -2, -1.5) ?? 'fail'
  else status = cycles >= 3 || envelope < 0.1 ? 'pass' : cycles >= 1.5 ? 'warn' : 'fail'
  if (severity === 'advisory' && status === 'fail') status = 'warn'
  return result(def0, KIND, status, `${fix(cycles, 2)} cycles, envelope ${pct(envelope, 0)} by the end`,
    short === 'SP' ? 'R ≥ 1.5 Td or the envelope below 10 %' : short === 'PH' ? 'pass ≥ 2 cycles; warn 1.5–2; fail < 1.5' : 'pass ≥ 3 cycles or the envelope below 10 %; warn 1.5–3; fail < 1.5',
    status === 'pass' ? '' : 'Record more cycles.', { severity })
}

function modePurity(ds: Dataset, mode: ModeId, det: InputDetection | null, rows: RowRange, fit: FitSummary | null): Check {
  const short = SHORT[mode]
  const def0 = d('mode-purity')
  const [r0, r1] = rows
  const time = ds.elapsed
  if (short === 'SP') {
    const v = firstChannel(ds, ['Vtrue,_ktas', '_Vind,_kias'])
    if (!v) return notCheckable(def0, KIND)
    const from = det ? det.end : r0
    const to = rowAtTime(ds, time[Math.min(ds.rowCount - 1, from)] + 3, from, ds.rowCount)
    const s = summary(v.values, from, to)
    const dv = s.n ? s.range / s.mean : NaN
    const td = fit?.ok ? fit.periodS : NaN
    const status: CheckStatus = dv <= 0.03 && (!Number.isFinite(td) || (td >= 1 && td <= 8)) ? 'pass' : 'warn'
    return result(def0, KIND, status, `speed change ${pct(dv)} in 3 s after the input${Number.isFinite(td) ? `, Td ${fix(td, 2)} s` : ''}`, 'speed change ≤ 3 % and 1 s ≤ Td ≤ 8 s', status === 'pass' ? '' : 'The response may hold more than the short period.')
  }
  if (short === 'PH') {
    const alpha = findChannel(ds, 'alpha,__deg')
    const v = findChannel(ds, 'Vtrue,_ktas')
    if (!alpha) return notCheckable(def0, KIND)
    const sa = summary(alpha.values, r0, r1).sd
    const td = fit?.ok ? fit.periodS : NaN
    const vMean = v ? summary(v.values, r0, r1).mean * 0.514444 : NaN
    const lanchester = (Math.PI * Math.SQRT2 * vMean) / 9.80665
    const ratio = td / lanchester
    const ok = sa <= 1 && (!Number.isFinite(td) || (td >= 15 && td <= 150)) && (!Number.isFinite(ratio) || (ratio >= 0.6 && ratio <= 1.6))
    return result(def0, KIND, ok ? 'pass' : 'warn', `σα ${fix(sa, 2)}°${Number.isFinite(td) ? `, Td ${fix(td, 1)} s` : ''}${Number.isFinite(ratio) ? `, ${fix(ratio, 2)} × Lanchester` : ''}`, 'σα ≤ 1°, 15 s ≤ Td ≤ 150 s and Td/T_Lanchester 0.6–1.6', ok ? '' : 'Check the window holds the phugoid only.')
  }
  if (short === 'DR') {
    const beta = findChannel(ds, '_beta,__deg')
    if (!beta || !fit?.ok) return notCheckable(def0, KIND, { needs: beta ? 'Needs a fit' : 'row {18}' })
    // Period from β's zero crossings about its trend.
    const tr = trend(beta.values, time, r0, r1)
    let crossings = 0
    let first = NaN
    let last = NaN
    let prev = NaN
    for (let i = r0; i < r1; i += 1) {
      const v = beta.values[i] - (tr.mean + tr.slope * (time[i] - (time[r0] + time[r1 - 1]) / 2))
      if (Number.isFinite(prev) && Math.sign(v) !== Math.sign(prev) && v !== 0) {
        crossings += 1
        if (!Number.isFinite(first)) first = time[i]
        last = time[i]
      }
      prev = v
    }
    const tdBeta = crossings >= 3 ? (2 * (last - first)) / (crossings - 1) : NaN
    const diff = Math.abs(tdBeta - fit.periodS) / fit.periodS
    const status: CheckStatus = diff <= 0.15 ? 'pass' : 'warn'
    return result(def0, KIND, status, `Td ${fix(fit.periodS, 2)} s vs ${fix(tdBeta, 2)} s from β`, 'Td from the window and from β agree within 15 %', status === 'pass' ? '' : 'Check the oscillation is the dutch roll.')
  }
  if (short === 'RS') {
    const beta = findChannel(ds, '_beta,__deg')
    if (!beta) return notCheckable(def0, KIND, { needs: 'row {18}' })
    const db = summary(beta.values, r0, r1).range
    const status: CheckStatus = db <= 3 ? 'pass' : 'warn'
    return result(def0, KIND, status, `sideslip change ${fix(db, 2)}°`, '|Δβ| ≤ 3° (almost pure rolling)', status === 'pass' ? '' : 'Keep the feet still: the roll should be almost pure rolling.')
  }
  const beta = findChannel(ds, '_beta,__deg')
  if (!beta) return notCheckable(def0, KIND, { needs: 'row {18}' })
  const mb = Math.abs(summary(beta.values, r0, r1).mean)
  const tau = fit?.ok && fit.model === 'first-order' ? Math.abs(fit.tau) : NaN
  const status: CheckStatus = mb <= 2 && (!Number.isFinite(tau) || tau >= 5) ? 'pass' : 'warn'
  return result(def0, KIND, status, `|mean β| ${fix(mb, 2)}°${Number.isFinite(tau) ? `, |τ| ${fix(tau, 1)} s` : ''}`, '|mean β| ≤ 2° and |τ| ≥ 5 s (a slow real root)', status === 'pass' ? '' : 'The response may not be the spiral alone.')
}

function weather(ds: Dataset, tir: [number, number], t: Thresholds): Check {
  const def0 = d('weather')
  const turb = findChannel(ds, '_turb,_locl')
  const wind = findChannel(ds, '_wind,knots')
  const vw = findChannel(ds, '_wind,v_fpm')
  if (!turb && !wind && !vw) return notCheckable(def0, KIND)
  const tb = turb ? summary(turb.values, tir[0], tir[1]).max : NaN
  const wr = wind ? summary(wind.values, tir[0], tir[1]).range : NaN
  const wv = vw ? maxAbs(vw.values, tir[0], tir[1]) : NaN
  const ok = !(tb > t.turbulence) && !(wr > t.windRangeKt) && !(wv > t.verticalWindFpm)
  return result(def0, KIND, ok ? 'pass' : 'warn', `turbulence ${fmt(tb, 2)}, wind range ${fmt(wr, 2)} kt, |vertical wind| ≤ ${fmt(wv, 2)} fpm`, 'turbulence ≤ 0.01, wind range ≤ 2 kt, |vertical wind| ≤ 50 fpm (never fails)', ok ? '' : 'Set calm weather for stability tests.')
}

function envelope(ds: Dataset, tir: [number, number], settings: DynamicSettings, t: Thresholds): Check {
  const def0 = d('envelope')
  const nz = findChannel(ds, 'Gload,norml')
  const alpha = findChannel(ds, 'alpha,__deg')
  const kias = findChannel(ds, '_Vind,_kias')
  const mach = findChannel(ds, '_Mach,ratio')
  const agl = findChannel(ds, '_gear,ftagl')
  if (!nz && !kias && !agl) return notCheckable(def0, KIND)
  const parts: string[] = []
  let status: CheckStatus = 'pass'
  const lim = settings.limits ?? {}
  if (nz) {
    const s = summary(nz.values, tir[0], tir[1])
    parts.push(`n_z ${fix(s.min, 2)} to ${fix(s.max, 2)} g`)
    if (s.min < 0 || s.max > 2) status = 'warn'
  }
  if (alpha && lim.alphaMaxDeg) {
    const s = summary(alpha.values, tir[0], tir[1])
    parts.push(`α ≤ ${fix(s.max, 1)}°`)
    if (s.max > lim.alphaMaxDeg) status = 'warn'
  }
  if (kias) {
    const s = summary(kias.values, tir[0], tir[1])
    parts.push(`${fix(s.min, 0)}–${fix(s.max, 0)} KIAS`)
    if ((lim.vsKias && s.min < 1.3 * lim.vsKias) || (lim.vmoKias && s.max > lim.vmoKias - 10)) status = 'warn'
  }
  if (mach && lim.mmo) {
    const s = summary(mach.values, tir[0], tir[1])
    parts.push(`M ≤ ${fix(s.max, 3)}`)
    if (s.max > lim.mmo - 0.02) status = 'warn'
  }
  if (agl) {
    const s = summary(agl.values, tir[0], tir[1])
    parts.push(`height ≥ ${fix(s.min, 0)} ft AGL`)
    if (s.min < t.heightAglFt) status = 'warn'
  }
  const limitsSet = Object.values(lim).some((v) => typeof v === 'number' && v > 0)
  if (!limitsSet) parts.push('speed limits not set')
  return result(def0, KIND, status, parts.join('; '), '0 ≤ n_z ≤ 2 g; α ≤ α_max; 1.3 V_S ≤ KIAS ≤ V_MO − 10; M ≤ M_MO − 0.02; ≥ 5,000 ft AGL (never fails)', status === 'pass' ? '' : 'Stay inside the stated test envelope.')
}

/** MIL-F-8785C Class III limits (Category B clean; C with flaps or gear down). */
function hqLevel(ds: Dataset, mode: ModeId, rows: RowRange, fit: FitSummary | null, config: ReturnType<typeof configuration>, settings: DynamicSettings): Check {
  const def0 = d('hq-level')
  const short = SHORT[mode]
  if (!fit || !fit.ok) return notCheckable(def0, KIND)
  const catC = config.surfaces.some((s) => Math.abs(s.mean) > 0.01) || (config.gear !== null && config.gear.mean > 0.01)
  const cat = catC ? 'C' : 'B'
  const label = settings.yawDamper === 'on' ? 'augmented' : 'X-Plane model, one condition, yaw damper off = failure state (bare airframe)'
  const lv = (ok1: boolean, ok2: boolean, ok3: boolean) => (ok1 ? 'Level 1' : ok2 ? 'Level 2' : ok3 ? 'Level 3' : 'worse than Level 3')
  let measured: string
  if (short === 'SP' && fit.model === 'oscillation') {
    const z = fit.zeta
    const [l1lo, l1hi] = cat === 'B' ? [0.3, 2.0] : [0.35, 1.3]
    const [l2lo, l2hi] = cat === 'B' ? [0.2, 2.0] : [0.25, 2.0]
    const damping = lv(z >= l1lo && z <= l1hi, z >= l2lo && z <= l2hi, z >= 0.15)
    // CAP = ωn² / (n/α), n/α from a least-squares fit of Δn_z on Δα (rad) over R.
    const nz = findChannel(ds, 'Gload,norml')
    const alpha = findChannel(ds, 'alpha,__deg')
    let cap = NaN
    if (nz && alpha) {
      const a = Array.from(alpha.values.subarray(rows[0], rows[1]), (v) => (v * Math.PI) / 180)
      const n = Array.from(nz.values.subarray(rows[0], rows[1]))
      const nAlpha = linearFit(a, n).c1
      cap = (fit.omegaN * fit.omegaN) / nAlpha
    }
    // MIL guide Figs 5 and 6 (pp.53–54): the lower boundary is "Levels 2 & 3", so a CAP below it is worse than Level 3;
    // above the Level 2 upper line (10) only Level 3 remains.
    const [c1lo, c1hi, c2lo, c2hi] = cat === 'B' ? [0.085, 3.6, 0.038, 10] : [0.16, 3.6, 0.096, 10]
    const capLevel = Number.isFinite(cap) && cap > 0 ? lv(cap >= c1lo && cap <= c1hi, cap >= c2lo && cap <= c2hi, cap >= c2lo) : 'CAP not computed'
    measured = `ζ ${fmt(z, 3)}: ${damping} (Table IV, Cat ${cat}); CAP ${fmt(cap, 3)}: ${capLevel}`
  } else if (short === 'PH' && fit.model === 'oscillation') {
    const t2 = fit.sigma < 0 ? -fit.halfLifeS : Infinity
    measured = `ζ ${fmt(fit.zeta, 3)}: ${lv(fit.zeta >= 0.04, fit.zeta >= 0, t2 >= 55)}`
  } else if (short === 'DR' && fit.model === 'oscillation') {
    const z = fit.zeta
    const zw = z * fit.omegaN
    const w = fit.omegaN
    const zw1 = cat === 'B' ? 0.15 : 0.1
    measured = `ζ ${fmt(z, 3)}, ζωn ${fmt(zw, 3)} rad/s, ωn ${fmt(w, 3)} rad/s: ${lv(z >= 0.08 && zw >= zw1 && w >= 0.4, z >= 0.02 && zw >= 0.05 && w >= 0.4, z >= 0 && w >= 0.4)} (Table VI, Cat ${cat}; footnotes on |φ/β| not applied)`
  } else if (short === 'RS' && fit.model === 'first-order') {
    const tr = fit.tau
    measured = `τ_R ${fmt(tr, 3)} s: ${tr > 0 ? lv(tr <= 1.4, tr <= 3.0, tr <= 10) : 'divergent'}`
  } else if (short === 'SPI' && fit.model === 'first-order') {
    if (fit.tau > 0) measured = 'stable spiral'
    else {
      const t2 = -fit.halfLifeS
      const l1 = cat === 'B' ? 20 : 12
      measured = `T2 ${fmt(t2, 3)} s: ${lv(t2 >= l1, t2 >= 8, t2 >= 4)} (Table VIII, Cat ${cat})`
    }
  } else {
    return notCheckable(def0, KIND, { needs: 'Needs the mode’s model (oscillation or first order)' })
  }
  return result(def0, KIND, 'info', `${measured} — ${label}`, 'report only (Class III)')
}
