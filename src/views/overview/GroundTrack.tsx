// The ground track: longitude against latitude with equal ground distance per pixel on both axes (the ranges follow
// the plot's measured size), start and end marked.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { EChart } from '../../charts/EChart'
import { formatNumber } from '../../charts/format'
import { groundTrackOption, TRACK_GRID } from '../../charts/options/overview'
import { useChartTheme } from '../../charts/theme'
import { channelTitle } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { formatAxisValue, timeAxis } from '../../core/time'
import type { Dataset } from '../../core/types'
import { equalAspectRanges, glanceTime, trackSizeKm, type GroundTrack } from './overviewModel'

/** Width / height of the plot area, rounded so a resize redraws only when the shape really changes. */
function usePlotAspect(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState(1)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (!box) return
      const width = box.width - TRACK_GRID.left - TRACK_GRID.right
      const height = box.height - TRACK_GRID.top - TRACK_GRID.bottom
      if (width > 10 && height > 10) setAspect(Math.round((width / height) * 50) / 50)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, aspect]
}

export function GroundTrackCard({ ds, track }: { ds: Dataset; track: GroundTrack }) {
  const theme = useChartTheme()
  const [plotRef, aspect] = usePlotAspect()
  const ranges = useMemo(() => equalAspectRanges(track.lonExtent, track.latExtent, aspect), [track, aspect])
  const size = useMemo(() => trackSizeKm(track), [track])
  const option = useMemo(() => {
    const time = glanceTime(ds)
    const axis = timeAxis(ds, time.base)
    // "t = 12.0 s", or "row 12" for a file without a time column (its elapsed time is the row index).
    const when = (t: number) => (time.base === 'elapsed' ? `t = ${formatAxisValue(axis, t)}` : formatAxisValue(axis, t))
    const lonCh = channelById(ds, track.lonId)
    const latCh = channelById(ds, track.latId)
    return groundTrackOption(theme, {
      path: track.path,
      start: { label: 'Start', ...track.start, time: when(track.start.t) },
      end: { label: 'End', ...track.end, time: when(track.end.t) },
      lonRange: ranges.lon,
      latRange: ranges.lat,
      xName: lonCh ? channelTitle(lonCh) : 'Longitude',
      yName: latCh ? channelTitle(latCh) : 'Latitude',
      lonLabel: lonCh?.meta.label ?? 'Longitude',
      latLabel: latCh?.meta.label ?? 'Latitude',
    })
  }, [ds, theme, track, ranges])

  return (
    <div className="chart-card ov-track">
      <div className="chart-card-header">
        <span className="chart-card-title">Ground track</span>
        <span className="ov-track-size" title="East–west by north–south extent of the track">
          {formatNumber(size.eastWest, 3)} × {formatNumber(size.northSouth, 3)} km
        </span>
      </div>
      <div ref={plotRef} className="ov-track-plot">
        <EChart
          option={option}
          notMerge
          className="ov-track-chart"
          ariaLabel="Ground track: longitude against latitude with equal scales, from the start marker (circle) to the end marker (square)"
        />
      </div>
    </div>
  )
}
