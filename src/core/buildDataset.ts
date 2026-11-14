// Turns a RawTable into a Dataset: channel ids (with #2 for repeats), meanings, stats, time source, elapsed time,
// segments, sample rate, warnings and the workspace signature.
// It reads the channel dictionary (core/channels, 230 kB), so the app loads this module on demand (store/app.ts
// loadDatasetBuilder): the start page never waits for the dictionary. The light helpers (channelById, computeStats,
// fnv1a32) stay in dataset.ts.
// OWNER: parser agent.

import type { Channel, Dataset, Segment } from './types'
import type { RawTable } from './parse'
import { describeHeader } from './channels/header'
import { computeStats, fnv1a32 } from './dataset'
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
    // X-Plane rows are skipped for their cell count, or for being a stray line of text (a typed note, garbled bytes).
    const why =
      raw.format === 'xplane' ? 'wrong number of values, or a line of text' : 'wrong number of values, or no numbers'
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
    // The parser worker sends the stats with the columns (one pass over every value, off the main thread).
    const stats = raw.stats?.length === raw.columns.length ? raw.stats[column] : computeStats(values)
    return { id, token, occurrence, column, meta: metas[column], values, stats }
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
