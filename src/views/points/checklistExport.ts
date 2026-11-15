// The checklists' rows for the MATLAB export (out/test_checks*.csv): the static-stability and range-and-endurance
// checklists of the points the X–Y analysis uses, and the Dynamic modes checklist of the window Dynamic modes analyses
// (its fit run here, as the tab runs it). The script writes them as the app computed them. Pure: no React.

import { dynamicReportRows, type ChecklistRow } from '../../core/checklists/export'
import type { Dataset, RowRange, Workspace } from '../../core/types'
import { channelById } from '../../core/dataset'
import { modeChecklist } from '../modes/modeChecksModel'
import { runModeFit } from '../modes/modeFit'
import { windowSeries } from '../modes/modesModel'
import { setChecklistRows } from './checklistModel'

/** Longest window (rows) whose fit the export runs on the main thread; a longer one gets its checks without a fit. */
const MAX_FIT_ROWS = 60_000

export function checklistRowsForExport(
  ds: Dataset,
  ws: Workspace,
  opts: { sets: boolean; modes: boolean; modeRows: RowRange | null },
): ChecklistRow[] {
  const rows: ChecklistRow[] = []
  if (opts.sets) rows.push(...setChecklistRows(ds, ws))
  const channel = ws.modes.channelId ? channelById(ds, ws.modes.channelId) : undefined
  if (opts.modes && opts.modeRows && channel) {
    const [start, end] = opts.modeRows
    const point = ws.points.find((p) => `point:${p.id}` === ws.modes.source) ?? null
    const series = windowSeries(ds, channel.values, [start, end])
    let fit = null
    if (end - start <= MAX_FIT_ROWS) {
      try {
        fit = runModeFit(series, ws.modes.model, ws.modes.detrend)
      } catch {
        fit = null
      }
    }
    const report = modeChecklist(ds, ws, [start, end], fit, point)
    const window = point ? point.name : ws.modes.source === 'view' ? 'Zoom range' : 'Selection'
    if (report) rows.push(...dynamicReportRows(report, window))
  }
  return rows
}
