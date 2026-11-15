// What the test-validity checklists judge in the Test points and X–Y tabs: the points the analysis uses (the visible
// points of the X–Y group filter), the plotted channels when the X–Y plot is a trim curve or a range-and-endurance fit
// (otherwise the ones its preset would plot), and the reports, the CSV rows and the X–Y summary. Pure: no React.

import { channelAlias } from '../../core/channels/alias'
import { checklistCsv, setReportRows, type ChecklistRow } from '../../core/checklists/export'
import { engineChannels, findChannel, POWER_HP, THRUST } from '../../core/checklists/helpers'
import { propulsionType, runPerfChecks, type PerfReport } from '../../core/checklists/performance'
import { classifyY, refsOf, runStaticChecks, type StaticReport } from '../../core/checklists/staticStability'
import type { CheckStatus, PointStatus, SetReport } from '../../core/checklists/types'
import { computeStats, channelById } from '../../core/dataset'
import type { Channel, Dataset, TestPoint, Workspace, XYConfig } from '../../core/types'
import { effectiveXY } from '../xy/xyModel'

export type SetChecklistKind = 'performance' | 'static'

/** The points the analysis uses: the visible points of the groups in the X–Y group filter (every group when none). */
export function analysisPoints(ws: Pick<Workspace, 'points' | 'groups' | 'xy'>): TestPoint[] {
  return effectiveXY({ ...ws.xy, source: 'points' }, ws, null).points
}

const ELEVATORS = ['elev1,__deg', '_elev,_surf', '_trim,_elev']
const CL_WORDS = /\bc_?l\b|lift coeff/i

/** A lift-coefficient channel: X-Plane's ___cl,total, or a formula named or built as one (weight over q·S). */
export function isClChannel(ds: Dataset, ch: Channel | null | undefined): boolean {
  if (!ch) return false
  if (ch.token === '___cl,total') return true
  if (!ch.derived) return false
  if (CL_WORDS.test(`${ch.meta.label} ${ch.id}`)) return true
  const refs = refsOf(ds, ch)
  const weight = [...refs].some((r) => /^(total_lb|gross_lb|maxim_lb)$/.test(r))
  const speed = [...refs].some((r) => /^(Vind_keas|Vind_kias|Vtrue_ktas)$/.test(r))
  return weight && speed
}

/** The X–Y plot is a trim curve: a pitch control (elevator, stabiliser trim or δ_eq) against C_L. */
export function isTrimCurve(ds: Dataset, xy: Pick<XYConfig, 'x' | 'ys'>): boolean {
  const x = xy.x ? channelById(ds, xy.x) : undefined
  return isClChannel(ds, x) && xy.ys.length > 0 && classifyY(ds, xy.ys[0]).kind !== 'other'
}

/** The static checklist's x and Y: the X–Y plot's when it is a trim curve, else what the static-stability preset plots. */
export function staticPlot(ds: Dataset, xy: Pick<XYConfig, 'x' | 'ys'>): { xId: string | null; yId: string | null; fromXY: boolean } {
  if (isTrimCurve(ds, xy)) return { xId: xy.x, yId: xy.ys[0], fromXY: true }
  const cl = channelById(ds, '___cl,total') ? '___cl,total' : (ds.channels.find((c) => isClChannel(ds, c))?.id ?? null)
  return { xId: cl, yId: ELEVATORS.find((id) => channelById(ds, id)) ?? null, fromXY: false }
}

export interface PerfSetDef {
  key: string
  name: string
  points: TestPoint[]
  x: Channel | null
  y: Channel | null
  fit: XYConfig['fit']
  fitTarget: XYConfig['fitTarget']
  /** The X–Y plot's own fit (else the preset's choice for this log) */
  fromXY: boolean
}

/** A total of per-engine channels, computed (when the log has no formula channel for it yet). */
function totalChannel(ds: Dataset, chs: readonly Channel[], label: string, unit: string): Channel {
  const values = new Float64Array(ds.rowCount)
  for (let i = 0; i < ds.rowCount; i += 1) {
    let s = 0
    for (const c of chs) s += c.values[i]
    values[i] = s
  }
  return {
    id: `fx:checklist_${label.toLowerCase().replace(/\W+/g, '_')}`,
    token: '',
    occurrence: 1,
    column: -1,
    meta: { label, short: label, unit, quantity: 'other', group: 'derived', known: false },
    values,
    stats: computeStats(values),
    derived: { expression: chs.map(channelAlias).join(' + ') },
  }
}

