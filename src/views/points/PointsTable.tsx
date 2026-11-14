// The test-point table: group (changeable), name (editable in place, the note under it), window on the current time
// axis, duration, rows, a steadiness badge, mean ± σ per tracked channel (drifting cells flagged), and row actions.
// The group and name columns stay put while the channel columns scroll sideways, and so do the actions.

import {
  AlertFillIcon,
  CheckIcon,
  EyeClosedIcon,
  EyeIcon,
  PulseIcon,
  TrashIcon,
  TriangleDownIcon,
  TriangleUpIcon,
  ZoomInIcon,
} from '@primer/octicons-react'
import type { KeyboardEvent } from 'react'
import { formatDuration } from '../../core/time'
import type { Channel, Dataset, PointGroup, TestPoint, TimeAxis } from '../../core/types'
import {
  getActiveDataset,
  getWorkspace,
  removePoint,
  setModes,
  setTab,
  setView,
  toast,
  updatePoint,
  updateWorkspace,
} from '../../store/app'
import {
  driftSummary,
  formatMeanSd,
  framedRange,
  reinsertPoint,
  type PointCell,
  type PointRow,
  type PointSortKey,
  type SortDirection,
} from './pointsModel'

interface PointsTableProps {
  ds: Dataset
  groups: readonly PointGroup[]
  rows: readonly PointRow[]
  tracked: readonly Channel[]
  axis: TimeAxis
  sort: { key: PointSortKey; dir: SortDirection }
  onSort: (key: PointSortKey) => void
}

