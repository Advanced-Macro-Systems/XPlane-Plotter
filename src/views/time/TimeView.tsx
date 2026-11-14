// Time history: the heart of the app. Channels plotted against time in stacked panels — one ECharts instance per
// panel, one unit per panel (no dual y-axes) — sharing the x axis, zoom, crosshair and tooltip. Zoom mode wheel-zooms
// and pans; Select mode drags out a time window to save as a test point, zoom to, or analyse on Dynamic modes.
// Pure logic: timeMath.ts, panelEdit.ts, presets.ts, pointDraft.ts; chart options: charts/options/timePanel.ts and
// timeStack.ts (export figure); imperative chart glue (zoom sync, drag band): timeController.ts.

import { AlertIcon, ArrowBothIcon, GraphIcon, XIcon, ZoomInIcon, ZoomOutIcon } from '@primer/octicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TIME_GRID, type TimeBand, type TimeXInput } from '../../charts/options/timePanel'
import { seriesColor, useChartTheme } from '../../charts/theme'
import { ExportMenu, type ExportItem } from '../../components/ExportMenu'
import { Segmented, type SegmentedOption } from '../../components/Segmented'
import { formatAxisValue, timeAxis, timeBases } from '../../core/time'
import type { Dataset, TimeBaseId, Workspace } from '../../core/types'
import { isTypingTarget } from '../../layout/shellModel'
import { setSelection, setTimeBase, setView, toast, useActiveDataset, useApp, useWorkspace } from '../../store/app'
import { exportTimeCsv, exportTimeImage, exportTimeMatlab } from './exportTime'
import { resolveActive, type PickResult } from './panelEdit'
import { resolvePresets } from './presets'
import { SavePointDialog } from './SavePointDialog'
import { ModeHint, SelectionBar } from './SelectionBar'
import { TimeController } from './timeController'
import {
  axisTitle,
  boundaryMarks,
  fitPlotHeight,
  formatTimeTick,
  formatTimeValue,
  rowsToX,
  segmentBreaks,
  xFrame,
  type StackChrome,
} from './timeMath'
import { TimePanelCard, type LaneData, type PointerMode } from './TimePanelCard'
import { PresetButton, TimeSidebar } from './TimeSidebar'
import './time.css'

/** The pointer mode and the active panel survive switching tabs (the view unmounts). */
let rememberedMode: PointerMode = 'zoom'
const rememberedActive = new Map<string, string>()

/** Fixed heights around the plots (px), matching time.css: see fitPlotHeight. */
const CHROME: StackChrome = {
  // card header 36 + borders 2 + grid padding above and below the plot
  perPanel: 38 + TIME_GRID.top + TIME_GRID.bottom,
  // content padding 12 + 24, status row 44 + gap 10, the lane, the bottom axis beyond the usual padding
  fixed: 36 + 54 + TIME_GRID.lane + (TIME_GRID.axis - TIME_GRID.bottom),
  gap: 10,
}

const MODE_OPTIONS: readonly SegmentedOption<PointerMode>[] = [
  {
    value: 'zoom',
    label: (
      <span className="tv-mode" data-testid="time-mode-zoom">
        <ZoomInIcon size={14} />
        Zoom
      </span>
    ),
    title: 'Zoom and pan: scroll to zoom, drag to pan (Z)',
  },
  {
    value: 'select',
    label: (
      <span className="tv-mode" data-testid="time-mode-select">
        <ArrowBothIcon size={14} />
        Select
      </span>
    ),
    title: 'Select a time window: drag across a plot (S)',
  },
]

export function TimeView() {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  return (
    <div className="view tv" data-testid="view-time">
      {ds && ws && <TimeWorkspace ds={ds} ws={ws} />}
    </div>
  )
}

