// Test validity of a range-and-endurance set: were the steady level points flown and reduced the way the lectures
// (FD12b, FD12c), Cook (ch. 3, 14) and NATO AG-300 Vol. 14 ch. 13 ask, and does the fit through them place the two
// optima inside the data? Per point: a steady record at a fixed throttle, level, unaccelerated, in one configuration
// and calm air, with the energy correction (Cook p.64 eq. 3.42; NATO 13-7) small; the back side and the approach to the
// stall are noted, and such points stay in the fit. Per set: the weight column, the weight and altitude spread, the
// point count, the brackets around V_E and V_R, the construction for the engine type, the speed axis, fuel flow and the
// fit's uncertainty. Numbers no source gives are marked as engineering judgement, and the ones a source gives are listed
// with it (`sourced`). Questions the sources leave open are shown as U1–U7. Pure: no React, no DOM.

import { polyFit, type PolyFit } from '../analysis/fit'
import {
  physicalFit,
  physicalProblem,
  polyRangeEndurance,
  RE_MARGIN,
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
  /** Where the climb rate and altitude scatter come from (with VVI only, the altitude is VVI integrated over the record) */
  altSource: 'geometric' | 'pressure' | 'vvi' | null
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
  /** |total| / D_corr; without thrust, of X-Plane's drag, else of the thrust power η_p·P, else of the shaft power */
  share: number
  /** What `share` is a share of */
  shareOf: 'corrected drag' | 'X-Plane drag' | 'thrust power' | 'shaft power'
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
/** The ground-effect line, ft AGL: the app's stand-in for one wingspan (NATO 13-4), as no wingspan is logged or set */
const GROUND_EFFECT_FT = 200

// ------------------------------------------------------------------ definitions

const def = (d: CheckDef): CheckDef => d

export const PERFORMANCE_DEFS: readonly CheckDef[] = [
  def({
    id: 'time-base', title: 'Continuous sim-time record', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Rates of change and fuel used are per second of simulated flight, and a reset or gap inside a record breaks the trend fit. NATO requires time to be recorded with the other performance parameters, and its data validation looks for periods when no data were recorded. What counts as a gap (a step longer than max(1 s, 20 × the median step)) and the preference for sim time over real time are the app’s own choices; a sim running a little off real time does not by itself spoil a steady point.',
    cite: ['NATO 13-2', 'NATO 28-5', 'App src/core/time.ts', 'App src/views/modes/modesModel.ts line 111', 'App src/core/channels/groupRows.ts (row 0)', 'EJ'], judgement: true, needs: 'row {1}',
  }),
  def({
    id: 'sample-rate', title: 'Sample rate', severity: 'critical', scope: 'point', interval: 'R',
    why: 'NATO records its classical steady climbs at one sample per five seconds, and its cruise tests use the same instrumentation as its climb tests; it samples non-steady runs such as level accelerations at 5 to 10 per second, and requires airspeed, altitude, fuel, time and engine parameters at rates sufficient for performance. The app’s recording guide asks 10 writes per second. The 1 Hz pass line, the dropout warning (a step over 3 × the median) and the 2 % allowance on both lines are engineering judgement.',
    cite: ['NATO 13-6', 'NATO 13-9', 'NATO 13-7', 'NATO 13-8', 'NATO 13-2', 'App src/core/channels/guide.ts', 'EJ'], judgement: true,
    sourced: 'fail < 0.2 Hz: NATO 13-6 (classical climbs, borrowed; 13-9 uses the same instrumentation for cruise)', needs: 'row {1}',
  }),
  def({
    id: 'record-length', title: 'Record long enough', severity: 'critical', scope: 'point', interval: 'R',
    why: 'NATO records the last minute of each cruise test and computes the drag increment from the residual acceleration. Shorter records are kept with a warning: the lecture’s own X-Plane example selects short windows, and the data need not be perfect. The 5 s and 10-row floors are engineering judgement.',
    cite: ['NATO 13-10', 'FD12c p.16', 'FD12b p.19', 'EJ'], judgement: true,
    sourced: 'pass ≥ 60 s: NATO 13-10 (the last minute of a cruise test)',
    follows: 'pass: NATO 13-10; warn band: FD12c p.16 and FD12b p.19; floors: engineering judgement', needs: 'row {1}',
  }),
  def({
    id: 'stabilised', title: 'Settled before the record', severity: 'advisory', scope: 'point', interval: 'S (up to 300 s) and R',
    why: 'NATO stabilises engine and aircraft for at least one minute before recording climbs, and the engine for at least one minute before level accelerations; it notes that engine output changes appreciably in the first minute after a power-lever change, and allows three to four minutes for propulsion steady state. Whether X-Plane models engine lag is not settled, so a short settling time is judged by the traces and only warned about. The 300 s look-back and what counts as a power change are engineering judgement.',
    cite: ['NATO 13-6', 'NATO 13-7', 'NATO 13-5', 'NATO 24-6', 'EJ'], judgement: true,
    sourced: 'pass ≥ 60 s settled: NATO 13-6 (climbs) and 13-7 (engine, before level accelerations), both borrowed',
    follows: 'NATO 13-6 and 13-7 (one minute, stated for climbs and level accelerations) rather than 24-6 (three to four minutes, propulsion tests)',
    needs: 'row {25} or {26}, else {35}, {34} or {41}',
  }),
  def({
    id: 'throttle-fixed', title: 'Throttle unchanged', severity: 'critical', scope: 'point', interval: 'R',
    why: 'The quasi-steady technique sets a throttle and holds altitude while the speed stabilises, and the engine instruments confirm the engine is at the intended thrust; NATO fixes the power lever, autothrottle off, for its non-steady runs, and notes that engine output changes appreciably in the first minute after a lever change. The app reasons that a change inside the record mixes two thrust levels. The lever, thrust and N1 ranges are the app’s own choice; the 3 % thrust range is narrower than the ± 3 % band Find steady points accepts, so a window it finds can fail here and be re-cut.',
    cite: ['NATO 13-9', 'NATO 13-10', 'NATO 13-4', 'NATO 13-5', 'App src/core/analysis/steady.ts', 'EJ'], judgement: true,
    needs: 'row {25}, else {26} or {35}',
  }),
  def({
    id: 'autothrottle-off', title: 'Autothrottle off', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'NATO fixes the power lever with the autothrottle off for its non-steady cruise runs, lists autothrottles among the automatic controls that cause propulsion transients, and records autopilot status with every test point. Whether autothrottle-held level points are acceptable is not settled (U2). Detection thresholds are engineering judgement.',
    cite: ['NATO 13-10', 'NATO 24-6', 'NATO 29-1', 'App dictionary.ts line 612', 'EJ'], judgement: true, needs: 'row {25} or {117}',
  }),
  def({
    id: 'speed-steady', title: 'Speed steady', severity: 'critical', scope: 'point', interval: 'R',
    why: 'For low-performance aircraft NATO flies cruise tests in quasi-stabilised conditions that allow very small variations in speed, records the last minute and corrects for the residual acceleration; it sets no numerical speed tolerance for level points. Its only number, under one knot in two minutes, belongs to its cruise-climb method and is used here only as the pass benchmark. Phugoid periods are typically 15–100 s. The scatter limits are engineering judgement.',
    cite: ['NATO 13-9', 'NATO 13-10', 'FD13 p.13', 'App src/core/analysis/steady.ts', 'EJ'], judgement: true,
    sourced: 'pass |drift| ≤ 0.5 kt/min: NATO 13-10 (under 1 kt in 2 min, cruise-climb method, borrowed)',
    follows: 'NATO 13-10 (correct, do not discard); the 0.5 kt/min benchmark is NATO’s W/δ figure, not a level-point rule',
    needs: 'row {3}',
  }),
  def({
    id: 'level', title: 'Level flight', severity: 'critical', scope: 'point', interval: 'R',
    why: 'The technique holds a constant altitude while the speed stabilises, and a residual climb is corrected through the energy equation. The 20 fpm line is about 1 % of drag at L/D 15 and 300 KTAS; the share grows with L/D and falls with speed (about 2 % at L/D 10 and 100 KTAS), and the energy-correction check measures it. With only VVI logged, the altitude is rebuilt by integrating VVI over the record. Tolerances are engineering judgement.',
    cite: ['NATO 13-9', 'NATO 13-10', 'NATO 13-7', 'App dictionary.ts line 55', 'EJ'], judgement: true, needs: 'row {20} or {4}',
  }),
  def({
    id: 'energy-correction', title: 'Energy correction small', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Specific excess power ḣ + (V/g)V̇ measures the thrust not balancing drag (D = T − W·ḣ/V − (W/g)·V̇); Cook’s trim balance (eqs 3.42–3.43, resolved along the flight path) has the same climb term, and NATO calculates the drag increment from the residual acceleration of each cruise test. NATO says a correction below about 10 % needs only 10 % accuracy to keep the result within 1 % (said of point-performance corrections, and borrowed here for the fail line). The thrust-axis term T(1 − cos(α + κ)) follows from that balance, the thrust line not lying along the wind. The 2 % pass band is engineering judgement.',
    cite: ['NATO 13-7', 'NATO 13-10', 'NATO 13-8', 'Cook p.64', 'FD08 p.21', 'Cook p.69', 'EJ'], judgement: true,
    sourced: 'fail > 10 %: NATO 13-8 (correction size for point performance, borrowed)',
    follows: 'NATO 13-8 (said of corrections to point performance), applied here by analogy for the 10 % limit',
    needs: 'rows {3}, {20} or {4}, and {63}, and {35}, {64} or {34}',
  }),
  def({
    id: 'thrust-drag', title: 'Corrected thrust matches drag', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'NATO derives drag from excess thrust and weight and calculates the drag increment from the residual acceleration, as this checklist does (D_corr); a performance model needs thrust and drag known in absolute value. X-Plane’s drag output is a model output, so it serves only as a cross-check: by analogy with NATO’s post-flight analysis, which flags the test points where a mathematical model and the observed data disagree, a mismatch flags the point for a closer look. Tolerances are engineering judgement.',
    cite: ['NATO 13-3', 'NATO 13-10', 'NATO 13-4', 'NATO 13-9', 'NATO 28-6', 'EJ'], judgement: true, needs: 'rows {64}, {35}, {3}, {63}, and {20} or {4}',
  }),
  def({
    id: 'configuration-constant', title: 'Configuration unchanged', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Flap, gear, speedbrake and thrust belong to each test point’s configuration, the quasi-steady technique sets each throttle at a given altitude-weight-configuration, and NATO flies its climbs at each external configuration (tanks or stores) separately. No source gives a number for “unchanged”: the 0.001 range tolerance is engineering judgement.',
    cite: ['NATO 8-4', 'NATO 29-1', 'NATO 13-9', 'NATO 13-8', 'EJ'], judgement: true, needs: 'row {13}; gear needs row {14} or {67}',
  }),
  def({
    id: 'configuration-match', title: 'Clean, one configuration', severity: 'critical', scope: 'point', interval: 'SET',
    why: 'The quasi-steady technique builds each curve at a given altitude-weight-configuration, and flap, gear, speedbrake and thrust belong to each test point’s configuration, so a point in another configuration is left out of this set, to be grouped on its own, and two equally common configurations call for splitting the set. NATO tests cruise at various combinations of weight and external configuration (tanks and stores); no source asks for flaps, slats and gear retracted, so asking for the clean one (NATO’s flaps, slats and gear retracted, to which the app adds the speedbrake) is the app’s choice, and gear that never moves in the log is taken as fixed. Tolerances are engineering judgement.',
    cite: ['NATO 13-9', 'NATO 8-4', 'NATO 29-1', 'NATO 12-3', 'EJ'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'trim-fixed', title: 'Pitch trim still', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'No source asks for a still pitch trim during a performance record: this check is the app’s own data-quality aid. When an autopilot’s altitude hold is tested NATO records stabiliser position, so a deviation can be traced to a speed change or a trim action, and NATO notes that pitch-trim drag depends on CG position. The app reasons that a step starts a transient while a slow drift hardly changes the drag, so only a step warns; the 0.02 size and the 0.5 s window are engineering judgement.',
    cite: ['NATO 21-7', 'NATO 13-9', 'EJ'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'wings-level', title: 'Wings level, unaccelerated', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Aircraft fly wings level in the steady trim state, and in trimmed symmetric flight lift approximately equals weight and thrust drag; NATO flies its level accelerations with minimum sideslip and a normal acceleration of about one g, and corrects small discrepancies in the analysis. Two derivations, not on a cited page: a bank φ raises the lift needed by 1/cos φ and the induced drag by its square, which no energy correction removes, and the accelerometer reads cos θ cos φ in unaccelerated flight. The tolerances, and the refly beyond the warn lines (stricter than NATO’s correction of small n_z discrepancies), are engineering judgement.',
    cite: ['Cook p.56', 'Cook p.33', 'Cook p.63', 'NATO 13-7', 'FD08 p.4', 'EJ'], judgement: true,
    sourced: 'n_z about one g, small discrepancies corrected in analysis: NATO 13-7 (level accelerations, borrowed)', needs: 'rows {17}, {18} and {4}',
  }),
  def({
    id: 'weather', title: 'Calm air', severity: 'critical', scope: 'point', interval: 'R',
    why: 'Weather requirements for performance tests may be very stringent; NATO looks for stable air and warns that vertical air motion and wind or pressure gradients can bias a measured rate of climb by 100 fpm or more. The app infers that vertical air motion biases the climb term of the energy correction in the same way, while a steady wind leaves TAS-based results unchanged (info only). Tolerances are engineering judgement.',
    cite: ['NATO 8-3', 'NATO 13-9', 'App dictionary.ts lines 61, 155', 'EJ'], judgement: true,
    needs: 'rows {3} and {20}; add {152}',
  }),
  def({
    id: 'isa-day', title: 'Standard (ISA) day', severity: 'advisory', scope: 'point', interval: 'R; SET',
    why: 'Data reduction calculates standard-day values, and point performance needs the temperature within tolerances. Tolerance is engineering judgement.',
    cite: ['NATO 13-3', 'EJ'], judgement: true, needs: 'rows {20} and {151}, or rows {3}, {4} and {20} for the TAS/Mach estimate',
  }),
  def({
    id: 'near-stall', title: 'Back side or near the stall', severity: 'advisory', scope: 'point', interval: 'R against SET',
    why: 'Below the speed of the plotted curve’s minimum (the back side) the speed is unstable at a fixed throttle, so such points tend to drift; no source drops them from the fit: NATO considers a range of speeds from the back side of the power curve highly desirable for low-performance aircraft, and discards an outlier (“wild point”) only for a good technical reason. Watching the slowest points for a departure from the lift line and the parabolic polar fitted through the middle points (never through the point judged), as a sign the stall is near, is the app’s own note, and the point stays in the fit. 1.3 V_S is NATO’s usual landing approach speed, borrowed as an info line. The other thresholds are engineering judgement.',
    cite: ['Cook p.35', 'Cook p.152', 'NATO 13-5', 'NATO 13-10', 'NATO 13-3', 'Cook p.64', 'Cook p.509', 'EJ'], judgement: true,
    sourced: 'info below 1.3 V_S: NATO 13-5 (usual landing approach speed, borrowed)', needs: 'rows {18} and {68}',
  }),
  def({
    id: 'compressibility', title: 'Mach effects at the fast end', severity: 'advisory', scope: 'point', interval: 'R against SET',
    why: 'Cruise drag is primarily a function of lift coefficient and Mach number; as compressibility becomes significant the coefficients depend on Mach as well as incidence. Cook notes compressibility effects from about M 0.3, with stability and control changes that may not become significant until M 0.6 or higher; applying 0.6 to drag at the fast end of the set, the M_MO − 0.02 margin and the 2 % drag rise are engineering judgement.',
    cite: ['NATO 13-10', 'NATO 13-9', 'Cook p.36', 'Cook p.360', 'EJ'], judgement: true,
    sourced: 'M 0.6: Cook p.360 (stability and control changes, borrowed for drag)', needs: 'rows {4} and {68}',
  }),
  def({
    id: 'envelope', title: 'Out of ground effect, inside limits', severity: 'advisory', scope: 'point', interval: 'R',
    why: 'Ground effect lasts up to about one wingspan above the ground (a semi-span in the taxi-test section of NATO’s pre-flight tests chapter), and a test plan states the envelope and the source of its limits. The app has no wingspan setting, so it warns below 200 ft, more than one span for all but the largest airliners; that default and the V_MO − 10 kt and M_MO − 0.02 margins are engineering judgement.',
    cite: ['NATO 13-4', 'NATO 9-20', 'NATO 8-3', 'EJ'], judgement: true,
    sourced: 'about one wingspan: NATO 13-4 (end of a take-off test, borrowed)', needs: 'row {20}',
  }),
  def({
    id: 'weight-cg', title: 'Weight, CG and W/δ', severity: 'info', scope: 'point', interval: 'R',
    why: 'Weight and CG are part of each test point; pitch-trim drag depends on CG position; jet cruise data are presented against weight over pressure ratio.',
    cite: ['NATO 29-1', 'NATO 13-9', 'NATO 13-10'], judgement: false, needs: 'row {63}',
  }),
  def({
    id: 'weight-column', title: 'Current weight used', severity: 'analysis', scope: 'set', interval: 'SET and the plotted channels',
    why: 'Excess thrust and weight are used to derive lift and drag, inaccurate weight makes them inaccurate, and each point’s weight is part of its configuration. In X-Plane, total,___lb (curnt,___lb in X-Plane 10/11 logs) is the current weight and gross,___lb the maximum.',
    cite: ['NATO 13-3', 'NATO 9-11', 'NATO 29-1', 'App dictionary.ts lines 167, 168, 171, 172', 'App src/core/channels/guide.ts line 58'], judgement: false, needs: 'row {63}',
  }),
  def({
    id: 'weight-spread', title: 'Weight change across the points', severity: 'analysis', scope: 'set', interval: 'U',
    why: 'Data reduction calculates standard-day values reduced to standard weight; NATO notes that corrections can be made in linearised form and that one below about 10 % needs only 10 % accuracy for a 1 % result (said of point performance). The minimum-drag speed scales with √(W/ρ), as the lecture’s glider polars at three wing loadings show; this check judges the weight only, and the ISA-day and altitude-band checks judge the density. The brief sets no weight requirement, so reduction is advice, not a rule: the check only warns.',
    cite: ['NATO 13-2', 'NATO 13-3', 'NATO 13-8', 'Cook p.510', 'FD12b p.22', 'FD12b p.23', 'B p.7', 'EJ'], judgement: true,
    sourced: 'hint above 10 %: NATO 13-8 (thrust and drag corrections to point performance of up to about 10 %, which then need only 10 % accuracy; borrowed)',
    follows: 'NATO 13-2 and 13-3 (reduce) over the brief’s silence (B p.7)', needs: 'row {63}',
  }),
  def({
    id: 'altitude-band', title: 'One altitude band', severity: 'analysis', scope: 'set', interval: 'U',
    why: 'The quasi-steady technique holds a constant altitude and builds a power-required curve at that altitude; for jets NATO also presents cruise data at constant weight over pressure ratio (W/δ), which combines altitudes. The minimum-drag speed scales with 1/√ρ, so a density spread moves the optima. The 1 % and 10 % density-ratio bands are engineering judgement, not a source’s numbers.',
    cite: ['NATO 13-9', 'NATO 13-10', 'Cook p.510', 'EJ'], judgement: true, needs: 'row {20} or {151}',
  }),
  def({
    id: 'point-count', title: 'Enough points', severity: 'critical', scope: 'set', interval: 'U',
    why: 'The lectures average each window and fit five and six points. For climb point performance, for contract purposes, NATO recommends the average of about five tests over a range of airspeeds read from a curve fit, and a spread of speeds beats repeating one. The fail at n ≤ p is a mathematical floor (the fit passes through every point); the dependence on the fit’s parameters is engineering judgement.',
    cite: ['FD12c p.10', 'FD12c p.11', 'FD12c p.17', 'NATO 13-8', 'NATO 13-9', 'NATO 13-3', 'EJ'], judgement: true,
    sourced: 'about 5 points: NATO 13-8/13-9 (the average of about five tests, climb point performance, for contract purposes, borrowed)',
    follows: 'FD12c p.11 and p.17 (5 and 6 points) and NATO 13-8', needs: 'Needs a fit through test points',
  }),
  def({
    id: 'bracket-endurance', title: 'Endurance optimum inside the data', severity: 'critical', scope: 'set', interval: 'FIT',
    why: 'NATO considers it highly desirable for low-performance aircraft to fly speeds from the back side of the power curve to near maximum speed for normal rated power. The lecture reads maximum endurance at the fitted curve’s minimum, and its own X-Plane example has that minimum at its slowest point, so a modest extrapolation is a warning, by analogy with NATO’s limited extrapolation of a validated performance model. The app’s own limits: two point spacings outside the data, a search within the data ± max(half the span, two spacings), and two-term model coefficients at least two standard errors above zero. NATO gives no endurance criterion, so the fuel-based part is advisory (U3).',
    cite: ['NATO 13-10', 'NATO 13-4', 'FD12c p.11', 'FD12c p.17', 'App src/core/analysis/rangeEndurance.ts', 'EJ'], judgement: true,
    follows: 'FD12c p.11 and p.17 (minimum of the plotted curve) for the critical part; NATO 13-10 and 13-4 for the extrapolation advice',
    needs: 'Needs a range-and-endurance fit through test points',
  }),
  def({
    id: 'bracket-range', title: 'Range optimum inside the data', severity: 'critical', scope: 'set', interval: 'FIT',
    why: 'The lecture reads maximum range where the tangent from the origin touches the fitted curve. NATO’s range criterion is the range factor (air miles per pound of fuel), so for a jet the fuel-based optimum is reported beside it, advisory (U3). NATO considers speeds up to near maximum speed for normal rated power highly desirable for low-performance aircraft, and allows limited extrapolation of a validated performance model; by analogy a modest extrapolation is a warning. The app’s own limits: two point spacings outside the data, a search within the data ± max(half the span, two spacings), two-term model coefficients at least two standard errors above zero, and, with V_MO or M_MO set as the app’s stand-in for that maximum speed, a fastest point within 10 % of it.',
    cite: ['FD12c p.11', 'FD12c p.14', 'NATO 13-10', 'NATO 13-4', 'App src/core/analysis/rangeEndurance.ts', 'EJ'], judgement: true,
    follows: 'FD12c p.11 and p.14 (tangent on the plotted curve) for the critical part; NATO 13-10 (range factor) for the advisory jet part',
    needs: 'Needs a range-and-endurance fit through test points',
  }),
  def({
    id: 'construction', title: 'Right construction for the engine', severity: 'analysis', scope: 'set', interval: 'FIT',
    why: 'The lecture’s chart plots fuel flow or power required for a propeller aircraft: maximum endurance at minimum power, maximum range from the line through the origin. For a jet the app reads the same construction on thrust (drag), which gives maximum endurance and range only if TSFC is constant: textbook theory that no cited page states (U3), so cite a Resource List text for it. Thrust is NATO’s jet term and power its propeller term. The engine-type inference (η_p above 0.01 for a propeller) is the app’s own.',
    cite: ['FD12c p.14', 'FD12c p.11', 'NATO 13-2', 'NATO 13-10', 'B p.4', 'App src/core/analysis/rangeEndurance.ts', 'App dictionary.ts line 418', 'EJ'], judgement: true,
    needs: 'The engine type: log row {68} or the SFC row, or choose jet or propeller in the checklist settings',
  }),
  def({
    id: 'speed-axis', title: 'Plotted against true airspeed', severity: 'analysis', scope: 'set', interval: 'FIT',
    why: 'Range is air distance per unit of fuel, so the tangent construction needs true airspeed; recorded airspeed is corrected for instrument and position error before TAS is calculated, and position error depends on angle of attack. Ground speed fails only with a wind, |GS − TAS·cos γ| above 1 kt at a point: that line is engineering judgement.',
    cite: ['NATO 13-10', 'NATO 13-3', 'NATO 11-4', 'App dictionary.ts line 44', 'EJ'], judgement: true, needs: 'Needs an X–Y x channel',
  }),
  def({
    id: 'fuel-flow', title: 'Fuel flow logged, TSFC steady (jets)', severity: 'advisory', scope: 'set', interval: 'U',
    why: 'Fuel used, fuel-flow rates, time and engine parameters must all be recorded; NATO’s range factor is per pound of fuel; the lecture’s construction works on the consumption quantity itself. A jet’s thrust-curve optima assume a constant TSFC (U3), so the check compares TSFC across the points; the 3 % spread is engineering judgement.',
    cite: ['NATO 13-2', 'NATO 13-10', 'FD12c p.10', 'FD12c p.14', 'EJ'], judgement: true, needs: 'row {45} or the SFC row',
  }),
  def({
    id: 'fuel-bookkeeping', title: 'Fuel flow matches fuel burnt', severity: 'advisory', scope: 'set', interval: 'first R.start to last R.end',
    why: 'Fuel used and fuel flow are both performance records; in its fuel-system tests NATO checks that the contents and totaliser indications agree, and it calibrates the fuel measuring system by weighing the aircraft at several fuel loads. Applying that cross-check to performance points, and the 2 % tolerance, are the app’s choices.',
    cite: ['NATO 13-2', 'NATO 17-24', 'NATO 9-11', 'App src/core/analysis/derived.ts', 'EJ'], judgement: true, needs: 'rows {45} and {63} or {62}',
  }),
  def({
    id: 'fit-quality', title: 'Fit quality and uncertainty', severity: 'advisory', scope: 'set', interval: 'FIT',
    why: 'For climb point performance NATO reads the result from a computer curve fit and judges its accuracy by the random error limit of the fit, without giving a method. The app estimates it by a jackknife (refitting without each point in turn) and warns when leaving one point out loses an optimum; the two-term models fix the ratio of the two speeds. Bands are engineering judgement.',
    cite: ['NATO 13-9', 'FD12c p.17', 'App src/core/analysis/rangeEndurance.ts', 'EJ'], judgement: true, needs: 'Needs a fit with n ≥ p + 2',
  }),
  def({
    id: 'repeats', title: 'Repeated speeds', severity: 'info', scope: 'set', interval: 'SET',
    why: 'A spread of speeds is worth more than repeating one condition, but NATO considers it highly desirable to duplicate an early test to find whether the engine output has deteriorated. The 2 kt window for “the same speed” is engineering judgement.',
    cite: ['NATO 13-3', 'NATO 13-2', 'EJ'], judgement: true, needs: 'Needs two points at the same speed',
  }),
  def({
    id: 'autopilot-record', title: 'Autopilot modes recorded', severity: 'advisory', scope: 'set', interval: 'R; R ± 30 s for the inference',
    why: 'Autopilot or stability-augmentation status is part of each test point’s configuration, so a declaration in the settings or the point notes meets NATO’s requirement. A mode that changes inside a record warns; a changed selected value (speed, vertical speed, altitude) is only noted, since the speed, level and throttle checks judge its effect, and selected values alone do not show which modes were on. The servo can keep a value after disconnect, so the inference asks whether the surface follows the servo or the stick; its thresholds are engineering judgement. Whether autopilot-held points are accepted is open item U1.',
    cite: ['NATO 29-1', 'NATO 29-2', 'App dictionary.ts lines 204, 599, 612-614, 621, 623-624', 'EJ'], judgement: true,
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
    citations: formatCitations(['NATO 13-9', 'NATO 13-10', 'NATO 13-7', 'FD13 p.13', 'B p.7']),
  },
  U2: {
    title: 'Autothrottle-held points',
    question: 'Are points whose speed the autothrottle held acceptable? NATO’s quasi-steady technique sets a throttle and lets the speed settle, and fixes the lever with the autothrottle off for its non-steady runs.',
    meanwhile: 'Declare it; the point may stand if the throttle, speed and thrust–drag checks pass.',
    citations: formatCitations(['NATO 13-9', 'NATO 13-10', 'NATO 24-6']),
  },
  U3: {
    title: 'Jet criteria from a thrust curve',
    question: 'Is a thrust-required curve with the constant-TSFC assumption accepted for a jet’s range and endurance, or are fuel-flow optima expected? The lecture’s construction chart reads “fuel flow/power required” and its UAV example works on the consumption quantity itself (current draw); NATO defines range per pound of fuel and gives no endurance criterion; no cited source gives jet criteria. The sources lean towards fuel-flow optima.',
    meanwhile: 'Show both, cite a Resource List text for the jet criteria, and ask.',
    citations: formatCitations(['FD12c p.10', 'FD12c p.11', 'FD12c p.14', 'NATO 13-10', 'B p.4']),
  },
  U4: {
    title: 'Reduction to a standard weight and altitude',
    question: 'Does the coursework expect the points reduced to a standard weight and altitude, or is stating the spread enough? The brief names no standard condition; NATO reduces data to standard-day values and weight, or to lift and drag coefficients for a performance model.',
    meanwhile: 'Reduce (constant C_L) or state the spread, and ask.',
    citations: formatCitations(['B p.7', 'NATO 13-2', 'NATO 13-3']),
  },
  U5: {
    title: 'One altitude, weight band and CG',
    question: 'Is one altitude, one weight band and one CG enough for range and endurance? NATO verifies performance at several weights and altitudes and makes trim drag a function of CG; the lecture’s glider manual flies the CG towards the rear for optimum performance; the brief is silent.',
    meanwhile: 'State it as a limitation and an enhancement, and ask.',
    citations: formatCitations(['NATO 13-3', 'NATO 13-10', 'NATO 13-9', 'FD12b p.23', 'B p.7']),
  },
  U6: {
    title: 'X-Plane’s drag output as data',
    question: 'May X-Plane’s own drag output stand in for the measured drag? A performance model needs thrust and drag known in absolute value, and X-Plane’s drag is a model output that the test cannot check independently; the lecture’s X-Plane example plots the engine power X-Plane outputs.',
    meanwhile: 'Derive drag from thrust (energy correction) and keep X-Plane’s drag as the check.',
    citations: formatCitations(['NATO 13-4', 'NATO 13-9', 'FD12c p.15']),
  },
  U7: {
    title: 'Hours and nautical miles',
    question: 'Are range and endurance figures (hours, nautical miles, on a full tank) expected, or do the optimum speeds suffice? The brief asks for range and endurance, and for numerical analysis where possible only generically (for every question), not for hours or nautical miles; the lecture examples give the two speeds.',
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

/** ISA at a pressure altitude (ft): the troposphere, and the isothermal layer (216.65 K) above 36,089 ft. */
function isa(hp: number) {
  const tropo = hp <= 36089
  const theta = tropo ? 1 - 6.8755856e-6 * hp : 216.65 / 288.15
  const delta = tropo ? theta ** 5.2558797 : 0.22336 * Math.exp(-(hp - 36089) / 20806)
  return { theta, delta, sigma: delta / theta, a: 661.48 * Math.sqrt(theta), tK: 288.15 * theta }
}

/** The current weight: X-Plane 12's total,___lb, else the X-Plane 10/11 curnt,___lb. */
function weightChannel(ds: Dataset): Channel | null {
  return findChannel(ds, 'total,___lb') ?? findChannel(ds, 'curnt,___lb')
}

/** Altitude rebuilt from VVI over rows [a, b) (trapezoids, ft, from 0 at row a; indexed from a): the porpoising scatter when only VVI is logged. */
function integrateVvi(vvi: ArrayLike<number>, time: ArrayLike<number>, a: number, b: number): Float64Array {
  const out = new Float64Array(Math.max(0, b - a))
  let h = 0
  for (let i = a; i < b; i += 1) {
    if (i > a && Number.isFinite(vvi[i - 1]) && Number.isFinite(vvi[i])) h += ((vvi[i - 1] + vvi[i]) / 2 / 60) * (time[i] - time[i - 1])
    out[i - a] = Number.isFinite(vvi[i]) ? h : NaN
  }
  return out
}

/**
 * The shaft power's thrust part, hp: each engine's power times its propeller efficiency (row 69), else the summed power
 * times η_p = (L/D·η_p) ÷ (L/D) (row 68); NaN when neither gives an efficiency in (0, 1].
 */
function thrustPowerOf(ds: Dataset, a: number, b: number, power: number): number {
  const mean = (ch: Channel | null) => (ch ? summary(ch.values, a, b).mean : NaN)
  const token = engineChannels(ds, POWER_HP).length ? POWER_HP : POWER_LEGACY
  let sum = 0
  let engines = 0
  for (let k = 1; k <= 8; k += 1) {
    const p = findChannel(ds, token(k))
    if (!p) continue
    const eta = mean(findChannel(ds, `Peff${k},cruis`) ?? findChannel(ds, `Peff${k},ratio`))
    if (!(eta > 0 && eta <= 1)) {
      engines = 0
      break
    }
    sum += eta * mean(p)
    engines += 1
  }
  if (engines > 0 && sum > 0) return sum
  const eta = mean(findChannel(ds, '__L/D,*etaP')) / mean(findChannel(ds, '__L/D,_aero') ?? findChannel(ds, '__L/D,ratio'))
  return eta > 0 && eta <= 1 ? eta * power : NaN
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
  let altSource: PointMetrics['altSource'] = null
  if (geo) {
    const t = trend(geo.values, time, a, b)
    dhdt = t.slope
    altScatter = 2 * t.residualSd
    altSource = 'geometric'
  } else if (palt) {
    const t = trend(palt.values, time, a, b)
    const tK = temp ? mean(temp) + 273.15 : atm.tK
    dhdt = (t.slope * tK) / atm.tK
    altScatter = 2 * t.residualSd
    altSource = 'pressure'
  } else if (vvi) {
    // VVI alone: the climb rate is its mean, and the porpoising scatter that of the altitude it integrates to.
    dhdt = mean(vvi) / 60
    altScatter = 2 * trend(integrateVvi(vvi.values, time, a, b), time.subarray(a, b), 0, b - a).residualSd
    altSource = 'vvi'
  }
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
  const w = mean(weightChannel(ds))
  const keas = mean(findChannel(ds, '_Vind,_keas'))
  const s = mean(findChannel(ds, 'S-ref,ft*ft'))
  const q = 0.5 * RHO0 * (KT * keas) ** 2
  const dens = findChannel(ds, '_dens,ratio')
  const tK = temp ? mean(temp) + 273.15 : NaN
  // ISA quantities need the pressure altitude: without it σ comes only from the density ratio, and ΔISA is unknown.
  const haveHp = Number.isFinite(hp)
  const sigma = dens ? mean(dens) : !haveHp ? NaN : Number.isFinite(tK) ? (atm.sigma * atm.tK) / tK : atm.sigma
  const machCh = findChannel(ds, '_Mach,ratio')
  const mach = machCh ? mean(machCh) : v / atm.a
  const dIsa = !haveHp ? NaN : Number.isFinite(tK) ? tK - atm.tK : machCh && Number.isFinite(v) ? atm.tK * ((v / (mach * atm.a)) ** 2 - 1) : NaN
  const vFts = v * KT
  const climb = (w * dhdt) / vFts
  const acc = (w / G0) * dvdt * KT
  const total = climb + acc
  const angle = ((alpha + kappaDeg) * Math.PI) / 180
  const tForce = Number.isFinite(thrust) ? thrust : NaN
  const cosTerm = tForce * (1 - Math.cos(Number.isFinite(angle) ? angle : 0))
  const dCorr = tForce * Math.cos(Number.isFinite(angle) ? angle : 0) - total
  const drag = mean(findChannel(ds, '_drag,___lb'))
  // Without thrust: a share of X-Plane's drag, else of the thrust power η_p·P (a share of the shaft power P alone
  // understates the share of the drag by η_p), else, labelled as such, of the shaft power.
  let share = Math.abs(total) / dCorr
  let shareOf: PointMetrics['shareOf'] = 'corrected drag'
  if (!Number.isFinite(thrust) && drag > 0) {
    share = Math.abs(total) / drag
    shareOf = 'X-Plane drag'
  } else if (!Number.isFinite(thrust) && power > 0) {
    const thrustPower = thrustPowerOf(ds, a, b, power)
    share = Math.abs(total * vFts) / (550 * (Number.isFinite(thrustPower) ? thrustPower : power))
    shareOf = Number.isFinite(thrustPower) ? 'thrust power' : 'shaft power'
  }
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
    altSource,
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
    shareOf,
    ffCorr,
    x: mean(x),
    y: mean(y),
  }
}

/**
 * The fit through point means with the plotted model, and its two optima (physical models in closed form). A
 * polynomial's optima are searched within the data ± max(half the span, two point spacings): the bracket checks warn up
 * to two spacings outside the data, so the search reaches that far even with three or four points.
 */
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
  const re = polyRangeEndurance(widenedRange(fit, pairs.length))
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

/**
 * The polynomial with its speed range widened so that polyRangeEndurance's search (the range ± RE_MARGIN of its span)
 * reaches at least two point spacings beyond the data: widening the range by d on each side moves each end of the
 * search by d·(1 + 2·RE_MARGIN).
 */
function widenedRange(fit: PolyFit, n: number): PolyFit {
  const span = fit.xMax - fit.xMin
  const reach = Math.max(RE_MARGIN * span, n > 1 ? (2 * span) / (n - 1) : 0)
  const d = (reach - RE_MARGIN * span) / (1 + 2 * RE_MARGIN)
  return d > 0 ? { ...fit, xMin: fit.xMin - d, xMax: fit.xMax + d } : fit
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
  const weight = weightChannel(ds)
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
  // Mode codes (a change inside a record is a mode change) and selected values (a change is only noted).
  const channelsOf = (tokens: readonly string[]) => tokens.map((tok) => findChannel(ds, tok)).filter((c): c is Channel => c !== null)
  const modeChannels = channelsOf(['_fdir,_mode', '_mode,__alt', '_mode,hding', '_auto,throt'])
  const setChannels = channelsOf(['__set,__vvi', '_dial,__alt', '__set,speed'])
  const propulsion = propulsionType(ds, settings.propulsion)
  const fitAll = fitThrough(metrics.map((m) => m.x), metrics.map((m) => m.y), input.fit)

  // thrust-drag first: without row 152 the weather check uses each point's own result.
  const thrustDrag = metrics.map((m) => (Number.isFinite(m.drag) && m.drag > 0 && Number.isFinite(m.dCorr) ? (m.dCorr - m.drag) / m.drag : NaN))

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
      checks.push(result(d('sample-rate'), KIND, status, `${fmt(sr.rate, 3)} Hz${sr.dropouts ? `, ${sr.dropouts} dropout${sr.dropouts === 1 ? '' : 's'}` : ''}`, 'pass ≥ 1 Hz and no dropouts; warn 0.2–1 Hz or a dropout (a step > 3 × the median); fail < 0.2 Hz (both lines less 2 %)', status === 'pass' ? '' : 'Log at 10 writes per second.', pid))
    }

    // record-length (the rows of R: the time column has one per row, whatever else is logged)
    const n = b - a
    {
      const status: CheckStatus = L < 5 || n < 10 ? 'fail' : L >= 60 ? 'pass' : 'warn'
      checks.push(result(d('record-length'), KIND, status, `${fix(L, 1)} s, ${n} rows`, 'pass ≥ 60 s; warn 5–60 s; fail < 5 s or < 10 rows', status === 'warn' ? 'Record the last minute of each point when you fly it.' : status === 'fail' ? 'Too short to average: re-cut or refly.' : '', pid))
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
        checks.push(result(d('stabilised'), KIND, status, `${st.found ? `set ${fix(tSet, 0)} s after a power change` : `no throttle change in the ${fix(st.lookback, 0)} s before`}${Number.isFinite(st.thrustTrend) ? `; thrust trend ${signed(st.thrustTrend, 1)} %` : ''}`, 'pass: the last power change ≥ 60 s before R; info: sooner, but the thrust trend over R ≤ 1 % and the speed steady; warn: sooner and still settling (never fails)', status === 'warn' ? 'Taken while still settling: the energy correction matters for this point.' : status === 'info' ? 'Set soon after a power change, but already steady.' : '', pid))
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
      checks.push(result(d('throttle-fixed'), KIND, status, [Number.isFinite(lever) ? `lever range ${fmt(lever, 2)}` : '', Number.isFinite(force) ? `${ps.force} range ${pct(force, 2)}` : ps.force === 'n1' ? `N1 range ${fix(ps.n1Range, 2)} %pt` : ''].filter(Boolean).join('; '), 'pass: lever range ≤ 0.002 and thrust (else power) range ≤ 1 % of its mean (N1 ≤ 0.5 %pt without either); warn ≤ 0.01 and ≤ 3 % (1.5 %pt); fail beyond', status === 'fail' ? 'The throttle changed inside the record: re-cut it to its constant-throttle part (Re-cut this point) or refly.' : '', pid))
    }

    // autothrottle-off
    const at = autothrottleEvidence(ds, a, b, ktas)
    {
      if (at.basis === 'none') checks.push(notCheckable(d('autothrottle-off'), KIND, pid))
      else if (at.basis === 'logged') {
        const status: CheckStatus = at.codeOn ? 'warn' : 'pass'
        checks.push(result(d('autothrottle-off'), KIND, status, `_auto,throt ${at.codeOn ? 'not 0' : '0'} (a mode code: confirm its meaning with a calibration recording)`, 'pass: _auto,throt 0 throughout R; warn: not 0 (never fails)', status === 'warn' ? 'Declare autothrottle use for this point (open item U2).' : '', pid))
      } else {
        const status: CheckStatus = at.atLike ? 'warn' : at.share <= 0.01 ? 'pass' : 'info'
        checks.push(result(d('autothrottle-off'), KIND, status, `lever changed in ${pct(at.share, 1)} of samples, range ${fmt(at.leverRange, 2)}${at.atLike ? ' — autothrottle-like (inferred)' : ''}`, 'pass: levers still (changes in ≤ 1 % of samples); warn: autothrottle-like (changes in ≥ 20 % of samples, lever range ≤ 0.02, levers together, TAS 2σ ≤ 1 kt); info: any other lever activity (never fails)', status === 'warn' ? 'Declare autothrottle use for this point (open item U2).' : '', pid))
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
      checks.push(result(d('level'), KIND, status, `climb rate ${signed(fpm, 1)} fpm, altitude 2σ ${fix(m.altScatter, 1)} ft${m.altSource === 'vvi' ? ' (VVI integrated over R)' : ''}`, 'pass |ḣ| ≤ 20 fpm and altitude 2σ ≤ 20 ft; warn a larger ḣ (corrected) or 2σ 20–100 ft; fail 2σ > 100 ft (porpoising); with VVI only, the altitude is VVI integrated over R', status === 'warn' ? 'Keep the point: the energy correction removes the climb.' : status === 'fail' ? 'Not a quasi-steady point: refly.' : '', pid))
    }

    // energy-correction (the "not checkable" line names only what is missing)
    if (!Number.isFinite(m.share) || !Number.isFinite(m.w)) {
      const missing = [
        !Number.isFinite(m.v) ? 'row {3}' : '',
        !Number.isFinite(m.dhdt) ? 'row {20} or {4}' : '',
        !Number.isFinite(m.w) ? 'row {63}' : '',
        !Number.isFinite(m.thrust) && !Number.isFinite(m.power) && !Number.isFinite(m.drag) ? 'row {35}, {64} or {34}' : '',
      ].filter(Boolean)
      checks.push(notCheckable(d('energy-correction'), KIND, { ...pid, needs: missing.length ? missing.join(', ') : undefined }))
    }
    else {
      const status: CheckStatus = m.share <= 0.02 ? 'pass' : m.share <= 0.1 ? 'warn' : 'fail'
      const of = m.shareOf === 'corrected drag' ? 'the drag' : m.shareOf === 'X-Plane drag' ? 'X-Plane’s drag' : m.shareOf === 'thrust power' ? 'the thrust power η_p·P' : 'the shaft power (η_p unknown)'
      const shaftNote = m.shareOf === 'shaft power' ? ' The share of the drag is larger by 1/η_p: log row 68 or 69 for the propeller efficiency.' : ''
      checks.push(result(d('energy-correction'), KIND, status, `|ΔT_E| ${pct(m.share, 2)} of ${of} (climb ${signed(m.climb, 0)} lbf, acceleration ${signed(m.acc, 0)} lbf)${Number.isFinite(m.thrust) ? `; thrust-axis term ${pct(m.cosTerm / m.dCorr, 2)}` : ''}`, 'pass ≤ 2 %; warn 2–10 % (use D_corr and FF_corr); fail > 10 %; a share of the corrected drag, or without thrust of X-Plane’s drag, else of the thrust power η_p·P (rows 68–69), else of the shaft power', `${status === 'warn' ? 'Use the corrected drag and fuel flow for this point, not the raw thrust.' : status === 'fail' ? 'A correction above NATO’s 10 % correction size: refly the point.' : ''}${shaftNote}`.trim(), pid))
    }

    // thrust-drag (the "not checkable" line names every row D_corr and the comparison still need)
    if (!Number.isFinite(thrustDrag[i])) {
      const missing = [
        !Number.isFinite(m.drag) ? 'row {64}' : '',
        !Number.isFinite(m.thrust) ? 'row {35}' : '',
        !Number.isFinite(m.v) ? 'row {3}' : '',
        !Number.isFinite(m.w) ? 'row {63}' : '',
        !Number.isFinite(m.dhdt) ? 'row {20} or {4}' : '',
      ].filter(Boolean)
      checks.push(notCheckable(d('thrust-drag'), KIND, { ...pid, needs: missing.length ? missing.join(', ') : undefined }))
    }
    else {
      const r = thrustDrag[i]
      const raw = (m.thrust - m.drag) / m.drag
      const status: CheckStatus = Math.abs(r) <= 0.01 ? 'pass' : 'warn'
      checks.push(result(d('thrust-drag'), KIND, status, `corrected ${signed(100 * r, 2)} % against X-Plane’s drag (raw thrust ${signed(100 * raw, 2)} %)`, 'pass |r| ≤ 1 %; warn beyond, with the causes to look for above 3 % (never fails)', Math.abs(r) > 0.03 ? 'Look for a throttle move, an autothrottle, the wrong weight column, a record edge or vertical air motion.' : status === 'warn' ? 'Small mismatch: note it.' : '', pid))
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
      // Only a step warns (and flags the point for a re-cut); a slow drift is a note.
      const status: CheckStatus = step > 0.02 ? 'warn' : range > 0.02 ? 'info' : 'pass'
      checks.push(result(d('trim-fixed'), KIND, status, `trim range ${fmt(range, 2)}, largest change in 0.5 s ${fmt(step, 2)}`, 'pass: no change > 0.02 within 0.5 s and a range ≤ 0.02; info: a slow drift (range > 0.02, no step); warn: a step (> 0.02 within 0.5 s) (never fails)', status === 'warn' ? 'The trim stepped inside the record: check the speed and altitude traces there, or end the record before it (Re-cut).' : status === 'info' ? 'A slow trim drift: it hardly changes the drag.' : '', pid))
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

    // The wind along the track, |GS − TAS·cos γ| (kt): the weather check, and the speed-axis check for a ground-speed axis.
    const gamma = vpath ? summary(vpath.values, a, b).mean : (Math.asin(Math.max(-1, Math.min(1, m.dhdt / (m.v * KT)))) * 180) / Math.PI
    const cosG = Math.cos((Number.isFinite(gamma) ? gamma : 0) * Math.PI / 180)
    const wh = gs && ktas ? Math.abs(summary(gs.values, a, b).mean - summary(ktas.values, a, b).mean * cosG) : NaN

    // weather
    {
      const tas = ktas
      if (!tas || (!gs && !turb && !wind && !vwind)) checks.push(notCheckable(d('weather'), KIND, { ...pid, severity: 'advisory' }))
      else {
        let whChange = NaN
        if (gs) {
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
        const td = thrustDrag[i]
        let status: CheckStatus = 'pass'
        const why: string[] = []
        if (whChange > 5 || wv > 50 || tbm > 0.1) status = 'fail'
        else {
          if (wv > 10 || wr > 2 || tbm > 0.01) status = 'warn'
          // Without row 152, this point's own corrected thrust against the drag output stands in for the vertical wind.
          if (!vwind && !(Math.abs(td) <= 0.01)) {
            status = 'warn'
            why.push(`vertical air motion unchecked (no row 152, and ${Number.isFinite(td) ? 'this point’s corrected thrust is more than 1 % from the drag output' : 'no thrust–drag comparison: see the thrust–drag check for the missing rows'})`)
          }
          // A steady wind leaves TAS-based results unchanged: a note.
          if (wh > 1 || trackDiff > 1) {
            if (status === 'pass') status = 'info'
            why.push('steady wind: TAS-based results are unaffected; use specific air range TAS/FF, not ground-speed specific range')
          }
        }
        checks.push(result(d('weather'), KIND, status, [Number.isFinite(wh) ? `horizontal wind ${fix(wh, 2)} kt (change ${fix(whChange, 2)} kt)` : '', Number.isFinite(trackDiff) ? `track vs heading − β ${fix(trackDiff, 2)}°` : '', wind ? `wind range ${fix(wr, 2)} kt` : '', vwind ? `|vertical wind| ${fmt(wv, 2)} fpm` : '', turb ? `turbulence ${fmt(tbm, 2)}` : ''].filter(Boolean).join('; '), 'pass: wind ≤ 1 kt along the track and track within 1° of heading − β, |w_v| ≤ 10 fpm, wind range ≤ 2 kt, turbulence ≤ 0.01, and without row 152 this point’s thrust–drag within 1 %; info: a steady wind beyond 1 kt or 1° (TAS-based results unaffected); warn: |w_v| > 10 fpm, wind range > 2 kt, turbulence > 0.01, or without row 152 thrust–drag beyond 1 %; fail: wind changing > 5 kt across R, |w_v| > 50 fpm or turbulence > 0.1', status === 'fail' ? 'Changing wind or vertical air inside the record: set calm air and refly.' : why.join('; '), { ...pid, severity: status === 'fail' ? 'critical' : 'advisory' }))
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
        // The reference polar without this point.
        const polar = fastest ? ref.polar(i) : null
        const r = polar ? (m.cd - (polar.cd0 + polar.k * clP ** 2)) / (polar.cd0 + polar.k * clP ** 2) : NaN
        const mmo = settings.limits?.mmo
        // The Mach line applies at the fast end only: a jet's whole cruise set can lie above M 0.6.
        const status: CheckStatus = (fastest && m.mach >= 0.6) || (mmo && m.mach >= mmo - 0.02) || r > 0.02 ? 'warn' : 'pass'
        checks.push(result(d('compressibility'), KIND, status, `M ${fix(m.mach, 3)}${fastest ? ' (fastest third)' : ''}${Number.isFinite(r) ? `, drag ${signed(100 * r, 1)} % from the reference polar` : ''}`, 'pass: in the fastest third M < 0.6 and the drag within 2 % of the reference polar (fitted without the point), and at every point M < M_MO − 0.02 when set; warn otherwise (never fails)', status === 'warn' ? 'Keep the point; C_L and Mach change together at one altitude, so their effects cannot be separated (a second altitude would).' : '', pid))
      }
    }

    // envelope
    if (!agl) checks.push(notCheckable(d('envelope'), KIND, pid))
    else {
      const h = summary(agl.values, a, b).min
      const lim = settings.limits ?? {}
      const over = (lim.vmoKias && kias && summary(kias.values, a, b).max > lim.vmoKias - 10) || (lim.mmo && machCh && summary(machCh.values, a, b).max > lim.mmo - 0.02)
      const status: CheckStatus = h < GROUND_EFFECT_FT || over ? 'warn' : 'pass'
      checks.push(result(d('envelope'), KIND, status, `lowest ${fix(h, 0)} ft AGL${lim.vmoKias || lim.mmo ? '' : '; speed limits not set'}`, `pass: ≥ ${GROUND_EFFECT_FT} ft AGL (the app’s stand-in for one wingspan), and with the limits set max KIAS ≤ V_MO − 10 kt and max Mach ≤ M_MO − 0.02; warn otherwise (never fails)`, h < GROUND_EFFECT_FT ? 'Ground effect lowers the induced drag.' : over ? 'Within the margin of a set speed limit, or beyond it.' : '', pid))
    }

    // weight-cg (info)
    if (!weight) checks.push(notCheckable(d('weight-cg'), KIND, pid))
    else {
      const wr = summary(weight.values, a, b)
      const wOverDelta = Number.isFinite(m.hp) ? m.w / isa(m.hp).delta : NaN
      checks.push(result(d('weight-cg'), KIND, 'info', `W ${fmt(m.w, 5)} lb (change ${fmt(wr.range, 3)} lb)${Number.isFinite(m.cg) ? `, CG ${fmt(m.cg, 4)} ft` : ''}${Number.isFinite(m.fuel) ? `, fuel ${fmt(m.fuel, 4)} lb` : ''}, W/δ ${fmt(wOverDelta, 4)} lb`, 'report only', '', pid))
    }

    // Selected values alone do not show the modes: the inference runs whenever no mode code is logged.
    const pc = modeChannels.length ? null : pitchControlSource(ds, a, b)
    return {
      point,
      a,
      b,
      checks,
      configMeans,
      configKey: config.surfaces.length ? configMeans.map((v) => (Math.round(v * 100) / 100).toFixed(2)).join(',') : null,
      hasGear: config.gear !== null,
      at,
      pitch: pc ? pc.source : (null as PitchSource | null),
      modesChanged: modeChannels.some((c) => summary(c.values, a, b).range > 0),
      setsChanged: setChannels.some((c) => summary(c.values, a, b).range > 0),
      windH: wh,
    }
  })

  // ---- configuration-match
  let configTie = 0
  {
    const keys = ctxs.map((c) => c.configKey).filter((k): k is string => k !== null)
    const counts = new Map<string, number>()
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    const ranked = [...counts.entries()].sort((u, v) => v[1] - u[1])
    // Configurations tied for the most points: which one is "the set" is undecided, so none of them is left out (a point
    // in any other configuration still is), and the verdict asks for the split. Keys within 0.01 of each other (apart
    // only by rounding) are one configuration, not a tie.
    const sameValues = (u: readonly number[], v: readonly number[]) => u.length === v.length && u.every((x, k) => Math.abs(x - v[k]) <= 0.01 + 1e-9)
    const sameAs = (c: (typeof ctxs)[number], values: readonly number[]) => sameValues(c.configMeans, values)
    const top = ranked[0]?.[1] ?? 0
    const leaders: number[][] = []
    for (const [key, k] of ranked) {
      const values = key.split(',').map(Number)
      if (k === top && !leaders.some((l) => sameValues(l, values))) leaders.push(values)
    }
    const tied = leaders.length
    if (tied > 1) configTie = tied
    const modal = ranked[0]?.[0] ?? null
    const modalValues = leaders[0] ?? []
    // Gear that never moves in the whole log is taken as fixed gear and left out of "clean".
    const gearHandle = findChannel(ds, '_gear,__0/1')
    const gearLegs = gearHandle ? [] : ds.channels.filter((ch) => ch.token === '_gear,__rat' && ch.stats.finite > 0)
    const withGear = ctxs.some((c) => c.hasGear)
    const gearFixed = withGear && (gearHandle ? gearHandle.stats.constant : gearLegs.length > 0 && gearLegs.every((ch) => ch.stats.constant))
    const cleanValues = gearFixed ? modalValues.slice(0, -1) : modalValues
    const clean = cleanValues.every((v) => Math.abs(v) <= 0.01)
    const fixedDown = gearFixed && Math.abs(modalValues[modalValues.length - 1]) > 0.01
    const criterion = 'pass: every point in one clean configuration (flaps, slats, speedbrake and gear retracted; gear that never moves in the log counts as fixed); info: the same with the gear down throughout the log (taken as fixed gear); warn: one configuration that is not clean, or configurations tied for the most points (split the set); fail: a point in another configuration than the most frequent one, or than the tied ones (left out of this set, not reflown)'
    const leftOutHint = 'Left out: put it in its own group (another configuration).'
    for (const c of ctxs) {
      const pid = { pointId: c.point.id }
      if (c.configKey === null || modal === null) {
        c.checks.push(notCheckable(d('configuration-match'), KIND, pid))
        continue
      }
      if (tied > 1) {
        const inTie = leaders.some((values) => sameAs(c, values))
        c.checks.push(result(d('configuration-match'), KIND, inTie ? 'warn' : 'fail', `${tied} configurations tie at ${top} points each; this point ${c.configKey}${inTie ? '' : tied === 2 ? ', in neither tied configuration' : ', in none of the tied configurations'}`, criterion, inTie ? `${tied} configurations tie for the most points: split the set, one group per configuration.` : leftOutHint, pid))
        continue
      }
      const same = sameAs(c, modalValues)
      const status: CheckStatus = !same ? 'fail' : !clean ? 'warn' : fixedDown ? 'info' : 'pass'
      c.checks.push(result(d('configuration-match'), KIND, status, `${same ? 'same as the set' : 'differs from the set'}; set ${clean ? 'clean' : `not clean (${modal})`}${fixedDown ? '; gear down throughout the log: taken as fixed gear' : ''}`, criterion, status === 'fail' ? leftOutHint : status === 'warn' ? 'The results hold for that configuration, not clean cruise.' : status === 'info' ? 'Taken as fixed gear: if the gear retracts, these points are not clean (raise it for the points, or report them as gear down).' : '', pid))
    }
  }

  // ---- near-stall (back side from the as-plotted fit, in its plotted units; near the stall for the slowest third). A
  // note only: the point stays in the fit.
  {
    const vE = fitAll?.vE ?? null
    // Without a fitted minimum, the point with the least plotted y stands in for it.
    const lowest = metrics.reduce((best, m, k) => (Number.isFinite(m.x) && Number.isFinite(m.y) && (best < 0 || m.y < metrics[best].y) ? k : best), -1)
    const vs = settings.limits?.vsKeas
    ctxs.forEach((c, i) => {
      const m = metrics[i]
      const pid = { pointId: c.point.id }
      const haveLift = Number.isFinite(m.alpha) && Number.isFinite(m.cl)
      if (!haveLift && !Number.isFinite(m.cd)) {
        c.checks.push(notCheckable(d('near-stall'), KIND, pid))
        return
      }
      const backSide = vE !== null ? m.x < vE : lowest >= 0 && m.x < metrics[lowest].x
      // The 3 % warn line widens to two standard errors of the reference fit's prediction (at most 10 %), and the info
      // line sits 1 point below it; the reference leaves this point out.
      let deficit = NaN
      let excess = NaN
      let liftLine = 0.03
      let polarLine = 0.03
      if (ref.slowest.has(i)) {
        const lift = ref.lift(i)
        const polar = ref.polar(i)
        if (lift && haveLift) {
          const line = lift.a * (m.alpha - lift.alpha0)
          deficit = (line - m.cl) / line
          liftLine = widenedLine(0.03, lift.se(m.alpha), line)
        }
        if (polar && Number.isFinite(m.cd)) {
          const cl = Number.isFinite(m.clW) ? m.clW : m.cl
          const p = polar.cd0 + polar.k * cl ** 2
          excess = (m.cd - p) / p
          polarLine = widenedLine(0.03, polar.se(cl ** 2), p)
        }
      }
      const low = vs ? m.keas < 1.3 * vs : false
      let status: CheckStatus = 'pass'
      const hints: string[] = []
      if (deficit > liftLine || excess > polarLine) {
        status = 'warn'
        hints.push('Near the stall: it stays in the fit; check it against the curve and say so in the report.')
      } else if (deficit > liftLine - 0.01 || excess > polarLine - 0.01) {
        status = 'info'
        hints.push('Approaching the stall.')
      }
      if (low) {
        if (status === 'pass') status = 'info'
        hints.push('Below 1.3 V_S, NATO’s usual landing approach speed: keep it, and watch the speed stability.')
      }
      if (backSide) {
        if (status === 'pass') status = 'info'
        hints.push('Back side: speed unstable at fixed throttle; the energy correction matters most here.')
      }
      const lines = liftLine > 0.03 || polarLine > 0.03 ? `; warn line ${pct(Math.max(liftLine, polarLine), 1)} (reference scatter)` : ''
      c.checks.push(result(d('near-stall'), KIND, status, `${backSide ? 'back side' : 'front side'}${Number.isFinite(deficit) ? `, lift deficit ${pct(deficit)}` : ''}${Number.isFinite(excess) ? `, drag ${signed(100 * excess, 1)} % from the polar` : ''}${low ? ', below 1.3 V_S' : ''}${lines}`, 'pass: front side, and in the slowest third the lift deficit and polar excess up to the info line; info: back side (below the speed of the plotted curve’s minimum), beyond the info line, or below 1.3 V_S; warn: beyond the warn line (a note: the point stays in the fit). The warn line is 3 %, widened to two standard errors of the reference fit’s prediction (at most 10 %), and the info line sits 1 point below it; the reference is the points between the TAS quartiles (with fewer than three there, those outside the slowest third), less the point judged', hints.join(' '), pid))
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
      // Only another configuration: plotted but left out of this set's fit, to be grouped on its own ("Plot
      // separately", as in the static checklist); nothing needs flying again. 'left-out' stays the user's own choice.
      status = failed.every((k) => k.id === 'configuration-match') ? 'plot-only' : 'excluded'
      reasons.push(...failed.map((k) => PERF_REASON[k.id] ?? k.title.toLowerCase()))
    } else if (na.length) {
      status = 'cannot-confirm'
      reasons.push(...na.map((k) => `${k.title.toLowerCase()}: not checkable`))
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

  // ---- weight-column (a plotted formula with the maximum weight fails at any count, whatever weight row is logged)
  {
    const def0 = d('weight-column')
    const refs = new Set<string>([...(x ? refsOf(ds, x) : []), ...(y ? refsOf(ds, y) : [])])
    const plain = [x?.token, y?.token]
    const usesMax = [...refs, ...plain].some((r) => r !== undefined && /^(gross_lb|maxim_lb|gross,___lb|maxim,___lb)$/.test(r))
    const criterion = 'pass: the current weight (total,___lb, or curnt,___lb) falls with fuel burn, or stays constant with zero fuel flow, and no plotted formula uses the maximum weight; warn: it does not fall across the used points while fuel flows or with no fuel-flow row to confirm the burn; fail: a plotted formula uses gross,___lb or maxim,___lb'
    const ordered = [...usedIdx].sort((u, v) => SET[u].start - SET[v].start)
    if (usesMax) set.push(result(def0, KIND, 'fail', 'a plotted formula uses gross,___lb or maxim,___lb (the constant maximum weight)', criterion, 'Use total,___lb, the current weight.'))
    else if (!weight) set.push(notCheckable(def0, KIND))
    // Whether the weight falls takes two used points.
    else if (ordered.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    else {
      const ffLogged = U.some((m) => Number.isFinite(m.ff))
      const ffPositive = U.some((m) => m.ff > 0)
      const first = metrics[ordered[0]].w
      const last = metrics[ordered[ordered.length - 1]].w
      const frozen = !(first > last) && (ffPositive || !ffLogged)
      const measured = first > last ? `${weight.token} falls from ${fmt(first, 5)} to ${fmt(last, 5)} lb` : `${weight.token} does not fall (${fmt(first, 5)} to ${fmt(last, 5)} lb)${ffPositive ? ' although fuel flows' : ffLogged ? ' with zero fuel flow' : '; no fuel-flow row confirms a burn'}`
      set.push(result(def0, KIND, frozen ? 'warn' : 'pass', measured, criterion, frozen ? 'The weight is not updating: check the column and the fuel settings.' : ''))
    }
  }

  // ---- weight-spread (the weight only: the ISA-day and altitude-band checks judge the density)
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
      const fV = U.map((m) => Math.abs(Math.sqrt(ws / m.w) - 1))
      const fD = U.map((m) => Math.abs(ws / m.w - 1))
      const maxFV = Math.max(...fV)
      const maxFD = Math.max(...fD)
      const cgs = U.map((m) => m.cg).filter(Number.isFinite)
      // Above NATO's 10 % correction size the check still only warns: the brief sets no weight requirement.
      const far = maxFD > 0.1
      const status: CheckStatus = !far && spread <= 0.01 && maxFD <= 0.01 ? 'pass' : 'warn'
      reductionWarn ||= status === 'warn'
      const hint = far
        ? spread <= 0.1
          ? 'The reduction moves points by more than 10 % (above NATO’s 10 % correction size) though the weights spread less: check the reference weight.'
          : 'The weights spread by more than 10 % (above NATO’s 10 % correction size): split the set by weight, or reduce with care.'
        : status === 'warn'
          ? 'Reduce each point to the standard weight (V·f_V, D·f_D), or state the spread (open item U4).'
          : ''
      set.push(result(def0, KIND, status, `weight spread ${pct(spread, 2)}; max |f_D − 1| ${pct(maxFD, 2)}, max |f_V − 1| ${pct(maxFV, 2)} (to ${fmt(ws, 5)} lb; f_D = W_s/W, f_V = √(W_s/W))${cgs.length ? `; CG range ${fmt(Math.max(...cgs) - Math.min(...cgs), 2)} ft` : ''}`, 'pass: weight spread ≤ 1 % and |f_D − 1| ≤ 1 %; warn: larger, and above 10 % (NATO’s correction size) check the reference weight or split the set (never fails)', hint))
    }
  }

  // ---- altitude-band (σ: the density ratio, else ISA at the pressure altitude with the logged temperature)
  {
    const def0 = d('altitude-band')
    const hps = U.map((m) => m.hp).filter(Number.isFinite)
    const sig = U.map((m) => m.sigma).filter(Number.isFinite)
    if (!findChannel(ds, 'p-alt,ftMSL') && !findChannel(ds, '_dens,ratio')) set.push(notCheckable(def0, KIND))
    else if (sig.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    else {
      const spread = (Math.max(...sig) - Math.min(...sig)) / (sig.reduce((s, v) => s + v, 0) / sig.length)
      const status: CheckStatus = spread <= 0.01 ? 'pass' : spread <= 0.1 ? 'warn' : 'fail'
      reductionWarn ||= status === 'warn'
      // A jet's cruise data combine altitudes through W/δ (NATO 13-10), so the fix offered is that reduction or a split.
      const failHint = propulsion.type === 'jet' ? 'The points span more than 10 % in density: reduce them through W/δ (NATO’s jet cruise presentation) or split the set by altitude.' : 'The points belong to different altitudes: split the set.'
      set.push(result(def0, KIND, status, `${hps.length >= 2 ? `pressure altitude ${fmt(Math.min(...hps), 5)}–${fmt(Math.max(...hps), 5)} ft; ` : ''}density ratio ${fmt(Math.min(...sig), 4)}–${fmt(Math.max(...sig), 4)}, spread ${pct(spread, 2)}`, 'pass σ spread ≤ 1 %; warn ≤ 10 %; fail > 10 % (fix the analysis: split the set, or for a jet reduce through W/δ)', status === 'warn' ? 'Reduce to one altitude (f_V) or fit by groups (open item U5).' : status === 'fail' ? failHint : ''))
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
  const noOptimum = 'none within the data ± max(½ span, 2 point spacings) for a polynomial, a straight line, or a two-term model with A or B ≤ 0, R² ≤ 0, or A or B within 2 standard errors of zero'
  // The X–Y table under the plot searches a polynomial only within the data ± ½ span (rangeEndurance's window), so it
  // may show no optimum where this check, searching two spacings out, finds one.
  const polynomial = input.fit === 'linear' || input.fit === 'poly2' || input.fit === 'poly3'
  const tableNote = (v: number) => (polynomial && (v < xMinU - RE_MARGIN * (xMaxU - xMinU) || v > xMaxU + RE_MARGIN * (xMaxU - xMinU)) ? '; beyond the data ± ½ span the X–Y table searches, so the table may show none' : '')
  {
    const def0 = d('bracket-endurance')
    const criterion = `pass: V_E inside the data with ≥ 2 points on each side; warn: one point on a side, or V_E outside by ≤ 2 point spacings; fail: no minimum (${noOptimum}) or V_E > 2 spacings outside; jets: a least corrected fuel flow at the edge of the data drops a pass to warn (advisory)`
    if (!fitU) set.push(notCheckable(def0, KIND))
    else if (fitU.vE === null) set.push(result(def0, KIND, 'fail', `no minimum: ${fitU.problem}`, criterion, 'Fly slower points, so the curve has its minimum among them.'))
    else {
      const vE = fitU.vE
      const below = xsU.filter((v) => v < vE).length
      const above = xsU.filter((v) => v > vE).length
      const over = vE < xMinU ? (xMinU - vE) / spacing : vE > xMaxU ? (vE - xMaxU) / spacing : 0
      let status: CheckStatus = over > 2 ? 'fail' : over > 0 ? 'warn' : below >= 2 && above >= 2 ? 'pass' : 'warn'
      let measured = `V_E ${fmt(vE, 4)} ${x?.meta.unit || 'kt'}: ${below} points below, ${above} above${over > 0 ? `; ${fix(over, 2)} spacings outside the data` : ''}${tableNote(vE)}`
      let hint = status === 'fail' ? `Fly ${vE < xMinU ? 'slower' : 'faster'} points.` : over > 0 ? 'Limited extrapolation: fly slower points if you can.' : status === 'warn' ? 'Only one point on one side of V_E.' : ''
      if (jetFuelPart) {
        const iMin = byTas.reduce((best, m, k) => (m.ffCorr < byTas[best].ffCorr ? k : best), 0)
        const edge = iMin <= 1 || iMin >= byTas.length - 2
        measured += `; lowest corrected fuel flow at ${fmt(byTas[iMin].v, 4)} kt (${iMin} slower, ${byTas.length - 1 - iMin} faster)`
        if (edge && status === 'pass') status = 'warn'
        if (edge) hint = `${hint ? `${hint} ` : ''}The fuel-based endurance optimum lies at the edge of the data (advisory).`
      }
      set.push(result(def0, KIND, status, measured, criterion, hint))
    }
  }
  {
    const def0 = d('bracket-range')
    const criterion = `pass: V_R inside the data with ≥ 2 points faster; warn: one faster, or V_R outside by ≤ 2 point spacings; fail: no tangent point (${noOptimum.replace('none within', 'no tangent within')}, or the curve not positive there) or V_R > 2 spacings outside; advisory, dropping a pass to warn: jets, a specific air range peaking with < 2 points faster or ≤ 1 % above the fastest point; with V_MO or M_MO set (the app’s stand-in for NATO’s maximum speed at normal rated power), a fastest point more than 10 % below it`
    if (!fitU) set.push(notCheckable(def0, KIND))
    else if (fitU.vR === null) set.push(result(def0, KIND, 'fail', `no tangent point: ${fitU.problem}`, criterion, 'Fly faster points.'))
    else {
      const vR = fitU.vR
      const above = xsU.filter((v) => v > vR).length
      const over = vR > xMaxU ? (vR - xMaxU) / spacing : vR < xMinU ? (xMinU - vR) / spacing : 0
      let status: CheckStatus = over > 2 ? 'fail' : over > 0 ? 'warn' : above >= 2 ? 'pass' : 'warn'
      let measured = `V_R ${fmt(vR, 4)} ${x?.meta.unit || 'kt'}: ${above} points faster${over > 0 ? `; ${fix(over, 2)} spacings outside the data` : ''}${tableNote(vR)}`
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
      // NATO 13-10 covers speeds to near maximum speed for normal rated power; the app stands V_MO or M_MO, when set, in
      // for that speed (advisory).
      const lim = settings.limits ?? {}
      const kiasTop = Math.max(...U.map((m) => m.kias).filter(Number.isFinite))
      const machTop = Math.max(...U.map((m) => m.mach).filter(Number.isFinite))
      const byKias = lim.vmoKias && Number.isFinite(kiasTop) ? kiasTop / lim.vmoKias : NaN
      const byMach = lim.mmo && Number.isFinite(machTop) ? machTop / lim.mmo : NaN
      if (Number.isFinite(byKias) || Number.isFinite(byMach)) {
        measured += `; fastest point ${[Number.isFinite(byKias) ? `${fmt(kiasTop, 3)} KIAS (V_MO ${fmt(lim.vmoKias as number, 3)})` : '', Number.isFinite(byMach) ? `M ${fix(machTop, 3)} (M_MO ${fix(lim.mmo as number, 2)})` : ''].filter(Boolean).join(', ')}`
        if (!(byKias >= 0.9) && !(byMach >= 0.9)) {
          if (status === 'pass') status = 'warn'
          hint = `${hint ? `${hint} ` : ''}The fastest point is more than 10 % below the set speed limit, the app’s stand-in for NATO’s maximum speed at normal rated power: if the aircraft can fly faster at normal rated power, add faster points (advisory).`
        }
      }
      set.push(result(def0, KIND, status, measured, criterion, hint))
    }
  }

  // ---- construction (an unknown engine type is a warning pointing to the setting, not a block on the verdict)
  {
    const def0 = d('construction')
    const model = input.fit
    const physical = model === 'power-model' || model === 'drag-model'
    let status: CheckStatus
    let hint = ''
    const jet = propulsion.type === 'jet'
    const propeller = propulsion.type === 'propeller'
    if ((jet && quantity === 'power') || (propeller && (quantity === 'thrust' || quantity === 'drag'))) {
      status = 'fail'
      hint = jet ? 'Plot thrust (or drag), not engine power, for a jet.' : 'Plot power, not thrust or drag, for a propeller aircraft.'
    } else if ((model === 'power-model' && (quantity === 'thrust' || quantity === 'drag')) || (model === 'drag-model' && quantity === 'power')) {
      status = 'fail'
      hint = 'The model’s powers of V belong to the other quantity: replot with the matching model.'
    } else if (quantity === 'fuel-flow') {
      status = physical ? 'warn' : 'pass'
      if (physical) hint = 'TSFC or BSFC varies with speed: prefer a polynomial for fuel flow.'
    } else if (!propulsion.type) {
      status = 'warn'
      hint = 'Engine type unknown: choose jet or propeller in the checklist settings (or log row 68 or the SFC row) to check the construction.'
    } else if (quantity === 'other') {
      status = 'warn'
      hint = 'Plot thrust or drag (jet), power (propeller) or fuel flow.'
    } else status = 'pass'
    set.push(result(def0, KIND, status, `${propulsion.type ?? 'engine type unknown'} (${propulsion.reason}); Y is ${quantity}; ${model} fit${propeller && quantity === 'power' ? '; the construction assumes a constant propeller efficiency' : ''}`, 'pass: jet with thrust or drag, propeller with power, either with fuel flow (polynomial); warn: fuel flow with a two-term model, a Y the app does not recognise, or the engine type unknown; fail: a jet with power, a propeller with thrust or drag, or a model whose powers of V belong to the other quantity', hint))
  }

  // ---- speed-axis (the wind along the track at each point, |GS − TAS·cos γ|, whatever the weather check found)
  const windKt = ctxs.map((c) => c.windH).filter(Number.isFinite)
  const windFound = windKt.some((w) => w > 1)
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
        hint = windFound ? 'Ground speed with a wind: replot against KTAS.' : 'Ground speed: replot against KTAS.'
      } else {
        status = 'warn'
        hint = 'Plot against true airspeed (KTAS).'
      }
      set.push(result(def0, KIND, status, `x is ${x.meta.short || x.token}${t === 'Vtrue,_ktgs' ? (windKt.length ? `; largest |GS − TAS·cos γ| ${fix(Math.max(...windKt), 1)} kt` : '; wind unknown (no TAS)') : ''}`, 'pass: KTAS (or KEAS at one altitude); warn: KIAS, another channel, or ground speed in calm air (|GS − TAS·cos γ| ≤ 1 kt at every point); fail: ground speed with a wind (> 1 kt at a point)', hint))
    }
  }

  // ---- fuel-flow (NATO 13-2: fuel flow must be recorded, so a log without it warns)
  {
    const def0 = d('fuel-flow')
    const haveFf = engineChannels(ds, FUEL_FLOW).length > 0 || engineChannels(ds, TSFC).length > 0
    const anyFuel = haveFf || engineChannels(ds, (k) => `FF__${k},gal/h`).length > 0 || engineChannels(ds, BSFC).length > 0
    const tsfc = U.map((m) => m.ff / m.thrust).filter(Number.isFinite)
    const criterion = 'pass: fuel flow (or TSFC) logged for every engine with thrust, and a TSFC spread ≤ 3 % across the used points; warn: no fuel-flow row at all, an engine without one, or a spread > 3 % (never fails); propeller aircraft: info'
    if (!anyFuel) set.push(result(def0, KIND, 'warn', 'no fuel-flow or SFC row logged', criterion, 'Log row 45 (fuel flow): NATO requires fuel flow to be recorded for performance tests.'))
    else if (propulsion.type === 'propeller') set.push(result(def0, KIND, 'info', 'propeller: the fuel-flow optima are reported as info only', 'report only for propeller aircraft'))
    else if (!haveFf) set.push(notCheckable(def0, KIND, { needs: 'row {45} in lb/h, or the TSFC row' }))
    else if (tsfc.length < 2) set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points (with thrust)' }))
    else {
      const mean = tsfc.reduce((s, v) => s + v, 0) / (tsfc.length || 1)
      const spread = tsfc.length ? (Math.max(...tsfc) - Math.min(...tsfc)) / mean : NaN
      const everyEngine = engineChannels(ds, THRUST).every((_, k) => findChannel(ds, FUEL_FLOW(k + 1)) || findChannel(ds, TSFC(k + 1)))
      const status: CheckStatus = everyEngine && !(spread > 0.03) ? 'pass' : 'warn'
      set.push(result(def0, KIND, status, `TSFC ${fmt(Math.min(...tsfc), 3)}–${fmt(Math.max(...tsfc), 3)} lb/(lbf·h), spread ${pct(spread, 1)}${everyEngine ? '' : '; an engine with thrust has no fuel-flow row'}`, criterion, status === 'warn' ? 'Report the fuel-flow optima (least corrected fuel flow, most TAS/FF) beside the thrust-curve ones.' : ''))
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
      // A fuel quantity that does not fall (fuel burn off) leaves nothing to compare with.
      if (!(burnt > 0)) set.push(notCheckable(def0, KIND, { needs: 'Needs the fuel quantity to fall across the points (fuel burn on in X-Plane)' }))
      else {
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
        set.push(result(def0, KIND, status, `integrated fuel flow ${fmt(integrated, 4)} lb against ${fmt(burnt, 4)} lb burnt (${signed(100 * diff, 1)} %)`, 'pass |difference| ≤ 2 % of the fuel burnt; warn beyond (never fails)', status === 'warn' ? 'Check the time base (sim time), refuelling or a reloaded situation.' : ''))
      }
    }
  }

  // ---- fit-quality (jackknife)
  {
    const def0 = d('fit-quality')
    if (!fitU || U.length < p + 2) set.push(notCheckable(def0, KIND))
    else {
      // Leave-one-out fits; one that loses an optimum the full fit has is counted, not skipped (a fragile optimum).
      const thetaE: number[] = []
      const thetaR: number[] = []
      let lostE = 0
      let lostR = 0
      for (let k = 0; k < U.length; k += 1) {
        const rest = U.filter((_, j) => j !== k)
        const f = fitThrough(rest.map((m) => m.x), rest.map((m) => m.y), input.fit)
        if (f?.vE) thetaE.push(f.vE)
        else if (fitU.vE) lostE += 1
        if (f?.vR) thetaR.push(f.vR)
        else if (fitU.vR) lostR += 1
      }
      const jack = (vals: number[], full: number | null) => {
        if (!full || vals.length < 2) return NaN
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length
        return Math.sqrt(((vals.length - 1) / vals.length) * vals.reduce((s, v) => s + (v - mean) ** 2, 0)) / full
      }
      const seE = jack(thetaE, fitU.vE)
      const seR = jack(thetaR, fitU.vR)
      const lost = lostE + lostR > 0
      const status: CheckStatus = fitU.r2 >= 0.98 && seE <= 0.01 && seR <= 0.02 && !lost ? 'pass' : 'warn'
      const lostText = lost ? `; leaving one point out loses ${[lostE ? `V_E in ${lostE}` : '', lostR ? `V_R in ${lostR}` : ''].filter(Boolean).join(' and ')} of ${U.length} fits` : ''
      // Corrected and reduced: D_corr·f_D against V·f_V.
      let reduced = ''
      if ((quantity === 'thrust' || quantity === 'drag') && U.every((m) => Number.isFinite(m.dCorr))) {
        const f = fitThrough(U.map((m) => m.v * Math.sqrt((ws / m.w) * (m.sigma / sigmaS))), U.map((m) => (m.dCorr * ws) / m.w), input.fit)
        if (f?.vE && f.vR) reduced = `; corrected and reduced: V_E ${fmt(f.vE, 4)}, V_R ${fmt(f.vR, 4)} kt TAS`
      }
      const asPlotted = fitAll && (fitAll.vE || fitAll.vR) ? `; as plotted (every point): V_E ${fmt(fitAll.vE ?? NaN, 4)}, V_R ${fmt(fitAll.vR ?? NaN, 4)}` : ''
      set.push(result(def0, KIND, status, `R² ${fix(fitU.r2, 4)}; jackknife SE(V_E) ${pct(seE, 1)}, SE(V_R) ${pct(seR, 1)}${lostText}${asPlotted}${reduced}${input.fit === 'power-model' || input.fit === 'drag-model' ? '; V_R/V_E = 3^¼ by construction: cross-check with a polynomial' : ''}`, 'pass R² ≥ 0.98, SE(V_E) ≤ 1 %, SE(V_R) ≤ 2 % and no leave-one-out fit loses an optimum; warn otherwise (never fails)', lost ? 'An optimum hangs on single points: add points around it, or quote it as uncertain.' : status === 'warn' ? 'The optima hinge on few points: add points or quote the uncertainty.' : ''))
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

  // ---- autopilot-record (mode codes, rows 108 and 117, show the modes; selected values, row 118, only what was set)
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
      // A changed selected value is noted whatever shows the modes: the speed, level and throttle checks judge its effect.
      const reset = ctxs.filter((c) => c.setsChanged).map((c) => c.point.name)
      const resetText = reset.length ? `; a selected value changed inside ${reset.join(', ')}` : ''
      const resetHint = reset.length ? 'A selected value changed inside a record: the speed, level and throttle checks judge its effect.' : ''
      let status: CheckStatus
      let measured: string
      let hint: string
      if (logged) {
        // A mode change inside a record warns.
        const changed = ctxs.filter((c) => c.modesChanged).map((c) => c.point.name)
        status = changed.length ? 'warn' : reset.length ? 'info' : 'pass'
        measured = `${setChannels.length ? 'mode codes and selected values' : 'mode codes'} logged${changed.length ? `; a mode changed inside ${changed.join(', ')}` : reset.length ? '' : ', constant in every record'}${resetText}`
        hint = changed.length ? 'Write the modes used (e.g. ALT HOLD, A/T off) in the point notes.' : resetHint
      } else if (declared || allNoted) {
        status = reset.length ? 'info' : 'pass'
        measured = `${declared ? `declared: autopilot ${settings.declared?.autopilot}${settings.declared?.modes ? ` (${settings.declared.modes})` : ''}` : 'modes written in every point’s note'}${resetText}`
        hint = resetHint
      } else {
        status = 'warn'
        const held = inferred.filter((c) => c.pitch === 'autopilot').length
        const counts = (['autopilot', 'pilot', 'hands-off', 'unknown'] as PitchSource[]).map((s) => [s, inferred.filter((c) => c.pitch === s).length] as const).filter(([, k]) => k > 0)
        measured = `inferred from the surface, stick and servo: ${counts.map(([s, k]) => `${s} ${k}`).join(', ')}${setChannels.length ? '; selected values logged, but no mode codes' : ''}${resetText}`
        hint = held ? `The autopilot held pitch in ${held} points (inferred): write the modes (e.g. ALT HOLD, A/T off) in the point notes or log row 117.` : 'Write the modes in the point notes or log row 117.'
      }
      set.push(result(def0, KIND, status, measured, 'pass: mode codes (rows 108, 117) logged and constant, or the modes declared for every point (settings or notes); info: as a pass, but a selected value (row 118: speed, vertical speed, altitude) changed inside a record; warn: a mode change inside a record, or the controller only inferred (selected values alone do not show the modes) (never fails; acceptance is open item U1)', hint))
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
  const verdict = perfVerdict(points, set, usedIdx.length, SET.length, settings.fitUsedOnly === true, recut, p, configTie)
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

/**
 * The reference polar and lift line, and the slowest and fastest thirds by TAS. The reference points lie between the
 * 25th and 75th TAS percentiles (with fewer than three there, every point outside the slowest third), and `polar(i)`
 * and `lift(i)` fit them without point i, so a judged point never bends or widens its own reference.
 */
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
  const third = Math.max(1, Math.round(sorted.length / 3))
  const slowest = new Set(sorted.slice(0, third))
  const fastest = new Set(sorted.slice(sorted.length - third))
  let refIdx = sorted.filter((i) => metrics[i].v >= q25 - 1e-9 && metrics[i].v <= q75 + 1e-9)
  if (refIdx.length < 3) refIdx = sorted.filter((i) => !slowest.has(i))
  const polarCl = (m: PointMetrics) => (Number.isFinite(m.clW) ? m.clW : m.cl)
  return {
    refIndices: refIdx,
    slowest,
    fastest,
    /** C_D = cd0 + k·C_L² without point `skip`, and the standard error of predicting one more point at a given C_L² */
    polar: (skip: number) => {
      const pts = refIdx.filter((i) => i !== skip && Number.isFinite(metrics[i].cd) && Number.isFinite(polarCl(metrics[i])))
      const pf = pts.length >= 2 ? lineStats(pts.map((i) => polarCl(metrics[i]) ** 2), pts.map((i) => metrics[i].cd)) : null
      return pf && Number.isFinite(pf.c1) ? { cd0: pf.c0, k: pf.c1, se: pf.se } : null
    },
    /** C_L = a·(α − α0) without point `skip`, and the standard error of predicting one more point at a given α */
    lift: (skip: number) => {
      const pts = refIdx.filter((i) => i !== skip && Number.isFinite(metrics[i].alpha) && Number.isFinite(metrics[i].cl))
      const lf = pts.length >= 2 ? lineStats(pts.map((i) => metrics[i].alpha), pts.map((i) => metrics[i].cl)) : null
      return lf && Number.isFinite(lf.c1) && lf.c1 !== 0 ? { a: lf.c1, alpha0: -lf.c0 / lf.c1, se: lf.se } : null
    },
  }
}

/**
 * Least squares y = c0 + c1·x through paired finite values, with the standard error of predicting one more point at
 * x0: s·√(1 + 1/n + (x0 − x̄)²/Sxx) (NaN with two points: no scatter to judge).
 */
function lineStats(x: readonly number[], y: readonly number[]): { c0: number; c1: number; se: (x0: number) => number } {
  const idx = x.map((_, i) => i).filter((i) => Number.isFinite(x[i]) && Number.isFinite(y[i]))
  const n = idx.length
  const xm = idx.reduce((s, i) => s + x[i], 0) / (n || 1)
  const ym = idx.reduce((s, i) => s + y[i], 0) / (n || 1)
  const sxx = idx.reduce((s, i) => s + (x[i] - xm) ** 2, 0)
  const sxy = idx.reduce((s, i) => s + (x[i] - xm) * (y[i] - ym), 0)
  const c1 = n >= 2 && sxx > 0 ? sxy / sxx : NaN
  const c0 = ym - c1 * xm
  const ssr = idx.reduce((s, i) => s + (y[i] - c0 - c1 * x[i]) ** 2, 0)
  const s = n > 2 ? Math.sqrt(ssr / (n - 2)) : NaN
  return { c0, c1, se: (x0: number) => s * Math.sqrt(1 + 1 / n + (x0 - xm) ** 2 / sxx) }
}

/** The widest the reference scatter may push the near-stall warn line, so a large departure is still noted (judgement). */
const NEAR_STALL_CAP = 0.1

/**
 * A relative warn line widened to two standard errors of the reference prediction (`se`) relative to its value, at most
 * NEAR_STALL_CAP; `base` alone when the reference has no scatter to judge (two points or fewer).
 */
function widenedLine(base: number, se: number, value: number): number {
  const rel = (2 * se) / Math.abs(value)
  return Number.isFinite(rel) ? Math.min(NEAR_STALL_CAP, Math.max(base, rel)) : base
}

function perfVerdict(
  points: readonly PointReport[],
  set: readonly Check[],
  used: number,
  total: number,
  fitUsedOnly: boolean,
  recut: { flagged: number; fixable: number },
  parameters: number,
  configTie: number,
): Verdict {
  if (total === 0) return { kind: 'no-data', text: 'No test points to judge: save steady level points (Find steady points) and plot them.' }
  const cannot = points.filter((p) => p.status === 'cannot-confirm')
  const setNa = set.filter((c) => (c.severity === 'critical' || c.severity === 'analysis') && c.status === 'not-checkable')
  const rows = rowsFromNotCheckable([...setNa, ...cannot.flatMap((p) => p.checks.filter((c) => CRITICAL.has(c.id)))])
  const cannotText = `Cannot confirm — ${rows.length ? `tick rows ${rows.join(', ')}` : setNa.map((c) => c.title.toLowerCase()).join('; ') || 'some checks need rows the log does not have'}`
  if (used < 3 && used + cannot.length >= 3) return { kind: 'cannot-confirm', text: cannotText }
  // Configurations tied for the most points: a fit through them is not one curve (NATO 13-9 builds each at one
  // configuration), so the set checks, judged on the mixed fit, wait for the split.
  if (configTie > 1) return { kind: 'fix-analysis', text: `Fix the analysis — ${configTie} configurations tie for the most points: split the set, one group per configuration, then check each group` }
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