/**
 * The range-and-endurance sets: the X–Y fit's (one per group when the plot colours by group) when its markers are on;
 * otherwise what the range-and-endurance preset would plot for this log (KTAS against total thrust with the drag
 * model, or total engine power with the power model for a propeller aircraft, or when the engine type is unknown and
 * only engine power is logged).
 */
export function perfSets(ds: Dataset, ws: Pick<Workspace, 'points' | 'groups' | 'xy' | 'perfCheck'>): PerfSetDef[] {
  const points = analysisPoints(ws)
  if (!points.length) return []
  const xy = ws.xy
  if (xy.rangeEndurance && xy.fit !== 'none' && xy.x && xy.ys.length) {
    const x = channelById(ds, xy.x) ?? null
    const y = channelById(ds, xy.ys[0]) ?? null
    const groups = ws.groups.filter((g) => points.some((p) => p.groupId === g.id))
    if (xy.colorBy === 'group' && groups.length > 1) {
      return groups.map((g) => ({ key: g.id, name: g.name, points: points.filter((p) => p.groupId === g.id), x, y, fit: xy.fit, fitTarget: xy.fitTarget, fromXY: true }))
    }
    return [{ key: '*', name: 'Range and endurance points', points, x, y, fit: xy.fit, fitTarget: xy.fitTarget, fromXY: true }]
  }
  const x = findChannel(ds, 'Vtrue,_ktas')
  const type = propulsionType(ds, ws.perfCheck?.propulsion).type
  // An engine type the log does not tell, with engine power but no thrust logged (the lecture's propeller example):
  // judge the power curve, as the propeller preset plots it, rather than no curve at all. The construction check
  // still asks for the engine type.
  const powerOnly = type === null && !engineChannels(ds, THRUST).length && engineChannels(ds, POWER_HP).length > 0
  const propeller = type === 'propeller' || powerOnly
  let y: Channel | null
  let fit: XYConfig['fit'] = 'drag-model'
  if (propeller) {
    const powers = engineChannels(ds, POWER_HP)
    const formula = ds.channels.find((c) => c.derived && /total engine power/i.test(c.meta.label))
    y = formula ?? (powers.length > 1 ? totalChannel(ds, powers, 'Total engine power', 'hp') : (powers[0] ?? null))
    fit = 'power-model'
  } else {
    const thrusts = engineChannels(ds, THRUST)
    const formula = ds.channels.find((c) => c.derived && /total thrust/i.test(c.meta.label))
    y = formula ?? (thrusts.length > 1 ? totalChannel(ds, thrusts, 'Total thrust', 'lb') : (thrusts[0] ?? findChannel(ds, '_drag,___lb')))
  }
  return [{ key: '*', name: 'Range and endurance points', points, x, y, fit, fitTarget: 'means', fromXY: false }]
}

/** The static-stability checklist for the analysis points (null without points). */
export function staticChecklist(ds: Dataset, ws: Workspace): (StaticReport & { fromXY: boolean }) | null {
  const points = analysisPoints(ws)
  if (!points.length) return null
  const plot = staticPlot(ds, ws.xy)
  const report = runStaticChecks({ ds, points, groups: ws.groups, xId: plot.xId, yId: plot.yId, settings: ws.trimCheck })
  return { ...report, fromXY: plot.fromXY }
}

/** The range-and-endurance checklist of every set. */
export function perfChecklists(ds: Dataset, ws: Workspace): { def: PerfSetDef; report: PerfReport }[] {
  return perfSets(ds, ws).map((def) => ({
    def,
    report: runPerfChecks({ ds, points: def.points, x: def.x, y: def.y, fit: def.fit, fitTarget: def.fitTarget, settings: ws.perfCheck, setName: def.name }),
  }))
}

