// Default workspace for a freshly opened file, and sanitising a saved/imported workspace against a dataset.

import { channelById } from '../core/dataset'
import { sanitizeSlots } from '../core/slots'
import type {
  ChecklistDeclared,
  Dataset,
  DerivedDef,
  ModesCheckSettings,
  ModesConfig,
  PanelConfig,
  PerfCheckSettings,
  PointGroup,
  TestPoint,
  TimeBaseId,
  TrimCheckSettings,
  Workspace,
  XYConfig,
} from '../core/types'

/** Most series a chart shows (the categorical palette has 8 validated slots; a 9th colour is never generated). */
export const MAX_SERIES = 8
/** Most test-point groups a file can have: one colour slot each, so a 9th group would repeat a colour. */
export const MAX_GROUPS = 8
/** Every X–Y fit setting (XYConfig.fit), for sanitising stored values. */
export const XY_FITS = ['none', 'linear', 'poly2', 'poly3', 'power-model', 'drag-model'] as const satisfies readonly XYConfig['fit'][]

let idCounter = 0
/** Short unique id with a prefix: "p3k9x2a". */
export function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36).slice(-4)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

const TIME_LIKE = /time|zulu|local|hobbs|timer/i

function exists(ds: Dataset, id: string | null | undefined): id is string {
  return !!id && channelById(ds, id) !== undefined
}

/** Channels worth plotting by default when the dictionary knows nothing (CSV): varying, non-time columns. */
function plainCandidates(ds: Dataset): string[] {
  return ds.channels
    .filter((ch) => !ch.stats.constant && ch.stats.finite > 1 && !TIME_LIKE.test(ch.token) && ch.meta.quantity !== 'time')
    .map((ch) => ch.id)
}

/** Default stacked panels: airspeed, altitude, pitch attitude & AoA, bank, throttles — whichever exist. */
const PANEL_PRESETS: string[][] = [
  ['_Vind,_kias', 'Vtrue,_ktas'],
  ['p-alt,ftMSL'],
  ['pitch,__deg', 'alpha,__deg'],
  ['_roll,__deg'],
  ['thro1,handl', 'thro2,handl'],
]

/** Colour slots 0, 1, 2, ... for a new list of `count` channels. */
export function firstSlots(count: number): number[] {
  return sanitizeSlots(null, count)
}

export function defaultPanels(ds: Dataset): PanelConfig[] {
  const panels: PanelConfig[] = []
  for (const preset of PANEL_PRESETS) {
    const ids = preset.filter((id) => exists(ds, id))
    if (ids.length) panels.push({ id: newId('p'), channelIds: ids, slots: firstSlots(ids.length) })
  }
  if (!panels.length) {
    for (const id of plainCandidates(ds).slice(0, 3)) panels.push({ id: newId('p'), channelIds: [id], slots: [0] })
  }
  return panels
}

export function defaultXY(ds: Dataset): XYConfig {
  let x: string | null
  let ys: string[]
  if (exists(ds, 'alpha,__deg') && exists(ds, '___cl,total')) {
    x = 'alpha,__deg'
    ys = ['___cl,total']
  } else if (exists(ds, '_Vind,_kias') && exists(ds, 'alpha,__deg')) {
    x = '_Vind,_kias'
    ys = ['alpha,__deg']
  } else {
    const plain = plainCandidates(ds)
    x = plain[0] ?? null
    ys = plain.slice(1, 2)
  }
  return {
    x,
    ys,
    ySlots: firstSlots(ys.length),
    source: 'all',
    style: 'points',
    colorBy: 'series',
    fit: 'none',
    fitTarget: 'samples',
    showSamples: true,
    showMeans: true,
    title: '',
    xLabel: '',
    yLabel: '',
  }
}

export function defaultModes(ds: Dataset): ModesConfig {
  const pick = ['pitch,__deg', '____Q,deg/s', 'alpha,__deg', '_Vind,_kias'].find((id) => exists(ds, id))
  return {
    channelId: pick ?? plainCandidates(ds)[0] ?? null,
    source: 'selection',
    model: 'oscillation',
    detrend: 'linear',
  }
}

const TRACKED_PRESET = [
  '_Vind,_kias',
  'p-alt,ftMSL',
  '__VVI,__fpm',
  'alpha,__deg',
  'pitch,__deg',
  '_elev,_surf',
  'thro1,handl',
  '___cl,total',
]

export function defaultTracked(ds: Dataset): string[] {
  const ids = TRACKED_PRESET.filter((id) => exists(ds, id))
  return ids.length ? ids : plainCandidates(ds).slice(0, 4)
}

export function defaultGroups(): PointGroup[] {
  return [{ id: 'g1', name: 'Test 1', slot: 0 }]
}

