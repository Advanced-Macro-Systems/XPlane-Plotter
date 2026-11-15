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
  leverChannels,
  segmentEnd,
  smoothInside,
  LEVER_ACTUAL,
  type ConfigurationState,
  type PitchSource,
} from './helpers'
import { MODE_NAMES } from './names'
import type { Check, CheckDef, CheckSeverity, CheckStatus, Verdict } from './types'

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
/** A number a published source gives (`source`: its key, and the test it is stated for when that is another test). */
const fromSource = (value: number, unit: string, source: string): Threshold => ({ value, unit, source, judgement: false })

/** The dynamic checklist's named tolerances (the run takes overrides by name). */
export const CHECK_THRESHOLDS = {
  // trim window T (its full length by mode) and the input look-back before R (by mode)
  tTrimSpS: ej(10, 's'),
  tTrimPhS: ej(15, 's'),
  tTrimDrS: ej(10, 's'),
  tTrimRsS: ej(3, 's'),
  tTrimSpiS: ej(15, 's'),
  /** A T this much shorter than its full length still counts as full */
  tSlackS: ej(0.25, 's'),
  lookbackSpS: ej(15, 's'),
  lookbackPhS: ej(90, 's'),
  lookbackDrS: ej(30, 's'),
  lookbackRsS: ej(20, 's'),
  lookbackSpiS: ej(60, 's'),
  // trimmed-start
  trimGapS: ej(0.5, 's'),
  tMinS: ej(5, 's'),
  tMinRollS: ej(2, 's'),
  /** The shortest settled T judged on its own; under it, the stretch from the end of the earlier input is judged */
  tJudgeS: ej(1, 's'),
  speedDriftKt: ej(2, 'kt', 'App src/core/analysis/steady.ts (speedTolKt)'),
  speedDriftRollKt: ej(3, 'kt'),
  vviMeanFpm: ej(200, 'fpm'),
  vviMeanRollFpm: ej(300, 'fpm'),
  vviSdFpm: ej(150, 'fpm'),
  rateDegS: ej(1, 'deg/s'),
  thetaSdDeg: ej(0.5, 'deg'),
  bankDeg: ej(3, 'deg'),
  bankWarnDeg: ej(5, 'deg', 'App src/core/analysis/steady.ts (bankTol)'),
  rollBankMinDeg: ej(20, 'deg'),
  rollBankPassDeg: ej(35, 'deg'),
  rollBankMaxDeg: fromSource(60, 'deg', 'NATO 15-6 (largest usual bank-to-bank start: the roll performance test, borrowed)'),
  rollBankSdDeg: ej(1.5, 'deg'),
  betaTrimDeg: ej(1, 'deg'),
  spiralYawRateDegS: ej(0.3, 'deg/s'),
  // hands-off-trim
  stickMedian: ej(0.03, 'ratio'),
  stickDev: ej(0.02, 'ratio'),
  // input detection
  inputStick: ej(0.02, 'ratio'),
  inputDeg: ej(0.3, 'deg'),
  /** A burst leaves the baseline (median) by more than this many noise σ (1.4826 × MAD), and at least the floor above */
  detectSigma: ej(5, 'σ'),
  /** The input's onset and end: where it crosses this share of its peak */
  onsetFraction: ej(0.1, 'of peak'),
  /** A lobe of the input: a same-sign run above this share of its peak */
  lobeFraction: ej(0.25, 'of peak'),
  /** Bursts closer than this are one input (phugoid: mergePhS) */
  mergeS: ej(1, 's'),
  mergePhS: ej(3, 's'),
  /** Another stick axis moved during the input when it left its baseline by more than this */
  otherAxisStick: ej(0.05, 'ratio'),
  inputGapS: ej(2, 's'),
  inputGapPhS: ej(5, 's'),
  inputOnsetS: ej(0.5, 's'),
  // input-shape
  pulseMaxS: fromSource(1, 's', 'Cook p.176'),
  stepMinS: ej(3, 's'),
  spMaxCycles: ej(2, 'cycles'),
  spDoubletMinTd: ej(0.6, 'Td'),
  spDoubletMaxTd: ej(1.4, 'Td'),
  areaRatioMin: ej(0.7, ''),
  areaRatioMax: ej(1.4, ''),
  phugoidHoldS: ej(3, 's'),
  drDoubletMinTd: ej(0.5, 'Td'),
  drDoubletMaxTd: ej(1.5, 'Td'),
  drCycleMinTd: ej(0.7, 'Td'),
  drCycleMaxTd: ej(1.3, 'Td'),
  rollHoldS: ej(2, 's'),
  rollHoldTau: ej(3, 'τ'),
  pedalMax: ej(0.03, 'ratio'),
  spiralStickBack: ej(0.03, 'ratio'),
  // input-size
  spAlphaMinDeg: ej(0.5, 'deg'),
  spAlphaMaxDeg: ej(5, 'deg'),
  spNzMaxG: ej(1, 'g'),
  phSpeedMin: ej(0.03, ''),
  phSpeedMax: ej(0.1, ''),
  drBetaMinDeg: ej(1, 'deg'),
  drBetaMaxDeg: ej(10, 'deg'),
  drBankMaxDeg: ej(15, 'deg'),
  spiralBankMinDeg: fromSource(5, 'deg', 'NATO 15-7'),
  spiralBankMaxDeg: fromSource(20, 'deg', 'NATO 15-7'),
  // sample-rate
  rateFastHz: { value: 20, unit: 'Hz', source: 'App guide.ts (20–25 /s for dynamic modes)', judgement: true },
  rateMinHz: { value: 10, unit: 'Hz', source: 'NATO 15-3, NATO 15-5', judgement: false },
  samplesPerPeriod: ej(20, 'samples'),
  samplesPerTau: ej(10, 'samples'),
  // power, augmentation, configuration, trim
  leverRange: ej(0.01, 'ratio'),
  n1Dev: ej(1.0, '%'),
  astabOff: ej(1e-4, 'ratio'),
  astabOn: ej(1e-3, 'ratio'),
  yawRateProofDegS: ej(0.5, 'deg/s'),
  configRange: ej(0.001, 'ratio'),
  configMean: ej(0.01, 'ratio'),
  trimRange: ej(0.002, 'ratio'),
  trimRangeWarn: ej(0.005, 'ratio'),
  // controls-fixed
  stickBand: ej(0.02, 'ratio'),
  stillFraction: ej(0.95, ''),
  stillMax: ej(0.05, 'ratio'),
  stillFractionWarn: ej(0.9, ''),
  stillMaxWarn: ej(0.1, 'ratio'),
  rollRiseS: ej(1, 's'),
  // window-start
  windowGapS: ej(1, 's'),
  windowGapPhS: ej(5, 's'),
  windowGapTd: ej(0.5, 'Td'),
  windowEarlyS: ej(0.2, 's'),
  windowOnsetS: ej(0.2, 's'),
  // record-length
  spRecordTd: ej(1.5, 'Td'),
  envelopeEnd: ej(0.1, ''),
  phCyclesPass: ej(2, 'cycles'),
  phCyclesMin: ej(1, 'cycles'),
  drCyclesPass: ej(3, 'cycles'),
  drCyclesMin: ej(1.5, 'cycles'),
  rsRecordTau: ej(4, 'τ'),
  spiralRecordS: ej(60, 's'),
  // fit-quality
  r2: ej(0.9, ''),
  zetaAgree: ej(0.03, ''),
  zetaAgreeRel: ej(0.25, ''),
  minPeaks: ej(3, 'peaks'),
  // mode-purity
  spSpeedChange: ej(0.03, ''),
  spSpeedWindowS: ej(3, 's'),
  spTdMinS: fromSource(1, 's', 'FD13 p.9 (lower end of the typical 1–4 s)'),
  spTdMaxS: ej(8, 's'),
  phAlphaSdDeg: ej(1, 'deg'),
  phTdMinS: fromSource(15, 's', 'FD13 p.13 (lower end of the typical 15–100 s)'),
  phTdMaxS: ej(150, 's'),
  lanchesterMin: ej(0.6, ''),
  lanchesterMax: ej(1.6, ''),
  drTdAgree: ej(0.15, ''),
  rsBetaRangeDeg: ej(3, 'deg'),
  spiralBetaDeg: ej(2, 'deg'),
  spiralTauMinS: ej(5, 's'),
  bankChangeDeg: ej(15, 'deg'),
  // weather
  turbulence: ej(0.01, 'ratio'),
  windRangeKt: ej(2, 'kt'),
  gustWindowS: ej(5, 's'),
  verticalWindFpm: ej(50, 'fpm'),
  // envelope
  nzMinG: ej(0, 'g'),
  nzMaxG: ej(2, 'g'),
  vsFactor: fromSource(1.3, '× V_S', 'NATO 13-5 (the usual approach speed, borrowed)'),
  vmoMarginKt: ej(10, 'kt'),
  mmoMargin: ej(0.02, ''),
  heightAglFt: ej(5000, 'ft'),
  // repeats
  repeatZetaRange: ej(0.05, ''),
  repeatTdRange: ej(0.1, ''),
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
  /** The channel the fit is on (ModesConfig.channelId): mode-purity compares the period with another channel's */
  channelId?: string
  /** Other same-mode test points with accepted fits (repeats); absent = not compared */
  repeats?: { name: string; periodS: number; zeta: number }[]
  /** Names of the other test points of this mode (their fits are not run here): listed on the repeats line */
  otherPoints?: string[]
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
  /** Each forcing cycle's period (s), from the centres of same-sign lobes two apart (three lobes or more) */
  periods: number[]
  channelId: string
  source: 'stick' | 'surface' | 'deg' | 'response' | 'override'
  variant: 'decay' | 'onset'
  /** Bursts found in the look-back (more than one: "several bursts") */
  bursts: number
  /** Other stick axes that moved in the look-back ("an input on an unexpected axis") */
  otherAxes: string[]
  /** It ends more than the mode's look-back before R (found by searching the continuous record before the look-back) */
  far: boolean
}

