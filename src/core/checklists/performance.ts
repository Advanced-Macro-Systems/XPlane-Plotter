// Test validity of a range-and-endurance set: were the steady level points flown and reduced the way the lectures
// (FD12b, FD12c), Cook (ch. 3, 14) and NATO AG-300 Vol. 14 ch. 13 ask, and does the fit through them place the two
// optima inside the data? Per point: a steady record at a fixed throttle, level, unaccelerated, clean, calm and clear
// of the stall, with the energy correction (Cook p.64 eq. 3.42; NATO 13-7) small. Per set: the weight column, the
// weight and altitude spread, the point count, the brackets around V_E and V_R, the construction for the engine type,
// the speed axis, fuel flow and the fit's uncertainty. Questions the sources leave open are shown as U1–U7.
// Pure: no React, no DOM.

import { polyFit } from '../analysis/fit'
import {
  physicalFit,
  physicalProblem,
  polyRangeEndurance,
  type PhysicalModel,
} from '../analysis/rangeEndurance'
import { channelById } from '../dataset'
import type { Channel, Dataset, PerfCheckSettings, TestPoint, XYConfig } from '../types'
import { formatCitations } from './cite'
import {
  autothrottleEvidence,
  configuration,
  engineChannels,
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
  summary,
  timeBase,
  trend,
  worse,
  atLeast,
  declaresModes,
  configText,
  BSFC,
  FUEL_FLOW,
  POWER_HP,
  POWER_LEGACY,
  THRUST,
  TSFC,
  type PitchSource,
} from './helpers'
import { recutCounts } from './recut'
import { leftOutText, refsOf, summariseWarnings, POINT_LABEL } from './staticStability'
import type { Check, CheckDef, CheckStatus, OpenItem, PointReport, PointStatus, SetReport, Verdict } from './types'
import { worstStatus } from './types'

export type { PerfCheckSettings }

export interface PerfInput {
  ds: Dataset
  /** SET: the points of one fit (visible points of the chosen groups) */
  points: readonly TestPoint[]
  /** The plotted x (a speed) and y (thrust, drag, power or fuel flow): channels, so a view can pass a computed total */
  x: Channel | null
  y: Channel | null
  fit: XYConfig['fit']
  fitTarget?: XYConfig['fitTarget']
  settings?: PerfCheckSettings
  setName?: string
}

export interface PointMetrics {
  /** True airspeed, kt, and its least-squares rate (kt/s), drift (kt/min) and scatter (2σ, kt) */
  v: number
  dvdt: number
  drift: number
  scatter: number
  /** Climb rate, ft/s (geometric altitude, else pressure altitude × T/T_ISA, else VVI), and the altitude 2σ (ft) */
  dhdt: number
  altScatter: number
  w: number
  thrust: number
  power: number
  ff: number
  alpha: number
  mach: number
  hp: number
  keas: number
  kias: number
  q: number
  s: number
  sigma: number
  dIsa: number
  drag: number
  cl: number
  /** C_L from weight, n_z·W/(q·S): the lift the corrected drag goes with (the reference polar uses it) */
  clW: number
  cd: number
  cg: number
  fuel: number
  /** The energy terms (lbf): climb W·ḣ/V, acceleration (W/g)·V̇, their sum, the thrust-axis term, the corrected drag */
  climb: number
  acc: number
  total: number
  cosTerm: number
  dCorr: number
  /** |total| / D_corr (or the share of shaft power for a propeller without thrust) */
  share: number
  ffCorr: number
  x: number
  y: number
}

export interface PerfFit {
  model: XYConfig['fit']
  n: number
  r2: number
  vE: number | null
  vR: number | null
  /** Why there is no V_E / V_R ('' when there is) */
  problem: string
  xMin: number
  xMax: number
}

export interface PerfReport extends SetReport {
  kind: 'performance'
  propulsion: 'jet' | 'propeller' | null
  /** The fit through every point of the set (as plotted) and through the used points */
  fitAll: PerfFit | null
  fitU: PerfFit | null
  metrics: PointMetrics[]
}

const G0 = 32.174
const KT = 1.68781
const RHO0 = 0.0023769

// ------------------------------------------------------------------ definitions

const def = (d: CheckDef): CheckDef => d

