// The X–Y chart card: legend chips and zoom tools above the plot, the fitted equations below it.
//
// Hover: every series is silent, so the view finds the sample or test-point mean nearest the pointer itself (in screen
// pixels, rAF-throttled), shows ECharts' tooltip there with dispatchAction('showTip') and rings the point with a DOM
// element. Nothing on hover touches React state or the chart option.
// Zoom: the mouse wheel zooms both axes about the pointer; dragging pans, or draws a zoom box when "Zoom box" is on;
// double-click or "Reset view" shows everything again. A new plot (other channels, source or groups) starts unzoomed.

import { AlertIcon, ArrowDownIcon, ScreenFullIcon, ZoomInIcon } from '@primer/octicons-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { EChart } from '../../charts/EChart'
import type { ECharts } from '../../charts/echarts'
import { timeRamp, XY_REPLACE_MERGE, XY_ZOOM_X, XY_ZOOM_Y, xyChartOption } from '../../charts/options/xy'
import { seriesColor, useChartTheme, type ChartTheme } from '../../charts/theme'
import { channelTitle } from '../../core/channels'
import { scrollBehavior } from '../../components/hooks'
import { formatAxisValue } from '../../core/time'
import type { TimeAxis, XYConfig } from '../../core/types'
import { LineGlyph, MarkerGlyph, MeanGlyph, SlotSwatch } from './Glyphs'
import {
  anyZoomed,
  applyZoomEvent,
  chartDescription,
  focusNote,
  legendChips,
  measureLabelArea,
  plotKey,
  rampColor,
  sameLabelArea,
  type AxisFocus,
  type LabelArea,
  type ZoomFlags,
} from './xyControls'
import { boxRanges, hitTest, meanTooltipHtml, pixelBox, sampleTooltipHtml, type Hit } from './xyHover'
import { SAMPLE_STRIDE, type FitWindow, type XYData, type XYFit, type XYLabels } from './xyModel'
import { constructionSlots, dataSlots, labelNumber, NEEDS_TEST_POINTS, type XYRange } from './xyRange'
import { equationText, fitRows } from './xyTables'

/** The parts of a zrender pointer event the view reads. */
interface ZrPointer {
  offsetX: number
  offsetY: number
  event?: { buttons?: number }
}

interface HoverTarget {
  key: string
  /** Data coordinates where the point is drawn */
  x: number
  y: number
  html: string
  color: string
  mean: boolean
}

const GRID = { gridIndex: 0 }
const RESET_ZOOM = [
  { dataZoomId: XY_ZOOM_X, start: 0, end: 100 },
  { dataZoomId: XY_ZOOM_Y, start: 0, end: 100 },
]

function asPointer(params: unknown): ZrPointer | null {
  const e = params as ZrPointer | null
  return e && Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY) ? e : null
}

function live(ref: RefObject<ECharts | null>): ECharts | null {
  const chart = ref.current
  return chart && !chart.isDisposed() ? chart : null
}

/** What the pointer is on, as tooltip content and the point to ring. */
function describeHit(hit: Hit, data: XYData, axis: TimeAxis, theme: ChartTheme): HoverTarget | null {
  const x = data.x
  if (!x) return null
  const timeMode = data.effective.colorBy === 'time'
  const [tMin, tMax] = data.tRange
  const timeColor = (t: number) => rampColor(timeRamp(theme), tMax > tMin ? (t - tMin) / (tMax - tMin) : 1)
  if (hit.kind === 'mean') {
    const m = data.means[hit.mean]
    if (!m) return null
    const color = timeMode ? timeColor(m.t) : seriesColor(theme, m.slot)
    return {
      key: `m${hit.mean}`,
      x: m.x.mean,
      y: m.yStats.mean,
      color,
      mean: true,
      html: meanTooltipHtml({
        color,
        point: m.point.name,
        group: m.group?.name ?? '',
        xTitle: channelTitle(x),
        yTitle: channelTitle(m.y.ch),
        x: m.x,
        y: m.yStats,
        rows: m.rows,
      }),
    }
  }
  const s = data.series[hit.series]
  if (!s) return null
  const o = hit.index * SAMPLE_STRIDE
  const row = s.data[o + 3]
  const t = s.data[o + 2]
  const color = timeMode ? timeColor(t) : seriesColor(theme, s.slot)
  const point = s.pointIndex ? (data.effective.points[s.pointIndex[hit.index]]?.name ?? '') : ''
  return {
    key: `s${hit.series}:${hit.index}`,
    x: s.data[o],
    y: s.data[o + 1],
    color,
    mean: false,
    html: sampleTooltipHtml({
      color,
      series: s.name,
      xTitle: channelTitle(x),
      yTitle: channelTitle(s.y.ch),
      // Exact values from the channels (the drawing copy is Float32).
      x: x.values[row],
      y: s.y.ch.values[row],
      time: formatAxisValue(axis, axis.values[row] ?? t),
      point,
    }),
  }
}

