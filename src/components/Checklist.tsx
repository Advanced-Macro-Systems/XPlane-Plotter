// The test-validity checklist's shared parts (core/checklists), used by the Test points panel, the Dynamic modes card
// and the X–Y summary: a status with its icon and word (never colour alone), the verdict, a check row (title, measured
// against the criterion, citations, a "judgement" tag, a one-line hint and the "Why" behind it), per-point summary rows
// and the questions the sources leave open.

import {
  AlertFillIcon,
  CheckCircleFillIcon,
  CircleSlashIcon,
  CommentDiscussionIcon,
  InfoIcon,
  XCircleFillIcon,
} from '@primer/octicons-react'
import type { ReactNode } from 'react'
import type { Check, CheckStatus, OpenItem, PointStatus, Verdict } from '../core/checklists/types'
import { STATUS_LABEL } from '../core/checklists/types'
import './checklist.css'

const ICON: Readonly<Record<CheckStatus, typeof InfoIcon>> = {
  pass: CheckCircleFillIcon,
  warn: AlertFillIcon,
  fail: XCircleFillIcon,
  'not-checkable': CircleSlashIcon,
  'not-settled': CommentDiscussionIcon,
  info: InfoIcon,
}

/** A status as an icon and its word, in the status colour. */
export function StatusBadge({ status, label, testId }: { status: CheckStatus; label?: string; testId?: string }) {
  const Icon = ICON[status]
  return (
    <span className={`ck-status ck-status-${status}`} data-testid={testId}>
      <Icon size={14} aria-hidden="true" />
      {label !== undefined && <span className="sr-only">{STATUS_LABEL[status]}: </span>}
      <span>{label ?? STATUS_LABEL[status]}</span>
    </span>
  )
}

const POINT_STATUS: Readonly<Record<PointStatus, CheckStatus>> = {
  used: 'pass',
  correct: 'info',
  'plot-only': 'warn',
  excluded: 'fail',
  'cannot-confirm': 'not-checkable',
  'left-out': 'not-settled',
}

/** A test point's place in the set ("Use", "Correct", "Plot only", "Retest", "Cannot confirm", "Left out"). */
export function PointBadge({ status, label }: { status: PointStatus; label: string }) {
  const shown = POINT_STATUS[status]
  const Icon = ICON[shown]
  return (
    <span className={`ck-status ck-status-${shown}`}>
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

const VERDICT_STATUS: Readonly<Record<Verdict['kind'], CheckStatus>> = {
  acceptable: 'pass',
  retest: 'fail',
  'cannot-confirm': 'not-checkable',
  'fix-analysis': 'warn',
  'no-data': 'info',
}

/** The verdict line, in NATO Table 29-I's words. */
export function VerdictBanner({ verdict, testId, children }: { verdict: Verdict; testId?: string; children?: ReactNode }) {
  const status = VERDICT_STATUS[verdict.kind]
  const Icon = ICON[status]
  return (
    <div className={`ck-verdict ck-verdict-${status}`} data-testid={testId} role="status">
      <Icon size={16} aria-hidden="true" />
      <div className="ck-verdict-text">
        <strong>{verdict.text}</strong>
        {children}
      </div>
    </div>
  )
}

/** One check: status, title, measured vs criterion, hint, citations, judgement tag; "Why" opens the reasoning. */
export function CheckRow({ check, testId, extra }: { check: Check; testId?: string; extra?: ReactNode }) {
  return (
    <li className={`ck-row ck-row-${check.status}`} data-testid={testId}>
      <div className="ck-row-head">
        <StatusBadge status={check.status} />
        <span className="ck-row-title">{check.title}</span>
        {check.judgement && (
          <span className="ck-tag" title="The thresholds are engineering judgement: no source gives the number">
            judgement
          </span>
        )}
        {check.severity === 'advisory' && <span className="ck-tag ck-tag-quiet">advisory</span>}
        {check.severity === 'analysis' && <span className="ck-tag ck-tag-quiet">analysis</span>}
      </div>
      {check.measured && (
        <p className="ck-line">
          <span className="ck-line-label">Measured</span> <span className="ck-measured">{check.measured}</span>
        </p>
      )}
      <p className="ck-line">
        {check.status !== 'not-checkable' && (
          <>
            <span className="ck-line-label">Criterion</span>{' '}
          </>
        )}
        <span className="ck-criterion">{check.criterion}</span>
      </p>
      {check.hint && <p className="ck-hint">{check.hint}</p>}
      <div className="ck-foot">
        {check.citations.length > 0 && (
          <span className="ck-cites" aria-label="Sources">
            {check.citations.join(' · ')}
          </span>
        )}
        <details className="ck-why">
          <summary>Why</summary>
          <p>{check.why}</p>
          {check.follows && (
            <p>
              <strong>Where the sources differ:</strong> follows {check.follows}.
            </p>
          )}
          <p className="ck-why-meta">
            Check “{check.id}”, {check.severity}, over {check.interval}.
          </p>
        </details>
        {extra}
      </div>
    </li>
  )
}

/** A list of checks. */
export function CheckList({ checks, testId, rowTestId }: { checks: readonly Check[]; testId?: string; rowTestId?: string }) {
  return (
    <ul className="ck-list" data-testid={testId}>
      {checks.map((c) => (
        <CheckRow key={`${c.id}|${c.pointId ?? ''}|${c.title}`} check={c} testId={rowTestId} />
      ))}
    </ul>
  )
}

/** The questions the sources do not settle. */
export function OpenItems({ items, testId }: { items: readonly OpenItem[]; testId?: string }) {
  if (!items.length) return null
  return (
    <section className="ck-open" aria-label="Not settled by the sources" data-testid={testId}>
      <h4 className="ck-open-title">
        <CommentDiscussionIcon size={14} aria-hidden="true" /> Not settled by the sources — ask on EdDiscussion
      </h4>
      <ul className="ck-open-list">
        {items.map((o) => (
          <li key={o.id}>
            <details>
              <summary>
                <span className="ck-open-id">{o.id}</span> {o.title}
              </summary>
              <p>{o.question}</p>
              <p className="ck-open-meanwhile">
                <strong>Meanwhile:</strong> {o.meanwhile}
              </p>
              {o.citations.length > 0 && <p className="ck-cites">{o.citations.join(' · ')}</p>}
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}
