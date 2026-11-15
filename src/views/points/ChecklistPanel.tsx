// The Test points tab's test-validity checklist: was each point (and the set) flown the way the lectures, Cook's book
// and the NATO flight-test handbook ask, for the test chosen (range and endurance, or the static-stability trim curve)?
// A badge per point (expand it for its checks), the set checks, the questions the sources leave open, the settings the
// checks need (engine type, trim type, declarations, limits) and the actions: leave a point out of the fit, fit the
// used points only, plot δ_eq, copy or export the results. The checks themselves are core/checklists.

import { ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, GraphIcon, FoldIcon } from '@primer/octicons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckList, CheckRow, OpenItems, PointBadge, StatusBadge, VerdictBanner } from '../../components/Checklist'
import { Segmented } from '../../components/Segmented'
import { recutFailing, recutPlan, type Recut } from '../../core/checklists/recut'
import { countsText, statusCounts, worstStatus, type Check, type PointReport, type SetReport } from '../../core/checklists/types'
import { copyText, downloadText } from '../../core/export/download'
import type { ChecklistDeclared, Dataset, PerfCheckSettings, TestPoint, TrimCheckSettings, Workspace } from '../../core/types'
import {
  clearChecklistRequest,
  removeDerived,
  saveDerived,
  setChecklistKind,
  setPerfCheck,
  setTrimCheck,
  setXY,
  setTab,
  toast,
  updateWorkspace,
  useApp,
} from '../../store/app'
import { exportStem } from '../xy/xyControls'
import { perfChecklists, setChecklistCsv, staticChecklist, type SetChecklistKind } from './checklistModel'

const KIND_OPTIONS = [
  { value: 'performance' as const, label: 'Performance — range & endurance' },
  { value: 'static' as const, label: 'Static stability — trim curve' },
]

