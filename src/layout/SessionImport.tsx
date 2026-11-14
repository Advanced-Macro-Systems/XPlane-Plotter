// The import dialog for a session file opened from the shell (Open file, a drop, Settings → Load session file) or from
// Test points: shown while fileActions holds one for the open file. It reads the dataset and workspace only while it
// is open, so the always-mounted shell never keeps a closed file's data alive.

import { useSyncExternalStore } from 'react'
import { ImportSessionDialog } from '../components/ImportSessionDialog'
import { useActiveDataset, useWorkspace } from '../store/app'
import { closeSessionImport, getPendingSession, subscribePendingSession, type PendingSession } from './fileActions'

export function SessionImport() {
  const pending = useSyncExternalStore(subscribePendingSession, getPendingSession)
  return pending ? <PendingImport pending={pending} /> : null
}

function PendingImport({ pending }: { pending: PendingSession }) {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  // Asked for another file (since closed, or switched away from): nothing to confirm here.
  if (!ds || !ws || ds.id !== pending.datasetId) return null
  return <ImportSessionDialog ds={ds} ws={ws} session={pending.session} onClose={closeSessionImport} />
}
