// The two "add many points" dialogs' preview rows: the steady stretches Find steady points found, and the windows a
// pasted table of times gives on the chosen time axis — each with its name, its window on the time axis Time history
// shows, its speed and whether it would repeat a saved point. Pure: no React, no DOM.

import { formatFixed } from '../../charts/format'
import type { SteadyWindow } from '../../core/analysis/steady'
import { driftPerMinute, rangeStats, type RangeStats } from '../../core/analysis/stats'
import type { Channel, Dataset, RowRange, TestPoint, TimeAxis, Workspace } from '../../core/types'
import { formatTimeRange } from '../../components/timeText'
import { driftText, steadiness, type Steadiness } from './pointsModel'
import { heldSpeed, overlappingPoint, speedName, uniqueNames } from './pointSets'
import { MATCH_LIMIT, MATCH_SHARE, SINGLE_TIME_PAD, windowRows, type TimesWindow } from './timesTable'

/** A signed number to fixed decimals: "+1.6", "−0.4", "0.0"; "—" when missing. */
export function signedText(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—'
  const text = formatFixed(value, digits)
  return value > 0 && text !== formatFixed(0, digits) ? `+${text}` : text
}

/** "1061.3 – 1120.1 s": a row range's first and last row on the axis. */
export function windowText(axis: TimeAxis, range: RowRange): string {
  const last = Math.max(range[0], range[1] - 1)
  return formatTimeRange(axis, axis.values[range[0]], axis.values[last])
}

/**
 * Names for the rows that will be added (`base` of each, or null for a row that will not be): unique among the saved
 * points' names and each other, in row order.
 */
function namesFor(bases: readonly (string | null)[], points: readonly TestPoint[]): string[] {
  const wanted = bases.filter((b): b is string => b !== null)
  const unique = uniqueNames(wanted, points.map((p) => p.name))
  let k = 0
  return bases.map((b) => (b === null ? '' : unique[k++]))
}

// ------------------------------------------------------------------ Find steady points

export interface SteadyRow {
  /** Stable key: the rows */
  key: string
  window: SteadyWindow
  /** "250 KIAS" (unique), '' when it overlaps a saved point */
  name: string
  /** The window on the current time axis */
  range: string
  /** The saved point it would repeat (it is not added), or null */
  overlaps: TestPoint | null
}

/** The found windows as preview rows: named by the speed held ("250 KIAS", see heldSpeed), on the current time axis. */
export function steadyRows(
  ws: Pick<Workspace, 'points'>,
  axis: TimeAxis,
  windows: readonly SteadyWindow[],
  short: string,
): SteadyRow[] {
  const overlaps = windows.map((w) => overlappingPoint(ws.points, [w.start, w.end]))
  const names = namesFor(
    windows.map((w, i) => (overlaps[i] ? null : speedName(heldSpeed(w.speed.mean), short))),
    ws.points,
  )
  return windows.map((w, i) => ({
    key: `${w.start}-${w.end}`,
    window: w,
    name: names[i],
    range: windowText(axis, [w.start, w.end]),
    overlaps: overlaps[i],
  }))
}

// ------------------------------------------------------------------ Add points from times

export interface TimesRow {
  /** Stable key: the line and its text */
  key: string
  window: TimesWindow
  /** The window's rows on the chosen axis; null when no sample lies in it there (outside the log, or in a gap) */
  rows: RowRange | null
  /** The speed over the rows */
  stats: RangeStats | null
  /** The speed's steadiness over the rows (as the Test points table judges it); null when not judged */
  steady: Steadiness | null
  /** The speed's σ is above the tolerance: the window is not a steady stretch, whatever its trend */
  scattered: boolean
  /** "drifting +1.6 kt/min" when the speed drifts, else '' */
  hint: string
  /** Mean speed − listed speed; NaN without either */
  diff: number
  /** "310 KIAS" from the listed speed (else the mean), unique; '' when it will not be added */
  name: string
  /** The window on the current time axis (what Time history shows) */
  range: string
  /** The saved point it would repeat (it is not added), or null */
  overlaps: TestPoint | null
  /** The line of an earlier window in the paste that shares rows with this one, or null */
  clash: number | null
  /**
   * Ticked to start with: a window of data that is not a saved point, whose mean speed agrees with the speed listed
   * (within MATCH_LIMIT), that shares no rows with an earlier line, is not scattered, and lists a speed when most
   * lines do. The others can still be ticked.
   */
  suggested: boolean
  /**
   * Why it is not ticked to start with, in a few words ('' when it is): "Overlaps line 3", "8.3 kt off" (the speed
   * listed), "Scattered ± 15 kt", "No speed listed", "No data here"
   */
  caution: string
}

