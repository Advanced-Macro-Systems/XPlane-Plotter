// Ready-made X–Y plots for the coursework: lift curve, drag polar, static stability (elevator to trim against CL),
// performance curves against true airspeed (with range and endurance), and the ground track. Channels are looked up
// by X-Plane token (never by label); a preset is offered only when its channels exist in the file. Each preset sets a
// complete XYConfig. A preset may plot a formula channel (total engine power, total thrust) that the file does not have
// yet: it then names the formula, and choosing it makes the channel first (store saveDerived, see the sidebar).

import { availablePresets as formulaPresets } from '../../core/analysis/derived'
import { channelById } from '../../core/dataset'
import type { Dataset, Workspace, XYConfig } from '../../core/types'
import { MAX_Y } from './xyModel'

export interface XYPreset {
  id: string
  name: string
  /** One line under the name: what the plot is for */
  hint: string
  section: 'Aerodynamics' | 'Stability' | 'Performance' | 'Navigation'
}

/** A formula channel a preset plots, to be made when it is chosen (the file has no channel for it yet). */
export interface PresetFormula {
  name: string
  unit: string
  expression: string
  /** The channel id becomes "fx:<slug>" (or "fx:<slug>_2" ... when that is taken) */
  slug: string
  /** The id standing for the channel in the preset's config.ys until it exists */
  placeholder: string
}

export interface ResolvedPreset extends XYPreset {
  config: XYConfig
  /** Set when config.ys plots a formula channel that must be made first (its placeholder id is in config.ys) */
  formula?: PresetFormula
}

/** Elevator deflection in degrees, else the elevator surface ratio, else the elevator trim. */
const ELEVATOR = ['elev1,__deg', '_elev,_surf', '_trim,_elev']
const ALPHA = 'alpha,__deg'
const CL = '___cl,total'
const CD = '___cd,total'
const LD = '__L/D,_aero'
const KIAS = '_Vind,_kias'
const KTAS = 'Vtrue,_ktas'
const DRAG = '_drag,___lb'
const VVI = '__VVI,__fpm'
const LAT = '__lat,__deg'
const LON = '__lon,__deg'
/** Per-engine thrust and fuel flow ("thrst,_1,lb", "FF__1,_lb/h" ...), engines 1..8 */
const THRUST = Array.from({ length: 8 }, (_, i) => `thrst,_${i + 1},lb`)
const FUEL_FLOW = Array.from({ length: 8 }, (_, i) => `FF__${i + 1},_lb/h`)
/** Per-engine power in hp: X-Plane 12 "engn1,___hp" ..., else the X-Plane 8–11 "power,_1,hp" ... */
const ENGINE_POWER = Array.from({ length: 8 }, (_, i) => `engn${i + 1},___hp`)
const LEGACY_POWER = Array.from({ length: 8 }, (_, i) => `power,_${i + 1},hp`)

interface BuildContext {
  has: (id: string) => boolean
  /** The file has visible test points */
  withPoints: boolean
  /**
   * The channel id of the file's formula preset `name` (core/analysis/derived, e.g. "Total thrust"): the formula
   * channel when the file has one with its expression, else a placeholder for the channel to make; null when the file
   * lacks its inputs.
   */
  formula: (name: string) => string | null
}

interface PresetSpec extends XYPreset {
  /** null when the file lacks a channel the preset needs */
  build(ctx: BuildContext): Partial<XYConfig> | null
}

const first = (has: (id: string) => boolean, ids: readonly string[]): string | null => ids.find(has) ?? null

/** Steady test points when the file has them (means, fits through them), else every row. */
function steadySource(withPoints: boolean): Partial<XYConfig> {
  return withPoints
    ? { source: 'points', colorBy: 'group', fitTarget: 'means', showMeans: true }
    : { source: 'all', colorBy: 'series', fitTarget: 'samples' }
}

/**
 * Range and endurance: the steady level test points (the means, one fit through every visible group pooled), the
 * physical model, the constructions and axes from zero. Without test points yet the plot says so and shows every row,
 * and switches to the points as soon as there are some.
 */
