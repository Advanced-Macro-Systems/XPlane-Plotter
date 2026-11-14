// Imperative glue between the Time-history panels, kept out of React so zooming, hovering and dragging never
// re-render the view:
// - the ECharts instances, one per panel, kept in step BY AXIS VALUE: a zoom in one panel is applied to the others, and
//   the crosshair and tooltip follow the hovered time in every panel. (echarts.connect is not used: it maps the
//   crosshair through series/data indices, which differ between panels once LTTB has sampled their different data,
//   so connected panels lose their crosshair.)
// - the visible x window, as a tiny external store the overlays (selection band, label lane, readout) subscribe to;
// - zoom -> store.view (rows, debounced) and store.view -> zoom (dispatchAction), without echoing its own changes;
// - pointer -> time conversion for drag-select, the live drag band (pure DOM, across every panel), and the crosshair
//   while the select overlay covers the plots.
// The view creates one controller per mount and disposes it on unmount.

import type { ECharts } from '../../charts/echarts'
import { DATAZOOM_INSIDE_ID, TIME_GRID } from '../../charts/options/timePanel'
import { rangeToRows } from '../../core/time'
import type { RowRange, TimeAxis } from '../../core/types'
import {
  isWholeWindow,
  normalizeWindow,
  paddedWindow,
  rowsToWindow,
  sameRows,
  windowFromZoomEvent,
  windowValueAt,
  windowView,
  zoomAbout,
  type XFrame,
  type XWindow,
} from './timeMath'

/** How long the zoom has to settle before the rows reach the store (X–Y and Modes read them). */
export const VIEW_DEBOUNCE_MS = 120

/** Plot-area padding of a panel's chart (px), to aim the crosshair at the middle of its plot. */
export interface ChartInsets {
  top: number
  bottom: number
}

interface Member {
  chart: ECharts
  insets: ChartInsets
}

