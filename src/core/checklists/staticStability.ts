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
  summary,
  timeBase,
  trend,
  twoVariableFit,
  worse,
  atLeast,
  declaresModes,
  configText,
  engineChannels,
  N1,
  POWER_HP,
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

const ej = (value: number, unit: string) => ({ value, unit, source: 'EJ', judgement: true })

/**
 * The static checklist's main tolerances, named with their source (documentation: the checks below use these values
 * as written; unlike the dynamic checklist's CHECK_THRESHOLDS they are not yet overridable).
 */
export const TRIM_CHECK_THRESHOLDS = {
  minRecordS: { value: 30, unit: 's', source: 'App guide.ts line 79 (30–60 s)', judgement: false },
  floorRecordS: ej(5, 's'),
  driftKtMin: ej(1, 'kt/min'),
  speedChangeKt: { value: 2, unit: 'kt', source: 'App steady.ts line 243', judgement: false },
  vviSdFpm: ej(100, 'fpm'),
  levelFpm: { value: 100, unit: 'fpm', source: 'App steady.ts line 243', judgement: false },
  qMeanDegS: ej(0.1, 'deg/s'),
  dn: ej(0.02, 'g'),
  gammaDeg: ej(10, 'deg'),
  bankDeg: ej(3, 'deg'),
  bankSdDeg: ej(1, 'deg'),
  betaDeg: ej(2, 'deg'),
  forceRange: ej(0.02, ''),
  stickRange: ej(0.02, 'ratio'),
  elevSdDeg: ej(0.1, 'deg'),
  trimRange: ej(0.002, 'ratio'),
  trimDrift: ej(0.02, 'ratio'),
  clRatio: ej(1.8, ''),
  mach: ej(0.6, ''),
  heightAglFt: ej(500, 'ft'),
}

// ------------------------------------------------------------------ definitions

const def = (d: CheckDef): CheckDef => d

