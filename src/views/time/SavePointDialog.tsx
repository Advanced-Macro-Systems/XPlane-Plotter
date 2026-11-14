// "Save test point": name the selected window and choose its group (or start a new one). Enter saves.

import { useId, useState, type FormEvent } from 'react'
import { rangeText } from '../../components/hooks'
import type { Dataset, RowRange, TimeAxis, Workspace } from '../../core/types'
import { addGroup, addPoint, getActiveDataset, removePoint, setSelection, toast } from '../../store/app'
import { Modal } from '../../ui/Modal'
import { suggestPointName } from '../points/pointsModel'
import { defaultGroupId } from './pointDraft'

const NEW_GROUP = '__new__'

/** The group the last point went in, per dataset, for the next save. */
const lastGroup = new Map<string, string>()

interface SavePointDialogProps {
  ds: Dataset
  ws: Workspace
  axis: TimeAxis
  range: RowRange
  onClose: () => void
}

export function SavePointDialog({ ds, ws, axis, range, onClose }: SavePointDialogProps) {
  const formId = useId()
  // The same suggestion as Test points' "Add from selection": the mean airspeed ("250 KIAS"), else "Point N".
  const [defaultName] = useState(() => suggestPointName(ds, range, ws.points.map((p) => p.name)))
  const [name, setName] = useState(defaultName)
  const [groupId, setGroupId] = useState(() => defaultGroupId(ws.groups, lastGroup.get(ds.id)))
  const [groupName, setGroupName] = useState('')
  const creating = groupId === NEW_GROUP || ws.groups.length === 0

  const save = (event?: FormEvent) => {
    event?.preventDefault()
    const pointName = name.trim() || defaultName
    const target = creating ? addGroup(groupName.trim() || `Test ${ws.groups.length + 1}`) : groupId
    const id = addPoint({ name: pointName, groupId: target, start: range[0], end: range[1] })
    lastGroup.set(ds.id, target)
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
          <button type="submit" form={formId} className="btn btn-primary" data-testid="save-point-confirm">
            Save
          </button>
        </>
      }
    >
      <form id={formId} className="tv-save" onSubmit={save}>
        <p className="tv-save-range num">{rangeText(ds, axis, range)}</p>
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
              autoFocus
              onChange={(event) => setGroupName(event.target.value)}
            />
          </label>
        )}
        <p className="field-hint">The point keeps its rows, so it stays put whichever time axis you use.</p>
      </form>
    </Modal>
  )
}
