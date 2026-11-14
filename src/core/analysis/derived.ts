// Derived channels: evaluating the workspace's formulas onto a dataset, and ready-made presets.
// OWNER: analysis agent. Public API below is a contract; keep these signatures.

import type { Channel, Dataset, DerivedDef } from '../types'
import { channelAlias, makeResolver } from '../channels/alias'
import { computeStats } from '../dataset'
import { UnknownNameError, compileExpression, isExprConstant } from './expr'

/**
 * Returns a NEW Dataset object whose channels are the file channels of `ds` (any existing derived channels dropped)
 * followed by one channel per def, evaluated in order (a def may use earlier defs by their slug). A def that fails is
 * skipped and reported in `errors`; the rest still evaluate. Derived channels get id def.id ("fx:<slug>"),
 * token '', occurrence 1, column −1, meta { label: name, short: name, unit, quantity: 'other', group: 'derived',
 * known: false }, stats computed, and `derived: { expression }`.
 */
export function withDerived(
  ds: Dataset,
  defs: readonly DerivedDef[],
): { dataset: Dataset; errors: { id: string; message: string }[] } {
  const channels: Channel[] = ds.channels.filter((ch) => !ch.derived)
  const ids = new Set(channels.map((ch) => ch.id))
  const errors: { id: string; message: string }[] = []
  for (const def of defs) {
    try {
      if (!/^fx:./.test(def.id)) throw new Error(`A formula channel id must look like "fx:<name>" (got "${def.id}").`)
      if (ids.has(def.id)) throw new Error(`Another channel already has the id "${def.id}".`)
      // The resolver sees the file channels plus the formulas evaluated so far (by their slug).
      const resolve = makeResolver({ ...ds, channels })
      const values = compileExpression(def.expression).evaluate({ rowCount: ds.rowCount, time: ds.elapsed, resolve })
      channels.push({
        id: def.id,
        token: '',
        occurrence: 1,
        column: -1,
        meta: { label: def.name, short: def.name, unit: def.unit, quantity: 'other', group: 'derived', known: false },
        values,
        stats: computeStats(values),
        derived: { expression: def.expression },
      })
      ids.add(def.id)
    } catch (error) {
      errors.push({ id: def.id, message: describeError(error, channels) })
    }
  }
  return { dataset: { ...ds, channels }, errors }
}

/** The error's message, with a "did you mean" hint for a misspelt channel alias. */
function describeError(error: unknown, channels: readonly Channel[]): string {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof UnknownNameError)) return error.message
  const suggestion = closestAlias(error.ref, channels.map(channelAlias))
  return suggestion ? `${error.message} Did you mean ${suggestion}?` : error.message
}

function closestAlias(name: string, aliases: readonly string[]): string | null {
  const target = name.toLowerCase()
  let best: string | null = null
  let bestDistance = Infinity
  for (const alias of aliases) {
    const d = editDistance(target, alias.toLowerCase())
    if (d < bestDistance) {
      best = alias
      bestDistance = d
    }
  }
  // Allow roughly one typo per four characters.
  return best !== null && bestDistance <= Math.max(1, Math.floor(name.length / 4)) ? best : null
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

const GREEK: Record<string, string> = {
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  Δ: 'delta',
  ε: 'epsilon',
  ζ: 'zeta',
  η: 'eta',
  θ: 'theta',
  λ: 'lambda',
  μ: 'mu',
  ν: 'nu',
  π: 'pi',
  ρ: 'rho',
  σ: 'sigma',
  τ: 'tau',
  φ: 'phi',
  ψ: 'psi',
  ω: 'omega',
  Ω: 'omega',
}

/**
 * "Power required" -> "power_required" (a formula-safe identifier; never empty, never starts with a digit).
 * Lower case letters, digits and single underscores; accents dropped and Greek letters spelt out ("W/δ" -> "w_delta").
 * Prefixed with "f_" when it would start with a digit or clash with a formula constant (pi, e, g0, t, ...).
 */
export function slugify(name: string): string {
  let slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[α-ωΑ-Ω]/g, (ch) => ` ${GREEK[ch] ?? GREEK[ch.toLowerCase()] ?? ''} `)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!slug) slug = 'formula'
  if (/^[0-9]/.test(slug) || isExprConstant(slug)) slug = `f_${slug}`
  return slug
}

export interface DerivedPreset {
  id: string
  name: string
  unit: string
  expression: string
  description: string
  /** Channel aliases the expression needs; the preset is offered only when all exist */
  requires: string[]
}

