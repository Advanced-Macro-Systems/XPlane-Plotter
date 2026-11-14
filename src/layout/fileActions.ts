// What the shell does with files: open logs (and route session files to "load session"), save and load sessions, and
// the whole-file exports offered on the Overview. Store-bound: everything goes through the store's actions.

import { DEMO_FILE_NAME, generateDemoFlight } from '../core/demo/generateDemo'
import { datasetCsv } from '../core/export/csv'
import { downloadText, safeFilename } from '../core/export/download'
import { matlabScript, matlabScriptName } from '../core/export/matlab'
import { parseSession, serializeSession } from '../core/export/session'
import { getActiveDataset, getWorkspace, importWorkspace, openDemo, openFiles, setActive, toast, useApp } from '../store/app'
import { fileStem, isSessionFileName, modeRowsFor, plural } from './shellModel'

/** Opens picked or dropped files: logs first (each becomes a dataset), then any session files onto the active one. */
export async function openPickedFiles(files: readonly File[]): Promise<void> {
  const logs = files.filter((f) => !isSessionFileName(f.name))
  const sessions = files.filter((f) => isSessionFileName(f.name))
  if (logs.length) await openFiles(logs)
  for (const file of sessions) await loadSessionFile(file)
}

/** Switches to the demo flight when it is already open, else builds it. */
export function showDemo(): void {
  const open = useApp.getState().datasets.find((d) => d.name === DEMO_FILE_NAME)
  if (open) setActive(open.id)
  else void openDemo()
}

/** Downloads the active workspace as a session file. */
export function saveSessionFile(): void {
  const ds = getActiveDataset()
  const ws = getWorkspace()
  if (!ds || !ws) return
  downloadText(`${safeFilename(fileStem(ds.name), 'session')}.xpp-session.json`, serializeSession(ds, ws), 'application/json')
}

/** Reads a session file onto the active dataset (its test points, panels, formulas and plot settings). */
export async function loadSessionFile(file: File): Promise<void> {
  const ds = getActiveDataset()
  if (!ds) {
    toast(`Open the flight log first, then load its session file (${file.name}).`, 'error')
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
    const session = parseSession(text)
    importWorkspace(session.workspace)
    const points = getWorkspace()?.points.length ?? 0
    if (session.dataset.signature === ds.signature) {
      toast(`Session loaded: ${plural(points, 'test point')}.`, 'success')
    } else {
      toast(
        `Session saved for ${session.dataset.name} loaded onto ${ds.name}. Channels and test points that do not fit this file were left out (${plural(points, 'test point')} kept).`,
        'info',
      )
    }
  } catch (error) {
    // parseSession's messages are written for people.
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** The MATLAB script for the whole workspace: test points, X–Y, time histories (over the zoom) and the mode fit. */
export function exportMatlabScript(): void {
  const ds = getActiveDataset()
  const ws = getWorkspace()
  if (!ds || !ws) return
  const { selection, view } = useApp.getState()
  const script = matlabScript({
    ds,
    ws,
    include: { points: true, xy: true, time: true, modes: true },
    view,
    modeRows: modeRowsFor(ws, selection, view),
  })
  downloadText(matlabScriptName(ds.name), script)
}

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
