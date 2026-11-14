// The "add several test points" dialogs, shown by the shell (layout/PointsToolHost) over whichever tab opened them:
// Find steady points and Add points from times. Each reads the open file and its workspace while it is open, and the
// group field both share lives here.

import { useTimeAxis } from '../../components/hooks'
import type { PointGroup } from '../../core/types'
import { closePointsTool, useActiveDataset, useWorkspace, type PointsTool } from '../../store/app'
import { MAX_GROUPS } from '../../store/defaults'
import { AddTimesDialog } from './AddTimesDialog'
import { FindSteadyDialog } from './FindSteadyDialog'
import { SPEED_POINTS_GROUP, type GroupTarget } from './pointSets'
import './points.css'

export function PointsTools({ kind, datasetId }: PointsTool) {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  const axis = useTimeAxis()
  if (!ds || !ws || !axis || ds.id !== datasetId) return null
  return kind === 'steady' ? (
    <FindSteadyDialog ds={ds} ws={ws} axis={axis} onClose={closePointsTool} />
  ) : (
    <AddTimesDialog ds={ds} ws={ws} axis={axis} onClose={closePointsTool} />
  )
}

const NEW_GROUP = '__new__'

/**
 * Which group the new points go in: one of the file's, or a new one named here. It sits in the dialog's footer, beside
 * the button that adds them ("Add to [Speed points] … Add 16 test points").
 */
export function GroupField({
  groups,
  target,
  onChange,
}: {
  groups: readonly PointGroup[]
  target: GroupTarget
  onChange: (target: GroupTarget) => void
}) {
  const full = groups.length >= MAX_GROUPS
  return (
    <div className="pt-tool-group" role="group" aria-label="Group for the new test points">
      <label className="pt-tool-to">
        <span>Add to</span>
        <select
          className="select select-sm"
          value={target.kind === 'existing' ? target.id : NEW_GROUP}
          data-testid="points-tool-group"
          onChange={(event) =>
            onChange(
              event.target.value === NEW_GROUP
                ? { kind: 'new', name: SPEED_POINTS_GROUP }
                : { kind: 'existing', id: event.target.value },
            )
          }
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value={NEW_GROUP} disabled={full}>
            {full ? `New group… (a file has at most ${MAX_GROUPS})` : 'New group…'}
          </option>
        </select>
      </label>
      {target.kind === 'new' && (
        <input
          className="input input-sm pt-tool-group-name"
          value={target.name}
          maxLength={60}
          placeholder={SPEED_POINTS_GROUP}
          aria-label="New group name"
          title="Name of the new group"
          onChange={(event) => onChange({ kind: 'new', name: event.target.value })}
        />
      )}
    </div>
  )
}
