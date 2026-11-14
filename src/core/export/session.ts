// Workspace save/load as a JSON "session" file (test points, groups, panels, formulas, plot settings — never the
// flight data itself).
// OWNER: export agent. Public API below is a contract; keep these signatures.

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
} from '../types'
import { safeFilename } from './download'

export interface SessionFile {
  app: 'xplane-plotter'
  version: 1
  /** ISO timestamp */
  savedAt: string
  dataset: { name: string; signature: string; rowCount: number }
  workspace: Workspace
}

/** Value of SessionFile.app: identifies our files among other JSON. */
export const SESSION_APP = 'xplane-plotter'
/** Newest session format this build reads and the one it writes. */
export const SESSION_VERSION = 1

/**
 * Session files hold settings only (a few kB; well under 3 MB even at the limits below), so anything this large is the
 * wrong file — or one made to freeze the page.
 */
const MAX_SESSION_CHARS = 5_000_000
/**
 * A file larger than this (bytes) holds more than MAX_SESSION_CHARS characters whatever its encoding: callers can
 * turn it away by its size, before reading it.
 */
export const MAX_SESSION_BYTES = 3 * MAX_SESSION_CHARS

/**
 * Most items a session may hold. Far more than a flight-test campaign needs, and small enough that the Test points
 * table, the formulas and the panels of an imported session render without freezing the page.
 */
export const SESSION_LIMITS = { points: 2000, groups: 200, derived: 500, panels: 100 } as const

const NOT_A_SESSION = 'This is not an X-Plane Plotter session file'

/** The session file's name for a log: "Data_run1.txt" -> "Data_run1.xpp-session.json". */
export function sessionFileName(datasetName: string): string {
  const stem = datasetName.replace(/\.[A-Za-z0-9]{1,5}$/, '') || datasetName
  return `${safeFilename(stem, 'session')}.xpp-session.json`
}

export function serializeSession(ds: Dataset, ws: Workspace): string {
  const file: SessionFile = {
    app: SESSION_APP,
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    dataset: { name: ds.name, signature: ds.signature, rowCount: ds.rowCount },
    workspace: ws,
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * Parses and structurally validates a session file. Throws Error with a user-facing message for anything that is not
 * a valid session. (Matching it to a dataset — unknown channels, row ranges — is store/defaults.ts sanitizeWorkspace.)
 *
 * The result is a clean copy: unknown properties are dropped and optional flags appear only when set.
 */
export function parseSession(text: string): SessionFile {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${NOT_A_SESSION}: it is empty.`)
  if (text.length > MAX_SESSION_CHARS) throw new Error(`${NOT_A_SESSION}: it is far too large.`)

  let data: unknown
  try {
    // A byte-order mark (U+FEFF) is not JSON; editors on Windows sometimes add one.
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    if (looksLikeLog(text)) {
      throw new Error(`${NOT_A_SESSION}: it looks like a flight log. Open it as a data file instead.`)
    }
    throw new Error(`${NOT_A_SESSION}: it is not valid JSON.`)
  }
  if (!isRecord(data) || data.app !== SESSION_APP) throw new Error(`${NOT_A_SESSION}.`)

  checkVersion(data.version, 'session')
  const savedAt = str(data.savedAt, 'savedAt')
  const dsIn = record(data.dataset, 'dataset')
  const dataset = {
    name: str(dsIn.name, 'dataset.name'),
    signature: str(dsIn.signature, 'dataset.signature'),
    rowCount: count(dsIn.rowCount, 'dataset.rowCount'),
  }
  const workspace = parseWorkspace(record(data.workspace, 'workspace'))
  return { app: SESSION_APP, version: SESSION_VERSION, savedAt, dataset, workspace }
}

// ------------------------------------------------------------------ validation helpers

/** A first line made of "|" cells (X-Plane) or many delimiters: the user picked the log instead of a session. */
function looksLikeLog(text: string): boolean {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? ''
  return (firstLine.match(/\|/g)?.length ?? 0) >= 3 || (firstLine.match(/[,;\t]/g)?.length ?? 0) >= 3
}

function damaged(path: string, problem: string): never {
  throw new Error(`This session file is damaged or was edited by hand: ${path} ${problem}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) damaged(path, value === undefined ? 'is missing' : 'must be an object')
  return value
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) damaged(path, value === undefined ? 'is missing' : 'must be a list')
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') damaged(path, value === undefined ? 'is missing' : 'must be text')
  return value
}