function rangeEndurance(y: string, fit: 'power-model' | 'drag-model'): Partial<XYConfig> {
  return {
    x: KTAS,
    ys: [y],
    source: 'points',
    colorBy: 'series',
    fitTarget: 'means',
    showMeans: true,
    fit,
    rangeEndurance: true,
    axesFromZero: true,
  }
}

const SPECS: PresetSpec[] = [
  {
    id: 'lift-curve',
    name: 'Lift curve (CL vs α)',
    hint: 'Lift coefficient against angle of attack, with a linear fit for the lift-curve slope.',
    section: 'Aerodynamics',
    build: ({ has, withPoints }) =>
      has(ALPHA) && has(CL) ? { x: ALPHA, ys: [CL], fit: 'linear', ...steadySource(withPoints) } : null,
  },
  {
    id: 'drag-polar',
    name: 'Drag polar (CL vs CD)',
    hint: 'Lift coefficient against drag coefficient.',
    section: 'Aerodynamics',
    build: ({ has, withPoints }) => (has(CD) && has(CL) ? { x: CD, ys: [CL], ...steadySource(withPoints) } : null),
  },
  {
    id: 'lift-to-drag',
    name: 'L/D vs CL',
    hint: 'Lift-to-drag ratio against lift coefficient: the best L/D and the CL it needs.',
    section: 'Aerodynamics',
    build: ({ has, withPoints }) => (has(CL) && has(LD) ? { x: CL, ys: [LD], ...steadySource(withPoints) } : null),
  },
  {
    id: 'static-stability',
    name: 'Static stability: elevator to trim vs CL',
    hint: 'Elevator angle to trim against CL through the trim-point means; the slope gives the stick-fixed margin.',
    section: 'Stability',
    build: ({ has, withPoints }) => {
      const elevator = first(has, ELEVATOR)
      return has(CL) && elevator ? { x: CL, ys: [elevator], fit: 'linear', ...steadySource(withPoints) } : null
    },
  },
  {
    id: 'trim-curve',
    name: 'Elevator vs KIAS',
    hint: 'The trim curve: elevator angle to trim against indicated airspeed.',
    section: 'Stability',
    build: ({ has, withPoints }) => {
      const elevator = first(has, ELEVATOR)
      return has(KIAS) && elevator ? { x: KIAS, ys: [elevator], ...steadySource(withPoints) } : null
    },
  },
  {
    id: 'range-endurance-prop',
    name: 'Range & endurance — propeller (engine power vs TAS)',
    hint:
      'Engine power against true airspeed through steady level test points, power model fit: the minimum is the ' +
      'speed for maximum endurance, the tangent from the origin the speed for maximum range.',
    section: 'Performance',
    build: ({ has, formula }) => {
      if (!has(KTAS)) return null
      const engines = ENGINE_POWER.filter(has).length ? ENGINE_POWER.filter(has) : LEGACY_POWER.filter(has)
      const power = engines.length > 1 ? formula('Total engine power') : (engines[0] ?? null)
      return power ? rangeEndurance(power, 'power-model') : null
    },
  },
  {
    id: 'range-endurance-jet',
    name: 'Range & endurance — jet (thrust vs TAS)',
    hint:
      'Total thrust (or drag) against true airspeed through steady level test points, drag model fit: the minimum ' +
      'is the speed for maximum endurance, the tangent from the origin the speed for maximum range.',
    section: 'Performance',
    build: ({ has, formula }) => {
      if (!has(KTAS)) return null
      const engines = THRUST.filter(has)
      const thrust = engines.length > 1 ? formula('Total thrust') : (engines[0] ?? (has(DRAG) ? DRAG : null))
      return thrust ? rangeEndurance(thrust, 'drag-model') : null
    },
  },
  {
    id: 'thrust-drag',
    name: 'Thrust & drag vs KTAS',
    hint: 'Drag (and engine thrust, same unit) against true airspeed: thrust required and available.',
    section: 'Performance',
    build: ({ has, withPoints }) => {
      if (!has(KTAS) || !has(DRAG)) return null
      return { x: KTAS, ys: [DRAG, ...THRUST.filter(has)].slice(0, MAX_Y), ...steadySource(withPoints), colorBy: 'series' }
    },
  },
  {
    id: 'fuel-flow',
    name: 'Fuel flow vs KTAS',
    hint: 'Fuel flow per engine against true airspeed, for range and endurance.',
    section: 'Performance',
    build: ({ has, withPoints }) => {
      const flows = FUEL_FLOW.filter(has)
      if (!has(KTAS) || !flows.length) return null
      return { x: KTAS, ys: flows.slice(0, MAX_Y), ...steadySource(withPoints), colorBy: 'series' }
    },
  },
  {
    id: 'rate-of-climb',
    name: 'Rate of climb vs KTAS',
    hint: 'Vertical speed against true airspeed.',
    section: 'Performance',
    build: ({ has, withPoints }) => (has(KTAS) && has(VVI) ? { x: KTAS, ys: [VVI], ...steadySource(withPoints) } : null),
  },
  {
    id: 'ground-track',
    name: 'Ground track (lat vs lon, lines)',
    hint: 'Latitude against longitude drawn as a line through the whole log.',
    section: 'Navigation',
    build: ({ has }) =>
      has(LAT) && has(LON)
        ? { x: LON, ys: [LAT], source: 'all', style: 'lines', colorBy: 'series', fitTarget: 'samples', showMeans: false }
        : null,
  },
]