export const STATIC_DEFS: readonly CheckDef[] = [
  def({
    id: 'time-base', title: 'Continuous sim-time record', severity: 'critical', scope: 'point', interval: 'W',
    why: 'A trim point’s mean must come from one continuous flight; real time keeps running through pauses and menus.',
    cite: ['App src/core/time.ts', 'App src/views/modes/modesModel.ts'], judgement: false, needs: 'row {1}',
  }),
  def({
    id: 'sample-rate', title: 'Sample rate', severity: 'critical', scope: 'point', interval: 'W',
    why: 'NATO records its classical steady climbs at one sample per five seconds and notes that quasi-steady trim data may even be recorded by hand; the app’s recording guide asks 10 writes per second for trim points. The 1 Hz pass line is engineering judgement.',
    cite: ['NATO 13-6', 'NATO 15-5', 'App src/core/channels/guide.ts'], judgement: true, needs: 'row {1}',
  }),
  def({
    id: 'record-length', title: 'Long enough to judge', severity: 'critical', scope: 'point', interval: 'W',
    why: 'No source sets a record length for a trim point; the app’s recording guide asks for trimmed points of 30 to 60 s. The lecture’s own X-Plane example selects short windows, so shorter points are kept with a warning; the 5 s floor is engineering judgement.',
    cite: ['NATO 15-5', 'App src/core/channels/guide.ts', 'FD12c p.16', 'FD12b p.19'], judgement: true,
    follows: 'pass: App guide (30–60 s); floor: engineering judgement, below the lecture example’s short windows (FD12c p.16)',
    needs: 'row {3}',
  }),
  def({
    id: 'stabilised', title: 'Settled after the last power change', severity: 'advisory', scope: 'point', interval: 'L and W',
    why: 'NATO stabilises engine and aircraft for at least a minute before recording climbs and accelerations, and notes that engine output changes appreciably in the first minute after a power-lever change. Whether X-Plane models that lag is not settled by the sources, so a short settling time is judged by the traces and only warned about.',
    cite: ['NATO 13-5', 'NATO 13-6', 'NATO 13-7', 'NATO 24-6'], judgement: true,
    follows: 'NATO 13-6 and 13-7 (one minute, stated for climbs and accelerations) rather than 24-6 (three to four minutes, propulsion tests)',
    needs: 'row {25}, {35}, {34} or {41}',
  }),
  def({
    id: 'speed-steady', title: 'Speed held steady', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Trim is steady, non-accelerating flight. NATO’s only speed-steadiness figure belongs to its cruise-climb method, and NATO corrects quasi-steady points for residual acceleration. A drift of 1 kt/min is about 0.05° of flight-path angle. Bands are engineering judgement, with the fail line at the app’s steady-point default.',
    cite: ['FD08 p.4', 'Cook p.33', 'NATO 13-10', 'App src/core/analysis/steady.ts'], judgement: true, needs: 'row {3}',
  }),
  def({
    id: 'flight-path', title: 'Steady flight path at 1 g', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Trim is steady, non-accelerating flight with forces and moments in balance, and C_L = nW/(q̄S) takes the load factor n. Sources differ on level flight: MIL states speed stability at 1 g and constant altitude, while NATO controls speed by climbing or descending at fixed power, Cook’s flight test held power constant and the lecture’s X-Plane trims at zero thrust are steady descents. A steady climb or descent is therefore a valid trim point; in a level set it is only noted.',
    cite: ['FD08 p.4', 'FD08 p.24', 'MIL p.40', 'MIL p.43', 'FD12 p.11', 'NATO 15-6', 'Cook p.47', 'FD12b p.18', 'App src/core/analysis/steady.ts line 243', 'App dictionary.ts line 55'],
    judgement: true,
    follows: 'MIL p.40 and the lecture’s level trim example (FD12 p.11) for power-for-level sets; NATO 15-6, Cook p.47 and the lecture’s X-Plane slide (FD12b p.18) otherwise',
    needs: 'row {4}; add {20}, {16} and {17}',
  }),
  def({
    id: 'wings-level', title: 'Wings level, little sideslip', severity: 'critical', scope: 'point', interval: 'W',
    why: 'The trim condition is calculated for straight, symmetric flight. A banked turn raises the load factor and needs a pitch rate, which takes extra elevator and changes C_L = nW/(q̄S). Sideslip changes the longitudinal trim only slightly, and a propeller aircraft trimmed hands-off at low speed holds some sideslip, so the sideslip bands are wider. Bands are engineering judgement.',
    cite: ['Cook p.63', 'FD11 p.6', 'FD11 p.18', 'FD08 p.24', 'MIL p.40', 'App src/core/analysis/steady.ts line 243'], judgement: true, needs: 'rows {17} and {18}',
  }),
  def({
    id: 'throttle-fixed', title: 'Power not changed during the point', severity: 'critical', scope: 'point', interval: 'W',
    why: 'The sources hold power fixed while trim data are taken: Cook’s flight test kept power constant, NATO keeps engine power at the trim setting through a block of stability tests. Thrust, power and N1 come first because they are the force. Bands are engineering judgement.',
    cite: ['Cook p.47', 'NATO 15-6', 'NATO 13-5', 'App src/core/analysis/steady.ts'], judgement: true,
    needs: 'row {35}, {34}, {41} or {25}',
  }),
  def({
    id: 'controls-fixed', title: 'Controls fixed: no stick input', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Controls-fixed means the elevator is held at the setting needed to trim, and a trimmed aircraft keeps flying the condition when the controls are released. Stability tests are open loop. Bands are engineering judgement.',
    cite: ['Cook p.45', 'FD10 slide 25', 'FD08 p.4', 'NATO 15-4'], judgement: true,
    needs: 'row {8} for the stick, {74} or {11} for the elevator',
  }),
  def({
    id: 'trim-fixed', title: 'Pitch trim still', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Controls-fixed stability takes the elevator and its trim at the settings for the prevailing trim condition, and the trim is part of the pitch control this plot measures. Under an autopilot altitude hold a stabiliser trim action can change the condition. Bands are engineering judgement.',
    cite: ['Cook p.45', 'FD10 slide 25', 'NATO 21-7'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'configuration-constant', title: 'Configuration unchanged', severity: 'critical', scope: 'point', interval: 'W',
    why: 'Flap and gear positions are recorded to establish a test point’s configuration, and trim depends on the airframe configuration as well as speed, weight and CG. No source gives a number for “unchanged”: the 0.001 range tolerance is engineering judgement.',
    cite: ['NATO 15-5', 'NATO 8-4', 'Cook p.34'], judgement: true, needs: 'row {13}; gear needs row {14}',
  }),
  def({
    id: 'configuration-match', title: 'One configuration per line', severity: 'critical', scope: 'point', interval: 'P',
    why: 'Trim depends on the airframe configuration, and each test point’s configuration is defined by its flap and gear positions. The 0.01 match tolerance is engineering judgement.',
    cite: ['Cook p.34', 'NATO 29-1', 'NATO 15-5'], judgement: true, needs: 'row {13}',
  }),
  def({
    id: 'near-stall', title: 'Not near the stall', severity: 'advisory', scope: 'point', interval: 'U',
    why: 'The trim curve of most aircraft has some non-linear tendency at high trim C_L and in extreme cases stability reverses, so a sweep that starts from the stall needs its top points judged apart. Below the minimum-drag speed a level point drifts. Lift-slope and speed-margin bands are engineering judgement.',
    cite: ['Cook p.41', 'FD10 slide 19', 'FD12 p.10', 'Cook p.35', 'MIL p.41'], judgement: true, needs: 'row {18}',
  }),
  def({
    id: 'envelope', title: 'Out of ground effect, inside limits', severity: 'advisory', scope: 'point', interval: 'W',
    why: 'Ground effect lasts up to about one wingspan above the ground, so trim points are flown at altitude; a test plan states the envelope and the source of its limits. 500 ft is engineering judgement.',
    cite: ['NATO 13-4', 'FD12b p.18', 'NATO 8-3'], judgement: true, needs: 'row {20}',
  }),
  def({
    id: 'weather', title: 'Calm air', severity: 'advisory', scope: 'point', interval: 'W',
    why: 'Weather requirements are set for each block of test points, and weather affects the quality of a test; turbulence adds scatter and a vertical wind biases a level point. Engineering judgement, as in the dynamic checklist.',
    cite: ['NATO 8-3', 'NATO 15-4'], judgement: true, needs: 'row {152}',
  }),
  def({
    id: 'trim-variable', title: 'Pitch control includes the trim', severity: 'analysis', scope: 'set', interval: 'U',
    why: 'With a trimming tail the whole tail rotates to trim and the elevator can sit near zero; tail setting and elevator enter the same moment balance, and re-trimming needs elevator or stabiliser. Automatic trimming can hide the control-position gradient. The 2 SE and 3 SE tests are engineering judgement.',
    cite: ['FD09 p.5', 'FD09 p.30', 'FD09 p.32', 'FD10 slide 22', 'FD08 p.14', 'Cook p.44', 'Cook p.491', 'NATO 21-7', 'MIL p.40', 'MIL p.41', 'FD05 p.15', 'App dictionary.ts lines 210, 214, 381', 'App src/views/xy/xyPresets.ts line 38'],
    judgement: true, needs: 'rows {13} and {74} or {11}',
  }),
  def({
    id: 'cl-definition', title: 'C_L from EAS, current weight, S-ref', severity: 'analysis', scope: 'set', interval: 'P, judged on U',
    why: 'The lectures take C_L = nW/(q̄S) with q̄ = ½ρ₀U_E² from equivalent airspeed, and data reduction uses the current weight. X-Plane’s KIAS carries a pitot error that grows with angle of attack, and its gross,___lb is the maximum weight. X-Plane’s own C_L uses the aerodynamic lift, hence the 3 % band (engineering judgement).',
    cite: ['FD08 p.24', 'Cook p.64', 'NATO 15-3', 'App dictionary.ts lines 44, 45, 167, 168', 'App src/core/analysis/derived.ts'],
    judgement: true, needs: 'rows {63}, {3}, {4} and {68} for S-ref',
  }),
  def({
    id: 'cl-range', title: 'Enough points across a wide C_L range', severity: 'critical', scope: 'set', interval: 'U',
    why: 'The gradient comes from trims at several C_L. MIL’s speed-stability band of ±15 % in speed spans a C_L ratio of about 1.8; the lecture’s trim example runs from the stall to 250 kt in 15 kt steps; a searching evaluation needs more and better data points. Numbers are engineering judgement.',
    cite: ['FD12b p.26', 'Cook p.47', 'MIL p.40', 'FD12 p.10', 'Cook p.48'], judgement: true, needs: 'Needs cl-definition',
  }),
  def({
    id: 'compressibility', title: 'Compressibility at the fast end', severity: 'advisory', scope: 'set', interval: 'U',
    why: 'As compressibility grows the moment coefficients depend on Mach as well as incidence; static margins can change markedly in the transonic regime. In a sweep at one altitude Mach and C_L change together and cannot be separated. M 0.6 is engineering judgement for a subsonic transport.',
    cite: ['Cook p.36', 'Cook p.276', 'Cook p.252'], judgement: true, needs: 'row {4}',
  }),
  def({
    id: 'thrust-method', title: 'Thrust: zero, constant or power-on', severity: 'advisory', scope: 'set', interval: 'U',
    why: 'The sources differ: the lecture’s X-Plane procedure trims at zero thrust; Cook’s flight test held power constant while noting power effects cannot be fully removed; NATO keeps power at the trim setting; the lecture’s computed trims re-balance thrust at each speed. Power is probably the most significant source of variation in static stability.',
    cite: ['FD12b p.18', 'Cook p.46', 'Cook p.47', 'NATO 15-6', 'FD12 p.12', 'Cook p.38', 'FD08 p.21', 'FD12b p.26'], judgement: true,
    follows: 'FD12b p.18 and Cook p.47 for a pass; FD12 p.12 (computed trims, thrust re-balanced) is labelled, not failed',
    needs: 'row {25}; add {35} or {41}',
  }),
  def({
    id: 'cg-lines', title: 'CG positions: neutral point possible?', severity: 'info', scope: 'set', interval: 'U',
    why: 'The neutral point comes from the mean gradient of each CG line plotted against CG and extrapolated to zero; three lines are called barely adequate; CG can be changed in X-Plane 12. CG moves with fuel burn, and flying-qualities data can be adjusted only for slight CG changes. The clustering gap is engineering judgement.',
    cite: ['FD12b p.28', 'Cook p.48', 'FD10 slide 32', 'NATO 9-11', 'NATO 15-7', 'NATO 15-2'], judgement: true, needs: 'row {63}',
  }),
  def({
    id: 'autopilot-record', title: 'Autopilot modes recorded', severity: 'advisory', scope: 'set', interval: 'W; ±30 s for the inference',
    why: 'Every test point’s configuration includes the autopilot or stability-augmentation status. The servo can keep a value after disconnect, so the evidence is whether the surface follows the servo or the stick. Whether autopilot-held trims are accepted is not settled (N1).',
    cite: ['NATO 29-1', 'NATO 29-2', 'NATO 21-7', 'App dictionary.ts lines 204, 599, 612-614'], judgement: true,
    needs: 'rows {117} and {108}, or rows {8}, {11} and {138} to infer; or write the modes in each point’s note',
  }),
  def({
    id: 'pitch-augmentation', title: 'No pitch augmentation', severity: 'advisory', scope: 'set', interval: 'W of every point',
    why: 'Augmentation can supply speed stability and give zero control gradients; the gradient then belongs to the augmented aircraft. The threshold is engineering judgement.',
    cite: ['MIL p.40', 'Cook p.34'], judgement: true, needs: 'row {10}',
  }),
  def({
    id: 'gradient', title: 'Result: stick-fixed trim gradient', severity: 'info', scope: 'set', interval: 'U',
    why: 'A negative elevator-to-trim gradient means stable and a horizontal line neutral; trim curves can be non-linear from power; the course treats the stick-fixed case only. The static margin needs the tail volume ratio and elevator lift slope of X-Plane’s model, so it is not computed. t ≥ 3 is engineering judgement.',
    cite: ['FD10 slide 31', 'FD10 slide 32', 'Cook p.46', 'MIL p.40', 'FD12b p.26', 'Cook p.47', 'FD10 slide 25'], judgement: true,
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
    question: 'Are autopilot-held trim points accepted? The brief never mentions the autopilot; the lectures mention it only as raising phugoid damping, a dynamic-test issue; NATO lists autopilot status as an item to record and calls stability tests open loop, but neither approves nor forbids autopilot-held trims.',
    meanwhile: 'Declare who flew pitch in each point (the point notes) and ask.',
    citations: formatCitations(['B pp.1-9', 'FD13 p.13', 'NATO 15-4', 'NATO 29-1']),
  },
  N2: {
    title: 'Lateral-directional static stability',
    question: 'Does A2.1(b) also expect lateral-directional static stability? It says static and dynamic stability with no longitudinal or lateral label; NATO’s static lateral-directional test is the steady sideslip. This checklist covers longitudinal static stability only.',
    meanwhile: 'Ask under A2.1(b) on EdDiscussion.',
    citations: formatCitations(['B p.4', 'B p.7', 'NATO 15-5']),
  },
  N3: {
    title: 'One CG, no neutral point',
    question: 'Is a single-CG gradient without a neutral point enough? The brief names no static-stability quantity; the lectures and Cook find the neutral point from several CG lines.',
    meanwhile: 'Report the gradient and its sign, say a neutral point needs more CG positions, and ask.',
    citations: formatCitations(['B p.7', 'FD12b p.28', 'Cook p.48']),
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
  modesLogged: boolean
  modesChanged: boolean
  astab: number
  speedDrift: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

function meanOf(ch: Channel | null, a: number, b: number): number {
  return ch ? summary(ch.values, a, b).mean : NaN
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
  const n1s = engineChannels(ds, N1)
  const thrusts = engineChannels(ds, THRUST)
  const powers = engineChannels(ds, POWER_HP)
  const turb = findChannel(ds, '_turb,_locl')
  const wind = findChannel(ds, '_wind,knots')
  const vwind = findChannel(ds, '_wind,v_fpm')
  const modeChannels = ['_fdir,_mode', '_mode,__alt', '_mode,hding', '_auto,throt', '__set,__vvi', '_dial,__alt', '__set,speed']
    .map((tok) => findChannel(ds, tok))
    .filter((c): c is Channel => c !== null)

  // The set's thrust method over P (the flight-path check needs it per point; thrust-method reports it over U).
  const methodOver = (pts: readonly { a: number; b: number }[]) => thrustMethod(pts, levers, n1s, thrusts, powers)
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
      checks.push(result(d('time-base'), KIND, status, `time from ${tb.source}${tb.crosses ? '; a reset or gap inside' : ''}`, 'pass: sim time and no reset or gap; warn: real or another clock; fail: a reset or gap inside', status === 'fail' ? 'Re-cut the point inside one continuous stretch.' : '', pid))
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
    const n = speedCh ? summary(speedCh.values, a, b).n : 0
    if (!speedCh) checks.push(notCheckable(d('record-length'), KIND, pid))
    else {
      const status: CheckStatus = seconds >= 30 && n >= 30 ? 'pass' : seconds >= 5 && n >= 10 ? 'warn' : 'fail'
      checks.push(result(d('record-length'), KIND, status, `${fix(seconds, 1)} s, ${n} samples`, 'pass ≥ 30 s and ≥ 30 samples; warn 5–30 s; fail < 5 s or < 10 samples', status === 'pass' ? '' : status === 'warn' ? 'Hold trim points for 30–60 s when you fly them.' : 'Too short to judge: re-cut a longer stretch or refly.', pid))
    }

    // speed-steady (needed by stabilised)
    let speedStatus: CheckStatus | null = null
    let speedDrift = NaN
    if (speedCh) {
      const tr = trend(speedCh.values, time, a, b)
      speedDrift = tr.slope * 60
      const change = Math.abs(tr.slope * tr.seconds)
      const scatter = 2 * tr.residualSd
      speedStatus = Math.abs(speedDrift) <= 1 && scatter <= 1 ? 'pass' : change <= 2 && scatter <= 2 ? 'warn' : 'fail'
      if (!Number.isFinite(speedDrift)) speedStatus = 'fail'
    }

    // stabilised
    {
      const st = settling(ds, a, b, 120)
      if (st.by === null || (!st.found && st.lookback < 60)) checks.push(notCheckable(d('stabilised'), KIND, { ...pid, needs: st.by === null ? undefined : 'Not checkable — the log or a segment starts less than 60 s before the point and holds no power change' }))
      else {
        const tSet = st.tSet ?? 0
        const flat = !(Math.abs(st.thrustTrend) > 1)
        const status: CheckStatus = tSet >= 60 ? 'pass' : flat && speedStatus === 'pass' ? 'info' : 'warn'
        checks.push(result(d('stabilised'), KIND, status, `${st.found ? `set ${fix(tSet, 0)} s after a power change` : `no power change in the ${fix(st.lookback, 0)} s before`}${Number.isFinite(st.thrustTrend) ? `; thrust trend ${signed(st.thrustTrend, 1)} %` : ''}`, 'pass ≥ 60 s; info: sooner but already steady; warn: sooner and still settling (never fails)', status === 'warn' ? 'Still settling: wait longer after a power change before the point.' : status === 'info' ? 'Set soon after a power change, but already steady.' : '', pid))
      }
    }

    if (speedCh) {
      const tr = trend(speedCh.values, time, a, b)
      checks.push(result(d('speed-steady'), KIND, speedStatus ?? 'fail', `drift ${signed(speedDrift, 2)} kt/min (${fix(Math.abs(tr.slope * tr.seconds), 2)} kt over the point), 2σ ${fix(2 * tr.residualSd, 2)} kt`, 'pass |drift| ≤ 1 kt/min and 2σ ≤ 1 kt; warn while the change and 2σ ≤ 2 kt; fail beyond', speedStatus === 'pass' ? '' : speedStatus === 'warn' ? 'Drifting: say so in the report.' : 'The speed was not held: the point would not pass Find steady points.', pid))
    } else checks.push(notCheckable(d('speed-steady'), KIND, pid))

    // flight-path
    if (!vvi && !palt) checks.push(notCheckable(d('flight-path'), KIND, pid))
    else {
      const vs = vvi ? summary(vvi.values, a, b) : null
      const altDrift = palt ? trend(palt.values, time, a, b).slope * 60 : NaN
      const vMean = vs?.mean ?? altDrift
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
        status = worse(status, 'warn')
        hint = 'Method unknown: log row 25 (throttle) so the method can be told.'
      }
      if (status === 'fail') hint = 'Not a steady flight path at 1 g: re-cut or refly the point.'
      checks.push(result(d('flight-path'), KIND, status, `VVI ${signed(vMean, 0)} fpm (σ ${fix(vSd, 0)}), altitude drift ${signed(altDrift, 0)} ft/min, γ ${signed(gamma, 2)}°${qs ? `, mean Q ${signed(qs.mean, 3)} deg/s` : ''}, n_z − cosθcosφ ${signed(dn, 4)}`, `σ(VVI) ≤ 100 fpm, |mean Q| ≤ 0.1 deg/s, |Δn| ≤ 0.02 (warn 200, 0.2, 0.05); ${method.kind === 'power-for-level' ? 'level set: |VVI| ≤ 100 fpm (noted beyond)' : 'any steady climb or descent with |γ| ≤ 10°'}`, hint, pid))
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

    // throttle-fixed
    const ps = powerSteadiness(ds, a, b)
    if (ps.force === null) checks.push(notCheckable(d('throttle-fixed'), KIND, pid))
    else {
      let status: CheckStatus
      let measured: string
      if (ps.force === 'thrust' || ps.force === 'power') {
        status = grade(ps.forceRange, 0.02, 0.05) ?? 'fail'
        measured = `${ps.force} range ${pct(ps.forceRange)} of its mean`
      } else if (ps.force === 'n1') {
        status = grade(ps.n1Range, 0.5, 1.5) ?? 'fail'
        measured = `N1 range ${fix(ps.n1Range, 2)} %pt`
      } else {
        status = grade(ps.leverRange, 0.005, 0.02) ?? 'fail'
        measured = `lever range ${fmt(ps.leverRange, 2)}`
      }
      if (ps.force !== 'lever' && Number.isFinite(ps.leverRange)) measured += `; lever range ${fmt(ps.leverRange, 2)}`
      checks.push(result(d('throttle-fixed'), KIND, status, measured, 'thrust or power range ≤ 2 % (N1 ≤ 0.5 %pt; lever only ≤ 0.005); warn ≤ 5 % (1.5 %pt; 0.02); fail beyond', status === 'fail' ? 'The power was changed inside the point: re-cut it to the stretch after the last change (Re-cut this point) and check again.' : '', pid))
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
        status = 'warn'
        hint = 'Quiet but held off-centre: controls fixed, not trimmed hands-off; the held input is part of the elevator angle.'
      }
      checks.push(result(d('controls-fixed'), KIND, status, `${ss ? `stick range ${fmt(ss.range, 2)} (median ${signed(med, 3)})` : 'stick not logged'}; ${es ? `elevator σ ${fmt(es.sd, 2)} ${elevInfo?.unit === 'ratio' ? '(ratio)' : '°'}` : 'elevator not logged'}`, 'pass: stick range ≤ 0.02 and elevator σ ≤ 0.1° (ratio 0.005); warn ≤ 0.05 and 0.3° (0.015) or a stick held off-centre; fail beyond', hint, pid))
    }

    // trim-fixed
    if (!trimCh) checks.push(notCheckable(d('trim-fixed'), KIND, pid))
    else {
      const range = summary(trimCh.values, a, b).range
      const step = largestChangeWithin(trimCh.values, time, a, b, 0.5)
      const status: CheckStatus = range <= 0.002 ? 'pass' : range <= 0.02 && step <= 0.02 ? 'warn' : 'fail'
      checks.push(result(d('trim-fixed'), KIND, status, `trim range ${fmt(range, 2)}, largest change in 0.5 s ${fmt(step, 2)}`, 'pass ≤ 0.002; warn ≤ 0.02 (auto-trim drift); fail > 0.02 or a step > 0.02 within 0.5 s', status === 'fail' ? (step > 0.02 ? 'Trim step inside the point: split it at the step or leave it out.' : 'The trim moved: re-cut or leave the point out.') : status === 'warn' ? 'An auto-trim drift: the mean trim still describes the point.' : '', pid))
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
      const status: CheckStatus = h < 500 || over ? 'warn' : 'pass'
      checks.push(result(d('envelope'), KIND, status, `lowest ${fix(h, 0)} ft AGL${lim.vmoKias || lim.mmo ? '' : '; speed limits not set'}`, '≥ 500 ft AGL; KIAS ≤ V_MO − 10 and M ≤ M_MO − 0.02 when set (never fails)', h < 500 ? 'Ground effect may change the downwash at the tail and the lift curve.' : over ? 'A set limit was exceeded.' : '', pid))
    }

    // weather
    if (!turb && !wind && !vwind) checks.push(notCheckable(d('weather'), KIND, pid))
    else {
      const tbm = turb ? summary(turb.values, a, b).max : NaN
      const wr = wind ? summary(wind.values, a, b).range : NaN
      const wv = vwind ? maxAbs(vwind.values, a, b) : NaN
      const ok = !(tbm > 0.01) && !(wr > 2) && !(wv > 50)
      checks.push(result(d('weather'), KIND, ok ? 'pass' : 'warn', `turbulence ${fmt(tbm, 2)}, wind range ${fmt(wr, 2)} kt, |vertical wind| ${fmt(wv, 2)} fpm`, 'turbulence ≤ 0.01, wind range ≤ 2 kt, |vertical wind| ≤ 50 fpm (never fails)', ok ? '' : 'Set calm weather for trim points.', pid))
    }

    // autopilot evidence (set check later)
    const pc = modeChannels.length ? null : pitchControlSource(ds, a, b)
    const modesChanged = modeChannels.some((c) => summary(c.values, a, b).range > 0)

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
      modesLogged: modeChannels.length > 0,
      modesChanged,
      astab: astab ? maxAbs(astab.values, a, b) : NaN,
      speedDrift,
    }
  })

  // ---- configuration-match (each point against the modal configuration of P)
  {
    const keys = ctxs.map((c) => c.configKey).filter((k): k is string => k !== null)
    const counts = new Map<string, number>()
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    const modal = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
    for (const c of ctxs) {
      const pid = { pointId: c.point.id }
      if (c.configKey === null || modal === null) {
        c.checks.push(notCheckable(d('configuration-match'), KIND, pid))
        continue
      }
      const modalValues = modal.split(',').map(Number)
      const same = c.configMeans.length === modalValues.length && c.configMeans.every((v, i) => Math.abs(v - modalValues[i]) <= 0.01 + 1e-9)
      const clean = modalValues.every((v) => Math.abs(v) <= 0.01)
      c.checks.push(result(d('configuration-match'), KIND, same ? 'pass' : 'fail', `${same ? 'same as the set' : 'differs from the set'} (${clean ? 'clean' : 'not clean'}: ${modal})`, 'every point within 0.01 of the set’s commonest configuration', same ? '' : 'Put it in its own group: each configuration is its own trim curve.', pid))
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
        c.checks.push(result(d('near-stall'), KIND, 'info', usable.includes(c) ? 'fewer than 3 points to draw the lift line' : 'not judged (the point is out on other checks)', 'lift-curve deficit ≤ 2 % and local slope ≥ 0.85 of the line', '', pid))
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
      c.checks.push(result(d('near-stall'), KIND, status, `lift deficit ${pct(deficit)}${Number.isFinite(slopeRatio) ? `, local slope ${fix(slopeRatio, 2)} of the line` : ''}${Number.isFinite(vsRatio) ? `, ${fix(vsRatio, 2)} V_S` : ''}`, 'pass: deficit ≤ 2 % and slope ≥ 0.85; info: approaching (2–3 %, 0.7–0.85); warn: > 3 % or < 0.7 (plot only)', status === 'warn' ? 'Plot only: leave it out of the linear fit, keep it on the plot and say why.' : status === 'info' ? 'Approaching the stall: watch the gradient’s curvature.' : '', pid))
    }
  }

  // ---- point verdicts
  const excludedByUser = new Set(settings.fitExcluded ?? [])
  const points: PointReport[] = ctxs.map((c) => {
    let status = preStatus(c)
    const reasons: string[] = []
    if (status === 'excluded') reasons.push(...c.checks.filter((k) => CRITICAL.has(k.id) && k.status === 'fail').map((k) => STATIC_REASON[k.id] ?? k.title.toLowerCase()))
    else if (status === 'cannot-confirm') reasons.push(...c.checks.filter((k) => CRITICAL.has(k.id) && k.status === 'not-checkable').map((k) => `${k.title.toLowerCase()}: not checkable`))
    else if (c.checks.some((k) => k.id === 'near-stall' && k.status === 'warn')) {
      status = 'plot-only'
      reasons.push('plot only (near the stall)')
    } else if (excludedByUser.has(c.point.id)) {
      status = 'left-out'
      reasons.push('left out by you')
    }
    return {
      pointId: c.point.id,
      name: c.point.name,
      groupId: c.point.groupId,
      status,
      label: POINT_LABEL[status],
      reasons,
      checks: c.checks,
      worst: worstStatus(c.checks.map((k) => k.status)),
    }
  })
  const U = ctxs.filter((_, i) => points[i].status === 'used')
  const set: Check[] = []

  // ---- trim-variable
  const yKind = yInfo.kind
  let deltaEq: StaticReport['deltaEq'] = null
  let equivalent: EquivalentElevator | null
  {
    const def0 = d('trim-variable')
    const cl = U.map((c) => c.x)
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
          `Y is ${yKind === 'combined' ? 'δ_eq (elevator and trim)' : yKind}; trim range over the used points ${fmt(dTrim, 2)}; elevator-only slope ${fmt(fe.c1, 3)} ± ${fmt(fe.seC1, 2)}, trim-only slope ${fmt(ft.c1, 3)} ± ${fmt(ft.seC1, 2)}; ${gText}${equivalent ? `; dδ_eq/dC_L ${fmt(equivalent.slope, 3)} ± ${fmt(equivalent.seSlope, 2)}` : ''}; trim type ${trimType ?? 'unknown'}${stableWithoutG ? '; stable sign holds without G' : ''}`,
          'pass: Y holds every pitch control that moved (δ_eq, or the elevator with a still trim or an elevator-trimmed aircraft); warn: the trim moved outside the plotted control (never fails: fixed with Plot δ_eq or the trim type)',
          hint,
        ),
      )
    }
  }

  // ---- cl-definition
  const clAxis = isClAxis(xCh)
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
        measured = `${xCh.derived ? `formula ${xCh.derived.expression}` : xCh.token}; largest difference from n·W/(q̄S) ${pct(worst)}${usesKias ? ' (uses KIAS)' : ''}`
        if (status === 'warn' || status === 'fail') hint = usesKias ? 'Use KEAS for the dynamic pressure, not KIAS.' : 'Check the weight, speed and area in the C_L definition.'
      }
      // Compared at the used points: with none, there is nothing to compare.
      if (status === 'not-checkable') set.push(notCheckable(def0, KIND, { needs: 'Needs used points' }))
      else set.push(result(def0, KIND, status, measured, 'pass: C_L from KEAS, total,___lb and S-ref, within 3 % of n·W/(q̄S) at every used point; warn 3–6 % or a speed axis; fail > 6 % or the maximum weight', hint))
    }
  }

  // ---- cl-range
  {
    const def0 = d('cl-range')
    const cls = U.map((c) => (clAxis ? c.x : c.clW)).filter(Number.isFinite).sort((u, v) => u - v)
    if (!clAxis && !U.some((c) => Number.isFinite(c.clW))) set.push(notCheckable(def0, KIND))
    else {
      const n = U.length
      const ratio = cls.length ? cls[cls.length - 1] / cls[0] : NaN
      const span = cls.length ? cls[cls.length - 1] - cls[0] : NaN
      let gap = 0
      for (let i = 1; i < cls.length; i += 1) gap = Math.max(gap, cls[i] - cls[i - 1])
      const gapShare = span > 0 ? gap / span : NaN
      const status: CheckStatus = n < 3 || !(ratio >= 1.3) ? 'fail' : n >= 5 && ratio >= 1.8 && !(gapShare > 0.4) ? 'pass' : 'warn'
      set.push(result(def0, KIND, status, `${n} used points, C_L ${fmt(cls[0], 3)}–${fmt(cls[cls.length - 1], 3)} (ratio ${fix(ratio, 2)}), largest gap ${pct(gapShare, 0)} of the span`, 'pass: ≥ 5 points, C_L ratio ≥ 1.8, largest gap ≤ 40 %; warn 3–4 points, ratio 1.3–1.8 or a gap > 40 %; fail < 3 points or ratio < 1.3', status === 'pass' ? '' : status === 'fail' ? 'Fly more trim points over a wider speed range.' : 'More points, spread more evenly, would firm up the gradient.'))
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
      set.push(result(def0, KIND, status, `M_max ${fix(mMax, 3)}${fast.length ? ` (at or above 0.6: ${fast.join(', ')})` : ''}`, 'pass M_max < 0.6 (and < M_MO − 0.02 when set); warn otherwise (never fails)', status === 'warn' ? 'Compare the gradient with and without the points at or above M 0.6.' : ''))
    }
  }

  // ---- thrust-method (over U)
  const methodU = methodOver(U.map((c) => ({ a: c.a, b: c.b })))
  {
    const def0 = d('thrust-method')
    if (methodU.kind === 'unknown') set.push(notCheckable(def0, KIND, U.length ? {} : { needs: 'Needs two or more used points' }))
    else if (U.length < 2 && methodU.kind !== 'zero-thrust') {
      // Constant power or power for level flight is a comparison between points: one point cannot tell them apart.
      set.push(notCheckable(def0, KIND, { needs: 'Needs two or more used points' }))
    } else {
      const status: CheckStatus = methodU.kind === 'power-for-level' ? 'warn' : 'pass'
      set.push(result(def0, KIND, status, `${METHOD_NAME[methodU.kind]} (${methodU.detail})`, 'pass: zero thrust (the lecture’s X-Plane procedure) or constant power (Cook; NATO); warn: power for level flight (labelled, never failed)', status === 'warn' ? 'Power-on, level-flight trim curve: the thrust moment changes with C_L and is in the gradient; label it power-on and discuss.' : ''))
    }
  }

  // ---- cg-lines
  const cgInfo = cgLines(U, input.groups, settings, clAxis)
  {
    const def0 = d('cg-lines')
    if (!cg) set.push(notCheckable(def0, KIND))
    else set.push(result(def0, KIND, cgInfo.status, cgInfo.measured, 'pass: 3 or more CG lines with ≥ 3 used points each (neutral point by extrapolation); warn: 2 lines or a fuel-burn drift > 25 % of the spacing; info: 1 line (gradient and sign only)', cgInfo.hint))
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
      let status: CheckStatus
      let measured: string
      let hint = ''
      if (logged) {
        status = changed.length ? 'warn' : 'pass'
        measured = changed.length ? `modes logged; a mode changed inside ${changed.join(', ')}` : 'modes logged and constant in every point'
      } else if (declaredAll || allNoted) {
        status = 'pass'
        measured = declaredAll ? `declared: autopilot ${settings.declared?.autopilot}${settings.declared?.modes ? ` (${settings.declared.modes})` : ''}` : 'the modes are written in every point’s note'
      } else {
        status = 'warn'
        const counts = (['autopilot', 'pilot', 'hands-off', 'unknown'] as PitchSource[]).map((s) => [s, inferred.filter((c) => c.pitch === s).length] as const).filter(([, k]) => k > 0)
        measured = `inferred from the surface, stick and servo: ${counts.map(([s, k]) => `${s} ${k}`).join(', ')}${atLike.length ? `; autothrottle-like levers at ${atLike.join(', ')}` : ''}`
        hint = autopilotHeld ? `The autopilot held pitch in ${autopilotHeld} points (inferred): write the modes (e.g. HDG + V/S, A/T off) in the point notes or log row 117.` : 'Write the modes in the point notes or log row 117.'
      }
      set.push(result(def0, KIND, status, measured, 'pass: modes logged and constant, or declared for every point; warn: only inferred, or a mode change inside a point (never fails; whether autopilot-held trims are accepted is open item N1)', hint))
    }
  }

  // ---- pitch-augmentation
  {
    const def0 = d('pitch-augmentation')
    if (!astab) set.push(notCheckable(def0, KIND))
    else {
      const worst = Math.max(0, ...ctxs.map((c) => c.astab).filter(Number.isFinite))
      const status: CheckStatus = worst <= 1e-4 ? 'pass' : 'warn'
      set.push(result(def0, KIND, status, `max |_elev,astab| ${fmt(worst, 2)}`, '≤ 1e−4 in every point (never fails)', status === 'warn' ? 'Pitch augmentation active: the gradient describes the aircraft with its augmentation.' : ''))
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
      set.push(result(def0, KIND, 'info', `${fmt(lf.c1, 3)} ± ${fmt(lf.seC1, 2)} ${unit} (t ${fix(t, 1)}, R² ${fix(lf.r2, 3)}, n ${U.length}): ${label}${Math.abs(tCurve) >= 3 ? '; curved, as power effects produce: quote a mean or local gradient' : ''}${odd.length ? `; inconsistent: ${odd.join(', ')}` : ''}; ${METHOD_NAME[methodU.kind]}, ${cgInfo.lines} CG line${cgInfo.lines === 1 ? '' : 's'}, stick-fixed, X-Plane model`, 'report only: stable (stable sign, |t| ≥ 3), cannot be told apart from neutral (|t| < 3), unstable (other sign, |t| ≥ 3)'))
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
  const verdict = staticVerdict(points, set, U.length, ctxs.length, settings.fitUsedOnly === true, recut)
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
  'configuration-match': 'another configuration',
}

export const POINT_LABEL: Readonly<Record<PointStatus, string>> = {
  used: 'Use',
  correct: 'Correct',
  'plot-only': 'Plot only',
  excluded: 'Retest',
  'cannot-confirm': 'Cannot confirm',
  'left-out': 'Left out',
}

/** Per-point warnings, one line per check: "Speed held steady: warn at 210 KIAS, 190 KIAS". */
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

/** "M left out (power changed inside: 300 KIAS, 240 KIAS; near the stall: 170 KIAS)". */
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
): Verdict {
  if (total === 0) return { kind: 'no-data', text: 'No test points to judge: save trim points (Find steady points) and plot them.' }
  const cannot = points.filter((p) => p.status === 'cannot-confirm')
  const naRows = rowsFromNotCheckable([
    ...set.filter((c) => (c.severity === 'critical' || c.severity === 'analysis') && c.status === 'not-checkable'),
    ...cannot.flatMap((p) => p.checks.filter((c) => c.severity === 'critical')),
  ])
  const cannotText = `Cannot confirm — ${naRows.length ? `tick rows ${naRows.join(', ')}` : 'some checks need rows the log does not have'}`
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
  const clRange = set.find((c) => c.id === 'cl-range')
  if (clRange?.status === 'fail') return { kind: 'retest', text: `Retest required — the C_L range is too narrow: fly a wider speed range${also}` }
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
  'zero-thrust': 'zero thrust',
  'constant-power': 'constant power',
  'power-for-level': 'power for level flight',
  unknown: 'thrust method unknown',
}