function nonEmpty(value: unknown, path: string): string {
  const text = str(value, path)
  if (!text) damaged(path, 'must not be empty')
  return text
}

function optionalStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path)
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') damaged(path, value === undefined ? 'is missing' : 'must be true or false')
  return value
}

/** A whole number >= 0. */
function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    damaged(path, value === undefined ? 'is missing' : 'must be a whole number (0 or more)')
  }
  return value
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    damaged(path, value === undefined ? 'is missing' : `must be one of ${options.map((o) => `"${o}"`).join(', ')}`)
  }
  return value as T
}

function strList(value: unknown, path: string): string[] {
  return list(value, path).map((item, i) => str(item, `${path}[${i}]`))
}

/** Version fields: 1 is read; a larger number means a newer app wrote the file. */
function checkVersion(value: unknown, what: string): void {
  if (typeof value === 'number' && Number.isInteger(value) && value > SESSION_VERSION) {
    throw new Error(
      `This ${what} was saved by a newer version of X-Plane Plotter (format ${value}; this version reads format ` +
        `${SESSION_VERSION}). Reload the page to update the app, then try again.`,
    )
  }
  if (value !== SESSION_VERSION) {
    throw new Error(`${NOT_A_SESSION}: its format version (${JSON.stringify(value) ?? 'missing'}) is not supported.`)
  }
}

// ------------------------------------------------------------------ the workspace

/** A list with at most `max` items; more is refused with a message that says how many (see SESSION_LIMITS). */
function limited(value: unknown, path: string, max: number, what: string): unknown[] {
  const items = list(value, path)
  if (items.length > max) {
    throw new Error(
      `This session has ${items.length.toLocaleString('en-GB')} ${what}; X-Plane Plotter reads at most ` +
        `${max.toLocaleString('en-GB')}.`,
    )
  }
  return items
}

function parseWorkspace(input: Record<string, unknown>): Workspace {
  checkVersion(input.version, 'workspace')
  const panels = limited(input.panels, 'workspace.panels', SESSION_LIMITS.panels, 'plot panels')
  const groups = limited(input.groups, 'workspace.groups', SESSION_LIMITS.groups, 'test-point groups')
  const points = limited(input.points, 'workspace.points', SESSION_LIMITS.points, 'test points')
  const derived = limited(input.derived, 'workspace.derived', SESSION_LIMITS.derived, 'formulas')
  return {
    version: 1,
    timeBase: parseTimeBase(input.timeBase),
    panels: panels.map((p, i) => parsePanel(p, `workspace.panels[${i}]`)),
    groups: groups.map((g, i) => parseGroup(g, `workspace.groups[${i}]`)),
    points: points.map((p, i) => parsePoint(p, `workspace.points[${i}]`)),
    derived: derived.map((d, i) => parseDerived(d, `workspace.derived[${i}]`)),
    xy: parseXY(record(input.xy, 'workspace.xy')),
    modes: parseModes(record(input.modes, 'workspace.modes')),
    tracked: strList(input.tracked, 'workspace.tracked'),
  }
}

function parseTimeBase(value: unknown): TimeBaseId {
  const id = str(value, 'workspace.timeBase')
  if (id === 'elapsed' || id === 'index') return id
  if (id.startsWith('ch:') && id.length > 3) return id as TimeBaseId
  return damaged('workspace.timeBase', 'must be "elapsed", "index" or "ch:<channel id>"')
}

function parsePanel(value: unknown, path: string): PanelConfig {
  const p = record(value, path)
  const panel: PanelConfig = { id: nonEmpty(p.id, `${path}.id`), channelIds: strList(p.channelIds, `${path}.channelIds`) }
  if (p.slots !== undefined) panel.slots = slotList(p.slots, `${path}.slots`)
  if (p.yZero !== undefined && bool(p.yZero, `${path}.yZero`)) panel.yZero = true
  return panel
}

/** A categorical colour slot, 0 to 7. */
function colourSlot(value: unknown, path: string): number {
  const slot = count(value, path)
  if (slot > 7) damaged(path, 'must be a colour slot from 0 to 7')
  return slot
}

/**
 * The colour slots of a channel list (PanelConfig.slots, XYConfig.ySlots). Each must be a slot; matching them to the
 * channels (one each, no repeats) is sanitizeWorkspace's job, which re-derives any that do not fit.
 */