export function PointsTable({ ds, groups, rows, tracked, axis, sort, onSort }: PointsTableProps) {
  return (
    <div className="pt-table-wrap">
      <table className="table pt-table" data-testid="points-table">
        <thead>
          <tr>
            <SortHeader className="pt-col-group" label="Group" sortKey="group" sort={sort} onSort={onSort} />
            <SortHeader className="pt-col-name" label="Name" sortKey="name" sort={sort} onSort={onSort} />
            <SortHeader
              className="pt-col-window"
              label="Window"
              title={`First and last row on the time axis (${axis.label})`}
              sortKey="time"
              sort={sort}
              onSort={onSort}
            />
            <th scope="col" className="num">
              Duration
            </th>
            <th scope="col" className="num">
              Rows
            </th>
            <th scope="col">Steadiness</th>
            {tracked.map((ch) => (
              <th key={ch.id} scope="col" className="num pt-col-stat" title={`${ch.meta.label}: mean ± 1σ`}>
                <span className="pt-th-name">{ch.meta.short}</span>
                {ch.meta.unit && <span className="pt-th-unit">{ch.meta.unit}</span>}
              </th>
            ))}
            <th scope="col" className="pt-col-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <PointRowView key={row.point.id} ds={ds} row={row} groups={groups} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SortHeader({
  className,
  label,
  title,
  sortKey,
  sort,
  onSort,
}: {
  className: string
  label: string
  title?: string
  sortKey: PointSortKey
  sort: { key: PointSortKey; dir: SortDirection }
  onSort: (key: PointSortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={title}
    >
      <button type="button" className={`pt-sort${active ? ' is-active' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <span className="pt-sort-icon" aria-hidden="true">
          {active && sort.dir === 'desc' ? <TriangleDownIcon size={14} /> : <TriangleUpIcon size={14} />}
        </span>
      </button>
    </th>
  )
}

function PointRowView({ ds, row, groups }: { ds: Dataset; row: PointRow; groups: readonly PointGroup[] }) {
  const { point } = row
  return (
    <tr data-testid="points-row" className={point.hidden ? 'pt-row is-hidden' : 'pt-row'}>
      <td className="pt-col-group">
        <GroupPick point={point} group={row.group} groups={groups} />
      </td>
      <td className="pt-col-name">
        <NameCell point={point} />
      </td>
      <td className="pt-col-window num">
        {row.from} – {row.to}
      </td>
      <td className="num">{formatDuration(row.seconds)}</td>
      <td className="num">{row.rows.toLocaleString('en-GB')}</td>
      <td>
        <span className="pt-status">
          <Steadiness row={row} />
          {point.hidden && <span className="chip chip-plain pt-hidden-tag">Hidden</span>}
        </span>
      </td>
      {row.cells.map((cell) => (
        <StatCell key={cell.channel.id} cell={cell} />
      ))}
      <td className="pt-col-actions">
        <RowActions ds={ds} point={point} />
      </td>
    </tr>
  )
}

/** The group as a chip; a native select laid over it changes the group (no menu to clip inside the scroller). */
function GroupPick({ point, group, groups }: { point: TestPoint; group: PointGroup; groups: readonly PointGroup[] }) {
  return (
    <span className={`chip pt-group-pick slot-${group.slot}`} title={`Group: ${group.name} (click to change)`}>
      <span className="chip-dot" aria-hidden="true" />
      <span className="pt-chip-name">{group.name}</span>
      <TriangleDownIcon size={12} className="pt-group-caret" />
      <select
        className="pt-group-select"
        aria-label={`Group of ${point.name}`}
        value={group.id}
        onChange={(event) => updatePoint(point.id, { groupId: event.target.value })}
      >
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </span>
  )
}

function commitName(point: TestPoint, input: HTMLInputElement): void {
  const next = input.value.trim().slice(0, 80)
  if (!next) input.value = point.name
  else if (next !== point.name) updatePoint(point.id, { name: next })
}

function NameCell({ point }: { point: TestPoint }) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') {
      event.currentTarget.value = point.name
      event.currentTarget.blur()
    }
  }
  return (
    <div className="pt-name">
      <input
        // A rename elsewhere (or an undo) shows the new name.
        key={point.name}
        className="pt-name-input"
        defaultValue={point.name}
        maxLength={80}
        spellCheck={false}
        aria-label="Test point name"
        title="Click to rename"
        onBlur={(event) => commitName(point, event.currentTarget)}
        onKeyDown={onKeyDown}
      />
      {point.note && (
        <span className="pt-note" title={point.note}>
          {point.note}
        </span>
      )}
    </div>
  )
}

function Steadiness({ row }: { row: PointRow }) {
  if (row.drifting.length) {
    return (
      <span className="badge badge-warning" title={driftSummary(row)}>
        <AlertFillIcon size={12} /> Drifting ({row.drifting.length})
      </span>
    )
  }
  if (row.cells.some((c) => c.steady)) {
    return (
      <span className="badge badge-success" title="No tracked channel drifts by more than its scatter">
        <CheckIcon size={12} /> Steady
      </span>
    )
  }
  return (
    <span className="subtle" title="Track some channels (Columns) to judge steadiness">
      —
    </span>
  )
}

function StatCell({ cell }: { cell: PointCell }) {
  const text = formatMeanSd(cell.stats.mean, cell.stats.std)
  return (
    <td
      className={`num pt-stat${cell.hint ? ' is-drifting' : ''}`}
      title={cell.hint ? `${cell.channel.meta.label}: ${cell.hint}` : undefined}
    >
      {cell.hint && (
        <>
          <span className="pt-drift-dot" aria-hidden="true" />
          <span className="sr-only">{cell.hint}: </span>
        </>
      )}
      <span className="pt-mean">{text.mean}</span>
      {text.sd && <span className="pt-sd"> ± {text.sd}</span>}
    </td>
  )
}

/** Deletes a point; the toast's Undo puts it back with its id, in its place. */
function deletePoint(ds: Dataset, point: TestPoint): void {
  const index = getWorkspace()?.points.findIndex((p) => p.id === point.id) ?? -1
  removePoint(point.id)
  toast(`Deleted test point “${point.name}”.`, 'info', {
    label: 'Undo',
    run: () => {
      if (getActiveDataset()?.id !== ds.id) {
        toast(`Switch back to ${ds.name} to undo.`, 'info')
        return
      }
      updateWorkspace((ws) => reinsertPoint(ws, point, index < 0 ? ws.points.length : index))
    },
  })
}

function RowActions({ ds, point }: { ds: Dataset; point: TestPoint }) {
  return (
    <span className="pt-actions-cell">
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={point.hidden ? `Show ${point.name} in plots` : `Hide ${point.name} from plots`}
        title={point.hidden ? 'Hidden from X–Y plots: click to show' : 'Hide from X–Y plots'}
        onClick={() => updatePoint(point.id, { hidden: point.hidden ? undefined : true })}
      >
        {point.hidden ? <EyeClosedIcon size={16} /> : <EyeIcon size={16} />}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={`Zoom Time history to ${point.name}`}
        title="Zoom to it in Time history"
        onClick={() => {
          setView(framedRange(point.start, point.end))
          setTab('time')
        }}
      >
        <ZoomInIcon size={16} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={`Analyse ${point.name} in Dynamic modes`}
        title="Analyse it in Dynamic modes"
        onClick={() => {
          setModes({ source: `point:${point.id}` })
          setTab('modes')
        }}
      >
        <PulseIcon size={16} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm pt-delete"
        aria-label={`Delete ${point.name}`}
        title="Delete (the message offers Undo)"
        onClick={() => deletePoint(ds, point)}
      >
        <TrashIcon size={16} />
      </button>
    </span>
  )
}