export const PERFORMANCE_DEFS: readonly CheckDef[] = [
  def({
    id: 'time-base', title: 'Continuous sim-time record', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Rates of change and fuel used are per second of simulated flight, and a reset or gap inside a record breaks the trend fit; NATO requires time to be recorded with the other performance parameters. A sim running a little off real time does not by itself spoil a steady point.',
    cite: ['NATO 13-2', 'App src/core/time.ts', 'App src/views/modes/modesModel.ts line 111', 'App src/core/channels/groupRows.ts (row 0)'], judgement: false, needs: 'row {1}',
  }),
  def({
    id: 'sample-rate', title: 'Sample rate', severity: 'critical', scope: 'point', interval: 'R',
    why: 'NATO records its classical steady climbs at one sample per five seconds and requires airspeed, altitude, fuel, time and engine parameters at rates sufficient for performance; the app’s recording guide asks 10 writes per second. The 1 Hz pass line is engineering judgement.',
    cite: ['NATO 13-6', 'NATO 13-2', 'App src/core/channels/guide.ts', 'EJ'], judgement: true, needs: 'row {1}',
  }),
  def({
    id: 'record-length', title: 'Record long enough', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Record the last minute of each cruise point and compute the drag increment from the residual acceleration. Shorter records are kept with a warning: the lecture’s own X-Plane example selects short windows, and the data need not be perfect. The 5 s floor is engineering judgement.',
    cite: ['NATO 13-10', 'FD12c p.16', 'FD12b p.19', 'EJ'], judgement: true,
    follows: 'pass: NATO 13-10; warn band: FD12c p.16 and FD12b p.19; floor: engineering judgement', needs: 'row {1}',
  }),
  def({
    id: 'stabilised', title: 'Settled before the record', severity: 'advisory', scope: 'point', interval: 'S (up to 300 s) and R',
    why: 'NATO stabilises engine and aircraft for at least one minute before recording climbs and accelerations, notes that engine output changes appreciably in the first minute after a power-lever change, and allows three to four minutes for propulsion steady state. Whether X-Plane models engine lag is not settled, so a short settling time is judged by the traces and only warned about.',
    cite: ['NATO 13-6', 'NATO 13-7', 'NATO 13-5', 'NATO 24-6', 'EJ'], judgement: true,
    follows: 'NATO 13-6 and 13-7 (one minute, stated for climbs and accelerations) rather than 24-6 (three to four minutes, propulsion tests)',
    needs: 'row {25} or {35}',
  }),
  def({
    id: 'throttle-fixed', title: 'Throttle unchanged', severity: 'critical', scope: 'point', interval: 'R',
    why: 'The quasi-steady technique sets a throttle and holds altitude while the speed stabilises, and the engine instruments confirm the engine is at the intended thrust; NATO fixes the power lever, autothrottle off, for its non-steady runs. A change inside the record mixes two thrust levels. Tolerances are engineering judgement.',
    cite: ['NATO 13-9', 'NATO 13-10', 'NATO 13-4', 'NATO 13-5', 'App src/core/analysis/steady.ts', 'EJ'], judgement: true,
    needs: 'row {25}, else {26} or {35}',
  }),
  def({
    id: 'autothrottle-off', title: 'Autothrottle off', severity: 'advisory', scope: 'point', interval: 'S+R',
    why: 'NATO fixes the power lever with the autothrottle off for its non-steady cruise runs, lists autothrottles among the automatic controls that cause propulsion transients, and records autopilot status with every test point. Whether autothrottle-held level points are acceptable is not settled (U2). Detection thresholds are engineering judgement.',
    cite: ['NATO 13-10', 'NATO 24-6', 'NATO 29-1', 'App dictionary.ts line 612', 'EJ'], judgement: true, needs: 'row {25} or {117}',
  }),
  def({
    id: 'speed-steady', title: 'Speed steady', severity: 'critical', scope: 'point', interval: 'R',
    why: 'NATO sets no speed tolerance for level points: it records the last minute and corrects for the residual acceleration. Its only number, under one knot in two minutes, belongs to its cruise-climb method and is used here only as the pass benchmark. Phugoid periods are typically 15–100 s. Scatter limits are engineering judgement.',
    cite: ['NATO 13-10', 'FD13 p.13', 'App src/core/analysis/steady.ts', 'EJ'], judgement: true,
    follows: 'NATO 13-10 (correct, do not discard); the 0.5 kt/min benchmark is NATO’s W/δ figure, not a level-point rule',
    needs: 'row {3}',
  }),
  def({
    id: 'level', title: 'Level flight', severity: 'critical', scope: 'point', interval: 'R',
    why: 'The technique holds a constant altitude while the speed stabilises; a residual climb is corrected through the energy equation. 20 fpm is about 1 % of drag for a transport with L/D near 15. Tolerances are engineering judgement.',
    cite: ['NATO 13-9', 'NATO 13-10', 'NATO 13-7', 'App dictionary.ts line 55', 'EJ'], judgement: true, needs: 'row {20} or {4}',
  }),
  def({
    id: 'energy-correction', title: 'Energy correction small', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Specific excess power ḣ + (V/g)V̇ measures the thrust not balancing drag (D = T − W·ḣ/V − (W/g)·V̇), and NATO computes the drag increment from the residual acceleration. NATO says corrections below about 10 % may be applied in linearised form. The 2 % pass band is engineering judgement.',
    cite: ['NATO 13-7', 'NATO 13-8', 'NATO 13-10', 'FD08 p.21', 'Cook p.64', 'Cook p.69', 'EJ'], judgement: true,
    follows: 'NATO 13-8 (said of corrections to point performance), applied here by analogy for the 10 % limit',
    needs: 'rows {3}, {20} or {4}, and {63}, and {35} or {64}',
  }),
  def({
    id: 'thrust-drag', title: 'Corrected thrust matches drag', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'A real flight test cannot measure drag, so drag is derived from thrust and the residual acceleration; X-Plane’s drag output is a model output and serves only as a cross-check. Tolerances are engineering judgement.',
    cite: ['NATO 13-4', 'NATO 13-9', 'NATO 9-4', 'FD08 p.21', 'EJ'], judgement: true, needs: 'rows {64} and {35}',
  }),
  def({
    id: 'configuration-constant', title: 'Configuration unchanged', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Flap, gear, speedbrake and thrust belong to each test point’s configuration, and the quasi-steady technique sets each throttle at a given altitude-weight-configuration. No source gives a number for “unchanged”: the 0.001 range tolerance is engineering judgement.',
    cite: ['NATO 8-4', 'NATO 29-1', 'NATO 13-9', 'NATO 15-5'], judgement: true, needs: 'row {13}; gear needs row {14} or {67}',
  }),
  def({
    id: 'configuration-match', title: 'Clean, one configuration', severity: 'critical', scope: 'point', interval: 'SET',
    why: 'The test aircraft should be in its standard external configuration; flap, gear, speedbrake and thrust belong to each test point’s configuration; the lecture’s glider polars apply to a clean aircraft. Tolerances are engineering judgement.',
    cite: ['NATO 13-2', 'NATO 8-4', 'NATO 29-1', 'Cook p.34', 'FD12b p.23', 'EJ'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'trim-fixed', title: 'Pitch trim still', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'When an autopilot’s altitude hold is tested NATO records stabiliser position, so a drift can be traced to a speed change or a trim action; pitch-trim drag is part of the measured drag. A slow drift hardly changes the drag; a step starts a transient.',
    cite: ['NATO 21-7', 'NATO 13-9', 'EJ'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'wings-level', title: 'Wings level, unaccelerated', severity: 'critical', scope: 'point', interval: 'R',
    why: 'The drag curve assumes steady, non-accelerating level flight with lift equal to weight; a bank φ raises the lift needed by 1/cos φ and the induced drag by its square, which no energy correction removes. The accelerometer reads cos θ cos φ in unaccelerated flight. Tolerances are engineering judgement.',
    cite: ['FD08 p.4', 'FD03 p.5', 'Cook p.33', 'Cook p.63', 'EJ'], judgement: true, needs: 'rows {17}, {18} and {4}',
  }),
  def({
    id: 'weather', title: 'Calm air', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Weather requirements for performance tests may be very stringent: vertical air motion and wind gradients bias climb-type measurements, and vertical air motion enters the energy equation directly. Tolerances are engineering judgement.',
    cite: ['NATO 8-3', 'NATO 13-9', 'App dictionary.ts lines 61, 62, 155', 'EJ'], judgement: true,
    needs: 'rows {3} and {20}; add {152}',
  }),
  def({
    id: 'isa-day', title: 'Standard (ISA) day', severity: 'advisory', scope: 'point', interval: 'R; SET',
    why: 'Data reduction calculates standard-day values, and point performance needs the temperature within tolerances. Tolerance is engineering judgement.',
    cite: ['NATO 13-3', 'EJ'], judgement: true, needs: 'row {151}, or rows {3}, {4} and {20} for the TAS/Mach estimate',
  }),
  def({
    id: 'near-stall', title: 'Back side or near the stall', severity: 'advisory', scope: 'point', interval: 'R against SET',
    why: 'Below the minimum-drag speed the force balance is unstable with speed (the back side), so such points drift at fixed throttle. Near the stall the lift curve bends and the drag leaves the parabolic polar on which the model rests; NATO discards a point only for a good technical reason, and this is one. Thresholds are engineering judgement.',
    cite: ['Cook p.35', 'Cook p.152', 'NATO 13-5', 'NATO 13-3', 'Cook p.64', 'Cook p.509', 'EJ'], judgement: true, needs: 'rows {18} and {68}',
  }),
  def({
    id: 'compressibility', title: 'Mach effects at the fast end', severity: 'advisory', scope: 'point', interval: 'R against SET',
    why: 'Cruise drag is primarily a function of lift coefficient and Mach number; as compressibility becomes significant the coefficients depend on Mach as well as incidence. Thresholds are engineering judgement.',
    cite: ['NATO 13-10', 'NATO 13-9', 'Cook p.36', 'EJ'], judgement: true, needs: 'rows {4} and {68}',
  }),
  def({
    id: 'envelope', title: 'Out of ground effect, inside limits', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'Ground effect lasts up to about one wingspan above the ground, and a test plan states the envelope and the source of its limits. 500 ft is engineering judgement.',
    cite: ['NATO 13-4', 'NATO 8-3', 'EJ'], judgement: true, needs: 'row {20}',
  }),
  def({
    id: 'weight-cg', title: 'Weight, CG and W/δ', severity: 'info', scope: 'point', interval: 'R',
    why: 'Weight and CG are part of each test point; pitch-trim drag depends on CG position; jet cruise data are presented against weight over pressure ratio.',
    cite: ['NATO 29-1', 'NATO 13-9', 'NATO 13-10'], judgement: false, needs: 'row {63}',
  }),
  def({
    id: 'weight-column', title: 'Current weight used', severity: 'analysis', scope: 'set', interval: 'SET and the plotted channels',
    why: 'Excess thrust and weight are used to derive lift and drag, inaccurate weight makes them inaccurate, and each point’s weight is part of its configuration. In X-Plane, total,___lb is the current weight and gross,___lb the maximum.',
    cite: ['NATO 13-3', 'NATO 9-11', 'NATO 29-1', 'App dictionary.ts lines 167, 168, 172', 'App src/core/channels/guide.ts line 58'], judgement: false, needs: 'row {63}',
  }),
  def({
    id: 'weight-spread', title: 'Weight change across the points', severity: 'analysis', scope: 'set', interval: 'U',
    why: 'Data reduction calculates standard-day values reduced to standard weight; corrections below about 10 % may be linearised. The minimum-drag speed scales with √(W/ρ), as the lecture’s glider polars at three wing loadings show. The brief sets no weight requirement, so reduction is advice, not a rule.',
    cite: ['NATO 13-2', 'NATO 13-3', 'NATO 13-8', 'Cook p.510', 'FD12b p.22', 'FD12b p.23', 'B p.7', 'EJ'], judgement: true,
    follows: 'NATO 13-2 and 13-3 (reduce) over the brief’s silence (B p.7)', needs: 'row {63}',
  }),
  def({
    id: 'altitude-band', title: 'One altitude band', severity: 'analysis', scope: 'set', interval: 'U',
    why: 'The technique builds a power-required curve at one altitude while holding a constant altitude; jet cruise data reduce through weight over pressure ratio; corrections below about 10 % may be linearised. Bands are engineering judgement.',
    cite: ['NATO 13-9', 'NATO 13-10', 'NATO 13-8', 'Cook p.510', 'EJ'], judgement: true, needs: 'row {20}',
  }),
  def({
    id: 'point-count', title: 'Enough points', severity: 'critical', scope: 'set', interval: 'U',
    why: 'The lectures average each window and fit five and six points; NATO recommends the average of about five tests over a range of airspeeds read from a curve fit; a spread of speeds beats repeating one. The dependence on the fit’s parameters is engineering judgement.',
    cite: ['FD12c p.10', 'FD12c p.11', 'FD12c p.17', 'NATO 13-8', 'NATO 13-9', 'NATO 13-3', 'EJ'], judgement: true,
    follows: 'FD12c p.11 and p.17 (5 and 6 points) and NATO 13-8', needs: 'Needs a fit through test points',
  }),
  def({
    id: 'bracket-endurance', title: 'Endurance optimum inside the data', severity: 'critical', scope: 'set', interval: 'FIT',
    why: 'NATO asks for speeds from the back side of the power curve to near maximum speed and allows limited extrapolation; the lecture reads maximum endurance at the fitted curve’s minimum, and its own X-Plane example has that minimum at its slowest point, so a modest extrapolation is a warning. NATO gives no endurance criterion, so the fuel-based part is advisory (U3).',
    cite: ['NATO 13-10', 'NATO 13-4', 'FD12c p.11', 'FD12c p.17', 'App src/core/analysis/rangeEndurance.ts', 'EJ'], judgement: true,
    follows: 'FD12c p.11 and p.17 (minimum of the plotted curve) for the critical part; NATO 13-10 and 13-4 for the extrapolation advice',
    needs: 'Needs a range-and-endurance fit through test points',
  }),
  def({
    id: 'bracket-range', title: 'Range optimum inside the data', severity: 'critical', scope: 'set', interval: 'FIT',
    why: 'The lecture reads maximum range where the tangent from the origin touches the fitted curve. NATO’s range criterion is the range factor (air miles per pound of fuel), so for a jet the fuel-based optimum is reported beside it, advisory (U3). NATO allows limited extrapolation and asks for speeds up to near maximum.',
    cite: ['FD12c p.11', 'FD12c p.14', 'NATO 13-10', 'NATO 13-4', 'App src/core/analysis/rangeEndurance.ts', 'EJ'], judgement: true,
    follows: 'FD12c p.11 and p.14 (tangent on the plotted curve) for the critical part; NATO 13-10 (range factor) for the advisory jet part',
    needs: 'Needs a range-and-endurance fit through test points',
  }),
  def({
    id: 'construction', title: 'Right construction for the engine', severity: 'analysis', scope: 'set', interval: 'FIT',
    why: 'The lecture’s chart is a propeller (power) chart: maximum endurance at minimum power, maximum range from the line through the origin. On a jet’s thrust curve the minimum is maximum endurance and the tangent maximum range, both only if TSFC is constant (U3); thrust is NATO’s jet term and power its propeller term.',
    cite: ['FD12c p.14', 'FD12c p.11', 'NATO 13-2', 'NATO 13-10', 'App src/core/analysis/rangeEndurance.ts', 'App dictionary.ts line 418'], judgement: false,
    needs: 'Not checkable until the engine type is known: log row {68} or the SFC row, or choose jet or propeller in the checklist settings',
  }),
  def({
    id: 'speed-axis', title: 'Plotted against true airspeed', severity: 'analysis', scope: 'set', interval: 'FIT',
    why: 'Range is air distance per unit of fuel, so the tangent construction needs true airspeed; recorded airspeed is corrected for instrument and position error before TAS is calculated, and position error depends on angle of attack.',
    cite: ['NATO 13-10', 'NATO 13-3', 'NATO 11-4', 'App dictionary.ts line 44'], judgement: false, needs: 'Needs an X–Y x channel',
  }),
  def({
    id: 'fuel-flow', title: 'Fuel flow logged (jets)', severity: 'advisory', scope: 'set', interval: 'U',
    why: 'Fuel used, fuel-flow rates, time and engine parameters must all be recorded; NATO’s range factor is per pound of fuel; the lecture’s construction works on the consumption quantity itself. The 3 % spread is engineering judgement.',
    cite: ['NATO 13-2', 'NATO 13-10', 'FD12c p.10', 'FD12c p.14', 'EJ'], judgement: true, needs: 'row {45} or the SFC row',
  }),
  def({
    id: 'fuel-bookkeeping', title: 'Fuel flow matches fuel burnt', severity: 'advisory', scope: 'set', interval: 'first R.start to last R.end',
    why: 'Fuel used and fuel flow are both performance records, and NATO calibrates the fuel measuring system by weighing the aircraft at several fuel loads. Tolerance is engineering judgement.',
    cite: ['NATO 13-2', 'NATO 9-11', 'App src/core/analysis/derived.ts', 'EJ'], judgement: true, needs: 'rows {45} and {63} or {62}',
  }),
  def({
    id: 'fit-quality', title: 'Fit quality and uncertainty', severity: 'advisory', scope: 'set', interval: 'FIT',
    why: 'NATO reads the result from a computer curve fit and judges its accuracy by the random error limit of the fit, without giving a method (the jackknife estimates it); the two-term models fix the ratio of the two speeds. Bands are engineering judgement.',
    cite: ['NATO 13-9', 'FD12c p.17', 'App src/core/analysis/rangeEndurance.ts', 'EJ'], judgement: true, needs: 'Needs a fit with n ≥ p + 2',
  }),
  def({
    id: 'repeats', title: 'Repeated speeds', severity: 'info', scope: 'set', interval: 'SET',
    why: 'A spread of speeds is worth more than repeating one condition, but duplicating an early test shows whether anything has drifted.',
    cite: ['NATO 13-3', 'NATO 13-2'], judgement: false, needs: 'Needs two points at the same speed',
  }),
  def({
    id: 'autopilot-record', title: 'Autopilot modes recorded', severity: 'advisory', scope: 'set', interval: 'S+R; ±30 s for the inference',
    why: 'Autopilot or stability-augmentation status is part of each test point’s configuration. The servo can keep a value after disconnect, so the evidence is whether the surface follows the servo or the stick. Whether autopilot-held points are accepted is open item U1.',
    cite: ['NATO 29-1', 'NATO 29-2', 'App dictionary.ts lines 204, 599, 612-614'], judgement: true,
    needs: 'row {117} or {108}, or rows {8}, {11} and {138} to infer; otherwise state the modes you used',
  }),
]

const DEF = new Map(PERFORMANCE_DEFS.map((x) => [x.id, x]))
const d = (id: string): CheckDef => DEF.get(id) as CheckDef
const KIND = 'performance' as const
const isaDaySet: CheckDef = { ...d('isa-day'), scope: 'set', title: 'Standard (ISA) day: the same for every point' }

export const PERF_OPEN: Readonly<Record<'U1' | 'U2' | 'U3' | 'U4' | 'U5' | 'U6' | 'U7', Omit<OpenItem, 'id'>>> = {
  U1: {
    title: 'Autopilot-held level points',
    question: 'Are level points held by the autopilot (altitude hold or vertical-speed mode, throttle by hand) acceptable for range and endurance? NATO has the pilot hold a constant altitude but does not say how, and a steady altitude keeps the energy corrections small; the lectures mention the autopilot only as suppressing the phugoid; the brief is silent.',
    meanwhile: 'Declare the modes, measure and correct the residual climb (energy correction), and ask.',
    citations: formatCitations(['NATO 13-9', 'NATO 13-10', 'NATO 13-7', 'NATO 21-6', 'FD13 p.13', 'B p.7']),
  },
  U2: {
    title: 'Autothrottle-held points',
    question: 'Are points whose speed the autothrottle held acceptable? NATO’s quasi-steady technique sets a throttle and lets the speed settle, and fixes the lever with the autothrottle off for its non-steady runs.',
    meanwhile: 'Declare it; the point may stand if the throttle, speed and thrust–drag checks pass.',
    citations: formatCitations(['NATO 13-9', 'NATO 13-10', 'NATO 24-6']),
  },
  U3: {
    title: 'Jet criteria from a thrust curve',
    question: 'Is a thrust-required curve with the constant-TSFC assumption accepted for a jet’s range and endurance, or are fuel-flow optima expected? The lectures build the construction on a propeller power chart; NATO defines range on fuel and gives no endurance criterion.',
    meanwhile: 'Show both, cite a Resource List text for the jet criteria, and ask.',
    citations: formatCitations(['FD12c p.10', 'FD12c p.11', 'FD12c p.14', 'NATO 13-10', 'Cook p.510', 'B p.4']),
  },
  U4: {
    title: 'Reduction to a standard weight and altitude',
    question: 'Does the coursework expect the points reduced to a standard weight and altitude, or is stating the spread enough? The brief names no standard condition; NATO reduces data to standard-day values and weight.',
    meanwhile: 'Reduce (constant C_L) or state the spread, and ask.',
    citations: formatCitations(['B p.7', 'NATO 13-2', 'NATO 13-3']),
  },
  U5: {
    title: 'One altitude, weight band and CG',
    question: 'Is one altitude, one weight band and one CG enough for range and endurance? NATO verifies performance at several weights and altitudes and makes trim drag a function of CG; the brief is silent.',
    meanwhile: 'State it as a limitation and an enhancement, and ask.',
    citations: formatCitations(['NATO 13-3', 'NATO 13-10', 'NATO 13-9', 'FD12b p.28', 'B p.7']),
  },
  U6: {
    title: 'X-Plane’s drag output as data',
    question: 'May X-Plane’s own drag output stand in for the measured drag? A performance model needs thrust and drag known in absolute value, and a simulator’s fidelity is unknown; the lecture’s X-Plane example plots the engine power X-Plane outputs.',
    meanwhile: 'Derive drag from thrust (energy correction) and keep X-Plane’s drag as the check.',
    citations: formatCitations(['NATO 13-4', 'NATO 13-9', 'NATO 9-4', 'FD12c p.15']),
  },
  U7: {
    title: 'Hours and nautical miles',
    question: 'Are range and endurance figures (hours, nautical miles, on a full tank) expected, or do the optimum speeds suffice? The brief asks for range and endurance and numerical analysis where possible; the lecture examples give the two speeds.',
    meanwhile: 'Label a full-tank figure as an extrapolation, state its assumptions, and ask.',
    citations: formatCitations(['B p.7', 'FD12c p.11', 'FD12c p.17', 'NATO 13-4']),
  },
}

/** Short reasons for a point left out, by the check that failed (for the verdict). */
export const PERF_REASON: Readonly<Record<string, string>> = {
  'time-base': 'a reset or gap inside the record',
  'sample-rate': 'too few samples',
  'record-length': 'record too short',
  'throttle-fixed': 'throttle moved inside the record',
  'speed-steady': 'speed oscillating',
  level: 'altitude porpoising',
  'energy-correction': 'energy correction over 10 %',
  'configuration-constant': 'configuration changed',
  'configuration-match': 'another configuration',
  'wings-level': 'not wings level',
  weather: 'changing wind or vertical air',
}

// ------------------------------------------------------------------ ISA and quantities

function isa(hp: number) {
  const theta = 1 - 6.8755856e-6 * hp
  const delta = theta ** 5.2558797
  return { theta, delta, sigma: delta / theta, a: 661.48 * Math.sqrt(theta), tK: 288.15 * theta }
}

/** Per-point quantities over a record (NaN where a channel is missing). */
export function perfPointMetrics(ds: Dataset, point: TestPoint, x: Channel | null, y: Channel | null, kappaDeg = 0): PointMetrics {
  const a = Math.max(0, point.start)
  const b = Math.min(ds.rowCount, point.end)
  const time = ds.elapsed
  const mean = (ch: Channel | null) => (ch ? summary(ch.values, a, b).mean : NaN)
  const ktas = findChannel(ds, 'Vtrue,_ktas')
  const tv = ktas ? trend(ktas.values, time, a, b) : null
  const v = tv?.mean ?? NaN
  const dvdt = tv?.slope ?? NaN
  const geo = findChannel(ds, '___CG,ftMSL')
  const palt = findChannel(ds, 'p-alt,ftMSL')
  const vvi = findChannel(ds, '__VVI,__fpm')
  const temp = findChannel(ds, 'AMtmp,_degC')
  const hp = mean(palt)
  const atm = isa(Number.isFinite(hp) ? hp : 0)
  let dhdt = NaN
  let altScatter = NaN
  if (geo) {
    const t = trend(geo.values, time, a, b)
    dhdt = t.slope
    altScatter = 2 * t.residualSd
  } else if (palt) {
    const t = trend(palt.values, time, a, b)
    const tK = temp ? mean(temp) + 273.15 : atm.tK
    dhdt = (t.slope * tK) / atm.tK
    altScatter = 2 * t.residualSd
  } else if (vvi) dhdt = mean(vvi) / 60
  const thrusts = engineChannels(ds, THRUST)
  const powers = engineChannels(ds, POWER_HP).length ? engineChannels(ds, POWER_HP) : engineChannels(ds, POWER_LEGACY)
  const thrust = thrusts.length ? thrusts.reduce((s, c) => s + mean(c), 0) : NaN
  const power = powers.length ? powers.reduce((s, c) => s + mean(c), 0) : NaN
  const ffs = engineChannels(ds, FUEL_FLOW)
  const sfcs = engineChannels(ds, TSFC)
  let ff = ffs.length ? ffs.reduce((s, c) => s + mean(c), 0) : NaN
  if (!ffs.length && sfcs.length && thrusts.length) {
    ff = 0
    for (let k = 1; k <= 8; k += 1) {
      const sfc = findChannel(ds, TSFC(k))
      const th = findChannel(ds, THRUST(k))
      if (sfc && th) ff += mean(sfc) * mean(th)
    }
  }
  const alpha = mean(findChannel(ds, 'alpha,__deg'))
  const w = mean(findChannel(ds, 'total,___lb'))
  const keas = mean(findChannel(ds, '_Vind,_keas'))
  const s = mean(findChannel(ds, 'S-ref,ft*ft'))
  const q = 0.5 * RHO0 * (KT * keas) ** 2
  const dens = findChannel(ds, '_dens,ratio')
  const tK = temp ? mean(temp) + 273.15 : NaN
  const sigma = dens ? mean(dens) : Number.isFinite(tK) ? (atm.sigma * atm.tK) / tK : atm.sigma
  const machCh = findChannel(ds, '_Mach,ratio')
  const mach = machCh ? mean(machCh) : v / atm.a
  const dIsa = Number.isFinite(tK) ? tK - atm.tK : machCh && Number.isFinite(v) ? atm.tK * ((v / (mach * atm.a)) ** 2 - 1) : NaN
  const vFts = v * KT
  const climb = (w * dhdt) / vFts
  const acc = (w / G0) * dvdt * KT
  const total = climb + acc
  const angle = ((alpha + kappaDeg) * Math.PI) / 180
  const tForce = Number.isFinite(thrust) ? thrust : NaN
  const cosTerm = tForce * (1 - Math.cos(Number.isFinite(angle) ? angle : 0))
  const dCorr = tForce * Math.cos(Number.isFinite(angle) ? angle : 0) - total
  const drag = mean(findChannel(ds, '_drag,___lb'))
  let share = Math.abs(total) / dCorr
  if (!Number.isFinite(thrust) && Number.isFinite(power)) share = Math.abs(total * vFts) / (550 * power)
  else if (!Number.isFinite(thrust) && Number.isFinite(drag)) share = Math.abs(total) / drag
  const ffCorr = (ff * (tForce - total)) / tForce
  const clCh = findChannel(ds, '___cl,total')
  const cdCh = findChannel(ds, '___cd,total')
  const nz = mean(findChannel(ds, 'Gload,norml'))
  const clW = ((Number.isFinite(nz) ? nz : 1) * w) / (q * s)
  const cl = clCh ? mean(clCh) : clW
  const cd = Number.isFinite(dCorr) && Number.isFinite(s) ? dCorr / (q * s) : cdCh ? mean(cdCh) : NaN
  return {
    v,
    dvdt,
    drift: dvdt * 60,
    scatter: tv ? 2 * tv.residualSd : NaN,
    dhdt,
    altScatter,
    w,
    thrust,
    power,
    ff,
    alpha,
    mach,
    hp,
    keas,
    kias: mean(findChannel(ds, '_Vind,_kias')),
    q,
    s,
    sigma,
    dIsa,
    drag,
    cl,
    clW,
    cd,
    cg: mean(findChannel(ds, '___cg,ftref')),
    fuel: mean(findChannel(ds, '_fuel,___lb')),
    climb,
    acc,
    total,
    cosTerm,
    dCorr,
    share,
    ffCorr,
    x: mean(x),
    y: mean(y),
  }
}

/** The fit through point means with the plotted model, and its two optima (physical models in closed form). */
export function fitThrough(xs: readonly number[], ys: readonly number[], kind: XYConfig['fit']): PerfFit | null {
  const pairs = xs.map((x, i) => [x, ys[i]] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (kind === 'none' || pairs.length < 2) return null
  const vx = pairs.map((p) => p[0])
  const vy = pairs.map((p) => p[1])
  const xMin = Math.min(...vx)
  const xMax = Math.max(...vx)
  if (kind === 'power-model' || kind === 'drag-model') {
    const model: PhysicalModel = kind === 'power-model' ? 'power' : 'drag'
    const fit = physicalFit(vx, vy, model)
    if (!fit) return null
    const problem = physicalProblem(fit)
    if (problem) return { model: kind, n: fit.n, r2: fit.r2, vE: null, vR: null, problem, xMin, xMax }
    const vE = model === 'power' ? (fit.b / (3 * fit.a)) ** 0.25 : (fit.b / fit.a) ** 0.25
    const vR = model === 'power' ? (fit.b / fit.a) ** 0.25 : ((3 * fit.b) / fit.a) ** 0.25
    return { model: kind, n: fit.n, r2: fit.r2, vE, vR, problem: '', xMin, xMax }
  }
  const degree = kind === 'linear' ? 1 : kind === 'poly2' ? 2 : 3
  const fit = polyFit(vx, vy, degree)
  if (!fit) return null
  const re = polyRangeEndurance(fit)
  return {
    model: kind,
    n: fit.n,
    r2: fit.r2,
    vE: re.endurance?.v ?? null,
    vR: re.range?.v ?? null,
    problem: re.endurance ? (re.range ? '' : re.rangeNote) : re.enduranceNote,
    xMin,
    xMax,
  }
}

const FIT_PARAMETERS: Readonly<Record<XYConfig['fit'], number>> = { none: 0, linear: 2, poly2: 3, poly3: 4, 'power-model': 2, 'drag-model': 2 }

export type PlottedQuantity = 'thrust' | 'drag' | 'power' | 'fuel-flow' | 'other'

/** What the plotted Y is, from its token or (a formula) its name and the channels it uses. */
export function plottedQuantity(ds: Dataset, ch: Channel | null): PlottedQuantity {
  if (!ch) return 'other'
  const token = ch.token
  if (/^thrst,_\d,lb$/.test(token)) return 'thrust'
  if (token === '_drag,___lb') return 'drag'
  if (/^engn\d,___hp$|^power,_\d,hp$/.test(token)) return 'power'
  if (/^FF__\d,(_lb\/h|gal\/h)$|^___ff,__pph$/.test(token)) return 'fuel-flow'
  if (ch.derived) {
    const name = `${ch.meta.label} ${ch.id}`.toLowerCase()
    if (/fuel flow|fuel_flow/.test(name)) return 'fuel-flow'
    if (/power|thrust power/.test(name)) return 'power'
    if (/thrust/.test(name)) return 'thrust'
    if (/drag/.test(name)) return 'drag'
    const refs = [...refsOf(ds, ch)]
    if (refs.length && refs.every((r) => /^thrst_\d_lb$|^thrst,_\d,lb$/.test(r))) return 'thrust'
    if (refs.length && refs.every((r) => /^engn\d_hp$|^engn\d,___hp$/.test(r))) return 'power'
    if (refs.length && refs.every((r) => /^FF_\d_lb_h$|^FF__\d,_lb\/h$/.test(r))) return 'fuel-flow'
  }
  return 'other'
}

/** The engine type: declared, else from the propeller-efficiency figure, the SFC kind or the fuel-flow unit. */
export function propulsionType(ds: Dataset, declared?: 'jet' | 'propeller'): { type: 'jet' | 'propeller' | null; reason: string } {
  if (declared) return { type: declared, reason: 'declared' }
  const eta = findChannel(ds, '__L/D,*etaP')
  const thrusts = engineChannels(ds, THRUST)
  const thrustPositive = thrusts.some((c) => c.stats.max > 0)
  if (eta && eta.stats.max <= 0 && eta.stats.min >= 0 && thrustPositive) return { type: 'jet', reason: '__L/D,*etaP is 0 with positive thrust' }
  if (engineChannels(ds, TSFC).length) return { type: 'jet', reason: 'TSFC (lb/lb·h) is logged' }
  if (eta && eta.stats.max > 0.01) return { type: 'propeller', reason: '__L/D,*etaP > 0' }
  if (engineChannels(ds, BSFC).length) return { type: 'propeller', reason: 'BSFC (lb/hp·h) is logged' }
  const gph = engineChannels(ds, (k) => `FF__${k},gal/h`)
  if (gph.length && !engineChannels(ds, FUEL_FLOW).length) return { type: 'propeller', reason: 'fuel flow only in gal/h' }
  const epr = engineChannels(ds, (k) => `EPR_${k},_part`)
  if (epr.some((c) => !c.stats.constant)) return { type: 'jet', reason: 'EPR varies' }
  return { type: null, reason: 'no row tells the engine type' }
}

// ------------------------------------------------------------------ the run

const CRITICAL = new Set(['time-base', 'sample-rate', 'record-length', 'throttle-fixed', 'speed-steady', 'level', 'energy-correction', 'configuration-constant', 'configuration-match', 'wings-level'])

/** Runs the performance checklist on one set of points. */
export function runPerfChecks(input: PerfInput): PerfReport {
  const { ds, x, y } = input
  const settings = input.settings ?? {}
  const kappa = Number.isFinite(settings.thrustAngleDeg) ? (settings.thrustAngleDeg as number) : 0
  const SET = input.points.filter((p) => p.end > p.start)
  const time = ds.elapsed
  const metrics = SET.map((p) => perfPointMetrics(ds, p, x, y, kappa))
  const ktas = findChannel(ds, 'Vtrue,_ktas')
  const weight = findChannel(ds, 'total,___lb')
  const turb = findChannel(ds, '_turb,_locl')
  const wind = findChannel(ds, '_wind,knots')
  const vwind = findChannel(ds, '_wind,v_fpm')
  const gs = findChannel(ds, 'Vtrue,_ktgs')
  const lat = findChannel(ds, '__lat,__deg')
  const lon = findChannel(ds, '__lon,__deg')
  const hdg = findChannel(ds, 'hding,_true')
  const beta = findChannel(ds, '_beta,__deg')
  const vpath = findChannel(ds, 'vpath,__deg')
  const phi = findChannel(ds, '_roll,__deg')
  const theta = findChannel(ds, 'pitch,__deg')
  const nz = findChannel(ds, 'Gload,norml')
  const trimCh = findChannel(ds, '_trim,_elev')
  const agl = findChannel(ds, '_gear,ftagl')
  const kias = findChannel(ds, '_Vind,_kias')
  const machCh = findChannel(ds, '_Mach,ratio')
  const levers = leverChannels(ds)
  const modeChannels = ['_fdir,_mode', '_mode,__alt', '_mode,hding', '_auto,throt', '__set,__vvi', '_dial,__alt', '__set,speed']
    .map((tok) => findChannel(ds, tok))
    .filter((c): c is Channel => c !== null)
  const propulsion = propulsionType(ds, settings.propulsion)
  const fitAll = fitThrough(metrics.map((m) => m.x), metrics.map((m) => m.y), input.fit)

  // thrust-drag first: the weather check uses it when row 152 is missing.
  const thrustDrag = metrics.map((m) => (Number.isFinite(m.drag) && m.drag > 0 && Number.isFinite(m.dCorr) ? (m.dCorr - m.drag) / m.drag : NaN))
  const thrustDragAllPass = thrustDrag.length > 0 && thrustDrag.every((r) => Math.abs(r) <= 0.01)

  // Reference fits for near-stall and compressibility (points between the 25th and 75th TAS percentiles).
  const ref = referenceFits(metrics)

  const ctxs = SET.map((point, i) => {
    const m = metrics[i]
    const a = Math.max(0, point.start)
    const b = Math.min(ds.rowCount, point.end)
    const L = b > a ? time[b - 1] - time[a] : 0
    const pid = { pointId: point.id }
    const checks: Check[] = []

    // time-base
    const tb = timeBase(ds, a, b)
    if (tb.kind === 'none') checks.push(notCheckable(d('time-base'), KIND, pid))
    else {
      const status: CheckStatus = tb.crosses ? 'fail' : tb.kind === 'sim' ? 'pass' : 'warn'
      checks.push(result(d('time-base'), KIND, status, `time from ${tb.source}${tb.crosses ? '; a reset or gap inside' : ''}`, 'pass: sim time and no reset or gap inside R; warn: real time or another clock; fail: a reset or gap inside', status === 'fail' ? 'Re-cut the record inside one continuous stretch.' : status === 'warn' ? 'Rates are per wall-clock second: log row 1 for sim time.' : '', pid))
    }

    // sample-rate
    const sr = sampleRate(ds, a, b)
    {
      let status: CheckStatus = atLeast(sr.rate, 1) ? 'pass' : atLeast(sr.rate, 0.2) ? 'warn' : 'fail'
      if (!Number.isFinite(sr.rate)) status = 'fail'
      if (sr.dropouts > 0) status = worse(status, 'warn')
      checks.push(result(d('sample-rate'), KIND, status, `${fmt(sr.rate, 3)} Hz${sr.dropouts ? `, ${sr.dropouts} dropout${sr.dropouts === 1 ? '' : 's'}` : ''}`, 'pass ≥ 1 Hz and no dropouts; warn 0.2–1 Hz or a dropout; fail < 0.2 Hz', status === 'pass' ? '' : 'Log at 10 writes per second.', pid))
    }

    // record-length
    const n = ktas ? summary(ktas.values, a, b).n : 0
    {
      const status: CheckStatus = L < 5 || n < 10 ? 'fail' : L >= 60 ? 'pass' : 'warn'
      checks.push(result(d('record-length'), KIND, status, `${fix(L, 1)} s, ${n} samples`, 'pass ≥ 60 s; warn 5–60 s; fail < 5 s or < 10 samples', status === 'warn' ? 'Record the last minute of each point when you fly it.' : status === 'fail' ? 'Too short to average: re-cut or refly.' : '', pid))
    }

    // speed-steady status (stabilised uses it)
    const speedStatus: CheckStatus | null = ktas
      ? !(m.scatter <= 4) ? 'fail' : Math.abs(m.drift) <= 0.5 && m.scatter <= 2 ? 'pass' : 'warn'
      : null

    // stabilised
    {
      const st = settling(ds, a, b, 300)
      if (st.by === null || (!st.found && st.lookback < 60)) checks.push(notCheckable(d('stabilised'), KIND, { ...pid, needs: st.by === null ? undefined : 'Not checkable — the log or a segment starts less than 60 s before the record and holds no throttle change' }))
      else {
        const tSet = st.tSet ?? 0
        const flat = !(Math.abs(st.thrustTrend) > 1)
        const status: CheckStatus = tSet >= 60 ? 'pass' : flat && speedStatus === 'pass' ? 'info' : 'warn'
        checks.push(result(d('stabilised'), KIND, status, `${st.found ? `set ${fix(tSet, 0)} s after a power change` : `no throttle change in the ${fix(st.lookback, 0)} s before`}${Number.isFinite(st.thrustTrend) ? `; thrust trend ${signed(st.thrustTrend, 1)} %` : ''}`, 'pass ≥ 60 s; info: sooner but already steady; warn: sooner and still settling (never fails)', status === 'warn' ? 'Taken while still settling: the energy correction matters for this point.' : status === 'info' ? 'Set soon after a power change, but already steady.' : '', pid))
      }
    }

    // throttle-fixed
    const ps = powerSteadiness(ds, a, b)
    if (!levers.length && ps.force === null) checks.push(notCheckable(d('throttle-fixed'), KIND, pid))
    else {
      const lever = ps.leverRange
      const force = ps.force === 'thrust' || ps.force === 'power' ? ps.forceRange : NaN
      const status = worse(
        Number.isFinite(lever) ? grade(lever, 0.002, 0.01) : null,
        Number.isFinite(force) ? grade(force, 0.01, 0.03) : ps.force === 'n1' ? grade(ps.n1Range, 0.5, 1.5) : null,
      )
      checks.push(result(d('throttle-fixed'), KIND, status, [Number.isFinite(lever) ? `lever range ${fmt(lever, 2)}` : '', Number.isFinite(force) ? `${ps.force} range ${pct(force, 2)}` : ps.force === 'n1' ? `N1 range ${fix(ps.n1Range, 2)} %pt` : ''].filter(Boolean).join('; '), 'pass: lever range ≤ 0.002 and thrust range ≤ 1 % (N1 ≤ 0.5 %pt); warn ≤ 0.01 and ≤ 3 % (1.5 %pt); fail beyond', status === 'fail' ? 'The throttle changed inside the record: re-cut it to its constant-throttle part (Re-cut this point) or refly.' : '', pid))
    }

    // autothrottle-off
    const at = autothrottleEvidence(ds, a, b, ktas)
    {
      if (at.basis === 'none') checks.push(notCheckable(d('autothrottle-off'), KIND, pid))
      else if (at.basis === 'logged') {
        const status: CheckStatus = at.codeOn ? 'warn' : 'pass'
        checks.push(result(d('autothrottle-off'), KIND, status, `_auto,throt ${at.codeOn ? 'not 0' : '0'} (a mode code: confirm its meaning with a calibration recording)`, 'pass: _auto,throt 0, or the levers still; warn: an autothrottle pattern or a code not 0 (never fails)', status === 'warn' ? 'Declare autothrottle use for this point (open item U2).' : '', pid))
      } else {
        const status: CheckStatus = at.atLike ? 'warn' : at.share <= 0.01 ? 'pass' : 'info'
        checks.push(result(d('autothrottle-off'), KIND, status, `lever changed in ${pct(at.share, 1)} of samples, range ${fmt(at.leverRange, 2)}${at.atLike ? ' — autothrottle-like (inferred)' : ''}`, 'pass: levers still (changes in ≤ 1 % of samples); warn: many small changes, levers together, speed held (autothrottle-like)', status === 'warn' ? 'Declare autothrottle use for this point (open item U2).' : '', pid))
      }
    }

    // speed-steady
    if (!ktas) checks.push(notCheckable(d('speed-steady'), KIND, pid))
    else checks.push(result(d('speed-steady'), KIND, speedStatus ?? 'fail', `drift ${signed(m.drift, 2)} kt/min, 2σ ${fix(m.scatter, 2)} kt (TAS)`, 'pass |drift| ≤ 0.5 kt/min and 2σ ≤ 2 kt; warn a larger drift (corrected) or 2σ 2–4 kt; fail 2σ > 4 kt (oscillating)', speedStatus === 'warn' ? 'Keep the point: the energy correction removes the drift.' : speedStatus === 'fail' ? 'The speed oscillated: a linear correction does not describe the record.' : '', pid))

    // level
    if (!Number.isFinite(m.dhdt)) checks.push(notCheckable(d('level'), KIND, pid))
    else {
      const fpm = m.dhdt * 60
      const status: CheckStatus = m.altScatter > 100 ? 'fail' : Math.abs(fpm) <= 20 && !(m.altScatter > 20) ? 'pass' : 'warn'
      checks.push(result(d('level'), KIND, status, `climb rate ${signed(fpm, 1)} fpm, altitude 2σ ${fix(m.altScatter, 1)} ft`, 'pass |ḣ| ≤ 20 fpm and 2σ ≤ 20 ft; warn a larger ḣ (corrected) or 2σ 20–100 ft; fail 2σ > 100 ft (porpoising)', status === 'warn' ? 'Keep the point: the energy correction removes the climb.' : status === 'fail' ? 'Not a quasi-steady point: refly.' : '', pid))
    }

    // energy-correction (the "not checkable" line names only what is missing)
    if (!Number.isFinite(m.share) || !Number.isFinite(m.w)) {
      const missing = [
        !Number.isFinite(m.v) ? 'row {3}' : '',
        !Number.isFinite(m.dhdt) ? 'row {20} or {4}' : '',
        !Number.isFinite(m.w) ? 'row {63}' : '',
        !Number.isFinite(m.thrust) && !Number.isFinite(m.power) && !Number.isFinite(m.drag) ? 'row {35} or {64}' : '',
      ].filter(Boolean)
      checks.push(notCheckable(d('energy-correction'), KIND, { ...pid, needs: missing.length ? missing.join(', ') : undefined }))
    }
    else {
      const status: CheckStatus = m.share <= 0.02 ? 'pass' : m.share <= 0.1 ? 'warn' : 'fail'
      checks.push(result(d('energy-correction'), KIND, status, `|ΔT_E| ${pct(m.share, 2)} of the drag (climb ${signed(m.climb, 0)} lbf, acceleration ${signed(m.acc, 0)} lbf); thrust-axis term ${pct(m.cosTerm / m.dCorr, 2)}`, 'pass ≤ 2 %; warn 2–10 % (use D_corr and FF_corr); fail > 10 %', status === 'warn' ? 'Use the corrected drag and fuel flow for this point, not the raw thrust.' : status === 'fail' ? 'Beyond a linearised correction: refly the point.' : '', pid))
    }

    // thrust-drag
    if (!Number.isFinite(thrustDrag[i])) checks.push(notCheckable(d('thrust-drag'), KIND, pid))
    else {
      const r = thrustDrag[i]
      const raw = (m.thrust - m.drag) / m.drag
      const status: CheckStatus = Math.abs(r) <= 0.01 ? 'pass' : 'warn'
      checks.push(result(d('thrust-drag'), KIND, status, `corrected ${signed(100 * r, 2)} % against X-Plane’s drag (raw thrust ${signed(100 * raw, 2)} %)`, '|r| ≤ 1 % (never fails)', Math.abs(r) > 0.03 ? 'Look for a throttle move, an autothrottle, the wrong weight column, a record edge or vertical air motion.' : status === 'warn' ? 'Small mismatch: note it.' : '', pid))
    }

    // configuration-constant
    const config = configuration(ds, a, b)
    if (!config.surfaces.length) checks.push(notCheckable(d('configuration-constant'), KIND, { ...pid, needs: 'row {13}' }))
    else {
      const moved = config.surfaces.some((s) => s.range > 0.001) || (config.gear !== null && config.gear.range > 0.001)
      const status: CheckStatus = moved ? 'fail' : config.gear ? 'pass' : 'warn'
      checks.push(result(d('configuration-constant'), KIND, status, configText(config, 0.001), 'pass: every range ≤ 0.001; warn: gear not logged; fail: anything moved', status === 'fail' ? 'The configuration changed inside the record: re-cut or refly.' : status === 'warn' ? 'Log row 14 (Gear & brakes).' : '', pid))
    }
    const configMeans = [...config.surfaces.map((s) => s.mean), ...(config.gear ? [config.gear.mean] : [])]

    // trim-fixed
    if (!trimCh) checks.push(notCheckable(d('trim-fixed'), KIND, pid))
    else {
      const range = summary(trimCh.values, a, b).range
      const step = largestChangeWithin(trimCh.values, time, a, b, 0.5)
      const status: CheckStatus = range <= 0.02 && step <= 0.02 ? 'pass' : 'warn'
      checks.push(result(d('trim-fixed'), KIND, status, `trim range ${fmt(range, 2)}, largest change in 0.5 s ${fmt(step, 2)}`, 'pass: range ≤ 0.02 and no step > 0.02 in 0.5 s; warn otherwise (never fails)', status === 'warn' ? 'The trim moved inside the record: check the speed and altitude traces there, or end the record before it.' : '', pid))
    }

    // wings-level
    if (!phi && !beta) checks.push(notCheckable(d('wings-level'), KIND, pid))
    else {
      const p = phi ? summary(phi.values, a, b) : null
      const bb = beta ? summary(beta.values, a, b) : null
      let dn = NaN
      if (nz && theta && phi) {
        let sum = 0
        let k = 0
        for (let r = a; r < b; r += 1) {
          const c = Math.cos((theta.values[r] * Math.PI) / 180) * Math.cos((phi.values[r] * Math.PI) / 180)
          if (Number.isFinite(c)) {
            sum += c
            k += 1
          }
        }
        dn = summary(nz.values, a, b).mean - (k ? sum / k : NaN)
      }
      const status = worse(p ? grade(Math.abs(p.mean), 3, 10) : null, p ? grade(p.sd, 1, 2) : null, bb ? grade(Math.abs(bb.mean), 2, 5) : null, grade(Math.abs(dn), 0.02, 0.05))
      checks.push(result(d('wings-level'), KIND, status, `bank ${p ? `${signed(p.mean, 1)}° (σ ${fix(p.sd, 2)})` : 'not logged'}, sideslip ${bb ? `${signed(bb.mean, 2)}°` : 'not logged'}, n_z − cosθcosφ ${signed(dn, 4)}`, 'pass |φ| ≤ 3°, σφ ≤ 1°, |β| ≤ 2°, |Δn| ≤ 0.02; warn ≤ 10°, 2°, 5°, 0.05; fail beyond', status === 'fail' ? 'Not wings level and unaccelerated: refly.' : status === 'warn' ? 'Note the bank or sideslip.' : '', pid))
    }

    // weather
    {
      const tas = ktas
      if (!tas || (!gs && !turb && !wind && !vwind)) checks.push(notCheckable(d('weather'), KIND, { ...pid, severity: 'advisory' }))
      else {
        const gamma = vpath ? summary(vpath.values, a, b).mean : (Math.asin(Math.max(-1, Math.min(1, m.dhdt / (m.v * KT)))) * 180) / Math.PI
        const cosG = Math.cos((Number.isFinite(gamma) ? gamma : 0) * Math.PI / 180)
        let wh = NaN
        let whChange = NaN
        if (gs) {
          wh = Math.abs(summary(gs.values, a, b).mean - summary(tas.values, a, b).mean * cosG)
          const tenth = Math.max(1, Math.floor((b - a) / 10))
          const early = summary(gs.values, a, a + tenth).mean - summary(tas.values, a, a + tenth).mean * cosG
          const late = summary(gs.values, b - tenth, b).mean - summary(tas.values, b - tenth, b).mean * cosG
          whChange = Math.abs(late - early)
        }
        let trackDiff = NaN
        if (lat && lon && hdg && beta) {
          const tl = trend(lat.values, time, a, b)
          const tn = trend(lon.values, time, a, b)
          const chi = (Math.atan2(tn.slope * Math.cos((tl.mean * Math.PI) / 180), tl.slope) * 180) / Math.PI
          const head = summary(hdg.values, a, b).mean - summary(beta.values, a, b).mean
          trackDiff = Math.abs(((((chi - head) % 360) + 540) % 360) - 180)
        }
        const tbm = turb ? summary(turb.values, a, b).max : NaN
        const wr = wind ? summary(wind.values, a, b).range : NaN
        const wv = vwind ? maxAbs(vwind.values, a, b) : NaN
        let status: CheckStatus = 'pass'
        const why: string[] = []
        if (whChange > 5 || wv > 50 || tbm > 0.1) status = 'fail'
        else {
          if (wh > 1 || trackDiff > 1) {
            status = 'warn'
            why.push('steady wind: TAS-based results are unaffected; use specific air range TAS/FF, not ground-speed specific range')
          }
          if (wv > 10 || wr > 2 || tbm > 0.01) status = 'warn'
          if (!vwind && !thrustDragAllPass) {
            status = 'warn'
            why.push('vertical air motion unchecked (no row 152 and no matching drag output)')
          }
        }
        checks.push(result(d('weather'), KIND, status, [Number.isFinite(wh) ? `horizontal wind ${fix(wh, 2)} kt (change ${fix(whChange, 2)} kt)` : '', Number.isFinite(trackDiff) ? `track vs heading − β ${fix(trackDiff, 2)}°` : '', vwind ? `|vertical wind| ${fmt(wv, 2)} fpm` : '', turb ? `turbulence ${fmt(tbm, 2)}` : ''].filter(Boolean).join('; '), 'pass: wind ≤ 1 kt, track within 1°, |w_v| ≤ 10 fpm, turbulence ≤ 0.01 (without row 152: thrust–drag within 1 % everywhere); fail: wind changing > 5 kt, |w_v| > 50 fpm or turbulence > 0.1', status === 'fail' ? 'Changing wind or vertical air inside the record: set calm air and refly.' : why.join('; '), { ...pid, severity: status === 'fail' ? 'critical' : 'advisory' }))
      }
    }

    // isa-day (point)
    if (!Number.isFinite(m.dIsa)) checks.push(notCheckable(d('isa-day'), KIND, pid))
    else checks.push(result(d('isa-day'), KIND, Math.abs(m.dIsa) <= 1 ? 'pass' : 'warn', `ΔISA ${signed(m.dIsa, 2)} K`, '|ΔISA| ≤ 1 K (never fails)', Math.abs(m.dIsa) > 1 ? 'Reduce to a standard day, or state ΔISA.' : '', pid))

    // compressibility
    {
      const fastest = ref.fastest.has(i)
      if (!Number.isFinite(m.mach)) checks.push(notCheckable(d('compressibility'), KIND, pid))
      else {
        const clP = Number.isFinite(m.clW) ? m.clW : m.cl
        const r = fastest && ref.polar ? (m.cd - (ref.polar.cd0 + ref.polar.k * clP ** 2)) / (ref.polar.cd0 + ref.polar.k * clP ** 2) : NaN
        const mmo = settings.limits?.mmo
        const status: CheckStatus = m.mach >= 0.6 || (mmo && m.mach >= mmo - 0.02) || r > 0.02 ? 'warn' : 'pass'
        checks.push(result(d('compressibility'), KIND, status, `M ${fix(m.mach, 3)}${Number.isFinite(r) ? `, drag ${signed(100 * r, 1)} % from the reference polar` : ''}`, 'M < 0.6 and (fastest third) drag within 2 % of the reference polar (never fails)', status === 'warn' ? 'Keep the point; C_L and Mach change together at one altitude, so their effects cannot be separated (a second altitude would).' : '', pid))
      }
    }

    // envelope
    if (!agl) checks.push(notCheckable(d('envelope'), KIND, pid))
    else {
      const h = summary(agl.values, a, b).min
      const lim = settings.limits ?? {}
      const over = (lim.vmoKias && kias && summary(kias.values, a, b).max > lim.vmoKias - 10) || (lim.mmo && machCh && summary(machCh.values, a, b).max > lim.mmo - 0.02)
      const status: CheckStatus = h < 500 || over ? 'warn' : 'pass'
      checks.push(result(d('envelope'), KIND, status, `lowest ${fix(h, 0)} ft AGL${lim.vmoKias || lim.mmo ? '' : '; speed limits not set'}`, '≥ 500 ft AGL; inside the limits when set (never fails)', h < 500 ? 'Ground effect lowers the induced drag.' : over ? 'A set limit was exceeded.' : '', pid))
    }

    // weight-cg (info)
    if (!weight) checks.push(notCheckable(d('weight-cg'), KIND, pid))
    else {
      const wr = summary(weight.values, a, b)
      const atm = isa(Number.isFinite(m.hp) ? m.hp : 0)
      checks.push(result(d('weight-cg'), KIND, 'info', `W ${fmt(m.w, 5)} lb (change ${fmt(wr.range, 3)} lb)${Number.isFinite(m.cg) ? `, CG ${fmt(m.cg, 4)} ft` : ''}${Number.isFinite(m.fuel) ? `, fuel ${fmt(m.fuel, 4)} lb` : ''}, W/δ ${fmt(m.w / atm.delta, 4)} lb`, 'report only', '', pid))
    }

    const pc = modeChannels.length ? null : pitchControlSource(ds, a, b)
    return {
      point,
      a,
      b,
      checks,
      configMeans,
      configKey: config.surfaces.length ? configMeans.map((v) => (Math.round(v * 100) / 100).toFixed(2)).join(',') : null,
      at,
      pitch: pc ? pc.source : (null as PitchSource | null),
      modesChanged: modeChannels.some((c) => summary(c.values, a, b).range > 0),
    }
  })

  // ---- configuration-match
  {
    const keys = ctxs.map((c) => c.configKey).filter((k): k is string => k !== null)
    const counts = new Map<string, number>()
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    const modal = [...counts.entries()].sort((u, v) => v[1] - u[1])[0]?.[0] ?? null
    const modalValues = modal ? modal.split(',').map(Number) : []
    const clean = modalValues.every((v) => Math.abs(v) <= 0.01)
    for (const c of ctxs) {
      const pid = { pointId: c.point.id }
      if (c.configKey === null || modal === null) {
        c.checks.push(notCheckable(d('configuration-match'), KIND, pid))
        continue
      }
      const same = c.configMeans.length === modalValues.length && c.configMeans.every((v, k) => Math.abs(v - modalValues[k]) <= 0.01 + 1e-9)
      const status: CheckStatus = !same ? 'fail' : clean ? 'pass' : 'warn'
      c.checks.push(result(d('configuration-match'), KIND, status, `${same ? 'same as the set' : 'differs from the set'}; set ${clean ? 'clean' : `not clean (${modal})`}`, 'pass: every point in one clean configuration; warn: one non-clean configuration; fail: a point in another configuration', status === 'fail' ? 'Left out: put it in its own group (another configuration).' : status === 'warn' ? 'The results hold for that configuration, not clean cruise.' : '', pid))
    }
  }

  // ---- near-stall (back side from the as-plotted fit; near stall for the slowest third)
  {
    const vE = fitAll?.vE ?? null
    const lowestThrust = metrics.reduce((best, m, k) => (Number.isFinite(m.thrust) && (best < 0 || m.thrust < metrics[best].thrust) ? k : best), -1)
    ctxs.forEach((c, i) => {
      const m = metrics[i]
      const pid = { pointId: c.point.id }
      const haveLift = Number.isFinite(m.alpha) && Number.isFinite(m.cl)
      if (!haveLift && !Number.isFinite(m.cd)) {
        c.checks.push(notCheckable(d('near-stall'), KIND, pid))
        return
      }
      const backSide = vE !== null ? m.v < vE : lowestThrust >= 0 && m.v < metrics[lowestThrust].v
      let deficit = NaN
      let excess = NaN
      if (ref.slowest.has(i)) {
        if (ref.lift && haveLift) {
          const line = ref.lift.a * (m.alpha - ref.lift.alpha0)
          deficit = (line - m.cl) / line
        }
        if (ref.polar && Number.isFinite(m.cd)) {
          const cl = Number.isFinite(m.clW) ? m.clW : m.cl
          const p = ref.polar.cd0 + ref.polar.k * cl ** 2
          excess = (m.cd - p) / p
        }
      }
      const vs = settings.limits?.vsKeas
      const low = vs ? m.keas < 1.3 * vs : false
      let status: CheckStatus = 'pass'
      let hint = ''
      if (deficit > 0.03 || excess > 0.03 || low) {
        status = 'warn'
        hint = 'Plot only: plot it, leave it out of the fit and say why.'
      } else if (deficit > 0.02 || excess > 0.02) {
        status = 'info'
        hint = 'Approaching the stall.'
      } else if (backSide) {
        status = 'info'
        hint = 'Back side: speed unstable at fixed throttle; the energy correction matters most here.'
      }
      c.checks.push(result(d('near-stall'), KIND, status, `${backSide ? 'back side' : 'front side'}${Number.isFinite(deficit) ? `, lift deficit ${pct(deficit)}` : ''}${Number.isFinite(excess) ? `, drag ${signed(100 * excess, 1)} % from the polar` : ''}`, 'pass: front side, lift deficit and polar excess ≤ 2 %; info: back side, or 2–3 %; warn: > 3 % or below 1.3 V_S (plot only)', hint, pid))
    })
  }

  // ---- point verdicts
  const excludedByUser = new Set(settings.fitExcluded ?? [])
  const points: PointReport[] = ctxs.map((c) => {
    const failed = c.checks.filter((k) => (CRITICAL.has(k.id) || (k.id === 'weather' && k.status === 'fail')) && k.status === 'fail')
    const na = c.checks.filter((k) => CRITICAL.has(k.id) && k.status === 'not-checkable')
    let status: PointStatus
    const reasons: string[] = []
    if (failed.length) {
      status = 'excluded'
      reasons.push(...failed.map((k) => PERF_REASON[k.id] ?? k.title.toLowerCase()))
    } else if (na.length) {
      status = 'cannot-confirm'
      reasons.push(...na.map((k) => `${k.title.toLowerCase()}: not checkable`))
    } else if (c.checks.some((k) => k.id === 'near-stall' && k.status === 'warn')) {
      status = 'plot-only'
      reasons.push('plot only (near the stall)')
    } else if (excludedByUser.has(c.point.id)) {
      status = 'left-out'
      reasons.push('left out by you')
    } else if (c.checks.some((k) => k.id === 'energy-correction' && k.status === 'warn')) {
      status = 'correct'
      reasons.push('use the corrected drag and fuel flow')
    } else status = 'used'
    return { pointId: c.point.id, name: c.point.name, groupId: c.point.groupId, status, label: POINT_LABEL[status], reasons, checks: c.checks, worst: worstStatus(c.checks.map((k) => k.status)) }
  })
  const usedIdx = points.map((p, i) => (p.status === 'used' || p.status === 'correct' ? i : -1)).filter((i) => i >= 0)
  const U = usedIdx.map((i) => metrics[i])
  const fitU = fitThrough(U.map((m) => m.x), U.map((m) => m.y), input.fit)
  const set: Check[] = []
  const quantity = plottedQuantity(ds, y)

  // ---- weight-column
  {
    const def0 = d('weight-column')
    if (!weight) set.push(notCheckable(def0, KIND))
    else {
      const refs = new Set<string>([...(x ? refsOf(ds, x) : []), ...(y ? refsOf(ds, y) : [])])
      const plain = [x?.token, y?.token]
      const usesMax = [...refs, ...plain].some((r) => r !== undefined && /^(gross_lb|maxim_lb|gross,___lb|maxim,___lb)$/.test(r))
      const ordered = [...usedIdx].sort((u, v) => SET[u].start - SET[v].start)
      const ffPositive = U.some((m) => m.ff > 0)
      const first = ordered.length ? metrics[ordered[0]].w : NaN
      const last = ordered.length ? metrics[ordered[ordered.length - 1]].w : NaN
      const constant = ordered.length >= 2 && !(first > last) && ffPositive
      const status: CheckStatus = usesMax ? 'fail' : constant ? 'warn' : 'pass'
      // Whether the weight falls takes two used points (a formula with the maximum weight fails at any count).
      if (!usesMax && ordered.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
      else set.push(result(def0, KIND, status, usesMax ? 'a plotted formula uses gross,___lb or maxim,___lb (the constant maximum weight)' : `total,___lb ${constant ? 'does not fall although fuel flows' : `falls from ${fmt(first, 5)} to ${fmt(last, 5)} lb`}`, 'pass: total,___lb logged and falling with fuel burn, no maximum weight in the plotted formulas; fail: a formula uses gross,___lb or maxim,___lb', usesMax ? 'Use total,___lb, the current weight.' : constant ? 'The weight is not updating: check the column and the fuel settings.' : ''))
    }
  }

  // ---- weight-spread
  const ws = settings.referenceWeightLb && settings.referenceWeightLb > 0 ? settings.referenceWeightLb : U.reduce((s, m) => s + m.w, 0) / (U.length || 1)
  const hpRef = Number.isFinite(settings.referenceAltitudeFt) ? (settings.referenceAltitudeFt as number) : U.reduce((s, m) => s + m.hp, 0) / (U.length || 1)
  const sigmaS = isa(Number.isFinite(hpRef) ? hpRef : 0).sigma
  let reductionWarn = false
  {
    const def0 = d('weight-spread')
    if (!weight) set.push(notCheckable(def0, KIND))
    else if (U.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    else {
      const wsList = U.map((m) => m.w)
      const spread = (Math.max(...wsList) - Math.min(...wsList)) / (wsList.reduce((s, v) => s + v, 0) / wsList.length)
      const fV = U.map((m) => Math.abs(Math.sqrt((ws / m.w) * (m.sigma / sigmaS)) - 1))
      const fD = U.map((m) => Math.abs(ws / m.w - 1))
      const maxFV = Math.max(...fV)
      const maxFD = Math.max(...fD)
      const cgs = U.map((m) => m.cg).filter(Number.isFinite)
      const status: CheckStatus = maxFD > 0.1 ? 'fail' : spread <= 0.01 && maxFV <= 0.005 && maxFD <= 0.01 ? 'pass' : 'warn'
      reductionWarn ||= status === 'warn'
      set.push(result(def0, KIND, status, `weight spread ${pct(spread, 2)}; max |f_V − 1| ${pct(maxFV, 2)}, max |f_D − 1| ${pct(maxFD, 2)} (to ${fmt(ws, 5)} lb)${cgs.length ? `; CG range ${fmt(Math.max(...cgs) - Math.min(...cgs), 2)} ft` : ''}`, 'pass: spread ≤ 1 %, |f_V − 1| ≤ 0.5 %, |f_D − 1| ≤ 1 %; warn larger; fail |f_D − 1| > 10 %', status === 'warn' ? 'Reduce each point to the standard weight (V·f_V, D·f_D), or state the spread (open item U4).' : status === 'fail' ? 'The reduction moves points too far: split the set by weight.' : ''))
    }
  }

  // ---- altitude-band
  {
    const def0 = d('altitude-band')
    const hps = U.map((m) => m.hp).filter(Number.isFinite)
    if (!findChannel(ds, 'p-alt,ftMSL')) set.push(notCheckable(def0, KIND))
    else if (hps.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    else {
      const sig = U.map((m) => m.sigma).filter(Number.isFinite)
      const spread = (Math.max(...sig) - Math.min(...sig)) / (sig.reduce((s, v) => s + v, 0) / sig.length)
      const status: CheckStatus = spread <= 0.01 ? 'pass' : spread <= 0.1 ? 'warn' : 'fail'
      reductionWarn ||= status === 'warn'
      set.push(result(def0, KIND, status, `pressure altitude ${fmt(Math.min(...hps), 5)}–${fmt(Math.max(...hps), 5)} ft; density-ratio spread ${pct(spread, 2)}`, 'pass σ spread ≤ 1 %; warn ≤ 10 %; fail > 10 %', status === 'warn' ? 'Reduce to one altitude (f_V) or fit by groups (open item U5).' : status === 'fail' ? 'The points belong to different altitudes: split the set.' : ''))
    }
  }

  // ---- point-count
  const p = FIT_PARAMETERS[input.fit]
  {
    const def0 = d('point-count')
    if (input.fit === 'none' || !x || !y) set.push(notCheckable(def0, KIND))
    else {
      const n = U.length
      let status: CheckStatus = n <= p ? 'fail' : n >= Math.max(5, p + 2) ? 'pass' : 'warn'
      if (status === 'pass' && input.fitTarget === 'samples') status = 'warn'
      set.push(result(def0, KIND, status, `${n} used points for a ${p}-parameter fit${input.fitTarget === 'samples' ? ' (the X–Y fit runs through samples, not point means)' : ''}`, `pass n ≥ max(5, p + 2) = ${Math.max(5, p + 2)}; warn ${p + 1}–${Math.max(5, p + 2) - 1}; fail n ≤ ${p}`, status === 'fail' ? 'Fly more points: the fit passes through every point.' : status === 'warn' ? 'More points (or a fit through the point means) would firm up the curve.' : ''))
    }
  }

  // ---- brackets
  const xsU = U.map((m) => m.x).filter(Number.isFinite)
  const xMinU = xsU.length ? Math.min(...xsU) : NaN
  const xMaxU = xsU.length ? Math.max(...xsU) : NaN
  const spacing = xsU.length > 1 ? (xMaxU - xMinU) / (xsU.length - 1) : NaN
  const jetFuelPart = propulsion.type === 'jet' && quantity !== 'fuel-flow' && U.some((m) => Number.isFinite(m.ffCorr))
  const byTas = [...U].sort((u, v) => u.v - v.v)
  {
    const def0 = d('bracket-endurance')
    if (!fitU) set.push(notCheckable(def0, KIND))
    else if (fitU.vE === null) set.push(result(def0, KIND, 'fail', `no minimum: ${fitU.problem}`, 'V_E inside the data with ≥ 2 points on each side', 'Fly slower points, so the curve has its minimum among them.'))
    else {
      const vE = fitU.vE
      const below = xsU.filter((v) => v < vE).length
      const above = xsU.filter((v) => v > vE).length
      const over = vE < xMinU ? (xMinU - vE) / spacing : vE > xMaxU ? (vE - xMaxU) / spacing : 0
      let status: CheckStatus = over > 2 ? 'fail' : over > 0 ? 'warn' : below >= 2 && above >= 2 ? 'pass' : 'warn'
      let measured = `V_E ${fmt(vE, 4)} ${x?.meta.unit || 'kt'}: ${below} points below, ${above} above${over > 0 ? `; ${fix(over, 2)} spacings outside the data` : ''}`
      let hint = status === 'fail' ? `Fly ${vE < xMinU ? 'slower' : 'faster'} points.` : over > 0 ? 'Limited extrapolation: fly slower points if you can.' : status === 'warn' ? 'Only one point on one side of V_E.' : ''
      if (jetFuelPart) {
        const iMin = byTas.reduce((best, m, k) => (m.ffCorr < byTas[best].ffCorr ? k : best), 0)
        const edge = iMin <= 1 || iMin >= byTas.length - 2
        measured += `; lowest corrected fuel flow at ${fmt(byTas[iMin].v, 4)} kt (${iMin} slower, ${byTas.length - 1 - iMin} faster)`
        if (edge && status === 'pass') status = 'warn'
        if (edge) hint = `${hint ? `${hint} ` : ''}The fuel-based endurance optimum lies at the edge of the data (advisory).`
      }
      set.push(result(def0, KIND, status, measured, 'pass: inside with ≥ 2 points each side; warn: one point on a side, or outside by ≤ 2 spacings; fail: no minimum or > 2 spacings outside (the jet fuel part is advisory)', hint))
    }
  }
  {
    const def0 = d('bracket-range')
    if (!fitU) set.push(notCheckable(def0, KIND))
    else if (fitU.vR === null) set.push(result(def0, KIND, 'fail', `no tangent point: ${fitU.problem}`, 'V_R inside the data with ≥ 2 points above it', 'Fly faster points.'))
    else {
      const vR = fitU.vR
      const above = xsU.filter((v) => v > vR).length
      const over = vR > xMaxU ? (vR - xMaxU) / spacing : vR < xMinU ? (xMinU - vR) / spacing : 0
      let status: CheckStatus = over > 2 ? 'fail' : over > 0 ? 'warn' : above >= 2 ? 'pass' : 'warn'
      let measured = `V_R ${fmt(vR, 4)} ${x?.meta.unit || 'kt'}: ${above} points faster${over > 0 ? `; ${fix(over, 2)} spacings outside the data` : ''}`
      let hint = status === 'fail' ? 'Fly faster points.' : over > 0 ? 'Limited extrapolation: fly faster points if you can.' : status === 'warn' ? 'Only one point faster than V_R.' : ''
      if (jetFuelPart) {
        const sr = byTas.map((m) => m.v / m.ffCorr)
        const iStar = sr.reduce((best, v, k) => (v > sr[best] ? k : best), 0)
        const faster = byTas.length - 1 - iStar
        const top = (sr[iStar] - sr[sr.length - 1]) / sr[iStar]
        measured += `; specific air range peaks at ${fmt(byTas[iStar].v, 4)} kt (${faster} faster, top ${pct(top, 1)})`
        const fuelWarn = faster < 2 || top <= 0.01
        if (fuelWarn && status === 'pass') status = 'warn'
        if (fuelWarn) hint = `${hint ? `${hint} ` : ''}${faster === 0 ? 'Specific air range still rising: the fuel-based best-range speed lies beyond the fastest point; fly faster points if you can.' : 'Flat top of specific air range (advisory).'}`
      }
      set.push(result(def0, KIND, status, measured, 'pass: inside with ≥ 2 points faster; warn: one faster, or outside by ≤ 2 spacings; fail: no tangent or > 2 spacings outside (the jet fuel part is advisory)', hint))
    }
  }

  // ---- construction
  {
    const def0 = d('construction')
    if (!propulsion.type) set.push(notCheckable(def0, KIND))
    else {
      const model = input.fit
      const physical = model === 'power-model' || model === 'drag-model'
      let status: CheckStatus
      let hint = ''
      const jet = propulsion.type === 'jet'
      if ((jet && quantity === 'power') || (!jet && quantity === 'thrust')) {
        status = 'fail'
        hint = jet ? 'Plot thrust (or drag), not engine power, for a jet.' : 'Plot power, not thrust, for a propeller aircraft.'
      } else if ((model === 'power-model' && (quantity === 'thrust' || quantity === 'drag')) || (model === 'drag-model' && quantity === 'power')) {
        status = 'fail'
        hint = 'The model’s powers of V belong to the other quantity: replot with the matching model.'
      } else if (quantity === 'fuel-flow') {
        status = physical ? 'warn' : 'pass'
        if (physical) hint = 'TSFC or BSFC varies with speed: prefer a polynomial for fuel flow.'
      } else if (quantity === 'other') {
        status = 'warn'
        hint = 'Plot thrust or drag (jet), power (propeller) or fuel flow.'
      } else status = 'pass'
      set.push(result(def0, KIND, status, `${propulsion.type} (${propulsion.reason}); Y is ${quantity}; ${model} fit${!jet && quantity === 'power' ? '; the construction assumes a constant propeller efficiency' : ''}`, 'pass: jet with thrust or drag, propeller with power, either with fuel flow (polynomial); fail: the other engine’s quantity or a mismatched model', hint))
    }
  }

  // ---- speed-axis
  const windFound = ctxs.some((c) => c.checks.some((k) => k.id === 'weather' && k.status !== 'pass' && /steady wind/.test(k.hint)))
  {
    const def0 = d('speed-axis')
    if (!x) set.push(notCheckable(def0, KIND))
    else {
      const t = x.token
      let status: CheckStatus
      let hint = ''
      if (t === 'Vtrue,_ktas') status = 'pass'
      else if (t === '_Vind,_keas') {
        status = 'pass'
        hint = 'KEAS at one altitude gives the same points: convert to TAS for air miles per pound.'
      } else if (t === '_Vind,_kias') {
        status = 'warn'
        hint = 'X-Plane’s pitot error grows with α, so KIAS is not a constant scale of TAS: plot against KTAS.'
      } else if (t === 'Vtrue,_ktgs') {
        status = windFound ? 'fail' : 'warn'
        hint = 'Ground speed: replot against KTAS.'
      } else {
        status = 'warn'
        hint = 'Plot against true airspeed (KTAS).'
      }
      set.push(result(def0, KIND, status, `x is ${x.meta.short || x.token}`, 'pass: KTAS (or KEAS at one altitude); warn: KIAS or ground speed in calm air; fail: ground speed with wind', hint))
    }
  }

  // ---- fuel-flow
  {
    const def0 = d('fuel-flow')
    const haveFf = engineChannels(ds, FUEL_FLOW).length > 0 || engineChannels(ds, TSFC).length > 0
    const tsfc = U.map((m) => m.ff / m.thrust).filter(Number.isFinite)
    if (!haveFf) set.push(notCheckable(def0, KIND))
    else if (propulsion.type === 'propeller') set.push(result(def0, KIND, 'info', 'propeller: the fuel-flow optima are reported as info only', 'report only for propeller aircraft'))
    else if (tsfc.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points (with thrust)' }))
    else {
      const mean = tsfc.reduce((s, v) => s + v, 0) / (tsfc.length || 1)
      const spread = tsfc.length ? (Math.max(...tsfc) - Math.min(...tsfc)) / mean : NaN
      const everyEngine = engineChannels(ds, THRUST).every((_, k) => findChannel(ds, FUEL_FLOW(k + 1)) || findChannel(ds, TSFC(k + 1)))
      const status: CheckStatus = everyEngine && !(spread > 0.03) ? 'pass' : 'warn'
      set.push(result(def0, KIND, status, `TSFC ${fmt(Math.min(...tsfc), 3)}–${fmt(Math.max(...tsfc), 3)} lb/(lbf·h), spread ${pct(spread, 1)}`, 'pass: fuel flow logged for every engine and TSFC spread ≤ 3 % (never fails)', status === 'warn' ? 'Report the fuel-flow optima (least corrected fuel flow, most TAS/FF) beside the thrust-curve ones.' : ''))
    }
  }

  // ---- fuel-bookkeeping
  {
    const def0 = d('fuel-bookkeeping')
    const ffs = engineChannels(ds, FUEL_FLOW)
    const fuel = findChannel(ds, '_fuel,___lb')
    const tanks = engineChannels(ds, (k) => `fuel${k},___lb`)
    if (!ffs.length || (!fuel && !tanks.length) || !SET.length) set.push(notCheckable(def0, KIND))
    else {
      const a = Math.min(...SET.map((p0) => p0.start))
      const b = Math.max(...SET.map((p0) => p0.end))
      const fuelAt = (row: number) => (fuel ? fuel.values[row] : tanks.reduce((s, c) => s + c.values[row], 0))
      const burnt = fuelAt(a) - fuelAt(b - 1)
      let integrated = 0
      for (let r = a + 1; r < b; r += 1) {
        if (ds.segments.some((s) => s.start === r)) continue
        const dt = time[r] - time[r - 1]
        for (const c of ffs) {
          const f0 = c.values[r - 1]
          const f1 = c.values[r]
          if (Number.isFinite(f0) && Number.isFinite(f1)) integrated += ((f0 + f1) / 2) * (dt / 3600)
        }
      }
      const diff = (integrated - burnt) / burnt
      const status: CheckStatus = Math.abs(diff) <= 0.02 ? 'pass' : 'warn'
      set.push(result(def0, KIND, status, `integrated fuel flow ${fmt(integrated, 4)} lb against ${fmt(burnt, 4)} lb burnt (${signed(100 * diff, 1)} %)`, '|difference| ≤ 2 % (never fails)', status === 'warn' ? 'Check the time base (sim time), refuelling or a reloaded situation.' : ''))
    }
  }

  // ---- fit-quality (jackknife)
  {
    const def0 = d('fit-quality')
    if (!fitU || U.length < p + 2) set.push(notCheckable(def0, KIND))
    else {
      const thetaE: number[] = []
      const thetaR: number[] = []
      for (let k = 0; k < U.length; k += 1) {
        const rest = U.filter((_, j) => j !== k)
        const f = fitThrough(rest.map((m) => m.x), rest.map((m) => m.y), input.fit)
        if (f?.vE) thetaE.push(f.vE)
        if (f?.vR) thetaR.push(f.vR)
      }
      const jack = (vals: number[], full: number | null) => {
        if (!full || vals.length < 2) return NaN
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length
        return Math.sqrt(((vals.length - 1) / vals.length) * vals.reduce((s, v) => s + (v - mean) ** 2, 0)) / full
      }
      const seE = jack(thetaE, fitU.vE)
      const seR = jack(thetaR, fitU.vR)
      const status: CheckStatus = fitU.r2 >= 0.98 && seE <= 0.01 && seR <= 0.02 ? 'pass' : 'warn'
      // Corrected and reduced: D_corr·f_D against V·f_V.
      let reduced = ''
      if ((quantity === 'thrust' || quantity === 'drag') && U.every((m) => Number.isFinite(m.dCorr))) {
        const f = fitThrough(U.map((m) => m.v * Math.sqrt((ws / m.w) * (m.sigma / sigmaS))), U.map((m) => (m.dCorr * ws) / m.w), input.fit)
        if (f?.vE && f.vR) reduced = `; corrected and reduced: V_E ${fmt(f.vE, 4)}, V_R ${fmt(f.vR, 4)} kt TAS`
      }
      const asPlotted = fitAll && (fitAll.vE || fitAll.vR) ? `; as plotted (every point): V_E ${fmt(fitAll.vE ?? NaN, 4)}, V_R ${fmt(fitAll.vR ?? NaN, 4)}` : ''
      set.push(result(def0, KIND, status, `R² ${fix(fitU.r2, 4)}; jackknife SE(V_E) ${pct(seE, 1)}, SE(V_R) ${pct(seR, 1)}${asPlotted}${reduced}${input.fit === 'power-model' || input.fit === 'drag-model' ? '; V_R/V_E = 3^¼ by construction: cross-check with a polynomial' : ''}`, 'pass R² ≥ 0.98, SE(V_E) ≤ 1 %, SE(V_R) ≤ 2 % (never fails)', status === 'warn' ? 'The optima hinge on few points: add points or quote the uncertainty.' : ''))
    }
  }

  // ---- repeats
  {
    const def0 = d('repeats')
    const pairs: string[] = []
    for (let i = 0; i < metrics.length; i += 1) {
      for (let j = i + 1; j < metrics.length; j += 1) {
        if (Math.abs(metrics[i].v - metrics[j].v) <= 2) {
          const dd = (metrics[j].dCorr - metrics[i].dCorr) / metrics[i].dCorr
          const df = (metrics[j].ffCorr - metrics[i].ffCorr) / metrics[i].ffCorr
          pairs.push(`${SET[i].name} / ${SET[j].name}: drag ${signed(100 * dd, 1)} %, fuel flow ${signed(100 * df, 1)} %`)
        }
      }
    }
    if (!pairs.length) set.push(notCheckable(def0, KIND))
    else set.push(result(def0, KIND, 'info', pairs.join('; '), 'report only'))
  }

  // ---- isa-day (set)
  {
    const dIsa = metrics.map((m) => m.dIsa).filter(Number.isFinite)
    if (!dIsa.length) set.push(notCheckable(isaDaySet, KIND))
    else {
      const range = Math.max(...dIsa) - Math.min(...dIsa)
      const worst = Math.max(...dIsa.map(Math.abs))
      const status: CheckStatus = range <= 1 && worst <= 1 ? 'pass' : 'warn'
      set.push(result(isaDaySet, KIND, status, `ΔISA ${signed(Math.min(...dIsa), 2)} to ${signed(Math.max(...dIsa), 2)} K (range ${fix(range, 2)} K)`, '|ΔISA| ≤ 1 K at every point and a range ≤ 1 K (never fails)', status === 'warn' ? 'Reduce to a standard day, or state ΔISA: at one pressure altitude the density then differs from ISA by about ΔISA/T.' : ''))
    }
  }

  // ---- autopilot-record
  let atWarn = settings.declared?.autothrottle === 'on'
  {
    const def0 = d('autopilot-record')
    const declared = settings.declared?.autopilot && settings.declared.autopilot !== 'unknown'
    const allNoted = SET.length > 0 && SET.every((p0) => declaresModes(p0.note))
    const logged = modeChannels.length > 0
    const inferred = ctxs.filter((c) => c.pitch !== null)
    atWarn ||= ctxs.some((c) => c.checks.some((k) => k.id === 'autothrottle-off' && k.status === 'warn'))
    if (!logged && !inferred.length && !declared && !allNoted) set.push(notCheckable(def0, KIND))
    else {
      let status: CheckStatus
      let measured: string
      let hint = ''
      if (logged) {
        const changed = ctxs.filter((c) => c.modesChanged).map((c) => c.point.name)
        status = changed.length ? 'warn' : 'pass'
        measured = changed.length ? `modes logged; a mode changed inside ${changed.join(', ')}` : 'modes logged and constant in every record'
      } else if (declared || allNoted) {
        status = 'pass'
        measured = declared ? `declared: autopilot ${settings.declared?.autopilot}${settings.declared?.modes ? ` (${settings.declared.modes})` : ''}` : 'modes written in every point’s note'
      } else {
        status = 'warn'
        const held = inferred.filter((c) => c.pitch === 'autopilot').length
        const counts = (['autopilot', 'pilot', 'hands-off', 'unknown'] as PitchSource[]).map((s) => [s, inferred.filter((c) => c.pitch === s).length] as const).filter(([, k]) => k > 0)
        measured = `inferred from the surface, stick and servo: ${counts.map(([s, k]) => `${s} ${k}`).join(', ')}`
        hint = held ? `The autopilot held pitch in ${held} points (inferred): write the modes (e.g. ALT HOLD, A/T off) in the point notes or log row 117.` : 'Write the modes in the point notes or log row 117.'
      }
      set.push(result(def0, KIND, status, measured, 'pass: modes logged and constant, or declared for every point; warn: only inferred, or a mode change inside a record (never fails; acceptance is open item U1)', hint))
    }
  }

  // ---- open items
  const open: OpenItem[] = []
  const openItem = (id: keyof typeof PERF_OPEN) => open.push({ id, ...PERF_OPEN[id] })
  openItem('U1')
  if (atWarn) openItem('U2')
  if (propulsion.type === 'jet' && (quantity === 'thrust' || quantity === 'drag')) openItem('U3')
  if (reductionWarn) openItem('U4')
  openItem('U5')
  if (y?.token === '_drag,___lb') openItem('U6')
  openItem('U7')

  // ---- verdict (points left out only because the throttle moved inside them can be re-cut instead of reflown)
  const recut = recutCounts(ds, SET, points, 'performance', (k) => CRITICAL.has(k.id) || k.id === 'weather')
  const verdict = perfVerdict(points, set, usedIdx.length, SET.length, settings.fitUsedOnly === true, recut, p)
  const notes = [...set.filter((c) => c.status === 'warn').map((c) => `${c.title}: ${c.hint || c.measured}`), ...summariseWarnings(points)]
  return {
    kind: 'performance',
    setName: input.setName ?? 'Range and endurance points',
    points,
    set,
    open,
    verdict,
    notes,
    used: usedIdx.map((i) => SET[i].id),
    fitIncludesUnused: settings.fitUsedOnly !== true && usedIdx.length < SET.length,
    propulsion: propulsion.type,
    fitAll,
    fitU,
    metrics,
  }
}

/** The points of the reference polar and lift line, and the slowest and fastest thirds by TAS. */
export function referenceFits(metrics: readonly PointMetrics[]) {
  const idx = metrics.map((_, i) => i).filter((i) => Number.isFinite(metrics[i].v))
  const sorted = [...idx].sort((u, v) => metrics[u].v - metrics[v].v)
  const q = (p: number) => {
    const vs = sorted.map((i) => metrics[i].v)
    const at = p * (vs.length - 1)
    const lo = Math.floor(at)
    return vs.length ? vs[lo] + (vs[Math.min(vs.length - 1, lo + 1)] - vs[lo]) * (at - lo) : NaN
  }
  const q25 = q(0.25)
  const q75 = q(0.75)
  let refIdx = sorted.filter((i) => metrics[i].v >= q25 - 1e-9 && metrics[i].v <= q75 + 1e-9)
  if (refIdx.length < 3) refIdx = sorted
  const third = Math.max(1, Math.round(sorted.length / 3))
  const slowest = new Set(sorted.slice(0, third))
  const fastest = new Set(sorted.slice(sorted.length - third))
  const polarCl = (m: PointMetrics) => (Number.isFinite(m.clW) ? m.clW : m.cl)
  const polarPts = refIdx.filter((i) => Number.isFinite(metrics[i].cd) && Number.isFinite(polarCl(metrics[i])))
  const pf = polarPts.length >= 2 ? linearFit(polarPts.map((i) => polarCl(metrics[i]) ** 2), polarPts.map((i) => metrics[i].cd)) : null
  const liftPts = refIdx.filter((i) => Number.isFinite(metrics[i].alpha) && Number.isFinite(metrics[i].cl))
  const lf = liftPts.length >= 2 ? linearFit(liftPts.map((i) => metrics[i].alpha), liftPts.map((i) => metrics[i].cl)) : null
  return {
    refIndices: refIdx,
    slowest,
    fastest,
    polar: pf && Number.isFinite(pf.c1) ? { cd0: pf.c0, k: pf.c1 } : null,
    lift: lf && Number.isFinite(lf.c1) && lf.c1 !== 0 ? { a: lf.c1, alpha0: -lf.c0 / lf.c1 } : null,
  }
}

function perfVerdict(
  points: readonly PointReport[],
  set: readonly Check[],
  used: number,
  total: number,
  fitUsedOnly: boolean,
  recut: { flagged: number; fixable: number },
  parameters: number,
): Verdict {
  if (total === 0) return { kind: 'no-data', text: 'No test points to judge: save steady level points (Find steady points) and plot them.' }
  const cannot = points.filter((p) => p.status === 'cannot-confirm')
  const setNa = set.filter((c) => (c.severity === 'critical' || c.severity === 'analysis') && c.status === 'not-checkable')
  const rows = rowsFromNotCheckable([...setNa, ...cannot.flatMap((p) => p.checks.filter((c) => CRITICAL.has(c.id)))])
  const cannotText = `Cannot confirm — ${rows.length ? `tick rows ${rows.join(', ')}` : setNa.map((c) => c.title.toLowerCase()).join('; ') || 'some checks need rows the log does not have'}`
  if (used < 3 && used + cannot.length >= 3) return { kind: 'cannot-confirm', text: cannotText }
  const critical = set.filter((c) => c.severity === 'critical' && c.status === 'fail')
  const flagged = `${recut.flagged} flagged point${recut.flagged === 1 ? '' : 's'}`
  if (critical.some((c) => c.id === 'point-count') && recut.fixable > 0 && used + recut.fixable > parameters) {
    // Too few points as cut, but the ones left out only for a throttle move can be re-cut to their still part: the
    // set checks on so few points (brackets, fit) wait for that.
    return {
      kind: 'fix-analysis',
      text: `Fix the analysis — re-cut the ${flagged} (the throttle or trim moved inside them) to their still part (Re-cut), then check again: as cut, only ${used} ${used === 1 ? 'is' : 'are'} usable`,
    }
  }
  if (critical.length) {
    const fly = critical.map((c) => (c.id === 'point-count' ? 'fly more points' : c.hint.replace(/\.$/, '').toLowerCase() || c.title.toLowerCase()))
    const also = recut.flagged > 0 ? ` (and re-cut the ${flagged}: the throttle or trim moved inside them)` : ''
    return { kind: 'retest', text: `Retest required — ${[...new Set(fly)].join('; ')}${also}` }
  }
  if (setNa.length || cannot.length > total / 2) return { kind: 'cannot-confirm', text: cannotText }
  const analysisFail = set.filter((c) => c.severity === 'analysis' && c.status === 'fail')
  if (analysisFail.length) return { kind: 'fix-analysis', text: `Fix the analysis — ${analysisFail.map((c) => c.hint || c.title).join('; ')}` }
  const notes = set.filter((c) => c.status === 'warn').length + summariseWarnings(points).length
  const left = leftOutText(points)
  const correct = points.filter((p) => p.status === 'correct').map((p) => p.name)
  const tick = !fitUsedOnly && used < total ? "; tick 'Fit the used points only' to plot the fit this verdict judges" : ''
  return {
    kind: 'acceptable',
    text: `Acceptable for analysis — ${used} point${used === 1 ? '' : 's'} used${left ? `, ${left}` : ''}${correct.length ? `; correct: ${correct.join(', ')}` : ''}, ${notes} note${notes === 1 ? '' : 's'}${tick}`,
  }
}

/** The channel a plotted id names, else null. */
export function channelOf(ds: Dataset, id: string | null): Channel | null {
  return id ? (channelById(ds, id) ?? null) : null
}