function TimeWorkspace({ ds, ws }: { ds: Dataset; ws: Workspace }) {
  const view = useApp((s) => s.view)
  const selection = useApp((s) => s.selection)
  const theme = useChartTheme()
  const axis = useMemo(() => timeAxis(ds, ws.timeBase), [ds, ws.timeBase])
  const frame = useMemo(() => xFrame(axis), [axis])
  const [controller] = useState(() => new TimeController(setView))
  const [mode, setModeState] = useState<PointerMode>(rememberedMode)
  const [wantedActive, setWantedActive] = useState<string | null>(() => rememberedActive.get(ds.id) ?? null)
  const [reveal, setReveal] = useState<{ id: string; n: number }>({ id: '', n: 0 })
  const [saving, setSaving] = useState(false)
  const [available, setAvailable] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeId = resolveActive(ws.panels, wantedActive)

  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => controller.setOrder(ws.panels.map((p) => p.id)), [controller, ws.panels])
  useEffect(() => controller.sync(axis, frame, view), [controller, axis, frame, view])

  const setMode = useCallback((next: PointerMode) => {
    rememberedMode = next
    setModeState(next)
  }, [])
  const activate = useCallback(
    (panelId: string) => {
      rememberedActive.set(ds.id, panelId)
      setWantedActive(panelId)
    },
    [ds.id],
  )
  const showPanel = useCallback(
    (panelId: string | null) => {
      if (!panelId) return
      activate(panelId)
      setReveal((r) => ({ id: panelId, n: r.n + 1 }))
    },
    [activate],
  )
  const onPicked = useCallback(
    (result: PickResult) => {
      if (result.change === 'removed') {
        if (result.activeId) activate(result.activeId)
        return
      }
      showPanel(result.panelId)
    },
    [activate, showPanel],
  )

  // Keys: Z / S switch the pointer mode, Esc abandons a drag or clears the selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      if (document.querySelector('dialog[open]') || isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) setMode('zoom')
      else if (key === 's' && !event.shiftKey) setMode('select')
      else if (event.key === 'Escape') {
        if (!controller.cancelDrag()) {
          if (!useApp.getState().selection) return
          setSelection(null)
        }
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controller, setMode])

  // Plot heights fill the column (beyond a minimum the stack scrolls).
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setAvailable(entries[entries.length - 1]?.contentRect.height ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const plotHeight = fitPlotHeight(available, ws.panels.length, CHROME, 120, 420)

  // ------------------------------------------------------------------ what every panel draws (memoised)
  const breaks = useMemo(() => segmentBreaks(ds.segments), [ds.segments])
  const boundaries = useMemo(() => boundaryMarks(ds.segments, axis, frame), [ds.segments, axis, frame])
  const boundaryXs = useMemo(() => boundaries.map((b) => b.x), [boundaries])
  const x = useMemo<TimeXInput>(
    () => ({
      min: frame.min,
      max: frame.max,
      clock: frame.clock,
      name: axisTitle(axis),
      minSpan: frame.minSpan,
      tick: (value: number) => formatTimeTick(frame, value),
      label: (value: number) => formatTimeValue(axis, value / frame.factor, frame.step),
    }),
    [axis, frame],
  )
  const shownPoints = useMemo(() => ws.points.filter((p) => !p.hidden), [ws.points])
  const groups = useMemo(() => new Map(ws.groups.map((g) => [g.id, g])), [ws.groups])
  const bands = useMemo<TimeBand[]>(
    () =>
      shownPoints.map((p) => {
        const [x0, x1] = rowsToX(axis, frame, [p.start, p.end])
        return { x0, x1, color: seriesColor(theme, groups.get(p.groupId)?.slot ?? 0) }
      }),
    [shownPoints, axis, frame, theme, groups],
  )
  const lane = useMemo<LaneData | null>(() => {
    if (!shownPoints.length && !boundaries.length) return null
    return {
      points: shownPoints.map((p) => {
        const [x0, x1] = rowsToX(axis, frame, [p.start, p.end])
        const group = groups.get(p.groupId)
        const from = formatAxisValue(axis, axis.values[p.start])
        const to = formatAxisValue(axis, axis.values[Math.max(p.start, p.end - 1)])
        return {
          id: p.id,
          x0,
          x1,
          label: p.name,
          rows: [p.start, p.end] as const,
          slot: group?.slot ?? 0,
          title: `${p.name}${group ? ` · ${group.name}` : ''}\n${from} – ${to}${p.note ? `\n${p.note}` : ''}\nClick to zoom to it.`,
        }
      }),
      tags: boundaries.map((b) => ({ x: b.x, row: b.row, reason: b.reason })),
    }
  }, [shownPoints, boundaries, axis, frame, groups])
  const selectionX = useMemo(() => (selection ? rowsToX(axis, frame, selection) : null), [selection, axis, frame])

  return (
    <div className="view-split tv-split">
      <TimeSidebar ds={ds} ws={ws} activePanelId={activeId} onPicked={onPicked} onPreset={showPanel} />
      <div className="tv-main">
        <TimeToolbar ds={ds} ws={ws} mode={mode} onMode={setMode} controller={controller} />
        <div ref={scrollRef} className="tv-scroll">
          <div className="tv-content">
            <div className="tv-status">
              {selection ? (
                <SelectionBar
                  ds={ds}
                  ws={ws}
                  axis={axis}
                  selection={selection}
                  activePanelId={activeId}
                  controller={controller}
                  onSave={() => setSaving(true)}
                />
              ) : (
                <ModeHint ds={ds} axis={axis} frame={frame} mode={mode} controller={controller} />
              )}
            </div>
            {ws.panels.length === 0 ? (
              <NoPanels ds={ds} ws={ws} onPreset={showPanel} />
            ) : (
              <div className={`tv-panels${mode === 'select' ? ' tv-selecting' : ''}`}>
                {ws.panels.map((panel, index) => (
                  <TimePanelCard
                    key={panel.id}
                    ds={ds}
                    panel={panel}
                    index={index}
                    count={ws.panels.length}
                    axis={axis}
                    frame={frame}
                    x={x}
                    breaks={breaks}
                    theme={theme}
                    boundaryXs={boundaryXs}
                    bands={bands}
                    lane={index === 0 ? lane : null}
                    controller={controller}
                    mode={mode}
                    active={panel.id === activeId && ws.panels.length > 1}
                    plotHeight={plotHeight}
                    selectionX={selectionX}
                    onActivate={activate}
                    revealKey={reveal.id === panel.id ? reveal.n : 0}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {saving && selection && (
        <SavePointDialog ds={ds} ws={ws} axis={axis} range={selection} onClose={() => setSaving(false)} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ toolbar

function TimeToolbar({
  ds,
  ws,
  mode,
  onMode,
  controller,
}: {
  ds: Dataset
  ws: Workspace
  mode: PointerMode
  onMode: (mode: PointerMode) => void
  controller: TimeController
}) {
  const view = useApp((s) => s.view)
  const selection = useApp((s) => s.selection)
  const bases = timeBases(ds)
  const axis = timeAxis(ds, ws.timeBase)
  const fallback = axis.id !== ws.timeBase ? bases.find((b) => b.id === ws.timeBase) : undefined
  const empty = ws.panels.length === 0

  async function exportImage(format: 'png' | 'svg') {
    try {
      await exportTimeImage({ ds, ws, axis, frame: xFrame(axis), window: controller.getWindow(), format })
    } catch (error) {
      toast(`Could not export the figure: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const items: ExportItem[] = [
    {
      section: 'Figure',
      label: 'PNG image',
      hint: 'Every panel as one figure, over the zoom range',
      disabled: empty,
      onSelect: () => exportImage('png'),
    },
    { label: 'SVG image', hint: 'Vector, for reports', disabled: empty, onSelect: () => exportImage('svg') },
    {
      section: 'Data',
      label: 'CSV of plotted channels',
      hint: view ? 'Rows in the zoom range, with time columns' : 'Every row, with time columns',
      disabled: empty,
      onSelect: () => {
        const name = exportTimeCsv(ds, ws, useApp.getState().view)
        toast(`Saved ${name}.`, 'success')
      },
    },
    {
      section: 'MATLAB',
      label: 'MATLAB script',
      hint: 'Re-plots these panels from the log (keep it next to the file)',
      disabled: empty,
      onSelect: () => {
        const name = exportTimeMatlab(ds, ws, useApp.getState().view)
        toast(`Saved ${name}. Run it in MATLAB from the folder that holds ${ds.name}.`, 'success')
      },
    },
  ]

  return (
    <div className="view-toolbar tv-toolbar">
      <label className="view-toolbar-group tv-base">
        <span className="view-toolbar-label">Time axis</span>
        <select
          className="select select-sm tv-base-select"
          data-testid="time-base-select"
          value={axis.id}
          onChange={(event) => setTimeBase(event.target.value as TimeBaseId)}
        >
          {bases.map((b) => (
            <option key={b.id} value={b.id} disabled={!b.available}>
              {b.available ? b.label : `${b.label} — ${b.reason ?? 'unavailable'}`}
            </option>
          ))}
        </select>
      </label>
      {fallback && (
        <span
          className="badge badge-warning tv-fallback"
          title={`${fallback.label}${fallback.reason ? ` ${fallback.reason}` : ' is not available'}, so time is shown as ${axis.label.toLowerCase()}.`}
        >
          <AlertIcon size={12} />
          {fallback.label} unavailable
        </span>
      )}
      <div className="view-toolbar-divider" />
      <Segmented value={mode} options={MODE_OPTIONS} onChange={onMode} ariaLabel="Pointer mode" />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={view === null}
        title="Show the whole log (or double-click a plot)"
        onClick={() => controller.resetZoom()}
      >
        <ZoomOutIcon size={16} />
        <span className="tv-collapse">Reset zoom</span>
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={selection === null}
        title="Clear the selection (Esc)"
        onClick={() => setSelection(null)}
      >
        <XIcon size={16} />
        <span className="tv-collapse">Clear selection</span>
      </button>
      <div className="view-toolbar-spacer" />
      <ExportMenu items={items} disabled={empty} />
    </div>
  )
}

// ------------------------------------------------------------------ empty state

function NoPanels({ ds, ws, onPreset }: { ds: Dataset; ws: Workspace; onPreset: (panelId: string | null) => void }) {
  const presets = useMemo(() => resolvePresets(ds).filter((r) => r.panels.length > 0), [ds])
  return (
    <div className="tv-empty">
      <span className="tv-empty-icon" aria-hidden="true">
        <GraphIcon size={24} />
      </span>
      <h2>No panels yet</h2>
      <p className="muted">Pick channels on the left or apply a preset. Channels with different units get their own panels.</p>
      {presets.length > 0 && (
        <div className="tv-empty-presets">
          {presets.slice(0, 6).map((resolved) => (
            <PresetButton key={resolved.preset.id} resolved={resolved} ws={ws} onPreset={onPreset} />
          ))}
        </div>
      )}
    </div>
  )
}