interface XYChartCardProps {
  data: XYData
  fits: readonly XYFit[]
  /** Range and endurance per fit (null: its markers are off) */
  re: readonly XYRange[] | null
  labels: XYLabels
  xy: Pick<XYConfig, 'style' | 'showSamples' | 'fit' | 'axesFromZero'>
  axis: TimeAxis
  chartRef: RefObject<ECharts | null>
  /** Where the axes point when a few absurd samples would flatten the rest */
  focus: AxisFocus | null
  /** The axis ranges in force (the focus unless showAll); null = everything */
  extent: FitWindow | null
  /** true: the axes show everything, absurd samples included */
  showAll: boolean
  onShowAll: (all: boolean) => void
}

export function XYChartCard({ data, fits, re, labels, xy, axis, chartRef, focus, extent, showAll, onShowAll }: XYChartCardProps) {
  const theme = useChartTheme()
  const [zoomBox, setZoomBox] = useState(false)
  const [zoom, setZoom] = useState<ZoomFlags>({})
  const zoomed = anyZoomed(zoom)
  const ringRef = useRef<HTMLSpanElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  /** Pointer bookkeeping for the event handlers (never read during render) */
  const pointer = useRef<{ frame: number; x: number; y: number; down: boolean; tip: string; zoom: ZoomFlags }>({
    frame: 0,
    x: 0,
    y: 0,
    down: false,
    tip: '',
    zoom: {},
  })
  const endDrag = useRef<(() => void) | null>(null)

  // The range-and-endurance labels are placed in the plotting area as drawn, so they stay inside it on a phone's narrow
  // plot and when zoomed: after each render (debounced, so a wheel zoom or a drag measures once it stops) the chart's
  // plotting area and zoom window are measured; the option is rebuilt only when they change, and only while the labels
  // are drawn. Until the first measurement the plot's size, rounded to 40 px, gives an estimate.
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotSize, setPlotSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = plotRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      const next = { width: Math.round(box.width / 40) * 40, height: Math.round(box.height / 40) * 40 }
      setPlotSize((old) => (old && old.width === next.width && old.height === next.height ? old : next))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const [measured, setMeasured] = useState<LabelArea | null>(null)
  const measureTimer = useRef(0)
  const measureLabels = () => {
    measureTimer.current = 0
    const chart = live(chartRef)
    if (!chart) return
    const next = measureLabelArea(chart.getOption(), (value) => chart.convertToPixel(GRID, value) as number[] | null)
    if (next) setMeasured((old) => (sameLabelArea(old, next) ? old : next))
  }
  useEffect(() => () => window.clearTimeout(measureTimer.current), [])
  const area = re ? measured : null
  const layoutSize = re && !area ? plotSize : null

  const time = useMemo(() => ({ label: axis.label, format: (v: number) => formatAxisValue(axis, v) }), [axis])
  // Rebuilt only when an axis starts or stops being zoomed (its end labels are hidden while it is), not per wheel tick.
  const zoomedX = !!zoom[XY_ZOOM_X]
  const zoomedY = !!zoom[XY_ZOOM_Y]
  const option = useMemo(
    () =>
      xyChartOption(
        {
          data,
          fits,
          style: xy.style,
          showSamples: xy.showSamples,
          labels,
          time,
          zoomBox,
          extent,
          zoomed: { x: zoomedX, y: zoomedY },
          re,
          axesFromZero: xy.axesFromZero === true,
          size: layoutSize,
          plot: area?.plot ?? null,
          labelZoom: area?.zoom ?? null,
        },
        theme,
      ),
    [data, fits, re, xy.style, xy.showSamples, xy.axesFromZero, labels, time, zoomBox, extent, zoomedX, zoomedY, theme, layoutSize, area],
  )
  const chips = useMemo(() => legendChips(data, fits, xy.fit, xy.style, re), [data, fits, xy.fit, xy.style, re])
  const equations = useMemo(() => fitRows(data, fits), [data, fits])
  const description = chartDescription(data, labels, fits, xy.fit, re)
  const xUnit = data.x?.meta.unit ? ` ${data.x.meta.unit}` : ''
  const found = (re ?? []).filter((r) => r.re.endurance || r.re.range)
  const reSlots = constructionSlots(dataSlots(data))

  const hideHover = () => {
    const p = pointer.current
    if (p.frame) cancelAnimationFrame(p.frame)
    p.frame = 0
    if (p.tip) {
      p.tip = ''
      live(chartRef)?.dispatchAction({ type: 'hideTip' })
    }
    if (ringRef.current) ringRef.current.hidden = true
  }

  const updateHover = () => {
    const chart = live(chartRef)
    const p = pointer.current
    if (!chart || !data.x || data.empty) return hideHover()
    const at = [p.x, p.y]
    if (!chart.containPixel(GRID, at)) return hideHover()
    const a = chart.convertFromPixel(GRID, at) as number[]
    const b = chart.convertFromPixel(GRID, [p.x + 1, p.y + 1]) as number[]
    const hit = hitTest(
      data,
      { x: a[0], y: a[1], ux: b[0] - a[0], uy: b[1] - a[1] },
      { samples: xy.showSamples, means: data.effective.showMeans },
    )
    const target = hit ? describeHit(hit, data, axis, theme) : null
    if (!target) return hideHover()
    const [hx, hy] = chart.convertToPixel(GRID, [target.x, target.y]) as number[]
    // A point clipped away by the zoom is not under the pointer.
    if (!chart.containPixel(GRID, [hx, hy])) return hideHover()
    if (target.key !== p.tip) {
      p.tip = target.key
      chart.dispatchAction({ type: 'showTip', x: hx, y: hy, tooltip: { content: target.html } })
    }
    const ring = ringRef.current
    if (ring) {
      ring.hidden = false
      ring.style.transform = `translate(${hx}px, ${hy}px)`
      ring.style.setProperty('--ring', target.mean ? '22px' : '13px')
      ring.style.setProperty('--ring-color', target.color)
    }
  }

  const resetZoom = () => {
    if (anyZoomed(pointer.current.zoom)) live(chartRef)?.dispatchAction({ type: 'dataZoom', batch: RESET_ZOOM })
  }

  /** The zoom box: drawn while dragging, applied to both axes on release (a click is not a zoom). */
  const startBox = (px: number, py: number) => {
    const chart = live(chartRef)
    const box = boxRef.current
    if (!chart || !box || !chart.containPixel(GRID, [px, py])) return
    const rect = chart.getDom().getBoundingClientRect()
    const local = (ev: PointerEvent) => [ev.clientX - rect.left, ev.clientY - rect.top]
    const move = (ev: PointerEvent) => {
      const b = pixelBox([px, py], local(ev), 0)
      box.hidden = !b
      if (b) {
        box.style.left = `${b.left}px`
        box.style.top = `${b.top}px`
        box.style.width = `${b.width}px`
        box.style.height = `${b.height}px`
      }
    }
    const finish = (ev: PointerEvent) => {
      cleanup()
      const to = local(ev)
      const current = live(chartRef)
      if (ev.type !== 'pointerup' || !current || !pixelBox([px, py], to)) return
      const ranges = boxRanges(current.convertFromPixel(GRID, [px, py]) as number[], current.convertFromPixel(GRID, to) as number[])
      if (!ranges) return
      current.dispatchAction({
        type: 'dataZoom',
        batch: [
          { dataZoomId: XY_ZOOM_X, startValue: ranges.x[0], endValue: ranges.x[1] },
          { dataZoomId: XY_ZOOM_Y, startValue: ranges.y[0], endValue: ranges.y[1] },
        ],
      })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      box.hidden = true
      endDrag.current = null
    }
    endDrag.current?.()
    endDrag.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const onEvents = {
    'zr:mousemove': (params: unknown) => {
      const e = asPointer(params)
      const p = pointer.current
      if (!e) return
      if (p.down && e.event?.buttons === 0) p.down = false
      // No tooltip while panning or drawing a zoom box.
      if (p.down) return hideHover()
      p.x = e.offsetX
      p.y = e.offsetY
      if (!p.frame) {
        p.frame = requestAnimationFrame(() => {
          p.frame = 0
          updateHover()
        })
      }
    },
    'zr:mousedown': (params: unknown) => {
      const e = asPointer(params)
      const p = pointer.current
      p.down = true
      hideHover()
      const release = () => {
        p.down = false
      }
      window.addEventListener('pointerup', release, { once: true })
      if (e && zoomBox) startBox(e.offsetX, e.offsetY)
    },
    'zr:mouseup': () => {
      pointer.current.down = false
    },
    'zr:globalout': () => hideHover(),
    'zr:dblclick': () => resetZoom(),
    datazoom: (params: unknown) => {
      hideHover()
      const p = pointer.current
      const next = applyZoomEvent(p.zoom, params)
      if (next !== p.zoom) {
        p.zoom = next
        setZoom(next)
      }
    },
    // Rendered (a new option, a zoom or pan step, a resize): measure where the construction labels go once it settles.
    finished: () => {
      if (!re) return
      window.clearTimeout(measureTimer.current)
      measureTimer.current = window.setTimeout(measureLabels, 120)
    },
  }

  // A new option redraws the points: whatever was hovered may have moved or gone.
  const forgetHover = useEffectEvent(() => hideHover())
  useEffect(() => {
    forgetHover()
  }, [option])

  // A new plot (other channels, source or groups), or other axes, starts unzoomed.
  const resetKey = `${plotKey(data)}|${extent ? 'focus' : 'all'}`
  useEffect(() => {
    if (anyZoomed(pointer.current.zoom)) live(chartRef)?.dispatchAction({ type: 'dataZoom', batch: RESET_ZOOM })
  }, [resetKey, chartRef])

  useEffect(() => {
    const drag = endDrag
    return () => drag.current?.()
  }, [])

  return (
    <section className="chart-card xy-card" data-testid="xy-chart" aria-label={description}>
      <div className="chart-card-header xy-card-header">
        <div className="xy-legend" role="group" aria-label="Legend">
          {chips.length >= 2 &&
            chips.map((c) => (
              <span key={c.key} className="series-chip xy-legend-chip" title={c.name}>
                {c.kind === 'line' || c.kind === 'fit' || c.kind === 'guide' ? (
                  <LineGlyph slot={c.slot} pattern={c.line} />
                ) : c.kind === 'mean' ? (
                  <MeanGlyph slot={null} />
                ) : (
                  <MarkerGlyph shape={c.shape} slot={c.slot} />
                )}
                <span className="series-chip-name">{c.name}</span>
              </span>
            ))}
        </div>
        <div className="xy-tools">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={zoomBox}
            title={zoomBox ? 'Drag on the plot to zoom to a box. Turn off to pan by dragging.' : 'Drag a box on the plot to zoom to it'}
            onClick={() => setZoomBox((on) => !on)}
          >
            <ZoomInIcon size={14} /> Zoom box
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!zoomed}
            title="Show all the data again (or double-click the plot)"
            onClick={resetZoom}
          >
            <ScreenFullIcon size={14} /> Reset view
          </button>
        </div>
      </div>

      <div ref={plotRef} className={`xy-plot${zoomBox ? ' is-boxing' : ''}`}>
        <EChart
          option={option}
          replaceMerge={XY_REPLACE_MERGE}
          className="xy-echart"
          ariaLabel={description}
          onChart={(chart) => {
            chartRef.current = chart
          }}
          onEvents={onEvents}
        />
        <span ref={ringRef} className="xy-ring" hidden aria-hidden="true" />
        <div ref={boxRef} className="xy-zoom-box" hidden aria-hidden="true" />
      </div>

      <div className="xy-card-footer">
        {focus && focus.outside > 0 && (
          <p className="xy-focus-note" role="note">
            <AlertIcon size={12} />
            <span>{focusNote(focus, data, showAll, fits)}</span>
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => onShowAll(!showAll)}>
              {showAll ? 'Focus on the bulk' : 'Show all'}
            </button>
          </p>
        )}
        <p className="xy-hint">
          {zoomBox ? 'Drag a box to zoom' : 'Scroll to zoom · drag to pan'} · double-click to reset · hover a point for its values
        </p>
        {equations.length > 0 && (
          <ul className="xy-equations" aria-label="Fitted equations">
            {equations.slice(0, 8).map((r) => (
              <li
                key={r.key}
                className="xy-equation-chip"
                title={r.problem ? equationText(r, true) : `${r.name}: ${r.equation}`}
              >
                <SlotSwatch slot={r.slot} />
                {r.problem ? (
                  <span className="xy-equation-problem">{equationText(r, equations.length > 1)}</span>
                ) : (
                  <>
                    <span className="xy-equation-text">{equationText(r, equations.length > 1)}</span>
                    <span className="xy-equation-stats">
                      R² {Number.isFinite(r.r2) ? (r.r2 >= 0.999 && r.r2 < 1 ? r.r2.toFixed(4) : r.r2.toFixed(3)) : '—'} · n {r.n}
                    </span>
                  </>
                )}
              </li>
            ))}
            <li>
              <a className="xy-tables-link" href="#xy-tables" onClick={scrollToTables}>
                <ArrowDownIcon size={12} /> Fit details
              </a>
            </li>
          </ul>
        )}
        {re && re.length > 0 && (
          <ul className="xy-re-summary" aria-label="Range and endurance" data-testid="xy-re-summary">
            {found.length === 0 && (
              <li className="xy-equation-problem">
                {re.every((r) => r.re.enduranceNote === NEEDS_TEST_POINTS)
                  ? NEEDS_TEST_POINTS
                  : 'No minimum or tangent from the origin on this fit: the table below says why.'}
              </li>
            )}
            {found.map((r) => (
              <li key={r.key} className="xy-re-item">
                {found.length > 1 && <span className="xy-re-name">{r.fit.name}:</span>}
                {r.re.endurance && (
                  <span className="xy-re-point">
                    <LineGlyph slot={reSlots.endurance} pattern="dashed" />
                    <span>
                      Max endurance V<sub>E</sub> = {labelNumber(r.re.endurance.v)}
                      {xUnit}
                      {r.re.endurance.extrapolated && <span className="xy-re-warn"> (extrapolated)</span>}
                    </span>
                  </span>
                )}
                {r.re.range && (
                  <span className="xy-re-point">
                    <LineGlyph slot={reSlots.range} pattern="solid" />
                    <span>
                      Max range V<sub>R</sub> = {labelNumber(r.re.range.v)}
                      {xUnit}
                      {r.re.range.extrapolated && <span className="xy-re-warn"> (extrapolated)</span>}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function scrollToTables(event: MouseEvent<HTMLAnchorElement>): void {
  const target = document.getElementById('xy-tables')
  if (!target) return
  event.preventDefault()
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
}
