// Pure helpers for the app shell (header, tab bar, landing, overlays): tab order, keyboard rules and the short texts
// the shell shows. No React, no store at runtime (type imports only), so it is unit-tested in node.

import type { Dataset, RowRange, TabId, TestPoint, Workspace } from '../core/types'
import type { LoadingState, RecentFile } from '../store/app'

/** Tabs in the order of the tab bar (and of the 1–6 keyboard shortcuts). */
export const TAB_ORDER: readonly TabId[] = ['overview', 'time', 'xy', 'points', 'modes', 'channels']

export const TAB_NAMES: Readonly<Record<TabId, string>> = {
  overview: 'Overview',
  time: 'Time history',
  xy: 'X–Y plot',
  points: 'Test points',
  modes: 'Dynamic modes',
  channels: 'Channels',
}

/** The help dialog's sections. */
export type HelpSection = 'record' | 'use' | 'about'

// ------------------------------------------------------------------ keyboard

/** "1".."6" -> the tab in that position of the tab bar; anything else -> null. */
export function tabForKey(key: string): TabId | null {
  if (!/^[1-9]$/.test(key)) return null
  return TAB_ORDER[Number(key) - 1] ?? null
}

/** Inputs that take no typed text: digits pressed while one of these has focus may still switch tabs. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'])

/** Whether a key event's target is somewhere the user types: a text input, a text area, a select, editable content. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown }
  if (el.isContentEditable === true) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = typeof el.type === 'string' ? el.type.toLowerCase() : 'text'
  return !NON_TEXT_INPUTS.has(type)
}

/** The parts of a KeyboardEvent the shortcuts look at. */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  target: unknown
  defaultPrevented?: boolean
  isComposing?: boolean
}

export type ShortcutAction = { kind: 'tab'; tab: TabId } | { kind: 'open' } | { kind: 'help' } | null

/**
 * The global shortcuts: Ctrl/Cmd+O opens the file picker (anywhere); "1".."6" switch tabs and "?" opens the help,
 * but only when focus is not in something that takes text, no dialog is open and no modifier is held.
 */
export function shortcutFor(event: KeyLike, ctx: { hasDataset: boolean; dialogOpen: boolean }): ShortcutAction {
  if (event.defaultPrevented || event.isComposing) return null
  const command = event.ctrlKey || event.metaKey
  if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o') return { kind: 'open' }
  if (command || event.altKey) return null
  if (ctx.dialogOpen || isTypingTarget(event.target)) return null
  if (event.key === '?') return { kind: 'help' }
  const tab = tabForKey(event.key)
  return tab && ctx.hasDataset ? { kind: 'tab', tab } : null
}

// ------------------------------------------------------------------ text

const COUNT = new Intl.NumberFormat('en-GB')

/** 12345 -> "12,345" */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? COUNT.format(value) : '—'
}

/** n and the noun, pluralised with "s" unless a plural is given: "1 row", "5 rows", "2 test points". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`
}

/** File sizes in decimal units, 3 significant figures: "812 B", "45.2 kB", "12.3 MB", "1.25 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${Number(value.toPrecision(3))} ${units[unit]}`
}

/** "12,345 rows · 173 ch" for the dataset switcher. */
export function datasetSummary(ds: Pick<Dataset, 'rowCount' | 'channels'>): string {
  return `${plural(ds.rowCount, 'row')} · ${formatCount(ds.channels.length)} ch`
}

/** The loading card's phase line: "Reading… 42%" while reading, then "Building channels…". */
export function loadingText(loading: Pick<LoadingState, 'phase' | 'progress'>, demo: boolean): string {
  if (loading.phase === 'reading') {
    const percent = Math.max(0, Math.min(100, Math.floor((Number.isFinite(loading.progress) ? loading.progress : 0) * 100)))
    return `Reading… ${percent}%`
  }
  return demo ? 'Generating the demo flight…' : 'Building channels…'
}

/**
 * rangeText's "from – to · duration" (components/hooks.ts) split into its two parts, for the zoom chip (the span) and
 * the selection chip (the duration).
 */
export function splitRangeText(text: string): { span: string; duration: string } {
  const at = text.lastIndexOf(' · ')
  return at < 0 ? { span: text, duration: '' } : { span: text.slice(0, at), duration: text.slice(at + 3) }
}

/** "120.0 s – 340.5 s" -> "120.0 – 340.5 s"; "row 10 – row 99" -> "rows 10–99"; clock times stay as they are. */
export function compactSpan(span: string): string {
  const rows = /^row (\S+) – row (\S+)$/.exec(span)
  if (rows) return `rows ${rows[1]}–${rows[2]}`
  const sameUnit = /^(\S+) (\S+) – (\S+) \2$/.exec(span)
  if (sameUnit) return `${sameUnit[1]} – ${sameUnit[3]} ${sameUnit[2]}`
  return span
}

