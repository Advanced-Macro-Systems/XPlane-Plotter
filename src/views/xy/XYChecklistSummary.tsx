// The X–Y tab's one-line test-validity summary: when the range-and-endurance markers are on or the plot is a trim
// curve, the checklist's verdict as a status, the points by verdict, the notes, and "Open checklist" (the full list is
// in the Test points tab).

import { ChecklistIcon } from '@primer/octicons-react'
import { StatusBadge } from '../../components/Checklist'
import { openChecklist } from '../../store/app'
import type { XYChecklist } from '../points/checklistModel'

export function XYChecklistSummary({ checklist, fitTarget }: { checklist: XYChecklist; fitTarget: 'samples' | 'means' }) {
  const id = checklist.kind === 'performance' ? 'perf' : 'trim'
  const title = checklist.kind === 'performance' ? 'Test validity — range and endurance' : 'Test validity — static stability'
  const { summary } = checklist
  return (
    <section className="card xy-checks" data-testid={`xy-checks-${id}`} aria-label={title}>
      <div className="xy-checks-row">
        <span className="xy-checks-title">
          <ChecklistIcon size={16} aria-hidden="true" /> {title}
        </span>
        <StatusBadge status={summary.status} testId={`xy-checks-${id}-status`} />
        <span className="xy-checks-counts">
          {summary.points}
          {summary.notes ? ` · ${summary.notes}` : ''}
        </span>
        <button type="button" className="btn btn-sm btn-outline xy-checks-open" data-testid={`xy-checks-${id}-open`} onClick={() => openChecklist(checklist.kind)}>
          Open checklist
        </button>
      </div>
      <p className="xy-checks-verdict" data-testid={`xy-checks-${id}-verdict`}>
        {summary.verdict}
        {checklist.fitUsedOnly && fitTarget === 'means' ? ' The fit runs through the used points only.' : ''}
        {checklist.fitUsedOnly && fitTarget === 'samples' ? ' (“Fit the used points only” applies to fits through the point means.)' : ''}
      </p>
    </section>
  )
}