export interface TrimWindow {
  start: number
  end: number
  seconds: number
  /** What cut it below its full length: an earlier input, or the log start / a reset or gap */
  cut: 'input' | 'boundary' | null
  /** Cut by an earlier input, T starts where that input's free response had settled (not at the input's end) */
  settled?: boolean
  /** Cut by an earlier input: the first row after that input (before the response settled) */
  cutFrom?: number
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
    why: 'The flight model integrates in sim time, while real time keeps running through pauses, and a reset or gap inside a run breaks the fit. Preferring sim time and the gap rule (a forward step longer than max(1 s, 20 × the median step)) are this app’s own conventions: engineering judgement.',
    cite: ['App src/core/time.ts', 'App src/views/modes/modesModel.ts'], judgement: true, needs: 'row {1}',
  }),
  def({
    id: 'sample-rate', title: 'Sample rate fits the mode', severity: 'critical', scope: 'run', interval: 'TIR + fit',
    why: 'At least 10 samples/s are required when dynamic manoeuvres such as Dutch rolls are recorded (NATO 15-5; typically a minimum of 10, NATO 15-3), and the app applies that floor to every mode. The 20/s pass line is the app’s recording guide (20–25/s for dynamic modes); the samples-per-period and per-time-constant counts are engineering judgement and only warn.',
    cite: ['NATO 15-5', 'NATO 15-3', 'App src/core/channels/guide.ts'], judgement: true,
    sourced: 'fail < 10 samples/s: NATO 15-5 (dynamic manoeuvres such as Dutch rolls), NATO 15-3 (typically a minimum of 10)',
    needs: 'row {1}',
  }),
  def({
    id: 'autopilot-off', title: 'Autopilot off', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'Stability tests are open loop: the pilot makes the input but does not act as a feedback loop (NATO 15-4), and autopilot status is part of every test point (NATO 29-1). An autopilot loop raises the phugoid’s damping artificially (FD13 p.13) and attitude hold suppresses it (MIL p.48); treating every mode the same is engineering judgement. A servo can hold a value after a disconnect, so the evidence is whether each surface follows the stick or a moving servo; the app counts autopilot use only in the trim window before the input as a note, since the response itself was free. Tolerances are engineering judgement.',
    cite: ['NATO 15-4', 'NATO 29-1', 'NATO 29-2', 'FD13 p.13', 'MIL p.48', 'App dictionary.ts line 204'], judgement: true,
    needs: 'rows {8} and {11}; add {138} and {10} to tell pilot from autopilot',
  }),
  def({
    id: 'throttle-fixed', title: 'Autothrottle off, power fixed', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'Engine power must not be changed from the trim setting during the block (NATO 15-6); power changes during a phugoid add power damping (Cook p.177, FD12b p.32-33). A governed engine changes its power by itself at a fixed lever (Cook p.177), so the app lets the lever decide the fail and an N1 change alone warns, unless no lever is logged; the autothrottle mode code is read when row 117 is logged. Tolerances are engineering judgement.',
    cite: ['NATO 15-6', 'Cook p.177', 'FD12b p.32', 'FD12b p.33'], judgement: true, needs: 'row {25}; add {26} and {41}',
  }),
  def({
    id: 'yaw-damper-off', title: 'Yaw damper off', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'Yaw-rate feedback to the rudder is the classical yaw damper: it mostly damps the Dutch roll and also stabilises the spiral (Cook p.328; the lectures list the yaw damper with the Dutch roll, FD13 p.25), so it changes the modes measured. The sources only ask that SAS status is recorded (NATO 29-1), and MIL-F-8785C evaluates the aircraft with its augmentation (MIL p.16), losing it being a failure state (MIL p.152): requiring it off is this app’s bare-airframe choice (engineering judgement), and an augmented run can be declared in the settings instead. Roll subsidence is almost pure rolling (Cook p.211), so there it is only a note; the thresholds are engineering judgement.',
    cite: ['Cook p.328', 'FD13 p.25', 'NATO 29-1', 'NATO 29-2', 'MIL p.16', 'MIL p.152', 'Cook p.211'], judgement: true, needs: 'row {10}',
  }),
  def({
    id: 'other-augmentation', title: 'Roll and pitch augmentation off', severity: 'advisory', scope: 'run', interval: 'TIR',
    why: 'Record SAS status (NATO 29-1). Augmentation may change the modes or add new ones (MIL p.16), so the app prefers pitch and roll augmentation off: its choice, engineering judgement. A note only.',
    cite: ['NATO 29-1', 'NATO 29-2', 'MIL p.16'], judgement: true, needs: 'row {10}',
  }),
  def({
    id: 'configuration-constant', title: 'Configuration unchanged', severity: 'critical', scope: 'run', interval: 'TIR',
    why: 'Flaps and gear are recorded to establish the configuration (NATO 15-5); the test plan’s configurations include gear, flap and speedbrake position (NATO 8-4); a block of manoeuvres is flown at one test condition (NATO 15-6). The handling-qualities category follows the flight phase (Cook p.272, MIL p.17); the app labels flaps, slats or gear out as a Category C proxy, its choice. No source gives a number for “unchanged”: the 0.001 range tolerance is engineering judgement.',
    cite: ['NATO 15-5', 'NATO 8-4', 'NATO 15-6', 'Cook p.272', 'MIL p.17'], judgement: true,
    needs: 'row {13}; gear needs row {14}',
  }),
  def({
    id: 'trim-fixed', title: 'Trim not touched', severity: 'critical', scope: 'run', interval: 'I+R',
    why: 'No further control inputs follow the disturbance (NATO 15-6), and a large aircraft has only the controls-fixed response (Cook p.178); pitch trim position is one of the recorded parameters (NATO 15-5). Counting a trim movement as a control input, and the tolerances, are engineering judgement.',
    cite: ['NATO 15-6', 'Cook p.178', 'Cook p.177', 'NATO 15-5'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'trimmed-start', title: 'Trimmed and steady before the input', severity: 'critical', scope: 'run', interval: 'T',
    why: 'Every manoeuvre starts from a trimmed condition (NATO 15-6, Cook p.175-177, p.211-212), the spiral from wings-level, zero-yaw-rate trim (MIL p.99); stabilised data before a manoeuvre also serves as a tare (NATO 11-11, air-data chapter). Roll subsidence usually starts from a steady turn, to keep the bank excursion small (−30° in Cook’s illustration; Cook p.211 = FD12b p.37); NATO’s bank-to-bank roll, a roll performance test, usually starts from 30, 45 or 60° (NATO 15-6), so the app fails only a start steeper than 60°. With power fixed, speed is held by climb or descent (NATO 15-6), so a modest VVI is tolerated. Every other number is engineering judgement: the 20–35° roll pass band around Cook’s illustration, the speed line (the app’s steady-point default, 2 kt), the VVI line (twice its 100 fpm), the bank line (tighter than its 5°) and T (3–15 s by mode, shorter than its 20 s); the app counts a short T as a note.',
    cite: ['NATO 15-6', 'Cook p.175-177', 'Cook p.211-212', 'FD12b p.30', 'FD12b p.32', 'FD12b p.37', 'MIL p.99', 'NATO 11-11', 'App src/core/analysis/steady.ts'],
    judgement: true,
    sourced: 'roll start: a steady turn first is usual, −30° in the illustration (Cook p.211); fail above 60°: NATO 15-6’s largest usual bank-to-bank start (roll performance test, borrowed)',
    needs: 'rows {3}, {4}, {16} and {17}',
  }),
  def({
    id: 'hands-off-trim', title: 'Trimmed with trim, not held', severity: 'advisory', scope: 'run', interval: 'T',
    why: 'Hands-off trim is set with the trim tab, so the aircraft holds its trimmed condition with the controls free (Cook p.49); after the input the pilot releases the controls (Cook p.177 = FD12b p.31). In X-Plane a released spring-centred stick returns to centre, so the app reads a stick held off centre in the trim window as held, not trimmed: its reading, with tolerances that are engineering judgement. A note only.',
    cite: ['Cook p.49', 'Cook p.177', 'FD12b p.31', 'NATO 15-6'], judgement: true, needs: 'row {8}',
  }),
  def({
    id: 'input-detected', title: 'Input found', severity: 'critical', scope: 'run', interval: 'look-back before R',
    why: 'Each mode test is defined by an input applied from trim (NATO 15-5, NATO 15-6; Cook p.176-177, p.211-213). The app searches the continuous record before the window, back to the last power, configuration or trim change (its choice: a run does not span one): an input further back than its look-back (15–90 s by mode) is a note, and only no input at all fails. Detection levels, look-backs and that stop are engineering judgement.',
    cite: ['NATO 15-5', 'NATO 15-6', 'Cook p.176-177', 'Cook p.211-213', 'FD12b p.30-39'], judgement: true,
    needs: 'row {8}; fallback row {11}',
  }),
  def({
    id: 'input-shape', title: 'Input shape and duration suit the mode', severity: 'advisory', scope: 'run', interval: 'I',
    why: 'Short period: an elevator pulse of a second or less (Cook p.176 = FD12b p.30), short enough not to excite the phugoid (Cook p.176), or a doublet at the short-period frequency (NATO 15-6). Phugoid: elevator held until the speed has changed about 5 % (Cook p.177 = FD12b p.32), like a pulse of several seconds (Cook p.177). Dutch roll: a rudder doublet matched to the mode, in practice continuous cyclic pedalling at resonance, then release (Cook p.213 = FD12b p.39). Roll: a lateral step with no pedal (NATO 15-5), held a few seconds (about 4 s in the textbook example, Cook p.211 = FD12b p.36). Spiral: a small rudder step to about 20° of bank, then the rudder gently back to datum (Cook p.212 = FD12b p.38). The bands, and the short-period fail lines (a single lobe over 3 s, more than 2 cycles), are engineering judgement.',
    cite: ['Cook p.176', 'FD12b p.30', 'NATO 15-6', 'Cook p.177', 'FD12b p.32', 'Cook p.213', 'FD12b p.39', 'NATO 15-5', 'Cook p.211', 'FD12b p.36', 'Cook p.212', 'FD12b p.38'],
    judgement: true, sourced: 'short-period pulse ≤ 1 s: Cook p.176 (“a duration of a second or less”)', needs: 'row {8}',
  }),
  def({
    id: 'input-size', title: 'Response in the linear range and above noise', severity: 'advisory', scope: 'run', interval: 'I+R vs T',
    why: 'Inputs must be large enough relative to noise yet small enough to stay linear (NATO 15-13, parameter-identification inputs); the analysis assumes small perturbations (Cook p.177). Phugoid: about 5 % speed change (Cook p.177 = FD12b p.32); the 3–10 % pass band around it is engineering judgement. Roll: a steady turn first is usual, then through wings level (−30° to +30° in Cook’s illustration, Cook p.211 = FD12b p.37); NATO gives the roll mode no starting bank (NATO 15-5) and starts its bank-to-bank rolls usually from 30, 45 or 60° (NATO 15-6), so the app passes 20–60° and counts a wings-level start as a note. Spiral: a disturbance of 5–20° (NATO 15-7; up to 20°, MIL p.99). The other bands are engineering judgement, wide enough that the textbook’s recorded inputs pass (Cook p.176, p.214); a note only.',
    cite: ['NATO 15-13', 'Cook p.177', 'FD12b p.32', 'Cook p.211', 'FD12b p.37', 'NATO 15-5', 'NATO 15-6', 'NATO 15-7', 'MIL p.99', 'Cook p.176', 'Cook p.214'], judgement: true,
    sourced: 'spiral release 5–20°: NATO 15-7; phugoid speed change about 5 %: Cook p.177; roll start: a steady turn first is usual, −30° in the illustration (Cook p.211); 60° upper roll line: NATO 15-6 (largest usual bank-to-bank start, roll performance test, borrowed)',
    needs: 'rows {18}, {4}, {3} and {17}',
  }),
  def({
    id: 'controls-fixed', title: 'Hands and feet off during the response', severity: 'critical', scope: 'run', interval: 'R',
    why: 'The aircraft responds without further control inputs (NATO 15-6) and the tests are open loop (NATO 15-4); the other controls stay at their trim settings (Cook p.211, Cook p.213 = FD12b p.39) and the spiral is left to its own devices with the controls free (Cook p.212 = FD12b p.38, MIL p.99); after the input the pilot releases the controls (Cook p.177 = FD12b p.31), and a large aircraft is controls-fixed (Cook p.178). The app lets the mode’s own axes decide the fail, and another axis only warns, except a lateral or pedal movement over 0.10 in a longitudinal mode. In roll subsidence it lets the elevator hold the turn (a warn at most), though Cook keeps the other controls fixed; every tolerance is engineering judgement.',
    cite: ['NATO 15-6', 'NATO 15-4', 'Cook p.211', 'Cook p.213', 'FD12b p.39', 'Cook p.212', 'FD12b p.38', 'MIL p.99', 'Cook p.177', 'FD12b p.31', 'Cook p.178'], judgement: true,
    needs: 'row {8}',
  }),
  def({
    id: 'window-start', title: 'Window starts at the free response', severity: 'advisory', scope: 'run', interval: 'I.end to R.start',
    why: 'The free transient is the response after the forcing input has ceased (Cook p.213 = FD12b p.39); the spiral record starts when the rudder is back at datum (FD12b p.38). The lecture’s log-decrement example starts at the first peak of the free response (FD12b p.34), so the app accepts a start up to half a damped period after the input. Roll subsidence may instead be judged as the step response from its onset (NATO 15-5, Cook p.211). The timing tolerances are engineering judgement; a note only.',
    cite: ['Cook p.213', 'FD12b p.39', 'FD12b p.38', 'FD12b p.34', 'NATO 15-5', 'Cook p.211'], judgement: true, needs: 'Needs input-detected',
  }),
  def({
    id: 'record-length', title: 'Long enough to measure damping', severity: 'advisory', scope: 'run', interval: 'R',
    why: 'Damping is read from the decay over the chosen time section (FD12b p.34). The course’s own records hold about 1.6 phugoid cycles (Cook p.178), about 3 free Dutch-roll cycles (Cook p.214) and, in the lecture’s X-Plane example, 4 periods (FD12b p.34); the spiral is timed to double or half amplitude (NATO 15-7). The cycle and time limits are engineering judgement (the app’s fitter rejects under about 0.9 cycle); while the log runs on past the window, a short window is fixed in the analysis.',
    cite: ['FD12b p.34', 'Cook p.178', 'Cook p.214', 'NATO 15-7', 'App src/core/analysis/modes.ts'], judgement: true,
    sourced: 'spiral passes once |φ| doubles or halves: NATO 15-7 (the time to double or half amplitude)', needs: 'Needs a fit',
  }),
  def({
    id: 'fit-quality', title: 'Fit accepted and consistent', severity: 'analysis', scope: 'run', interval: 'R',
    why: 'The report gives damping and frequency from the time section used, for example by logarithmic decrement (FD12b p.34, FD13 p.33). A fit the app’s fitter rejects cannot support a number, and another window or trend fixes it without flying again (Fix the analysis). The R² and agreement bands are engineering judgement.',
    cite: ['FD12b p.34', 'FD13 p.33', 'App src/core/analysis/modes.ts'], judgement: true, needs: 'Needs a fit',
  }),
  def({
    id: 'mode-purity', title: 'Response looks like the intended mode', severity: 'advisory', scope: 'run', interval: 'R',
    why: 'Short period: α and q with virtually no change in speed, typically 1–4 s (FD13 p.9). Phugoid: speed-height exchange at nearly constant α, periods typically 15–100 s (FD13 p.11-13, NATO 15-5); Lanchester gives the order of the period (Cook p.160). The Dutch roll couples yaw, roll and sideslip, roll subsidence is almost pure rolling and the spiral is a slow real root (FD13 p.21-25). The app reads a bank change over 15° in a longitudinal mode as lateral motion in the response. The lower period lines are FD13’s typical values; the upper lines (8 s, 150 s), wider than the typical values (Cook p.255’s B-747 short period has a damped period of about 5.7 s), and the other bands are engineering judgement; a note only.',
    cite: ['FD13 p.9', 'Cook p.255', 'FD13 p.11-13', 'NATO 15-5', 'Cook p.160', 'FD13 p.21-25', 'MIL p.96'], judgement: true,
    sourced: 'typical short period 1–4 s (the 1 s lower line): FD13 p.9; typical phugoid 15–100 s (the 15 s lower line): FD13 p.13; Lanchester frequency ωp = g√2/V0 (period 2π/ωp = π√2·V/g): Cook p.160',
    needs: 'Needs rows {3}, {18} and {16}',
  }),
  def({
    id: 'weather', title: 'Calm air', severity: 'advisory', scope: 'run', interval: 'TIR',
    why: 'State the weather requirements for each block (NATO 8-3); weather affects the quality of a test (NATO 15-4); turbulence disturbs the trimmed equilibrium (FD12 p.7). The app judges turbulence and gusts (the wind about its running mean), so a steady change of wind with height does not count; that the fits do not model turbulence is its reasoning. Tolerances are engineering judgement; a note only.',
    cite: ['NATO 8-3', 'NATO 15-4', 'FD12 p.7'], judgement: true, needs: 'row {152}',
  }),
  def({
    id: 'envelope', title: 'Inside the test envelope', severity: 'advisory', scope: 'run', interval: 'TIR',
    why: 'The test plan states the test envelope and the source of its limits (NATO 8-3). The app’s default margins (0–2 g, 5,000 ft AGL, V_MO − 10 kt, M_MO − 0.02) are its own choice (engineering judgement), and its 1.3 V_S is borrowed from NATO’s usual approach speed (NATO 13-5). The speed limits are checked only once you set them.',
    cite: ['NATO 8-3', 'NATO 13-5'], judgement: true, sourced: '1.3 V_S: NATO 13-5 (the usual approach speed, borrowed)',
    needs: 'Needs rows {3}, {4}, {18} and {20}',
  }),
  def({
    id: 'weight-cg', title: 'Weight and CG', severity: 'info', scope: 'run', interval: 'I.start and R',
    why: 'Gross weight and CG position belong to each test point’s description (NATO 29-1) and the test loadings (NATO 8-3). The brief asks you to note and explain your assumptions in general (B p.4).',
    cite: ['NATO 29-1', 'NATO 8-3', 'B p.4'], judgement: false, needs: 'row {63}',
  }),
  def({
    id: 'repeats', title: 'Repeat consistency', severity: 'info', scope: 'run', interval: 'workspace',
    why: 'Several attempts may be needed to collect clear flight data (FD12b p.19), and consistent procedures make runs comparable (Cook p.175). Comparing similar measurements to check repeatability is NATO’s practice in performance testing (NATO 13-3), borrowed as an analogy. The app does not yet fit the other runs itself; its flag bands are engineering judgement.',
    cite: ['FD12b p.19', 'Cook p.175', 'NATO 13-3'], judgement: true, needs: 'Needs two or more test points of the mode with accepted fits',
  }),
  def({
    id: 'hq-level', title: 'Handling-qualities level (MIL-F-8785C)', severity: 'info', scope: 'run', interval: 'fit',
    why: 'Places the accepted result against MIL-F-8785C, which includes augmentation in the aircraft (MIL p.16), so a yaw-damper-off level describes a failure state (MIL p.152). Class III (large, heavy, low to medium manoeuvrability, Cook p.270) is assumed, and the category comes from the app’s configuration proxy (flaps, slats or gear out: C, else B), though the sources set it by flight phase (MIL p.17, Cook p.271-272). The app estimates n/α from the free response (engineering judgement).',
    cite: ['MIL p.51', 'MIL p.53-54', 'MIL p.47', 'Cook p.278', 'MIL p.96', 'Cook p.282', 'MIL p.99', 'Cook p.270-272', 'MIL p.16-17', 'Cook p.271', 'MIL p.152'], judgement: true,
    sourced: 'every level boundary: MIL p.51 Table IV and MIL p.53-54 Figs 5–6 (short period), Cook p.278 Table 10.5 and MIL p.47 (phugoid), MIL p.96 Table VI (Dutch roll), Cook p.282 Table 10.6 and its text (roll; the Level 3 10 s is MIL-F-8785C’s, quoted there), MIL p.99 Table VIII (spiral)',
    follows: 'MIL-F-8785C (MIL p.47, p.51, p.53-54, p.96, p.99) where Cook’s tables differ or give no chart',
    needs: 'Needs an accepted fit',
  }),
]

