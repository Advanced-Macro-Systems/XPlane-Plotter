// App state (zustand): loaded datasets, the active one, each dataset's workspace (saved per file signature in
// localStorage), the shared zoom range and selection, the open tab, loading progress and toasts.
// Views read with useApp(selector) / the hooks below and change state ONLY through the exported actions.

import { create } from 'zustand'
import { withDerived } from '../core/analysis/derived'
import { buildDataset } from '../core/dataset'
import { DEMO_FILE_NAME, generateDemoFlight } from '../core/demo/generateDemo'
import { ParseError, parseFile, parseText, type RawTable } from '../core/parse'
import type {
  Dataset,
  DerivedDef,
  ModesConfig,
  PanelConfig,
  PointGroup,
  RowRange,
  TabId,
  TestPoint,
  TimeBaseId,
  Workspace,
  XYConfig,
} from '../core/types'
import { MAX_SERIES, defaultWorkspace, newId, nextGroupSlot, sanitizeWorkspace } from './defaults'
import { demoWorkspace } from './demoWorkspace'

export interface LoadingState {
  name: string
  phase: 'reading' | 'building'
  /** 0..1 while reading */
  progress: number
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  action?: { label: string; run: () => void }
}

export interface RecentFile {
  name: string
  signature: string
  rows: number
  points: number
  savedAt: string
}

/** How another view wants the Channels tab to open (see openChannels). */
export interface ChannelsRequest {
  /** Show only this group (a group id from core/channels/groups) */
  group?: string
  /** Bring the constant channels to the top */
  constant?: boolean
}

export interface AppState {
  datasets: Dataset[]
  activeId: string | null
  loading: LoadingState | null
  tab: TabId
  /** By dataset id */
  workspaces: Record<string, Workspace>
  /** Time-history zoom as rows (null = whole file). Shared by X–Y ("zoom range" source) and Modes. */
  view: RowRange | null
  /** Current drag-selection as rows (null = none) */
  selection: RowRange | null
  /** Filter for the Channels tab to start with, set by openChannels and taken (cleared) by the Channels view */
  channelsRequest: ChannelsRequest | null
  toasts: Toast[]
}

export const useApp = create<AppState>(() => ({
  datasets: [],
  activeId: null,
  loading: null,
  tab: 'overview',
  workspaces: {},
  view: null,
  selection: null,
  channelsRequest: null,
  toasts: [],
}))

const set = useApp.setState
const get = useApp.getState

// ------------------------------------------------------------------ selectors

export function getActiveDataset(): Dataset | null {
  const { datasets, activeId } = get()
  return datasets.find((d) => d.id === activeId) ?? null
}

export function getWorkspace(): Workspace | null {
  const { workspaces, activeId } = get()
  return activeId ? (workspaces[activeId] ?? null) : null
}

export function useActiveDataset(): Dataset | null {
  return useApp((s) => s.datasets.find((d) => d.id === s.activeId) ?? null)
}

export function useWorkspace(): Workspace | null {
  return useApp((s) => (s.activeId ? (s.workspaces[s.activeId] ?? null) : null))
}

// ------------------------------------------------------------------ toasts

let toastCounter = 0

export function toast(message: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  toastCounter += 1
  const id = toastCounter
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message, action }] }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : action ? 8000 : 4500)
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

// ------------------------------------------------------------------ persistence (per file signature)

const WS_PREFIX = 'xpp:ws:'
const RECENT_KEY = 'xpp:recent'

function readSaved(signature: string): unknown {
  try {
    const text = localStorage.getItem(WS_PREFIX + signature)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function writeSaved(ds: Dataset, ws: Workspace): void {
  try {
    localStorage.setItem(WS_PREFIX + ds.signature, JSON.stringify(ws))
    const recent = readRecent().filter((r) => r.signature !== ds.signature)
    recent.unshift({
      name: ds.name,
      signature: ds.signature,
      rows: ds.rowCount,
      points: ws.points.length,
      savedAt: new Date().toISOString(),
    })
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 8)))
  } catch {
    // Storage full or unavailable: the workspace lasts until the tab is closed.
  }
}

/** Files opened before on this device (newest first) — their workspaces come back when the same file is opened. */
export function readRecent(): RecentFile[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as RecentFile[]).filter((r) => r && typeof r.signature === 'string') : []
  } catch {
    return []
  }
}

