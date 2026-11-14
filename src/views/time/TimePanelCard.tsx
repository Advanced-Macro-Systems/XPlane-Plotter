// One Time-history panel: a card with the series chips and the panel menu, its own ECharts instance (in the shared
// connect group), the select overlay (data-testid time-plot-area) with the selection bands, and — in the first panel —
// the lane above the plot naming the test points and the sim resets / recording gaps.

import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  KebabHorizontalIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { EChart } from '../../charts/EChart'
import type { ECharts } from '../../charts/echarts'
import {
  MAX_PANEL_SERIES,
  TIME_GRID,
  panelGeometry,
  timePanelOption,
  type PanelGeometry,
  type TimeBand,
  type TimeXInput,
} from '../../charts/options/timePanel'
import { seriesColor, type ChartTheme } from '../../charts/theme'
import { ChannelPicker } from '../../components/ChannelPicker'
import { channelTitle } from '../../core/channels'
import { channelById } from '../../core/dataset'
import type { Channel, Dataset, PanelConfig, RowRange, TimeAxis } from '../../core/types'
import { movePanel, setSelection, updatePanel, useApp } from '../../store/app'
import { Dropdown } from '../../ui/Dropdown'
import { removePanelWithUndo } from './timeActions'
import type { TimeController } from './timeController'
import {
  cachedSeriesData,
  laneLabels,
  spanInWindow,
  tooltipHtml,
  wheelScale,
  type LaneBand,
  type XFrame,
} from './timeMath'

/** Series can be removed: replace them on update (the zoom state in dataZoom is merged, so it stays). */
const REPLACE_SERIES = ['series']
/** A press that moves less than this (px) is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3

export type PointerMode = 'zoom' | 'select'

/** A test point in the label lane. */
export interface LanePoint extends LaneBand {
  rows: RowRange
  slot: number
  title: string
}

export interface LaneTag {
  x: number
  row: number
  reason: 'reset' | 'gap'
}

export interface LaneData {
  points: readonly LanePoint[]
  tags: readonly LaneTag[]
}

interface PanelCardProps {
  ds: Dataset
  panel: PanelConfig
  index: number
  count: number
  axis: TimeAxis
  frame: XFrame
  x: TimeXInput
  breaks: readonly number[]
  theme: ChartTheme
  boundaryXs: readonly number[]
  bands: readonly TimeBand[]
  /** The first panel's lane (null for the others, or when there is nothing to label) */
  lane: LaneData | null
  controller: TimeController
  mode: PointerMode
  /** Highlighted as the panel new channels go into */
  active: boolean
  plotHeight: number
  /** The committed selection as chart x, or null */
  selectionX: readonly [number, number] | null
  onActivate: (panelId: string) => void
  /** Changes when the panel should scroll into view */
  revealKey: number
}

interface Entry {
  ch: Channel
  slot: number
}