/** When a recent file was last saved: "Today, 14:02", "Yesterday, 09:15", else "12 Nov 2026". */
export function recentWhen(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "12,345 rows · 5 test points" (or "· no test points") for a recent file. */
export function recentSummary(recent: Pick<RecentFile, 'rows' | 'points'>): string {
  const rows = Number.isFinite(recent.rows) ? plural(recent.rows, 'row') : ''
  const points = !Number.isFinite(recent.points) ? '' : recent.points === 0 ? 'no test points' : plural(recent.points, 'test point')
  return [rows, points].filter(Boolean).join(' · ')
}

// ------------------------------------------------------------------ the tab bar on narrow screens

/** Which edges of a sideways-scrolling strip hide content: null when everything is in sight. */
export type FadeEdges = 'left' | 'right' | 'both' | null

export function fadeEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): FadeEdges {
  // A pixel of slack: zoomed pages report fractional scroll positions.
  const left = scrollLeft > 1
  const right = scrollLeft + clientWidth < scrollWidth - 1
  return left && right ? 'both' : left ? 'left' : right ? 'right' : null
}

/**
 * The scroll position that brings an item fully into a strip's view, with `margin` px to spare beside it (the edge
 * fade), clamped to the strip; null when the item is already in sight.
 */
export function scrollToReveal(
  itemLeft: number,
  itemWidth: number,
  viewLeft: number,
  viewWidth: number,
  margin = 0,
): number | null {
  const roomy = Math.max(0, Math.min(margin, (viewWidth - itemWidth) / 2))
  if (itemLeft - roomy < viewLeft) return Math.max(0, itemLeft - roomy)
  if (itemLeft + itemWidth + roomy > viewLeft + viewWidth) return Math.max(0, itemLeft + itemWidth + roomy - viewWidth)
  return null
}

/**
 * Text with `code` spans (the recording guide marks header tokens such as `_totl,_time` with backticks) as plain and
 * code segments in order. A text with an unmatched backtick stays plain.
 */
export function codeSegments(text: string): { text: string; code: boolean }[] {
  const parts = text.split('`')
  if (parts.length % 2 === 0) return [{ text, code: false }]
  return parts.map((part, i) => ({ text: part, code: i % 2 === 1 })).filter((segment) => segment.text.length > 0)
}

/** Whether a drag carries files from the computer (not text or a link dragged inside the page). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files')
}

/**
 * Whether an error is a view's code failing to download (Chrome, Firefox and Safari word it differently): typically
 * the site was redeployed while the page stayed open, so only a reload helps.
 */
export function isChunkLoadError(message: string): boolean {
  return /dynamically imported module|importing a module script failed|error loading dynamically imported/i.test(message)
}

/** Session files are routed to "load session" instead of being parsed as flight logs. */
export function isSessionFileName(name: string): boolean {
  return /\.json$/i.test(name.trim())
}

// ------------------------------------------------------------------ exports

/**
 * The rows of the current mode window for the MATLAB export: the drag selection, the zoom range, or the test point
 * the Dynamic modes tab analyses; null when that window does not exist (the script then skips the fit with a note).
 */
export function modeRowsFor(
  ws: Pick<Workspace, 'modes' | 'points'>,
  selection: RowRange | null,
  view: RowRange | null,
): RowRange | null {
  const source = ws.modes.source
  if (source === 'selection') return selection
  if (source === 'view') return view
  const point: TestPoint | undefined = ws.points.find((p) => `point:${p.id}` === source)
  return point ? [point.start, point.end] : null
}

/** The stem of a file name without its extension ("Data 737.txt" -> "Data 737"). */
export function fileStem(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || name
}

/** A MATLAB script of one tab's plot: the time histories, the X–Y plot (with the test-point table), the mode fit. */
export type MatlabPart = 'time' | 'xy' | 'modes'

/** What each MATLAB script holds (null = the whole workspace), for the message after saving it. */
const MATLAB_CONTENTS: Readonly<Record<MatlabPart | 'all', string>> = {
  all: 'test-point table, X–Y plot, time histories and mode fit',
  time: 'time histories',
  xy: 'test-point table and X–Y plot',
  modes: 'mode fit',
}

/**
 * The file name of a one-plot MATLAB script, from the whole-workspace one: "xpp_Data_run1.m" + 'xy' ->
 * "xpp_Data_run1_xy.m", still at most 63 characters before ".m" so MATLAB can run it by name. The whole-workspace
 * script keeps the plain name: the one run_all.m and the help refer to.
 */
export function matlabPartName(wholeName: string, part: MatlabPart | null): string {
  if (!part) return wholeName
  const suffix = `_${part}`
  const stem = wholeName.replace(/\.m$/, '')
  return `${stem.slice(0, 63 - suffix.length).replace(/_+$/, '')}${suffix}.m`
}

/** The one message after any MATLAB export, whichever tab it came from. */
export function matlabSavedText(name: string, part: MatlabPart | null, logName: string): string {
  return `Saved ${name} (${MATLAB_CONTENTS[part ?? 'all']}). Put it next to ${logName} and run it in MATLAB: figures and tables go to ./out/.`
}
