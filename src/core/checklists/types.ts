// Test-validity checklists: the shared result types. A checklist judges whether a manoeuvre or a set of test points was
// flown the way the course's sources ask (the lectures, Cook's Flight Dynamics Principles, the NATO flight test
// handbook AG-300 Vol. 14 and the coursework brief), check by check: pass / warn / fail with the measured value, the
// criterion and the citation. Thresholds the sources do not give as numbers are marked as engineering judgement;
// questions the sources do not settle are "not settled" (ask on EdDiscussion), never pass or fail. Pure types.

/**
 * - pass / warn / fail: judged against the criterion
 * - not-checkable: the log lacks the rows the check needs ("Not checkable — log row 25* (Throttle (commanded))")
 * - not-settled: the sources do not decide the question: shown apart, never as pass or fail
 * - info: reported only (a result, a label, a note that changes nothing)
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not-checkable' | 'not-settled' | 'info'

/**
 * - critical: a fail rejects the run (dynamic) or the point (per point), or sets the set verdict (set checks)
 * - analysis: a choice in the plot or the analysis, fixed without flying again ("Fix the analysis")
 * - advisory: a note; never fails, never blocks the verdict
 * - info: reported only
 * - open: a question the sources do not settle
 */
export type CheckSeverity = 'critical' | 'analysis' | 'advisory' | 'info' | 'open'

export type ChecklistKind = 'dynamic' | 'static' | 'performance'

/** Where a check looks: the dynamic run, one test point, or the set of points behind a plot. */
export type CheckScope = 'run' | 'point' | 'set'

/** What a check is, independent of any data: the registry entry (registry.ts). */
export interface CheckDef {
  /** Shared id: the same id computes the same thing in every checklist ('throttle-fixed', 'weather', ...) */
  id: string
  title: string
  severity: CheckSeverity
  scope: CheckScope
  /** The rows it reads, in the spec's letters (R record, T trim window, W point window, U used points, ...) */
  interval: string
  /** The "Why": the sources' reasoning in a sentence or two (documents and engineering judgement only, never log values) */
  why: string
  /** Spec-style citation keys ("NATO 13-10", "Cook p.47", "FD12b p.28", "B p.7", "EJ"); cite.ts formats them */
  cite: readonly string[]
  /** Its numbers are engineering judgement (no source gives them) */
  judgement: boolean
  /** Which source the criterion follows where the sources differ */
  follows?: string
  /** What the "not checkable" line says, with {N} for Data Output row N (expanded with its name, cite.ts) */
  needs: string
}

/** One check's result. */
export interface Check {
  id: string
  kind: ChecklistKind
  title: string
  status: CheckStatus
  severity: CheckSeverity
  scope: CheckScope
  /** The measured value(s), e.g. "drift 1.4 kt/min, 2σ 0.3 kt" ('' when not checkable) */
  measured: string
  /** The criterion applied, e.g. "pass ≤ 1 kt/min and 2σ ≤ 1 kt; fail beyond a 2 kt change" */
  criterion: string
  /** One line on what to do about it ('' when nothing is needed) */
  hint: string
  why: string
  /** Short citations for display: "NATO AG-300 v14 p.13-10", "FD12b p.28", "Cook p.47", "Brief p.7" */
  citations: string[]
  judgement: boolean
  follows?: string
  interval: string
  /** The test point a per-point check belongs to */
  pointId?: string
}

/** A question the sources do not settle: shown under "Not settled by the sources — ask on EdDiscussion". */
export interface OpenItem {
  id: string
  title: string
  question: string
  /** What to do meanwhile */
  meanwhile: string
  citations: string[]
}

export type VerdictKind = 'acceptable' | 'retest' | 'cannot-confirm' | 'fix-analysis' | 'no-data'

/** The overall verdict, in NATO Table 29-I's words ("Acceptable for Analysis" / "Retest Required"). */
export interface Verdict {
  kind: VerdictKind
  /** The full sentence: "Acceptable for analysis — 9 points used, 1 left out (…), 3 notes" */
  text: string
}

/**
 * A point's place in a set checklist:
 * - used: in the fit
 * - correct: used, but its energy correction matters (performance: use the corrected drag and fuel flow)
 * - plot-only: plotted but left out of the fit (near the stall)
 * - excluded: a critical check failed (retest it, or re-cut it)
 * - cannot-confirm: a critical check could not be made (a row is missing)
 * - left-out: the user left it out of the fit
 */
export type PointStatus = 'used' | 'correct' | 'plot-only' | 'excluded' | 'cannot-confirm' | 'left-out'

export interface PointReport {
  pointId: string
  name: string
  groupId: string
  status: PointStatus
  /** The badge text: "Use", "Correct", "Plot only", "Retest", "Cannot confirm", "Left out" */
  label: string
  /** The checks behind the status, worst first ("throttle moved inside the record") */
  reasons: string[]
  /** Every per-point check of this point, in checklist order */
  checks: Check[]
  /** The worst status among its checks (fail > warn > not-checkable > info/pass) */
  worst: CheckStatus
}

/** A set checklist (static stability, performance): per-point checks, set checks, open items and the verdict. */
export interface SetReport {
  kind: Exclude<ChecklistKind, 'dynamic'>
  /** e.g. "Trim points" or "All test points" */
  setName: string
  points: PointReport[]
  /** Set-level checks (and per-point checks summarised: "11 pass · 2 warn · 1 fail") */
  set: Check[]
  open: OpenItem[]
  verdict: Verdict
  /** Warnings turned into notes for the verdict */
  notes: string[]
  /** Ids of the used points (U) */
  used: string[]
  /** Whether the X–Y fit includes points outside U (the verdict then says to tick "Fit the used points only") */
  fitIncludesUnused: boolean
}

/** The worst of several statuses, for badges: fail > warn > not-checkable > not-settled > info > pass. */
export const STATUS_RANK: Readonly<Record<CheckStatus, number>> = {
  fail: 5,
  warn: 4,
  'not-checkable': 3,
  'not-settled': 2,
  info: 1,
  pass: 0,
}

export function worstStatus(statuses: Iterable<CheckStatus>): CheckStatus {
  let worst: CheckStatus = 'pass'
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
  return worst
}

/** Labels shown next to every status icon (never colour alone). */
export const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = {
  pass: 'Pass',
  warn: 'Warn',
  fail: 'Fail',
  'not-checkable': 'Not checkable',
  'not-settled': 'Not settled',
  info: 'Info',
}

/** Counts per status, e.g. for "11 pass · 2 warn · 1 fail". */
export function statusCounts(checks: Iterable<Pick<Check, 'status'>>): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, 'not-checkable': 0, 'not-settled': 0, info: 0 }
  for (const c of checks) counts[c.status] += 1
  return counts
}

/** "11 pass · 2 warn · 1 fail" (zero counts left out; '' when empty). */
export function countsText(counts: Record<CheckStatus, number>): string {
  const order: CheckStatus[] = ['pass', 'warn', 'fail', 'not-checkable', 'info', 'not-settled']
  return order
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`)
    .join(' · ')
}
