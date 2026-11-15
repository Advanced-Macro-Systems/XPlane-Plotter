// The Dynamic modes tab's test-validity checklist (core/checklists/dynamic): which mode the window is (the setting,
// else the active quick pick, else the test point's name), the fit in the checklist's terms, and the CSV rows. Pure.

import { dynamicReportRows, checklistCsv } from '../../core/checklists/export'
import { fitSummary, runDynamicChecks, type DynamicReport, type ModeId } from '../../core/checklists/dynamic'
import type { Dataset, RowRange, TestPoint, Workspace } from '../../core/types'
import type { ModeFit } from './modeFit'
import { MODE_PRESETS, presetActive, presetForPoint } from './modesModel'

/** The mode a window is: ModesConfig.check.mode, else the quick pick that is on, else the one its test point is named after. */
export function checklistMode(ds: Dataset, ws: Pick<Workspace, 'modes' | 'points'>, point: TestPoint | null): { mode: ModeId | null; from: 'setting' | 'quick pick' | 'test point' | null } {
  if (ws.modes.check?.mode) return { mode: ws.modes.check.mode, from: 'setting' }
  const active = MODE_PRESETS.find((p) => presetActive(ds, p, ws.modes, ws.points))
  if (active) return { mode: active.id, from: 'quick pick' }
  const named = point ? presetForPoint(point.name) : null
  return named ? { mode: named.id, from: 'test point' } : { mode: null, from: null }
}

/**
 * The checklist of a window (null until the mode is known). The other test points named after the same mode are passed
 * by name for the repeats line: their fits are not run here (one fit takes tens of milliseconds and the tab runs fits
 * in a worker), so the checklist asks the student to compare them.
 */
export function modeChecklist(ds: Dataset, ws: Pick<Workspace, 'modes' | 'points'>, rows: RowRange, result: ModeFit | null, point: TestPoint | null): DynamicReport | null {
  const { mode } = checklistMode(ds, ws, point)
  if (!mode) return null
  const fit = result
    ? result.model === 'oscillation'
      ? fitSummary({ model: 'oscillation', fit: result.fit, r2Oscillation: result.detrend === 'linear' ? result.r2Oscillation : undefined })
      : fitSummary({ model: 'first-order', fit: result.fit })
    : null
  const otherPoints = ws.points.filter((p) => p.id !== point?.id && presetForPoint(p.name)?.id === mode).map((p) => p.name)
  return runDynamicChecks({ ds, mode, rows, fit, settings: ws.modes.check, channelId: ws.modes.channelId ?? undefined, otherPoints })
}

/** The checklist as CSV (or TSV with '\t'). */
export function modeChecklistCsv(report: DynamicReport, window: string, delimiter: ',' | '\t' = ','): string {
  return checklistCsv(dynamicReportRows(report, window), delimiter)
}
