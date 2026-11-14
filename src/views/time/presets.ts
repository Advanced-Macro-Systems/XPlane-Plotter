// Ready-made panel stacks for the Time-history tab, one per kind of flight test. Each preset lists X-Plane 12 Data
// Output channels by header token (= channel id of the first occurrence), never by label; a preset only uses the
// channels the log actually has. Channels that end up in one panel always share a unit (no dual y-axes): a panel spec
// whose channels have different units is split. Pure: unit-tested in presets.test.ts.

import type { Channel, Dataset, PanelConfig } from '../../core/types'
import { channelById } from '../../core/dataset'

/** A channel id, or alternatives of which the first that exists is used. */
type Entry = string | readonly string[]

export interface TimePreset {
  id: string
  name: string
  description: string
  panels: readonly (readonly Entry[])[]
}

/** Tokens for engines 1..n, e.g. perEngine((i) => `N1__${i},_pcnt`). */
function perEngine(token: (engine: number) => string, engines = 8): string[] {
  return Array.from({ length: engines }, (_, i) => token(i + 1))
}

const KIAS = '_Vind,_kias'
const KTAS = 'Vtrue,_ktas'
const ALTITUDE = ['p-alt,ftMSL', '___CG,ftMSL'] as const
const VVI = '__VVI,__fpm'
const PITCH = 'pitch,__deg'
const ROLL = '_roll,__deg'
const THROTTLES = perEngine((i) => `thro${i},handl`)
const THRUST = perEngine((i) => `thrst,_${i},lb`)
const N1 = perEngine((i) => `N1__${i},_pcnt`)
const FUEL_FLOW = perEngine((i) => `FF__${i},_lb/h`)

export const TIME_PRESETS: readonly TimePreset[] = [
  {
    id: 'longitudinal',
    name: 'Longitudinal',
    description: 'Airspeed, altitude, pitch and angle of attack, pitch rate, elevator',
    panels: [[KIAS, KTAS], [ALTITUDE], [PITCH, 'alpha,__deg'], ['____Q,deg/s'], [['elev1,__deg', '_elev,_surf', '_elev,stick']]],
  },
  {
    id: 'lateral',
    name: 'Lateral-directional',
    description: 'Bank, sideslip, roll and yaw rates, aileron and rudder',
    panels: [
      [ROLL],
      ['_beta,__deg'],
      ['____P,deg/s', '____R,deg/s'],
      [
        ['ailrn,_surf', 'ailrn,stick'],
        ['ruddr,_surf', 'ruddr,stick'],
      ],
    ],
  },
  {
    id: 'performance',
    name: 'Performance',
    description: 'Airspeed, altitude, vertical speed, N1 and throttles, fuel flow',
    panels: [[KIAS], [ALTITUDE], [VVI], N1.slice(0, 4), THROTTLES.slice(0, 4), FUEL_FLOW.slice(0, 4)],
  },
  {
    id: 'engines',
    name: 'Engines',
    description: 'N1, N2, fuel flow, thrust, EPR and engine speed per engine',
    panels: [
      N1,
      perEngine((i) => `N2__${i},_pcnt`),
      FUEL_FLOW,
      THRUST,
      perEngine((i) => `EPR_${i},_part`),
      perEngine((i) => `engn${i},__rpm`),
    ],
  },
  {
    id: 'controls',
    name: 'Controls & trim',
    description: 'Yoke and pedals, control surfaces, trim, flaps and speedbrake, throttles',
    panels: [
      ['_elev,stick', 'ailrn,stick', 'ruddr,stick'],
      ['_elev,_surf', 'ailrn,_surf', 'ruddr,_surf'],
      ['_trim,_elev', '_trim,ailrn', '_trim,ruddr'],
      [
        ['_flap,postn', '_flap,handl'],
        ['sbrak,postn', 'sbrak,handl'],
      ],
      THROTTLES.slice(0, 4),
    ],
  },
  {
    id: 'propulsion',
    name: 'Propulsion control',
    description: 'Throttles, thrust, pitch, vertical speed, heading and bank',
    panels: [THROTTLES.slice(0, 4), THRUST.slice(0, 4), [PITCH], [VVI], [['hding,_true', 'hding,__mag']], [ROLL]],
  },
]

export interface ResolvedPreset {
  preset: TimePreset
  /** Channel ids per panel; empty when the log has none of the preset's channels */
  panels: string[][]
  /** "KIAS, KTAS · Altitude · ..." from the channels' short names */
  summary: string
}

/**
 * The panels a preset gives for a dataset: existing channels only, without repeats, split so each panel has one unit,
 * at most `maxSeries` channels per panel and `maxPanels` panels.
 */
export function resolvePreset(
  preset: TimePreset,
  lookup: (id: string) => Channel | undefined,
  maxPanels = 6,
  maxSeries = 8,
): string[][] {
  const used = new Set<string>()
  const panels: string[][] = []
  for (const spec of preset.panels) {
    const channels: Channel[] = []
    for (const entry of spec) {
      const options = typeof entry === 'string' ? [entry] : entry
      const ch = options.map(lookup).find((c): c is Channel => c !== undefined && !used.has(c.id))
      if (!ch) continue
      used.add(ch.id)
      channels.push(ch)
    }
    // One panel per unit, in order of first appearance.
    const byUnit = new Map<string, string[]>()
    for (const ch of channels) {
      const list = byUnit.get(ch.meta.unit) ?? []
      list.push(ch.id)
      byUnit.set(ch.meta.unit, list)
    }
    for (const ids of byUnit.values()) {
      for (let i = 0; i < ids.length; i += maxSeries) panels.push(ids.slice(i, i + maxSeries))
    }
  }
  return panels.slice(0, maxPanels)
}

export function resolvePresets(ds: Dataset): ResolvedPreset[] {
  const lookup = (id: string) => channelById(ds, id)
  return TIME_PRESETS.map((preset) => {
    const panels = resolvePreset(preset, lookup)
    const summary = panels
      .map((ids) => ids.map((id) => lookup(id)?.meta.short ?? id).join(', '))
      .join(' · ')
    return { preset, panels, summary }
  })
}

/** Panel configs for resolved channel lists, with fresh ids and colour slots 0, 1, 2, ... (a fresh stack). */
export function presetPanels(panels: readonly string[][], makeId: () => string): PanelConfig[] {
  return panels.map((channelIds) => ({ id: makeId(), channelIds: [...channelIds], slots: channelIds.map((_, i) => i) }))
}