function slotList(value: unknown, path: string): number[] {
  return list(value, path).map((item, i) => colourSlot(item, `${path}[${i}]`))
}

function parseGroup(value: unknown, path: string): PointGroup {
  const g = record(value, path)
  const slot = colourSlot(g.slot, `${path}.slot`)
  return { id: nonEmpty(g.id, `${path}.id`), name: str(g.name, `${path}.name`), slot }
}

function parsePoint(value: unknown, path: string): TestPoint {
  const p = record(value, path)
  const start = count(p.start, `${path}.start`)
  const end = count(p.end, `${path}.end`)
  if (end <= start) damaged(`${path}.end`, 'must be greater than start (rows are [start, end))')
  const point: TestPoint = {
    id: nonEmpty(p.id, `${path}.id`),
    name: str(p.name, `${path}.name`),
    groupId: str(p.groupId, `${path}.groupId`),
    start,
    end,
  }
  if (p.hidden !== undefined && bool(p.hidden, `${path}.hidden`)) point.hidden = true
  const note = optionalStr(p.note, `${path}.note`)
  if (note) point.note = note
  return point
}

function parseDerived(value: unknown, path: string): DerivedDef {
  const d = record(value, path)
  const id = str(d.id, `${path}.id`)
  if (!/^fx:./.test(id)) damaged(`${path}.id`, 'must start with "fx:"')
  return {
    id,
    name: nonEmpty(d.name, `${path}.name`),
    unit: str(d.unit, `${path}.unit`),
    expression: nonEmpty(d.expression, `${path}.expression`),
  }
}

function parseXY(xy: Record<string, unknown>): XYConfig {
  const at = (key: string): string => `workspace.xy.${key}`
  if (xy.x !== null && typeof xy.x !== 'string') damaged(at('x'), xy.x === undefined ? 'is missing' : 'must be a channel id or null')
  return {
    x: xy.x as string | null,
    ys: strList(xy.ys, at('ys')),
    ...(xy.ySlots !== undefined ? { ySlots: slotList(xy.ySlots, at('ySlots')) } : {}),
    source: oneOf(xy.source, ['all', 'view', 'points'] as const, at('source')),
    ...(xy.groups !== undefined ? { groups: strList(xy.groups, at('groups')) } : {}),
    style: oneOf(xy.style, ['points', 'lines', 'both'] as const, at('style')),
    colorBy: oneOf(xy.colorBy, ['series', 'group', 'time'] as const, at('colorBy')),
    fit: oneOf(xy.fit, ['none', 'linear', 'poly2', 'poly3', 'power-model', 'drag-model'] as const, at('fit')),
    fitTarget: oneOf(xy.fitTarget, ['samples', 'means'] as const, at('fitTarget')),
    // Optional (sessions saved before range and endurance have neither): kept only when on.
    ...(xy.rangeEndurance !== undefined && bool(xy.rangeEndurance, at('rangeEndurance')) ? { rangeEndurance: true } : {}),
    ...(xy.axesFromZero !== undefined && bool(xy.axesFromZero, at('axesFromZero')) ? { axesFromZero: true } : {}),
    showSamples: bool(xy.showSamples, at('showSamples')),
    showMeans: bool(xy.showMeans, at('showMeans')),
    title: str(xy.title, at('title')),
    xLabel: str(xy.xLabel, at('xLabel')),
    yLabel: str(xy.yLabel, at('yLabel')),
  }
}

function parseModes(modes: Record<string, unknown>): ModesConfig {
  const at = (key: string): string => `workspace.modes.${key}`
  if (modes.channelId !== null && typeof modes.channelId !== 'string') {
    damaged(at('channelId'), modes.channelId === undefined ? 'is missing' : 'must be a channel id or null')
  }
  const source = str(modes.source, at('source'))
  if (source !== 'selection' && source !== 'view' && !/^point:./.test(source)) {
    damaged(at('source'), 'must be "selection", "view" or "point:<test point id>"')
  }
  return {
    channelId: modes.channelId as string | null,
    source: source as ModesConfig['source'],
    model: oneOf(modes.model, ['oscillation', 'first-order'] as const, at('model')),
    detrend: oneOf(modes.detrend, ['none', 'linear'] as const, at('detrend')),
  }
}
