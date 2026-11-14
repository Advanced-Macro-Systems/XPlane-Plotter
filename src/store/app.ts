// App state (zustand): loaded datasets, the active one, each dataset's workspace (saved per file signature in
// localStorage), the shared zoom range and selection, the open tab, loading progress and toasts.
// Views read with useApp(selector) / the hooks below and change state ONLY through the exported actions.

import { create } from 'zustand'
import { withDerived } from '../core/analysis/derived'
import type { buildDataset } from '../core/buildDataset'
import { DEMO_FILE_NAME, generateDemoFlight } from '../core/demo/generateDemo'
import { downloadText } from '../core/export/download'
import { serializeSession, sessionFileName } from '../core/export/session'
import { ParseError, parseFile, parseText, type RawTable } from '../core/parse'
import { assignSlots, slotsValid } from '../core/slots'
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
import {
  MAX_GROUPS,
  MAX_SERIES,
  defaultWorkspace,
  firstSlots,
  newId,
  nextGroupSlot,
  sanitizeDerived,
  sanitizeWorkspace,
} from './defaults'
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
  action?: ToastAction
}

export interface ToastAction {
  label: string
  run: () => void
  /**
   * The file (dataset id) the action changes or shows: its toast closes when another file becomes active (opened,
   * switched to, or this one closed), and neither its button nor Ctrl/Cmd+Z runs it for another file. An Undo always
   * has one (given, or else the file active when it is shown); every other action about one file passes it too
   * (Start fresh, Plot it, Show), so no action ever changes or shows a file that is no longer on screen.
   */
  datasetId?: string
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
  /**
   * The last try to save a workspace in this browser failed (storage full or blocked): test points last only until
   * the page closes, unless saved as a session file. Cleared by the next save that works.
   */
  saveFailed: boolean
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
  saveFailed: false,
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

/** At most this many toasts show at once; a new one pushes out the oldest. */
const MAX_TOASTS = 4
/** A held toast that is let go again stays at least this long (ms), so it does not vanish under the pointer. */
const TOAST_RESUME_MS = 4000

/**
 * How long a toast shows (ms). One with an action (Undo, Start fresh) stays 20 s: long enough to reach it with the
 * keyboard (WCAG 2.2.1); its time also stops while the pointer is over it or focus is in it (holdToast).
 */
export function toastLifetime(kind: Toast['kind'], hasAction: boolean): number {
  return hasAction ? 20000 : kind === 'error' ? 9000 : 4500
}

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null
  /** When it closes (ms since the epoch) while running */
  due: number
  /** Time left when it was held */
  left: number
  /** Why it is held: the pointer is over it, focus is in it */
  holds: Set<'pointer' | 'focus'>
}

const toastTimers = new Map<number, ToastTimer>()

function runToastTimer(id: number, timer: ToastTimer, ms: number): void {
  timer.due = Date.now() + ms
  timer.handle = setTimeout(() => dismissToast(id), ms)
}

/** True for an action labelled "Undo" (what Ctrl/Cmd+Z runs). */
export function isUndoAction(action: ToastAction | undefined): action is ToastAction {
  return action?.label.trim().toLowerCase() === 'undo'
}

export function toast(message: string, kind: Toast['kind'] = 'info', action?: ToastAction): void {
  toastCounter += 1
  const id = toastCounter
  const kept = get().toasts.slice(-(MAX_TOASTS - 1))
  for (const old of get().toasts) if (!kept.includes(old)) forgetToastTimer(old.id)
  // An Undo belongs to a file: the one it names, else the one active now.
  const activeId = get().activeId
  const scoped =
    isUndoAction(action) && action.datasetId === undefined && activeId !== null ? { ...action, datasetId: activeId } : action
  set({ toasts: [...kept, { id, kind, message, action: scoped }] })
  const timer: ToastTimer = { handle: null, due: 0, left: 0, holds: new Set() }
  toastTimers.set(id, timer)
  runToastTimer(id, timer, toastLifetime(kind, action !== undefined))
}

function forgetToastTimer(id: number): void {
  const timer = toastTimers.get(id)
  if (timer?.handle) clearTimeout(timer.handle)
  toastTimers.delete(id)
}

