// Small hooks shared by the views.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { channelById } from '../core/dataset'
import { formatDuration, timeAxis } from '../core/time'
import type { Channel, Dataset, RowRange, TimeAxis } from '../core/types'
import { useActiveDataset, useWorkspace } from '../store/app'
import { formatTimeRange } from './timeText'

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

/**
 * "120.0 – 340.5 s · 220.5 s" for a row range on an axis: its first and last row (formatTimeRange, the one range format
 * of the app), then the duration (always from elapsed seconds).
 */
export function rangeText(ds: Dataset, axis: TimeAxis, range: RowRange): string {
  const [start, end] = range
  const last = Math.max(start, end - 1)
  const seconds = ds.elapsed[last] - ds.elapsed[start]
  return `${formatTimeRange(axis, axis.values[start], axis.values[last])} · ${formatDuration(seconds)}`
}

/** Duration in seconds of a row range (elapsed time). */
export function rangeSeconds(ds: Dataset, range: RowRange): number {
  const last = Math.max(range[0], range[1] - 1)
  return ds.elapsed[last] - ds.elapsed[range[0]]
}

/** 'smooth' scrolling, or 'auto' (a jump) when the user asks the system for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  } catch {
    return 'smooth'
  }
}

/**
 * A value that follows `value` once it has stopped changing for `ms` (the first value is taken at once): a fit that
 * waits for clicks to settle, or a status line that is spoken once typing pauses rather than on every key.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(settled, value)) return
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

/** Phones: the single-column layout of components/view.css (keep the two in step). */
export const PHONE_QUERY = '(max-width: 560px)'

/** Whether a CSS media query matches now, following changes (false where matchMedia is missing). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  )
}
