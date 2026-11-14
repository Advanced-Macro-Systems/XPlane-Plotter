// "Add from selection": saves the current Time-history selection as a test point, like Time history's own
// "Save test point" (name, group or a new group, an optional note; Enter saves; the toast can undo it).

import { useId, useState, type FormEvent } from 'react'
import { rangeText } from '../../components/hooks'
import type { Dataset, RowRange, TimeAxis, Workspace } from '../../core/types'
import { addGroup, addPoint, getActiveDataset, removePoint, setSelection, toast } from '../../store/app'
import { Modal } from '../../ui/Modal'
import { suggestPointName } from './pointsModel'

const NEW_GROUP = '__new__'

interface AddPointDialogProps {
  ds: Dataset
  ws: Workspace
  axis: TimeAxis
  range: RowRange
  onClose: () => void
}

export function AddPointDialog({ ds, ws, axis, range, onClose }: AddPointDialogProps) {
  const formId = useId()
  const [defaultName] = useState(() => suggestPointName(ds, range, ws.points.map((p) => p.name)))
  const [name, setName] = useState(defaultName)
  // The group the latest point went in, else the first group.
  const [groupId, setGroupId] = useState(() => ws.points.at(-1)?.groupId ?? ws.groups[0]?.id ?? NEW_GROUP)
  const [groupName, setGroupName] = useState('')
  const [note, setNote] = useState('')
  const creating = groupId === NEW_GROUP || !ws.groups.some((g) => g.id === groupId)

  const save = (event?: FormEvent) => {
    event?.preventDefault()
    const pointName = (name.trim() || defaultName).slice(0, 80)
    const target = creating ? addGroup(groupName.trim() || `Test ${ws.groups.length + 1}`) : groupId
    const id = addPoint({
      name: pointName,
      groupId: target,
      start: range[0],
      end: range[1],
      ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}),
    })
    setSelection(null)
    onClose()
    const datasetId = ds.id
    toast(`Saved test point “${pointName}”.`, 'success', {
      label: 'Undo',
      datasetId,
      run: () => {
        if (getActiveDataset()?.id !== datasetId) return
        removePoint(id)
        setSelection(range)
      },
    })
  }

  return (
    <Modal
      title="Save test point"
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn-primary">
            Save
          </button>
        </>
      }
    >
      <form id={formId} className="pt-form" onSubmit={save}>
        <p className="pt-form-range num">{rangeText(ds, axis, range)}</p>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={80}
            placeholder={defaultName}
            data-autofocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Group</span>
          <select className="select" value={creating ? NEW_GROUP : groupId} onChange={(event) => setGroupId(event.target.value)}>
            {ws.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value={NEW_GROUP}>New group…</option>
          </select>
        </label>
        {creating && (
          <label className="field">
            <span className="field-label">New group name</span>
            <input
              className="input"
              value={groupName}
              maxLength={60}
              placeholder={`Test ${ws.groups.length + 1}`}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">
            Note <span className="subtle">(optional)</span>
          </span>
          <input
            className="input"
            value={note}
            maxLength={500}
            placeholder="e.g. flaps up, trimmed hands-off, light turbulence"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </form>
    </Modal>
  )
}