export function dismissToast(id: number): void {
  forgetToastTimer(id)
  if (get().toasts.some((t) => t.id === id)) set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/**
 * Stops a toast's time while the pointer is over it or focus is in it (`held` true), and lets it run again once
 * neither is (with at least a few seconds left), so nobody loses an Undo they are reaching for.
 */
export function holdToast(id: number, reason: 'pointer' | 'focus', held: boolean): void {
  const timer = toastTimers.get(id)
  if (!timer) return
  if (held) timer.holds.add(reason)
  else timer.holds.delete(reason)
  if (timer.holds.size > 0) {
    if (timer.handle === null) return
    clearTimeout(timer.handle)
    timer.handle = null
    timer.left = Math.max(0, timer.due - Date.now())
  } else if (timer.handle === null) {
    runToastTimer(id, timer, Math.max(timer.left, TOAST_RESUME_MS))
  }
}

/** Whether a toast's action may run now: one that names its file (every Undo) only while that file is the active one. */
function actionInScope(action: ToastAction | undefined, activeId: string | null): boolean {
  return action?.datasetId === undefined || action.datasetId === activeId
}

/**
 * Runs a toast's action (its button, or Ctrl/Cmd+Z for an Undo) and closes the toast. An action whose file is no longer
 * the active one only closes (it never changes or shows a file that is not on screen).
 */
export function runToastAction(id: number): void {
  const item = get().toasts.find((t) => t.id === id)
  dismissToast(id)
  if (item?.action && actionInScope(item.action, get().activeId)) item.action.run()
}

/** The newest toast that offers an Undo for the active file, or null: what Ctrl/Cmd+Z undoes. */
export function latestUndoToast(): Toast | null {
  const { toasts, activeId } = get()
  return toasts.findLast((t) => isUndoAction(t.action) && actionInScope(t.action, activeId)) ?? null
}

// An action that names its file (every Undo; Start fresh, Plot it, Show) belongs to it: when another file becomes
// active (one opened, switched to, or the active one closed), the toasts of the others close, so neither a click nor
// Ctrl/Cmd+Z can reach a file the user no longer sees.
useApp.subscribe((state, previous) => {
  if (state.activeId === previous.activeId) return
  for (const t of state.toasts) {
    if (!actionInScope(t.action, state.activeId)) dismissToast(t.id)
  }
})

// ------------------------------------------------------------------ persistence (per file signature)

const WS_PREFIX = 'xpp:ws:'
const RECENT_KEY = 'xpp:recent'
/** Files listed as recent on the start page. */
const MAX_RECENT = 8
/** Longest file name kept from the stored recent list (a file name is at most 255 characters). */
const MAX_RECENT_NAME = 260

function readSaved(signature: string): unknown {
  try {
    const text = localStorage.getItem(WS_PREFIX + signature)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** Saves one workspace and puts its file first in the recent list; false when the browser refuses (full, blocked). */
function trySave(ds: Dataset, text: string, points: number): boolean {
  try {
    localStorage.setItem(WS_PREFIX + ds.signature, text)
    const recent = readRecent().filter((r) => r.signature !== ds.signature)
    const savedAt = new Date().toISOString()
    recent.unshift({ name: ds.name, signature: ds.signature, rows: ds.rowCount, points, savedAt })
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)))
    return true
  } catch {
    return false
  }
}

/**
 * Frees room: removes the saved workspaces of files that are no longer in the recent list (nothing on the start page
 * leads to them any more), except `keep`'s. Returns how many were removed.
 */
function pruneSaved(keep: string): number {
  try {
    const listed = new Set(readRecent().map((r) => r.signature))
    listed.add(keep)
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(WS_PREFIX) && !listed.has(key.slice(WS_PREFIX.length))) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
    return stale.length
  } catch {
    return 0
  }
}

/** The save-failure warning shows once per page load (the lasting sign is `saveFailed`). */
let saveFailureToastShown = false

function writeSaved(datasetId: string, ds: Dataset, ws: Workspace): void {
  const text = JSON.stringify(ws)
  // Storage full: make room by dropping saved workspaces nothing leads to any more, then try once more.
  const points = ws.points.length
  const saved = trySave(ds, text, points) || (pruneSaved(ds.signature) > 0 && trySave(ds, text, points))
  if (saved) {
    if (get().saveFailed) set({ saveFailed: false })
    return
  }
  // Full or blocked (private window, site data blocked): the workspace lasts only until the tab closes. Say so.
  if (!get().saveFailed) set({ saveFailed: true })
  if (saveFailureToastShown) return
  saveFailureToastShown = true
  toast(
    'This browser could not save your workspace (storage full or blocked): test points will be lost when the page closes. Save a session file to keep them.',
    'error',
    { label: 'Save session', run: () => downloadSession(datasetId) },
  )
}

