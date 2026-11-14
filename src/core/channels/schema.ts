// Types of the channel dictionary (dictionary.ts, groupRows.ts) and of the hand-curated overrides (overrides.ts).

/**
 * The app's small vocabulary of physical quantities. Views use it (with the unit) to decide which channels can share an
 * axis; 'time' channels are left out of default plots and steadiness checks.
 */
export type Quantity =
  | 'time'
  | 'speed'
  | 'angle'
  | 'angular-rate'
  | 'angular-accel'
  | 'length'
  | 'altitude'
  | 'mass'
  | 'force'
  | 'moment'
  | 'power'
  | 'rpm'
  | 'percent'
  | 'pressure'
  | 'temperature'
  | 'flow'
  | 'ratio'
  | 'flag'
  | 'position'
  | 'other'

/** How well the research pinned a meaning down: h = documented or verified, m = consistent evidence, l = inferred. */
export type Confidence = 'h' | 'm' | 'l'

/**
 * How to tell apart a token that several Data Output rows write, from its neighbours in the header. X-Plane writes each
 * ticked row as one contiguous block, so the columns around a shared token show which row it came from.
 */
export interface ContextRule {
  /** The columns just before this one, in file order (the last item is the column immediately before) */
  after?: readonly string[]
  /** The columns just after this one, in file order (the first item is the column immediately after) */
  before?: readonly string[]
  /** The default meaning: it applies when the columns just before are NOT these */
  notAfter?: readonly string[]
  /** Identical-token rows (e.g. stator A / B) told apart only by the order of their blocks */
  orderOnly?: boolean
  /** Only in the n-th block (1-based, in file order) that contains `marker` */
  block?: { readonly nth: number; readonly marker: string }
  /** The n-th time this token occurs in the file */
  nthInFile?: number
}

/** [id, X-Plane 12 Data Output index (null = not published), name, description, index confirmed for X-Plane 12 (1/0)] */
export type GroupRow = readonly [id: string, index: number | null, name: string, description: string, confirmed: 0 | 1]

/** One dictionary entry, as built from the research. */
export type ChannelRow = readonly [
  token: string,
  occurrence: number,
  group: string,
  label: string,
  short: string,
  unit: string,
  quantity: Quantity,
  description: string,
  sign: string,
  notes: string,
  confidence: Confidence,
  context?: ContextRule,
]

/** Hand-curated corrections of a dictionary entry (overrides.ts). Empty strings clear a field. */
export interface MetaOverride {
  label?: string
  short?: string
  unit?: string
  quantity?: Quantity
  description?: string
  sign?: string
  notes?: string
}