const DEF = new Map(DYNAMIC_DEFS.map((d) => [d.id, d]))
const d = (id: string): CheckDef => DEF.get(id) as CheckDef

/** A small tolerance as the criterion writes it: 1e−4 (typographic minus). */
const sci = (v: number): string => v.toExponential().replace('e+', 'e').replace('-', '−')

// ------------------------------------------------------------------ mode constants

/** The trim window T's full length by mode (CHECK_THRESHOLDS, engineering judgement) */
const T_TRIM_KEY: Readonly<Record<Short, DynamicThresholdName>> = { SP: 'tTrimSpS', PH: 'tTrimPhS', DR: 'tTrimDrS', RS: 'tTrimRsS', SPI: 'tTrimSpiS' }
/**
 * How far back before R an input counts as near, by mode (CHECK_THRESHOLDS, engineering judgement); the continuous
 * record before it is searched too, back to the last power, configuration or trim change.
 */
const LOOKBACK_KEY: Readonly<Record<Short, DynamicThresholdName>> = { SP: 'lookbackSpS', PH: 'lookbackPhS', DR: 'lookbackDrS', RS: 'lookbackRsS', SPI: 'lookbackSpiS' }

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

/** Baseline (median), noise (1.4826 × MAD) and threshold (`sigma` noise σ, at least `floor`) of a channel over rows [lo, hi). */
function level(values: ArrayLike<number>, lo: number, hi: number, floor: number, sigma: number): { base: number; noise: number; h: number } {
  const xs: number[] = []
  for (let i = lo; i < hi; i += 1) if (Number.isFinite(values[i])) xs.push(values[i])
  const base = median(xs)
  const noise = 1.4826 * median(xs.map((x) => Math.abs(x - base)))
  return { base, noise, h: Math.max(floor, sigma * (Number.isFinite(noise) ? noise : 0)) }
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

/** Onset and end of a burst at `fraction` (onsetFraction, 10 %) of its peak, interpolated in time; rows widened to that level. */
function refine(ds: Dataset, values: ArrayLike<number>, burst: Burst, base: number, lo: number, hi: number, fraction: number) {
  const limit = fraction * Math.abs(burst.peak)
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

/**
 * Lobes above `fraction` (lobeFraction, 25 %) of the peak (consecutive same-sign runs merged): their areas and centres
 * (area-weighted mean time), and the half-amplitude width.
 */
function lobes(ds: Dataset, values: ArrayLike<number>, a: number, b: number, base: number, peak: number, fraction: number) {
  const limit = fraction * Math.abs(peak)
  const found: { sign: number; area: number; moment: number }[] = []
  let halfWidth = 0
  for (let i = a; i < b; i += 1) {
    const v = values[i] - base
    const dt = i + 1 < b ? ds.elapsed[i + 1] - ds.elapsed[i] : 0
    if (Math.abs(v) >= 0.5 * Math.abs(peak)) halfWidth += dt
    if (!(Math.abs(v) > limit)) continue
    const sign = Math.sign(v)
    const w = Math.abs(v) * dt
    const last = found[found.length - 1]
    if (last && last.sign === sign) {
      last.area += w
      last.moment += w * ds.elapsed[i]
    } else found.push({ sign, area: w, moment: w * ds.elapsed[i] })
  }
  return { found: found.map((l) => ({ sign: l.sign, area: l.area, centre: l.area > 0 ? l.moment / l.area : NaN })), halfWidth }
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
  /** No input found: the power, configuration or trim change the search stopped at (null: it reached the record's start) */
  stop: Change | null
}

interface Change {
  /** The first row after the change */
  row: number
  what: 'the throttle moved' | 'the configuration changed' | 'the trim moved'
}

/**
 * The input before R: first within the mode's look-back; when none is there, in the continuous record before it, back
 * to the last power, configuration or trim change (the app does not let a run span one), with the look-back's own
 * baseline and threshold (a window chosen late in a long phugoid). `far` is set by the distance: an input ending more
 * than the look-back before R.
 */
function detectInput(ds: Dataset, mode: ModeId, rows: RowRange, settings: DynamicSettings | undefined, t: Thresholds): InputSearch {
  const short = SHORT[mode]
  const segLo = segmentStart(ds, rows[0])
  const lookback = rowAtTime(ds, ds.elapsed[rows[0]] - t[LOOKBACK_KEY[short]], segLo, rows[0])
  const near = searchInput(ds, mode, rows, settings, t, lookback, lookback, false)
  if (near.detection || !near.channel) return near
  const stop = lastChangeBefore(ds, rows[0], segLo, t)
  const lo = stop ? stop.row : segLo
  if (lo >= lookback) return { ...near, stop }
  const far = searchInput(ds, mode, rows, settings, t, lo, lookback, true)
  return far.detection ? far : { ...near, stop }
}

/**
 * The last change of power, configuration or trim before R, searched back from R's start to `lo`: a lever (or the
 * throttle reaching an engine), flap, slat, speedbrake, gear or trim channel that left its value at R's start by more
 * than its check's fail line (2 × leverRange, configRange, trimRangeWarn). Null when none did.
 */
function lastChangeBefore(ds: Dataset, r0: number, lo: number, t: Thresholds): Change | null {
  const tracked: { ch: Channel; tol: number; what: Change['what'] }[] = []
  for (const ch of [...leverChannels(ds), ...engineChannels(ds, LEVER_ACTUAL)]) tracked.push({ ch, tol: 2 * t.leverRange, what: 'the throttle moved' })
  for (const tokens of [['_flap,postn', '_flap,handl'], ['_slat,ratio'], ['sbrak,postn', 'sbrak,handl'], ['_gear,__0/1']]) {
    const ch = firstChannel(ds, tokens)
    if (ch) tracked.push({ ch, tol: t.configRange, what: 'the configuration changed' })
  }
  if (!findChannel(ds, '_gear,__0/1')) {
    for (const ch of ds.channels) if (ch.token === '_gear,__rat' && ch.stats.finite > 0) tracked.push({ ch, tol: t.configRange, what: 'the configuration changed' })
  }
  for (const tok of ['_trim,_elev', '_trim,ailrn', '_trim,ruddr']) {
    const ch = findChannel(ds, tok)
    if (ch) tracked.push({ ch, tol: t.trimRangeWarn, what: 'the trim moved' })
  }
  const live = tracked.filter((k) => Number.isFinite(k.ch.values[r0]))
  if (!live.length) return null
  for (let i = r0 - 1; i >= lo; i -= 1) {
    for (const k of live) if (Math.abs(k.ch.values[i] - k.ch.values[r0]) > k.tol) return { row: i + 1, what: k.what }
  }
  return null
}

/**
 * One pass of the input search: bursts over rows [lo, R's end) against the baseline and threshold of [levelLo, R's end)
 * (the look-back: a far pass reuses it, so a long record is never sorted). `far`: the pass before the look-back.
 */
function searchInput(ds: Dataset, mode: ModeId, rows: RowRange, settings: DynamicSettings | undefined, t: Thresholds, lo: number, levelLo: number, far: boolean): InputSearch {
  const short = SHORT[mode]
  const [r0, r1] = rows
  const lookbackS = t[LOOKBACK_KEY[short]]
  const mergeS = short === 'PH' ? t.mergePhS : t.mergeS
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
  if (!candidates.length) return { detection: null, earlierEnd: null, estimated: true, channel: null, axis: null, stop: null }

  for (const cand of candidates) {
    const { ch, axis, source, floor } = cand
    const { base, h } = level(ch.values, levelLo, r1, floor, t.detectSigma)
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
        return { detection: null, earlierEnd: null, estimated: false, channel: candidates[0].ch, axis: candidates[0].axis, stop: null }
      }
      continue
    }
    const index = found.indexOf(chosen)
    if (index > 0) earlierEnd = found[index - 1].b
    const refined = settings?.input
      ? { a: chosen.a, b: chosen.b, startT: ds.elapsed[chosen.a], endT: ds.elapsed[chosen.b - 1] }
      : refine(ds, ch.values, chosen, base, lo, r1, t.onsetFraction)
    const shapeData = lobes(ds, ch.values, refined.a, refined.b, base, chosen.peak, t.lobeFraction)
    const n = shapeData.found.length
    const duration = refined.endT - refined.startT
    const shape: InputDetection['shape'] = n >= 3 ? 'cyclic' : n === 2 ? 'doublet' : duration <= t.stepMinS ? 'pulse' : 'step'
    const areaRatio = n >= 2 && shapeData.found[1].area > 0 ? shapeData.found[0].area / shapeData.found[1].area : NaN
    const periods: number[] = []
    for (let k = 0; k + 2 < n; k += 1) periods.push(shapeData.found[k + 2].centre - shapeData.found[k].centre)
    // Other stick axes that moved during the input (each against its baseline over the look-back).
    const otherAxes: string[] = []
    for (const other of ['elev', 'ailrn', 'ruddr'] as Axis[]) {
      if (other === axis || INPUT_AXES[short].includes(other)) continue
      const stick = findChannel(ds, STICK[other])
      if (!stick) continue
      const lv = level(stick.values, levelLo, r1, t.inputStick, t.detectSigma)
      if (bursts(ds, stick.values, refined.a, Math.min(r1, refined.b), lv.base, Math.max(lv.h, t.otherAxisStick), mergeS).length) {
        otherAxes.push(AXIS_NAME[other])
      }
    }
    // Several bursts: in the look-back before R; for an input found further back, within the look-back before it.
    const counted = far
      ? found.filter((bu) => bu === chosen || (bu.b <= chosen.a && ds.elapsed[chosen.a] - ds.elapsed[bu.b - 1] <= lookbackS))
      : found.filter((bu) => ds.elapsed[bu.b - 1] <= ds.elapsed[r0] + 0.5 || bu === chosen)
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
        periods,
        channelId: ch.id,
        source: settings?.input ? 'override' : source,
        variant,
        bursts: counted.length,
        otherAxes,
        far: ds.elapsed[r0] - refined.endT > lookbackS,
      },
      earlierEnd,
      estimated: false,
      channel: ch,
      axis,
      stop: null,
    }
  }
  return { detection: null, earlierEnd: null, estimated: false, channel: candidates[0].ch, axis: candidates[0].axis, stop: null }
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
 * Without a control channel: the last time before R at which the mode's response left its earlier level by 5σ
 * (detectSigma, B2): q, else dθ/dt, for the short period and phugoid; β, else R, for the dutch roll; P, else dφ/dt, for
 * roll subsidence and the spiral. A rate, not an attitude: an attitude wanders by degrees in "trimmed" flight, so its
 * 5σ band can hold the whole response.
 */
