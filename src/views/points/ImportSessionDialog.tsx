// Confirms a session import: says whether the session was saved for this very file (signature) and what it holds,
// and warns when it was not (test points are row ranges, so they would land on other data).

import { AlertIcon, CheckCircleIcon } from '@primer/octicons-react'
import type { SessionFile } from '../../core/export/session'
import type { Dataset, Workspace } from '../../core/types'
import { importWorkspace, toast } from '../../store/app'
import { Modal } from '../../ui/Modal'

function savedAt(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-GB')} ${one}${n === 1 ? '' : 's'}`

interface ImportSessionDialogProps {
  ds: Dataset
  ws: Workspace
  session: SessionFile
  onClose: () => void
}

export function ImportSessionDialog({ ds, ws, session, onClose }: ImportSessionDialogProps) {
  const matches = session.dataset.signature === ds.signature
  const incoming = session.workspace
  const when = savedAt(session.savedAt)

  const apply = () => {
    importWorkspace(incoming)
    onClose()
    toast(
      `Imported the session: ${plural(incoming.points.length, 'test point')} in ${plural(incoming.groups.length, 'group')}.`,
      'success',
    )
  }

  return (
    <Modal
      title="Import session"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} data-autofocus>
            {matches ? 'Replace workspace' : 'Import anyway'}
          </button>
        </>
      }
    >
      <div className="pt-import">
        {matches ? (
          <div className="callout callout-success" role="note">
            <CheckCircleIcon size={16} />
            <span>Saved for this recording ({ds.name}){when ? ` on ${when}` : ''}.</span>
          </div>
        ) : (
          <div className="callout callout-warning" role="note">
            <AlertIcon size={16} />
            <span>
              This session was saved for <strong>{session.dataset.name}</strong> (
              {session.dataset.rowCount.toLocaleString('en-GB')} rows)
              {session.dataset.name === ds.name ? ', a different recording with the same name,' : ''} not for the open file{' '}
              <strong>{ds.name}</strong> ({ds.rowCount.toLocaleString('en-GB')} rows). Test points are stored as row numbers,
              so they may land on different flight data, and channels this file lacks are dropped.
            </span>
          </div>
        )}
        <dl className="pt-import-facts">
          <div>
            <dt>Test points</dt>
            <dd>
              {incoming.points.length.toLocaleString('en-GB')}
              <span className="subtle"> (now {ws.points.length.toLocaleString('en-GB')})</span>
            </dd>
          </div>
          <div>
            <dt>Groups</dt>
            <dd>{incoming.groups.length}</dd>
          </div>
          <div>
            <dt>Time-history panels</dt>
            <dd>{incoming.panels.length}</dd>
          </div>
          <div>
            <dt>Formulas</dt>
            <dd>{incoming.derived.length}</dd>
          </div>
        </dl>
        <p className="pt-import-note">
          Importing replaces this file’s test points, groups, plot settings and formulas. Export a session first if you
          want to keep the current ones.
        </p>
      </div>
    </Modal>
  )
}
