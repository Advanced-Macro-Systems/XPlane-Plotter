// "Flight at a glance": up to three compact stacked charts (altitude, airspeed, attitude — or the file's first plain
// channels) over the whole log, sharing the time axis and crosshair (one ECharts group), with sim resets / recording
// gaps marked and the test points as faint neutral bands (as in Time history: a band in a group's colour would compete
// with the line of that colour).

import { useMemo, type CSSProperties } from 'react'
import { EChart } from '../../charts/EChart'
import { formatNumber } from '../../charts/format'
import { glanceChartHeight, glanceChartOption, type GlanceLine } from '../../charts/options/overview'
import { seriesColor, useChartTheme, type ChartTheme } from '../../charts/theme'
import { channelById } from '../../core/dataset'
import { formatAxisValue, timeAxis } from '../../core/time'
import type { Dataset, Workspace } from '../../core/types'
import {
  decimateBySegment,
  glancePanels,
  glanceTime,
  markerLegend,
  pointBands,
  segmentMarkers,
  toPairs,
  type GlancePanelSpec,
} from './overviewModel'

/** Points per line: plenty for a chart a few hundred pixels wide, whatever the log's length. */
const POINTS_PER_LINE = 1600
/** Height of each plot area, px (the containers add room for marker labels and the time axis). */
const PLOT_HEIGHT = 84
const GROUP = 'ov-glance'

interface PanelData {
  spec: GlancePanelSpec
  lines: (GlanceLine & { label: string })[]
  min: number
  max: number
}

export function GlanceCharts({ ds, ws }: { ds: Dataset; ws: Workspace | null }) {
  const theme = useChartTheme()
  const panels = useMemo<PanelData[]>(
    () =>
      glancePanels(ds).map((spec) => {
        let min = Infinity
        let max = -Infinity
        const lines = spec.channelIds.flatMap((id, slot) => {
          const ch = channelById(ds, id)
          if (!ch) return []
          min = Math.min(min, ch.stats.min)
          max = Math.max(max, ch.stats.max)
          const reduced = decimateBySegment(ds.elapsed, ch.values, ds.segments, POINTS_PER_LINE)
          return [{ name: ch.meta.short, label: ch.meta.label, slot, data: toPairs(reduced.x, reduced.y) }]
        })
        return { spec, lines, min, max }
      }),
    [ds],
  )
  const markers = useMemo(
    () => segmentMarkers(ds).map((m) => ({ x: m.x, label: m.reason === 'reset' ? 'reset' : 'gap' })),
    [ds],
  )
  const points = ws?.points
  const groups = ws?.groups
  const bands = useMemo(() => (points && groups ? pointBands(ds, { points, groups }) : []), [ds, points, groups])
  const shownGroups = useMemo(() => {
    const used = new Set((points ?? []).filter((p) => !p.hidden).map((p) => p.groupId))
    return (groups ?? []).filter((g) => used.has(g.id))
  }, [points, groups])

  if (!panels.length) {
    return (
      <div className="chart-card ov-glance ov-glance-empty">
        <p className="muted">No channel in this file changes over time, so there is nothing to draw.</p>
      </div>
    )
  }

  const last = ds.rowCount - 1
  const xMin = ds.elapsed[0]
  const xMax = Math.max(ds.elapsed[last], xMin + 1e-9)

  return (
    <div className="chart-card ov-glance">
      {panels.map((panel, i) => (
        <GlancePanel
          key={panel.spec.key}
          ds={ds}
          theme={theme}
          panel={panel}
          xMin={xMin}
          xMax={xMax}
          first={i === 0}
          last={i === panels.length - 1}
          markers={markers}
          bands={bands}
        />
      ))}
      {(shownGroups.length > 0 || markers.length > 0) && (
        <div className="ov-glance-foot">
          {shownGroups.length > 0 && (
            <span className="ov-glance-key">
              <span className="ov-glance-band" aria-hidden="true" />
              <span className="ov-glance-key-label">Test points</span>
              {shownGroups.map((g) => g.name).join(', ')}
            </span>
          )}
          {markers.length > 0 && (
            <span className="ov-glance-key">
              <span className="ov-glance-marker" aria-hidden="true" />
              {markerLegend(
                markers.filter((m) => m.label === 'reset').length,
                markers.filter((m) => m.label !== 'reset').length,
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function GlancePanel({
  ds,
  theme,
  panel,
  xMin,
  xMax,
  first,
  last,
  markers,
  bands,
}: {
  ds: Dataset
  theme: ChartTheme
  panel: PanelData
  xMin: number
  xMax: number
  first: boolean
  last: boolean
  markers: { x: number; label: string }[]
  bands: { from: number; to: number }[]
}) {
  const { spec, lines } = panel
  const labelMarkers = first && markers.length > 0
  const time = glanceTime(ds)
  const xAxis = useMemo(() => timeAxis(ds, time.base), [ds, time.base])
  const option = useMemo(
    () =>
      glanceChartOption(theme, {
        lines,
        unit: spec.unit,
        xMin,
        xMax,
        showXAxis: last,
        xName: time.axisName,
        markers,
        labelMarkers,
        bands,
        formatX: (x) => formatAxisValue(xAxis, x),
      }),
    [theme, lines, spec.unit, xMin, xMax, last, time.axisName, markers, labelMarkers, bands, xAxis],
  )
  const names = lines.map((l) => l.label).join(' and ')
  const unit = spec.unit ? ` [${spec.unit}]` : ''

  return (
    <div className="ov-glance-panel">
      <div className="ov-glance-head">
        <span className="ov-glance-title">
          {spec.title}
          {unit && <span className="ov-glance-unit">{unit}</span>}
        </span>
        {lines.length > 1 && (
          <span className="ov-glance-legend">
            {lines.map((line) => (
              <span key={line.slot} className="series-chip ov-chip" title={line.label}>
                <span className="line-key" style={{ '--key': seriesColor(theme, line.slot) } as CSSProperties} />
                <span className="series-chip-name">{line.name}</span>
              </span>
            ))}
          </span>
        )}
        {Number.isFinite(panel.min) && (
          <span className="ov-glance-range" title="Lowest and highest value in the file">
            {formatNumber(panel.min)} to {formatNumber(panel.max)}
            {spec.unit ? ` ${spec.unit}` : ''}
          </span>
        )}
      </div>
      <EChart
        option={option}
        replaceMerge={['series']}
        group={GROUP}
        className="ov-glance-plot"
        style={{ height: glanceChartHeight(PLOT_HEIGHT, { showXAxis: last, labelMarkers }) }}
        ariaLabel={`${names}${unit} over the whole flight, against ${time.against}`}
      />
    </div>
  )
}
