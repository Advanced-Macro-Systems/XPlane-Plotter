// Turns a RawTable into a Dataset: channel ids (with #2 for repeats), meanings, stats, time source, elapsed time,
// segments, sample rate, warnings and the workspace signature.
// OWNER: parser agent (buildDataset). computeStats and channelById are final — keep them as they are.

import type { Channel, ChannelStats, Dataset, Segment } from './types'
import type { RawTable } from './parse'
import { describeHeader } from './channels'
import { buildElapsed, pickTimeSource } from './time'

/** Time resets/gaps listed one by one in the warnings before they are summarised. */
const MAX_TIME_NOTES = 5

/** Builds the dataset. Never throws for a valid RawTable (rowCount may be 0 → caller shows an error). */
export function buildDataset(raw: RawTable, source: { name: string; size: number }): Dataset {
  const rowCount = raw.rowCount
  const channels = fileChannels(raw)
  const timeSource = pickTimeSource(channels)
  const warnings = [...raw.warnings]
  if (raw.skippedRows > 0) {
    const n = raw.skippedRows
    const why = raw.format === 'xplane' ? 'wrong number of values' : 'wrong number of values, or no numbers'
    warnings.push(`Skipped ${n} unreadable row${n === 1 ? '' : 's'} (${why}).`)
  }

  let elapsed: Float64Array
  let segments: Segment[]
  let sampleRateHz: number
  if (timeSource) {
    const result = buildElapsed(timeSource.values)
    elapsed = result.elapsed
    segments = result.segments
    sampleRateHz = result.medianDt > 0 ? 1 / result.medianDt : NaN
    warnings.push(...discontinuityNotes(segments, timeSource.values))
  } else {
    elapsed = new Float64Array(rowCount)
    for (let i = 0; i < rowCount; i += 1) elapsed[i] = i
    segments = rowCount > 0 ? [{ start: 0, end: rowCount, reason: 'start' }] : []
    sampleRateHz = NaN
    warnings.push('No time column found; time is shown as row number.')
  }

  return {
    id: '',
    name: source.name,
    sizeBytes: source.size,
    format: raw.format,
    rowCount,
    channels,
    timeSourceId: timeSource?.id ?? null,
    elapsed,
    segments,
    sampleRateHz,
    warnings,
    signature: signatureOf(raw, timeSource),
    loadedAt: Date.now(),
  }
}

/**
 * One channel per file column: id = token, "#2", "#3"... for repeats (kept unique even if a header contains "#").
 * Meanings come from the whole header at once, so a token that several Data Output rows write gets its own row's.
 */
function fileChannels(raw: RawTable): Channel[] {
  const occurrences = new Map<string, number>()
  const taken = new Set<string>()
  const metas = describeHeader(raw.headers)
  return raw.headers.map((token, column) => {
    const occurrence = (occurrences.get(token) ?? 0) + 1
    occurrences.set(token, occurrence)
    let id = occurrence > 1 ? `${token}#${occurrence}` : token
    for (let k = occurrence + 1; taken.has(id); k += 1) id = `${token}#${k}`
    taken.add(id)
    const values = raw.columns[column]
    return { id, token, occurrence, column, meta: metas[column], values, stats: computeStats(values) }
  })
}

/** One note per segment boundary ("Time resets at row 300 ...", "Recording gap of 870.0 s at row 300."), at most 5. */
function discontinuityNotes(segments: readonly Segment[], time: Float64Array): string[] {
  const boundaries = segments.slice(1)
  const notes = boundaries.slice(0, MAX_TIME_NOTES).map((segment) => {
    if (segment.reason === 'reset') return `Time resets at row ${segment.start} (a new flight was loaded?).`
    let before = segment.start - 1
    while (before > 0 && Number.isNaN(time[before])) before -= 1
    const jump = time[segment.start] - time[before]
    return `Recording gap of ${jump.toFixed(1)} s at row ${segment.start}.`
  })
  const more = boundaries.length - MAX_TIME_NOTES
  if (more > 0) notes.push(`…and ${more} more time ${more === 1 ? 'reset or gap' : 'resets or gaps'}.`)
  return notes
}

function firstFinite(values: Float64Array): number {
  for (let i = 0; i < values.length; i += 1) if (!Number.isNaN(values[i])) return values[i]
  return NaN
}

function lastFinite(values: Float64Array): number {
  for (let i = values.length - 1; i >= 0; i -= 1) if (!Number.isNaN(values[i])) return values[i]
  return NaN
}

/** Workspace key: headers + row count + first/last time-source values, hashed. Stable across reloads of a file. */
function signatureOf(raw: RawTable, timeSource: Channel | null): string {
  const first = timeSource ? String(firstFinite(timeSource.values)) : ''
  const last = timeSource ? String(lastFinite(timeSource.values)) : ''
  return fnv1a32(`${raw.headers.join('|')}\n${raw.rowCount}\n${first}\n${last}`)
}

/** FNV-1a 32-bit hash of the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const lookup = new WeakMap<Dataset, Map<string, Channel>>()

/** O(1) lookup (cached per dataset object). */
export function channelById(ds: Dataset, id: string): Channel | undefined {
  let table = lookup.get(ds)
  if (!table) {
    table = new Map(ds.channels.map((ch) => [ch.id, ch]))
    lookup.set(ds, table)
  }
  return table.get(id)
}

/** NaN-aware stats over all values. `constant` is true when every finite value is equal or there are none. */
export function computeStats(values: Float64Array): ChannelStats {
  let finite = 0
  let min = Infinity
  let max = -Infinity
  let mean = 0
  let m2 = 0
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    finite += 1
    if (v < min) min = v
    if (v > max) max = v
    // Welford's online update: stable for large offsets (e.g. absolute times, positions in metres).
    const delta = v - mean
    mean += delta / finite
    m2 += delta * (v - mean)
  }
  if (finite === 0) return { min: NaN, max: NaN, mean: NaN, std: NaN, finite: 0, constant: true }
  return {
    min,
    max,
    mean,
    std: finite > 1 ? Math.sqrt(m2 / (finite - 1)) : 0,
    finite,
    constant: min === max,
  }
}
