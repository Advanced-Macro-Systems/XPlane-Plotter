// The row above the panels: with a selection, the selection bar (its time range, steadiness stats for up to four
// plotted channels and what to do with it); without one, a hint for the pointer mode and the visible range.

import { BookmarkIcon, PulseIcon, XIcon, ZoomInIcon } from '@primer/octicons-react'
import { useMemo, useSyncExternalStore } from 'react'
import { useChannels } from '../../components/hooks'
import { formatDuration } from '../../core/time'
import type { Dataset, RowRange, TimeAxis, Workspace } from '../../core/types'
import { setModes, setSelection, setTab } from '../../store/app'
import { statChannelIds } from './panelEdit'
import type { PointerMode } from './TimePanelCard'
import type { TimeController } from './timeController'
import { formatTimeRange, isWholeWindow, selectionSummary, steadyStats, windowToRows, type XFrame } from './timeMath'

const STAT_CHANNELS = 4

interface SelectionBarProps {
  ds: Dataset
  ws: Workspace
  axis: TimeAxis
  selection: RowRange
  activePanelId: string | null
  controller: TimeController
  onSave: () => void
}

export function SelectionBar({ ds, ws, axis, selection, activePanelId, controller, onSave }: SelectionBarProps) {
  const summary = selectionSummary(ds, axis, selection)
  const statIds = useMemo(() => statChannelIds(ws.panels, activePanelId, STAT_CHANNELS), [ws.panels, activePanelId])
  const channels = useChannels(ds, statIds)
  const stats = useMemo(() => steadyStats(ds, channels, selection), [ds, channels, selection])

  return (
    <div className="tv-selbar" data-testid="selection-bar" role="region" aria-label="Selection">
      <div className="tv-selbar-row">
        <div className="tv-selbar-text">
          <span className="eyebrow tv-selbar-label">Selection</span>
          <span className="tv-selbar-range num">{summary.range}</span>
          <span className="tv-selbar-meta num">
            {summary.duration} · {summary.rows}
          </span>
        </div>
        <div className="tv-selbar-actions">
          <button type="button" className="btn btn-primary btn-sm" data-testid="save-point-button" onClick={onSave}>
            <BookmarkIcon size={16} />
            Save test point
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Zoom every panel to the selection"
            onClick={() => controller.zoomToRows(selection)}
          >
            <ZoomInIcon size={16} />
            <span className="tv-collapse">Zoom to selection</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Fit a dynamic mode (oscillation or first-order response) to the selection"
            onClick={() => {
              setModes({ source: 'selection' })
              setTab('modes')
            }}
          >
            <PulseIcon size={16} />
            <span className="tv-collapse">Analyse mode</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
            onClick={() => setSelection(null)}
          >
            <XIcon size={16} />
          </button>
        </div>
      </div>
      {stats.length > 0 && (
        <ul className="tv-stats" aria-label="Steadiness over the selection">
          {stats.map((s) => (
            <li key={s.id} className="tv-stat" title={s.title}>
              <span className="tv-stat-name">{s.name}</span>
              <span className="tv-stat-value num">
                {s.meanText}
                {s.unit && <span className="tv-stat-unit"> {s.unit}</span>}
              </span>
              <span className="tv-stat-drift num">{s.driftText}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What the pointer does in this mode, and the range the panels show. */
export function ModeHint({
  ds,
  axis,
  frame,
  mode,
  controller,
}: {
  ds: Dataset
  axis: TimeAxis
  frame: XFrame
  mode: PointerMode
  controller: TimeController
}) {
  return (
    <div className="tv-hint" role="status">
      <p className="tv-hint-text">
        {mode === 'zoom' ? (
          <>
            Scroll to zoom, drag to pan, double-click to reset. Press <kbd className="kbd">S</kbd> to select a window.
          </>
        ) : (
          <>
            Drag across any plot to select a window. <kbd className="kbd">Esc</kbd> clears it,{' '}
            <kbd className="kbd">Z</kbd> returns to zoom.
          </>
        )}
      </p>
      <VisibleRange ds={ds} axis={axis} frame={frame} controller={controller} />
    </div>
  )
}

function VisibleRange({ ds, axis, frame, controller }: { ds: Dataset; axis: TimeAxis; frame: XFrame; controller: TimeController }) {
  const window = useSyncExternalStore(controller.subscribe, controller.getWindow)
  if (isWholeWindow(window, frame)) {
    const last = ds.rowCount - 1
    return <span className="tv-hint-range num">Whole log · {formatDuration(ds.elapsed[last] - ds.elapsed[0])}</span>
  }
  const [start, end] = windowToRows(axis, frame, window)
  const last = Math.max(start, end - 1)
  return (
    <span className="tv-hint-range num">
      Showing {formatTimeRange(axis, window[0] / frame.factor, window[1] / frame.factor)} ·{' '}
      {formatDuration(ds.elapsed[last] - ds.elapsed[start])}
    </span>
  )
}