function estimateFromResponse(ds: Dataset, mode: ModeId, rows: RowRange, t: Thresholds): number | null {
  const short = SHORT[mode]
  const [r0] = rows
  const lo = rowAtTime(ds, ds.elapsed[r0] - t[LOOKBACK_KEY[short]], segmentStart(ds, r0), r0)
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
  const { base, noise } = level(series, 0, third - lo, 0, t.detectSigma)
  const limit = t.detectSigma * Math.max(noise, 1e-6)
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

/** 1 / the median time step over rows [a, b): the rate the run was logged at (a dropout does not lower it); NaN under 10 steps. */
function medianRate(ds: Dataset, a: number, b: number): number {
  const steps: number[] = []
  for (let i = Math.max(1, a + 1); i < b; i += 1) {
    const dt = ds.elapsed[i] - ds.elapsed[i - 1]
    if (dt > 0) steps.push(dt)
  }
  return steps.length >= 10 ? 1 / median(steps) : NaN
}

/**
 * The app's Category C proxy (its choice: the sources set the category by flight phase, MIL p.17): flaps, slats or gear
 * out. The speedbrake does not count (MIL p.17 puts descent and emergency deceleration in Category B).
 */
function categoryC(cfg: ConfigurationState, limit: number): boolean {
  return cfg.surfaces.some((s) => s.name !== 'speedbrake' && Math.abs(s.mean) > limit) || (cfg.gear !== null && cfg.gear.mean > limit)
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
  /** A failed critical check's reason in this run's own words, where the default (DYNAMIC_REASON) would mislead */
  const reasons: Record<string, string> = {}
  const tTrim = t[T_TRIM_KEY[short]]
  const lookbackS = t[LOOKBACK_KEY[short]]

  // ---- input and trim windows
  const search = detectInput(ds, mode, rows, settings, t)
  const det = search.detection
  let estimatedStart: number | null = null
  if (search.estimated) estimatedStart = estimateFromResponse(ds, mode, rows, t)
  /** No control channel: I.start comes from the response, so T (and TIR) are only as good as that estimate. */
  const estimated = estimatedStart !== null
  const iStart = det ? det.start : estimatedStart
  const iStartT = det ? det.startT : estimatedStart !== null ? time[estimatedStart] : null
  let trimWin: TrimWindow | null = null
  if (iStartT !== null && iStart !== null) {
    const segLo = segmentStart(ds, iStart)
    const wantStart = iStartT - tTrim - t.trimGapS
    const endRow = rowAtTime(ds, iStartT - t.trimGapS, segLo, iStart + 1)
    let startRow = rowAtTime(ds, wantStart, segLo, endRow)
    let cut: TrimWindow['cut'] = null
    let settled = false
    let cutFrom: number | null = null
    if (search.earlierEnd !== null && search.earlierEnd > startRow) {
      startRow = Math.min(endRow, search.earlierEnd)
      cut = 'input'
      cutFrom = startRow
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
    const finalCut = seconds >= tTrim - t.tSlackS ? null : cut
    trimWin = {
      start: startRow,
      end: endRow,
      seconds,
      cut: finalCut,
      ...(settled ? { settled: true } : {}),
      ...(finalCut === 'input' && cutFrom !== null ? { cutFrom } : {}),
    }
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
        'pass: sim time (_totl,_time or missn,_time) with no reset or gap from T to R; warn: real time or another clock; fail: a reset (time steps back) or a gap (a forward step longer than max(1 s, 20 × the median step)) inside',
        status === 'fail' ? 'Choose a run inside one continuous stretch of sim time.' : status === 'warn' ? 'Log row 1 (Times) so sim time is the time axis.' : '',
      )
    }, tir[0]),
  )

  // ---- sample-rate: the rate the run itself was logged at (T to R), not the whole file's
  {
    const sr = sampleRate(ds, tir[0], tir[1])
    const runRate = medianRate(ds, tir[0], tir[1])
    const rate = Number.isFinite(runRate) ? runRate : Number.isFinite(ds.sampleRateHz) ? ds.sampleRateHz : sr.rate
    const fast = short === 'SP' || short === 'DR' || short === 'RS'
    let status: CheckStatus = !atLeast(rate, t.rateMinHz) ? 'fail' : fast && !atLeast(rate, t.rateFastHz) ? 'warn' : 'pass'
    let measured = `${fmt(rate, 3)} Hz${Number.isFinite(runRate) ? '' : ' (whole file: the run is too short to judge on its own)'}`
    if (fast && fit?.ok && fit.model === 'oscillation' && Number.isFinite(fit.periodS)) {
      const perPeriod = fit.periodS * rate
      measured += `, ${fmt(perPeriod, 3)} samples per period`
      status = worse(status, atLeast(perPeriod, t.samplesPerPeriod) ? 'pass' : 'warn')
    } else if (fast && fit?.ok && fit.model === 'first-order' && Number.isFinite(fit.tau)) {
      const perTau = Math.abs(fit.tau) * rate
      measured += `, ${fmt(perTau, 3)} samples per time constant`
      status = worse(status, atLeast(perTau, t.samplesPerTau) ? 'pass' : 'warn')
    }
    // A data floor: the fitter could not resolve a time constant shorter than the sample interval.
    if (fast && fit?.message?.includes('faster than the sample interval')) status = 'fail'
    if (sr.dropouts > 0) {
      measured += `, ${sr.dropouts} dropout${sr.dropouts === 1 ? '' : 's'}`
      status = worse(status, 'warn')
    }
    checks.push(
      result(
        d('sample-rate'), KIND, status, measured,
        fast
          ? `the rate from T to R: pass ≥ ${t.rateFastHz} Hz (the app’s recording guide) with ≥ ${t.samplesPerPeriod} samples per damped period (roll subsidence: ≥ ${t.samplesPerTau} per |τ|); warn ${t.rateMinHz}–${t.rateFastHz} Hz, fewer samples per period or per τ, or a dropout; fail < ${t.rateMinHz} Hz (NATO 15-5) or a mode faster than the sample interval`
          : `the rate from T to R: pass ≥ ${t.rateMinHz} Hz; warn: a dropout; fail < ${t.rateMinHz} Hz (NATO 15-5)`,
        status === 'pass' ? '' : 'Raise the Disk Rate (Data Output → Output rates) to 20–25 per second for dynamic modes.',
      ),
    )
  }

  // ---- autopilot-off (the shared rule, judged on this run's own spans: the surface follows a moving servo while the
  // stick is still). Without the ±30 s widening the static and performance checklists use: over the response R and from
  // the input to R's end, whole and every 2 s of them, the stick is still even on the axis the input was given on, so an
  // autopilot that took over after the input is found there (a fail); the trim window T is judged the same way, but an
  // autopilot only there (trimmed on it, disconnected before the input) is a warning; over TIR a surface that follows
  // the stick is the pilot.
  {
    const fdir = findChannel(ds, '_fdir,_mode')
    // No input found on the stick: the stretch searched before R (where the surfaces may have been moved without it).
    const lookback: [number, number] | null = det || estimated ? null : [rowAtTime(ds, time[r0] - lookbackS, segmentStart(ds, r0), r0), r0]
    const make = (a: number, b: number): Check => {
      const trim = a < r0 && trimWin && trimWin.end > trimWin.start ? trimWin : null
      const irFrom = Math.max(a, ir[0])
      const fdirRun = fdir ? summary(fdir.values, irFrom, b).max >= 2 : false
      const fdirTrim = fdir && trim ? summary(fdir.values, trim.start, trim.end).max >= 2 : false
      const spans = autopilotSpans(ds, trim, rows, [irFrom, b], lookback)
      const verdicts: { axis: Axis; text: string; source: PitchSource | 'no servo row'; trimOnly: boolean }[] = []
      let anyRow = false
      for (const axis of AXES) {
        const surf = findChannel(ds, SURF[axis])
        const stick = findChannel(ds, STICK[axis])
        if (!surf || !stick) continue
        anyRow = true
        if (!findChannel(ds, `${axis === 'elev' ? '_elev' : axis},servo`)) {
          verdicts.push({ axis, text: 'no servo row', source: 'no servo row', trimOnly: false })
          continue
        }
        verdicts.push({ axis, ...axisSource(ds, axis, spans, rows, [a, b]) })
      }
      if (!anyRow && !fdir) return notCheckable(d('autopilot-off'), KIND)
      const ap = verdicts.some((v) => v.source === 'autopilot' && !v.trimOnly)
      const apTrim = verdicts.some((v) => v.trimOnly)
      const pilot = verdicts.some((v) => v.source === 'pilot')
      const status: CheckStatus = fdirRun || ap ? 'fail' : fdirTrim || apTrim ? 'warn' : pilot ? 'pass' : 'warn'
      const measured = [
        ...verdicts.map((v) => `${AXIS_NAME[v.axis]}: ${v.text}`),
        ...(fdir ? [`_fdir,_mode ${fdirRun ? '= 2 (autopilot) during the run' : fdirTrim ? '= 2 (autopilot) before the input' : '< 2'}`] : []),
      ].join('; ')
      return result(
        d('autopilot-off'), KIND, status, measured,
        'pass: a surface follows the stick (R² ≥ 0.9) and none follows a moving servo; fail: a surface follows a moving servo (R² ≥ 0.9, servo range ≥ 0.005) while the stick is still (range ≤ 0.02) from the input to the end of R, or over the look-back before R when no input was found (each whole or any 2 s of it), or _fdir,_mode = 2 from the input (without one, in R); warn: the same only in the trim window T before the input (trimmed on the autopilot, disconnected before the input), or inconclusive',
        status === 'fail'
          ? 'Disconnect the autopilot before the input and fly the run again.'
          : apTrim || fdirTrim
            ? 'Trimmed on the autopilot: the response was free, but check the disconnect left the aircraft trimmed and steady (trimmed-start).'
            : status === 'warn'
              ? 'Inconclusive: log rows 8, 11 and 138 (servos), or fly a calibration (autopilot on, then off).'
              : '',
      )
    }
    checks.push(guarded(make, tir[0]))
  }

  // ---- throttle-fixed: the lever decides; N1 alone (the power can change at a fixed lever) only when no lever is logged
  {
    const levers = leverChannels(ds)
    const actual = engineChannels(ds, LEVER_ACTUAL)
    const n1 = engineChannels(ds, (k) => `N1__${k},_pcnt`)
    const atCode = findChannel(ds, '_auto,throt')
    const haveLever = levers.length > 0 || actual.length > 0
    // Without a lever, N1 decides: a fail then means the power changed, not that the throttle was seen to move.
    if (!haveLever) reasons['throttle-fixed'] = 'the power changed'
    if (!haveLever && !n1.length) checks.push(notCheckable(d('throttle-fixed'), KIND))
    else {
      const make = (a: number, b: number): Check => {
        // N1 is measured from its mean over T (over the rows themselves when T is not part of them).
        const ps = powerSteadiness(ds, a, b, a < r0 && trimWin ? [trimWin.start, trimWin.end] : undefined)
        const lever = Math.max(Number.isFinite(ps.leverRange) ? ps.leverRange : 0, Number.isFinite(ps.actualRange) ? ps.actualRange : 0)
        const n1Status = !n1.length || !Number.isFinite(ps.n1Deviation)
          ? null
          : haveLever ? (ps.n1Deviation <= t.n1Dev ? 'pass' : 'warn') : grade(ps.n1Deviation, t.n1Dev, 2 * t.n1Dev)
        const at = atCode ? summary(atCode.values, a, b) : null
        const atOn = at !== null && at.n > 0 && (at.max !== 0 || at.min !== 0)
        const status = worse(haveLever ? grade(lever, t.leverRange, 2 * t.leverRange) : null, n1Status, atOn ? 'warn' : null)
        return result(
          d('throttle-fixed'), KIND, status,
          [
            haveLever ? `lever range ${fmt(lever, 2)}` : '',
            n1.length ? `N1 within ${fix(ps.n1Deviation, 2)} %pt of trim` : '',
            at ? `autothrottle mode code ${atOn ? `${fmt(at.max === 0 ? at.min : at.max, 3)} (not 0)` : '0'}` : '',
          ]
            .filter(Boolean)
            .join('; '),
          `pass: lever range ≤ ${t.leverRange}; warn ≤ ${2 * t.leverRange}; fail beyond. N1 within ${t.n1Dev} %pt of its trim mean, else warn (with no lever logged: warn ≤ ${2 * t.n1Dev} %pt, fail beyond). Autothrottle mode code (row 117) not 0: warn`,
          status === 'pass' ? '' : 'Keep the throttles at the trim setting through the input and response (autothrottle off).',
        )
      }
      checks.push(guarded(make, tir[0]))
    }
  }

  // ---- yaw-damper-off: critical for the dutch roll and spiral (Cook p.328), a note for roll subsidence, info otherwise
  {
    const astab = findChannel(ds, 'ruddr,astab')
    const severity: CheckSeverity = short === 'DR' || short === 'SPI' ? 'critical' : short === 'RS' ? 'advisory' : 'info'
    if (!astab) checks.push(notCheckable(d('yaw-damper-off'), KIND, { severity }))
    else {
      const a = maxAbs(astab.values, tir[0], tir[1])
      const rCh = findChannel(ds, '____R,deg/s')
      const r = rCh ? maxAbs(rCh.values, r0, r1) : NaN
      const declared = settings.yawDamper === 'on'
      let status: CheckStatus
      // A run declared augmented in the settings passes as such: the run is then labelled "augmented".
      if (declared) status = 'pass'
      else if (a > t.astabOn) status = 'fail'
      else if (a > t.astabOff || !(r >= t.yawRateProofDegS)) status = 'warn'
      else status = 'pass'
      if (severity === 'info' && status !== 'pass') status = 'info'
      const off = `|ruddr,astab| ≤ ${sci(t.astabOff)} with |R| ≥ ${t.yawRateProofDegS} deg/s`
      checks.push(
        result(
          d('yaw-damper-off'), KIND, status,
          `max |ruddr,astab| ${fmt(a, 2)}; max |R| ${fmt(r, 2)} deg/s${declared ? '; declared augmented run (passes as augmented)' : ''}`,
          severity === 'critical'
            ? `pass: ${off}, or a run declared augmented in the settings (reported as augmented); warn: unproven (|R| < ${t.yawRateProofDegS}) or ≤ ${sci(t.astabOn)}; fail > ${sci(t.astabOn)}`
            : severity === 'advisory'
              ? `roll subsidence (a note, never fails): pass ${off}, or a declared augmented run; warn otherwise`
              : 'information only for the short period and phugoid',
          !declared && a > t.astabOff && severity !== 'info'
            ? 'Switch the yaw damper off for a bare-airframe run, or declare an augmented run in the settings (it is then reported as augmented).'
            : '',
          { severity },
        ),
      )
    }
  }

  // ---- other-augmentation: pitch and roll augmentation, both rows
  {
    const chs = ['_elev,astab', 'ailrn,astab'].map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
    if (!chs.length) checks.push(notCheckable(d('other-augmentation'), KIND))
    else {
      const values = chs.map((ch) => maxAbs(ch.values, tir[0], tir[1]))
      const status: CheckStatus = values.every((v) => !(v > t.astabOff)) ? 'pass' : 'warn'
      checks.push(
        result(
          d('other-augmentation'), KIND, status, chs.map((ch, k) => `max |${ch.token}| ${fmt(values[k], 2)}`).join('; '),
          `pass: |_elev,astab| and |ailrn,astab| ≤ ${sci(t.astabOff)} from T to R; warn above (a note, never fails)`,
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
        return result(
          d('configuration-constant'), KIND, status,
          `${configText(cfg, t.configRange)}; ${categoryC(cfg, t.configMean) ? 'Category C proxy (flaps, slats or gear out)' : 'Category B proxy (flaps, slats and gear in)'}`,
          `pass: every range ≤ ${t.configRange} (engineering judgement); warn: gear not logged; fail: any range above that (it moved)`,
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
          d('trim-fixed'), KIND, status, `largest trim range ${fmt(worst, 2)}`, `pass ≤ ${t.trimRange}; warn ≤ ${t.trimRangeWarn}; fail above (pilot trim, autotrim or speed trim)`,
          status === 'fail' ? 'Leave the trim alone after the input; switch off autotrim or speed trim.' : '',
        )
      }
      checks.push(guarded(make, ir[0]))
    }
  }

  // ---- trimmed-start
  {
    const ts = trimmedStart(ds, mode, trimWin, iStart !== null, t, estimatedStart !== null ? time[estimatedStart] : null)
    checks.push(ts.check)
    if (ts.reason) reasons['trimmed-start'] = ts.reason
  }

  // ---- hands-off-trim (advisory: a note, never a fail)
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
        status = worse(status, heldInTurn || !(Math.abs(med) > t.stickMedian) ? 'pass' : 'warn', !(dev > t.stickDev) ? 'pass' : 'warn')
        parts.push(`${AXIS_NAME[ax]} median ${signed(med, 3)}, deviation ${fmt(dev, 2)}`)
      }
      checks.push(
        result(
          d('hands-off-trim'), KIND, status, parts.join('; '),
          `pass: |median stick| ≤ ${t.stickMedian} and deviation from it ≤ ${t.stickDev} on each axis over T (roll subsidence: pitch and lateral may be held in the turn); warn beyond (a note, never fails)`,
          status === 'pass' ? '' : 'Trim the aircraft so it holds the condition with the stick centred and still.',
        ),
      )
    }
  }

  // ---- input-detected: the continuous record before R is searched, back to the last power, configuration or trim
  // change; only no input at all fails
  {
    const gapLimit = short === 'PH' ? t.inputGapPhS : t.inputGapS
    const criterion = `pass: one burst on the mode’s axis ending ≤ ${gapLimit} s before the window (roll subsidence: or the window starts within ${t.inputOnsetS} s of the step onset); warn: a later one (beyond the app’s ${lookbackS} s look-back included), a window starting during the input (other modes than roll subsidence), several bursts, or another axis moved; fail: no input in the continuous record before the window, searched back to the last power, configuration or trim change`
    if (!search.channel) {
      checks.push(
        notCheckable(d('input-detected'), KIND, {
          needs: `row {8}; fallback row {11}${estimatedStart !== null ? ` (input estimated from the response at ${fix(time[estimatedStart], 1)} s)` : ''}`,
        }),
      )
      if (estimatedStart !== null) notes.push('Input estimated from the response: no control channel is logged.')
    } else if (!det) {
      const where = search.stop ? `after ${search.stop.what} at ${fix(time[search.stop.row], 1)} s` : 'in the continuous record before the window'
      checks.push(
        result(d('input-detected'), KIND, 'fail', `no input on ${search.channel.token} ${where}`, criterion,
          `Choose the window that follows an input on the mode’s axis (Time history → Select)${search.stop ? ': a run does not span a power, configuration or trim change' : ''}.`),
      )
    } else {
      const gap = det.variant === 'onset' ? Math.abs(time[r0] - det.startT) : time[r0] - det.endT
      const limit = det.variant === 'onset' ? t.inputOnsetS : gapLimit
      let status: CheckStatus = gap <= limit ? 'pass' : 'warn'
      const duringInput = det.variant === 'onset' && short !== 'RS'
      if (duringInput) status = 'warn'
      if (det.bursts > 1 || det.otherAxes.length) status = worse(status, 'warn')
      const late = det.variant !== 'onset' && gap > limit
      checks.push(
        result(
          d('input-detected'), KIND, status,
          `${det.shape} on ${det.channelId} at ${fix(det.startT, 1)}–${fix(det.endT, 1)} s (${fix(det.duration, 2)} s, peak ${signed(det.peak, 3)}), ${det.variant === 'onset' ? 'window starts at its onset' : `ends ${fix(gap, 1)} s before the window${det.far ? ` (beyond the ${lookbackS} s look-back)` : ''}`}${det.bursts > 1 ? `; ${det.bursts} bursts` : ''}${det.otherAxes.length ? `; also ${det.otherAxes.join(', ')}` : ''}`,
          criterion,
          status === 'pass'
            ? ''
            : late
              ? 'Move the window nearer the input: the first cycles after it carry the largest response.'
              : duringInput
                ? 'Start the window after the input has ended: only roll subsidence is judged from the step onset.'
                : 'Use one clean input on the mode’s axis only, then hands off.',
        ),
      )
    }
  }

  // ---- input-shape
  checks.push(inputShape(ds, mode, det, fit, rows, t))

  // ---- input-size
  checks.push(inputSize(ds, mode, det, trimWin, rows, t))

  // ---- controls-fixed
  checks.push(controlsFixed(ds, mode, rows, t, det))

  // ---- window-start (advisory): up to half a damped period after the input, the first peak of the free response
  {
    if (!det) checks.push(notCheckable(d('window-start'), KIND))
    else {
      const onsetRs = det.variant === 'onset' && short === 'RS'
      const gap = onsetRs ? time[r0] - det.startT : time[r0] - det.endT
      const td = fit?.ok && fit.model === 'oscillation' && Number.isFinite(fit.periodS) ? fit.periodS : NaN
      const base = short === 'PH' ? t.windowGapPhS : t.windowGapS
      const maxGap = Number.isFinite(td) ? Math.max(base, t.windowGapTd * td) : base
      const early = gap < -t.windowEarlyS
      const status: CheckStatus = onsetRs ? (Math.abs(gap) <= t.windowOnsetS ? 'pass' : 'warn') : early ? 'warn' : gap <= maxGap ? 'pass' : 'warn'
      checks.push(
        result(
          d('window-start'), KIND, status,
          onsetRs ? `window starts ${fix(gap, 2)} s from the step onset` : early ? `the window starts ${fix(-gap, 2)} s before the input ends (it holds the forced input)` : `window starts ${fix(gap, 2)} s after the input ends`,
          onsetRs
            ? `roll subsidence from the step onset (the step response): pass |gap| ≤ ${t.windowOnsetS} s from the step edge; warn otherwise (a note, never fails)`
            : `pass −${t.windowEarlyS} s ≤ gap ≤ ${fix(maxGap, 2)} s after the input ends (${Number.isFinite(td) ? `${t.windowGapTd} × the damped period, at least ${base} s: the first peak of the free response` : `${base} s without an accepted oscillation fit`}); warn later, or when the window holds the forced input (gap < −${t.windowEarlyS} s); a note, never fails`,
          status === 'pass' ? '' : early ? 'Start the window after the input has ended: fit the free response.' : 'Start the window sooner after the input ends (at the first peak of the free response).',
        ),
      )
    }
  }

  // ---- record-length
  checks.push(recordLength(ds, mode, rows, fit, t))

  // ---- fit-quality (analysis: another window or trend fixes a rejected fit)
  {
    const criterion = `pass: accepted, R² ≥ ${t.r2} and (oscillation) |ζ − ζ_logdec| ≤ max(${t.zetaAgree}, ${t.zetaAgreeRel}ζ) with ≥ ${t.minPeaks} peaks; warn: R² < ${t.r2}, disagreement, fewer peaks or any fit note (few cycles, fair fit, heavy damping, solver not converged); fail: rejected by the app’s fitter (Fix the analysis)`
    if (!fit) checks.push(notCheckable(d('fit-quality'), KIND))
    else if (!fit.ok) {
      checks.push(result(d('fit-quality'), KIND, 'fail', fit.message ? `fit rejected: ${fit.message}` : 'fit rejected', criterion, 'Choose another window or trend: start after the input, include enough cycles.'))
    } else {
      let status: CheckStatus = fit.r2 >= t.r2 ? 'pass' : 'warn'
      let measured = `R² ${fix(fit.r2, 3)}`
      if (fit.model === 'oscillation') {
        const agree = Math.abs(fit.zeta - fit.zetaLogDec) <= Math.max(t.zetaAgree, t.zetaAgreeRel * Math.abs(fit.zeta))
        measured += `, ζ ${fmt(fit.zeta, 3)} vs log decrement ${fmt(fit.zetaLogDec, 3)}, ${fit.peaks} peaks`
        if (!Number.isFinite(fit.zetaLogDec) || !agree || fit.peaks < t.minPeaks) status = worse(status, 'warn')
      }
      if (fit.message) {
        measured += `; note: ${fit.message}`
        status = worse(status, 'warn')
      }
      checks.push(result(d('fit-quality'), KIND, status, measured, criterion, status === 'pass' ? '' : 'Check the window: start, length and trend setting.'))
    }
  }

  // ---- mode-purity
  const fittedToken = input.channelId ? (findChannel(ds, input.channelId)?.token ?? null) : null
  checks.push(modePurity(ds, mode, det, rows, fit, t, fittedToken))

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

  // ---- repeats: compared when the caller passes the other runs' fits; otherwise listed for the student to compare
  {
    const reps = input.repeats?.filter((r) => Number.isFinite(r.zeta) && Number.isFinite(r.periodS)) ?? []
    if (reps.length >= 2) {
      const zs = reps.map((r) => r.zeta)
      const ts = reps.map((r) => r.periodS)
      const zr = Math.max(...zs) - Math.min(...zs)
      const tm = ts.reduce((s, v) => s + v, 0) / ts.length
      const tr = (Math.max(...ts) - Math.min(...ts)) / tm
      checks.push(
        result(d('repeats'), KIND, 'info', `${reps.length} points: ζ range ${fmt(zr, 2)}, Td range ${pct(tr, 0)}${zr > t.repeatZetaRange || tr > t.repeatTdRange ? ' (flagged)' : ''}`,
          `report only; flag a ζ range > ${t.repeatZetaRange} or a Td range > ${pct(t.repeatTdRange, 0)}`),
      )
    } else if (input.repeats) checks.push(notCheckable(d('repeats'), KIND))
    else {
      const others = input.otherPoints ?? []
      checks.push(
        result(
          d('repeats'), KIND, 'info',
          others.length ? `other ${MODE_NAMES[mode].toLowerCase()} test points: ${others.join(', ')}` : `no other ${MODE_NAMES[mode].toLowerCase()} test point`,
          'Compare your repeat runs yourself: the app does not compare them yet',
          others.length ? 'Fit each of them in Dynamic modes and compare ζ and the period.' : '',
        ),
      )
    }
  }

  // ---- hq-level
  checks.push(hqLevel(ds, mode, rows, fit, config, settings, t))

  // ---- verdict
  const label = settings.yawDamper === 'on' ? 'augmented' : 'X-Plane model, one condition, yaw damper off = failure state (bare airframe)'
  const verdict = dynamicVerdict(checks, { estimated, reasons })
  for (const c of checks) {
    if (c.status === 'warn' && c.severity !== 'info') notes.push(`${c.title}: ${c.measured}`)
  }
  return { mode, checks, verdict, notes, input: det, trim: trimWin, label, estimatedInput: estimatedStart !== null ? time[estimatedStart] : null }
}

