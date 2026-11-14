// Small hooks shared by the views.

import { useMemo } from 'react'
import { channelById } from '../core/dataset'
import { formatAxisValue, formatDuration, timeAxis } from '../core/time'
import type { Channel, Dataset, RowRange, TimeAxis } from '../core/types'
import { useActiveDataset, useWorkspace } from '../store/app'

/** The active dataset's time axis for the workspace's chosen time base (null without a dataset). */
export function useTimeAxis(): TimeAxis | null {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  return useMemo(() => (ds && ws ? timeAxis(ds, ws.timeBase) : null), [ds, ws])
}

/** Channels for ids, skipping ids that no longer exist. */
export function useChannels(ds: Dataset | null, ids: readonly string[]): Channel[] {
  return useMemo(
    () => (ds ? ids.map((id) => channelById(ds, id)).filter((c): c is Channel => c !== undefined) : []),
    [ds, ids],
  )
}

/** "120.0 s – 340.5 s · 220.5 s" for a row range on an axis (duration always from elapsed seconds). */
export function rangeText(ds: Dataset, axis: TimeAxis, range: RowRange): string {
  const [start, end] = range
  const last = Math.max(start, end - 1)
  const from = formatAxisValue(axis, axis.values[start])
  const to = formatAxisValue(axis, axis.values[last])
  const seconds = ds.elapsed[last] - ds.elapsed[start]
  return `${from} – ${to} · ${formatDuration(seconds)}`
}

/** Duration in seconds of a row range (elapsed time). */
export function rangeSeconds(ds: Dataset, range: RowRange): number {
  const last = Math.max(range[0], range[1] - 1)
  return ds.elapsed[last] - ds.elapsed[range[0]]
}
