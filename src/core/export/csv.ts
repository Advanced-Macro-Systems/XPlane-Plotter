// CSV / TSV exports of raw samples and of test-point statistics. Full precision (no rounding beyond JS's shortest
// round-trip representation), NaN written as empty cells, header names quoted when needed.
// OWNER: export agent. Public API below is a contract; keep these signatures.
//
// Format: RFC 4180 (fields quoted only when they contain the delimiter, a double quote or a line break; quotes doubled;
// CRLF line endings, including after the last record). TSV follows the same rules with a tab delimiter.
// Text that comes from the file or the user (headers, point and group names) is guarded against spreadsheet formula
// injection: a text cell starting with = + - @ gets a leading apostrophe, as OWASP recommends. Numbers are never altered.

import { channelTitle } from '../channels/title'
import { windowStats } from '../analysis/windowStats'
import { channelById } from '../dataset'
import type { Channel, Dataset, RowRange, Workspace } from '../types'

export interface CsvExportOptions {
  channelIds: string[]
  /** null = every row; otherwise the listed ranges in order, with a leading "point" column holding each name */
  ranges: { name: string; range: RowRange }[] | null
  /** Prepend "row" (0-based), "elapsed_s" and the raw time-source column */
  includeTime: boolean
  delimiter: ',' | '\t'
}

const EOL = '\r\n'

/** One field, quoted per RFC 4180 when it contains the delimiter, a double quote or a line break. */
export function csvField(text: string, delimiter: string): string {
  if (text.includes('"') || text.includes(delimiter) || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** A text cell: quoted when needed, and defused when a spreadsheet would read it as a formula. */
function textCell(text: string, delimiter: string): string {
  return csvField(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text, delimiter)
}

/** A numeric cell: shortest round-trip representation, NaN as an empty cell. */
function numCell(value: number): string {
  return Number.isNaN(value) ? '' : String(value)
}

/** The channels for `ids`, in order, without unknown ids or repeats. */
function pickChannels(ds: Dataset, ids: readonly string[]): Channel[] {
  const seen = new Set<Channel>()
  for (const id of ids) {
    const ch = channelById(ds, id)
    if (ch) seen.add(ch)
  }
  return [...seen]
}

/** [start, end) clamped to the dataset (end >= start). */
function clampRange(ds: Dataset, range: RowRange): [number, number] {
  const start = Math.max(0, Math.min(ds.rowCount, Math.floor(range[0])))
  const end = Math.max(start, Math.min(ds.rowCount, Math.ceil(range[1])))
  return [start, end]
}

/**
 * Header row uses channel titles with units ("KIAS [kt]") and, on a second header row, the raw X-Plane tokens.
 * Derived channels show their formula in the token row. With `includeTime`, the columns "row" (0-based), "elapsed_s"
 * and the time-source channel come first (the time source is not repeated if it is also among `channelIds`).
 * Returns '' when there is no column at all.
 */
export function datasetCsv(ds: Dataset, opts: CsvExportOptions): string {
  const d = opts.delimiter
  const timeSource = opts.includeTime && ds.timeSourceId ? channelById(ds, ds.timeSourceId) : undefined
  const channels = pickChannels(ds, opts.channelIds).filter((ch) => ch !== timeSource)

  const titles: string[] = []
  const tokens: string[] = []
  if (opts.ranges) {
    titles.push('point')
    tokens.push('point')
  }
  if (opts.includeTime) {
    titles.push('row', 'elapsed_s')
    tokens.push('row', 'elapsed_s')
    if (timeSource) {
      titles.push(channelTitle(timeSource))
      tokens.push(timeSource.token)
    }
  }
  for (const ch of channels) {
    titles.push(channelTitle(ch))
    tokens.push(ch.derived ? ch.derived.expression : ch.token)
  }
  if (!titles.length) return ''

  const lines: string[] = [titles.map((t) => textCell(t, d)).join(d), tokens.map((t) => textCell(t, d)).join(d)]
  const columns = channels.map((ch) => ch.values)
  const timeValues = timeSource?.values
  const cells: string[] = []

  const pushRow = (row: number, label: string | null): void => {
    cells.length = 0
    if (label !== null) cells.push(label)
    if (opts.includeTime) {
      cells.push(String(row), numCell(ds.elapsed[row]))
      if (timeValues) cells.push(numCell(timeValues[row]))
    }
    for (const values of columns) cells.push(numCell(values[row]))
    lines.push(cells.join(d))
  }

  if (opts.ranges === null) {
    for (let row = 0; row < ds.rowCount; row += 1) pushRow(row, null)
  } else {
    for (const { name, range } of opts.ranges) {
      const label = textCell(name, d)
      const [start, end] = clampRange(ds, range)
      for (let row = start; row < end; row += 1) pushRow(row, label)
    }
  }
  return lines.join(EOL) + EOL
}

/** Columns written for each channel in the test-point table, in order. */
const POINT_STATS = ['mean', 'std', 'min', 'max', 'drift_per_min'] as const

/**
 * One row per test point: name, group, start/end elapsed time (s), duration (s), rows, n, then for each channel
 * mean, std, min, max and drift per minute. Hidden points are included (with a "hidden" column).
 *
 * Columns: point, group, start_s (elapsed time of the first row), end_s (of the last row), duration_s (end_s − start_s),
 * start_row, end_row (0-based, end exclusive), n (rows), then "<title> mean|std|min|max|drift_per_min" per channel
 * (std is the sample standard deviation; drift is the least-squares slope against elapsed time, per minute), and
 * hidden (1/0) last.
 */
export function pointsTableCsv(ds: Dataset, ws: Workspace, channelIds: string[], delimiter: ',' | '\t' = ','): string {
  const d = delimiter
  const channels = pickChannels(ds, channelIds)
  const header = ['point', 'group', 'start_s', 'end_s', 'duration_s', 'start_row', 'end_row', 'n']
  for (const ch of channels) {
    const title = channelTitle(ch)
    for (const stat of POINT_STATS) header.push(`${title} ${stat}`)
  }
  header.push('hidden')

  const groupNames = new Map(ws.groups.map((g) => [g.id, g.name]))
  const lines = [header.map((h) => textCell(h, d)).join(d)]
  for (const point of ws.points) {
    const [start, end] = clampRange(ds, [point.start, point.end])
    const n = end - start
    const t0 = n > 0 ? ds.elapsed[start] : NaN
    const t1 = n > 0 ? ds.elapsed[end - 1] : NaN
    const cells = [
      textCell(point.name, d),
      textCell(groupNames.get(point.groupId) ?? '', d),
      numCell(t0),
      numCell(t1),
      numCell(t1 - t0),
      String(start),
      String(end),
      String(n),
    ]
    for (const ch of channels) {
      // As in the Test points table: a heading window through north is unwrapped first (windowStats).
      const { stats, drift } = windowStats(ch, ds.elapsed, start, end)
      if (stats.n === 0) {
        // No finite sample in the window: empty cells rather than whatever an empty min/max would be.
        cells.push('', '', '', '', '')
        continue
      }
      cells.push(numCell(stats.mean), numCell(stats.std), numCell(stats.min), numCell(stats.max), numCell(drift))
    }
    cells.push(point.hidden ? '1' : '0')
    lines.push(cells.join(d))
  }
  return lines.join(EOL) + EOL
}