export function defaultWorkspace(ds: Dataset): Workspace {
  return {
    version: 1,
    timeBase: 'elapsed',
    panels: defaultPanels(ds),
    groups: defaultGroups(),
    points: [],
    derived: [],
    xy: defaultXY(ds),
    modes: defaultModes(ds),
    tracked: defaultTracked(ds),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

/**
 * Makes a saved or imported workspace safe for this dataset: unknown channel ids dropped (with their colour slots, so
 * the other channels keep theirs), row ranges clamped, at least one group, colour slots in range and one per channel
 * of a panel or of the X–Y Y list, invalid fields replaced by defaults. Apply derived channels to the dataset BEFORE
 * calling this, so formula channels count as existing.
 */
export function sanitizeWorkspace(input: unknown, ds: Dataset): Workspace {
  const fallback = defaultWorkspace(ds)
  if (!isObject(input) || input.version !== 1) return fallback

  const timeBaseRaw = str(input.timeBase, 'elapsed')
  const timeBase: TimeBaseId =
    timeBaseRaw === 'index' || timeBaseRaw === 'elapsed'
      ? timeBaseRaw
      : timeBaseRaw.startsWith('ch:') && exists(ds, timeBaseRaw.slice(3))
        ? (timeBaseRaw as TimeBaseId)
        : 'elapsed'

  const seenIds = new Set<string>()
  const uniqueId = (id: unknown, prefix: string): string => {
    let value = typeof id === 'string' && id ? id : newId(prefix)
    while (seenIds.has(value)) value = newId(prefix)
    seenIds.add(value)
    return value
  }

  const panels: PanelConfig[] = Array.isArray(input.panels)
    ? input.panels.filter(isObject).flatMap((p) => {
        const { ids: channelIds, slots } = channelList(p.channelIds, p.slots, ds)
        return channelIds.length
          ? [{ id: uniqueId(p.id, 'p'), channelIds, slots, yZero: p.yZero === true || undefined }]
          : []
      })
    : fallback.panels

  let groups: PointGroup[] = Array.isArray(input.groups)
    ? input.groups.filter(isObject).map((g, i) => ({
        id: uniqueId(g.id, 'g'),
        name: str(g.name, `Test ${i + 1}`).slice(0, 60) || `Test ${i + 1}`,
        slot: Math.min(7, Math.max(0, int(g.slot) ?? i % 8)),
      }))
    : []
  if (!groups.length) groups = defaultGroups()
  const groupIds = new Set(groups.map((g) => g.id))

  const points: TestPoint[] = Array.isArray(input.points)
    ? input.points.filter(isObject).flatMap((p, i) => {
        const rawStart = int(p.start)
        const rawEnd = int(p.end)
        // A range that is not two numbers is dropped, not guessed at.
        if (rawStart === null || rawEnd === null) return []
        const start = Math.max(0, Math.min(ds.rowCount - 1, rawStart))
        const end = Math.max(0, Math.min(ds.rowCount, rawEnd))
        if (!(end > start)) return []
        const groupId = typeof p.groupId === 'string' && groupIds.has(p.groupId) ? p.groupId : groups[0].id
        return [
          {
            id: uniqueId(p.id, 't'),
            name: str(p.name, `Point ${i + 1}`).slice(0, 80) || `Point ${i + 1}`,
            groupId,
            start,
            end,
            hidden: p.hidden === true || undefined,
            note: typeof p.note === 'string' && p.note ? p.note.slice(0, 500) : undefined,
          },
        ]
      })
    : []

  const derived = sanitizeDerived(input.derived)

  const xyIn = isObject(input.xy) ? input.xy : {}
  const ys = Array.isArray(xyIn.ys)
    ? channelList(xyIn.ys, xyIn.ySlots, ds)
    : { ids: fallback.xy.ys, slots: firstSlots(fallback.xy.ys.length) }
  const xy: XYConfig = {
    x: exists(ds, xyIn.x as string) ? (xyIn.x as string) : fallback.xy.x,
    ys: ys.ids,
    ySlots: ys.slots,
    source: oneOf(xyIn.source, ['all', 'view', 'points'] as const, 'all'),
    ...xyGroups(xyIn.groups, groupIds),
    style: oneOf(xyIn.style, ['points', 'lines', 'both'] as const, 'points'),
    colorBy: oneOf(xyIn.colorBy, ['series', 'group', 'time'] as const, 'series'),
    fit: oneOf(xyIn.fit, XY_FITS, 'none'),
    fitTarget: oneOf(xyIn.fitTarget, ['samples', 'means'] as const, 'samples'),
    // Optional flags: present (true) only when on, so older workspaces and sessions read the same.
    ...(xyIn.rangeEndurance === true ? { rangeEndurance: true } : {}),
    ...(xyIn.axesFromZero === true ? { axesFromZero: true } : {}),
    showSamples: xyIn.showSamples !== false,
    showMeans: xyIn.showMeans !== false,
    title: str(xyIn.title, '').slice(0, 160),
    xLabel: str(xyIn.xLabel, '').slice(0, 120),
    yLabel: str(xyIn.yLabel, '').slice(0, 120),
  }

  const modesIn = isObject(input.modes) ? input.modes : {}
  const pointIds = new Set(points.map((p) => p.id))
  const sourceRaw = str(modesIn.source, 'selection')
  const modes: ModesConfig = {
    channelId: exists(ds, modesIn.channelId as string) ? (modesIn.channelId as string) : fallback.modes.channelId,
    source:
      sourceRaw === 'selection' || sourceRaw === 'view'
        ? sourceRaw
        : sourceRaw.startsWith('point:') && pointIds.has(sourceRaw.slice(6))
          ? (sourceRaw as `point:${string}`)
          : 'selection',
    model: oneOf(modesIn.model, ['oscillation', 'first-order'] as const, 'oscillation'),
    detrend: oneOf(modesIn.detrend, ['none', 'linear'] as const, 'linear'),
  }
  const modesCheck = sanitizeModesCheck(modesIn.check, ds.rowCount)
  if (modesCheck) modes.check = modesCheck

  const tracked = Array.isArray(input.tracked)
    ? [...new Set(input.tracked.filter((id): id is string => exists(ds, id as string)))].slice(0, 24)
    : fallback.tracked

  // The checklists' settings: optional, present only when set, so older workspaces read unchanged.
  const trimCheck = sanitizeTrimCheck(input.trimCheck, pointIds)
  const perfCheck = sanitizePerfCheck(input.perfCheck, pointIds)
  const checklistKind = isObject(input.checklist) ? input.checklist.kind : undefined
  return {
    version: 1,
    timeBase,
    panels,
    groups,
    points,
    derived,
    xy,
    modes,
    tracked,
    ...(trimCheck ? { trimCheck } : {}),
    ...(perfCheck ? { perfCheck } : {}),
    ...(checklistKind === 'performance' || checklistKind === 'static' ? { checklist: { kind: checklistKind } } : {}),
  }
}

// ------------------------------------------------------------------ checklist settings

const MODE_IDS = ['short-period', 'phugoid', 'dutch-roll', 'roll-subsidence', 'spiral'] as const

/** A finite number above zero, else undefined. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A finite number (any sign), else undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The object without its undefined fields; undefined when nothing is left. */
function compact<T extends object>(value: T): T | undefined {
  const out = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
  return Object.keys(out).length ? out : undefined
}

/** Positive limits under the given names only. */
function limitsOf<K extends string>(input: unknown, keys: readonly K[]): Partial<Record<K, number>> | undefined {
  if (!isObject(input)) return undefined
  return compact(Object.fromEntries(keys.map((k) => [k, positive(input[k])])) as Partial<Record<K, number>>)
}

const STATES = ['off', 'on', 'unknown'] as const

function declaredOf(input: unknown): ChecklistDeclared | undefined {
  if (!isObject(input)) return undefined
  const modes = typeof input.modes === 'string' && input.modes.trim() && input.modes.length <= 200 ? input.modes : undefined
  return compact({
    autopilot: STATES.find((s) => s === input.autopilot),
    autothrottle: STATES.find((s) => s === input.autothrottle),
    modes,
  })
}

/** Point ids that exist, each once. */
function pointIdsOf(input: unknown, pointIds: ReadonlySet<string>): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const kept = [...new Set(input.filter((id): id is string => typeof id === 'string' && pointIds.has(id)))]
  return kept.length ? kept : undefined
}

/**
 * Workspace.trimCheck made safe: a positive gain and MAC, any finite LEMAC (the CG reference can lie aft of it), known
 * trim types, positive limits, declarations of at most 200 characters, existing point ids; undefined when nothing is left.
 */
export function sanitizeTrimCheck(input: unknown, pointIds: ReadonlySet<string>): TrimCheckSettings | undefined {
  if (!isObject(input)) return undefined
  return compact<TrimCheckSettings>({
    gain: positive(input.gain),
    trimType: input.trimType === 'stabiliser' || input.trimType === 'elevator' ? input.trimType : undefined,
    macFt: positive(input.macFt),
    lemacFt: finiteNumber(input.lemacFt),
    limits: limitsOf(input.limits, ['vsKias', 'alphaStallDeg', 'mmo', 'vmoKias'] as const),
    declared: declaredOf(input.declared),
    fitExcluded: pointIdsOf(input.fitExcluded, pointIds),
    fitUsedOnly: input.fitUsedOnly === true ? true : undefined,
  })
}

/** Workspace.perfCheck made safe (unknown engine types, non-finite numbers and missing point ids dropped). */
export function sanitizePerfCheck(input: unknown, pointIds: ReadonlySet<string>): PerfCheckSettings | undefined {
  if (!isObject(input)) return undefined
  return compact<PerfCheckSettings>({
    propulsion: input.propulsion === 'jet' || input.propulsion === 'propeller' ? input.propulsion : undefined,
    thrustAngleDeg: finiteNumber(input.thrustAngleDeg),
    referenceWeightLb: positive(input.referenceWeightLb),
    referenceAltitudeFt: finiteNumber(input.referenceAltitudeFt),
    limits: limitsOf(input.limits, ['vsKeas', 'mmo', 'vmoKias'] as const),
    declared: declaredOf(input.declared),
    fitExcluded: pointIdsOf(input.fitExcluded, pointIds),
    fitUsedOnly: input.fitUsedOnly === true ? true : undefined,
  })
}

/** ModesConfig.check made safe: a known mode, the yaw-damper flag, an input row range inside the file, positive limits. */
export function sanitizeModesCheck(input: unknown, rowCount: number): ModesCheckSettings | undefined {
  if (!isObject(input)) return undefined
  const range = Array.isArray(input.input) ? input.input.map(int) : null
  const inputRows =
    range && range.length === 2 && range[0] !== null && range[1] !== null && range[0] >= 0 && range[1] > range[0] && range[1] <= rowCount
      ? ([range[0], range[1]] as const)
      : undefined
  return compact<ModesCheckSettings>({
    mode: MODE_IDS.find((m) => m === input.mode),
    yawDamper: input.yawDamper === 'on' || input.yawDamper === 'off' ? input.yawDamper : undefined,
    input: inputRows,
    limits: limitsOf(input.limits, ['vmoKias', 'mmo', 'vsKias', 'alphaMaxDeg'] as const),
  })
}

/**
 * The formulas of a saved or imported workspace, made safe to evaluate: objects only, an "fx:<slug>" id (the first
 * of a repeated id wins), a name (at most 80 characters, as the formula dialog allows) and an expression that are not
 * empty, and a text unit (else none). Anything else is dropped: localStorage and session files are untrusted.
 */
export function sanitizeDerived(input: unknown): DerivedDef[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  return input.filter(isObject).flatMap((d) => {
    const id = str(d.id, '')
    const name = str(d.name, '').trim().slice(0, 80)
    const expression = str(d.expression, '')
    if (!/^fx:./.test(id) || seen.has(id) || !name || !expression.trim()) return []
    seen.add(id)
    return [{ id, name, unit: str(d.unit, '').slice(0, 24), expression }]
  })
}

/**
 * A stored channel list (panel channels, X–Y Y channels) for this dataset with its colour slots: the channels that
 * exist, the first of a repeat, at most MAX_SERIES. A channel left out takes its slot with it, so the others keep
 * theirs; missing, invalid or repeated slots are re-derived (sanitizeSlots).
 */
function channelList(ids: unknown, slots: unknown, ds: Dataset): { ids: string[]; slots: number[] } {
  if (!Array.isArray(ids)) return { ids: [], slots: [] }
  const stored: readonly unknown[] = Array.isArray(slots) ? slots : []
  const kept: string[] = []
  const keptSlots: unknown[] = []
  ids.forEach((id: unknown, i) => {
    if (kept.length >= MAX_SERIES || typeof id !== 'string' || !exists(ds, id) || kept.includes(id)) return
    kept.push(id)
    keptSlots.push(stored[i])
  })
  return { ids: kept, slots: sanitizeSlots(keptSlots, kept.length) }
}

/** XYConfig.groups kept only when it names existing groups (absent = every group). */
function xyGroups(input: unknown, groupIds: ReadonlySet<string>): Pick<XYConfig, 'groups'> {
  if (!Array.isArray(input)) return {}
  const kept = [...new Set(input.filter((id): id is string => typeof id === 'string' && groupIds.has(id)))]
  return kept.length ? { groups: kept } : {}
}

/** The next colour slot not used by any group (or the least used one). */
export function nextGroupSlot(groups: readonly PointGroup[]): number {
  const counts = new Array<number>(8).fill(0)
  for (const g of groups) counts[g.slot % 8] += 1
  let best = 0
  for (let slot = 1; slot < 8; slot += 1) if (counts[slot] < counts[best]) best = slot
  return best
}
