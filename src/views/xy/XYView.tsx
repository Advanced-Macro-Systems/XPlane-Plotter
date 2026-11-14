// X–Y plot: any channel against one or more others (one shared axis, so one unit), from the whole file, the Time-history
// zoom range or the test points (with their means ± 1σ), with least-squares fits. The pure parts live next to it:
// xyModel (what is plotted), xyPresets, xyControls, xyHover, xyTables; the chart option in charts/options/xy.ts.

import { InfoIcon } from '@primer/octicons-react'
import { useMemo, useRef, useState } from 'react'
import type { ECharts } from '../../charts/echarts'
import { exportOptionImage } from '../../charts/exportChart'
import { xyChartOption } from '../../charts/options/xy'
import { readChartTheme } from '../../charts/theme'
import { ExportMenu, type ExportItem } from '../../components/ExportMenu'
import { useTimeAxis } from '../../components/hooks'
import { downloadText } from '../../core/export/download'
import { formatAxisValue } from '../../core/time'
import type { Dataset, RowRange, TimeAxis, Workspace } from '../../core/types'
import { exportMatlab } from '../../layout/fileActions'
import { toast, useActiveDataset, useApp, useWorkspace } from '../../store/app'
import { XYChartCard } from './XYChart'
import { XYSidebar } from './XYSidebar'
import { XYResults } from './XYResults'
import { exportStem, figureZoom, focusExtent, focusedAxes, plotKey, plotSummary } from './xyControls'
import { buildXYData, computeFits, defaultLabels, finalLabels, type XYDataConfig } from './xyModel'
import { NEEDS_TEST_POINTS, rangeResults } from './xyRange'
import { samplesCsv } from './xyTables'
import './xy.css'

export function XYView() {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  const axis = useTimeAxis()
  return (
    <div className="view" data-testid="view-xy">
      {ds && ws && axis && <XYWorkspace ds={ds} ws={ws} axis={axis} />}
    </div>
  )
}

/** Exported figures: 900 × 600 CSS px (2700 × 1800 px PNG). */
const FIGURE = { width: 900, height: 600 }

function useXYModel(ds: Dataset, ws: Workspace, view: RowRange | null, axis: TimeAxis) {
  const xy = ws.xy
  // setXY copies ys on every change: key the data on the ids (and their colour slots), so a label or fit change never
  // rebuilds it.
  const ysKey = xy.ys.join('\n')
  const slotsKey = (xy.ySlots ?? []).join(',')
  const groupsKey = (xy.groups ?? []).join('\n')
  const config = useMemo<XYDataConfig>(
    () => ({
      x: xy.x,
      ys: ysKey ? ysKey.split('\n') : [],
      ySlots: slotsKey ? slotsKey.split(',').map(Number) : undefined,
      source: xy.source,
      groups: groupsKey ? groupsKey.split('\n') : undefined,
      colorBy: xy.colorBy,
      fitTarget: xy.fitTarget,
      showMeans: xy.showMeans,
    }),
    [xy.x, ysKey, slotsKey, xy.source, groupsKey, xy.colorBy, xy.fitTarget, xy.showMeans],
  )
  // The zoom range matters only to the zoom-range source.
  const rows = config.source === 'view' ? view : null
  const lines = xy.style !== 'points' || xy.colorBy === 'time'
  const data = useMemo(
    () => buildXYData({ ds, xy: config, ws: { points: ws.points, groups: ws.groups }, view: rows, axis, lines }),
    [ds, config, ws.points, ws.groups, rows, axis, lines],
  )
  // A few absurd samples (CL on the ground) would flatten the rest: the axes focus on the bulk unless asked not to,
  // and a fit through the samples keeps to what the axes show.
  const focus = useMemo(() => (data.empty ? null : focusExtent(data)), [data])
  const key = plotKey(data)
  const [showAllFor, setShowAllFor] = useState<string | null>(null)
  const showAll = showAllFor === key
  const extent = useMemo(() => focusedAxes(focus, showAll), [focus, showAll])
  const fits = useMemo(() => computeFits(data, xy.fit, extent), [data, xy.fit, extent])
  // Range and endurance of every fit, when its markers are on and there is a fit (null = off, as the sidebar's checkbox
  // and the MATLAB export have it). When the settings ask for test points and there are none yet (a range and
  // endurance preset on a fresh log), every row is plotted: no speeds from that, the table says to save points first.
  const reOn = xy.rangeEndurance === true && xy.fit !== 'none'
  const needsPoints = xy.source === 'points' && data.effective.source !== 'points'
  const re = useMemo(
    () => (reOn ? rangeResults(fits, needsPoints ? NEEDS_TEST_POINTS : '') : null),
    [fits, reOn, needsPoints],
  )
  const defaults = useMemo(() => defaultLabels(data.x, data.ys.map((y) => y.ch)), [data])
  const labels = useMemo(
    () => finalLabels({ title: xy.title, xLabel: xy.xLabel, yLabel: xy.yLabel }, defaults),
    [xy.title, xy.xLabel, xy.yLabel, defaults],
  )
  const onShowAll = (all: boolean) => setShowAllFor(all ? key : null)
  return { data, fits, re, defaults, labels, focus, showAll, extent, onShowAll }
}