const AXES: readonly Axis[] = ['elev', 'ailrn', 'ruddr']

interface Span {
  /** R: the response; IR: the input to R's end; L: the look-back searched without an input; T: the trim window */
  where: 'T' | 'R' | 'IR' | 'L'
  a: number
  b: number
}

/**
 * The spans autopilot-off judges: R, the input to R's end (rows [ir0, ir1)), the look-back searched before R without an
 * input on the stick (`lookback`) and the trim window T, each whole and every `block` seconds of it (2 s, or 20 samples
 * at low sample rates; stepped by half a block), so an autopilot that held a surface for part of a span is not averaged
 * away.
 */
function autopilotSpans(ds: Dataset, trim: TrimWindow | null, rows: RowRange, ir: [number, number], lookback: [number, number] | null = null): Span[] {
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
  add('R', rows[0], rows[1])
  if (ir[0] < rows[0]) add('IR', ir[0], ir[1])
  if (lookback) add('L', lookback[0], lookback[1])
  if (trim && trim.end > trim.start) add('T', trim.start, trim.end)
  return out
}

/**
 * Who moved one axis's surface (the shared rule, pitchControlSource, without widening): 'autopilot' as soon as a span
 * from the input on (or the look-back) shows the surface following a moving servo while the stick was still; the same
 * only in the trim window T is 'autopilot' with `trimOnly` (trimmed on it, disconnected before the input); otherwise
 * its verdict over TIR ('pilot' when the surface follows the stick there: the input moved it).
 */
function axisSource(ds: Dataset, axis: Axis, spans: readonly Span[], rows: RowRange, tir: [number, number]): { source: PitchSource; text: string; trimOnly: boolean } {
  const time = ds.elapsed
  const at = (span: Span) => `${fix(time[span.a], 1)}–${fix(time[span.b - 1], 1)} s`
  let inTrim: Span | null = null
  for (const span of spans) {
    if (span.where === 'T' && inTrim) continue
    if (pitchControlSource(ds, span.a, span.b, axis, 0)?.source !== 'autopilot') continue
    if (span.where === 'T') {
      inTrim = span
      continue
    }
    const where = span.where === 'L' ? 'before the window' : span.a >= rows[0] ? 'during the response' : 'between the input and the window'
    return { source: 'autopilot', trimOnly: false, text: `autopilot ${where}, ${at(span)} (the surface followed the moving servo, stick still)` }
  }
  if (inTrim) {
    return { source: 'autopilot', trimOnly: true, text: `autopilot before the input, ${at(inTrim)} (trimmed on the autopilot, disconnected before the input)` }
  }
  const source = pitchControlSource(ds, tir[0], tir[1], axis, 0)?.source ?? 'unknown'
  return { source, text: source, trimOnly: false }
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
  'record-length': 'too few cycles recorded (the log ends)',
}

/** What a failed analysis check asks for, in the verdict's words ("Fix the analysis — …"). */
export const DYNAMIC_ANALYSIS_REASON: Readonly<Record<string, string>> = {
  'fit-quality': 'the fit was rejected: try another window or trend',
  'record-length': 'too few cycles in the window: widen it, the log runs on past it',
}

/**
 * The run's verdict, worst first: "Retest required" (a critical check failed), "Cannot confirm" (a critical or analysis
 * check could not be made), "Fix the analysis" (an analysis check failed: another window or trend fixes it), else
 * "Acceptable for analysis (N notes)". With `estimated` (no control channel: the input was estimated from the response)
 * a "Cannot confirm" says so; the checks that depend on the estimate never fail critically (they are capped at warn).
 * `reasons` gives a failed check's reason in the run's own words where DYNAMIC_REASON would mislead (throttle-fixed
 * judged on N1 alone: "the power changed"; trimmed-start failed on its roll-start bank).
 */
export function dynamicVerdict(checks: readonly Check[], options: { estimated?: boolean; reasons?: Readonly<Record<string, string>> } = {}): Verdict {
  const failed = checks.filter((c) => c.severity === 'critical' && c.status === 'fail')
  const reason = (c: Check) => options.reasons?.[c.id] ?? DYNAMIC_REASON[c.id] ?? c.title.toLowerCase()
  if (failed.length) return { kind: 'retest', text: `Retest required — ${failed.map(reason).join('; ')}` }
  const na = checks.filter((c) => (c.severity === 'critical' || c.severity === 'analysis') && c.status === 'not-checkable')
  if (na.length) {
    const rows = rowsFromNotCheckable(na)
    return {
      kind: 'cannot-confirm',
      text: `Cannot confirm — ${rows.length ? `tick rows ${rows.join(', ')}` : na.map((c) => c.title.toLowerCase()).join('; ')}${options.estimated ? '; the input was estimated from the response' : ''}`,
    }
  }
  const analysis = checks.filter((c) => c.severity === 'analysis' && c.status === 'fail')
  if (analysis.length) {
    return { kind: 'fix-analysis', text: `Fix the analysis — ${analysis.map((c) => DYNAMIC_ANALYSIS_REASON[c.id] ?? c.title.toLowerCase()).join('; ')}` }
  }
  const notes = checks.filter((c) => c.status === 'warn' && c.severity !== 'info').length
  return { kind: 'acceptable', text: `Acceptable for analysis (${notes} note${notes === 1 ? '' : 's'})` }
}

// ------------------------------------------------------------------ individual checks

/**
 * trimmed-start over T. `estimatedAt` (s): no control channel, so the input, and T before it, were estimated from the
 * response; the result is labelled so and never fails (capped at warn): the estimate, not the flight, may be wrong.
 * A T cut short by an earlier input is a note; its steadiness decides (under tJudgeS of settled flight, the stretch from
 * the end of that input is judged instead, so a response still going at the input fails on its rates). `reason`: the
 * verdict's words when the roll-start bank line fails the check.
 */
