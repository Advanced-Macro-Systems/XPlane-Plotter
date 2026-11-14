// What the shell does with files: open logs (and route session files to "load session"), save and load sessions, and
// the exports: the whole-file ones offered on the Overview and the MATLAB scripts every tab writes (one helper, one
// naming scheme, one message). Store-bound: everything goes through the store's actions.

import { DEMO_FILE_NAME, generateDemoFlight } from '../core/demo/generateDemo'
import { datasetCsv } from '../core/export/csv'
import { downloadText, safeFilename } from '../core/export/download'
import { matlabScript, matlabScriptName, type MatlabExportOptions } from '../core/export/matlab'
import { MAX_SESSION_BYTES, parseSession, serializeSession, sessionFileName, type SessionFile } from '../core/export/session'
import type { RowRange } from '../core/types'
import { getActiveDataset, getWorkspace, openDemo, openFiles, setActive, toast, useApp } from '../store/app'
import { fileStem, isSessionFileName, matlabPartName, matlabSavedText, modeRowsFor, type MatlabPart } from './shellModel'

/** Opens picked or dropped files: logs first (each becomes a dataset), then any session files onto the active one. */
export async function openPickedFiles(files: readonly File[]): Promise<void> {
  const logs = files.filter((f) => !isSessionFileName(f.name))
  const sessions = files.filter((f) => isSessionFileName(f.name))
  if (logs.length) await openFiles(logs)
  // One session at a time: it replaces the workspace, after a question.
  if (sessions.length) await loadSessionFile(sessions[sessions.length - 1])
}

/** Switches to the demo flight when it is already open, else builds it. */
export function showDemo(): void {
  const open = useApp.getState().datasets.find((d) => d.name === DEMO_FILE_NAME)
  if (open) setActive(open.id)
  else void openDemo()
}

/** Downloads the active workspace as a session file (every Save session offers this one name). */
export function saveSessionFile(): void {
  const ds = getActiveDataset()
  const ws = getWorkspace()
  if (!ds || !ws) return
  downloadText(sessionFileName(ds.name), serializeSession(ds, ws), 'application/json')
}

// ------------------------------------------------------------------ loading a session (asks first)

/** A session file read and waiting for "Replace workspace" in the import dialog, for the dataset it was opened onto. */
export interface PendingSession {
  session: SessionFile
  datasetId: string
}

let pendingSession: PendingSession | null = null
const pendingListeners = new Set<() => void>()

function notifyPending(): void {
  for (const listener of pendingListeners) listener()
}

/**
 * Reads a session file for the active dataset and asks before it replaces the workspace (the shell shows the import
 * dialog: whether it was saved for this recording, what it holds). Nothing changes until the user confirms.
 */
export async function loadSessionFile(file: File): Promise<void> {
  const ds = getActiveDataset()
  if (!ds) {
    toast(`Open the flight log first, then load its session file (${file.name}).`, 'error')
    return
  }
  // Turned away by its size before it is read: a session file is small.
  if (file.size > MAX_SESSION_BYTES) {
    toast(`${file.name} is far too large to be an X-Plane Plotter session file.`, 'error')
    return
  }
  let text: string
  try {
    text = await file.text()
  } catch {
    toast(`Could not read ${file.name}.`, 'error')
    return
  }
  try {
    askToImportSession(parseSession(text))
  } catch (error) {
    // parseSession's messages are written for people.
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** Shows the import dialog for a parsed session file, onto the active dataset. */
export function askToImportSession(session: SessionFile): void {
  const ds = getActiveDataset()
  if (!ds) return
  pendingSession = { session, datasetId: ds.id }
  notifyPending()
}

/** The import dialog closed (imported or cancelled). */
export function closeSessionImport(): void {
  if (!pendingSession) return
  pendingSession = null
  notifyPending()
}

export function subscribePendingSession(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

export function getPendingSession(): PendingSession | null {
  return pendingSession
}

// ------------------------------------------------------------------ MATLAB scripts

const MATLAB_INCLUDES: Readonly<Record<MatlabPart | 'all', MatlabExportOptions['include']>> = {
  all: { points: true, xy: true, time: true, modes: true },
  time: { points: false, xy: false, time: true, modes: false },
  xy: { points: true, xy: true, time: false, modes: false },
  modes: { points: false, xy: false, time: false, modes: true },
}

export interface MatlabExportRequest {
  /** One tab's plot, or null for the whole workspace (the script run_all.m runs) */
  part: MatlabPart | null
  /** Rows of the time histories (default: the zoom range; null = the whole log) */
  view?: RowRange | null
  /** Rows of the mode fit (default: the window Dynamic modes analyses) */
  modeRows?: RowRange | null
  /**
   * The X–Y axis ranges the app shows, so the script's fit through the samples leaves out the same off-axis samples.
   * The X–Y tab passes its own (they follow "Show all"); otherwise they are worked out from the workspace.
   */
  xyLimits?: MatlabExportOptions['xyLimits']
}

/**
 * Writes and downloads a MATLAB script, the whole workspace ("xpp_<log>.m") or one tab's plot ("xpp_<log>_xy.m"), and
 * says the same thing from every tab: the file name, what it holds and where to run it.
 */
export async function exportMatlab(request: MatlabExportRequest): Promise<void> {
  const ds = getActiveDataset()
  const ws = getWorkspace()
  if (!ds || !ws) return
  const { selection, view } = useApp.getState()
  const include = MATLAB_INCLUDES[request.part ?? 'all']
  try {
    let xyLimits = request.xyLimits
    if (include.xy && xyLimits === undefined) {
      // Loaded on demand: the X–Y model is not part of the start page.
      const { xyAxisLimits } = await import('../views/xy/xyLimits')
      xyLimits = xyAxisLimits(ds, ws, view)
    }
    const script = matlabScript({
      ds,
      ws,
      include,
      view: request.view !== undefined ? request.view : view,
      modeRows: request.modeRows !== undefined ? request.modeRows : modeRowsFor(ws, selection, view),
      xyLimits,
    })
    const name = matlabPartName(matlabScriptName(ds.name), request.part)
    downloadText(name, script, 'text/plain')
    toast(matlabSavedText(name, request.part, ds.name), 'success')
  } catch (error) {
    toast(`Could not write the MATLAB script: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/** The MATLAB script for the whole workspace: test points, X–Y, time histories (over the zoom) and the mode fit. */
export function exportMatlabScript(): void {
  void exportMatlab({ part: null })
}

// ------------------------------------------------------------------ whole-file exports

/** Every row and channel (formulas included), with the time columns first. */
export function exportAllChannelsCsv(): void {
  const ds = getActiveDataset()
  if (!ds) return
  const text = datasetCsv(ds, { channelIds: ds.channels.map((ch) => ch.id), ranges: null, includeTime: true, delimiter: ',' })
  downloadText(`${safeFilename(fileStem(ds.name), 'data')}.csv`, text, 'text/csv')
}

/** The synthetic demo log itself, so the exported MATLAB script has a file to read. */
export function downloadDemoLog(): void {
  downloadText(DEMO_FILE_NAME, generateDemoFlight())
}