/** Formula text compared without spaces (the file's own channel may be spaced differently). */
const squeeze = (expression: string) => expression.replace(/\s+/g, '')

/**
 * The presets this file supports, each resolved to a full XYConfig. The test-point group filter is kept (it is a
 * choice of data, not of plot); labels go back to their defaults, and range and endurance and axes from zero are off
 * unless the preset turns them on.
 */
export function availablePresets(ds: Dataset, ws: Workspace): ResolvedPreset[] {
  const has = (id: string) => channelById(ds, id) !== undefined
  const withPoints = ws.points.some((p) => !p.hidden)
  let formulas: ReturnType<typeof formulaPresets> | null = null
  const out: ResolvedPreset[] = []
  for (const spec of SPECS) {
    const made: { formula?: PresetFormula } = {}
    const formula = (name: string): string | null => {
      formulas ??= formulaPresets(ds)
      const preset = formulas.find((f) => f.name === name)
      if (!preset) return null
      const existing = ds.channels.find((ch) => ch.derived && squeeze(ch.derived.expression) === squeeze(preset.expression))
      if (existing) return existing.id
      const placeholder = `fx:${preset.id}`
      made.formula = { name: preset.name, unit: preset.unit, expression: preset.expression, slug: preset.id, placeholder }
      return placeholder
    }
    const patch = spec.build({ has, withPoints, formula })
    if (!patch) continue
    out.push({
      id: spec.id,
      name: spec.name,
      hint: spec.hint,
      section: spec.section,
      config: {
        x: null,
        ys: [],
        source: 'all',
        ...(ws.xy.groups ? { groups: ws.xy.groups } : {}),
        style: 'points',
        colorBy: 'series',
        fit: 'none',
        fitTarget: 'samples',
        rangeEndurance: undefined,
        axesFromZero: undefined,
        showSamples: true,
        showMeans: true,
        title: '',
        xLabel: '',
        yLabel: '',
        ...patch,
        // A preset is a fresh plot: its Y channels take the colours in order.
        ySlots: (patch.ys ?? []).map((_, i) => i),
      },
      ...(made.formula ? { formula: made.formula } : {}),
    })
  }
  return out
}

/** The preset's config once its formula channel exists with id `id`: the placeholder replaced. */
export function withFormulaChannel(preset: ResolvedPreset, id: string): XYConfig {
  const placeholder = preset.formula?.placeholder
  return { ...preset.config, ys: preset.config.ys.map((y) => (y === placeholder ? id : y)) }
}

/**
 * The preset whose channels the config plots (x and Y channels), if any — shown as the active preset. When several
 * plot the same channels (range and endurance of a jet with drag alone, and thrust & drag), the one with the config's
 * fit wins.
 */
export function matchingPreset(presets: readonly ResolvedPreset[], xy: XYConfig): ResolvedPreset | null {
  const same = presets.filter(
    (p) => p.config.x === xy.x && p.config.ys.length === xy.ys.length && p.config.ys.every((id, i) => xy.ys[i] === id),
  )
  return same.find((p) => p.config.fit === xy.fit) ?? same[0] ?? null
}
