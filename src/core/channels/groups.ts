// Data-set groups: the X-Plane 12 Data Output rows in the order X-Plane 12.4.3 lists them (and writes them to
// Data.txt), the rows only older versions wrote, then "Formulas" and "Other".

import { GROUP_ROWS } from './groupRows'

export interface ChannelGroup {
  /** e.g. "speeds" */
  id: string
  /** e.g. "Speeds" — the row name in X-Plane's Data Output screen */
  name: string
  /** X-Plane 12 Data Output row index, when known */
  index: number | null
  description: string
  /** Sort order in channel pickers (lower first); "other" sorts last */
  order: number
}

const DERIVED: ChannelGroup = Object.freeze({
  id: 'derived',
  name: 'Formulas',
  index: null,
  description: 'Channels you defined with a formula.',
  order: 9000,
})
const OTHER: ChannelGroup = Object.freeze({
  id: 'other',
  name: 'Other',
  index: null,
  description: 'Channels without a known group.',
  order: 9999,
})

/**
 * Short tags that tell apart rows writing the same tokens, appended to a short name when two columns of one file
 * would otherwise share it ("Wind dir (local)").
 */
const TAGS: Readonly<Record<string, string>> = {
  'metar-clouds-winds-1': 'METAR 1',
  'metar-clouds-winds-2': 'METAR 2',
  'metar-clouds-winds-3': 'METAR 3',
  'point-weather-precip-wind': 'local',
  'location-velocity-distance': 'travelled',
  'gps-status': 'GPS',
  'angular-velocities': 'body',
  'motion-platform': 'motion',
  'artificial-stability': 'SAS',
  'flight-controls': 'surface',
  'fbw-params': 'FBW',
  'lift-drag': 'aero',
  'gear-forces': 'gear',
  'engine-forces': 'engine',
  'ap-values': 'AP',
  pressurization: 'cabin',
  'throttle-commanded': 'lever',
  'throttle-actual': 'used',
  'motor-stator-a-temp': 'stator A',
  'motor-stator-b-temp': 'stator B',
  'legacy-rows': 'old',
}

interface GroupTable {
  list: readonly ChannelGroup[]
  byId: ReadonlyMap<string, ChannelGroup>
}

let table: GroupTable | null = null

function groups(): GroupTable {
  if (table) return table
  const list: ChannelGroup[] = GROUP_ROWS.map(([id, index, name, description], order) =>
    Object.freeze({ id, name, index, description, order }),
  )
  list.push(DERIVED, OTHER)
  table = { list, byId: new Map(list.map((g) => [g.id, g])) }
  return table
}

/**
 * Every group, sorted by `order`: the X-Plane 12 Data Output rows in display order, the legacy rows, then
 * { id: 'derived', name: 'Formulas' } and { id: 'other', name: 'Other' }.
 */
export function allGroups(): ChannelGroup[] {
  return [...groups().list]
}

/** The group for an id; the "other" group when unknown. */
export function groupById(id: string): ChannelGroup {
  return groups().byId.get(id) ?? OTHER
}

/** Display position of a dictionary group (0 = first row); a large number for unknown ids. */
export function groupPosition(id: string): number {
  return groups().byId.get(id)?.order ?? OTHER.order
}

/** The disambiguation tag of a group, if it shares tokens with another row. */
export function groupTag(id: string): string | undefined {
  return TAGS[id]
}
