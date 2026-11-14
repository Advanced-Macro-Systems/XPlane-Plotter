// Test points: the saved windows of steady flight (trim points) and manoeuvre responses, with the mean ± σ of every
// tracked channel and a steadiness check, grouped and colour-coded. Points are saved in Time history (or here, from
// the current selection), found automatically (Find steady points) or typed as times (Add from times); this view
// names, groups, hides, sorts and exports them, and jumps to Time history or Dynamic modes for one point. The pure
// parts live in pointsModel.ts, pointSets.ts, steadyModel.ts and timesTable.ts.

import { CopyIcon, GraphIcon, PasteIcon, PinIcon, SearchIcon } from '@primer/octicons-react'
import { useMemo, useRef, useState } from 'react'
import { useChannels, useTimeAxis } from '../../components/hooks'
import { pointsTableCsv } from '../../core/export/csv'
import { copyText } from '../../core/export/download'
import type { Dataset, TimeAxis, Workspace } from '../../core/types'
import { loadSessionFile } from '../../layout/fileActions'
import { openPointsTool, setTab, toast, useActiveDataset, useApp, useWorkspace } from '../../store/app'
import { AddPointDialog } from './AddPointDialog'
import { PointsTable } from './PointsTable'
import { PointsToolbar } from './PointsToolbar'
import { buildPointRows, pointCounts, sortPointRows, type PointSortKey, type SortDirection } from './pointsModel'
import './points.css'

export function PointsView() {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  const axis = useTimeAxis()
  return (
    <div className="view" data-testid="view-points">
      {ds && ws && axis && <PointsWorkspace ds={ds} ws={ws} axis={axis} />}
    </div>
  )
}

const count = (n: number) => n.toLocaleString('en-GB')

function PointsWorkspace({ ds, ws, axis }: { ds: Dataset; ws: Workspace; axis: TimeAxis }) {
  const selection = useApp((s) => s.selection)
  const [sort, setSort] = useState<{ key: PointSortKey; dir: SortDirection }>({ key: 'time', dir: 'asc' })
  const [adding, setAdding] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const tracked = useChannels(ds, ws.tracked)
  const points = ws.points
  const groups = ws.groups

  const rows = useMemo(() => buildPointRows(ds, { points, groups }, axis, tracked), [ds, points, groups, axis, tracked])
  const sorted = useMemo(() => sortPointRows(rows, sort.key, sort.dir, groups), [rows, sort, groups])
  const counts = pointCounts(rows)

  const chooseSession = () => fileRef.current?.click()

  const copyTable = async () => {
    const ok = await copyText(pointsTableCsv(ds, ws, ws.tracked, '\t'))
    if (ok) toast('Copied the test-point table as tab-separated values: paste into Excel or MATLAB.', 'success')
    else toast('The browser did not allow copying. Use Export → CSV table instead.', 'error')
  }

  const summary = [
    counts.steady ? `${count(counts.steady)} steady` : '',
    counts.drifting ? `${count(counts.drifting)} drifting` : '',
    counts.hidden ? `${count(counts.hidden)} hidden from plots` : '',
    `${count(groups.length)} group${groups.length === 1 ? '' : 's'}`,
  ].filter(Boolean)

  return (
    <>
      <PointsToolbar
        ds={ds}
        ws={ws}
        canAdd={selection !== null}
        onAdd={() => setAdding(true)}
        onImportSession={chooseSession}
      />
      <div className="pt-main">
          {points.length === 0 ? (
            <EmptyPoints canAdd={selection !== null} onAdd={() => setAdding(true)} />
          ) : (
            <>
              <header className="pt-heading">
                <div className="pt-heading-text">
                  <p className="eyebrow">Test points</p>
                  <h2>
                    {count(points.length)} test point{points.length === 1 ? '' : 's'}
                  </h2>
                  <p className="pt-heading-sub">{summary.join(' · ')}</p>
                </div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copyTable()}>
                  <CopyIcon size={14} /> Copy table
                </button>
              </header>
              <PointsTable
                ds={ds}
                groups={groups}
                rows={sorted}
                tracked={tracked}
                axis={axis}
                sort={sort}
                onSort={(key) =>
                  setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
                }
              />
              <p className="pt-footnote">
                Each cell is the mean ± 1σ (sample standard deviation) over the point’s rows.{' '}
                <span className="pt-drift-dot pt-drift-dot-inline" aria-hidden="true" /> marks a channel still drifting: its
                least-squares trend moves it across the window by more than twice its scatter. Hidden points stay in the
                table and exports but are left out of X–Y plots.
              </p>
            </>
          )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          // Read here, confirmed in the import dialog the shell shows (as for a session opened anywhere else).
          if (file) void loadSessionFile(file)
        }}
      />
      {adding && selection && (
        <AddPointDialog ds={ds} ws={ws} axis={axis} range={selection} onClose={() => setAdding(false)} />
      )}
    </>
  )
}

function EmptyPoints({ canAdd, onAdd }: { canAdd: boolean; onAdd: () => void }) {
  return (
    <section className="pt-empty" aria-labelledby="pt-empty-title">
      <span className="pt-empty-icon" aria-hidden="true">
        <PinIcon size={24} />
      </span>
      <h2 id="pt-empty-title">No test points yet</h2>
      <p className="pt-empty-lead">
        A test point is a saved window of flight: a steady trim point, or the response to a doublet or a pulse. Each one
        gets the mean ± σ of the channels you track, a steadiness check, and can be plotted in X–Y and fitted in Dynamic
        modes.
      </p>
      <ol className="pt-steps">
        <li>
          Open <strong>Time history</strong>.
        </li>
        <li>
          Choose <strong>Select</strong> and drag across a steady stretch of flight.
        </li>
        <li>
          Press <strong>Save test point</strong>, name it and pick its group.
        </li>
      </ol>
      <p className="pt-empty-lead">
        Or let the app do it: <strong>Find steady points</strong> finds every stretch of steady, level flight (a speed held,
        no climb, wings level), and <strong>Add from times</strong> takes the times you wrote down, with the speed of each.
      </p>
      <div className="pt-empty-actions">
        <button type="button" className="btn btn-primary" onClick={() => openPointsTool('steady')}>
          <SearchIcon size={16} /> Find steady points…
        </button>
        <button type="button" className="btn btn-outline" onClick={() => openPointsTool('times')}>
          <PasteIcon size={16} /> Add from times…
        </button>
        <button type="button" className="btn btn-outline" onClick={() => setTab('time')}>
          <GraphIcon size={16} /> Go to Time history
        </button>
        {canAdd && (
          <button type="button" className="btn btn-outline" onClick={onAdd}>
            Save the current selection
          </button>
        )}
      </div>
    </section>
  )
}