/** Downloads a dataset's workspace as a session file (the active one when that dataset is closed). */
function downloadSession(datasetId: string): void {
  const { datasets, workspaces, activeId } = get()
  const id = datasets.some((d) => d.id === datasetId) ? datasetId : activeId
  const ds = datasets.find((d) => d.id === id)
  const ws = id ? workspaces[id] : undefined
  if (ds && ws) downloadText(sessionFileName(ds.name), serializeSession(ds, ws), 'application/json')
}

/** One stored recent-file entry, or null when it is not one: anything on this origin can write to localStorage. */
function recentEntry(value: unknown): RecentFile | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (typeof r.signature !== 'string' || !r.signature || typeof r.name !== 'string') return null
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : Number.NaN)
  return {
    name: r.name.slice(0, MAX_RECENT_NAME),
    signature: r.signature,
    rows: count(r.rows),
    points: count(r.points),
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : '',
  }
}

/**
 * Files opened before on this device (newest first) — their workspaces come back when the same file is opened.
 * Entries that are not well formed are left out (and a file listed twice shows once), so a damaged list can never
 * break the start page.
 */
export function readRecent(): RecentFile[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const recent: RecentFile[] = []
    for (const item of parsed) {
      const entry = recentEntry(item)
      if (!entry || seen.has(entry.signature)) continue
      seen.add(entry.signature)
      recent.push(entry)
      if (recent.length === MAX_RECENT) break
    }
    return recent
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
      setTimeout(() => writeSaved(id, ds, ws), 400),
    )
  }
})

// ------------------------------------------------------------------ opening files

let loadAbort: AbortController | null = null
let datasetCounter = 0

type BuildDataset = typeof buildDataset

let datasetBuilder: Promise<BuildDataset> | null = null

/**
 * The dataset builder (core/buildDataset), which reads the channel dictionary (about 200 kB): its own chunk, fetched on
 * demand so the start page never waits for it. main.tsx asks for it before React draws the start page (it downloads
 * while the page is drawn), and opening a file or the demo asks for it at once (it arrives while the file is read), so
 * it is normally there before anyone needs it. A failed fetch (offline, or an old page after a redeploy) is not
 * remembered: the next call tries again.
 */
export function loadDatasetBuilder(): Promise<BuildDataset> {
  datasetBuilder ??= import('../core/buildDataset').then(
    (module) => module.buildDataset,
    (error: unknown) => {
      datasetBuilder = null
      throw new Error(
        `part of the app could not be loaded (${error instanceof Error ? error.message : String(error)}). Reload the page and try again.`,
      )
    },
  )
  return datasetBuilder
}

/** A stored workspace this version can restore: an object with `version: 1` (the rest is sanitised). */
function isWorkspaceV1(value: unknown): value is Record<string, unknown> & { version: 1 } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (value as { version?: unknown }).version === 1
}

function addDataset(
  build: BuildDataset,
  raw: RawTable,
  name: string,
  size: number,
  opts: { restore: boolean; initial?: (ds: Dataset) => Workspace },
): void {
  const base = build(raw, { name, size })
  if (base.rowCount === 0) throw new ParseError(`${name} has a header but no data rows.`)
  datasetCounter += 1
  const id = `ds${datasetCounter}`
  const saved = opts.restore ? readSaved(base.signature) : null
  let dataset: Dataset = { ...base, id }
  let workspace: Workspace | null = null
  let restoredPoints = -1
  let unreadable = false
  if (saved !== null) {
    // Stored data is untrusted (an older or newer app, hand edits, another page on this origin): restore only a
    // well-formed version-1 workspace, formulas checked before they are evaluated; anything else opens the file fresh.
    try {
      if (!isWorkspaceV1(saved)) throw new Error('not a version 1 workspace')
      dataset = withDerived(dataset, sanitizeDerived(saved.derived)).dataset
      workspace = sanitizeWorkspace(saved, dataset)
      restoredPoints = workspace.points.length
    } catch {
      dataset = { ...base, id }
      workspace = null
      unreadable = true
    }
  }
  workspace ??= opts.initial ? sanitizeWorkspace(opts.initial(dataset), dataset) : defaultWorkspace(dataset)
  const opened = workspace
  set((s) => ({
    datasets: [...s.datasets, dataset],
    activeId: id,
    workspaces: { ...s.workspaces, [id]: opened },
    view: null,
    selection: null,
    tab: s.datasets.length === 0 ? 'overview' : s.tab,
  }))
  if (unreadable) toast(`The saved workspace for ${name} could not be read and was ignored.`, 'info')
  if (restoredPoints >= 0) {
    toast(
      restoredPoints > 0
        ? `Restored your workspace for ${name}: ${restoredPoints} test point${restoredPoints === 1 ? '' : 's'}.`
        : `Restored your plot setup for ${name}.`,
      'success',
      startFreshAction(id, defaultWorkspace(dataset)),
    )
  }
}

