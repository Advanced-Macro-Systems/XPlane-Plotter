// Default workspace for a freshly opened file, and sanitising a saved/imported workspace against a dataset.

import { channelById } from '../core/dataset'
import type {
  Dataset,
  DerivedDef,
  ModesConfig,
  PanelConfig,
  PointGroup,
  TestPoint,
  TimeBaseId,
  Workspace,
  XYConfig,
} from '../core/types'

/** Most series a chart shows (the categorical palette has 8 validated slots; a 9th colour is never generated). */
export const MAX_SERIES = 8
/** Most test-point groups a file can have: one colour slot each, so a 9th group would repeat a colour. */
export const MAX_GROUPS = 8

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

export function defaultPanels(ds: Dataset): PanelConfig[] {
  const panels: PanelConfig[] = []
  for (const preset of PANEL_PRESETS) {
    const ids = preset.filter((id) => exists(ds, id))
    if (ids.length) panels.push({ id: newId('p'), channelIds: ids })
  }
  if (!panels.length) {
    for (const id of plainCandidates(ds).slice(0, 3)) panels.push({ id: newId('p'), channelIds: [id] })
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
 * Makes a saved or imported workspace safe for this dataset: unknown channel ids dropped, row ranges clamped,
 * at least one group, colour slots in range, invalid fields replaced by defaults. Apply derived channels to the
 * dataset BEFORE calling this, so formula channels count as existing.
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
        const channelIds = Array.isArray(p.channelIds)
          ? [...new Set(p.channelIds.filter((id): id is string => exists(ds, id as string)))].slice(0, MAX_SERIES)
          : []
        return channelIds.length ? [{ id: uniqueId(p.id, 'p'), channelIds, yZero: p.yZero === true || undefined }] : []
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
  const xy: XYConfig = {
    x: exists(ds, xyIn.x as string) ? (xyIn.x as string) : fallback.xy.x,
    ys: Array.isArray(xyIn.ys)
      ? [...new Set(xyIn.ys.filter((id): id is string => exists(ds, id as string)))].slice(0, MAX_SERIES)
      : fallback.xy.ys,
    source: oneOf(xyIn.source, ['all', 'view', 'points'] as const, 'all'),
    ...xyGroups(xyIn.groups, groupIds),
    style: oneOf(xyIn.style, ['points', 'lines', 'both'] as const, 'points'),
    colorBy: oneOf(xyIn.colorBy, ['series', 'group', 'time'] as const, 'series'),
    fit: oneOf(xyIn.fit, ['none', 'linear', 'poly2', 'poly3'] as const, 'none'),
    fitTarget: oneOf(xyIn.fitTarget, ['samples', 'means'] as const, 'samples'),
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

  const tracked = Array.isArray(input.tracked)
    ? [...new Set(input.tracked.filter((id): id is string => exists(ds, id as string)))].slice(0, 24)
    : fallback.tracked

  return { version: 1, timeBase, panels, groups, points, derived, xy, modes, tracked }
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