export function forgetRecent(signature: string): void {
  try {
    localStorage.removeItem(WS_PREFIX + signature)
    localStorage.setItem(RECENT_KEY, JSON.stringify(readRecent().filter((r) => r.signature !== signature)))
  } catch {
    // ignore
  }
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
useApp.subscribe((state, previous) => {
  if (state.workspaces === previous.workspaces) return
  for (const [id, ws] of Object.entries(state.workspaces)) {
    if (previous.workspaces[id] === ws) continue
    const ds = state.datasets.find((d) => d.id === id)
    if (!ds || ds.name === DEMO_FILE_NAME) continue
    clearTimeout(saveTimers.get(id))
    saveTimers.set(
      id,
      setTimeout(() => writeSaved(ds, ws), 400),
    )
  }
})

// ------------------------------------------------------------------ opening files

let loadAbort: AbortController | null = null
let datasetCounter = 0

function addDataset(
  raw: RawTable,
  name: string,
  size: number,
  opts: { restore: boolean; initial?: (ds: Dataset) => Workspace },
): void {
  const base = buildDataset(raw, { name, size })
  if (base.rowCount === 0) throw new ParseError(`${name} has a header but no data rows.`)
  datasetCounter += 1
  const id = `ds${datasetCounter}`
  const saved = opts.restore ? readSaved(base.signature) : null
  let dataset: Dataset = { ...base, id }
  let workspace: Workspace
  let restoredPoints = -1
  if (saved && typeof saved === 'object') {
    const defs = Array.isArray((saved as Workspace).derived) ? (saved as Workspace).derived : []
    const derived = withDerived(dataset, defs)
    dataset = derived.dataset
    workspace = sanitizeWorkspace(saved, dataset)
    restoredPoints = workspace.points.length
  } else {
    workspace = opts.initial ? sanitizeWorkspace(opts.initial(dataset), dataset) : defaultWorkspace(dataset)
  }
  set((s) => ({
    datasets: [...s.datasets, dataset],
    activeId: id,
    workspaces: { ...s.workspaces, [id]: workspace },
    view: null,
    selection: null,
    tab: s.datasets.length === 0 ? 'overview' : s.tab,
  }))
  if (restoredPoints >= 0) {
    const fresh = defaultWorkspace(dataset)
    toast(
      restoredPoints > 0
        ? `Restored your workspace for ${name}: ${restoredPoints} test point${restoredPoints === 1 ? '' : 's'}.`
        : `Restored your plot setup for ${name}.`,
      'success',
      {
        label: 'Start fresh',
        run: () => {
          const current = get().datasets.find((d) => d.id === id)
          if (!current) return
          const plain = withDerived(current, []).dataset
          set((s) => ({
            datasets: s.datasets.map((d) => (d.id === id ? plain : d)),
            workspaces: { ...s.workspaces, [id]: { ...fresh, panels: fresh.panels } },
          }))
        },
      },
    )
  }
}

/** Opens one or more files (each becomes a dataset; the last opened is active). */
export async function openFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files)
  for (const file of list) {
    loadAbort?.abort()
    const controller = new AbortController()
    loadAbort = controller
    set({ loading: { name: file.name, phase: 'reading', progress: 0 } })
    try {
      let lastPaint = 0
      const raw = await parseFile(
        file,
        (fraction) => {
          const now = performance.now()
          if (now - lastPaint < 60 && fraction < 1) return
          lastPaint = now
          set({ loading: { name: file.name, phase: 'reading', progress: fraction } })
        },
        controller.signal,
      )
      set({ loading: { name: file.name, phase: 'building', progress: 1 } })
      // Let the progress bar paint before the (synchronous) build.
      await new Promise((resolve) => setTimeout(resolve, 0))
      addDataset(raw, file.name, file.size, { restore: true })
      for (const warning of get().datasets.at(-1)?.warnings.slice(0, 1) ?? []) toast(warning, 'info')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') continue
      const message =
        error instanceof ParseError
          ? error.message
          : error instanceof RangeError
            ? `${file.name} is too large for this browser's memory. Try logging fewer Data Output rows or a lower rate.`
            : `Could not open ${file.name}: ${error instanceof Error ? error.message : String(error)}`
      toast(message, 'error')
    } finally {
      if (loadAbort === controller) {
        loadAbort = null
        set({ loading: null })
      }
    }
  }
}

export function cancelLoading(): void {
  loadAbort?.abort()
  loadAbort = null
  set({ loading: null })
}