/**
 * The restore toast's "Start fresh": the file's default workspace, without formulas. It belongs to that file
 * (`datasetId`): the toast closes once another file becomes active, so it never resets a file that is off screen.
 * Built out here so the toast holds only the id and that workspace: a closure made inside addDataset would keep the
 * whole Dataset alive (a function's closures share one context) for as long as anything holds the toast, also after
 * the file is closed.
 */
function startFreshAction(id: string, fresh: Workspace): NonNullable<Toast['action']> {
  return {
    label: 'Start fresh',
    datasetId: id,
    run: () => {
      const current = get().datasets.find((d) => d.id === id)
      if (!current) return
      const plain = withDerived(current, []).dataset
      set((s) => ({
        datasets: s.datasets.map((d) => (d.id === id ? plain : d)),
        workspaces: { ...s.workspaces, [id]: fresh },
      }))
    },
  }
}

/** Opens one or more files (each becomes a dataset; the last opened is active). */
export async function openFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files)
  // Fetched while the file is read (see loadDatasetBuilder); awaited only once the file is parsed.
  if (list.length) void loadDatasetBuilder().catch(() => undefined)
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
      const build = await loadDatasetBuilder()
      // Let the progress bar paint before the (synchronous) build.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (controller.signal.aborted) continue
      addDataset(build, raw, file.name, file.size, { restore: true })
      // The Overview leads with the file's data-quality notes; on another tab, say the first one in a toast (it shows
      // this file's Overview, so it closes once another file is on screen).
      const opened = get().datasets.at(-1)
      const warning = opened?.warnings[0]
      if (opened && warning && get().tab !== 'overview') {
        toast(warning, 'info', { label: 'Show', datasetId: opened.id, run: () => setTab('overview') })
      }
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
  // Fetched while the demo flight is generated (see loadDatasetBuilder).
  void loadDatasetBuilder().catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const text = generateDemoFlight()
    const build = await loadDatasetBuilder()
    addDataset(build, parseText(text), DEMO_FILE_NAME, text.length, { restore: false, initial: demoWorkspace })
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

/**
 * A panel's channels (at most MAX_SERIES) with their colour slots after an edit: the slots given when they fit the
 * channels, else each channel that was in `before` keeps its slot and a new one gets the lowest free slot.
 */
function slottedPanel(panel: PanelConfig, before: PanelConfig | undefined): PanelConfig {
  const channelIds = panel.channelIds.slice(0, MAX_SERIES)
  const given = panel.slots?.slice(0, MAX_SERIES)
  const slots = slotsValid(given, channelIds.length)
    ? given
    : assignSlots(channelIds, before?.channelIds ?? [], before?.slots)
  return { ...panel, channelIds, slots }
}

/**
 * Replaces the panel stack. A panel whose slots do not fit its channels (one edited by a view without them) gets them
 * from the panel with the same id before the change: channels keep their colours, new ones take the lowest free slot.
 */
export function setPanels(panels: PanelConfig[]): void {
  updateWorkspace((ws) => ({
    ...ws,
    panels: panels.map((p) => slottedPanel(p, ws.panels.find((old) => old.id === p.id))),
  }))
}

export function addPanel(channelIds: string[]): string {
  const id = newId('p')
  const ids = channelIds.slice(0, MAX_SERIES)
  updateWorkspace((ws) => ({ ...ws, panels: [...ws.panels, { id, channelIds: ids, slots: firstSlots(ids.length) }] }))
  return id
}

/**
 * Changes a panel. New channelIds keep the colour slot of every channel that stays (removing one never re-colours the
 * others) and give each channel added the lowest slot free in the panel, unless the patch brings its own slots.
 */