function XYWorkspace({ ds, ws, axis }: { ds: Dataset; ws: Workspace; axis: TimeAxis }) {
  const view = useApp((s) => s.view)
  const xy = ws.xy
  const { data, fits, re, defaults, labels, focus, showAll, extent, onShowAll } = useXYModel(ds, ws, view, axis)
  const chartRef = useRef<ECharts | null>(null)

  const groupNames = ws.groups.filter((g) => data.effective.groupIds.includes(g.id)).map((g) => g.name)
  const summary = data.empty ? '' : plotSummary(data, groupNames, xy.showSamples)

  const exportImage = async (format: 'png' | 'svg') => {
    const chart = chartRef.current
    const zoom = chart && !chart.isDisposed() ? figureZoom(chart.getOption()) : null
    const option = xyChartOption(
      {
        data,
        fits,
        style: xy.style,
        showSamples: xy.showSamples,
        labels,
        time: { label: axis.label, format: (v) => formatAxisValue(axis, v) },
        extent,
        figure: { zoom },
        re,
        axesFromZero: xy.axesFromZero === true,
        // The construction labels are placed for the figure's size and the zoom window it keeps.
        size: FIGURE,
      },
      readChartTheme('paper'),
    )
    try {
      await exportOptionImage(option, { format, ...FIGURE, filename: exportStem(ds.name) })
    } catch (error) {
      toast(`Could not export the figure: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const items: ExportItem[] = [
    {
      section: 'Figure',
      label: 'PNG image',
      hint: 'White background, 2700 × 1800 px, keeps the zoom',
      disabled: !!data.empty,
      onSelect: () => exportImage('png'),
    },
    {
      label: 'SVG image',
      hint: 'Vector, for reports',
      disabled: !!data.empty,
      onSelect: () => exportImage('svg'),
    },
    {
      section: 'Data',
      label: 'CSV of the plotted samples',
      hint: 'x, y, series and test point per sample',
      disabled: !!data.empty || data.sampleCount === 0,
      onSelect: () => {
        const csv = samplesCsv(ds, data)
        if (!csv) return toast('Nothing is plotted yet.', 'info')
        downloadText(`${exportStem(ds.name)}_samples.csv`, csv, 'text/csv')
      },
    },
    {
      section: 'MATLAB',
      label: 'MATLAB script: this plot only',
      hint: 'Re-reads the log; this plot and the test-point table',
      disabled: !data.x || !data.ys.length,
      // The axis ranges shown go with it: a fit through the samples leaves out the same off-axis samples there.
      onSelect: () => void exportMatlab({ part: 'xy', xyLimits: extent }),
    },
  ]

  return (
    <div className="view-split xy">
      <XYSidebar ds={ds} ws={ws} view={view} data={data} defaults={defaults} />
      <div className="view-main xy-main">
        <div className="xy-stage">
          <header className="xy-heading">
            <div className="xy-heading-text">
              <p className="eyebrow">X–Y plot</p>
              <h2 title={labels.title}>{labels.title || 'X–Y plot'}</h2>
              {summary && <p className="xy-heading-sub">{summary}</p>}
            </div>
            <div className="xy-heading-actions">
              <ExportMenu items={items} testId="xy-export-menu" />
            </div>
          </header>
          {data.empty ? (
            <section className="chart-card xy-card xy-empty" data-testid="xy-chart" aria-label="X–Y plot">
              <InfoIcon size={24} />
              <h3>{data.empty}</h3>
              <p>Pick a preset in the sidebar (the static-stability preset plots elevator to trim against CL), or choose the axes.</p>
            </section>
          ) : (
            <XYChartCard
              data={data}
              fits={fits}
              re={re}
              labels={labels}
              xy={xy}
              axis={axis}
              chartRef={chartRef}
              focus={focus}
              extent={extent}
              showAll={showAll}
              onShowAll={onShowAll}
            />
          )}
        </div>
        {!data.empty && <XYResults data={data} fits={fits} fit={xy.fit} re={re} />}
      </div>
    </div>
  )
}