function sameWindow(a: XWindow, b: XWindow): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The hovered x of an 'updateAxisPointer' event (null when the pointer is hidden). */
export function axisPointerValue(params: unknown): number | null {
  if (!isRecord(params) || !Array.isArray(params.axesInfo)) return null
  const info: unknown = params.axesInfo.find((a: unknown) => isRecord(a) && a.axisDim === 'x')
  if (!isRecord(info)) return null
  const value = info.value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class TimeController {
  private axis: TimeAxis | null = null
  private frame: XFrame | null = null
  private window: XWindow = [0, 1]
  private readonly members = new Map<string, Member>()
  private order: readonly string[] = []
  private readonly bands = new Map<string, HTMLElement>()
  private readonly listeners = new Set<() => void>()
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  /** > 0 while this controller dispatches actions itself: the events they raise are not user input */
  private applying = 0
  /** The view this controller last wrote to the store (undefined = none yet) */
  private pushed: RowRange | null | undefined = undefined
  private tipFrame = 0
  private pendingTip: { panelId: string; x: number; y: number } | null = null
  private pointerFrame = 0
  private zoomFrame = 0
  /** The window each chart was last zoomed to (by the user or by this controller) */
  private readonly shown = new WeakMap<ECharts, XWindow>()
  private pendingPointer: { source: ECharts; value: number | null } | null = null
  /** The time under the pointer (chart x), shared by every panel's tooltip */
  private hover: number | null = null
  private dragCancel: (() => void) | null = null
  private readonly writeView: (view: RowRange | null) => void

  constructor(writeView: (view: RowRange | null) => void) {
    this.writeView = writeView
  }

  // ------------------------------------------------------------------ the window store

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getWindow = (): XWindow => this.window

  private setWindow(window: XWindow): void {
    if (sameWindow(window, this.window)) return
    this.window = window
    for (const listener of [...this.listeners]) listener()
  }

  /** Whether the panels show less than the whole axis right now. */
  isZoomed(): boolean {
    return this.frame !== null && !isWholeWindow(this.window, this.frame)
  }

  // ------------------------------------------------------------------ context and the store's view

  /**
   * The axis the charts draw and the store's zoom rows. A new axis (time base switch, new dataset) or a view set
   * elsewhere (e.g. "Zoom to" on the Test points tab) is applied to every chart; the controller's own writes are not.
   */
  sync(axis: TimeAxis, frame: XFrame, view: RowRange | null): void {
    const frameChanged = frame !== this.frame
    this.axis = axis
    this.frame = frame
    if (!frameChanged && sameRows(view, this.pushed)) return
    this.cancelPendingView()
    this.pushed = view
    this.applyWindow(rowsToWindow(axis, frame, view))
  }

  /** The panel order (the first panel converts pointer positions). */
  setOrder(panelIds: readonly string[]): void {
    this.order = panelIds
  }

  registerChart(panelId: string, chart: ECharts | null, insets: ChartInsets): void {
    if (!chart) {
      this.members.delete(panelId)
      return
    }
    this.members.set(panelId, { chart, insets })
    // A chart arriving late (fonts, a new panel) starts at the window the others show.
    if (this.isZoomed()) this.dispatchZoom(chart, this.window)
  }

  /** A panel's plot padding changed (it became the first or the bottom panel). */
  updateInsets(panelId: string, insets: ChartInsets): void {
    const member = this.members.get(panelId)
    if (member) member.insets = insets
  }

  private liveCharts(): ECharts[] {
    const charts: ECharts[] = []
    for (const { chart } of this.members.values()) if (!chart.isDisposed()) charts.push(chart)
    return charts
  }

  // ------------------------------------------------------------------ zoom

  /** ECharts 'datazoom' from a panel: the user zoomed or panned it (or its slider); the others follow. */
  readonly onDataZoom = (params: unknown, source: ECharts): void => {
    if (!this.frame || this.applying > 0) return
    const next = windowFromZoomEvent(params, this.frame, this.window)
    if (!next) return
    this.shown.set(source, next)
    this.setWindow(next)
    // The other panels follow once per frame with the latest window: under a fast wheel the intermediate steps are
    // skipped instead of queueing up a render of every panel for each of them.
    if (!this.zoomFrame) {
      this.zoomFrame = requestAnimationFrame(() => {
        this.zoomFrame = 0
        for (const chart of this.liveCharts()) this.dispatchZoom(chart, this.window)
      })
    }
    this.scheduleView()
  }

  private scheduleView(): void {
    this.cancelPendingView()
    this.viewTimer = setTimeout(() => this.flushView(), VIEW_DEBOUNCE_MS)
  }

  private cancelPendingView(): void {
    if (this.viewTimer !== null) clearTimeout(this.viewTimer)
    this.viewTimer = null
  }

  private flushView(): void {
    this.viewTimer = null
    if (!this.axis || !this.frame) return
    const view = windowView(this.axis, this.frame, this.window)
    this.pushed = view
    this.writeView(view)
  }

  /** Shows `window` in every panel. */
  private applyWindow(window: XWindow): void {
    const next = this.frame ? normalizeWindow(window, this.frame) : window
    this.setWindow(next)
    for (const chart of this.liveCharts()) this.dispatchZoom(chart, next)
  }

  /** Zooms one chart, unless it already shows `window`. */
  private dispatchZoom(chart: ECharts, window: XWindow): void {
    if (chart.isDisposed()) return
    const shown = this.shown.get(chart)
    if (shown && sameWindow(shown, window)) return
    this.shown.set(chart, window)
    this.applying += 1
    try {
      chart.dispatchAction({ type: 'dataZoom', dataZoomId: DATAZOOM_INSIDE_ID, startValue: window[0], endValue: window[1] })
    } finally {
      this.applying -= 1
    }
  }

  /** Programmatic zoom that also updates the store (after the usual debounce). */
  zoomTo(window: XWindow): void {
    this.applyWindow(window)
    this.scheduleView()
  }

  /** Zoom about the point at `fraction` across the plots (wheel in Select mode); `scale` > 1 zooms out. */
  zoomBy(fraction: number, scale: number): void {
    if (!this.frame) return
    this.zoomTo(zoomAbout(this.window, this.frame, fraction, scale))
  }

  /** "Zoom to" a row range, with a little margin either side. */
  zoomToRows(rows: RowRange, pad = 0.05): void {
    if (!this.axis || !this.frame) return
    this.zoomTo(paddedWindow(this.axis, this.frame, rows, pad))
  }

  readonly resetZoom = (): void => {
    if (!this.frame) return
    this.applyWindow([this.frame.min, this.frame.max])
    this.cancelPendingView()
    this.pushed = null
    this.writeView(null)
  }

  // ------------------------------------------------------------------ crosshair and tooltips in every panel

  /**
   * The hovered time every tooltip reports. ECharts hands an axis tooltip the x of the nearest SAMPLED point, which
   * differs from panel to panel; this is the pointer's own x, the same in every panel.
   */
  readonly hoverValue = (): number | null => this.hover

  /** ECharts 'updateAxisPointer' from a panel: show the same time in the others (once per frame). */
  readonly onAxisPointer = (params: unknown, source: ECharts): void => {
    if (this.applying > 0) return
    const value = axisPointerValue(params)
    this.hover = value
    this.pendingPointer = { source, value }
    if (this.pointerFrame) return
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = 0
      const pending = this.pendingPointer
      this.pendingPointer = null
      if (pending) this.mirrorPointer(pending.source, pending.value)
    })
  }

  private mirrorPointer(source: ECharts, value: number | null): void {
    this.applying += 1
    try {
      for (const { chart, insets } of this.members.values()) {
        if (chart === source || chart.isDisposed()) continue
        if (value === null) {
          chart.dispatchAction({ type: 'hideTip' })
          chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' })
          continue
        }
        const px: unknown = chart.convertToPixel({ xAxisIndex: 0 }, value)
        const x = Number(px)
        if (!Number.isFinite(x)) continue
        const y = insets.top + Math.max(0, chart.getHeight() - insets.top - insets.bottom) / 2
        chart.dispatchAction({ type: 'showTip', x, y })
      }
    } finally {
      this.applying -= 1
    }
  }

  /** Shows the crosshair and tooltip at container pixel (x, y) of a panel (Select mode; at most once per frame). */
  showTipAt(panelId: string, x: number, y: number): void {
    this.pendingTip = { panelId, x, y }
    if (this.tipFrame) return
    this.tipFrame = requestAnimationFrame(() => {
      this.tipFrame = 0
      const tip = this.pendingTip
      this.pendingTip = null
      const chart = tip ? this.members.get(tip.panelId)?.chart : undefined
      if (tip && chart && !chart.isDisposed()) chart.dispatchAction({ type: 'showTip', x: tip.x, y: tip.y })
    })
  }

  /** Hides the crosshair and tooltips in every panel. */
  hideTips(): void {
    this.pendingTip = null
    this.pendingPointer = null
    this.applying += 1
    try {
      for (const chart of this.liveCharts()) {
        chart.dispatchAction({ type: 'hideTip' })
        chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' })
      }
    } finally {
      this.applying -= 1
    }
  }

  // ------------------------------------------------------------------ pointer -> time

  private firstChart(): ECharts | null {
    for (const id of this.order) {
      const chart = this.members.get(id)?.chart
      if (chart && !chart.isDisposed()) return chart
    }
    return null
  }

  /**
   * Chart x at `fraction` across the plot area. Asks the first panel's chart (convertFromPixel on its grid); until a
   * chart exists, interpolates across the window.
   */
  xAt(fraction: number): number {
    const f = Math.min(1, Math.max(0, fraction))
    const chart = this.firstChart()
    if (chart) {
      const plotWidth = chart.getWidth() - TIME_GRID.left - TIME_GRID.right
      if (plotWidth > 0) {
        const value: unknown = chart.convertFromPixel({ gridIndex: 0 }, [TIME_GRID.left + f * plotWidth, TIME_GRID.top])
        const x = Array.isArray(value) ? Number(value[0]) : Number(value)
        if (Number.isFinite(x)) return x
      }
    }
    return windowValueAt(this.window, f)
  }

  /** The rows between two chart x values (half-open, at least one row). */
  rowsBetween(x0: number, x1: number): RowRange | null {
    if (!this.axis || !this.frame) return null
    return rangeToRows(this.axis.values, x0 / this.frame.factor, x1 / this.frame.factor)
  }

  // ------------------------------------------------------------------ the live drag band (DOM, every panel)

  registerBand(panelId: string, element: HTMLElement | null): void {
    if (element) this.bands.set(panelId, element)
    else this.bands.delete(panelId)
  }

  showBand(from: number, to: number): void {
    const left = Math.min(1, Math.max(0, Math.min(from, to)))
    const right = Math.min(1, Math.max(0, Math.max(from, to)))
    for (const band of this.bands.values()) {
      band.style.left = `${left * 100}%`
      band.style.width = `${(right - left) * 100}%`
      band.hidden = false
    }
  }

  hideBand(): void {
    for (const band of this.bands.values()) band.hidden = true
  }

  /** The select overlay registers how to abandon a drag in progress (Escape). */
  setDragCancel(cancel: (() => void) | null): void {
    this.dragCancel = cancel
  }

  /** Abandons a drag in progress; false when there is none. */
  cancelDrag(): boolean {
    const cancel = this.dragCancel
    if (!cancel) return false
    this.dragCancel = null
    cancel()
    return true
  }

  // ------------------------------------------------------------------ lifetime

  /**
   * Unmount: writes a zoom still waiting for its debounce and drops pending frames. Subscriptions, charts and bands
   * unregister themselves (React may mount the same controller again, e.g. in StrictMode).
   */
  dispose(): void {
    if (this.viewTimer !== null) {
      this.cancelPendingView()
      this.flushView()
    }
    if (this.tipFrame) cancelAnimationFrame(this.tipFrame)
    if (this.pointerFrame) cancelAnimationFrame(this.pointerFrame)
    if (this.zoomFrame) cancelAnimationFrame(this.zoomFrame)
    this.tipFrame = 0
    this.pointerFrame = 0
    this.zoomFrame = 0
    this.pendingTip = null
    this.pendingPointer = null
    this.dragCancel = null
  }
}
