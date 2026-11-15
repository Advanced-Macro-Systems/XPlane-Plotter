// Test validity of a static-stability trim curve: do the chosen trim points support the course's plot of the pitch
// control needed to trim against C_L (one line per CG; a negative elevator-to-trim slope means stable; the neutral
// point from several CG lines: FD10 slides 31–32, FD12b pp.26–28, Cook pp.46–48)? Per point: steady, unaccelerated,
// controls and trim fixed, one power setting and configuration, clear of the stall. Per set: the pitch control includes
// the trim, C_L is defined right, the C_L range, the thrust method, the CG lines and the gradient. It judges the
// course's trim-curve method only, not the NATO/MIL speed-stability test, nor lateral-directional static stability
// (open item N2). Pure: no React, no DOM.

import { compileExpression } from '../analysis/expr'
import { airspeedChannels } from '../analysis/steady'
import { channelAlias } from '../channels/alias'
import { channelById } from '../dataset'
import type { Channel, Dataset, PointGroup, TestPoint, TrimCheckSettings } from '../types'
import { formatCitations } from './cite'
import {
  autothrottleEvidence,
  configuration,
  findChannel,
  fix,
  fmt,
  grade,
  largestChangeWithin,
  leverChannels,
  linearFit,
  maxAbs,
  notCheckable,
  pct,
  pitchControlSource,
  powerSteadiness,
  result,
  rowsFromNotCheckable,
  sampleRate,
  settling,
  signed,
  smoothInside,
  sumChannels,
  summary,
  timeBase,
  trend,
  twoVariableFit,
  worse,
  atLeast,
  declaresModes,
  configText,
  engineChannels,
  LEVER_ACTUAL,
  N1,
  POWER_HP,
  POWER_LEGACY,
  THRUST,
  type PitchSource,
} from './helpers'
import { recutCounts } from './recut'
import type { Check, CheckDef, CheckStatus, OpenItem, PointReport, PointStatus, SetReport, Verdict } from './types'
import { worstStatus } from './types'

export type { TrimCheckSettings }

export interface StaticInput {
  ds: Dataset
  /** P: the points the X–Y plot uses (visible points of the chosen groups), in workspace order */
  points: readonly TestPoint[]
  groups: readonly PointGroup[]
  /** The plotted x (a C_L) and Y (the pitch control) */
  xId: string | null
  yId: string | null
  settings?: TrimCheckSettings
  setName?: string
}

export type YKind = 'elevator' | 'trim' | 'combined' | 'other'

export interface EquivalentElevator {
  G: number
  seG: number
  /** dδ_eq/dC_L and its standard error */
  slope: number
  seSlope: number
  r2: number
  n: number
  /** +1 for the degree columns (trailing edge down positive), −1 for the nose-up-positive ratio _elev,_surf */
  sign: 1 | -1
}

export interface StaticReport extends SetReport {
  kind: 'static'
  yKind: YKind
  /** The fitted (or given) trim gain and the δ_eq formula to plot it, when trim-variable recommends it */
  deltaEq: { G: number; seG: number; name: string; unit: string; expression: string } | null
  gradient: { slope: number; se: number; t: number; label: string } | null
  /** The neutral point by extrapolation (CG reference units, ft) and its standard error; NaN with fewer than 2 lines */
  neutralPoint: { hn: number; se: number; lines: number }
}

/** Near idle the thrust (or power) range is judged against this share of the log's largest force, not a mean near zero. */
const IDLE_SHARE = 0.25

interface Threshold {
  value: number
  unit: string
  source: string
  judgement: boolean
}
const ej = (value: number, unit: string): Threshold => ({ value, unit, source: 'EJ', judgement: true })
/** This app's own default: no published source gives it, so in the checklist's sense it is engineering judgement. */
const appDefault = (value: number, unit: string, source: string): Threshold => ({ value, unit, source, judgement: true })
/** A number a published source gives (for this test or, as `source` says, for another one). */
const fromSource = (value: number, unit: string, source: string): Threshold => ({ value, unit, source, judgement: false })

/**
 * The static checklist's main tolerances, each tagged with where it comes from: a published source's number (judgement
 * false), or engineering judgement and this app's own defaults (judgement true). Documentation only: the checks below use
 * these values as written, the table is not shown in the app and, unlike the dynamic checklist's CHECK_THRESHOLDS, it is
 * not overridable. It is not exhaustive: every number a check applies is in that check's criterion string, and the
 * numbers a source gives are in its `sourced` line; those two are the full record.
 */
export const TRIM_CHECK_THRESHOLDS = {
  passRateHz: ej(1, 'Hz'),
  /** Below it the low-rate warning calls the rate sparse; no rate fails (NATO 15-5 sets no minimum for trim data) */
  sparseRateHz: fromSource(0.2, 'Hz', 'NATO 13-6 (one sample per five seconds, its recording rate for classical climb tests: borrowed)'),
  minRecordS: appDefault(30, 's', 'App guide.ts line 79 (30–60 s)'),
  floorRecordS: ej(5, 's'),
  settledS: fromSource(60, 's', 'NATO 13-6, 13-7 (climbs and level accelerations: borrowed)'),
  passChangeKt: ej(1, 'kt'),
  speedChangeKt: appDefault(2, 'kt', 'App steady.ts line 243'),
  vviSdFpm: ej(100, 'fpm'),
  levelFpm: appDefault(100, 'fpm', 'App steady.ts line 243'),
  qMeanDegS: ej(0.1, 'deg/s'),
  dn: ej(0.02, 'g'),
  gammaDeg: ej(10, 'deg'),
  bankDeg: ej(3, 'deg'),
  bankSdDeg: ej(1, 'deg'),
  bankSwingDeg: appDefault(2, 'deg', 'App steady.ts lines 243, 359 (0.4 × the 5° bank tolerance)'),
  betaDeg: ej(2, 'deg'),
  leverRange: ej(0.005, 'ratio'),
  forceRange: ej(0.02, ''),
  idleForceShare: ej(IDLE_SHARE, ''),
  n1RangePct: ej(0.5, '%pt'),
  /** With a setting row, N1 moving more than this inside a point warns (an autothrottle or FADEC moved the power) */
  n1MovedPct: ej(1.5, '%pt'),
  stickRange: ej(0.02, 'ratio'),
  elevSdDeg: ej(0.1, 'deg'),
  trimRange: ej(0.002, 'ratio'),
  trimDrift: ej(0.02, 'ratio'),
  configRange: ej(0.001, ''),
  configMatch: ej(0.01, ''),
  minPoints: fromSource(3, '', 'Cook p.48 (three points “barely adequate” to draw a line, said of the neutral-point plot)'),
  clRatio: fromSource(1.8, '', 'derived from MIL p.40 (±15 % or ±50 kt EAS about one trim speed, whichever is less; ±15 % below about 333 KEAS: the speed-stability test, another test)'),
  /** cl-range warns below clRatio; under this line the hint calls the range narrow */
  clRatioNarrow: ej(1.3, ''),
  vsWarn: fromSource(1.2, 'V_S', 'NATO 13-5 (take-off safety speed V2), 15-12 (one-g stalls started from trimmed level flight at 1.2 to 1.4 V_S): borrowed'),
  vsInfo: fromSource(1.3, 'V_S', 'NATO 13-5 (usual approach speed): borrowed'),
  mach: fromSource(0.6, '', 'Cook p.360, p.363'),
  cgLines: fromSource(3, '', 'Cook p.48 (three points “barely adequate”)'),
  // The same stand-in for one wingspan as the performance checklist's (the app has no wingspan setting).
  heightAglFt: ej(200, 'ft'),
}

// ------------------------------------------------------------------ definitions

const def = (d: CheckDef): CheckDef => d