// Aliases of the X-Plane 12 Data Output channels the presets use (channels/alias.ts aliasForToken of the token).
const KEAS = 'Vind_keas' // "_Vind,_keas"  equivalent airspeed, kt
const KTAS = 'Vtrue_ktas' // "Vtrue,_ktas" true airspeed, kt
const KTGS = 'Vtrue_ktgs' // "Vtrue,_ktgs" ground speed, kt
const VVI = 'VVI_fpm' // "__VVI,__fpm" vertical speed, ft/min
const NZ = 'Gload_norml' // "Gload,norml" normal load factor
const WEIGHT = 'total_lb' // "total,___lb" current total weight (empty + payload + fuel), lb
const SREF = 'S_ref_ft_ft' // "S-ref,ft*ft" reference wing area, ft²
const LIFT = 'lift_lb' // "_lift,___lb" total aerodynamic lift, lb
const DRAG = 'drag_lb' // "_drag,___lb" total aerodynamic drag, lb
const PALT = 'p_alt_ftMSL' // "p-alt,ftMSL" pressure altitude, ft
const MAX_ENGINES = 16
const thrustAlias = (k: number) => `thrst_${k}_lb` // "thrst,_1,lb"
const fuelFlowAlias = (k: number) => `FF_${k}_lb_h` // "FF__1,_lb/h"

// Expression fragments (SI inside, converted at the end).
const Q_PA = `0.5 * rho0 * (${KEAS} * kt2ms)^2`
const QS_N = `(${Q_PA} * ${SREF} * ft2m^2)`
/** TAS in m/s, bare (for function arguments) and parenthesised (inside products and quotients). */
const V_MS_BARE = `${KTAS} * kt2ms`
const V_MS = `(${V_MS_BARE})`
// ISA pressure ratio from pressure altitude (troposphere below 36 089 ft, isothermal layer above, to 65 617 ft).
const DELTA =
  `(${PALT} <= 36089.24 ? (1 - 6.8755856e-6 * ${PALT})^5.2558797 ` +
  `: 0.22336 * exp(-4.80634e-5 * (${PALT} - 36089.24)))`

function sum(aliases: readonly string[]): string {
  return aliases.length === 1 ? aliases[0] : `(${aliases.join(' + ')})`
}

/**
 * Useful flight-test quantities built from standard X-Plane channels, e.g. total thrust, total fuel flow,
 * dynamic pressure from KEAS, CL from weight and dynamic pressure (level flight), power required = drag × TAS,
 * specific excess power, flight-path angle from VVI and TAS, energy height, L/D from lift and drag, Mach-corrected...
 * Only presets whose `requires` are all present in the dataset are returned.
 *
 * Multi-engine sums use every "thrst,_N,lb" / "FF__N,_lb/h" channel present (N = 1..16). Each description states the
 * physics and assumptions; constants are the formula language's (exact unit conversions, ISA ρ0 and g0).
 */