/**
 * The pasted windows on axis `on`, with the speed over each, as preview rows (ranges shown on `shown`). Without a
 * speed channel (a file with no airspeed) the rows have no statistics and are named by the speed listed. `speedTol`
 * (the speed's unit): a window whose σ is above it is scattered, not steady.
 */
export function timesRows(
  ds: Dataset,
  ws: Pick<Workspace, 'points'>,
  on: TimeAxis,
  shown: TimeAxis,
  windows: readonly TimesWindow[],
  speed: Channel | null,
  pad = SINGLE_TIME_PAD,
  speedTol = MATCH_LIMIT,
): TimesRow[] {
  const draft = windows.map((window) => {
    const rows = windowRows(on, window, pad)
    const none = { window, rows, stats: null, steady: null, scattered: false, hint: '', diff: NaN }
    if (!rows) return { ...none, overlaps: null }
    if (!speed) return { ...none, overlaps: overlappingPoint(ws.points, rows) }
    const stats = rangeStats(speed.values, rows[0], rows[1])
    const last = Math.max(rows[0], rows[1] - 1)
    const seconds = ds.elapsed[last] - ds.elapsed[rows[0]]
    const drift = driftPerMinute(speed.values, ds.elapsed, rows[0], rows[1])
    const steady = stats.n >= 3 ? steadiness(stats, drift, seconds, speed) : null
    return {
      window,
      rows,
      stats,
      steady,
      scattered: stats.n >= 3 && stats.std > speedTol,
      hint: steady?.flagged ? driftText(drift, speed.meta.unit) : '',
      diff: window.speed !== null && stats.n > 0 ? stats.mean - window.speed : NaN,
      overlaps: overlappingPoint(ws.points, rows),
    }
  })
  const names = namesFor(
    draft.map((d) =>
      d.rows && !d.overlaps ? speedName(d.window.speed ?? heldSpeed(d.stats?.mean ?? NaN), speed?.meta.short ?? 'kt') : null,
    ),
    ws.points,
  )
  // Most lines list a speed: one that does not is probably not a test point ("140 | not recorded").
  const listing = windows.filter((w) => w.speed !== null).length >= MATCH_SHARE * windows.length
  const unit = speed?.meta.unit ? ` ${speed.meta.unit}` : ''
  return draft.map((d, i) => {
    const rows = d.rows
    const clash = rows
      ? (draft.slice(0, i).find((e) => e.rows && e.rows[0] < rows[1] && rows[0] < e.rows[1])?.window.line ?? null)
      : null
    const caution = !rows
      ? 'No data here'
      : d.overlaps
        ? ''
        : clash !== null
          ? `Overlaps line ${clash}`
          : Math.abs(d.diff) > MATCH_LIMIT
            ? `${formatFixed(Math.abs(d.diff), 1)}${unit} off`
            : d.scattered && d.stats
              ? `Scattered ± ${formatFixed(d.stats.std, 1)}${unit}`
              : speed && listing && d.window.speed === null
                ? 'No speed listed'
                : ''
    return {
      ...d,
      key: `${d.window.line}:${d.window.text}`,
      name: names[i],
      range: rows ? windowText(shown, rows) : '',
      clash,
      suggested: !!rows && !d.overlaps && caution === '',
      caution,
    }
  })
}
