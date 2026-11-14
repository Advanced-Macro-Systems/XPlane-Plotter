// The ground track: longitude against latitude with equal ground distance per pixel on both axes, start and end marked,
// and where the track picks up again after a sim reset or recording gap. The plot is as tall as the track's shape
// needs (within limits), so the equal-aspect ranges stay close to the track instead of padding it into a tall box.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { EChart } from '../../charts/EChart'
import { formatNumber } from '../../charts/format'
import { groundTrackOption, TRACK_GRID } from '../../charts/options/overview'
import { useChartTheme } from '../../charts/theme'
import { channelTitle } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { formatAxisValue, timeAxis } from '../../core/time'
import type { Dataset } from '../../core/types'
import { equalAspectRanges, glanceTime, trackPlotBox, trackSizeKm, type GroundTrack } from './overviewModel'

/** The plot box's measured width (px), rounded so a resize redraws only when it really changes. */
function usePlotWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (box && box.width > 0) setWidth(Math.round(box.width / 4) * 4)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export function GroundTrackCard({ ds, track }: { ds: Dataset; track: GroundTrack }) {
  const theme = useChartTheme()
  const [plotRef, width] = usePlotWidth()
  const size = useMemo(() => trackSizeKm(track), [track])
  const box = useMemo(() => trackPlotBox(size, width, TRACK_GRID), [size, width])
  const ranges = useMemo(() => equalAspectRanges(track.lonExtent, track.latExtent, box.aspect), [track, box.aspect])
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
      restarts: track.restarts.map((r) => ({
        label: 'Restart',
        lon: r.lon,
        lat: r.lat,
        time: `${when(r.t)}, after ${r.reason === 'reset' ? 'a sim reset' : 'a recording gap'}`,
      })),
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
      <div ref={plotRef} className="ov-track-plot" style={{ height: box.height }}>
        <EChart
          option={option}
          notMerge
          className="ov-track-chart"
          ariaLabel={`Ground track: longitude against latitude with equal scales, from the start marker (circle) to the end marker (square)${
            track.restarts.length
              ? `; ${track.restarts.length === 1 ? 'a triangle marks where it starts' : 'triangles mark where it starts'} again after a reset or gap`
              : ''
          }`}
        />
      </div>
    </div>
  )
}