export function availablePresets(ds: Dataset): DerivedPreset[] {
  const resolve = makeResolver(ds)
  const has = (alias: string) => resolve(alias) !== undefined
  const engines = (alias: (k: number) => string) =>
    Array.from({ length: MAX_ENGINES }, (_, i) => alias(i + 1)).filter(has)
  const thrusts = engines(thrustAlias)
  const fuelFlows = engines(fuelFlowAlias)
  const thrust = sum(thrusts)
  const fuelFlow = sum(fuelFlows)
  const engineCount = (n: number) => (n === 1 ? 'the engine' : `all ${n} engines`)
  // dh/dt (m/s) for the energy presets. X-Plane's VVI is the *indicated* vertical speed: it lags the true climb rate
  // (instrument lag, large errors in a pull-up), so the rate of change of pressure altitude is preferred — lag-free,
  // and consistent with energy height. (vY is not used: it is in X-Plane's flat local frame and drifts away from the
  // scenery origin.)
  const climb = has(PALT)
    ? { expr: `diff(${PALT} * ft2m)`, requires: [PALT], source: 'dh/dt from the rate of change of pressure altitude' }
    : {
        expr: `${VVI} * fpm2ms`,
        requires: [VVI],
        source: "dh/dt from VVI (X-Plane's indicated vertical speed lags: accurate in steady flight only)",
      }

  const presets: Omit<DerivedPreset, 'id'>[] = []
  const add = (preset: Omit<DerivedPreset, 'id'>, available = true) => {
    if (available && preset.requires.length > 0 && preset.requires.every(has)) presets.push(preset)
  }

  add(
    {
      name: 'Total thrust',
      unit: 'lb',
      expression: thrusts.join(' + '),
      description: `Sum of the net thrust of ${engineCount(thrusts.length)} (X-Plane "thrst" outputs).`,
      requires: thrusts,
    },
    thrusts.length >= 2,
  )
  add(
    {
      name: 'Total fuel flow',
      unit: 'lb/h',
      expression: fuelFlows.join(' + '),
      description: `Sum of the fuel flow of ${engineCount(fuelFlows.length)}.`,
      requires: fuelFlows,
    },
    fuelFlows.length >= 2,
  )
  add({
    name: 'Dynamic pressure (Pa)',
    unit: 'Pa',
    expression: Q_PA,
    description:
      'q = ½·ρ0·V_EAS² from equivalent airspeed, which equals ½·ρ·V_TAS² exactly by the definition of EAS ' +
      '(ρ0 = 1.225 kg/m³). This is the q of CL and CD; at high Mach it is less than the pitot impact pressure.',
    requires: [KEAS],
  })
  add({
    name: 'Dynamic pressure (lb/ft²)',
    unit: 'lb/ft²',
    expression: `${Q_PA} * ft2m^2 / lb2n`,
    description: 'q = ½·ρ0·V_EAS² from equivalent airspeed, in pounds per square foot (1 lb/ft² = 47.88 Pa).',
    requires: [KEAS],
  })
  add({
    name: 'CL from weight',
    unit: '',
    expression: `${NZ} * ${WEIGHT} * lb2n / ${QS_N}`,
    description:
      'Lift coefficient CL = n·W / (q·S): lift taken as normal load factor × total weight, q from KEAS, S = S-ref. ' +
      'Assumes the thrust component normal to the flight path is negligible (small α, thrust line near the ' +
      'flight path); in steady level flight n ≈ 1.',
    requires: [NZ, WEIGHT, KEAS, SREF],
  })
  add({
    name: 'CD from drag',
    unit: '',
    expression: `${DRAG} * lb2n / ${QS_N}`,
    description:
      "Drag coefficient CD = D / (q·S) from X-Plane's total aerodynamic drag force, q from KEAS, S = S-ref.",
    requires: [DRAG, KEAS, SREF],
  })
  add(
    {
      name: 'CD from thrust',
      unit: '',
      expression:
        `(${thrusts.join(' + ')} - ${WEIGHT} * (${climb.expr} / ${V_MS} + diff(${V_MS_BARE}) / g0)) ` +
        `* lb2n / ${QS_N}`,
      description:
        'Flight-test drag polar by the energy method: D = T − W·(sin γ + (dV/dt)/g), with sin γ = (dh/dt)/V_TAS ' +
        `(${climb.source}) and dV/dt from TAS, then CD = D/(q·S). In steady level flight this is simply T/(q·S). ` +
        `Assumes the thrust acts along the flight path (small α + thrust-line angle); total thrust of ` +
        `${engineCount(thrusts.length)}.`,
      requires: [...thrusts, WEIGHT, ...climb.requires, KTAS, KEAS, SREF],
    },
    thrusts.length > 0,
  )
  add({
    name: 'Lift to drag ratio',
    unit: '',
    expression: `${LIFT} / ${DRAG}`,
    description: "L/D from X-Plane's total aerodynamic lift and drag forces (compare __L/D,_aero).",
    requires: [LIFT, DRAG],
  })
  add({
    name: 'Power required (kW)',
    unit: 'kW',
    expression: `${DRAG} * lb2n * ${V_MS} / 1000`,
    description:
      'Aerodynamic power required P = D·V_TAS. In steady, level, unaccelerated flight it equals the thrust ' +
      'power the engines must supply.',
    requires: [DRAG, KTAS],
  })
  add({
    name: 'Power required (hp)',
    unit: 'hp',
    expression: `${DRAG} * lb2n * ${V_MS} / hp2w`,
    description: 'Aerodynamic power required P = D·V_TAS in horsepower (1 hp = 745.7 W).',
    requires: [DRAG, KTAS],
  })
  add(
    {
      name: 'Thrust power (kW)',
      unit: 'kW',
      expression: `${thrust} * lb2n * ${V_MS} / 1000`,
      description:
        `Thrust power (power available) P = T·V_TAS with the total thrust of ${engineCount(thrusts.length)}; ` +
        'thrust assumed along the flight path.',
      requires: [...thrusts, KTAS],
    },
    thrusts.length > 0,
  )
  add(
    {
      name: 'Thrust power (hp)',
      unit: 'hp',
      expression: `${thrust} * lb2n * ${V_MS} / hp2w`,
      description: 'Thrust power P = T·V_TAS in horsepower (1 hp = 745.7 W); thrust assumed along the flight path.',
      requires: [...thrusts, KTAS],
    },
    thrusts.length > 0,
  )
  add({
    name: 'Specific excess power',
    unit: 'm/s',
    expression: `${climb.expr} + ${V_MS} / g0 * diff(${V_MS_BARE})`,
    description:
      `Ps = dh/dt + (V/g)·dV/dt, the rate of change of energy height (= (T − D)·V/W), with ${climb.source} and ` +
      'dV/dt from TAS. Wrap it in smooth(…, 1) if the data are noisy.',
    requires: [...climb.requires, KTAS],
  })
  add({
    name: 'Energy height',
    unit: 'ft',
    expression: `${PALT} + ${V_MS}^2 / (2 * g0) / ft2m`,
    description:
      'Specific energy h_E = h + V_TAS²/(2g): pressure altitude plus kinetic energy per unit weight. Its rate of ' +
      'change is the specific excess power.',
    requires: [PALT, KTAS],
  })
  add({
    name: 'Flight-path angle',
    unit: 'deg',
    expression: `deg(asin(${VVI} * fpm2ms / ${V_MS}))`,
    description:
      'γ = asin(VVI / V_TAS): climb angle relative to the air (no vertical wind assumed); NaN where TAS is too ' +
      "low for the climb rate. X-Plane's VVI is the indicated vertical speed and lags, so use it in " +
      'steady climbs and descents (for manoeuvres: deg(asin(diff(p_alt_ftMSL * ft2m) / (Vtrue_ktas * kt2ms)))). ' +
      'X-Plane also logs the inertial flight-path angle as vpath,__deg.',
    requires: [VVI, KTAS],
  })
  add(
    {
      name: 'Specific range',
      unit: 'nm/lb',
      expression: `${KTGS} / ${fuelFlow}`,
      description:
        'Ground distance per pound of fuel = ground speed / total fuel flow. Includes the effect of wind; ' +
        'meaningful in steady cruise.',
      requires: [KTGS, ...fuelFlows],
    },
    fuelFlows.length > 0,
  )
  add(
    {
      name: 'Specific air range',
      unit: 'nm/lb',
      expression: `${KTAS} / ${fuelFlow}`,
      description:
        'Air distance per pound of fuel = TAS / total fuel flow: independent of wind, the usual cruise-performance ' +
        'measure (maximise for range).',
      requires: [KTAS, ...fuelFlows],
    },
    fuelFlows.length > 0,
  )
  add(
    {
      name: 'Specific endurance',
      unit: 'h/1000 lb',
      expression: `1000 / ${fuelFlow}`,
      description:
        'Hours of flight per 1000 lb of fuel = 1000 / total fuel flow (maximise for endurance / loiter). ' +
        'Meaningful in steady flight.',
      requires: fuelFlows,
    },
    fuelFlows.length > 0,
  )
  add(
    {
      name: 'Fuel used',
      unit: 'lb',
      expression: `integ(${fuelFlows.join(' + ')}) / 3600`,
      description:
        'Fuel burned since the first row: total fuel flow (lb/h) integrated over elapsed time (trapezoid rule), ' +
        '÷ 3600. Sim resets and recording gaps add nothing.',
      requires: fuelFlows,
    },
    fuelFlows.length > 0,
  )
  add({
    name: 'Pressure ratio δ',
    unit: '',
    expression: DELTA,
    description:
      'δ = p/p0 from pressure altitude by the ISA model (exact for pressure altitude; valid to 65 617 ft). ' +
      'Used to reduce performance data to standard conditions (e.g. W/δ, FF/δ).',
    requires: [PALT],
  })
  add({
    name: 'W/δ',
    unit: 'lb',
    expression: `${WEIGHT} / ${DELTA}`,
    description:
      'Weight over pressure ratio, the jet cruise-performance parameter: at a given Mach number, CL depends only ' +
      'on W/δ (Mach–W/δ data reduction).',
    requires: [WEIGHT, PALT],
  })

  return presets.map((preset) => ({ id: slugify(preset.name), ...preset }))
}