function trimmedStart(ds: Dataset, mode: ModeId, trimWin: TrimWindow | null, haveInput: boolean, t: Thresholds, estimatedAt: number | null): { check: Check; reason?: string } {
  const short = SHORT[mode]
  const def0 = d('trimmed-start')
  if (!haveInput || !trimWin) return { check: notCheckable(def0, KIND, { needs: 'Needs the input (the trim window T ends 0.5 s before it)' }) }
  const tMin = short === 'RS' ? t.tMinRollS : t.tMinS
  const tTrim = t[T_TRIM_KEY[short]]
  const cutShort = trimWin.cut === 'input' && trimWin.seconds < tMin
  if (trimWin.seconds < tMin && !cutShort) {
    return { check: notCheckable(def0, KIND, { needs: `Not checkable — T reaches the log start or a reset or gap (${fix(trimWin.seconds, 1)} s)` }) }
  }
  const time = ds.elapsed
  const unsettled = cutShort && trimWin.seconds < t.tJudgeS && trimWin.cutFrom !== undefined
  const a = unsettled ? (trimWin.cutFrom as number) : trimWin.start
  const b = trimWin.end
  const speed = firstChannel(ds, ['_Vind,_kias', '_Vind,_keas', 'Vtrue,_ktas'])
  const vvi = findChannel(ds, '__VVI,__fpm')
  const r = findChannel(ds, '____R,deg/s')
  const theta = findChannel(ds, 'pitch,__deg')
  const phi = findChannel(ds, '_roll,__deg')
  const beta = findChannel(ds, '_beta,__deg')
  if (!speed && !vvi && !phi) return { check: notCheckable(def0, KIND) }
  const parts: string[] = []
  /** Everything but the roll-start bank line (bankStatus), so the verdict can say which one failed */
  let status: CheckStatus = trimWin.seconds >= tTrim - t.tSlackS ? 'pass' : 'warn'
  let bankStatus: CheckStatus = 'pass'
  if (estimatedAt !== null) parts.push(`input estimated from the response at ${fix(estimatedAt, 1)} s`)
  parts.push(
    cutShort
      ? `T only ${fix(trimWin.seconds, 1)} s: an earlier input or its response was still in progress${unsettled ? ` (judged from the end of that input, ${fix(b > a ? time[b - 1] - time[a] : 0, 1)} s)` : ''}`
      : `T ${fix(trimWin.seconds, 1)} s${trimWin.settled ? ' (from where the previous input’s response settled)' : ''}`,
  )
  const two = (value: number, limit: number) => grade(Math.abs(value), limit, 2 * limit)
  const rs = short === 'RS'
  let hint = cutShort ? 'Wait for the previous transient to die out, then trim before the input.' : 'Trim and let the aircraft settle before the input.'
  if (speed) {
    const tr = trend(speed.values, time, a, b)
    const drift = Math.abs(tr.slope * tr.seconds)
    const scatter = 2 * tr.residualSd
    status = worse(status, two(drift, rs ? t.speedDriftRollKt : t.speedDriftKt), rs ? null : two(scatter, t.speedDriftKt))
    parts.push(`speed drift ${fix(drift, 2)} kt, 2σ ${fix(scatter, 2)} kt`)
  }
  if (vvi) {
    const s = summary(vvi.values, a, b)
    status = worse(status, two(s.mean, rs ? t.vviMeanRollFpm : t.vviMeanFpm), rs ? null : two(s.sd, t.vviSdFpm))
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
      // Cook p.211 (= FD12b p.37): a steady turn first is usual (it keeps the bank excursion small; −30° in its
      // illustration), not required, so a start from wings level is a note; NATO 15-6's bank-to-bank rolls (the roll
      // performance test) usually start from 30, 45 or 60°, so a start up to 60° is a note too and only a steeper one
      // fails. Steadiness stays critical.
      const bank = Math.abs(s.mean)
      bankStatus = bank >= t.rollBankMinDeg && bank <= t.rollBankPassDeg ? 'pass' : bank <= t.rollBankMaxDeg ? 'warn' : 'fail'
      status = worse(status, two(s.sd, t.rollBankSdDeg))
      parts.push(`bank ${fix(s.mean, 1)} ± ${fix(s.sd, 1)}°${bank < 15 ? ' (from wings level: a steady turn first is usual, 30° in Cook’s illustration, to limit the bank excursion)' : ''}`)
      if (bank < t.rollBankMinDeg) hint = 'Let the aircraft settle before the step; a steady turn first is usual (30° in Cook’s illustration, Cook p.211): it keeps the bank excursion small.'
      else if (bank > t.rollBankPassDeg) hint = 'Start the roll from a steady turn (30° in Cook’s illustration, Cook p.211); NATO’s usual bank-to-bank starts are 30, 45 or 60° (a roll performance test).'
    } else {
      const bank = Math.abs(s.mean)
      status = worse(status, bank <= t.bankDeg ? 'pass' : bank <= t.bankWarnDeg ? 'warn' : 'fail')
      parts.push(`bank ${fix(s.mean, 1)}°`)
    }
  }
  if (short === 'DR' && beta) {
    const s = summary(beta.values, a, b)
    status = worse(status, two(Math.abs(s.mean), t.betaTrimDeg))
    parts.push(`|β| ${fix(Math.abs(s.mean), 2)}°`)
  }
  if (short === 'SPI' && r) {
    const s = summary(r.values, a, b)
    status = worse(status, two(Math.abs(s.mean), t.spiralYawRateDegS))
    parts.push(`mean R ${fix(s.mean, 2)} deg/s`)
  }
  const steady = status
  status = worse(status, bankStatus)
  if (estimatedAt !== null && status === 'fail') {
    // The trim window sits where the estimate put it: not proof that the flight was unsteady.
    status = 'warn'
    hint = 'The input was estimated from the response (no control channel logged), so T may be misplaced: log row 8 (Joystick) to place it.'
  }
  const shortT = `a shorter T warns; under ${tMin} s at the log start or a gap it is not checkable; cut by an earlier input, its steadiness decides, judged from that input’s end when under ${t.tJudgeS} s has settled`
  const check = result(
    def0, KIND, status, parts.join('; '),
    (rs
      ? `steady turn (usual, Cook p.211): T ≥ ${tTrim} s (${shortT}); ${t.rollBankMinDeg}–${t.rollBankPassDeg}° bank with σ ≤ ${t.rollBankSdDeg}°, |P| ≤ ${t.rateDegS} deg/s, drift ≤ ${t.speedDriftRollKt} kt, |VVI| ≤ ${t.vviMeanRollFpm} fpm; warn within twice those, below ${t.rollBankMinDeg}° of bank (wings level included) or at ${t.rollBankPassDeg}–${t.rollBankMaxDeg}°; fail beyond twice or a bank over ${t.rollBankMaxDeg}°`
      : `T ≥ ${tTrim} s (${shortT}); drift and 2σ ≤ ${t.speedDriftKt} kt; |VVI| ≤ ${t.vviMeanFpm} fpm (σ ≤ ${t.vviSdFpm}); rates ≤ ${t.rateDegS} deg/s; σθ ≤ ${t.thetaSdDeg}°; |φ| ≤ ${t.bankDeg}° (warn ≤ ${t.bankWarnDeg}°)${short === 'DR' ? `; |β| ≤ ${t.betaTrimDeg}°` : ''}${short === 'SPI' ? `; |mean R| ≤ ${t.spiralYawRateDegS} deg/s` : ''}; warn within twice; fail beyond`) +
      (estimatedAt !== null ? '; with the input estimated from the response, never worse than warn' : ''),
    status === 'pass' ? '' : hint,
  )
  if (status !== 'fail' || bankStatus !== 'fail') return { check }
  const bankReason = `the roll started from more than ${t.rollBankMaxDeg}° of bank`
  return { check, reason: steady === 'fail' ? `${DYNAMIC_REASON['trimmed-start']}; ${bankReason}` : bankReason }
}

function inputShape(ds: Dataset, mode: ModeId, det: InputDetection | null, fit: FitSummary | null, rows: RowRange, t: Thresholds): Check {
  const short = SHORT[mode]
  const def0 = d('input-shape')
  if (!det) return notCheckable(def0, KIND, { needs: 'Needs input-detected' })
  const td = fit?.ok && fit.model === 'oscillation' ? fit.periodS : NaN
  let status: CheckStatus = 'pass'
  let severity: Check['severity'] = 'advisory'
  let measured = `${det.shape}, ${fix(det.duration, 2)} s`
  let criterion: string
  if (short === 'SP') {
    // The edges are interpolated at the onset fraction of the peak, which lengthens a sampled pulse by up to about one
    // sample interval: that much is allowed, so a pulse of exactly Cook's second still passes.
    const rate = medianRate(ds, Math.max(0, det.start - 10), Math.min(ds.rowCount, det.end + 10))
    const hz = Number.isFinite(rate) ? rate : ds.sampleRateHz
    const dt = Number.isFinite(hz) && hz > 0 ? 1 / hz : 0
    criterion = `pass: a pulse ≤ ${t.pulseMaxS} s long from its ${pct(t.onsetFraction, 0)}-of-peak onset to its end (Cook p.176), one sample interval (${fix(dt, 2)} s) allowed for the interpolated edges, or a doublet ${t.spDoubletMinTd}–${t.spDoubletMaxTd} × Td with lobe areas ${t.areaRatioMin}–${t.areaRatioMax}; warn: a longer pulse up to ${t.stepMinS} s, another doublet or 3–${2 * t.spMaxCycles} lobes; fail (critical, engineering judgement): a single lobe longer than ${t.stepMinS} s (a step) or more than ${t.spMaxCycles} cycles`
    if (det.shape === 'step' || (det.shape === 'cyclic' && det.cycles > t.spMaxCycles)) {
      status = 'fail'
      severity = 'critical'
    } else if (det.shape === 'pulse') {
      status = det.duration <= t.pulseMaxS + dt ? 'pass' : 'warn'
    } else if (det.shape === 'doublet' || det.shape === 'cyclic') {
      if (det.shape === 'cyclic') severity = 'critical'
      const ratio = det.duration / td
      measured += `, ${Number.isFinite(ratio) ? `${fix(ratio, 2)} × Td` : 'Td unknown'}, lobe areas ${fix(det.areaRatio, 2)}`
      const inBand = ratio >= t.spDoubletMinTd && ratio <= t.spDoubletMaxTd && det.areaRatio >= t.areaRatioMin && det.areaRatio <= t.areaRatioMax
      status = det.shape === 'doublet' && inBand ? 'pass' : 'warn'
    }
  } else if (short === 'PH') {
    criterion = `pass: one held lobe ≥ ${t.phugoidHoldS} s (the 5 % speed change is judged in input-size); warn: a pulse or doublet shorter than that`
    status = det.lobes === 1 && det.duration >= t.phugoidHoldS ? 'pass' : 'warn'
  } else if (short === 'DR') {
    criterion = `pass: a doublet ${t.drDoubletMinTd}–${t.drDoubletMaxTd} × Td, or cyclic pedalling (any number of cycles) with each forcing cycle ${t.drCycleMinTd}–${t.drCycleMaxTd} × Td, then release; warn otherwise`
    if (det.shape === 'doublet') {
      const ratio = det.duration / td
      measured += Number.isFinite(ratio) ? `, ${fix(ratio, 2)} × Td` : ', Td unknown'
      status = ratio >= t.drDoubletMinTd && ratio <= t.drDoubletMaxTd ? 'pass' : 'warn'
    } else if (det.shape === 'cyclic') {
      const ratios = det.periods.map((p) => p / td)
      const ok = ratios.length > 0 && ratios.every((x) => x >= t.drCycleMinTd && x <= t.drCycleMaxTd)
      measured += Number.isFinite(td) && ratios.length
        ? `, ${fix(det.cycles, 1)} forcing cycles, each ${fix(Math.min(...ratios), 2)}–${fix(Math.max(...ratios), 2)} × Td`
        : ', Td unknown'
      status = ok ? 'pass' : 'warn'
    } else status = 'warn'
  } else if (short === 'RS') {
    criterion = `pass: a lateral step held ≥ max(${t.rollHoldS} s, ${t.rollHoldTau}|τ|) with pedal change ≤ ${t.pedalMax}; warn: a shorter hold or pedal used`
    const tau = fit?.model === 'first-order' && fit.ok ? Math.abs(fit.tau) : NaN
    const need = Math.max(t.rollHoldS, Number.isFinite(tau) ? t.rollHoldTau * tau : t.rollHoldS)
    const pedal = findChannel(ds, 'ruddr,stick')
    const pedalChange = pedal ? summary(pedal.values, det.start, det.end).range : 0
    measured += `, held ${fix(det.duration, 2)} s (needs ${fix(need, 1)} s)${pedal ? `, pedal change ${fmt(pedalChange, 2)}` : ''}`
    status = det.duration >= need && pedalChange <= t.pedalMax ? 'pass' : 'warn'
  } else {
    criterion = `pass: an entry, then every control back at its baseline (± ${t.spiralStickBack}) before the window; warn otherwise`
    const sticks = ['_elev,stick', 'ailrn,stick', 'ruddr,stick'].map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
    const pre = det.start > 0 ? det.start - 1 : det.start
    const back = sticks.every((c) => Math.abs(c.values[rows[0]] - c.values[pre]) <= t.spiralStickBack)
    measured += back ? ', controls back at baseline' : ', controls not back at baseline'
    status = back ? 'pass' : 'warn'
  }
  return result(def0, KIND, status, measured, criterion, status === 'pass' ? '' : 'Use the input the lectures give for this mode.', { severity })
}