export const STATIC_DEFS: readonly CheckDef[] = [
  def({
    id: 'time-base', title: 'Continuous sim-time record', severity: 'critical', scope: 'point', interval: 'W',
    why: 'The app asks that a trim point’s mean come from one continuous stretch of flight. The app’s channel dictionary notes that X-Plane’s real-time clock keeps counting through loading screens, menus and pauses, and the lecture’s Data.txt excerpt shows the real and sim clocks far apart (an illustration only). The gap rule (a step longer than max(1 s, 20 × the median step)) and the preference for sim time are the app’s own choices.',
    cite: ['App src/core/time.ts', 'App dictionary.ts line 26', 'FD12b p.19'], judgement: true, needs: 'row {1}',
  }),
  def({
    id: 'sample-rate', title: 'Sample rate', severity: 'critical', scope: 'point', interval: 'W',
    why: 'NATO records handling-qualities data at typically at least 10 samples per second, the rate the app’s recording guide asks for, but notes that quasi-steady trim data may even be recorded by hand: it sets no minimum rate for trim points. So a low rate only warns, an isolated dropout is only noted, and the record-length check keeps the sample-count floor (the app’s choices). The warning calls a rate sparse below one sample per five seconds, NATO’s recording rate for its classical climb tests (borrowed). The 1 Hz line, the 2 % allowance and the dropout rule (a step over 3 × the median) are engineering judgement.',
    cite: ['NATO 15-3', 'NATO 15-5', 'NATO 13-6', 'App src/core/channels/guide.ts line 20'], judgement: true,
    sourced: '0.2 Hz (one sample per 5 s): NATO 13-6’s recording rate for classical climbs, borrowed for the app’s sparse-rate warning (NATO sets no minimum for trim data, 15-5); 10 samples/s for the recording: NATO 15-3 (handling-qualities data, typical minimum)',
    needs: 'row {1}',
  }),
  def({
    id: 'record-length', title: 'Long enough to judge', severity: 'critical', scope: 'point', interval: 'W',
    why: 'No source sets a record length for a trim point: NATO notes trim data may even be recorded by hand, and for comparison records the last minute of a quasi-steady cruise point (another test). The app’s recording guide asks for trimmed points of 30 to 60 s, an app default. The lecture warns that trimmed regions are hard to find and that the data need not be perfect, and its X-Plane performance example picks short windows, so shorter points are kept with a warning (the app’s choice). The 30-sample pass and the 5 s and 10-sample floors are engineering judgement.',
    cite: ['NATO 15-5', 'NATO 13-10', 'App src/core/channels/guide.ts line 79', 'FD12b p.19', 'FD12c p.16'], judgement: true,
    follows: 'pass: the app’s recording guide (30–60 s, an app default); floors: engineering judgement, below the short windows of the lecture’s X-Plane performance example (FD12c p.16, not trim points)',
    needs: 'row {3}',
  }),
  def({
    id: 'stabilised', title: 'Settled after the last power change', severity: 'advisory', scope: 'point', interval: 'L and W',
    why: 'NATO stabilises engine and aircraft for at least a minute before recording climbs and level accelerations, and notes that engine output changes appreciably in the first minute after a power-lever change (take-off and test-bench running). The sources do not say whether X-Plane models that lag, so the app judges a short settling time by the traces and only warns. The 120 s look-back, the change detection and the 1 % trend line are engineering judgement.',
    cite: ['NATO 13-5', 'NATO 13-6', 'NATO 13-7', 'NATO 24-6'], judgement: true,
    sourced: 'pass ≥ 60 s after the last power change: NATO 13-6, 13-7 (climbs and level accelerations, borrowed)',
    follows: 'NATO 13-6 and 13-7 (one minute, stated for climbs and accelerations) rather than 24-6 (three to four minutes, propulsion tests)',
    needs: 'row {25}, {35}, {34} or {41}',
  }),
  def({
    id: 'speed-steady', title: 'Speed held steady', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Trim is steady, non-accelerating flight with the forces and moments in balance. NATO’s only speed-steadiness figure belongs to its cruise climbs, a change of less than one knot in two minutes (0.5 kt/min), and NATO corrects quasi-steady points for residual acceleration. Every band uses one measure, the speed change over the point, with the scatter (2σ about the trend) beside it: the 2 kt change and 2σ warn lines are the app’s steady-point defaults (Find steady points), and the 1 kt pass lines are engineering judgement.',
    cite: ['FD08 p.4', 'Cook p.33', 'NATO 13-10', 'App src/core/analysis/steady.ts line 243'], judgement: true, needs: 'row {3}',
  }),
  def({
    id: 'flight-path', title: 'Steady flight path at 1 g', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Trim is steady, non-accelerating flight with forces and moments in balance, and C_L = nW/(q̄S) takes the load factor n. MIL states speed stability at 1 g and constant altitude, and the lecture’s computed trims are level. But Cook’s trim equations cover steady climbing flight, the lecture notes that its level-flight analysis extends easily to steady climbing flight (a constant flight-path angle), and re-trimming faster without more power leaves the aircraft descending; Cook’s flight test held power constant, NATO keeps engine power at the trim setting, and the lecture’s X-Plane trims are at zero thrust. So the app accepts a steady climb or descent, and only notes it in a level set. X-Plane’s VVI lags the true climb rate, so the level test also reads the altitude trend. The level band and the 200 fpm σ(VVI) line are the app’s steady-point defaults; every other band is engineering judgement.',
    cite: ['FD08 p.4', 'FD08 p.24', 'MIL p.40', 'MIL p.43', 'FD12 p.11', 'Cook p.63', 'FD08 p.10', 'Cook p.46', 'Cook p.47', 'NATO 15-6', 'FD12b p.18', 'App dictionary.ts line 55', 'App src/core/analysis/steady.ts line 243'],
    judgement: true,
    follows: 'MIL p.40 and the lecture’s level trim example (FD12 p.11) for power-for-level sets; Cook p.63, FD08 p.10 and the constant-power and zero-thrust procedures (Cook pp.46–47, NATO 15-6, FD12b p.18) otherwise',
    needs: 'row {4}; add {20}, {16} and {17}',
  }),
  def({
    id: 'wings-level', title: 'Wings level, little sideslip', severity: 'critical', scope: 'point', interval: 'W',
    why: 'The trim condition is calculated for straight, symmetric flight, which leaves only the longitudinal equilibrium to establish, and MIL defines its gradients for straight, steady flight. A banked turn raises the load factor and needs a pitch rate, which takes extra elevator and changes C_L = nW/(q̄S). The 2° bank-swing line is the app’s steady-point limit (0.4 × its 5° bank tolerance); every other band is engineering judgement.',
    cite: ['Cook p.63', 'MIL p.40', 'FD11 p.6', 'FD11 p.18', 'FD08 p.24', 'App src/core/analysis/steady.ts line 243', 'App src/core/analysis/steady.ts line 359'],
    judgement: true, needs: 'rows {17} and {18}',
  }),
  def({
    id: 'throttle-fixed', title: 'Power not changed during the point', severity: 'critical', scope: 'point', interval: 'W',
    why: 'The sources fix the power setting while trim data are taken: MIL’s speed-stability test leaves the trimmer and throttle where the crew set them (a different test from the trim curve), Cook’s flight test kept power at a constant setting, and NATO keeps engine power at the trim setting through a block of stability tests. So the app judges the setting: the lever and, when logged, the throttle reaching the engines, which an autothrottle or FADEC can move with the lever still (the app’s channel dictionary); N1 moving beside a still lever only warns (the app’s choice). Without a setting row N1 stands in, else thrust or engine power, smoothed over ±1 s as in Find steady points. At a fixed setting the force still changes with height, and near idle a ratio to a mean near zero means nothing, so in a point that is not level, or judged against a quarter of the log’s largest force, a force change only warns (the app’s reasoning and choices). Every band is engineering judgement.',
    cite: ['MIL p.40', 'Cook p.47', 'NATO 15-6', 'App dictionary.ts line 266', 'App src/core/analysis/steady.ts'], judgement: true,
    follows: 'MIL p.40 (a) and Cook p.47: the setting (the lever, and the throttle reaching the engines) is judged, not the force it produces',
    needs: 'row {25}, {35}, {34} or {41}',
  }),
  def({
    id: 'controls-fixed', title: 'Controls fixed: no stick input', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Controls-fixed means the elevator and its tab are held at the settings for the prevailing trim: in Cook’s procedure the pilot moves the column to the new elevator setting and simply holds it there, and the course’s stick-fixed case holds the elevator fixed. A trimmed aircraft keeps flying the condition when the controls are released, so a still stick held off-centre is only noted (the app’s choice). Stability tests are open loop. Bands are engineering judgement.',
    cite: ['Cook p.45', 'Cook p.46', 'FD10 slide 25', 'FD08 p.4', 'NATO 15-4'], judgement: true,
    needs: 'row {8} for the stick, {74} or {11} for the elevator',
  }),
  def({
    id: 'trim-fixed', title: 'Pitch trim still', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Controls-fixed stability takes the elevator and its tab at the settings for the prevailing trim, and the two are, to an extent, interchangeable means of trimming; Cook’s flight test kept the trim tab and power at constant settings throughout, and MIL’s speed-stability test leaves the trimmer where the crew set it. The course’s stick-fixed case holds the elevator fixed. Under an autopilot altitude hold a stabiliser trim action can change the condition. Bands are engineering judgement.',
    cite: ['Cook p.45', 'Cook p.47', 'MIL p.40', 'FD10 slide 25', 'NATO 21-7'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'configuration-constant', title: 'Configuration unchanged', severity: 'critical', scope: 'point', interval: 'W',
    why: 'A test plan defines each configuration by its landing gear, flap and speedbrake positions and thrust; flap and gear positions are recorded to establish a test point’s configuration, and trim depends on the airframe configuration as well as speed, weight and CG. No source gives a number for “unchanged”: the 0.001 range tolerance is engineering judgement, and the gear warning is the app’s choice.',
    cite: ['NATO 8-4', 'NATO 15-5', 'Cook p.34'], judgement: true, needs: 'row {13}; gear needs row {14}',
  }),
  def({
    id: 'configuration-match', title: 'One configuration per line', severity: 'critical', scope: 'point', interval: 'P',
    why: 'Trim depends on the airframe configuration, and each test point’s configuration is defined by its flap and gear positions, so each configuration is its own trim curve. A point in another configuration is plotted but left out of this curve’s fit, to plot on its own curve, not to refly, and when two configurations are equally common the set’s own cannot be told (the app’s choices). The 0.01 match tolerance, within which two configurations count as one, is engineering judgement.',
    cite: ['Cook p.34', 'NATO 29-1', 'NATO 15-5'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'near-stall', title: 'Not near the stall', severity: 'advisory', scope: 'point', interval: 'U',
    why: 'The trim curve of most aircraft has some non-linear tendency at high trim C_L, and in extreme cases stability reverses. A detailed analysis evaluates the margin at each trim C_L, Cook plots the mean gradient of each CG line, and the lecture’s trim example starts at the stall: no source removes near-stall points, so a warned point stays in the fit with a note (the app’s choice). Cook’s force balance is stable with speed provided the speed is above the minimum-drag speed, and NATO tests the approach and landing configurations for the back side of the power curve, where holding altitude takes more power as speed falls. The V_S lines borrow NATO’s numbers for other tests: 1.2 V_S is its take-off safety speed and the low end of its one-g stall entries from trimmed level flight, 1.3 V_S its usual approach speed. Every other limit here is engineering judgement.',
    cite: ['Cook p.41', 'FD10 slide 19', 'MIL p.41', 'Cook p.47', 'Cook p.48', 'FD12 p.10', 'Cook p.35', 'NATO 15-4', 'NATO 13-5', 'NATO 15-12'], judgement: true,
    sourced: 'warn < 1.2 V_S: NATO 13-5 (take-off safety speed V2) and 15-12 (one-g stalls started from trimmed level flight at 1.2 to 1.4 V_S); info < 1.3 V_S: NATO 13-5 (usual approach speed); both borrowed from other tests',
    needs: 'row {18}',
  }),
  def({
    id: 'envelope', title: 'Out of ground effect, inside limits', severity: 'advisory', scope: 'point', interval: 'W',
    why: 'Near the ground lift, drag and pitching moment differ from free air, and the effect is negligible once the wing is more than about a semi-span up; NATO ends a take-off test about one wingspan up, and the lecture starts its X-Plane trims at altitude. V_MO and M_MO may not be deliberately exceeded, and a test plan states its limits and their source. The app has no wingspan setting, so it warns below 200 ft, more than one span for all but the largest airliners (as in the performance checklist); that line and the V_MO − 10 kt and M_MO − 0.02 margins are engineering judgement.',
    cite: ['NATO 9-20', 'NATO 13-4', 'FD12b p.18', 'NATO 12-4', 'NATO 8-3'], judgement: true, needs: 'row {20}',
  }),
  def({
    id: 'weather', title: 'Calm air', severity: 'advisory', scope: 'point', interval: 'W',
    why: 'Weather requirements are set for each block of test points and can be stringent for performance tests, and weather affects the quality of a test. In climb tests vertical air movement, horizontal wind or pressure gradients can bias the measured rate of climb by 100 fpm or more, and NATO seeks stable air for performance tests. The three limits are engineering judgement, as in the dynamic checklist.',
    cite: ['NATO 8-3', 'NATO 15-4', 'NATO 13-9'], judgement: true, needs: 'row {152}',
  }),
  def({
    id: 'trim-variable', title: 'Pitch control includes the trim', severity: 'analysis', scope: 'set', interval: 'U',
    why: 'With a trimming tail the whole tail rotates to trim and the elevator can sit near zero; tail setting and elevator enter the same moment balance, re-trimming needs elevator or stabiliser, and NATO records the elevator and the stabiliser together in its autopilot tests. Speed stability supplied by the flight control system can leave zero control gradients, automatic trimming has let aircraft slow down towards the stall, and fly-by-wire airliners trim automatically. The slopes are fitted against C_L (n·W/(q̄S) when the x axis is not a C_L); the 0.005 trim and 0.01 or 0.2° elevator travel, the 2 SE and 3 SE tests and the 20 % G line are engineering judgement. When the check cannot be made, the verdict is Cannot confirm (the app’s rule).',
    cite: ['FD09 p.5', 'FD09 p.30', 'FD09 p.32', 'FD10 slide 22', 'FD08 p.14', 'Cook p.44', 'Cook p.491', 'NATO 21-7', 'MIL p.40', 'MIL p.41', 'FD05 p.15', 'App dictionary.ts lines 210, 214, 381', 'App src/views/xy/xyPresets.ts line 38'],
    judgement: true, needs: 'rows {13} and {74} or {11}',
  }),
  def({
    id: 'cl-definition', title: 'C_L from EAS, current weight, S-ref', severity: 'analysis', scope: 'set', interval: 'P, judged on U',
    why: 'The lectures take C_L = nW/(q̄S) with q̄ = ½ρ₀U_E² from equivalent airspeed, and data reduction uses the current weight. X-Plane’s KIAS carries a pitot error that grows with angle of attack, so a formula on KIAS is warned, and its gross,___lb is the maximum weight, which fails. X-Plane’s own C_L uses the aerodynamic lift, which differs from the weight-based value by drag, thrust and attitude terms, hence the 3 % pass and 6 % fail bands (engineering judgement). A speed axis is warned because the course plots the elevator to trim against C_L.',
    cite: ['FD08 p.24', 'Cook p.64', 'NATO 15-3', 'App dictionary.ts lines 44, 45, 167, 168', 'App src/core/analysis/derived.ts', 'FD12b p.26', 'FD10 slide 32'],
    judgement: true, needs: 'rows {63}, {3}, {4} and {68} for S-ref',
  }),
  def({
    id: 'cl-range', title: 'Enough points across a wide C_L range', severity: 'critical', scope: 'set', interval: 'U',
    why: 'The gradient comes from trims at several C_L, and three points to draw a line are called barely adequate (Cook, of the neutral-point plot); a line through two has no check, so fewer than three used points fail, and used points without a C_L leave the check not checkable (the app’s rule). Cook’s flight test has about seven points per CG line, the lecture’s trim example runs from the stall to 250 kt in 15 kt steps, and a searching evaluation needs more and better points. MIL’s speed-stability test spans ±15 % or ±50 kt equivalent airspeed about one trim speed, whichever is less, a C_L ratio of about 1.8, borrowed as the pass line (a different test). No source sets a minimum span, so a narrow range only warns; the 1.3 line, the 5-point pass and the 40 % gap are engineering judgement.',
    cite: ['FD12b p.26', 'Cook p.47', 'Cook p.48', 'FD12 p.10', 'MIL p.40'], judgement: true,
    sourced: 'pass C_L ratio ≥ 1.8: derived from MIL p.40 (speed-stability test: ±15 % or ±50 kt EAS about one trim speed, whichever is less; (1.15/0.85)² ≈ 1.8 where ±15 % is the lesser, below about 333 KEAS); fail < 3 points: Cook p.48 (three points “barely adequate” to draw a line, said of the neutral-point plot)',
    needs: 'Needs cl-definition',
  }),
  def({
    id: 'compressibility', title: 'Compressibility at the fast end', severity: 'advisory', scope: 'set', interval: 'U',
    why: 'As compressibility grows the force and moment coefficients depend on Mach as well as incidence, the speed derivative M_u becomes significant only at high Mach, and static margins can change markedly in the transonic regime. Changes in stability and control may not become significant until about M 0.6, the warn line. In a sweep at one altitude Mach and C_L change together and cannot be separated (the app’s reasoning). Only the optional M_MO − 0.02 margin is engineering judgement.',
    cite: ['Cook p.36', 'Cook p.252', 'Cook p.276', 'Cook p.360', 'Cook p.363'], judgement: true,
    sourced: 'warn at M 0.6: Cook p.360 (changes in stability and control may not become significant until M 0.6 or higher), p.363 (the compressibility change in pitching moment becomes significant at about M ≥ 0.6)',
    needs: 'row {4}',
  }),
  def({
    id: 'thrust-method', title: 'Thrust: zero, constant or power-on', severity: 'advisory', scope: 'set', interval: 'U',
    why: 'The sources differ: the lecture’s X-Plane procedure reduces thrust to zero (here: every lever at idle); Cook’s flight test held power constant while noting power effects cannot be fully removed; NATO keeps power at the trim setting; the lecture’s computed trims re-balance thrust at each speed. Power is probably the most significant source of variation in static stability, and the simple trim models leave out power changes and the thrust moment. The setting decides: the lever and, when logged, the throttle reaching the engines; fixed, they count as constant power whatever N1 does. Without a setting row a steady N1 or force counts as constant power, but one that varies between points cannot tell idle at varying speed from re-set power, so the method is left unknown (the app’s choices). The lever, N1 and thrust bands are engineering judgement.',
    cite: ['FD12b p.18', 'Cook p.46', 'Cook p.47', 'NATO 15-6', 'FD12 p.12', 'Cook p.38', 'FD08 p.21', 'FD12b p.26'], judgement: true,
    follows: 'FD12b p.18 and Cook p.47 for a pass; FD12 p.12 (computed trims, thrust re-balanced) is labelled, not failed',
    needs: 'row {25}; add {35} or {41}',
  }),
  def({
    id: 'cg-lines', title: 'CG positions: neutral point possible?', severity: 'info', scope: 'set', interval: 'U',
    why: 'The neutral point comes from the mean gradient of each CG line plotted against CG and extrapolated to zero, and three lines are called barely adequate, the pass line; a CG change gives another line, and CG can be changed in X-Plane 12. CG moves with fuel burn, flying-qualities data can be adjusted for slight CG variations, and the most aft CG is the critical case. The 3 points per line, the 25 % drift, the 2 × span extrapolation and the clustering gap are engineering judgement.',
    cite: ['FD12b p.28', 'Cook p.48', 'FD10 slide 32', 'NATO 9-11', 'NATO 15-2', 'NATO 15-7'], judgement: true,
    sourced: 'pass ≥ 3 CG lines: Cook p.48 (three points “barely adequate” for the neutral point)',
    needs: 'row {63}',
  }),
  def({
    id: 'autopilot-record', title: 'Autopilot modes recorded', severity: 'advisory', scope: 'set', interval: 'W; ±30 s for the inference',
    why: 'Every test point’s configuration includes the autopilot or stability-augmentation status, and NATO’s autopilot tests record the selected values and the selected modes as separate items, so only a mode code that changes counts as a mode change (the app’s reading). The servo can keep a value after disconnect, so the evidence is whether the surface follows the servo or the stick. Whether autopilot-held trims are accepted is not settled (N1); the inference limits are the app’s own.',
    cite: ['NATO 29-1', 'NATO 29-2', 'NATO 21-6', 'NATO 21-7', 'App dictionary.ts lines 204, 599, 612-614'], judgement: true,
    needs: 'rows {117} and {108}, or rows {8}, {11} and {138} to infer; or write the modes in each point’s note',
  }),
  def({
    id: 'pitch-augmentation', title: 'Pitch augmentation noted', severity: 'advisory', scope: 'set', interval: 'W of every point',
    why: 'Each test point’s configuration includes the stability-augmentation status. MIL accepts zero control gradients when augmentation supplies the stability, so augmentation is noted, not failed: the gradient then describes the augmented aircraft, whose control and trim properties must still read the same way to the pilot. The 1e−4 threshold is engineering judgement (in effect zero).',
    cite: ['NATO 29-1', 'MIL p.40', 'Cook p.34'], judgement: true, needs: 'row {10}',
  }),
  def({
    id: 'gradient', title: 'Result: stick-fixed trim gradient', severity: 'info', scope: 'set', interval: 'U',
    why: 'A negative elevator-to-trim gradient means stable and a horizontal line neutral; MIL states the same sense in speed terms (nose-down control to fly faster). Trim curves can be non-linear from power, and the course treats the stick-fixed case only. From one gradient the static margin needs the tail volume ratio and elevator lift slope of X-Plane’s model, so it is not computed; with two or more CG lines it follows as K_n = h_n − h from the extrapolated neutral point. The |t| ≥ 3 line and the curvature and outlier tests are engineering judgement.',
    cite: ['FD10 slide 31', 'FD10 slide 32', 'Cook p.46', 'Cook p.48', 'MIL p.40', 'FD12b p.26', 'Cook p.47', 'FD10 slide 25'], judgement: true,
    needs: 'Needs trim-variable and cl-definition',
  }),
]

const DEF = new Map(STATIC_DEFS.map((x) => [x.id, x]))
const d = (id: string): CheckDef => DEF.get(id) as CheckDef
const KIND = 'static' as const

/** The questions the sources do not settle (shown under "Not settled by the sources — ask on EdDiscussion"). */
export const STATIC_OPEN: Readonly<Record<'N1' | 'N2' | 'N3' | 'N4', Omit<OpenItem, 'id'>>> = {
  N1: {
    title: 'Autopilot-held trim points',
    question: 'Are autopilot-held trim points accepted? The brief never mentions the autopilot. The lectures mention it only as raising phugoid damping, a dynamic-test issue, and elsewhere name the auto-throttle and fly-by-wire automatic trim, not the autopilot. NATO lists autopilot status as an item to record and calls stability tests open loop; its one line in favour of an autopilot is about helicopter envelope tests. No source approves or forbids autopilot-held trims.',
    meanwhile: 'Declare who flew pitch in each point (the point notes) and ask.',
    citations: formatCitations(['B pp.1-9', 'FD13 p.13', 'FD05 p.12', 'FD05 p.15', 'NATO 15-4', 'NATO 29-1', 'NATO 12A-8']),
  },
  N2: {
    title: 'Lateral-directional static stability',
    question: 'Does A2.1(b) also expect lateral-directional static stability? It says static and dynamic stability with no longitudinal or lateral label, while the brief’s hints say “Pay attention to longitudinal/lateral requirements in the questions – these have been specified to manage your workload”. The lecture’s static flight-test section is longitudinal only, with lateral-directional tests only under dynamic stability; NATO’s static lateral-directional test is the steady sideslip. This checklist covers longitudinal static stability only.',
    meanwhile: 'Ask under A2.1(b) on EdDiscussion.',
    citations: formatCitations(['B p.4', 'B p.7', 'FD12b pp.25-28', 'FD12b p.35', 'NATO 15-5']),
  },
  N3: {
    title: 'One CG, no neutral point',
    question: 'Is a single-CG gradient without a neutral point enough? The brief names no static-stability quantity. The lectures and Cook find the neutral point from several CG lines, and the lectures note that CG can be changed in X-Plane 12 and that a CG change gives data for another line, a hint that several CG positions are expected.',
    meanwhile: 'Report the gradient and its sign, say a neutral point needs more CG positions, and ask.',
    citations: formatCitations(['B p.7', 'FD12b p.28', 'FD10 slide 32', 'Cook p.48']),
  },
  N4: {
    title: 'X-Plane’s trim scaling',
    question: 'How many stabiliser degrees one unit of _trim,_elev is (G), whether nose-up and nose-down trim are scaled alike, and, without a trimmable stabiliser, whether X-Plane’s elevator columns already include the trim: no source and no logged channel gives it.',
    meanwhile: 'Check the trim system in Plane Maker; state the trim type and G you used.',
    citations: formatCitations(['NATO 21-7', 'BS slide 20']),
  },
}

// ------------------------------------------------------------------ the plot's channels

const RHO0 = 0.0023769 // slug/ft³
const KT = 1.68781 // ft/s per kt

/** The kind of pitch control a Y channel is: elevator (degrees or ratio), trim, a combination (δ_eq), or other. */
export function classifyY(ds: Dataset, yId: string | null): { kind: YKind; sign: 1 | -1; unit: 'deg' | 'ratio' } {
  const ch = yId ? channelById(ds, yId) : undefined
  if (!ch) return { kind: 'other', sign: 1, unit: 'deg' }
  if (ch.derived) {
    const refs = refsOf(ds, ch)
    const degRef = [...refs].some((r) => /^elev\d_deg/.test(r) || /^\[?elev\d,__deg/.test(r))
    const ratioRef = refs.has('elev_surf') || refs.has('_elev,_surf')
    const trimRef = refs.has('trim_elev') || refs.has('_trim,_elev')
    const elev = degRef || ratioRef
    const sign: 1 | -1 = degRef ? 1 : ratioRef ? -1 : 1
    const unit = degRef ? 'deg' : 'ratio'
    if (elev && trimRef) return { kind: 'combined', sign, unit }
    if (elev) return { kind: 'elevator', sign, unit }
    if (trimRef) return { kind: 'trim', sign: 1, unit: 'ratio' }
    return { kind: 'other', sign: 1, unit: 'deg' }
  }
  if (/^elev\d,__deg$/.test(ch.token)) return { kind: 'elevator', sign: 1, unit: 'deg' }
  if (ch.token === '_elev,_surf') return { kind: 'elevator', sign: -1, unit: 'ratio' }
  if (ch.token === '_trim,_elev') return { kind: 'trim', sign: 1, unit: 'ratio' }
  return { kind: 'other', sign: 1, unit: 'deg' }
}

/**
 * Every name a formula channel refers to, following formula channels it uses (by their slug) recursively: aliases,
 * ids and raw tokens (without brackets).
 */
export function refsOf(ds: Dataset, ch: Channel, seen = new Set<string>()): Set<string> {
  const out = new Set<string>()
  if (!ch.derived || seen.has(ch.id)) return out
  seen.add(ch.id)
  let refs: string[]
  try {
    refs = compileExpression(ch.derived.expression).refs
  } catch {
    return out
  }
  for (const raw of refs) {
    const ref = raw.replace(/^\[|\]$/g, '').trim()
    out.add(ref)
    const formula = ds.channels.find((c) => c.derived && (c.id === ref || c.id === `fx:${ref}` || channelAlias(c) === ref))
    if (formula) for (const r of refsOf(ds, formula, seen)) out.add(r)
  }
  return out
}

/** The elevator channel behind a trim curve: degrees (row 74) else the row-11 ratio. */
function elevatorChannel(ds: Dataset): { ch: Channel; sign: 1 | -1; unit: 'deg' | 'ratio' } | null {
  const deg = findChannel(ds, 'elev1,__deg')
  if (deg) return { ch: deg, sign: 1, unit: 'deg' }
  const ratio = findChannel(ds, '_elev,_surf')
  return ratio ? { ch: ratio, sign: -1, unit: 'ratio' } : null
}

/**
 * G and the equivalent-elevator gradient: e = c0 + c1·C_L + s_e·G·trim through the point means (s_e = +1 for degrees,
 * −1 for _elev,_surf), so δ_eq = e − s_e·G·trim and dδ_eq/dC_L = c1. null without enough points or variation.
 */
export function fitEquivalentElevator(cl: readonly number[], elevator: readonly number[], trim: readonly number[], sign: 1 | -1): EquivalentElevator | null {
  const fit = twoVariableFit(cl as number[], trim as number[], elevator as number[])
  if (!fit) return null
  return { G: sign * fit.c[2], seG: fit.se[2], slope: fit.c[1], seSlope: fit.se[1], r2: fit.r2, n: fit.n, sign }
}

// ------------------------------------------------------------------ per-point measurements

interface PointCtx {
  point: TestPoint
  a: number
  b: number
  seconds: number
  checks: Check[]
  /** Point means used by the set checks */
  x: number
  y: number
  elev: number
  trim: number
  alpha: number
  kias: number
  keas: number
  mach: number
  cg: number
  lever: number
  n1: number
  thrust: number
  clW: number
  /** The rounded configuration "flaps 0, slats 0, speedbrake 0, gear 0" */
  configKey: string | null
  configMeans: number[]
  pitch: PitchSource | null
  /** Autopilot mode codes logged (rows 108/117), and whether one changed inside the point */
  modesLogged: boolean
  modesChanged: boolean
  /** A selected value (altitude, speed, vertical speed) changed inside the point: noted, not a mode change */
  setpointsChanged: boolean
  astab: number
  speedDrift: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

function meanOf(ch: Channel | null, a: number, b: number): number {
  return ch ? summary(ch.values, a, b).mean : NaN
}

/** The force throttle-fixed reads when no lever is logged: the summed thrust, else the summed engine power. */
interface ForceInfo {
  kind: 'thrust' | 'power'
  channels: readonly Channel[]
  /** The log's largest summed |force|: its 99th percentile, so that one spike does not set it (NaN when none is finite) */
  scale: number
}

function forceOf(thrusts: readonly Channel[], powers: readonly Channel[], rows: number): ForceInfo | null {
  const channels = thrusts.length ? thrusts : powers
  if (!channels.length) return null
  const abs = Array.from(sumChannels(channels, 0, rows), Math.abs).filter(Number.isFinite).sort((x, y) => x - y)
  return { kind: thrusts.length ? 'thrust' : 'power', channels, scale: abs.length ? abs[Math.min(abs.length - 1, Math.floor(0.99 * abs.length))] : NaN }
}

/**
 * The summed force's range over rows [a, b), smoothed ±1 s inside them, as a share of its level: its mean, but never
 * less than IDLE_SHARE of the log's largest force (nor of the largest inside the rows). A point near idle, whose mean is
 * near zero, is then judged on an absolute band instead of a ratio that blows up.
 */
function forceRange(f: ForceInfo, time: Float64Array, a: number, b: number): { rel: number; floored: boolean } {
  const smoothed = smoothInside(sumChannels(f.channels, a, b), time.subarray(a, b), 0, b - a, 1)
  const s = summary(smoothed, 0, smoothed.length)
  if (!s.n) return { rel: NaN, floored: false }
  const floor = IDLE_SHARE * Math.max(Number.isFinite(f.scale) ? f.scale : 0, Math.abs(s.min), Math.abs(s.max))
  const level = Math.max(Math.abs(s.mean), floor)
  return { rel: s.range === 0 ? 0 : level > 0 ? s.range / level : NaN, floored: floor > Math.abs(s.mean) }
}

/** The criterion of near-stall, every condition the check applies (the V_S lines borrowed from NATO 13-5 and 15-12, the rest engineering judgement). */
const NEAR_STALL_CRITERION = 'never fails, and the point stays in the fit: warn if the lift deficit against the lift line > 3 %, the local lift slope < 0.7 of the line, KIAS < 1.2 V_S or α within 2° of α_stall (V_S and α_stall when set); info if > 2 %, < 0.85, < 1.3 V_S, within 4°, or the highest-α point slowing by more than 2 kt/min; pass otherwise (the lift line: a straight fit of C_L on α through the lowest-α 60 % of the points, at least 3)'

/** configuration-match when two configurations are equally common: the set's own cannot be told. */
const CONFIG_TIE = 'Needs one commonest configuration: two configurations are equally common, so put each in its own group and plot them separately'

/** The badge of a point left out only for another configuration: plot it on its own curve, do not refly it. */
const OTHER_CONFIGURATION_LABEL = 'Plot separately'

/** thrust-method without a setting row when N1 or the force varies between points. */
const METHOD_VARIES = 'row {25}: without the lever, N1 or the force changes with speed at a fixed setting too, so idle and re-set power look alike'

/** The verdict's reason when three or more used points leave fewer than three with a C_L (a data gap, not too few points). */
const CL_MISSING = 'fewer than 3 used points have a C_L: check the C_L channel or its inputs at the others'

/** The finite larger of two values (NaN when neither is finite). */
function finiteMax(x: number, y: number): number {
  return Number.isFinite(x) ? (Number.isFinite(y) ? Math.max(x, y) : x) : y
}

/** Runs the static checklist on the points of a trim curve. */
export function runStaticChecks(input: StaticInput): StaticReport {
  const { ds } = input
  const settings = input.settings ?? {}
  const P = input.points.filter((p) => p.end > p.start)
  const time = ds.elapsed
  const speedCh = airspeedChannels(ds)[0] ?? null
  const xCh = input.xId ? (channelById(ds, input.xId) ?? null) : null
  const yCh = input.yId ? (channelById(ds, input.yId) ?? null) : null
  const yInfo = classifyY(ds, input.yId)
  const elevInfo = elevatorChannel(ds)
  const trimCh = findChannel(ds, '_trim,_elev')
  const stick = findChannel(ds, '_elev,stick')
  const vvi = findChannel(ds, '__VVI,__fpm')
  const palt = findChannel(ds, 'p-alt,ftMSL')
  const vpath = findChannel(ds, 'vpath,__deg')
  const q = findChannel(ds, '____Q,deg/s')
  const nz = findChannel(ds, 'Gload,norml')
  const theta = findChannel(ds, 'pitch,__deg')
  const phi = findChannel(ds, '_roll,__deg')
  const beta = findChannel(ds, '_beta,__deg')
  const alpha = findChannel(ds, 'alpha,__deg')
  const kias = findChannel(ds, '_Vind,_kias')
  const keas = findChannel(ds, '_Vind,_keas')
  const mach = findChannel(ds, '_Mach,ratio')
  const agl = findChannel(ds, '_gear,ftagl')
  const weight = findChannel(ds, 'total,___lb')
  const sref = findChannel(ds, 'S-ref,ft*ft')
  const cg = findChannel(ds, '___cg,ftref')
  const astab = findChannel(ds, '_elev,astab')
  const levers = leverChannels(ds)
  // The throttle reaching each engine (row 26): an autothrottle or FADEC can move it with the lever still. When no
  // handle is logged leverChannels already returns it, so it is not counted twice.
  const leverIsActual = levers.length > 0 && /^thro\d,engin$/.test(levers[0].token)
  const actual = leverIsActual ? [] : engineChannels(ds, LEVER_ACTUAL)
  const atCode = findChannel(ds, '_auto,throt')
  const n1s = engineChannels(ds, N1)
  const thrusts = engineChannels(ds, THRUST)
  // Engine power as powerSteadiness and settling read it: X-Plane 12's engn hp, else the legacy power,_k,hp.
  const powers = engineChannels(ds, POWER_HP).length ? engineChannels(ds, POWER_HP) : engineChannels(ds, POWER_LEGACY)
  const force = forceOf(thrusts, powers, ds.rowCount)
  const turb = findChannel(ds, '_turb,_locl')
  const wind = findChannel(ds, '_wind,knots')
  const vwind = findChannel(ds, '_wind,v_fpm')
  const present = (tokens: readonly string[]) => tokens.map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
  // Mode codes say which modes were engaged; the selected values (dialled altitude, set speed and vertical speed) are
  // targets that change while hand-flying too, so a change in them is noted but is not a mode change.
  const modeCodes = present(['_fdir,_mode', '_mode,__alt', '_mode,hding', '_auto,throt'])
  const setpoints = present(['__set,__vvi', '_dial,__alt', '__set,speed'])

  // The set's thrust method over P (the flight-path check needs it per point; thrust-method reports it over U).
  const methodOver = (pts: readonly { a: number; b: number }[]) => thrustMethod(pts, levers, actual, n1s, thrusts, powers)
  const method = methodOver(P.map((p) => ({ a: p.start, b: p.end })))

  // ---- per point
  const ctxs: PointCtx[] = P.map((point) => {
    const a = Math.max(0, point.start)
    const b = Math.min(ds.rowCount, point.end)
    const seconds = b > a ? time[b - 1] - time[a] : 0
    const checks: Check[] = []
    const pid = { pointId: point.id }

    // time-base
    const tb = timeBase(ds, a, b)
    if (tb.kind === 'none') checks.push(notCheckable(d('time-base'), KIND, pid))
    else {
      const status: CheckStatus = tb.crosses ? 'fail' : tb.kind === 'sim' ? 'pass' : 'warn'
      checks.push(result(d('time-base'), KIND, status, `time from ${tb.source}${tb.crosses ? '; a reset or gap inside' : ''}`, 'pass: sim time, no reset or gap inside; warn: real time or another clock; fail: a reset (time steps back) or a gap (a step > max(1 s, 20 × the median step)) inside', status === 'fail' ? 'Re-cut the point inside one continuous stretch.' : '', pid))
    }

    // sample-rate: NATO sets no minimum rate for trim data (15-5: it may be recorded by hand), so a low rate only warns
    // (record-length keeps the sample-count floor) and an isolated dropout, which does not spoil a quasi-steady mean, is
    // only noted. Only a point with no rate at all (one sample) fails.
    const sr = sampleRate(ds, a, b)
    {
      let status: CheckStatus = !Number.isFinite(sr.rate) ? 'fail' : atLeast(sr.rate, 1) ? 'pass' : 'warn'
      if (status === 'pass' && sr.dropouts > 0) status = 'info'
      const sparse = status === 'warn' && !atLeast(sr.rate, 0.2)
      const hint = status === 'pass' ? '' : status === 'info' ? 'Isolated dropouts: harmless for a quasi-steady trim point.' : status === 'fail' ? 'No sample rate: the point spans no time.' : sparse ? 'Sparse: fewer than one sample per 5 s, the rate NATO records its classical climb tests at; log at 10 writes per second.' : 'Log at 10 writes per second.'
      checks.push(result(d('sample-rate'), KIND, status, `${fmt(sr.rate, 3)} Hz${sr.dropouts ? `, ${sr.dropouts} dropout${sr.dropouts === 1 ? '' : 's'}` : ''}`, 'pass ≥ 1 Hz; info: ≥ 1 Hz with isolated dropouts (steps over 3 × the median); warn < 1 Hz (sparse below 0.2 Hz); each line with a 2 % allowance; fail only with no rate (the point spans no time); the record-length check judges whether there are enough samples', hint, pid))
    }

    // record-length
    const n = speedCh ? summary(speedCh.values, a, b).n : 0
    if (!speedCh) checks.push(notCheckable(d('record-length'), KIND, pid))
    else {
      const status: CheckStatus = seconds >= 30 && n >= 30 ? 'pass' : seconds >= 5 && n >= 10 ? 'warn' : 'fail'
      checks.push(result(d('record-length'), KIND, status, `${fix(seconds, 1)} s, ${n} samples`, 'pass ≥ 30 s and ≥ 30 airspeed samples; warn otherwise down to 5 s and 10 samples; fail < 5 s or < 10 samples', status === 'pass' ? '' : status === 'warn' ? 'Hold trim points for 30–60 s when you fly them.' : 'Too short to judge: re-cut a longer stretch or refly.', pid))
    }

    // speed-steady (needed by stabilised): every band on one measure, the speed change over the point (as Find steady
    // points measures it), so a long point drifting slowly can no longer pass on the rate and fail on the change
    let speedStatus: CheckStatus | null = null
    let speedDrift = NaN
    let speedChange = NaN
    let speedScatter = NaN
    if (speedCh) {
      const tr = trend(speedCh.values, time, a, b)
      speedDrift = tr.slope * 60
      speedChange = Math.abs(tr.slope * tr.seconds)
      speedScatter = 2 * tr.residualSd
      speedStatus = !Number.isFinite(speedChange) ? 'fail' : speedChange <= 1 && speedScatter <= 1 ? 'pass' : speedChange <= 2 && speedScatter <= 2 ? 'warn' : 'fail'
    }

    // stabilised
    {
      const st = settling(ds, a, b, 120)
      if (st.by === null || (!st.found && st.lookback < 60)) checks.push(notCheckable(d('stabilised'), KIND, { ...pid, needs: st.by === null ? undefined : 'Not checkable — the log or a segment starts less than 60 s before the point and holds no power change' }))
      else {
        const tSet = st.tSet ?? 0
        // Without a thrust, power or N1 row the force trend is not measured, and an unmeasured trend is not a flat one.
        const trendKnown = Number.isFinite(st.thrustTrend)
        const flat = trendKnown && Math.abs(st.thrustTrend) <= 1
        const status: CheckStatus = tSet >= 60 ? 'pass' : flat && speedStatus === 'pass' ? 'info' : 'warn'
        const hint = status === 'info' ? 'Set soon after a power change, but already steady.' : status !== 'warn' ? '' : trendKnown ? 'Still settling: wait longer after a power change before the point.' : 'Set soon after a power change and the force is not logged: log row 34, 35 or 41 to show it settled, or wait longer before the point.'
        checks.push(result(d('stabilised'), KIND, status, `${st.found ? `set ${fix(tSet, 0)} s after a power change` : `no power change in the ${fix(st.lookback, 0)} s before`}${trendKnown ? `; force trend ${signed(st.thrustTrend, 1)} %` : '; force trend not measured (no thrust, power or N1 row)'}`, 'pass ≥ 60 s since the last power change (looked for up to 120 s back: a lever more than 0.002 from its mean over the point, else the force more than 1 % from it); info: sooner, but the force trend over the point ≤ 1 % and the speed steady; warn: sooner and still settling, or the force trend not measured (never fails)', hint, pid))
      }
    }

    if (speedCh) {
      checks.push(result(d('speed-steady'), KIND, speedStatus ?? 'fail', `change ${fix(speedChange, 2)} kt over the point (drift ${signed(speedDrift, 2)} kt/min), 2σ ${fix(speedScatter, 2)} kt`, 'pass: change over the point ≤ 1 kt and 2σ ≤ 1 kt; warn: ≤ 2 kt and 2σ ≤ 2 kt (the steady-point default); fail beyond', speedStatus === 'pass' ? '' : speedStatus === 'warn' ? 'Drifting: say so in the report.' : 'The speed was not held: the point would not pass Find steady points.', pid))
    } else checks.push(notCheckable(d('speed-steady'), KIND, pid))

    // The vertical path, read by flight-path and throttle-fixed (a force at a fixed setting changes with height)
    const vs = vvi ? summary(vvi.values, a, b) : null
    const altDrift = palt ? trend(palt.values, time, a, b).slope * 60 : NaN
    const vMean = vs?.mean ?? altDrift
    const notLevel = Math.abs(vMean) > 100 || Math.abs(altDrift) > 100

    // flight-path
    if (!vvi && !palt) checks.push(notCheckable(d('flight-path'), KIND, pid))
    else {
      const vSd = vs?.sd ?? NaN
      const speedFts = meanOf(findChannel(ds, 'Vtrue,_ktas'), a, b) * KT
      const gamma = vpath ? meanOf(vpath, a, b) : Number.isFinite(speedFts) && speedFts > 0 ? (Math.asin(Math.max(-1, Math.min(1, vMean / 60 / speedFts))) * 180) / Math.PI : NaN
      const qs = q ? summary(q.values, a, b) : null
      let dn = NaN
      if (nz && theta && phi) {
        let sum = 0
        let k = 0
        for (let i = a; i < b; i += 1) {
          const c = Math.cos((theta.values[i] * Math.PI) / 180) * Math.cos((phi.values[i] * Math.PI) / 180)
          if (Number.isFinite(c)) {
            sum += c
            k += 1
          }
        }
        dn = meanOf(nz, a, b) - (k ? sum / k : NaN)
      }
      let status = worse(
        grade(vSd, 100, 200),
        qs ? grade(Math.abs(qs.mean), 0.1, 0.2) : null,
        grade(Math.abs(dn), 0.02, 0.05),
        Math.abs(gamma) > 10 ? 'fail' : null,
      )
      let hint = ''
      const level = Math.abs(vMean) <= 100 && !(Math.abs(altDrift) > 100)
      if (method.kind === 'power-for-level' && !level) {
        status = worse(status, 'warn')
        hint = 'Not level in a level set: its thrust, and the thrust moment, differ from the level trim.'
      } else if (method.kind === 'unknown' && !level) {
        // Without a power row a level set cannot be told from a constant-power one: a climb or descent is only noted.
        if (status === 'pass') status = 'info'
        hint = 'Not level, and the thrust method is unknown: log row 25 (throttle) so a level set can be told from a constant-power one.'
      }
      if (status === 'fail') hint = 'Not a steady flight path at 1 g: re-cut or refly the point.'
      const setRule =
        method.kind === 'power-for-level'
          ? 'level set: a point not level (|mean VVI| > 100 fpm or altitude drift > 100 ft/min) warns'
          : method.kind === 'unknown'
            ? 'thrust method unknown: a point not level gets an info note (log row 25)'
            : 'zero-thrust or constant-power set: any steady climb or descent with |γ| ≤ 10°'
      checks.push(result(d('flight-path'), KIND, status, `VVI ${signed(vMean, 0)} fpm (σ ${fix(vSd, 0)}), altitude drift ${signed(altDrift, 0)} ft/min, γ ${signed(gamma, 2)}°${qs ? `, mean Q ${signed(qs.mean, 3)} deg/s` : ''}, n_z − cosθcosφ ${signed(dn, 4)}`, `pass: σ(VVI) ≤ 100 fpm, |mean Q| ≤ 0.1 deg/s, |n_z − cosθcosφ| ≤ 0.02 and |γ| ≤ 10°; warn: σ(VVI) ≤ 200 fpm, |mean Q| ≤ 0.2 deg/s, |n_z − cosθcosφ| ≤ 0.05; fail beyond, or |γ| > 10°; ${setRule}`, hint, pid))
    }

    // wings-level
    if (!phi && !beta) checks.push(notCheckable(d('wings-level'), KIND, pid))
    else {
      const ps = phi ? summary(phi.values, a, b) : null
      const bs = beta ? summary(beta.values, a, b) : null
      const status = worse(
        ps ? grade(Math.abs(ps.mean), 3, 10) : null,
        ps ? grade(ps.sd, 1, 2) : null,
        bs ? grade(Math.abs(bs.mean), 2, 5) : null,
      )
      checks.push(result(d('wings-level'), KIND, status, `bank ${ps ? `${signed(ps.mean, 1)}° (σ ${fix(ps.sd, 2)})` : 'not logged'}, sideslip ${bs ? `${signed(bs.mean, 2)}°` : 'not logged'}`, 'pass |φ| ≤ 3°, σφ ≤ 1°, |β| ≤ 2°; warn ≤ 10°, 2°, 5°; fail beyond', status === 'pass' ? '' : status === 'warn' ? 'Note the bank or sideslip in the report.' : 'Not straight, symmetric flight: re-cut or refly.', pid))
    }

    // throttle-fixed: the sources fix the setting (MIL p.40 (a): throttle not moved; Cook p.47), so the setting decides
    // when it is logged: the lever and the throttle reaching the engines (row 26), which an autothrottle or FADEC can
    // move with the lever still. N1 (an absolute band: it never crosses zero), else thrust or engine power, stands in
    // only without a setting row; beside one, N1 moving (or, under an engaged autothrottle, N1 or the force) only warns.
    const ps = powerSteadiness(ds, a, b)
    {
      const setting = finiteMax(ps.leverRange, ps.actualRange)
      const fr = force ? forceRange(force, time, a, b) : null
      const forceText = fr && Number.isFinite(fr.rel) ? `${force?.kind} range ${pct(fr.rel)} of its level${fr.floored ? ' (judged against a quarter of the log’s largest force)' : ''}` : ''
      const n1Text = Number.isFinite(ps.n1Range) ? `N1 range ${fix(ps.n1Range, 2)} %pt` : ''
      // The stand-in for the setting. A force change shows the setting moved only in a level point whose mean is above
      // the floor: at a fixed setting it changes with height, and near idle it crosses zero.
      const proxy: { status: CheckStatus; measured: string; conclusive: boolean } | null = n1Text
        ? { status: grade(ps.n1Range, 0.5, 1.5) ?? 'fail', measured: n1Text, conclusive: true }
        : fr && Number.isFinite(fr.rel)
          ? { status: grade(fr.rel, 0.02, 0.05) ?? 'fail', measured: `${forceText}${notLevel ? ' (not level: it changes with height)' : ''}`, conclusive: !fr.floored && !notLevel }
          : null
      const at = atCode ? summary(atCode.values, a, b) : null
      const atOn = at !== null && at.n > 0 && (at.max !== 0 || at.min !== 0)
      let status: CheckStatus | null = null
      let measured = ''
      let hint = ''
      if (Number.isFinite(setting)) {
        status = grade(setting, 0.005, 0.02) ?? 'fail'
        // Only beside a still setting: when the setting moved, it explains the power change.
        const moved = status === 'pass' && proxy !== null && (atOn ? proxy.conclusive && proxy.status !== 'pass' : n1Text !== '' && ps.n1Range > 1.5)
        if (moved) {
          status = 'warn'
          hint = atOn ? 'The autothrottle was engaged and the power moved: disconnect it for trim points, or log row 26 to show the throttle reaching the engines.' : 'N1 moved with the lever still: an autothrottle or FADEC may have changed the power; log rows 26 and 117 to show it.'
        }
        const settingText = [
          Number.isFinite(ps.leverRange) ? `${leverIsActual ? 'throttle reaching the engines' : 'lever'} range ${fmt(ps.leverRange, 2)}` : '',
          actual.length && Number.isFinite(ps.actualRange) ? `throttle reaching the engines range ${fmt(ps.actualRange, 2)}` : '',
        ].filter(Boolean).join(', ')
        const context = [forceText, n1Text].filter(Boolean).join('; ')
        measured = `${settingText}${atOn ? '; autothrottle engaged' : ''}${context ? `; ${context} (${moved ? 'moved with the setting still' : 'not judged: the setting decides'})` : ''}`
      } else if (proxy) {
        status = proxy.conclusive || proxy.status !== 'fail' ? proxy.status : 'warn'
        measured = proxy.measured
        if (!proxy.conclusive && proxy.status !== 'pass') hint = 'Without the lever the force cannot show that the setting moved (it changes with height, and near idle crosses zero): log row 25 (throttle).'
      }
      if (status === null) checks.push(notCheckable(d('throttle-fixed'), KIND, pid))
      else {
        if (status === 'fail') hint = 'The power was changed inside the point: re-cut it to the stretch after the last change (Re-cut this point) and check again.'
        checks.push(result(d('throttle-fixed'), KIND, status, measured, 'the setting decides when logged (the lever, and the throttle reaching the engines when row 26 is logged): range ≤ 0.005, warn ≤ 0.02, fail beyond; with the setting still (≤ 0.005), N1 moving > 1.5 %pt warns, and so does, with the autothrottle engaged (row 117), N1 or a conclusive force beyond its pass band; without a setting row, N1 range ≤ 0.5 %pt, warn ≤ 1.5 %pt, fail beyond, else thrust (else engine power) range ≤ 2 %, warn ≤ 5 %, fail beyond, of its level (its mean, but never less than a quarter of the log’s largest, its 99th percentile, or of the point’s own largest); a force is conclusive only in a level point (|mean VVI| ≤ 100 fpm and altitude drift ≤ 100 ft/min) whose mean is above that floor, and otherwise warns at worst (smoothed ±1 s, the setting raw)', hint, pid))
      }
    }

    // controls-fixed
    if (!stick && !elevInfo) checks.push(notCheckable(d('controls-fixed'), KIND, pid))
    else {
      const ss = stick ? summary(stick.values, a, b) : null
      const xs: number[] = []
      if (stick) for (let i = a; i < b; i += 1) if (Number.isFinite(stick.values[i])) xs.push(stick.values[i])
      xs.sort((u, v) => u - v)
      const med = xs.length ? xs[xs.length >> 1] : NaN
      const es = elevInfo ? summary(elevInfo.ch.values, a, b) : null
      const [ep, ew] = elevInfo?.unit === 'ratio' ? [0.005, 0.015] : [0.1, 0.3]
      let status = worse(ss ? grade(ss.range, 0.02, 0.05) : null, es ? grade(es.sd, ep, ew) : null)
      let hint = status === 'fail' ? 'A pilot input inside the point: re-cut it to the still part.' : ''
      if (status === 'pass' && Math.abs(med) > 0.03) {
        // Cook's controls-fixed procedure holds the column at the trim setting (Cook pp.45–46): noted, not warned.
        status = 'info'
        hint = 'Still but held off-centre: controls fixed as in Cook’s procedure, not trimmed hands-off; the held input is part of the elevator angle, so plot the elevator rather than the trim.'
      }
      checks.push(result(d('controls-fixed'), KIND, status, `${ss ? `stick range ${fmt(ss.range, 2)} (median ${signed(med, 3)})` : 'stick not logged'}; ${es ? `elevator σ ${fmt(es.sd, 2)} ${elevInfo?.unit === 'ratio' ? '(ratio)' : '°'}` : 'elevator not logged'}`, 'pass: stick range ≤ 0.02 and elevator σ ≤ 0.1° (ratio 0.005); info: still, but the stick held off-centre (|median| > 0.03); warn: ≤ 0.05 and 0.3° (0.015); fail beyond', hint, pid))
    }

    // trim-fixed (the largest change within 0.5 s can never exceed the range, so it only tells a step from a drift)
    const trimRange = trimCh ? summary(trimCh.values, a, b).range : NaN
    if (!trimCh) checks.push(notCheckable(d('trim-fixed'), KIND, pid))
    // The trim row is logged but empty inside the point: not a moved trim.
    else if (!Number.isFinite(trimRange)) checks.push(notCheckable(d('trim-fixed'), KIND, { ...pid, needs: 'Not checkable — the trim channel has no samples inside the point' }))
    else {
      const range = trimRange
      const step = largestChangeWithin(trimCh.values, time, a, b, 0.5)
      const status: CheckStatus = range <= 0.002 ? 'pass' : range <= 0.02 ? 'warn' : 'fail'
      checks.push(result(d('trim-fixed'), KIND, status, `trim range ${fmt(range, 2)}, largest change in 0.5 s ${fmt(step, 2)}`, 'pass: range ≤ 0.002; warn: ≤ 0.02 (an auto-trim drift or a small step); fail > 0.02 (the largest change within 0.5 s tells a step from a drift)', status === 'fail' ? (step > 0.02 ? 'Trim step inside the point: split it at the step or leave it out.' : 'The trim moved: re-cut or leave the point out.') : status === 'warn' ? 'The trim moved a little (an auto-trim drift or a small step): the mean trim still describes the point.' : '', pid))
    }

    // configuration-constant
    const config = configuration(ds, a, b)
    if (!config.surfaces.length) checks.push(notCheckable(d('configuration-constant'), KIND, { ...pid, needs: 'row {13}' }))
    else {
      const moved = config.surfaces.some((s) => s.range > 0.001) || (config.gear !== null && config.gear.range > 0.001)
      const status: CheckStatus = moved ? 'fail' : config.gear ? 'pass' : 'warn'
      checks.push(result(d('configuration-constant'), KIND, status, configText(config, 0.001), 'pass: every range ≤ 0.001; warn: gear not logged; fail: anything moved', status === 'fail' ? 'The configuration changed inside the point: re-cut or refly.' : status === 'warn' ? 'Log row 14 (Gear & brakes).' : '', pid))
    }
    const configMeans = [...config.surfaces.map((s) => s.mean), ...(config.gear ? [config.gear.mean] : [])]
    const configKey = config.surfaces.length ? configMeans.map((v) => r2(v).toFixed(2)).join(',') : null

    // envelope
    if (!agl) checks.push(notCheckable(d('envelope'), KIND, pid))
    else {
      const h = summary(agl.values, a, b).min
      const lim = settings.limits ?? {}
      const kmax = kias ? summary(kias.values, a, b).max : NaN
      const mmax = mach ? summary(mach.values, a, b).max : NaN
      const over = (lim.vmoKias && kmax > lim.vmoKias - 10) || (lim.mmo && mmax > lim.mmo - 0.02)
      const groundFt = TRIM_CHECK_THRESHOLDS.heightAglFt.value
      const status: CheckStatus = h < groundFt || over ? 'warn' : 'pass'
      checks.push(result(d('envelope'), KIND, status, `lowest ${fix(h, 0)} ft AGL${lim.vmoKias || lim.mmo ? '' : '; speed limits not set'}`, `pass: lowest gear height ≥ ${groundFt} ft AGL (the app’s stand-in for one wingspan), and KIAS ≤ V_MO − 10 kt and M ≤ M_MO − 0.02 when set; warn otherwise (never fails)`, h < groundFt ? 'Ground effect may change the downwash at the tail and the lift curve.' : over ? 'A set limit was exceeded.' : '', pid))
    }

    // weather
    if (!turb && !wind && !vwind) checks.push(notCheckable(d('weather'), KIND, pid))
    else {
      const tbm = turb ? summary(turb.values, a, b).max : NaN
      const wr = wind ? summary(wind.values, a, b).range : NaN
      const wv = vwind ? maxAbs(vwind.values, a, b) : NaN
      const ok = !(tbm > 0.01) && !(wr > 2) && !(wv > 50)
      checks.push(result(d('weather'), KIND, ok ? 'pass' : 'warn', `turbulence ${fmt(tbm, 2)}, wind range ${fmt(wr, 2)} kt, |vertical wind| ${fmt(wv, 2)} fpm`, 'pass: turbulence ≤ 0.01, wind-speed range ≤ 2 kt and |vertical wind| ≤ 50 fpm (a row not logged is skipped); warn otherwise (never fails)', ok ? '' : 'Set calm weather for trim points.', pid))
    }

    // autopilot evidence (set check later): inferred from the surface, stick and servo only without mode codes
    const pc = modeCodes.length ? null : pitchControlSource(ds, a, b)
    const modesChanged = modeCodes.some((c) => summary(c.values, a, b).range > 0)
    const setpointsChanged = setpoints.some((c) => summary(c.values, a, b).range > 0)

    const clW = (() => {
      const w = meanOf(weight, a, b)
      const v = meanOf(keas, a, b) * KT
      const s = sref ? meanOf(sref, a, b) : NaN
      const n0 = nz ? meanOf(nz, a, b) : 1
      return (n0 * w) / (0.5 * RHO0 * v * v * s)
    })()

    return {
      point,
      a,
      b,
      seconds,
      checks,
      x: meanOf(xCh, a, b),
      y: meanOf(yCh, a, b),
      elev: elevInfo ? meanOf(elevInfo.ch, a, b) : NaN,
      trim: meanOf(trimCh, a, b),
      alpha: meanOf(alpha, a, b),
      kias: meanOf(kias, a, b),
      keas: meanOf(keas, a, b),
      mach: mach ? summary(mach.values, a, b).max : NaN,
      cg: meanOf(cg, a, b),
      lever: levers.length ? Math.max(...levers.map((c) => meanOf(c, a, b))) : NaN,
      n1: n1s.length ? Math.max(...n1s.map((c) => meanOf(c, a, b))) : NaN,
      thrust: thrusts.length ? thrusts.reduce((s, c) => s + meanOf(c, a, b), 0) : powers.length ? powers.reduce((s, c) => s + meanOf(c, a, b), 0) : NaN,
      clW,
      configKey,
      configMeans,
      pitch: pc ? pc.source : null,
      modesLogged: modeCodes.length > 0,
      modesChanged,
      setpointsChanged,
      astab: astab ? maxAbs(astab.values, a, b) : NaN,
      speedDrift,
    }
  })

  // ---- configuration-match (each point against the commonest configuration of P; when two configurations are
  // equally common the set's own cannot be told, so no point is judged against either). Configurations within the 0.01
  // match tolerance of a configuration's first point count as that one, so a rounding edge cannot split one in two.
  const within = (u: readonly number[], v: readonly number[]) => u.length === v.length && u.every((x, i) => Math.abs(x - v[i]) <= 0.01 + 1e-9)
  const configs: { values: readonly number[]; count: number }[] = []
  for (const c of ctxs) {
    if (c.configKey === null) continue
    const found = configs.find((k) => within(c.configMeans, k.values))
    if (found) found.count += 1
    else configs.push({ values: c.configMeans, count: 1 })
  }
  const configRanked = [...configs].sort((x, y) => y.count - x.count)
  const configTie = configRanked.length > 1 && configRanked[1].count === configRanked[0].count
  {
    const modal = configRanked[0]?.values ?? null
    const modalText = modal ? modal.map((v) => r2(v).toFixed(2)).join(',') : ''
    for (const c of ctxs) {
      const pid = { pointId: c.point.id }
      if (c.configKey === null || modal === null) {
        c.checks.push(notCheckable(d('configuration-match'), KIND, pid))
        continue
      }
      if (configTie) {
        c.checks.push(notCheckable(d('configuration-match'), KIND, { ...pid, needs: CONFIG_TIE }))
        continue
      }
      const same = within(c.configMeans, modal)
      const clean = modal.every((v) => Math.abs(v) <= 0.01)
      c.checks.push(result(d('configuration-match'), KIND, same ? 'pass' : 'fail', `${same ? 'same as the set' : 'differs from the set'} (${clean ? 'clean' : 'not clean'}: ${modalText})`, 'pass: every configuration mean within 0.01 of the set’s commonest configuration (configurations within 0.01 of each other count as one); fail: another configuration (plotted, but left out of this curve’s fit: plot it separately); not checkable when two configurations are equally common', same ? '' : 'Another configuration: put it in its own group and plot it separately (each configuration is its own trim curve).', pid))
    }
  }

  // ---- point verdicts before near-stall
  const CRITICAL = new Set(['time-base', 'sample-rate', 'record-length', 'speed-steady', 'flight-path', 'wings-level', 'throttle-fixed', 'controls-fixed', 'trim-fixed', 'configuration-constant', 'configuration-match'])
  const preStatus = (c: PointCtx): PointStatus => {
    if (c.checks.some((k) => CRITICAL.has(k.id) && k.status === 'fail')) return 'excluded'
    if (c.checks.some((k) => CRITICAL.has(k.id) && k.status === 'not-checkable')) return 'cannot-confirm'
    return 'used'
  }
  const candidates = ctxs.filter((c) => preStatus(c) === 'used')

  // ---- near-stall (lift line through the lowest 60 % by α of the candidates)
  {
    const clOf = (c: PointCtx) => (Number.isFinite(c.x) && isClAxis(xCh) ? c.x : c.clW)
    const usable = candidates.filter((c) => Number.isFinite(c.alpha) && Number.isFinite(clOf(c)))
    const sorted = [...usable].sort((u, v) => u.alpha - v.alpha)
    const base = sorted.slice(0, Math.max(3, Math.ceil(0.6 * sorted.length)))
    const line = base.length >= 3 ? linearFit(base.map((c) => c.alpha), base.map(clOf)) : null
    const highest = sorted[sorted.length - 1]
    for (const c of ctxs) {
      const pid = { pointId: c.point.id }
      if (!alpha) {
        c.checks.push(notCheckable(d('near-stall'), KIND, pid))
        continue
      }
      if (!line || !Number.isFinite(line.c1) || !usable.includes(c)) {
        c.checks.push(result(d('near-stall'), KIND, 'info', usable.includes(c) ? 'fewer than 3 points to draw the lift line' : 'not judged (the point is out on other checks)', NEAR_STALL_CRITERION, '', pid))
        continue
      }
      const predicted = line.c1 * c.alpha + line.c0
      const deficit = (predicted - clOf(c)) / predicted
      const idx = sorted.indexOf(c)
      const lower = idx > 0 ? sorted[idx - 1] : null
      const slopeRatio = lower && c.alpha - lower.alpha > 1e-6 ? (clOf(c) - clOf(lower)) / (c.alpha - lower.alpha) / line.c1 : NaN
      const lim = settings.limits ?? {}
      const vsRatio = lim.vsKias ? c.kias / lim.vsKias : NaN
      const margin = lim.alphaStallDeg ? lim.alphaStallDeg - c.alpha : NaN
      let status: CheckStatus = 'pass'
      if (deficit > 0.03 || slopeRatio < 0.7 || vsRatio < 1.2 || margin < 2) status = 'warn'
      else if (deficit > 0.02 || slopeRatio < 0.85 || vsRatio < 1.3 || margin < 4 || (c === highest && c.speedDrift < -2)) status = 'info'
      const marginText = Number.isFinite(margin) ? `, ${fix(margin, 1)}° below α_stall` : ''
      const driftText = c === highest && Number.isFinite(c.speedDrift) ? `, speed drift ${signed(c.speedDrift, 2)} kt/min (highest α)` : ''
      c.checks.push(result(d('near-stall'), KIND, status, `lift deficit ${pct(deficit)}${Number.isFinite(slopeRatio) ? `, local slope ${fix(slopeRatio, 2)} of the line` : ''}${Number.isFinite(vsRatio) ? `, ${fix(vsRatio, 2)} V_S` : ''}${marginText}${driftText}`, NEAR_STALL_CRITERION, status === 'warn' ? 'Near the stall: check the gradient with and without this point; leave it out (Left out) if the trim curve bends.' : status === 'info' ? 'Approaching the stall: watch the gradient’s curvature.' : '', pid))
    }
  }

  // ---- point verdicts (a near-stall warning is a note: no source removes such points, so the point stays in the fit
  // unless the user leaves it out)
  const excludedByUser = new Set(settings.fitExcluded ?? [])
  const points: PointReport[] = ctxs.map((c) => {
    let status = preStatus(c)
    const reasons: string[] = []
    const failed = c.checks.filter((k) => CRITICAL.has(k.id) && k.status === 'fail')
    if (status === 'excluded') reasons.push(...failed.map((k) => STATIC_REASON[k.id] ?? k.title.toLowerCase()))
    else if (status === 'cannot-confirm') reasons.push(...c.checks.filter((k) => CRITICAL.has(k.id) && k.status === 'not-checkable').map((k) => `${k.title.toLowerCase()}: not checkable`))
    else if (excludedByUser.has(c.point.id)) {
      status = 'left-out'
      reasons.push('left out by you')
    }
    // Left out only for another configuration: a valid point of another trim curve, plotted but left out of this
    // curve's fit (plot it separately), not one to refly or re-cut.
    const otherConfiguration = status === 'excluded' && failed.every((k) => k.id === 'configuration-match')
    if (otherConfiguration) status = 'plot-only'
    return {
      pointId: c.point.id,
      name: c.point.name,
      groupId: c.point.groupId,
      status,
      label: otherConfiguration ? OTHER_CONFIGURATION_LABEL : POINT_LABEL[status],
      reasons,
      checks: c.checks,
      worst: worstStatus(c.checks.map((k) => k.status)),
    }
  })
  const U = ctxs.filter((_, i) => points[i].status === 'used')
  const set: Check[] = []

  // The C_L the set checks fit against: the plotted x when it is a C_L axis, else n·W/(q̄S) at each point.
  const clAxis = isClAxis(xCh)
  const clBasis = clAxis ? 'the plotted C_L' : 'n·W/(q̄S) (the x axis is not a C_L)'

  // ---- trim-variable
  const yKind = yInfo.kind
  let deltaEq: StaticReport['deltaEq'] = null
  let equivalent: EquivalentElevator | null
  {
    const def0 = d('trim-variable')
    // Fitted against C_L, not a plotted speed, so the slopes' signs keep their meaning ("stable sign holds without G").
    const cl = U.map((c) => (clAxis ? c.x : c.clW))
    const needTrim = yKind === 'elevator' || yKind === 'combined'
    if ((needTrim && !trimCh) || (yKind === 'trim' && !elevInfo) || yKind === 'other') {
      set.push(
        yKind === 'other'
          ? notCheckable(def0, KIND, { needs: 'Needs a pitch control on the Y axis (elevator, trim or δ_eq)' })
          : notCheckable(def0, KIND, { needs: needTrim ? 'row {13}' : 'row {74} or {11}' }),
      )
    } else if (U.length < 2) {
      // The trim's travel between points and the slopes take two used points.
      set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    } else {
      const trims = U.map((c) => c.trim)
      const dTrim = trims.length ? Math.max(...trims) - Math.min(...trims) : NaN
      const elev = U.map((c) => c.elev)
      const fe = linearFit(cl, elev)
      const ft = linearFit(cl, trims)
      equivalent = elevInfo ? fitEquivalentElevator(cl, elev, trims, elevInfo.sign) : null
      const G = settings.gain && settings.gain > 0 ? settings.gain : equivalent?.G ?? NaN
      const seG = settings.gain ? 0 : equivalent?.seG ?? NaN
      let status: CheckStatus = 'pass'
      let hint = ''
      let trimType = settings.trimType ?? null
      const elevNeutral = Math.abs(fe.c1) < 2 * fe.seC1
      const trimSignificant = Math.abs(ft.c1) >= 3 * ft.seC1
      if (yKind === 'elevator') {
        if (dTrim > 0.005 && elevNeutral && trimSignificant) {
          status = 'warn'
          trimType ??= 'stabiliser'
          hint = `Elevator alone looks neutral while the trim moved by ${fmt(dTrim, 2)}: the trim acted outside the elevator column (a trimmable stabiliser); plot δ_eq or the trim.`
        } else if (dTrim > 0.005 && trimType !== 'elevator') {
          status = 'warn'
          hint = 'The trim moved between points: on a stabiliser-trimmed aircraft the elevator gradient leaves out the trim’s share (plot δ_eq); if the trim deflects the elevator itself the elevator is complete; say which (trim type) and see open item N4.'
        }
      } else if (yKind === 'trim') {
        const er = elev.length ? Math.max(...elev) - Math.min(...elev) : NaN
        const limit = elevInfo?.unit === 'ratio' ? 0.01 : 0.2
        if (er > limit) {
          status = 'warn'
          hint = 'The trim alone leaves out the elevator’s share: plot δ_eq.'
        }
      } else if (yKind === 'combined' && seG > 0.2 * Math.abs(G)) {
        status = 'warn'
        hint = 'G is poorly fixed by these points; see the gradient for G ± 25 %.'
      }
      const stableWithoutG = elevInfo
        ? Math.sign(ft.c1) === 1 && trimSignificant && (Math.sign(fe.c1) === -elevInfo.sign || elevNeutral)
        : false
      if (elevInfo && Number.isFinite(G) && G > 0) {
        const sym = elevInfo.unit === 'deg' ? 'elev1_deg' : 'elev_surf'
        const g2 = Number(G.toPrecision(2))
        deltaEq = {
          G,
          seG,
          name: 'Equivalent elevator δ_eq',
          unit: elevInfo.unit === 'deg' ? 'deg' : '',
          expression: elevInfo.sign === 1 ? `${sym} - ${g2} * trim_elev` : `${sym} + ${g2} * trim_elev`,
        }
      }
      const gText = Number.isFinite(G) ? `G ${fmt(G, 3)}${seG > 0 ? ` ± ${fmt(seG, 2)}` : settings.gain ? ' (given)' : ''}` : 'G not fixed'
      set.push(
        result(def0, KIND, status,
          `Y is ${yKind === 'combined' ? 'δ_eq (elevator and trim)' : yKind}; trim range over the used points ${fmt(dTrim, 2)}; elevator-only slope ${fmt(fe.c1, 3)} ± ${fmt(fe.seC1, 2)}, trim-only slope ${fmt(ft.c1, 3)} ± ${fmt(ft.seC1, 2)}; ${gText}${equivalent ? `; dδ_eq/dC_L ${fmt(equivalent.slope, 3)} ± ${fmt(equivalent.seSlope, 2)}` : ''}; trim type ${trimType ?? 'unknown'}${stableWithoutG ? '; stable sign holds without G' : ''}; slopes against ${clBasis}`,
          'pass: Y holds every pitch control that moved (δ_eq, or the elevator with a still trim or an elevator-trimmed aircraft); warn (Y the elevator): the trim moved > 0.005 between used points and either the elevator alone looks neutral (|slope| < 2 SE) while the trim slope is significant (≥ 3 SE), or the trim type is not declared elevator; warn (Y the trim): the elevator moved > 0.01 (ratio) or 0.2° between used points; warn (Y δ_eq): SE(G) > 20 % of G; never fails (fixed with Plot δ_eq or the trim type), but not checkable gives Cannot confirm',
          hint,
        ),
      )
    }
  }

  // ---- cl-definition
  {
    const def0 = d('cl-definition')
    const missing = [!weight ? '{63}' : '', !keas ? '{3}' : '', !sref ? '{68}' : ''].filter(Boolean)
    if (!xCh && missing.length) set.push(notCheckable(def0, KIND, { needs: `rows ${missing.join(', ')} (no C_L channel to plot)` }))
    else if (!xCh) set.push(notCheckable(def0, KIND, { needs: 'Needs a C_L channel on the x axis' }))
    else if (missing.length) set.push(notCheckable(def0, KIND, { needs: `rows ${missing.join(', ')}` }))
    else {
      const refs = xCh.derived ? refsOf(ds, xCh) : new Set<string>()
      const usesMax = [...refs].some((r) => /^(gross_lb|maxim_lb|gross,___lb|maxim,___lb)$/.test(r))
      const usesKias = [...refs].some((r) => /^(Vind_kias|_Vind,_kias)$/.test(r))
      const speedAxis = ['_Vind,_kias', '_Vind,_keas', 'Vtrue,_ktas'].includes(xCh.token)
      let status: CheckStatus
      let measured: string
      let hint = ''
      if (usesMax) {
        status = 'fail'
        measured = 'the formula uses gross,___lb or maxim,___lb (the constant maximum weight)'
        hint = 'Use total,___lb, the current weight.'
      } else if (speedAxis) {
        status = 'warn'
        measured = `x is a speed (${xCh.token})`
        hint = 'Plot against C_L for dη/dC_L; a speed axis also ignores the weight change.'
      } else if (!clAxis) {
        status = 'warn'
        measured = `x (${xCh.meta.short}) is not a lift coefficient`
        hint = 'Plot the trim curve against C_L.'
      } else {
        const errors = U.map((c) => Math.abs(c.x / c.clW - 1)).filter(Number.isFinite)
        const worst = errors.length ? Math.max(...errors) : NaN
        status = grade(worst, 0.03, 0.06) ?? 'not-checkable'
        // KIAS carries a pitot error that grows with α: a formula on it is warned even where it agrees at these points.
        if (usesKias && status === 'pass') status = 'warn'
        measured = `${xCh.derived ? `formula ${xCh.derived.expression}` : xCh.token}; largest difference from n·W/(q̄S) ${pct(worst)}${usesKias ? ' (uses KIAS)' : ''}`
        if (status === 'warn' || status === 'fail') hint = usesKias ? 'Use KEAS for the dynamic pressure, not KIAS.' : 'Check the weight, speed and area in the C_L definition.'
      }
      // Compared at the used points: with none, there is nothing to compare.
      if (status === 'not-checkable') set.push(notCheckable(def0, KIND, { needs: 'Needs used points' }))
      else set.push(result(def0, KIND, status, measured, 'pass: within 3 % of n·W/(q̄S) (KEAS, total,___lb, S-ref) at every used point; warn: 3–6 %, a formula on KIAS, a speed axis or an x that is not a C_L; fail: > 6 %, or the maximum weight (gross,___lb or maxim,___lb)', hint))
    }
  }

  // ---- cl-range
  let clMissing = false
  {
    const def0 = d('cl-range')
    const cls = U.map((c) => (clAxis ? c.x : c.clW)).filter(Number.isFinite).sort((u, v) => u - v)
    if (!clAxis && !U.some((c) => Number.isFinite(c.clW))) set.push(notCheckable(def0, KIND))
    else if (U.length >= 3 && cls.length < 3) {
      // Enough used points, but too few of them have a C_L: a data gap, not a reason to fly more points.
      clMissing = true
      set.push(notCheckable(def0, KIND, { needs: `Needs a C_L at three or more used points: ${cls.length} of the ${U.length} have one (check the C_L channel or its inputs at the others)` }))
    } else {
      // Fewer than three used points is a maths floor (a line through two has no check): critical. A narrow range is
      // judgement and no source sets a minimum span, so it only warns.
      const n = cls.length
      const ratio = n ? cls[n - 1] / cls[0] : NaN
      const span = n ? cls[n - 1] - cls[0] : NaN
      let gap = 0
      for (let i = 1; i < n; i += 1) gap = Math.max(gap, cls[i] - cls[i - 1])
      const gapShare = span > 0 ? gap / span : NaN
      const status: CheckStatus = n < 3 ? 'fail' : n >= 5 && ratio >= 1.8 && !(gapShare > 0.4) ? 'pass' : 'warn'
      const narrow = n >= 3 && !(ratio >= 1.3)
      const hint = status === 'pass' ? '' : status === 'fail' ? 'Fly more trim points: a line through fewer than three points has no check.' : narrow ? 'A narrow C_L range: fly a wider speed range if you can, and say how far the gradient can be trusted.' : 'More points, spread more evenly over a wider C_L range, would firm up the gradient.'
      set.push(result(def0, KIND, status, `${U.length} used point${U.length === 1 ? '' : 's'}${n < U.length ? ` (${n} with a C_L)` : ''}, C_L ${fmt(cls[0], 3)}–${fmt(cls[n - 1], 3)} (ratio ${fix(ratio, 2)}), largest gap ${pct(gapShare, 0)} of the span${clAxis ? '' : `; C_L as ${clBasis}`}`, 'pass: ≥ 5 points, C_L ratio ≥ 1.8 and the largest gap ≤ 40 % of the span; warn: 3–4 points, a ratio under 1.8 (under 1.3: narrow) or a gap > 40 %; fail: fewer than 3 used points; not checkable when 3 or more used points leave fewer than 3 with a C_L', hint))
    }
  }

  // ---- compressibility
  {
    const def0 = d('compressibility')
    const machs = U.map((c) => c.mach).filter(Number.isFinite)
    if (!mach) set.push(notCheckable(def0, KIND))
    else if (!machs.length) set.push(notCheckable(def0, KIND, { needs: 'Needs used points' }))
    else {
      const mMax = machs.length ? Math.max(...machs) : NaN
      const mmo = settings.limits?.mmo
      const fast = U.filter((c) => c.mach >= 0.6).map((c) => c.point.name)
      const status: CheckStatus = mMax >= 0.6 || (mmo && mMax >= mmo - 0.02) ? 'warn' : 'pass'
      set.push(result(def0, KIND, status, `M_max ${fix(mMax, 3)}${fast.length ? ` (at or above 0.6: ${fast.join(', ')})` : ''}`, 'pass: M_max < 0.6 and, when M_MO is set, < M_MO − 0.02; warn otherwise (never fails)', status === 'warn' ? 'Compare the gradient with and without the points at or above M 0.6.' : ''))
    }
  }

  // ---- thrust-method (over U)
  const methodU = methodOver(U.map((c) => ({ a: c.a, b: c.b })))
  {
    const def0 = d('thrust-method')
    if (methodU.kind === 'unknown') set.push(notCheckable(def0, KIND, !U.length ? { needs: 'Needs two or more used points' } : methodU.varies ? { needs: METHOD_VARIES } : {}))
    else if (U.length < 2 && methodU.kind !== 'zero-thrust') {
      // Constant power or power for level flight is a comparison between points: one point cannot tell them apart.
      set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    } else {
      const status: CheckStatus = methodU.kind === 'power-for-level' ? 'warn' : 'pass'
      set.push(result(def0, KIND, status, `${METHOD_NAME[methodU.kind]} (${methodU.detail})`, 'pass: idle, every lever (and throttle reaching the engines, when logged) ≤ 0.05 (the lecture’s zero-thrust procedure), or constant power (their ranges across the points ≤ 0.02, whatever N1 does; without a setting row, N1 range ≤ 2 %pt, else thrust or power range ≤ 4 % of the mean); warn: power for level flight (the setting varies; labelled, never failed); not checkable without a setting row when N1 or the force varies more (idle at varying speed and re-set power look alike)', status === 'warn' ? 'Power-on, level-flight trim curve: the thrust moment changes with C_L and is in the gradient; label it power-on and discuss.' : ''))
    }
  }

  // ---- cg-lines
  const cgInfo = cgLines(U, input.groups, settings, clAxis)
  {
    const def0 = d('cg-lines')
    if (!cg) set.push(notCheckable(def0, KIND))
    else set.push(result(def0, KIND, cgInfo.status, cgInfo.measured, 'pass: 3 or more CG lines with ≥ 3 used points each (neutral point by extrapolation); warn: 2 lines, a line with fewer than 3 points, a fuel-burn drift within a line > 25 % of the smallest spacing, or the neutral point more than 2 × the CG span aft of the aftmost line; info: 1 line (gradient and sign only); lines are the point groups, else CG clusters split at gaps > 2 % MAC (0.25 ft without a MAC)', cgInfo.hint))
  }

  // ---- autopilot-record
  let autopilotHeld: number
  {
    const def0 = d('autopilot-record')
    const declaredAll = settings.declared?.autopilot && settings.declared.autopilot !== 'unknown'
    const allNoted = U.length > 0 && U.every((c) => declaresModes(c.point.note))
    const logged = ctxs.some((c) => c.modesLogged)
    const inferred = ctxs.filter((c) => c.pitch !== null)
    autopilotHeld = ctxs.filter((c) => c.pitch === 'autopilot').length
    if (settings.declared?.autopilot === 'on') autopilotHeld = Math.max(autopilotHeld, 1)
    const atLike = U.filter((c) => autothrottleEvidence(ds, c.a, c.b, speedCh).atLike).map((c) => c.point.name)
    if (!logged && !inferred.length && !declaredAll && !allNoted) set.push(notCheckable(def0, KIND))
    else {
      const changed = ctxs.filter((c) => c.modesChanged).map((c) => c.point.name)
      const retargeted = ctxs.filter((c) => c.setpointsChanged).map((c) => c.point.name)
      let status: CheckStatus
      let measured: string
      let hint = ''
      if (logged) {
        status = changed.length ? 'warn' : 'pass'
        measured = changed.length ? `mode codes logged; a mode changed inside ${changed.join(', ')}` : 'mode codes logged and constant in every point'
        if (retargeted.length) measured += `; a selected altitude, speed or vertical speed changed inside ${retargeted.join(', ')} (not a mode change)`
      } else if (declaredAll || allNoted) {
        status = 'pass'
        measured = declaredAll ? `declared: autopilot ${settings.declared?.autopilot}${settings.declared?.modes ? ` (${settings.declared.modes})` : ''}` : 'the modes are written in every point’s note'
      } else {
        status = 'warn'
        const counts = (['autopilot', 'pilot', 'hands-off', 'unknown'] as PitchSource[]).map((s) => [s, inferred.filter((c) => c.pitch === s).length] as const).filter(([, k]) => k > 0)
        measured = `inferred from the surface, stick and servo: ${counts.map(([s, k]) => `${s} ${k}`).join(', ')}${atLike.length ? `; autothrottle-like levers at ${atLike.join(', ')}` : ''}`
        hint = autopilotHeld ? `The autopilot held pitch in ${autopilotHeld} points (inferred): write the modes (e.g. HDG + V/S, A/T off) in the point notes or log row 117.` : 'Write the modes in the point notes or log row 117.'
      }
      set.push(result(def0, KIND, status, measured, 'pass: mode codes logged and constant in every point, or the modes declared or written in every point’s note; warn: a mode code changes inside a point, or the modes are only inferred (autopilot: stick range ≤ 0.02 while the surface follows a moving servo, R² ≥ 0.9, over the point ± 30 s); a selected value changing is noted, not counted (never fails; whether autopilot-held trims are accepted is open item N1)', hint))
    }
  }

  // ---- pitch-augmentation
  {
    const def0 = d('pitch-augmentation')
    if (!astab) set.push(notCheckable(def0, KIND))
    else {
      const worst = Math.max(0, ...ctxs.map((c) => c.astab).filter(Number.isFinite))
      const status: CheckStatus = worst <= 1e-4 ? 'pass' : 'warn'
      set.push(result(def0, KIND, status, `max |_elev,astab| ${fmt(worst, 2)}`, 'pass: max |_elev,astab| ≤ 1e−4 in every plotted point; warn otherwise: augmentation noted (never fails)', status === 'warn' ? 'Pitch augmentation active: the gradient describes the aircraft with its augmentation.' : ''))
    }
  }

  // ---- gradient
  let gradient: StaticReport['gradient'] = null
  {
    const def0 = d('gradient')
    const xs = U.map((c) => (clAxis ? c.x : c.clW))
    const ys = U.map((c) => c.y)
    const lf = linearFit(xs, ys)
    if (!yCh || U.length < 3 || !Number.isFinite(lf.c1)) set.push(notCheckable(def0, KIND))
    else {
      const t = lf.c1 / lf.seC1
      const stableSign = yInfo.kind === 'trim' ? 1 : yInfo.sign === 1 ? -1 : 1
      const label = Math.abs(t) < 3 ? 'cannot be told apart from neutral' : Math.sign(lf.c1) === stableSign ? 'stable' : 'unstable'
      // Curvature: t of an added C_L² term.
      const sq = xs.map((v) => v * v)
      const quad = twoVariableFit(xs, sq, ys)
      const tCurve = quad ? quad.c[2] / quad.se[2] : NaN
      // Leave-one-out residuals.
      const rms = Math.sqrt(xs.reduce((s, v, i) => s + (ys[i] - lf.c0 - lf.c1 * v) ** 2, 0) / xs.length)
      const odd: string[] = []
      U.forEach((c, i) => {
        const others = linearFit(xs.filter((_, k) => k !== i), ys.filter((_, k) => k !== i))
        const res = ys[i] - others.c0 - others.c1 * xs[i]
        if (Math.abs(res) > 3 * rms && rms > 0) odd.push(c.point.name)
      })
      gradient = { slope: lf.c1, se: lf.seC1, t, label }
      const unit = yCh.meta.unit ? `${yCh.meta.unit}/C_L` : 'per C_L'
      // With a neutral point from two or more CG lines the margin follows as K_n = h_n − h (Cook p.46 eq. 3.17, p.48).
      const mac = settings.macFt && settings.macFt > 0 ? settings.macFt : null
      const margins = cgInfo.lines >= 2 && Number.isFinite(cgInfo.hn) ? cgInfo.cgs.map((h) => (mac ? `${fix((100 * (cgInfo.hn - h)) / mac, 1)} %MAC` : `${fmt(cgInfo.hn - h, 3)} ft`)) : []
      const marginText = margins.length ? `; static margin K_n = h_n − h by CG line, fore to aft: ${margins.join(', ')}` : ''
      set.push(result(def0, KIND, 'info', `${fmt(lf.c1, 3)} ± ${fmt(lf.seC1, 2)} ${unit} against ${clBasis} (t ${fix(t, 1)}, R² ${fix(lf.r2, 3)}, n ${U.length}): ${label}${Math.abs(tCurve) >= 3 ? '; curved, as power effects produce: quote a mean or local gradient' : ''}${odd.length ? `; inconsistent: ${odd.join(', ')}` : ''}${marginText}; ${METHOD_NAME[methodU.kind]}, ${cgInfo.lines} CG line${cgInfo.lines === 1 ? '' : 's'}, stick-fixed, X-Plane model`, 'report only: stable (stable sign, |t| ≥ 3), cannot be told apart from neutral (|t| < 3), unstable (other sign, |t| ≥ 3); curved if an added C_L² term has |t| ≥ 3; inconsistent if a point’s leave-one-out residual > 3 × the RMS; K_n = h_n − h when two or more CG lines give h_n'))
    }
  }

  // ---- open items
  const open: OpenItem[] = []
  const openItem = (id: keyof typeof STATIC_OPEN) => open.push({ id, ...STATIC_OPEN[id] })
  if (autopilotHeld > 0) openItem('N1')
  openItem('N2')
  if (cgInfo.lines <= 1) openItem('N3')
  const tv = set.find((c) => c.id === 'trim-variable')
  if (yKind === 'combined' || tv?.status === 'warn' || (!settings.trimType && trimCh && yKind === 'elevator')) openItem('N4')

  // ---- verdict (points left out only because the power or the trim moved inside them can be re-cut instead of reflown)
  const recut = recutCounts(ds, P, points, 'static', (k) => CRITICAL.has(k.id))
  const verdict = staticVerdict(points, set, U.length, ctxs.length, settings.fitUsedOnly === true, recut, configTie, clMissing)
  const notes = [
    ...set.filter((c) => c.status === 'warn').map((c) => `${c.title}: ${c.hint || c.measured}`),
    ...summariseWarnings(points),
  ]
  return {
    kind: 'static',
    setName: input.setName ?? 'Trim points',
    points,
    set,
    open,
    verdict,
    notes,
    used: U.map((c) => c.point.id),
    fitIncludesUnused: settings.fitUsedOnly !== true && U.length < ctxs.length,
    yKind,
    deltaEq,
    gradient,
    neutralPoint: { hn: cgInfo.hn, se: cgInfo.seHn, lines: cgInfo.lines },
  }
}

/** Short reasons for a point left out, by the check that failed (for the verdict). */
export const STATIC_REASON: Readonly<Record<string, string>> = {
  'time-base': 'a reset or gap inside',
  'sample-rate': 'too few samples',
  'record-length': 'too short',
  'speed-steady': 'speed drifting',
  'flight-path': 'flight path not steady',
  'wings-level': 'not wings level',
  'throttle-fixed': 'power changed inside',
  'controls-fixed': 'stick or elevator moved inside',
  'trim-fixed': 'trim moved inside',
  'configuration-constant': 'configuration changed',
  'configuration-match': 'another configuration (plot it separately)',
}

export const POINT_LABEL: Readonly<Record<PointStatus, string>> = {
  used: 'Use',
  correct: 'Correct',
  // The only use left: a valid point of another configuration, plotted but left out of this set's fit.
  'plot-only': 'Plot separately',
  excluded: 'Retest',
  'cannot-confirm': 'Cannot confirm',
  'left-out': 'Left out',
}

/** Per-point warnings, one line per check: "Speed held steady: warn at P2, P5". */
export function summariseWarnings(points: readonly PointReport[]): string[] {
  const byCheck = new Map<string, string[]>()
  for (const p of points) {
    if (p.status !== 'used' && p.status !== 'correct') continue
    for (const c of p.checks) {
      if (c.status !== 'warn' || c.severity === 'info') continue
      const list = byCheck.get(c.title) ?? []
      list.push(p.name)
      byCheck.set(c.title, list)
    }
  }
  return [...byCheck.entries()].map(([title, names]) => `${title}: warn at ${names.join(', ')}`)
}

/** "3 left out (power changed inside: P1, P6; another configuration (plot it separately): P4)". */
export function leftOutText(points: readonly PointReport[]): string {
  const groups = new Map<string, string[]>()
  for (const p of points) {
    if (p.status === 'used' || p.status === 'correct') continue
    const reason = (p.reasons[0] ?? POINT_LABEL[p.status]).toLowerCase()
    const list = groups.get(reason) ?? []
    list.push(p.name)
    groups.set(reason, list)
  }
  const count = points.filter((p) => p.status !== 'used' && p.status !== 'correct').length
  if (!count) return ''
  return `${count} left out (${[...groups.entries()].map(([r, names]) => `${r}: ${names.join(', ')}`).join('; ')})`
}

function staticVerdict(
  points: readonly PointReport[],
  set: readonly Check[],
  used: number,
  total: number,
  fitUsedOnly: boolean,
  recut: { flagged: number; fixable: number } = { flagged: 0, fixable: 0 },
  configTie = false,
  clMissing = false,
): Verdict {
  if (total === 0) return { kind: 'no-data', text: 'No test points to judge: save trim points (Find steady points) and plot them.' }
  const cannot = points.filter((p) => p.status === 'cannot-confirm')
  const naRows = rowsFromNotCheckable([
    ...set.filter((c) => (c.severity === 'critical' || c.severity === 'analysis') && c.status === 'not-checkable'),
    ...cannot.flatMap((p) => p.checks.filter((c) => c.severity === 'critical')),
  ])
  // Two equally common configurations leave every point unjudged on configuration-match: that needs a split, not a row.
  // Used points without a C_L leave cl-range unjudged: that needs the C_L checked, not more points.
  const tie = configTie && cannot.length > 0
  const rowsText = naRows.length ? `tick rows ${naRows.join(', ')}` : tie || clMissing ? '' : 'some checks need rows the log does not have'
  const cannotText = `Cannot confirm — ${[tie ? 'two configurations are equally common: put each in its own group and plot them separately' : '', clMissing ? CL_MISSING : '', rowsText].filter(Boolean).join('; ')}`
  if (used < 3 && used + cannot.length >= 3) return { kind: 'cannot-confirm', text: cannotText }
  const flagged = `${recut.flagged} flagged point${recut.flagged === 1 ? '' : 's'}`
  if (used < 3 && recut.fixable > 0 && used + recut.fixable >= 3) {
    // Too few points as cut, but the ones left out only for a power or trim move can be re-cut to their still part.
    return {
      kind: 'fix-analysis',
      text: `Fix the analysis — re-cut the ${flagged} (the power or trim moved inside them) to their still part (Re-cut), then check again: as cut, only ${used} ${used === 1 ? 'is' : 'are'} usable`,
    }
  }
  const also = recut.flagged > 0 ? ` (and re-cut the ${flagged}: the power or trim moved inside them)` : ''
  if (used < 3) return { kind: 'retest', text: `Retest required — only ${used} point${used === 1 ? '' : 's'} usable: fly more trim points${also}` }
  // cl-range fails only with fewer than 3 used points, decided above; a narrow range warns (no source sets a minimum
  // span) and used points without a C_L leave it not checkable (Cannot confirm, below).
  const setNa = set.some((c) => (c.severity === 'critical' || c.severity === 'analysis') && c.status === 'not-checkable')
  if (setNa || cannot.length > total / 2) return { kind: 'cannot-confirm', text: cannotText }
  const analysisFail = set.filter((c) => c.severity === 'analysis' && c.status === 'fail')
  if (analysisFail.length) return { kind: 'fix-analysis', text: `Fix the analysis — ${analysisFail.map((c) => c.hint || c.title).join('; ')}` }
  const notes = set.filter((c) => c.status === 'warn').length + summariseWarnings(points).length
  const left = leftOutText(points)
  const tick = !fitUsedOnly && used < total ? "; tick 'Fit the used points only' to plot the fit this verdict judges" : ''
  return {
    kind: 'acceptable',
    text: `Acceptable for analysis — ${used} point${used === 1 ? '' : 's'} used${left ? `, ${left}` : ''}, ${notes} note${notes === 1 ? '' : 's'}${tick}`,
  }
}

// ------------------------------------------------------------------ set helpers

function isClAxis(ch: Channel | null): boolean {
  if (!ch) return false
  if (ch.token === '___cl,total') return true
  if (ch.derived) return /\bc_?l\b|lift coeff/i.test(`${ch.meta.label} ${ch.id}`) || /total_lb|gross_lb|maxim_lb/.test(ch.derived.expression)
  return false
}

type MethodKind = 'zero-thrust' | 'constant-power' | 'power-for-level' | 'unknown'
const METHOD_NAME: Readonly<Record<MethodKind, string>> = {
  // The levers at idle: the lecture's "reduce thrust to zero" procedure (FD12b p.18), not a measured zero thrust.
  'zero-thrust': 'idle (zero-thrust procedure)',
  'constant-power': 'constant power',
  'power-for-level': 'power for level flight',
  unknown: 'thrust method unknown',
}

function thrustMethod(
  pts: readonly { a: number; b: number }[],
  levers: readonly Channel[],
  actual: readonly Channel[],
  n1s: readonly Channel[],
  thrusts: readonly Channel[],
  powers: readonly Channel[],
): { kind: MethodKind; detail: string; varies?: boolean } {
  if (!pts.length) return { kind: 'unknown', detail: 'no points' }
  const means = (chs: readonly Channel[], agg: 'max' | 'sum') =>
    pts.map(({ a, b }) => {
      const vals = chs.map((c) => summary(c.values, a, b).mean)
      return agg === 'max' ? Math.max(...vals) : vals.reduce((s, v) => s + v, 0)
    })
  const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
  // The setting decides (MIL p.40: throttle not moved): the lever and, when logged, the throttle reaching the engines,
  // which an autothrottle can move with the lever still. Fixed, they are constant power whatever N1 does.
  const lv = levers.length ? means(levers, 'max') : null
  const acMeans = actual.length ? means(actual, 'max') : null
  const ac = acMeans && acMeans.every(Number.isFinite) ? acMeans : null
  const series = [lv, ac].filter((s): s is number[] => s !== null)
  if (series.length) {
    if (series.every((s) => s.every((v) => v <= 0.05))) return { kind: 'zero-thrust', detail: 'every lever ≤ 0.05' }
    const detail = [lv ? `lever range ${fmt(range(lv), 2)}` : '', ac ? `throttle reaching the engines range ${fmt(range(ac), 2)}` : ''].filter(Boolean).join(', ')
    if (series.every((s) => range(s) <= 0.02)) return { kind: 'constant-power', detail }
    const moving = lv && !(range(lv) <= 0.02) ? { name: 'levers', s: lv } : { name: 'throttle reaching the engines', s: ac ?? [] }
    return { kind: 'power-for-level', detail: `${moving.name} ${fmt(Math.min(...moving.s), 3)}–${fmt(Math.max(...moving.s), 3)}` }
  }
  // Without a setting row a steady N1 or force is constant power, but one that varies between points cannot tell idle
  // at varying speed (idle N1 and thrust change with speed) from re-set power: unknown.
  if (n1s.length) {
    const n1 = means(n1s, 'max')
    return range(n1) <= 2
      ? { kind: 'constant-power', detail: `N1 range ${fix(range(n1), 2)} %pt (no lever row)` }
      : { kind: 'unknown', detail: `N1 range ${fix(range(n1), 2)} %pt across the points (no lever row)`, varies: true }
  }
  const force = powers.length ? powers : thrusts
  if (force.length) {
    const f = means(force, 'sum')
    const mean = f.reduce((s, v) => s + v, 0) / f.length
    const rel = range(f) / Math.abs(mean)
    const name = powers.length ? 'engine power' : 'thrust'
    return rel <= 0.04
      ? { kind: 'constant-power', detail: `${name} range ${pct(rel)} (no lever row)` }
      : { kind: 'unknown', detail: `${name} range ${pct(rel)} across the points (no lever row)`, varies: true }
  }
  return { kind: 'unknown', detail: 'no lever, N1, thrust or power row' }
}

function cgLines(U: readonly PointCtx[], groups: readonly PointGroup[], settings: TrimCheckSettings, clAxis: boolean) {
  const mac = settings.macFt && settings.macFt > 0 ? settings.macFt : null
  const lemac = Number.isFinite(settings.lemacFt) ? (settings.lemacFt as number) : null
  const pctMac = (cg: number) => (mac !== null && lemac !== null ? (100 * (cg - lemac)) / mac : NaN)
  const pts = U.filter((c) => Number.isFinite(c.cg))
  if (!pts.length) return { status: 'info' as CheckStatus, measured: 'no CG values', hint: '', lines: 0, hn: NaN, seHn: NaN, cgs: [] as number[] }
  // Lines by group when each group's CG range is under half the spacing to the next; else clusters split at gaps.
  const byGroup = groups.map((g) => pts.filter((c) => c.point.groupId === g.id)).filter((l) => l.length)
  const mean = (l: readonly PointCtx[]) => l.reduce((s, c) => s + c.cg, 0) / l.length
  const spread = (l: readonly PointCtx[]) => Math.max(...l.map((c) => c.cg)) - Math.min(...l.map((c) => c.cg))
  let lines: PointCtx[][] = byGroup
  const sortedGroups = [...byGroup].sort((u, v) => mean(u) - mean(v))
  const groupOk = sortedGroups.every((l, i) => {
    const next = sortedGroups[i + 1]
    const prev = sortedGroups[i - 1]
    const gaps = [next ? Math.abs(mean(next) - mean(l)) : Infinity, prev ? Math.abs(mean(l) - mean(prev)) : Infinity]
    return spread(l) < 0.5 * Math.min(...gaps)
  })
  if (!groupOk || byGroup.length <= 1) {
    const gap = mac ? 0.02 * mac : 0.25
    const sorted = [...pts].sort((u, v) => u.cg - v.cg)
    lines = []
    for (const c of sorted) {
      const last = lines[lines.length - 1]
      if (last && c.cg - last[last.length - 1].cg <= gap) last.push(c)
      else lines.push([c])
    }
  }
  const n = lines.length
  const lineText = lines.map((l) => `${fmt(mean(l), 4)} ft${Number.isFinite(pctMac(mean(l))) ? ` (${fix(pctMac(mean(l)), 1)} %MAC)` : ''}, ${l.length} pt`).join('; ')
  if (n <= 1) {
    return { status: 'info' as CheckStatus, measured: `1 CG line (${lineText}), fuel-burn drift ${fmt(spread(pts), 2)} ft`, hint: 'One CG: the gradient and its sign only; no flight-test neutral point or static margin (open item N3).', lines: n, hn: NaN, seHn: NaN, cgs: lines.map(mean) }
  }
  // Mean gradient per line, then gradient against CG; h_n where it is zero.
  const grads = lines.map((l) => linearFit(l.map((c) => (clAxis ? c.x : c.clW)), l.map((c) => c.y)).c1)
  const cgs = lines.map(mean)
  const fit = linearFit(cgs, grads)
  const hn = -fit.c0 / fit.c1
  // Standard error of the zero crossing (inverse prediction): (s/|c1|)·√(1/n + (h − x̄)²/Sxx).
  const cgMean = cgs.reduce((s0, v) => s0 + v, 0) / n
  const sxx = cgs.reduce((s0, v) => s0 + (v - cgMean) ** 2, 0)
  const resid = n > 2 ? Math.sqrt(cgs.reduce((s0, v, i) => s0 + (grads[i] - fit.c0 - fit.c1 * v) ** 2, 0) / (n - 2)) : NaN
  const seHn = (resid / Math.abs(fit.c1)) * Math.sqrt(1 / n + (hn - cgMean) ** 2 / sxx)
  const drift = Math.max(...lines.map(spread))
  const sortedCg = [...cgs].sort((u, w) => u - w)
  const spacing = Math.min(...sortedCg.slice(1).map((v, i) => v - sortedCg[i]))
  let status: CheckStatus = n >= 3 && lines.every((l) => l.length >= 3) ? 'pass' : 'warn'
  let hint = n === 2 ? 'A line through two points has no check: add a third CG position.' : status === 'warn' ? 'A CG line with fewer than three points has no check on its own gradient: add points to it.' : ''
  if (drift > 0.25 * spacing) {
    status = 'warn'
    hint = 'Fuel burn moved the CG within a line by more than a quarter of the spacing: use each point’s own CG.'
  }
  const aft = Math.max(...cgs)
  if (status === 'pass' && hn - aft > 2 * (aft - Math.min(...cgs))) {
    status = 'warn'
    hint = 'The neutral point lies far aft of the aftmost line: a long extrapolation.'
  }
  return {
    status,
    measured: `${n} CG lines (${lineText}); neutral point by extrapolation h_n ${fmt(hn, 4)}${Number.isFinite(seHn) ? ` ± ${fmt(seHn, 2)}` : ''} ft${Number.isFinite(pctMac(hn)) ? ` (${fix(pctMac(hn), 1)} %MAC)` : ''}`,
    hint,
    lines: n,
    hn,
    seHn,
    /** Each line's mean CG, fore to aft (for K_n = h_n − h) */
    cgs: sortedCg,
  }
}
