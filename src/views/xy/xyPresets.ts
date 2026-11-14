// Ready-made X–Y plots for the coursework: lift curve, drag polar, static stability (elevator to trim against CL),
// performance curves against true airspeed and the ground track. Channels are looked up by X-Plane token (never by
// label); a preset is offered only when its channels exist in the file. Each preset sets a complete XYConfig.

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

export interface ResolvedPreset extends XYPreset {
  config: XYConfig
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

interface PresetSpec extends XYPreset {
  /** null when the file lacks a channel the preset needs */
  build(has: (id: string) => boolean, withPoints: boolean): Partial<XYConfig> | null
}

const first = (has: (id: string) => boolean, ids: readonly string[]): string | null => ids.find(has) ?? null

/** Steady test points when the file has them (means, fits through them), else every row. */
function steadySource(withPoints: boolean): Partial<XYConfig> {
  return withPoints
    ? { source: 'points', colorBy: 'group', fitTarget: 'means', showMeans: true }
    : { source: 'all', colorBy: 'series', fitTarget: 'samples' }
}

const SPECS: PresetSpec[] = [
  {
    id: 'lift-curve',
    name: 'Lift curve (CL vs α)',
    hint: 'Lift coefficient against angle of attack, with a linear fit for the lift-curve slope.',
    section: 'Aerodynamics',
    build: (has, withPoints) =>
      has(ALPHA) && has(CL) ? { x: ALPHA, ys: [CL], fit: 'linear', ...steadySource(withPoints) } : null,
  },
  {
    id: 'drag-polar',
    name: 'Drag polar (CL vs CD)',
    hint: 'Lift coefficient against drag coefficient.',
    section: 'Aerodynamics',
    build: (has, withPoints) => (has(CD) && has(CL) ? { x: CD, ys: [CL], ...steadySource(withPoints) } : null),
  },
  {
    id: 'lift-to-drag',
    name: 'L/D vs CL',
    hint: 'Lift-to-drag ratio against lift coefficient: the best L/D and the CL it needs.',
    section: 'Aerodynamics',
    build: (has, withPoints) => (has(CL) && has(LD) ? { x: CL, ys: [LD], ...steadySource(withPoints) } : null),
  },
  {
    id: 'static-stability',
    name: 'Static stability: elevator to trim vs CL',
    hint: 'Elevator angle to trim against CL through the trim-point means; the slope gives the stick-fixed margin.',
    section: 'Stability',
    build: (has, withPoints) => {
      const elevator = first(has, ELEVATOR)
      return has(CL) && elevator ? { x: CL, ys: [elevator], fit: 'linear', ...steadySource(withPoints) } : null
    },
  },
  {
    id: 'trim-curve',
    name: 'Elevator vs KIAS',
    hint: 'The trim curve: elevator angle to trim against indicated airspeed.',
    section: 'Stability',
    build: (has, withPoints) => {
      const elevator = first(has, ELEVATOR)
      return has(KIAS) && elevator ? { x: KIAS, ys: [elevator], ...steadySource(withPoints) } : null
    },
  },
  {
    id: 'thrust-drag',
    name: 'Thrust & drag vs KTAS',
    hint: 'Drag (and engine thrust, same unit) against true airspeed: thrust required and available.',
    section: 'Performance',
    build: (has, withPoints) => {
      if (!has(KTAS) || !has(DRAG)) return null
      return { x: KTAS, ys: [DRAG, ...THRUST.filter(has)].slice(0, MAX_Y), ...steadySource(withPoints), colorBy: 'series' }
    },
  },
  {
    id: 'fuel-flow',
    name: 'Fuel flow vs KTAS',
    hint: 'Fuel flow per engine against true airspeed, for range and endurance.',
    section: 'Performance',
    build: (has, withPoints) => {
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
    build: (has, withPoints) => (has(KTAS) && has(VVI) ? { x: KTAS, ys: [VVI], ...steadySource(withPoints) } : null),
  },
  {
    id: 'ground-track',
    name: 'Ground track (lat vs lon, lines)',
    hint: 'Latitude against longitude drawn as a line through the whole log.',
    section: 'Navigation',
    build: (has) =>
      has(LAT) && has(LON)
        ? { x: LON, ys: [LAT], source: 'all', style: 'lines', colorBy: 'series', fitTarget: 'samples', showMeans: false }
        : null,
  },
]

/**
 * The presets this file supports, each resolved to a full XYConfig. The test-point group filter is kept (it is a
 * choice of data, not of plot); labels go back to their defaults.
 */
export function availablePresets(ds: Dataset, ws: Workspace): ResolvedPreset[] {
  const has = (id: string) => channelById(ds, id) !== undefined
  const withPoints = ws.points.some((p) => !p.hidden)
  const out: ResolvedPreset[] = []
  for (const spec of SPECS) {
    const patch = spec.build(has, withPoints)
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
        showSamples: true,
        showMeans: true,
        title: '',
        xLabel: '',
        yLabel: '',
        ...patch,
      },
    })
  }
  return out
}

/** The preset whose channels the config plots (x and Y channels), if any — shown as the active preset. */
export function matchingPreset(presets: readonly ResolvedPreset[], xy: XYConfig): ResolvedPreset | null {
  return (
    presets.find(
      (p) => p.config.x === xy.x && p.config.ys.length === xy.ys.length && p.config.ys.every((id, i) => xy.ys[i] === id),
    ) ?? null
  )
}