export function ChecklistPanel({ ds, ws }: { ds: Dataset; ws: Workspace }) {
  const kind: SetChecklistKind = ws.checklist?.kind ?? (ws.xy.rangeEndurance ? 'performance' : 'static')
  const request = useApp((s) => s.checklistRequest)
  const ref = useRef<HTMLElement>(null)
  const staticReport = useMemo(() => (kind === 'static' ? staticChecklist(ds, ws) : null), [kind, ds, ws])
  const perf = useMemo(() => (kind === 'performance' ? perfChecklists(ds, ws) : []), [kind, ds, ws])
  const [setKey, setSetKey] = useState<string | null>(null)
  const chosen = perf.find((p) => p.def.key === setKey) ?? perf[0] ?? null
  const report: SetReport | null = kind === 'static' ? staticReport : (chosen?.report ?? null)

  // Another tab asked for the checklist (X–Y "Open checklist"): bring it into view once.
  useEffect(() => {
    if (!request) return
    ref.current?.scrollIntoView({ block: 'start' })
    ref.current?.querySelector<HTMLElement>('h3')?.focus()
    clearChecklistRequest()
  }, [request])

  const copy = async () => {
    const ok = await copyText(setChecklistCsv(ds, ws, kind, '\t'))
    toast(ok ? 'Copied the checklist as tab-separated values.' : 'The browser did not allow copying. Use Export → Checklist (CSV).', ok ? 'success' : 'error')
  }
  const download = () => downloadText(`${exportStem(ds.name, `checklist_${kind}`)}.csv`, setChecklistCsv(ds, ws, kind), 'text/csv')

  const plotted =
    kind === 'static'
      ? staticReport && staticPlotText(staticReport)
      : chosen &&
        `${chosen.def.y?.meta.label ?? 'no thrust or power channel'} against ${chosen.def.x?.meta.short ?? 'no true airspeed'}, ${FIT_WORDS[chosen.def.fit]}${chosen.def.fromXY ? ' (the X–Y plot)' : ' (what the range-and-endurance preset plots)'}${chosen.report.propulsion === null ? '; the engine type is not known: choose jet or propeller under Settings and declarations' : ''}`

  return (
    <section ref={ref} className="card pt-checklist" id="pt-checklist" data-testid="points-checklist" aria-labelledby="pt-checklist-title">
      <header className="card-header pt-cl-header">
        <div className="pt-cl-heading">
          <h3 className="card-title" id="pt-checklist-title" tabIndex={-1}>
            Test validity checklist
          </h3>
          <span className="pt-cl-sub">
            The points the X–Y analysis uses, checked against the lectures, Cook’s book, the NATO flight-test handbook and the brief.
          </span>
        </div>
        <div className="pt-cl-actions">
          <button type="button" className="btn btn-sm btn-ghost" disabled={!report} onClick={() => void copy()}>
            <CopyIcon size={14} /> Copy
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={!report} onClick={download} data-testid="points-checklist-csv">
            <DownloadIcon size={14} /> CSV
          </button>
        </div>
      </header>
      <div className="card-body pt-cl-body">
        <div className="pt-cl-kind">
          <Segmented<SetChecklistKind> value={kind} options={KIND_OPTIONS} ariaLabel="Test type" onChange={setChecklistKind} />
          {kind === 'performance' && perf.length > 1 && (
            <select className="select select-sm" aria-label="Set" value={chosen?.def.key ?? ''} onChange={(e) => setSetKey(e.target.value)}>
              {perf.map((p) => (
                <option key={p.def.key} value={p.def.key}>
                  {p.def.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {!report ? (
          <p className="pt-cl-empty">
            No points to check: the X–Y group filter leaves none, or every point is hidden. Show some points, or choose groups in
            X–Y plot.
          </p>
        ) : (
          <>
            <VerdictBanner verdict={report.verdict} testId="points-checklist-verdict">
              {plotted && <span className="pt-cl-plotted">Judged on: {plotted}.</span>}
            </VerdictBanner>
            {kind === 'static' && staticReport && <DeltaEqAction ds={ds} ws={ws} report={staticReport} />}
            <Settings kind={kind} ws={ws} />
            <PointTable ds={ds} report={report} ws={ws} kind={kind} />
            <SetChecks report={report} />
            <OpenItems items={report.open} testId="points-checklist-open" />
            <p className="pt-cl-foot">
              Each check gives what was measured, the criterion and its source (NATO AG-300 v14 = the NATO flight test
              handbook RTO-AG-300 Vol. 14; FD = lecture decks; Brief = the coursework brief; App = this app’s own
              defaults, not a published source). The sources say what to check; they rarely give a number for it.{' '}
              <span className="ck-tag">judgement</span>{' '}
              marks a check with a limit no source gives (engineering judgement: this app’s choice); “From the sources”
              lists the numbers a source does give. Questions the sources leave open are never pass or fail: ask on
              EdDiscussion.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

const FIT_WORDS: Readonly<Record<string, string>> = {
  none: 'no fit',
  linear: 'linear fit',
  poly2: 'quadratic fit',
  poly3: 'cubic fit',
  'power-model': 'power model',
  'drag-model': 'drag model',
}

function staticPlotText(report: SetReport & { fromXY: boolean }): string {
  const tv = report.set.find((c) => c.id === 'trim-variable')
  const y = tv?.measured.match(/^Y is ([^;]+)/)?.[1] ?? 'the pitch control'
  return `${y} against C_L${report.fromXY ? ' (the X–Y plot)' : ' (what the static-stability preset plots)'}`
}

/** "Plot δ_eq": the equivalent elevator e − s_e·G·trim as a formula channel, plotted against C_L (with Undo). */
function DeltaEqAction({ ds, ws, report }: { ds: Dataset; ws: Workspace; report: NonNullable<ReturnType<typeof staticChecklist>> }) {
  const tv = report.set.find((c) => c.id === 'trim-variable')
  if (!report.deltaEq || report.yKind === 'combined' || tv?.status !== 'warn') return null
  const d = report.deltaEq
  const plot = () => {
    const before = ws.xy
    const saved = saveDerived({ name: d.name, unit: d.unit, expression: d.expression }, 'delta_eq')
    if (!saved.ok) {
      toast(`Could not make δ_eq: ${saved.error}`, 'error')
      return
    }
    const x = report.fromXY ? ws.xy.x : (ds.channels.find((c) => c.token === '___cl,total')?.id ?? ws.xy.x)
    setXY({ x, ys: [saved.id], source: 'points', fit: 'linear', fitTarget: 'means', showMeans: true, rangeEndurance: undefined })
    toast(`Made “${d.name}” (${d.expression}) and plotted it against C_L in X–Y plot.`, 'success', {
      label: 'Undo',
      datasetId: ds.id,
      run: () => {
        setXY(before)
        removeDerived(saved.id)
      },
    })
  }
  return (
    <div className="callout callout-info pt-cl-deq">
      <GraphIcon size={16} />
      <span>
        The trim moved between points: plot the equivalent elevator δ_eq = <code>{d.expression}</code> (G = {Number(d.G.toPrecision(3))}
        {Number.isFinite(d.seG) && d.seG > 0 ? ` ± ${Number(d.seG.toPrecision(2))}` : ''}, fitted through the used points).
      </span>
      <button type="button" className="btn btn-sm btn-outline" onClick={plot} data-testid="points-checklist-deq">
        Plot δ_eq
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTab('xy')}>
        Open X–Y plot
      </button>
    </div>
  )
}

/**
 * Re-cuts points to their longest still stretch (recutPoint) in one workspace change; the toast's Undo puts their old
 * rows back.
 */
function applyRecut(ds: Dataset, plan: readonly { point: TestPoint; recut: Recut }[]): void {
  if (!plan.length) return
  const before = new Map(plan.map(({ point }) => [point.id, [point.start, point.end] as const]))
  const after = new Map(plan.map(({ point, recut }) => [point.id, [recut.start, recut.end] as const]))
  const move = (rows: ReadonlyMap<string, readonly [number, number]>) =>
    updateWorkspace((w) => ({ ...w, points: w.points.map((p) => (rows.has(p.id) ? { ...p, start: rows.get(p.id)![0], end: rows.get(p.id)![1] } : p)) }))
  move(after)
  const names = plan.map(({ point }) => point.name)
  toast(
    `Re-cut ${plan.length === 1 ? `“${names[0]}”` : `${plan.length} points`} to the part where the throttle${plan.some(({ recut }) => recut.level === 'warn') ? ' (nearly)' : ''} stayed still.`,
    'success',
    {
      label: 'Undo',
      datasetId: ds.id,
      run: () => move(before),
    },
  )
}

/** The points: a badge each, what to look at, and (expanded) every check of the point. */
function PointTable({ ds, report, ws, kind }: { ds: Dataset; report: SetReport; ws: Workspace; kind: SetChecklistKind }) {
  const [open, setOpen] = useState<string | null>(null)
  // Points whose throttle (or trim) moved inside: the longest still stretch of each, to re-cut them to (the same points
  // the verdict counts: recutFailing).
  const plan = useMemo(() => recutPlan(ds, ws.points, recutFailing(report.points, kind)), [ds, ws.points, report, kind])
  const excluded = new Set((kind === 'static' ? ws.trimCheck?.fitExcluded : ws.perfCheck?.fitExcluded) ?? [])
  const toggleLeftOut = (id: string) => {
    const next = excluded.has(id) ? [...excluded].filter((x) => x !== id) : [...excluded, id]
    const patch = { fitExcluded: next.length ? next : undefined }
    if (kind === 'static') setTrimCheck(patch)
    else setPerfCheck(patch)
  }
  const groupName = (id: string) => ws.groups.find((g) => g.id === id)
  return (
    <div className="pt-cl-section">
      <div className="pt-cl-points-head">
        <h4 className="pt-cl-h4">
          Test points <span className="pt-cl-count">{report.points.length}</span>
        </h4>
        {plan.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-outline"
            title="Cut each point whose throttle (or trim) moved inside it to its longest stretch where it stayed still"
            data-testid="points-checklist-recut"
            onClick={() => applyRecut(ds, plan)}
          >
            <FoldIcon size={14} /> Re-cut {plan.length} flagged point{plan.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <div className="table-wrap pt-cl-table-wrap">
        <table className="table pt-cl-table" data-testid="points-checklist-points">
          <thead>
            <tr>
              <th scope="col">Point</th>
              <th scope="col">Verdict</th>
              <th scope="col">Look at</th>
            </tr>
          </thead>
          <tbody>
            {report.points.map((p) => {
              const expanded = open === p.pointId
              const group = groupName(p.groupId)
              const attention = p.checks
                .filter((c) => c.status === 'fail' || c.status === 'warn' || c.status === 'not-checkable')
                .sort(byWorst)
              return (
                <PointRows
                  key={p.pointId}
                  point={p}
                  expanded={expanded}
                  groupSlot={group?.slot ?? 0}
                  groupName={group?.name ?? ''}
                  attention={attention}
                  leftOut={excluded.has(p.pointId)}
                  onToggle={() => setOpen(expanded ? null : p.pointId)}
                  onLeaveOut={() => toggleLeftOut(p.pointId)}
                  onRecut={plan.some((x) => x.point.id === p.pointId) ? () => applyRecut(ds, plan.filter((x) => x.point.id === p.pointId)) : undefined}
                />
              )
            })}
          </tbody>
        </table>
      </div>
      <FitUsedOnly kind={kind} ws={ws} report={report} />
    </div>
  )
}

function PointRows({
  point,
  expanded,
  groupSlot,
  groupName,
  attention,
  leftOut,
  onToggle,
  onLeaveOut,
  onRecut,
}: {
  point: PointReport
  expanded: boolean
  groupSlot: number
  groupName: string
  attention: Check[]
  leftOut: boolean
  onToggle: () => void
  onLeaveOut: () => void
  /** Re-cut the point to its still stretch (when its throttle or trim moved inside it) */
  onRecut?: () => void
}) {
  const detailId = `pt-cl-detail-${point.pointId}`
  const tip = attention.map((c) => `${c.status}: ${c.title} — ${c.measured || c.criterion}`).join('\n')
  return (
    <>
      <tr className="pt-cl-point" data-testid="points-checklist-point">
        <td>
          <button type="button" className="pt-cl-expand" aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>
            {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            <span className={`chip-dot pt-cl-dot slot-${groupSlot}`} aria-hidden="true" />
            <span className="pt-cl-name">{point.name}</span>
            {groupName && <span className="sr-only"> ({groupName})</span>}
          </button>
        </td>
        <td>
          <span title={point.reasons.join('; ') || undefined}>
            <PointBadge status={point.status} label={point.label} />
          </span>
        </td>
        <td className="pt-cl-attention" title={tip || undefined}>
          {attention.length ? (
            <span className="pt-cl-attention-list">
              {attention.slice(0, 3).map((c) => (
                <StatusBadge key={c.id} status={c.status} label={c.title} />
              ))}
              {attention.length > 3 && <span className="subtle">+{attention.length - 3} more</span>}
            </span>
          ) : (
            <span className="subtle">{countsText(statusCounts(point.checks))}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="pt-cl-detail" id={detailId}>
          <td colSpan={3}>
            {point.reasons.length > 0 && <p className="pt-cl-reasons">{point.reasons.join('; ')}</p>}
            <CheckList checks={[...point.checks].sort(byWorst)} rowTestId="points-checklist-point-check" />
            <div className="pt-cl-point-actions">
              {onRecut && (
                <button type="button" className="btn btn-sm btn-outline" onClick={onRecut}>
                  <FoldIcon size={14} /> Re-cut this point
                </button>
              )}
              <button type="button" className="btn btn-sm btn-outline" onClick={onLeaveOut}>
                {leftOut ? 'Use in the fit' : 'Leave out of the fit'}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

const RANK: Readonly<Record<string, number>> = { fail: 0, warn: 1, 'not-checkable': 2, info: 3, 'not-settled': 4, pass: 5 }
const byWorst = (a: Check, b: Check) => RANK[a.status] - RANK[b.status]

/** "Fit the used points only": the X–Y fit leaves out what the verdict leaves out. */
function FitUsedOnly({ kind, ws, report }: { kind: SetChecklistKind; ws: Workspace; report: SetReport }) {
  const on = (kind === 'static' ? ws.trimCheck?.fitUsedOnly : ws.perfCheck?.fitUsedOnly) === true
  const change = (value: boolean) => (kind === 'static' ? setTrimCheck({ fitUsedOnly: value || undefined }) : setPerfCheck({ fitUsedOnly: value || undefined }))
  return (
    <label className="check pt-cl-fit-used">
      <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} data-testid="points-checklist-fit-used" />
      Fit the used points only ({report.used.length} of {report.points.length}) in X–Y plot
    </label>
  )
}

/** The set checks, then each per-point check summarised over the points ("11 pass · 2 warn · 1 fail"). */
function SetChecks({ report }: { report: SetReport }) {
  const perPoint = useMemo(() => {
    const byId = new Map<string, { title: string; checks: { name: string; check: Check }[] }>()
    for (const p of report.points) {
      for (const c of p.checks) {
        const entry = byId.get(c.id) ?? { title: c.title, checks: [] }
        entry.checks.push({ name: p.name, check: c })
        byId.set(c.id, entry)
      }
    }
    return [...byId.entries()]
  }, [report])
  return (
    <>
      <div className="pt-cl-section">
        <h4 className="pt-cl-h4">Set checks</h4>
        <CheckList checks={report.set} testId="points-checklist-set" rowTestId="points-checklist-row" />
      </div>
      <div className="pt-cl-section">
        <h4 className="pt-cl-h4">Per-point checks</h4>
        <ul className="ck-list">
          {perPoint.map(([id, entry]) => {
            const statuses = entry.checks.map((x) => x.check.status)
            const sample = entry.checks[0].check
            return (
              <CheckRow
                key={id}
                check={{ ...sample, status: worstStatus(statuses), measured: countsText(statusCounts(entry.checks.map((x) => x.check))), hint: '' }}
                extra={
                  <details className="ck-why pt-cl-points-of">
                    <summary>By point</summary>
                    <ul>
                      {entry.checks.map(({ name, check }) => (
                        <li key={name}>
                          <StatusBadge status={check.status} /> <strong>{name}</strong> {check.measured}
                          {check.hint ? ` — ${check.hint}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                }
              />
            )
          })}
        </ul>
      </div>
    </>
  )
}

/** The settings and declarations the checks read (engine type, trim type, autopilot, limits). */
function Settings({ kind, ws }: { kind: SetChecklistKind; ws: Workspace }) {
  const settings: TrimCheckSettings & PerfCheckSettings = (kind === 'static' ? ws.trimCheck : ws.perfCheck) ?? {}
  const set = (patch: Partial<TrimCheckSettings & PerfCheckSettings>) => (kind === 'static' ? setTrimCheck(patch) : setPerfCheck(patch))
  const declared: ChecklistDeclared = settings.declared ?? {}
  const setDeclared = (patch: Partial<ChecklistDeclared>) => {
    const next = { ...declared, ...patch }
    for (const key of Object.keys(next) as (keyof ChecklistDeclared)[]) if (!next[key]) delete next[key]
    set({ declared: Object.keys(next).length ? next : undefined })
  }
  const num = (value: string): number | undefined => {
    const v = Number(value)
    return value.trim() && Number.isFinite(v) ? v : undefined
  }
  const limits = (settings.limits ?? {}) as Record<string, number | undefined>
  const setLimit = (key: string, value: string) => {
    const next = { ...limits, [key]: num(value) && (num(value) as number) > 0 ? num(value) : undefined }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    set({ limits: Object.keys(next).length ? next : undefined })
  }
  return (
    <details className="pt-cl-settings">
      <summary>Settings and declarations</summary>
      {/* The inputs are uncontrolled (saved on blur): keyed by the test type so switching it mounts the other type's
          inputs with their own values, instead of reusing these with a typed value still in them. */}
      <div className="pt-cl-grid" key={kind}>
        {kind === 'performance' ? (
          <>
            <label className="field">
              <span className="field-label">Engine type</span>
              <select className="select select-sm" value={settings.propulsion ?? ''} onChange={(e) => set({ propulsion: (e.target.value || undefined) as PerfCheckSettings['propulsion'] })}>
                <option value="">From the log</option>
                <option value="jet">Jet</option>
                <option value="propeller">Propeller</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Thrust line κ (deg, nose up)</span>
              <input className="input input-sm" inputMode="decimal" defaultValue={settings.thrustAngleDeg ?? ''} placeholder="0" onBlur={(e) => set({ thrustAngleDeg: num(e.target.value) })} />
            </label>
            <label className="field">
              <span className="field-label">Standard weight (lb)</span>
              <input className="input input-sm" inputMode="decimal" defaultValue={settings.referenceWeightLb ?? ''} placeholder="the set’s mean" onBlur={(e) => set({ referenceWeightLb: num(e.target.value) && (num(e.target.value) as number) > 0 ? num(e.target.value) : undefined })} />
            </label>
            <label className="field">
              <span className="field-label">Standard pressure altitude (ft)</span>
              <input className="input input-sm" inputMode="decimal" defaultValue={settings.referenceAltitudeFt ?? ''} placeholder="the set’s mean" onBlur={(e) => set({ referenceAltitudeFt: num(e.target.value) })} />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Pitch trim</span>
              <select className="select select-sm" value={settings.trimType ?? ''} onChange={(e) => set({ trimType: (e.target.value || undefined) as TrimCheckSettings['trimType'] })}>
                <option value="">Not stated</option>
                <option value="stabiliser">Trimmable stabiliser</option>
                <option value="elevator">Elevator or tab</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Trim gain G (elevator per trim unit)</span>
              <input className="input input-sm" inputMode="decimal" defaultValue={settings.gain ?? ''} placeholder="fitted" onBlur={(e) => set({ gain: num(e.target.value) && (num(e.target.value) as number) > 0 ? num(e.target.value) : undefined })} />
            </label>
            <label className="field">
              <span className="field-label">MAC (ft)</span>
              <input className="input input-sm" inputMode="decimal" defaultValue={settings.macFt ?? ''} onBlur={(e) => set({ macFt: num(e.target.value) && (num(e.target.value) as number) > 0 ? num(e.target.value) : undefined })} />
            </label>
            <label className="field">
              <span className="field-label">LEMAC (CG reference, ft)</span>
              <input className="input input-sm" inputMode="decimal" defaultValue={settings.lemacFt ?? ''} onBlur={(e) => set({ lemacFt: num(e.target.value) })} />
            </label>
          </>
        )}
        <label className="field">
          <span className="field-label">Autopilot (declared)</span>
          <select className="select select-sm" value={declared.autopilot ?? ''} onChange={(e) => setDeclared({ autopilot: (e.target.value || undefined) as ChecklistDeclared['autopilot'] })}>
            <option value="">Not declared</option>
            <option value="off">Off</option>
            <option value="on">On</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Autothrottle (declared)</span>
          <select className="select select-sm" value={declared.autothrottle ?? ''} onChange={(e) => setDeclared({ autothrottle: (e.target.value || undefined) as ChecklistDeclared['autothrottle'] })}>
            <option value="">Not declared</option>
            <option value="off">Off</option>
            <option value="on">On</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="field pt-cl-wide">
          <span className="field-label">Modes used (e.g. ALT HOLD + HDG, A/T off)</span>
          <input className="input input-sm" maxLength={200} defaultValue={declared.modes ?? ''} onBlur={(e) => setDeclared({ modes: e.target.value.trim() || undefined })} />
        </label>
        {(kind === 'static' ? (['vsKias', 'alphaStallDeg', 'vmoKias', 'mmo'] as const) : (['vsKeas', 'vmoKias', 'mmo'] as const)).map((key) => (
          <label key={key} className="field">
            <span className="field-label">{LIMIT_LABEL[key]}</span>
            <input className="input input-sm" inputMode="decimal" defaultValue={limits[key] ?? ''} placeholder="not set" onBlur={(e) => setLimit(key, e.target.value)} />
          </label>
        ))}
      </div>
      <p className="field-hint">
        A note on a test point counts as its declaration. Limits are optional: they add the stall-margin and envelope checks.
      </p>
    </details>
  )
}

const LIMIT_LABEL: Readonly<Record<string, string>> = {
  vsKias: 'Stall speed V_S (KIAS)',
  vsKeas: 'Stall speed V_S (KEAS)',
  alphaStallDeg: 'Stall angle of attack (deg)',
  vmoKias: 'V_MO (KIAS)',
  mmo: 'M_MO',
}
