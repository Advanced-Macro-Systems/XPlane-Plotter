// Checklist results as rows for CSV / TSV (the Test points and Dynamic modes exports, "Copy checklist") and for the
// MATLAB export's out/test_checks*.csv. One row per check (per point for per-point checks), then the open questions
// and the verdict. Text cells are guarded like every other CSV the app writes: a cell that starts with = + − @ gets a
// leading apostrophe, so a spreadsheet never runs it as a formula.

import type { DynamicReport } from './dynamic'
import { MODE_NAMES } from './names'
import type { Check, ChecklistKind, SetReport } from './types'
import { STATUS_LABEL } from './types'

export const CHECKLIST_COLUMNS = [
  'checklist',
  'set',
  'point',
  'check',
  'title',
  'status',
  'severity',
  'measured',
  'criterion',
  'judgement',
  'follows',
  'citations',
  'hint',
] as const

export type ChecklistRow = Record<(typeof CHECKLIST_COLUMNS)[number], string>

const KIND_NAME: Readonly<Record<ChecklistKind, string>> = {
  dynamic: 'dynamic modes',
  static: 'static stability',
  performance: 'range and endurance',
}

function row(kind: ChecklistKind, set: string, point: string, c: Check): ChecklistRow {
  return {
    checklist: KIND_NAME[kind],
    set,
    point,
    check: c.id,
    title: c.title,
    status: STATUS_LABEL[c.status].toLowerCase(),
    severity: c.severity,
    measured: c.measured,
    criterion: c.criterion,
    judgement: c.judgement ? 'engineering judgement' : '',
    follows: c.follows ?? '',
    citations: c.citations.join('; '),
    hint: c.hint,
  }
}

/** Rows of a set checklist: each point's checks (with its verdict), the set checks, open items, the verdict. */
export function setReportRows(report: SetReport): ChecklistRow[] {
  const kind = report.kind
  const out: ChecklistRow[] = []
  for (const p of report.points) {
    out.push({
      ...emptyRow(kind, report.setName, p.name),
      check: 'point-verdict',
      title: 'Point verdict',
      status: p.label.toLowerCase(),
      measured: p.reasons.join('; '),
    })
    for (const c of p.checks) out.push(row(kind, report.setName, p.name, c))
  }
  for (const c of report.set) out.push(row(kind, report.setName, '', c))
  for (const o of report.open) {
    out.push({
      ...emptyRow(kind, report.setName, ''),
      check: o.id,
      title: o.title,
      status: 'not settled',
      severity: 'open',
      measured: o.question,
      criterion: 'Not settled by the sources — ask on EdDiscussion',
      citations: o.citations.join('; '),
      hint: o.meanwhile,
    })
  }
  out.push({ ...emptyRow(kind, report.setName, ''), check: 'verdict', title: 'Verdict', status: report.verdict.kind, measured: report.verdict.text })
  return out
}

/** Rows of a dynamic checklist: each check, then the verdict. `window` names the analysed window. */
export function dynamicReportRows(report: DynamicReport, window: string): ChecklistRow[] {
  const set = `${MODE_NAMES[report.mode]}: ${window}`
  return [
    ...report.checks.map((c) => row('dynamic', set, '', c)),
    { ...emptyRow('dynamic', set, ''), check: 'verdict', title: 'Verdict', status: report.verdict.kind, measured: `${report.verdict.text} (${report.label})` },
  ]
}

function emptyRow(kind: ChecklistKind, set: string, point: string): ChecklistRow {
  return {
    checklist: KIND_NAME[kind],
    set,
    point,
    check: '',
    title: '',
    status: '',
    severity: '',
    measured: '',
    criterion: '',
    judgement: '',
    follows: '',
    citations: '',
    hint: '',
  }
}

/** A text cell: one line, quoted when needed (RFC 4180), defused when a spreadsheet would read it as a formula. */
export function checklistCell(text: string, delimiter: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ')
  const safe = /^[=+\-@\t\r]/.test(flat) ? `'${flat}` : flat
  return safe.includes('"') || safe.includes(delimiter) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** CSV (or TSV with '\t') of checklist rows, header first, CRLF line ends. */
export function checklistCsv(rows: readonly ChecklistRow[], delimiter: ',' | '\t' = ','): string {
  const lines = [CHECKLIST_COLUMNS.join(delimiter)]
  for (const r of rows) lines.push(CHECKLIST_COLUMNS.map((k) => checklistCell(r[k], delimiter)).join(delimiter))
  return `${lines.join('\r\n')}\r\n`
}