function thrustMethod(
  pts: readonly { a: number; b: number }[],
  levers: readonly Channel[],
  n1s: readonly Channel[],
  thrusts: readonly Channel[],
  powers: readonly Channel[],
): { kind: MethodKind; detail: string } {
  if (!pts.length) return { kind: 'unknown', detail: 'no points' }
  const means = (chs: readonly Channel[], agg: 'max' | 'sum') =>
    pts.map(({ a, b }) => {
      const vals = chs.map((c) => summary(c.values, a, b).mean)
      return agg === 'max' ? Math.max(...vals) : vals.reduce((s, v) => s + v, 0)
    })
  const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
  if (levers.length) {
    const lv = means(levers, 'max')
    const n1 = n1s.length ? means(n1s, 'max') : null
    if (lv.every((v) => v <= 0.05)) return { kind: 'zero-thrust', detail: `every lever ≤ 0.05` }
    if (range(lv) <= 0.02 && (!n1 || range(n1) <= 2)) return { kind: 'constant-power', detail: `lever range ${fmt(range(lv), 2)}` }
    return { kind: 'power-for-level', detail: `levers ${fmt(Math.min(...lv), 3)}–${fmt(Math.max(...lv), 3)}` }
  }
  if (n1s.length) {
    const n1 = means(n1s, 'max')
    if (range(n1) <= 2) return { kind: 'constant-power', detail: `N1 range ${fix(range(n1), 2)} %pt (no lever row)` }
  }
  const force = powers.length ? powers : thrusts
  if (force.length) {
    const f = means(force, 'sum')
    const mean = f.reduce((s, v) => s + v, 0) / f.length
    const rel = range(f) / Math.abs(mean)
    return rel <= 0.04
      ? { kind: 'constant-power', detail: `${powers.length ? 'engine power' : 'thrust'} range ${pct(rel)} (no lever row)` }
      : { kind: 'power-for-level', detail: `${powers.length ? 'engine power' : 'thrust'} range ${pct(rel)} (no lever row)` }
  }
  return { kind: 'unknown', detail: 'no lever, N1, thrust or power row' }
}

function cgLines(U: readonly PointCtx[], groups: readonly PointGroup[], settings: TrimCheckSettings, clAxis: boolean) {
  const mac = settings.macFt && settings.macFt > 0 ? settings.macFt : null
  const lemac = Number.isFinite(settings.lemacFt) ? (settings.lemacFt as number) : null
  const pctMac = (cg: number) => (mac !== null && lemac !== null ? (100 * (cg - lemac)) / mac : NaN)
  const pts = U.filter((c) => Number.isFinite(c.cg))
  if (!pts.length) return { status: 'info' as CheckStatus, measured: 'no CG values', hint: '', lines: 0, hn: NaN, seHn: NaN }
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
    return { status: 'info' as CheckStatus, measured: `1 CG line (${lineText}), fuel-burn drift ${fmt(spread(pts), 2)} ft`, hint: 'One CG: the gradient and its sign only; no flight-test neutral point or static margin (open item N3).', lines: n, hn: NaN, seHn: NaN }
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
  let hint = n === 2 ? 'A line through two points has no check: add a third CG position.' : ''
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
  }
}