export function updatePanel(id: string, patch: Partial<Omit<PanelConfig, 'id'>>): void {
  updateWorkspace((ws) => ({
    ...ws,
    panels: ws.panels
      .map((p) => {
        if (p.id !== id) return p
        if (!patch.channelIds) return { ...p, ...patch }
        return slottedPanel({ ...p, ...patch, slots: patch.slots }, p)
      })
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

/**
 * Adds a test-point group with the next free colour slot and returns its id. A file has at most MAX_GROUPS groups (one
 * slot each: a 9th would repeat a colour). At the limit nothing is added, a toast says so, and the last group's id is
 * returned, so a point saved "in a new group" still lands in a group that exists. Views offer no new group there.
 */
export function addGroup(name: string): string {
  const current = getWorkspace()
  if (current && current.groups.length >= MAX_GROUPS) {
    toast(`A file can have at most ${MAX_GROUPS} test-point groups, one colour each: no group was added.`, 'info')
    return current.groups[current.groups.length - 1].id
  }
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

/**
 * Changes the X–Y settings. New ys keep the colour slot of every Y channel that stays and give each one added the
 * lowest free slot (colour follows the channel, not its place in the list), unless the patch brings its own ySlots.
 */
export function setXY(patch: Partial<XYConfig>): void {
  updateWorkspace((ws) => {
    const ys = (patch.ys ?? ws.xy.ys).slice(0, MAX_SERIES)
    const given = (patch.ySlots ?? (patch.ys ? undefined : ws.xy.ySlots))?.slice(0, MAX_SERIES)
    const ySlots = slotsValid(given, ys.length) ? given : assignSlots(ys, ws.xy.ys, ws.xy.ySlots)
    return { ...ws, xy: { ...ws.xy, ...patch, ys, ySlots } }
  })
}

export function setModes(patch: Partial<ModesConfig>): void {
  updateWorkspace((ws) => ({ ...ws, modes: { ...ws.modes, ...patch } }))
}

export function setTracked(ids: string[]): void {
  updateWorkspace((ws) => ({ ...ws, tracked: [...new Set(ids)] }))
}

/**
 * The workspace with every use of channel `from` (panels, X–Y axes, test-point columns, the Modes channel) moved to
 * `to` in place: each keeps its position, and so its colour slot (PanelConfig.slots, XYConfig.ySlots are parallel).
 */
function renameChannel(ws: Workspace, from: string, to: string): Workspace {
  const swap = (ids: string[]) => ids.map((x) => (x === from ? to : x))
  return {
    ...ws,
    panels: ws.panels.map((p) => ({ ...p, channelIds: swap(p.channelIds) })),
    xy: { ...ws.xy, x: ws.xy.x === from ? to : ws.xy.x, ys: swap(ws.xy.ys) },
    tracked: swap(ws.tracked),
    modes: { ...ws.modes, channelId: ws.modes.channelId === from ? to : ws.modes.channelId },
  }
}

/**
 * Re-evaluates every formula on the active dataset; returns the per-formula errors. `rename` (a formula whose id
 * changed with its name) moves its uses to the new id first: sanitising drops ids the dataset no longer has, so
 * without it a renamed formula would leave its panels and the X–Y plot, and lose its colour slot.
 */
function applyDerived(defs: DerivedDef[], rename?: { from: string; to: string }): { id: string; message: string }[] {
  const { activeId, datasets, workspaces } = get()
  const ds = getActiveDataset()
  if (!activeId || !ds || !workspaces[activeId]) return [{ id: '', message: 'No file is open.' }]
  const { dataset, errors } = withDerived(ds, defs)
  const failed = new Set(errors.map((e) => e.id))
  const kept = defs.filter((d) => !failed.has(d.id))
  const ws = rename ? renameChannel(workspaces[activeId], rename.from, rename.to) : workspaces[activeId]
  set({
    datasets: datasets.map((d) => (d.id === activeId ? dataset : d)),
    // Formulas that failed are not saved; channel references to removed formulas are dropped by sanitizing.
    workspaces: { ...workspaces, [activeId]: sanitizeWorkspace({ ...ws, derived: kept }, dataset) },
  })
  return errors
}

/**
 * Adds (or, when `replaceId` is given, replaces) a formula channel. The id is "fx:<slug>" of the name, made unique; a
 * formula renamed to a new id keeps its panels, X–Y place, test-point column and Modes channel, with its colour slots.
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
  // A renamed formula (its id follows its name) stays where it was used, under its new id.
  applyDerived(defs, replaceId && replaceId !== id ? { from: replaceId, to: id } : undefined)
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
  const { dataset } = withDerived(ds, sanitizeDerived(input.derived))
  const workspace = sanitizeWorkspace(input, dataset)
  set((s) => ({
    datasets: s.datasets.map((d) => (d.id === activeId ? dataset : d)),
    workspaces: { ...s.workspaces, [activeId]: workspace },
    view: null,
    selection: null,
  }))
}