/** CSV / TSV rows of the set checklists (both when `kind` is absent). */
export function setChecklistRows(ds: Dataset, ws: Workspace, kind?: SetChecklistKind): ChecklistRow[] {
  const rows: ChecklistRow[] = []
  if (kind !== 'performance') {
    const s = staticChecklist(ds, ws)
    if (s) rows.push(...setReportRows(s))
  }
  if (kind !== 'static') for (const { report } of perfChecklists(ds, ws)) rows.push(...setReportRows(report))
  return rows
}

/** The checklist as CSV (or TSV) text. */
export function setChecklistCsv(ds: Dataset, ws: Workspace, kind: SetChecklistKind, delimiter: ',' | '\t' = ','): string {
  return checklistCsv(setChecklistRows(ds, ws, kind), delimiter)
}

// ------------------------------------------------------------------ summaries

const POINT_ORDER: readonly PointStatus[] = ['used', 'correct', 'plot-only', 'left-out', 'excluded', 'cannot-confirm']
const POINT_WORD: Readonly<Record<PointStatus, string>> = {
  used: 'use',
  correct: 'correct',
  'plot-only': 'plot separately',
  'left-out': 'left out',
  excluded: 'retest',
  'cannot-confirm': 'cannot confirm',
}

export interface ChecklistSummary {
  /** The verdict as a status (acceptable: pass, or warn with notes; retest: fail; cannot confirm: not checkable) */
  status: CheckStatus
  /** "9 use · 1 retest · 1 plot only" */
  points: string
  /** "4 notes" */
  notes: string
  verdict: string
}

/** The one-line summary the X–Y tab shows. */
export function checklistSummary(report: SetReport): ChecklistSummary {
  const counts = new Map<PointStatus, number>()
  for (const p of report.points) counts.set(p.status, (counts.get(p.status) ?? 0) + 1)
  const points = POINT_ORDER.filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${POINT_WORD[s]}`).join(' · ')
  const noteCount = report.notes.length
  const kind = report.verdict.kind
  const status: CheckStatus =
    kind === 'retest' ? 'fail' : kind === 'cannot-confirm' ? 'not-checkable' : kind === 'fix-analysis' ? 'warn' : kind === 'no-data' ? 'info' : noteCount ? 'warn' : 'pass'
  return { status, points, notes: noteCount ? `${noteCount} note${noteCount === 1 ? '' : 's'}` : '', verdict: report.verdict.text }
}

export interface XYChecklist {
  kind: SetChecklistKind
  report: SetReport
  summary: ChecklistSummary
  /** The used points (U) of the set the X–Y fit draws */
  used: ReadonlySet<string>
  /** "Fit the used points only" is ticked for this checklist */
  fitUsedOnly: boolean
}

/**
 * The checklist the X–Y plot shows a summary of: range and endurance when its markers are on, static stability when the
 * plot is a trim curve (a pitch control against C_L); null otherwise or without test points.
 */
export function xyChecklist(ds: Dataset, ws: Workspace): XYChecklist | null {
  const xy = ws.xy
  if (xy.source !== 'points' || !analysisPoints(ws).length) return null
  if (xy.rangeEndurance && xy.fit !== 'none') {
    const sets = perfChecklists(ds, ws)
    if (!sets.length) return null
    // Several sets (one per group): the summary takes the worst verdict, the used points of every set.
    const order: Record<string, number> = { retest: 0, 'cannot-confirm': 1, 'fix-analysis': 2, acceptable: 3, 'no-data': 4 }
    const worst = [...sets].sort((a, b) => order[a.report.verdict.kind] - order[b.report.verdict.kind])[0].report
    const used = new Set(sets.flatMap((s) => s.report.used))
    return { kind: 'performance', report: worst, summary: checklistSummary(worst), used, fitUsedOnly: ws.perfCheck?.fitUsedOnly === true }
  }
  if (isTrimCurve(ds, xy)) {
    const report = staticChecklist(ds, ws)
    if (!report) return null
    return { kind: 'static', report, summary: checklistSummary(report), used: new Set(report.used), fitUsedOnly: ws.trimCheck?.fitUsedOnly === true }
  }
  return null
}