/** input-size (advisory: a note, never a fail): pass bands wide enough that the textbook's recorded inputs pass. */
function inputSize(ds: Dataset, mode: ModeId, det: InputDetection | null, trimWin: TrimWindow | null, rows: RowRange, t: Thresholds): Check {
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
    if (alpha) status = worse(status, da >= t.spAlphaMinDeg && da <= t.spAlphaMaxDeg ? 'pass' : 'warn')
    if (nz) status = worse(status, !(dn > t.spNzMaxG) && !(nzMin < 0) ? 'pass' : 'warn')
    return result(def0, KIND, status, `peak |Δα| ${fix(da, 2)}°, peak |Δn_z| ${fix(dn, 2)} g, min n_z ${fix(nzMin, 2)} g`,
      `pass ${t.spAlphaMinDeg}° ≤ peak |Δα| ≤ ${t.spAlphaMaxDeg}° and peak |Δn_z| ≤ ${t.spNzMaxG} g with n_z above 0; warn otherwise (a note, never fails)`,
      status === 'pass' ? '' : 'Size the input so the response stays small and linear.')
  }
  if (short === 'PH') {
    const v = firstChannel(ds, ['Vtrue,_ktas', '_Vind,_kias'])
    if (!v) return notCheckable(def0, KIND, { needs: 'row {3}' })
    const vt = summary(v.values, ref[0], ref[1]).mean
    const at = det ? Math.min(ds.rowCount - 1, det.end) : r0
    const dv = Math.abs(v.values[at] - vt) / vt
    const status: CheckStatus = dv >= t.phSpeedMin && dv <= t.phSpeedMax ? 'pass' : 'warn'
    return result(def0, KIND, status, `|ΔV|/V ${pct(dv)} at the input’s end`,
      `pass ${pct(t.phSpeedMin, 0)} ≤ |ΔV|/V ≤ ${pct(t.phSpeedMax, 0)} (around Cook’s 5 %); warn otherwise (a note, never fails)`,
      status === 'pass' ? '' : 'Hold the elevator until the speed has changed about 5 %.')
  }
  if (short === 'DR') {
    const beta = findChannel(ds, '_beta,__deg')
    const phi = findChannel(ds, '_roll,__deg')
    if (!beta) return notCheckable(def0, KIND, { needs: 'row {18}' })
    const db = peakDev(beta, from, r1)
    const ph = phi ? maxAbs(phi.values, from, r1) : NaN
    let status: CheckStatus = db >= t.drBetaMinDeg && db <= t.drBetaMaxDeg ? 'pass' : 'warn'
    if (phi) status = worse(status, !(ph > t.drBankMaxDeg) ? 'pass' : 'warn')
    return result(def0, KIND, status, `peak |Δβ| ${fix(db, 2)}°, max |φ| ${fix(ph, 1)}°`,
      `pass ${t.drBetaMinDeg}° ≤ peak |Δβ| ≤ ${t.drBetaMaxDeg}° with |φ| ≤ ${t.drBankMaxDeg}°; warn otherwise (a note, never fails)`,
      status === 'pass' ? '' : 'Size the rudder input for a few degrees of sideslip.')
  }
  const phi = findChannel(ds, '_roll,__deg')
  if (!phi) return notCheckable(def0, KIND, { needs: 'row {17}' })
  if (short === 'RS') {
    const start = phi.values[det ? det.start : r0]
    const end = phi.values[Math.min(ds.rowCount - 1, det ? det.end : r0)]
    const a = Math.abs(start)
    // A steady turn first, then through wings level to the other side, is the textbook technique (Cook p.211: usual, not
    // required; −30° to +30° in its illustration); NATO's bank-to-bank rolls usually start from 30, 45 or 60° (NATO
    // 15-6, the roll performance test), so 20–60° passes and a start from wings level is a note.
    let status: CheckStatus = a >= t.rollBankMinDeg && a <= t.rollBankMaxDeg ? 'pass' : 'warn'
    if (status === 'pass' && !(Math.sign(end) === -Math.sign(start))) status = 'warn'
    return result(def0, KIND, status, `bank ${fix(start, 1)}° at the input, ${fix(end, 1)}° at its end${a < 10 ? ' (from wings level)' : ''}`,
      `pass: from ${t.rollBankMinDeg}–${t.rollBankMaxDeg}° of bank to the opposite side; warn below ${t.rollBankMinDeg}° (a start from wings level included: the steady turn is usual, not required), above ${t.rollBankMaxDeg}° or not reaching the other side (a note, never fails)`,
      status === 'pass' ? '' : 'Roll from a steady turn through wings level (the usual technique; 30° in Cook’s illustration), so the bank excursion stays small.')
  }
  const bank = Math.abs(phi.values[rows[0]])
  const status: CheckStatus = bank >= t.spiralBankMinDeg && bank <= t.spiralBankMaxDeg ? 'pass' : 'warn'
  return result(def0, KIND, status, `|φ| ${fix(bank, 1)}° at release`,
    `pass ${t.spiralBankMinDeg}–${t.spiralBankMaxDeg}° at release (NATO 15-7); warn otherwise (a note, never fails)`, status === 'pass' ? '' : `Release at ${t.spiralBankMinDeg}–${t.spiralBankMaxDeg}° of bank.`)
}

function controlsFixed(ds: Dataset, mode: ModeId, rows: RowRange, t: Thresholds, det: InputDetection | null): Check {
  const short = SHORT[mode]
  const def0 = d('controls-fixed')
  const [r0, r1] = rows
  const time = ds.elapsed
  const longitudinal = short === 'SP' || short === 'PH'
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
      // The held level: the median over R. The rise to it may take up to rollRiseS after R starts (samples still
      // rising after that count as movement).
      const xs: number[] = []
      for (let i = r0; i < r1; i += 1) if (Number.isFinite(ch.values[i])) xs.push(ch.values[i])
      v0 = median(xs)
      const riseEnd = rowAtTime(ds, time[r0] + t.rollRiseS, r0, r1)
      while (from < riseEnd && !(Math.abs(ch.values[from] - v0) <= t.stickBand)) from += 1
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
      if (dv <= t.stickBand) within += 1
      dmax = Math.max(dmax, dv)
    }
    const f = n ? within / n : NaN
    parts.push(`${AXIS_NAME[ax]}${held} ${pct(f, 0)} still, max ${fmt(dmax, 2)}`)
    const axisStatus: CheckStatus = f >= t.stillFraction && dmax <= t.stillMax ? 'pass' : f >= t.stillFractionWarn && dmax <= t.stillMaxWarn ? 'warn' : 'fail'
    if (primary) status = worse(status, axisStatus)
    else if (longitudinal && dmax > t.stillMaxWarn) status = 'fail'
    else status = worse(status, axisStatus === 'pass' ? 'pass' : 'warn')
  }
  const own = longitudinal ? 'pitch' : short === 'RS' ? 'roll and yaw' : 'pitch, roll and yaw'
  return result(def0, KIND, status, parts.join('; '),
    `the mode’s own axes (${own}): pass ≥ ${pct(t.stillFraction, 0)} of samples within ${t.stickBand} of the start and max change ≤ ${t.stillMax}; warn ≥ ${pct(t.stillFractionWarn, 0)} and ≤ ${t.stillMaxWarn}; fail beyond. Other axes: at most warn${longitudinal ? `, except a lateral or pedal change > ${t.stillMaxWarn} (fail)` : short === 'RS' ? ' (the elevator may hold the turn)' : ''}${onset ? `; roll onset: the lateral stick against its held value once the step has risen (within ${t.rollRiseS} s)` : ''}`,
    status === 'pass' ? '' : onset ? 'Hold the lateral step constant and keep the pedals and elevator still through the window.' : 'Hands and feet off (or fixed) for the whole response window.')
}

/**
 * record-length. The phugoid and dutch roll are judged on cycles (critical); a fail there is an analysis fix (widen the
 * window) while the continuous record runs on past R for at least the missing time, and a retest when it ends. A
 * rejected fit with fewer cycles than the minimum (the fitter's own count) is judged the same way; any other rejected fit
 * is fit-quality's to report, so this line is then not checkable without blocking the verdict. The short period, roll
 * subsidence and spiral are advisory (a note, never a fail).
 */
function recordLength(ds: Dataset, mode: ModeId, rows: RowRange, fit: FitSummary | null, t: Thresholds): Check {
  const short = SHORT[mode]
  const def0 = d('record-length')
  const time = ds.elapsed
  const cyclesMode = short === 'PH' || short === 'DR'
  const len = time[rows[1] - 1] - time[rows[0]]
  const end = segmentEnd(ds, rows[1] - 1)
  const restS = end > rows[1] ? time[end - 1] - time[rows[1] - 1] : 0
  if (short === 'SPI') {
    const phi = findChannel(ds, '_roll,__deg')
    if (!phi) return notCheckable(def0, KIND, { needs: 'row {17}' })
    const start = Math.abs(phi.values[rows[0]])
    const s = summary(phi.values, rows[0], rows[1])
    const doubled = Math.max(Math.abs(s.max), Math.abs(s.min)) >= 2 * start || Math.abs(phi.values[rows[1] - 1]) <= 0.5 * start
    const status: CheckStatus = doubled || len >= t.spiralRecordS ? 'pass' : 'warn'
    return result(def0, KIND, status, `${fix(len, 1)} s; bank ${doubled ? 'doubled or halved' : 'neither doubled nor halved'}`,
      `pass: |φ| doubles or halves within R (NATO 15-7), or R ≥ ${t.spiralRecordS} s; warn otherwise (a note, never fails)`,
      status === 'pass' ? '' : 'Record longer: until the bank doubles or halves.')
  }
  if (!fit) return notCheckable(def0, KIND, { severity: cyclesMode ? 'critical' : 'advisory' })
  const [pass, min] = short === 'PH' ? [t.phCyclesPass, t.phCyclesMin] : [t.drCyclesPass, t.drCyclesMin]
  const tooFew = cyclesMode && fit.model === 'oscillation' && fit.cycles < min && fit.periodS > 0
  if (!fit.ok && !tooFew) return notCheckable(def0, KIND, { severity: 'advisory', needs: 'Needs an accepted fit (see fit-quality)' })
  if (fit.model === 'first-order') {
    const ratio = len / Math.abs(fit.tau)
    const status: CheckStatus = ratio >= t.rsRecordTau ? 'pass' : 'warn'
    return result(def0, KIND, status, `R = ${fix(ratio, 1)} |τ|`, `pass R ≥ ${t.rsRecordTau}|τ|; warn shorter (a note, never fails)`,
      status === 'pass' ? '' : 'Lengthen the window to four time constants.', { severity: 'advisory' })
  }
  const cycles = fit.cycles
  const envelope = Math.exp(-fit.sigma * len)
  if (!cyclesMode) {
    const status: CheckStatus = len >= t.spRecordTd * fit.periodS || envelope < t.envelopeEnd ? 'pass' : 'warn'
    return result(def0, KIND, status, `${fix(cycles, 2)} cycles, envelope ${pct(envelope, 0)} by the end`,
      `pass R ≥ ${t.spRecordTd} Td or the envelope below ${pct(t.envelopeEnd, 0)}; warn otherwise (a note, never fails)`,
      status === 'pass' ? '' : 'Lengthen the window.', { severity: 'advisory' })
  }
  // A rejected fit gets here only with too few cycles: its count fails, its decay is not trusted for the envelope.
  const status: CheckStatus = !fit.ok ? 'fail' : cycles >= pass || (short === 'DR' && envelope < t.envelopeEnd) ? 'pass' : cycles >= min ? 'warn' : 'fail'
  const missingS = Math.max(0, min - cycles) * fit.periodS
  const runsOn = restS > 0 && restS >= missingS
  const severity: CheckSeverity = status === 'fail' && runsOn ? 'analysis' : 'critical'
  const hint =
    status === 'pass'
      ? ''
      : runsOn
        ? `Widen the window: the log runs on ${fix(restS, 0)} s past it (as long as the response stays free).`
        : status === 'fail'
          ? 'Record more cycles: the log ends too soon after the window.'
          : 'Record more cycles next time.'
  return result(def0, KIND, status, `${fix(cycles, 2)} cycles${fit.ok ? `, envelope ${pct(envelope, 0)} by the end` : ' (the rejected fit’s count)'}; the log runs on ${fix(restS, 0)} s past the window`,
    `${short === 'PH' ? `pass ≥ ${pass} cycles` : `pass ≥ ${pass} cycles or the envelope below ${pct(t.envelopeEnd, 0)}`}; warn ${min}–${pass}; fail < ${min}, a rejected fit’s count included (the app’s fitter rejects under about 0.9): Fix the analysis (widen the window) while the log runs on past R, Retest when it ends; another rejected fit: not checkable here (see fit-quality)`,
    hint, { severity })
}

function modePurity(ds: Dataset, mode: ModeId, det: InputDetection | null, rows: RowRange, fit: FitSummary | null, t: Thresholds, fittedToken: string | null): Check {
  const short = SHORT[mode]
  const def0 = d('mode-purity')
  const [r0, r1] = rows
  const time = ds.elapsed
  if (short === 'SP' || short === 'PH') {
    // A longitudinal mode that banks a lot has lateral motion in it (moved here from controls-fixed: it is not a control input).
    const phi = findChannel(ds, '_roll,__deg')
    const bankChange = phi ? summary(phi.values, r0, r1).range : NaN
    const lateralOk = !(bankChange > t.bankChangeDeg)
    const bankText = phi ? `, bank change ${fix(bankChange, 1)}°${lateralOk ? '' : ' (lateral motion during the response)'}` : ''
    const bankCriterion = ` and a bank change ≤ ${t.bankChangeDeg}° over R (more is lateral motion during the response); warn otherwise (a note, never fails)`
    if (short === 'SP') {
      const v = firstChannel(ds, ['Vtrue,_ktas', '_Vind,_kias'])
      if (!v && !phi) return notCheckable(def0, KIND)
      const from = det ? det.end : r0
      const to = rowAtTime(ds, time[Math.min(ds.rowCount - 1, from)] + t.spSpeedWindowS, from, ds.rowCount)
      const s = v ? summary(v.values, from, to) : null
      const dv = s && s.n ? s.range / s.mean : NaN
      const td = fit?.ok ? fit.periodS : NaN
      const ok = !(dv > t.spSpeedChange) && (!Number.isFinite(td) || (td >= t.spTdMinS && td <= t.spTdMaxS)) && lateralOk
      return result(def0, KIND, ok ? 'pass' : 'warn', `${v ? `speed change ${pct(dv)} in ${t.spSpeedWindowS} s after the input` : 'speed not logged'}${Number.isFinite(td) ? `, Td ${fix(td, 2)} s` : ''}${bankText}`,
        `speed change ≤ ${pct(t.spSpeedChange, 0)} in the ${t.spSpeedWindowS} s after the input, ${t.spTdMinS} s ≤ Td ≤ ${t.spTdMaxS} s${bankCriterion}`,
        ok ? '' : lateralOk ? 'The response may hold more than the short period.' : 'Keep the wings level through the response: the window holds lateral motion.')
    }
    const alpha = findChannel(ds, 'alpha,__deg')
    const v = findChannel(ds, 'Vtrue,_ktas')
    if (!alpha && !phi) return notCheckable(def0, KIND)
    const sa = alpha ? summary(alpha.values, r0, r1).sd : NaN
    const td = fit?.ok ? fit.periodS : NaN
    const vMean = v ? summary(v.values, r0, r1).mean * 0.514444 : NaN
    const lanchester = (Math.PI * Math.SQRT2 * vMean) / 9.80665
    const ratio = td / lanchester
    const ok = !(sa > t.phAlphaSdDeg) && (!Number.isFinite(td) || (td >= t.phTdMinS && td <= t.phTdMaxS)) && (!Number.isFinite(ratio) || (ratio >= t.lanchesterMin && ratio <= t.lanchesterMax)) && lateralOk
    return result(def0, KIND, ok ? 'pass' : 'warn', `${alpha ? `σα ${fix(sa, 2)}°` : 'α not logged'}${Number.isFinite(td) ? `, Td ${fix(td, 1)} s` : ''}${Number.isFinite(ratio) ? `, ${fix(ratio, 2)} × Lanchester` : ''}${bankText}`,
      `σα ≤ ${t.phAlphaSdDeg}°, ${t.phTdMinS} s ≤ Td ≤ ${t.phTdMaxS} s, Td/T_Lanchester ${t.lanchesterMin}–${t.lanchesterMax}${bankCriterion}`,
      ok ? '' : lateralOk ? 'Check the window holds the phugoid only.' : 'Keep the wings level through the phugoid: the window holds lateral motion.')
  }
  if (short === 'DR') {
    // The period again from another channel's zero crossings (β, else yaw rate, else roll rate), never the fitted one:
    // compared with itself the test would be circular.
    const others: [string, string][] = [['_beta,__deg', 'β'], ['____R,deg/s', 'yaw rate'], ['____P,deg/s', 'roll rate']]
    const pick = others.map(([tok, name]) => ({ ch: tok === fittedToken ? null : findChannel(ds, tok), name })).find((o) => o.ch)
    if (!pick || !pick.ch || !fit?.ok) return notCheckable(def0, KIND, { needs: pick ? 'Needs a fit' : 'Needs rows {16} or {18}' })
    const ch = pick.ch
    const tr = trend(ch.values, time, r0, r1)
    let crossings = 0
    let first = NaN
    let last = NaN
    let prev = NaN
    for (let i = r0; i < r1; i += 1) {
      const v = ch.values[i] - (tr.mean + tr.slope * (time[i] - (time[r0] + time[r1 - 1]) / 2))
      if (Number.isFinite(prev) && Math.sign(v) !== Math.sign(prev) && v !== 0) {
        crossings += 1
        if (!Number.isFinite(first)) first = time[i]
        last = time[i]
      }
      prev = v
    }
    const tdOther = crossings >= 3 ? (2 * (last - first)) / (crossings - 1) : NaN
    const diff = Math.abs(tdOther - fit.periodS) / fit.periodS
    const status: CheckStatus = diff <= t.drTdAgree ? 'pass' : 'warn'
    return result(def0, KIND, status, `Td ${fix(fit.periodS, 2)} s vs ${fix(tdOther, 2)} s from ${pick.name}`,
      `the fitted Td and the Td from another channel’s zero crossings about its trend (β, else yaw rate, else roll rate; never the fitted channel) agree within ${pct(t.drTdAgree, 0)}; warn otherwise (a note, never fails)`,
      status === 'pass' ? '' : 'Check the oscillation is the dutch roll.')
  }
  if (short === 'RS') {
    const beta = findChannel(ds, '_beta,__deg')
    if (!beta) return notCheckable(def0, KIND, { needs: 'row {18}' })
    const db = summary(beta.values, r0, r1).range
    const status: CheckStatus = db <= t.rsBetaRangeDeg ? 'pass' : 'warn'
    return result(def0, KIND, status, `sideslip change ${fix(db, 2)}°`, `|Δβ| ≤ ${t.rsBetaRangeDeg}° (almost pure rolling); warn otherwise (a note, never fails)`, status === 'pass' ? '' : 'Keep the feet still: the roll should be almost pure rolling.')
  }
  const beta = findChannel(ds, '_beta,__deg')
  if (!beta) return notCheckable(def0, KIND, { needs: 'row {18}' })
  const mb = Math.abs(summary(beta.values, r0, r1).mean)
  const tau = fit?.ok && fit.model === 'first-order' ? Math.abs(fit.tau) : NaN
  const status: CheckStatus = mb <= t.spiralBetaDeg && (!Number.isFinite(tau) || tau >= t.spiralTauMinS) ? 'pass' : 'warn'
  return result(def0, KIND, status, `|mean β| ${fix(mb, 2)}°${Number.isFinite(tau) ? `, |τ| ${fix(tau, 1)} s` : ''}`, `|mean β| ≤ ${t.spiralBetaDeg}° and |τ| ≥ ${t.spiralTauMinS} s (a slow real root); warn otherwise (a note, never fails)`, status === 'pass' ? '' : 'The response may not be the spiral alone.')
}