export const TimePanelCard = memo(function TimePanelCard({
  ds,
  panel,
  index,
  count,
  axis,
  frame,
  x,
  breaks,
  theme,
  boundaryXs,
  bands,
  lane,
  controller,
  mode,
  active,
  plotHeight,
  selectionX,
  onActivate,
  revealKey,
}: PanelCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  const bottom = index === count - 1
  const geometry = panelGeometry({ lane: lane !== null, bottom })
  const chartHeight = geometry.top + plotHeight + geometry.bottom

  // The colour slot is the channel's position in the panel's list, so it never depends on which channels exist.
  const entries = useMemo<Entry[]>(
    () =>
      panel.channelIds.slice(0, MAX_PANEL_SERIES).flatMap((id, slot) => {
        const ch = channelById(ds, id)
        return ch ? [{ ch, slot }] : []
      }),
    [ds, panel.channelIds],
  )
  const series = useMemo(
    () =>
      entries.map(({ ch, slot }) => ({
        name: channelTitle(ch),
        color: seriesColor(theme, slot),
        data: cachedSeriesData(axis.values, frame.factor, breaks, ch.values),
      })),
    [entries, theme, axis, frame.factor, breaks],
  )
  const tipSeries = useMemo(
    () => entries.map(({ ch, slot }) => ({ name: channelTitle(ch), color: seriesColor(theme, slot), values: ch.values })),
    [entries, theme],
  )
  // Every panel's tooltip reads the same instant: the pointer's time, not the nearest sampled point.
  const tooltip = useCallback(
    (value: number) => tooltipHtml(axis, frame, tipSeries, controller.hoverValue() ?? value),
    [axis, frame, tipSeries, controller],
  )
  const option = useMemo(
    () =>
      timePanelOption({
        theme,
        series,
        x,
        lane: lane !== null,
        bottom,
        yZero: panel.yZero === true,
        boundaries: boundaryXs,
        bands,
        tooltip,
      }),
    [theme, series, x, lane, bottom, panel.yZero, boundaryXs, bands, tooltip],
  )
  // The controller keeps the panels in step by axis value (zoom, crosshair, tooltip).
  const events = useMemo(
    () => ({
      datazoom: controller.onDataZoom,
      updateAxisPointer: controller.onAxisPointer,
      'zr:dblclick': () => controller.resetZoom(),
    }),
    [controller],
  )
  const insetTop = geometry.top
  const insetBottom = geometry.bottom
  const onChart = useCallback(
    (chart: ECharts | null) => controller.registerChart(panel.id, chart, { top: insetTop, bottom: insetBottom }),
    [controller, panel.id, insetTop, insetBottom],
  )
  useEffect(
    () => controller.updateInsets(panel.id, { top: insetTop, bottom: insetBottom }),
    [controller, panel.id, insetTop, insetBottom],
  )

  useEffect(() => {
    if (revealKey > 0) cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [revealKey])

  const removeChannel = (id: string) => {
    if (panel.channelIds.length > 1) {
      updatePanel(panel.id, { channelIds: panel.channelIds.filter((c) => c !== id) })
      return
    }
    removePanelWithUndo(panel.id)
  }

  const names = entries.map((e) => channelTitle(e.ch)).join(', ')
  return (
    <section
      ref={cardRef}
      className={`chart-card tv-panel${active ? ' tv-panel-active' : ''}`}
      data-testid="time-panel"
      aria-label={`Panel ${index + 1}: ${names || 'empty'}`}
      onPointerDownCapture={() => onActivate(panel.id)}
    >
      <header className="tv-panel-head">
        <div className="tv-chips">
          {entries.map(({ ch, slot }) => (
            <SeriesChip key={ch.id} ch={ch} slot={slot} onRemove={() => removeChannel(ch.id)} />
          ))}
          <AddChannel ds={ds} panel={panel} unit={entries[0]?.ch.meta.unit ?? null} />
        </div>
        {active && <span className="tv-active-tag">Adding here</span>}
        <PanelMenu panel={panel} index={index} count={count} />
      </header>
      <div className="tv-plot" style={{ height: chartHeight }}>
        <EChart
          className="tv-chart"
          option={option}
          replaceMerge={REPLACE_SERIES}
          onEvents={events}
          onChart={onChart}
          ariaLabel={`${names} against ${x.name}`}
        />
        {lane && <PointLane controller={controller} lane={lane} geometry={geometry} />}
        <PlotOverlay
          panelId={panel.id}
          controller={controller}
          selecting={mode === 'select'}
          geometry={geometry}
          selectionX={selectionX}
        />
      </div>
    </section>
  )
})

function SeriesChip({ ch, slot, onRemove }: { ch: Channel; slot: number; onRemove: () => void }) {
  const source = ch.derived ? `= ${ch.derived.expression}` : ch.id
  return (
    <span className="series-chip tv-chip" title={`${ch.meta.label}${ch.meta.unit ? ` [${ch.meta.unit}]` : ''} · ${source}`}>
      <span className="line-key" style={{ '--key': `var(--series-${slot + 1})` } as CSSProperties} aria-hidden="true" />
      <span className="series-chip-name">{ch.meta.short}</span>
      {ch.meta.unit && <span className="series-chip-unit">{ch.meta.unit}</span>}
      <button type="button" aria-label={`Remove ${ch.meta.short} from this panel`} title="Remove from this panel" onClick={onRemove}>
        <XIcon size={12} />
      </button>
    </span>
  )
}

/** "+" next to the chips: tick channels with the panel's unit (no dual axes). */
function AddChannel({ ds, panel, unit }: { ds: Dataset; panel: PanelConfig; unit: string | null }) {
  const filter = useCallback((ch: Channel) => unit === null || ch.meta.unit === unit, [unit])
  const full = panel.channelIds.length >= MAX_PANEL_SERIES
  const unitText = unit === null ? '' : unit ? ` in ${unit}` : ' without a unit'
  return (
    <ChannelPicker
      dataset={ds}
      value={panel.channelIds}
      onChange={(ids) => updatePanel(panel.id, { channelIds: ids })}
      multiple
      max={MAX_PANEL_SERIES}
      filter={filter}
      label={<PlusIcon size={14} />}
      buttonClassName="btn btn-ghost btn-xs btn-icon tv-add"
      ariaLabel={`Add channels${unitText} to this panel`}
      title={full ? `A panel shows at most ${MAX_PANEL_SERIES} channels` : `Add channels${unitText} to this panel`}
      width={380}
    />
  )
}

function PanelMenu({ panel, index, count }: { panel: PanelConfig; index: number; count: number }) {
  return (
    <Dropdown
      label={<KebabHorizontalIcon size={16} />}
      ariaLabel="Panel options"
      title="Panel options"
      buttonClassName="btn btn-ghost btn-icon btn-sm"
      align="right"
      width={232}
    >
      {(close) => (
        <div role="menu" aria-label="Panel options">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={index === 0}
            onClick={() => {
              movePanel(panel.id, -1)
              close()
            }}
          >
            <ArrowUpIcon size={16} /> Move up
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={index === count - 1}
            onClick={() => {
              movePanel(panel.id, 1)
              close()
            }}
          >
            <ArrowDownIcon size={16} /> Move down
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={panel.yZero === true}
            className="menu-item"
            onClick={() => {
              updatePanel(panel.id, { yZero: panel.yZero ? undefined : true })
              close()
            }}
          >
            <span className="tv-menu-check" aria-hidden="true">
              {panel.yZero && <CheckIcon size={16} />}
            </span>
            Y axis includes zero
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-danger"
            onClick={() => {
              close()
              removePanelWithUndo(panel.id)
            }}
          >
            <TrashIcon size={16} /> Remove panel
          </button>
        </div>
      )}
    </Dropdown>
  )
}

// ------------------------------------------------------------------ the lane above the first plot

/** Rough width of a lane name in px (11.5 px Geist). */
function laneTextPx(text: string): number {
  return text.length * 6.4 + 10
}

function PointLane({ controller, lane, geometry }: { controller: TimeController; lane: LaneData; geometry: PanelGeometry }) {
  const window = useSyncExternalStore(controller.subscribe, controller.getWindow)
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setWidth(entries[entries.length - 1]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const byId = useMemo(() => new Map(lane.points.map((p) => [p.id, p])), [lane.points])
  const labels = useMemo(() => laneLabels(lane.points, window, width, laneTextPx), [lane.points, window, width])
  const tags = useMemo(
    () =>
      lane.tags.flatMap((tag) => {
        const span = spanInWindow(tag.x, tag.x, window)
        return span && span.left > 0 && span.left < 1 ? [{ ...tag, at: span.left }] : []
      }),
    [lane.tags, window],
  )
  return (
    <div
      ref={ref}
      className="tv-lane"
      style={{ left: geometry.left, right: geometry.right, top: TIME_GRID.top, height: TIME_GRID.lane }}
    >
      {labels.map((label) => {
        const point = byId.get(label.id)
        if (!point) return null
        return (
          <button
            key={label.id}
            type="button"
            className={`tv-lane-point slot-${point.slot}`}
            style={{ left: `${label.left * 100}%`, width: `${(label.right - label.left) * 100}%` }}
            title={point.title}
            aria-label={`Zoom to test point ${point.label}`}
            onClick={() => controller.zoomToRows(point.rows, 0.25)}
          >
            {label.showLabel && <span className="tv-lane-name">{point.label}</span>}
          </button>
        )
      })}
      {tags.map((tag) => (
        <span
          key={tag.row}
          className="tv-lane-tag"
          style={{ left: `${tag.at * 100}%` }}
          title={
            tag.reason === 'reset'
              ? `Sim time went backwards at row ${tag.row} (a reset or a new flight)`
              : `Recording gap before row ${tag.row} (collapsed on the elapsed axis)`
          }
        >
          {tag.reason}
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ the select overlay

interface Drag {
  start: number
  startX: number
  moved: boolean
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Transparent layer exactly over the plot area. In Select mode it takes the pointer: drag to select (the live band is
 * drawn in every panel by the controller), wheel to zoom, double-click to reset, and it keeps the crosshair moving.
 * In Zoom mode it lets everything through to the chart and only shows the committed selection.
 */
function PlotOverlay({
  panelId,
  controller,
  selecting,
  geometry,
  selectionX,
}: {
  panelId: string
  controller: TimeController
  selecting: boolean
  geometry: PanelGeometry
  selectionX: readonly [number, number] | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const bandRef = useCallback((element: HTMLDivElement | null) => controller.registerBand(panelId, element), [controller, panelId])

  // Wheel zoom in Select mode (React's wheel listener is passive: it cannot stop the page scrolling).
  useEffect(() => {
    const element = ref.current
    if (!element || !selecting) return
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      controller.zoomBy(clamp01((event.clientX - rect.left) / rect.width), wheelScale(event.deltaY, event.deltaMode))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [controller, selecting])

  const fractionAt = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return rect.width > 0 ? clamp01((event.clientX - rect.left) / rect.width) : 0
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selecting || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { start: fractionAt(event), startX: event.clientX, moved: false }
    controller.setDragCancel(() => {
      drag.current = null
      controller.hideBand()
    })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selecting) return
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    const f = fractionAt(event)
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top))
    controller.showTipAt(panelId, element.offsetLeft + f * rect.width, element.offsetTop + y)
    const current = drag.current
    if (!current) return
    if (!current.moved && Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD_PX) return
    current.moved = true
    controller.showBand(current.start, f)
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current
    drag.current = null
    controller.setDragCancel(null)
    controller.hideBand()
    if (!current || !commit) return
    if (!current.moved) {
      // A click (no drag) clears the selection.
      if (useApp.getState().selection) setSelection(null)
      return
    }
    const f = fractionAt(event)
    const rows = controller.rowsBetween(controller.xAt(Math.min(current.start, f)), controller.xAt(Math.max(current.start, f)))
    if (rows) setSelection(rows)
  }

  return (
    <div
      ref={ref}
      className={`tv-overlay${selecting ? ' tv-overlay-select' : ''}`}
      style={{ left: geometry.left, right: geometry.right, top: geometry.top, bottom: geometry.bottom }}
      data-testid="time-plot-area"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onPointerLeave={() => {
        if (selecting && !drag.current) controller.hideTips()
      }}
      onDoubleClick={() => {
        if (selecting) controller.resetZoom()
      }}
    >
      {selectionX && <SelectionBand controller={controller} x={selectionX} />}
      <div ref={bandRef} className="tv-band tv-band-live" hidden />
    </div>
  )
}

/** The committed selection (store.selection) in one panel; follows the zoom through the controller's window store. */
function SelectionBand({ controller, x }: { controller: TimeController; x: readonly [number, number] }) {
  const window = useSyncExternalStore(controller.subscribe, controller.getWindow)
  const span = spanInWindow(x[0], x[1], window)
  if (!span) return null
  return (
    <div
      className="tv-band"
      style={{ left: `${span.left * 100}%`, width: `${(span.right - span.left) * 100}%` }}
      aria-hidden="true"
    />
  )
}
