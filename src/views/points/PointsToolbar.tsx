// The Test points toolbar: the groups (rename, colour, delete), a new group, the tracked columns, saving the current
// selection, and the exports (table, MATLAB, session) with the session import.

import { ColumnsIcon, PlusIcon, TrashIcon } from '@primer/octicons-react'
import { useState, type FormEvent } from 'react'
import { ChannelPicker } from '../../components/ChannelPicker'
import { ExportMenu, type ExportItem } from '../../components/ExportMenu'
import { pointsTableCsv } from '../../core/export/csv'
import { downloadText } from '../../core/export/download'
import type { Dataset, PointGroup, Workspace } from '../../core/types'
import { exportMatlab, saveSessionFile } from '../../layout/fileActions'
import { addGroup, getWorkspace, removeGroup, setTracked, toast, updateGroup } from '../../store/app'
import { Dropdown } from '../../ui/Dropdown'
import { exportStem } from '../xy/xyControls'
import { MAX_TRACKED, SLOT_NAMES } from './pointsModel'

interface PointsToolbarProps {
  ds: Dataset
  ws: Workspace
  /** There is a selection to save */
  canAdd: boolean
  onAdd: () => void
  onImportSession: () => void
}

export function PointsToolbar({ ds, ws, canAdd, onAdd, onImportSession }: PointsToolbarProps) {
  const perGroup = new Map<string, number>()
  for (const p of ws.points) perGroup.set(p.groupId, (perGroup.get(p.groupId) ?? 0) + 1)
  const hasPoints = ws.points.length > 0

  const items: ExportItem[] = [
    {
      section: 'Table',
      label: 'CSV table',
      hint: 'Mean, σ, min, max and drift of every tracked channel',
      disabled: !hasPoints,
      onSelect: () => {
        const current = getWorkspace() ?? ws
        downloadText(`${exportStem(ds.name, 'points')}.csv`, pointsTableCsv(ds, current, current.tracked), 'text/csv')
      },
    },
    {
      section: 'MATLAB',
      label: 'MATLAB script: table and X–Y plot',
      hint: 'Re-reads the log: the test-point table and the X–Y plot',
      onSelect: () => void exportMatlab({ part: 'xy' }),
    },
    {
      section: 'Session',
      label: 'Session file (JSON)',
      hint: 'Test points, groups, plots and formulas, not the data',
      onSelect: saveSessionFile,
    },
    {
      label: 'Import session…',
      hint: 'Replace this file’s workspace from a session file',
      onSelect: onImportSession,
    },
  ]

  return (
    <div className="view-toolbar pt-toolbar">
      <div className="view-toolbar-group pt-groups" role="group" aria-label="Test-point groups">
        <span className="view-toolbar-label">Groups</span>
        {ws.groups.map((g) => (
          <GroupChip
            key={g.id}
            group={g}
            count={perGroup.get(g.id) ?? 0}
            canDelete={ws.groups.length > 1}
            fallback={ws.groups.find((other) => other.id !== g.id)?.name ?? ''}
          />
        ))}
        <Dropdown
          label={
            <>
              <PlusIcon size={14} /> Group
            </>
          }
          buttonClassName="btn btn-sm btn-ghost"
          title="Add a test-point group"
          width={280}
          haspopup="dialog"
        >
          {(close) => <NewGroupForm close={close} />}
        </Dropdown>
      </div>
      <div className="view-toolbar-spacer" />
      <div className="view-toolbar-group pt-actions">
        <ChannelPicker
          dataset={ds}
          value={ws.tracked}
          onChange={(ids) => setTracked(ids)}
          multiple
          max={MAX_TRACKED}
          ariaLabel="Columns: channels shown as mean ± σ"
          title="Channels shown as mean ± σ columns"
          buttonClassName="btn btn-sm btn-outline pt-columns"
          align="right"
          label={
            <>
              <ColumnsIcon size={14} />
              <span>Columns</span>
              <span className="badge badge-count">{ws.tracked.length}</span>
            </>
          }
        />
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={!canAdd}
          title={canAdd ? 'Save the selection from Time history as a test point' : 'Drag a selection in Time history (Select mode) first'}
          onClick={onAdd}
        >
          <PlusIcon size={14} /> Add from selection
        </button>
        <ExportMenu items={items} testId="points-export-menu" />
      </div>
    </div>
  )
}

function GroupChip({ group, count, canDelete, fallback }: { group: PointGroup; count: number; canDelete: boolean; fallback: string }) {
  return (
    <Dropdown
      label={
        <>
          <span className="chip-dot" aria-hidden="true" />
          <span className="pt-chip-name">{group.name}</span>
          <span className="pt-chip-count">{count}</span>
        </>
      }
      buttonClassName={`chip chip-md pt-group-chip slot-${group.slot}`}
      title={`${group.name}: ${count} point${count === 1 ? '' : 's'}. Click to rename, recolour or delete.`}
      width={284}
      haspopup="dialog"
    >
      {(close) => <GroupMenu group={group} count={count} canDelete={canDelete} fallback={fallback} close={close} />}
    </Dropdown>
  )
}

function GroupMenu({
  group,
  count,
  canDelete,
  fallback,
  close,
}: {
  group: PointGroup
  count: number
  canDelete: boolean
  fallback: string
  close: () => void
}) {
  const [name, setName] = useState(group.name)
  // Saved as it is typed (a closing menu fires no blur); an empty name keeps the last one.
  const rename = (text: string) => {
    setName(text)
    const next = text.trim().slice(0, 60)
    if (next && next !== group.name) updateGroup(group.id, { name: next })
  }
  return (
    <div className="pt-group-menu">
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input input-sm"
          value={name}
          maxLength={60}
          aria-label="Group name"
          onChange={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close()
          }}
        />
      </label>
      <div className="field">
        <span className="field-label">Colour</span>
        <div className="pt-swatches" role="radiogroup" aria-label="Group colour">
          {SLOT_NAMES.map((colour, slot) => (
            <button
              key={colour}
              type="button"
              role="radio"
              aria-checked={slot === group.slot}
              aria-label={colour}
              title={colour}
              className={`pt-swatch slot-${slot}`}
              onClick={() => updateGroup(group.id, { slot })}
            />
          ))}
        </div>
      </div>
      <div className="menu-divider" />
      <button
        type="button"
        className="menu-item menu-item-danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'A file always keeps one group'}
        onClick={() => {
          removeGroup(group.id)
          close()
          toast(
            count
              ? `Deleted the group “${group.name}”: its ${count} point${count === 1 ? '' : 's'} moved to “${fallback}”.`
              : `Deleted the group “${group.name}”.`,
            'info',
          )
        }}
      >
        <TrashIcon size={14} />
        <span className="pt-delete-text">
          <span>Delete group</span>
          {canDelete && count > 0 && (
            <small>
              Its {count} point{count === 1 ? '' : 's'} move to {fallback}
            </small>
          )}
          {!canDelete && <small>A file always keeps one group</small>}
        </span>
      </button>
    </div>
  )
}

function NewGroupForm({ close }: { close: () => void }) {
  const [name, setName] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    addGroup(name)
    close()
  }
  return (
    <form className="pt-group-menu" onSubmit={submit}>
      <label className="field">
        <span className="field-label">New group</span>
        <input
          className="input input-sm"
          value={name}
          maxLength={60}
          placeholder="e.g. CG aft, Flaps 15, Climbs"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="pt-menu-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary">
          Add group
        </button>
      </div>
    </form>
  )
}
