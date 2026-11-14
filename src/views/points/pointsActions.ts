// Store actions of the "add several test points" dialogs that come with an Undo in their toast.

import { toast, updateWorkspace, useApp } from '../../store/app'
import { newId } from '../../store/defaults'
import { addPointSet, undoPointSet, type GroupTarget, type NewPoint, type PointSetRecord } from './pointSets'

/**
 * Adds `points` to the open file's target group in one change, and says so with an Undo (the points go, and a group
 * made for them while it is still empty). Returns how many were added and the group's name, or null when the file is
 * no longer the active one.
 */
export function addPointsWithUndo(
  datasetId: string,
  points: readonly NewPoint[],
  target: GroupTarget,
): { count: number; group: string } | null {
  if (useApp.getState().activeId !== datasetId || points.length === 0) return null
  let record: PointSetRecord | null = null
  let group = ''
  updateWorkspace((ws) => {
    const result = addPointSet(ws, points, target, (prefix) => newId(prefix))
    record = result.record
    group = result.ws.groups.find((g) => g.id === result.record.groupId)?.name ?? ''
    return result.ws
  })
  const done = record as PointSetRecord | null
  if (!done) return null
  const count = done.ids.length
  toast(`Added ${count} test point${count === 1 ? '' : 's'} to “${group}”.`, 'success', {
    label: 'Undo',
    datasetId,
    run: () => {
      if (useApp.getState().activeId === datasetId) updateWorkspace((ws) => undoPointSet(ws, done))
    },
  })
  return { count, group }
}