/** Loads the synthetic demo flight. */
export async function openDemo(): Promise<void> {
  set({ loading: { name: DEMO_FILE_NAME, phase: 'building', progress: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const text = generateDemoFlight()
    addDataset(parseText(text), DEMO_FILE_NAME, text.length, { restore: false, initial: demoWorkspace })
    toast(
      'Demo flight loaded with its trim points and dynamic-mode windows marked. It is synthetic: explore with it, never use it as flight-test evidence.',
      'info',
    )
  } catch (error) {
    toast(`Could not build the demo: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    set({ loading: null })
  }
}

export function closeDataset(id: string): void {
  set((s) => {
    const datasets = s.datasets.filter((d) => d.id !== id)
    const workspaces = { ...s.workspaces }
    delete workspaces[id]
    const activeId = s.activeId === id ? (datasets.at(-1)?.id ?? null) : s.activeId
    return {
      datasets,
      workspaces,
      activeId,
      view: s.activeId === id ? null : s.view,
      selection: s.activeId === id ? null : s.selection,
    }
  })
}

export function setActive(id: string): void {
  if (get().activeId === id) return
  set({ activeId: id, view: null, selection: null })
}

export function setTab(tab: TabId): void {
  set({ tab })
}

/** Opens the Channels tab showing one group, or with the constant channels first (the Overview's links). */
export function openChannels(request: ChannelsRequest): void {
  set({ tab: 'channels', channelsRequest: request })
}

/** The Channels view applied the request: forget it, so the tab later reopens as the user left it. */
export function clearChannelsRequest(): void {
  if (get().channelsRequest) set({ channelsRequest: null })
}

// ------------------------------------------------------------------ zoom range and selection (rows)

function clampRange(range: RowRange | null): RowRange | null {
  const ds = getActiveDataset()
  if (!range || !ds) return null
  const start = Math.max(0, Math.min(ds.rowCount - 1, Math.floor(Math.min(range[0], range[1]))))
  const end = Math.max(start + 1, Math.min(ds.rowCount, Math.ceil(Math.max(range[0], range[1]))))
  return [start, end]
}

export function setView(range: RowRange | null): void {
  const next = clampRange(range)
  const ds = getActiveDataset()
  // The whole file is "no zoom".
  set({ view: next && ds && next[0] === 0 && next[1] === ds.rowCount ? null : next })
}

export function setSelection(range: RowRange | null): void {
  set({ selection: clampRange(range) })
}

// ------------------------------------------------------------------ workspace edits (active dataset)

/** Replaces the active workspace with `update(current)`. No-op without an active dataset. */
export function updateWorkspace(update: (ws: Workspace) => Workspace): void {
  const { activeId, workspaces } = get()
  if (!activeId || !workspaces[activeId]) return
  set({ workspaces: { ...workspaces, [activeId]: update(workspaces[activeId]) } })
}

export function setTimeBase(timeBase: TimeBaseId): void {
  updateWorkspace((ws) => ({ ...ws, timeBase }))
}

export function setPanels(panels: PanelConfig[]): void {
  updateWorkspace((ws) => ({ ...ws, panels }))
}

export function addPanel(channelIds: string[]): string {
  const id = newId('p')
  updateWorkspace((ws) => ({ ...ws, panels: [...ws.panels, { id, channelIds: channelIds.slice(0, MAX_SERIES) }] }))
  return id
}

export function updatePanel(id: string, patch: Partial<Omit<PanelConfig, 'id'>>): void {
  updateWorkspace((ws) => ({
    ...ws,
    panels: ws.panels
      .map((p) =>
        p.id === id
          ? { ...p, ...patch, channelIds: (patch.channelIds ?? p.channelIds).slice(0, MAX_SERIES) }
          : p,
      )
      .filter((p) => p.channelIds.length > 0),
  }))
}

export function removePanel(id: string): void {
  updateWorkspace((ws) => ({ ...ws, panels: ws.panels.filter((p) => p.id !== id) }))
}

export function movePanel(id: string, delta: -1 | 1): void {
  updateWorkspace((ws) => {
    const index = ws.panels.findIndex((p) => p.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= ws.panels.length) return ws
    const panels = [...ws.panels]
    ;[panels[index], panels[target]] = [panels[target], panels[index]]
    return { ...ws, panels }
  })
}

export function addPoint(point: Omit<TestPoint, 'id'>): string {
  const id = newId('t')
  updateWorkspace((ws) => ({ ...ws, points: [...ws.points, { ...point, id }] }))
  return id
}

export function updatePoint(id: string, patch: Partial<Omit<TestPoint, 'id'>>): void {
  updateWorkspace((ws) => ({ ...ws, points: ws.points.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
}

export function removePoint(id: string): void {
  updateWorkspace((ws) => ({
    ...ws,
    points: ws.points.filter((p) => p.id !== id),
    modes: ws.modes.source === `point:${id}` ? { ...ws.modes, source: 'selection' } : ws.modes,
  }))
}

export function addGroup(name: string): string {
  const id = newId('g')
  updateWorkspace((ws) => ({
    ...ws,
    groups: [...ws.groups, { id, name: name.trim() || `Test ${ws.groups.length + 1}`, slot: nextGroupSlot(ws.groups) }],
  }))
  return id
}

export function updateGroup(id: string, patch: Partial<Omit<PointGroup, 'id'>>): void {
  updateWorkspace((ws) => ({ ...ws, groups: ws.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }))
}

/** Removes a group, moving its points to the first remaining group. The last group cannot be removed. */
export function removeGroup(id: string): void {
  updateWorkspace((ws) => {
    if (ws.groups.length <= 1) return ws
    const groups = ws.groups.filter((g) => g.id !== id)
    return {
      ...ws,
      groups,
      points: ws.points.map((p) => (p.groupId === id ? { ...p, groupId: groups[0].id } : p)),
    }
  })
}

export function setXY(patch: Partial<XYConfig>): void {
  updateWorkspace((ws) => ({
    ...ws,
    xy: { ...ws.xy, ...patch, ys: (patch.ys ?? ws.xy.ys).slice(0, MAX_SERIES) },
  }))
}

export function setModes(patch: Partial<ModesConfig>): void {
  updateWorkspace((ws) => ({ ...ws, modes: { ...ws.modes, ...patch } }))
}

export function setTracked(ids: string[]): void {
  updateWorkspace((ws) => ({ ...ws, tracked: [...new Set(ids)] }))
}

/** Re-evaluates every formula on the active dataset; returns the per-formula errors. */
function applyDerived(defs: DerivedDef[]): { id: string; message: string }[] {
  const { activeId, datasets, workspaces } = get()
  const ds = getActiveDataset()
  if (!activeId || !ds || !workspaces[activeId]) return [{ id: '', message: 'No file is open.' }]
  const { dataset, errors } = withDerived(ds, defs)
  const failed = new Set(errors.map((e) => e.id))
  const kept = defs.filter((d) => !failed.has(d.id))
  const ws = workspaces[activeId]
  set({
    datasets: datasets.map((d) => (d.id === activeId ? dataset : d)),
    // Formulas that failed are not saved; channel references to removed formulas are dropped by sanitizing.
    workspaces: { ...workspaces, [activeId]: sanitizeWorkspace({ ...ws, derived: kept }, dataset) },
  })
  return errors
}

/**
 * Adds (or, when `replaceId` is given, replaces) a formula channel. The id is "fx:<slug>" of the name, made unique.
 * Returns the new channel id, or an error message (and changes nothing) when the formula does not evaluate.
 */
export function saveDerived(
  def: { name: string; unit: string; expression: string },
  slug: string,
  replaceId?: string,
): { ok: true; id: string } | { ok: false; error: string } {
  const ws = getWorkspace()
  const ds = getActiveDataset()
  if (!ws || !ds) return { ok: false, error: 'No file is open.' }
  const taken = new Set(ds.channels.map((c) => c.id))
  if (replaceId) taken.delete(replaceId)
  let id = `fx:${slug}`
  for (let n = 2; taken.has(id); n += 1) id = `fx:${slug}_${n}`
  const nextDef: DerivedDef = { id, name: def.name.trim(), unit: def.unit.trim(), expression: def.expression.trim() }
  const defs = replaceId ? ws.derived.map((d) => (d.id === replaceId ? nextDef : d)) : [...ws.derived, nextDef]
  // Dry run first so a broken formula never disturbs the workspace.
  const trial = withDerived(ds, defs)
  const error = trial.errors.find((e) => e.id === id)
  if (error) return { ok: false, error: error.message }
  applyDerived(defs)
  if (replaceId && replaceId !== id) {
    // Point panels / plots that used the old id at the renamed channel.
    const swap = (ids: string[]) => ids.map((x) => (x === replaceId ? id : x))
    updateWorkspace((w) => ({
      ...w,
      panels: w.panels.map((p) => ({ ...p, channelIds: swap(p.channelIds) })),
      xy: { ...w.xy, x: w.xy.x === replaceId ? id : w.xy.x, ys: swap(w.xy.ys) },
      tracked: swap(w.tracked),
      modes: { ...w.modes, channelId: w.modes.channelId === replaceId ? id : w.modes.channelId },
    }))
  }
  return { ok: true, id }
}

export function removeDerived(id: string): void {
  const ws = getWorkspace()
  if (!ws) return
  applyDerived(ws.derived.filter((d) => d.id !== id))
}

/** Replaces the active workspace with an imported one (session file), after sanitising it for this dataset. */
export function importWorkspace(input: Workspace): void {
  const ds = getActiveDataset()
  const { activeId } = get()
  if (!ds || !activeId) return
  const defs = Array.isArray(input.derived) ? input.derived : []
  const { dataset } = withDerived(ds, defs)
  const workspace = sanitizeWorkspace(input, dataset)
  set((s) => ({
    datasets: s.datasets.map((d) => (d.id === activeId ? dataset : d)),
    workspaces: { ...s.workspaces, [activeId]: workspace },
    view: null,
    selection: null,
  }))
}