/** weather (advisory): turbulence, gusts (the wind about its running mean, not a steady change with height) and vertical wind. */
function weather(ds: Dataset, tir: [number, number], t: Thresholds): Check {
  const def0 = d('weather')
  const turb = findChannel(ds, '_turb,_locl')
  const wind = findChannel(ds, '_wind,knots')
  const vw = findChannel(ds, '_wind,v_fpm')
  if (!turb && !wind && !vw) return notCheckable(def0, KIND)
  const tb = turb ? summary(turb.values, tir[0], tir[1]).max : NaN
  let gust = NaN
  if (wind) {
    const mean = smoothInside(wind.values, ds.elapsed, tir[0], tir[1], t.gustWindowS / 2)
    let lo = Infinity
    let hi = -Infinity
    for (let i = tir[0]; i < tir[1]; i += 1) {
      const x = wind.values[i] - mean[i - tir[0]]
      if (!Number.isFinite(x)) continue
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
    gust = hi >= lo ? hi - lo : NaN
  }
  const wv = vw ? maxAbs(vw.values, tir[0], tir[1]) : NaN
  const ok = !(tb > t.turbulence) && !(gust > t.windRangeKt) && !(wv > t.verticalWindFpm)
  return result(def0, KIND, ok ? 'pass' : 'warn', `turbulence ${fmt(tb, 2)}, gusts ${fmt(gust, 2)} kt, |vertical wind| ≤ ${fmt(wv, 2)} fpm`,
    `turbulence ≤ ${t.turbulence}, gusts ≤ ${t.windRangeKt} kt peak to peak (the wind speed about its ${t.gustWindowS} s running mean, so a steady change with height does not count) and |vertical wind| ≤ ${t.verticalWindFpm} fpm; warn otherwise (a note, never fails)`,
    ok ? '' : 'Set calm weather for stability tests.')
}

/** envelope (advisory): the app's default margins, and the speed limits once the student sets them (info until then). */
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
    if (s.min < t.nzMinG || s.max > t.nzMaxG) status = 'warn'
  }
  if (alpha && lim.alphaMaxDeg) {
    const s = summary(alpha.values, tir[0], tir[1])
    parts.push(`α ≤ ${fix(s.max, 1)}°`)
    if (s.max > lim.alphaMaxDeg) status = 'warn'
  }
  if (kias) {
    const s = summary(kias.values, tir[0], tir[1])
    parts.push(`${fix(s.min, 0)}–${fix(s.max, 0)} KIAS`)
    if ((lim.vsKias && s.min < t.vsFactor * lim.vsKias) || (lim.vmoKias && s.max > lim.vmoKias - t.vmoMarginKt)) status = 'warn'
  }
  if (mach && lim.mmo) {
    const s = summary(mach.values, tir[0], tir[1])
    parts.push(`M ≤ ${fix(s.max, 3)}`)
    if (s.max > lim.mmo - t.mmoMargin) status = 'warn'
  }
  if (agl) {
    const s = summary(agl.values, tir[0], tir[1])
    parts.push(`height ≥ ${fix(s.min, 0)} ft AGL`)
    if (s.min < t.heightAglFt) status = 'warn'
  }
  // α_max alone checks no speed: the line stays "info" until a speed limit (V_S, V_MO or M_MO) is set.
  const speedSet = !!(lim.vsKias || lim.vmoKias || lim.mmo)
  if (!speedSet) {
    parts.push('speed limits not set')
    if (status === 'pass') status = 'info'
  }
  return result(def0, KIND, status, parts.join('; '),
    `${t.nzMinG} ≤ n_z ≤ ${t.nzMaxG} g and ≥ ${t.heightAglFt.toLocaleString('en-GB')} ft AGL; once set: α ≤ α_max, ${t.vsFactor} V_S ≤ KIAS ≤ V_MO − ${t.vmoMarginKt} kt, M ≤ M_MO − ${t.mmoMargin}; warn outside (a note, never fails); info while no speed limit is set`,
    status === 'warn' ? 'Stay inside the stated test envelope.' : !speedSet ? 'Set V_S, V_MO and M_MO in the settings to check the speed envelope.' : '')
}

/**
 * MIL-F-8785C levels, Class III assumed (Category B; C by the app's proxy, flaps, slats or gear out). Category C short
 * period: Fig 6's Class II-L and III floors as well (MIL p.54, read on the gridlines: ωn ≥ 0.7 rad/s and n/α ≥ 2.0 g/rad
 * for Level 1, ≥ 0.4 and ≥ 1.0 for Level 2). Dutch roll Level 1: Table VI's footnote, ζ need not exceed 0.7 in Class III.
 */
function hqLevel(ds: Dataset, mode: ModeId, rows: RowRange, fit: FitSummary | null, config: ConfigurationState, settings: DynamicSettings, t: Thresholds): Check {
  const def0 = d('hq-level')
  const short = SHORT[mode]
  if (!fit || !fit.ok) return notCheckable(def0, KIND)
  const cat = categoryC(config, t.configMean) ? 'C' : 'B'
  const catText = cat === 'C' ? 'Category C proxy (flaps, slats or gear out)' : 'Category B proxy (flaps, slats and gear in)'
  const label = settings.yawDamper === 'on' ? 'augmented' : 'X-Plane model, one condition, yaw damper off = failure state (bare airframe)'
  const lv = (ok1: boolean, ok2: boolean, ok3: boolean) => (ok1 ? 'Level 1' : ok2 ? 'Level 2' : ok3 ? 'Level 3' : 'worse than Level 3')
  const assumed = `report only: MIL-F-8785C, Class III assumed, ${cat === 'C' ? 'Category C by the app’s proxy (flaps, slats or gear out)' : 'Category B by the app’s proxy (flaps, slats and gear in; C would need one of them out)'}`
  let measured: string
  let criterion: string
  if (short === 'SP' && fit.model === 'oscillation') {
    const z = fit.zeta
    const [l1lo, l1hi] = cat === 'B' ? [0.3, 2.0] : [0.35, 1.3]
    const [l2lo, l2hi] = cat === 'B' ? [0.2, 2.0] : [0.25, 2.0]
    const damping = lv(z >= l1lo && z <= l1hi, z >= l2lo && z <= l2hi, z >= 0.15)
    // CAP = ωn² / (n/α), n/α from a least-squares fit of Δn_z on Δα (rad) over R: the app's estimate from the free
    // response (engineering judgement).
    const nz = findChannel(ds, 'Gload,norml')
    const alpha = findChannel(ds, 'alpha,__deg')
    let cap = NaN
    let nAlpha = NaN
    if (nz && alpha) {
      const a = Array.from(alpha.values.subarray(rows[0], rows[1]), (v) => (v * Math.PI) / 180)
      const n = Array.from(nz.values.subarray(rows[0], rows[1]))
      nAlpha = linearFit(a, n).c1
      cap = (fit.omegaN * fit.omegaN) / nAlpha
    }
    // MIL guide Figs 5 and 6 (pp.53–54): the lower boundary is "Levels 2 & 3", so a CAP below it is worse than Level 3;
    // above the Level 2 upper line (10) only Level 3 remains. Category C adds Fig 6's Class II-L and III floors.
    const [c1lo, c1hi, c2lo, c2hi] = cat === 'B' ? [0.085, 3.6, 0.038, 10] : [0.16, 3.6, 0.096, 10]
    const floor1 = cat === 'B' || (fit.omegaN >= 0.7 && nAlpha >= 2.0)
    const floor2 = cat === 'B' || (fit.omegaN >= 0.4 && nAlpha >= 1.0)
    const capLevel = Number.isFinite(cap) && cap > 0
      ? lv(cap >= c1lo && cap <= c1hi && floor1, cap >= c2lo && cap <= c2hi && floor2, cap >= c2lo)
      : 'CAP not computed'
    const floorNote = cat === 'C' && Number.isFinite(cap) && cap >= c1lo && cap <= c1hi && !floor1 ? ' (below Fig 6’s Level 1 floor of ωn ≥ 0.7 rad/s and n/α ≥ 2.0 g/rad)' : ''
    measured = `ζ ${fmt(z, 3)}: ${damping} (Table IV, ${catText}); CAP ${fmt(cap, 3)}: ${capLevel}${floorNote}; n/α ${fmt(nAlpha, 3)} g/rad (estimated from the free response, engineering judgement)`
    criterion = `${assumed}. ζ (Table IV): B L1 0.30–2.00, L2 0.20–2.00; C L1 0.35–1.30, L2 0.25–2.00; L3 ≥ 0.15. CAP = ωn²/(n/α) (Figs 5–6): B L1 0.085–3.6, L2 0.038–10; C L1 0.16–3.6 with ωn ≥ 0.7 rad/s and n/α ≥ 2.0 g/rad, L2 0.096–10 with ωn ≥ 0.4 and n/α ≥ 1.0; L3 at or above the L2 lower line. n/α estimated from the free response (engineering judgement)`
  } else if (short === 'PH' && fit.model === 'oscillation') {
    const t2 = fit.sigma < 0 ? -fit.halfLifeS : Infinity
    measured = `ζ ${fmt(fit.zeta, 3)}: ${lv(fit.zeta >= 0.04, fit.zeta >= 0, t2 >= 55)}`
    criterion = `${assumed}. L1 ζ ≥ 0.04, L2 ζ ≥ 0 (Cook Table 10.5); L3 unstable with T2 ≥ 55 s (MIL p.47)`
  } else if (short === 'DR' && fit.model === 'oscillation') {
    const z = fit.zeta
    const zw = z * fit.omegaN
    const w = fit.omegaN
    const zw1 = cat === 'B' ? 0.15 : 0.1
    measured = `ζ ${fmt(z, 3)}, ζωn ${fmt(zw, 3)} rad/s, ωn ${fmt(w, 3)} rad/s: ${lv(z >= 0.08 && (zw >= zw1 || z >= 0.7) && w >= 0.4, z >= 0.02 && zw >= 0.05 && w >= 0.4, z >= 0 && w >= 0.4)} (Table VI, ${catText}; footnotes on |φ/β| not applied)`
    criterion = `${assumed}. Table VI: L1 ζ ≥ 0.08, ζωn ≥ 0.15 rad/s (C: 0.10) or ζ ≥ 0.7 (the Class III cap), ωn ≥ 0.4 rad/s; L2 ζ ≥ 0.02, ζωn ≥ 0.05, ωn ≥ 0.4; L3 ζ ≥ 0, ωn ≥ 0.4; the |φ/β| increase is not applied`
  } else if (short === 'RS' && fit.model === 'first-order') {
    const tr = fit.tau
    measured = `τ_R ${fmt(tr, 3)} s: ${tr > 0 ? lv(tr <= 1.4, tr <= 3.0, tr <= 10) : 'divergent'}`
    criterion = `${assumed}. τR ≤ 1.4 s L1, ≤ 3.0 s L2 (Cook Table 10.6), ≤ 10 s L3 (MIL-F-8785C, Cook p.282)`
  } else if (short === 'SPI' && fit.model === 'first-order') {
    if (fit.tau > 0) measured = 'stable spiral'
    else {
      const t2 = -fit.halfLifeS
      const l1 = cat === 'B' ? 20 : 12
      measured = `T2 ${fmt(t2, 3)} s: ${lv(t2 >= l1, t2 >= 8, t2 >= 4)} (Table VIII, ${catText})`
    }
    criterion = `${assumed}. Table VIII, unstable spiral: T2 ≥ 20 s L1 (C: 12 s), ≥ 8 s L2, ≥ 4 s L3; a stable spiral meets every level`
  } else {
    return notCheckable(def0, KIND, { needs: 'Needs the mode’s model (oscillation or first order)' })
  }
  return result(def0, KIND, 'info', `${measured} — ${label}`, criterion)
}
