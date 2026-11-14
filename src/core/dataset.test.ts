import { describe, expect, it } from 'vitest'
import { describeChannel } from './channels'
import { buildDataset, channelById, computeStats, fnv1a32 } from './dataset'
import { parseText, type RawTable } from './parse'
import { XPLANE_737_TEXT, xplaneText } from './parse/fixtures'

function raw(headers: string[], rows: number[][], extra: Partial<RawTable> = {}): RawTable {
  return {
    format: 'xplane',
    headers,
    columns: headers.map((_, c) => Float64Array.from(rows.map((row) => row[c]))),
    rowCount: rows.length,
    skippedRows: 0,
    warnings: [],
    ...extra,
  }
}

const source = { name: 'Data.txt', size: 1234 }

/** Sim time at 10 Hz with the given breaks: { row: newTimeValue }. */
function simTime(rows: number, breaks: Record<number, number> = {}): number[] {
  const values: number[] = []
  let t = 0
  for (let i = 0; i < rows; i += 1) {
    if (i in breaks) t = breaks[i]
    else if (i > 0) t += 0.1
    values.push(Math.round(t * 1e5) / 1e5)
  }
  return values
}

describe('buildDataset', () => {
  it('makes one channel per column, with #2 / #3 ids for repeated tokens', () => {
    const table = raw(['a,_x', 'b,_y', 'a,_x', 'a,_x'], [[1, 2, 3, 4], [5, 6, 7, 8]])
    const ds = buildDataset(table, source)
    expect(ds.channels.map((ch) => [ch.id, ch.token, ch.occurrence, ch.column])).toEqual([
      ['a,_x', 'a,_x', 1, 0],
      ['b,_y', 'b,_y', 1, 1],
      ['a,_x#2', 'a,_x', 2, 2],
      ['a,_x#3', 'a,_x', 3, 3],
    ])
    ds.channels.forEach((ch, c) => {
      expect(ch.values).toBe(table.columns[c]) // shared, not copied
      expect(ch.stats).toEqual(computeStats(table.columns[c]))
      expect(ch.meta).toEqual(describeChannel(ch.token, ch.occurrence))
      expect(ch.derived).toBeUndefined()
    })
    expect(channelById(ds, 'a,_x#3')?.column).toBe(3)
  })

  it('keeps ids unique even when a header already looks like "token#2"', () => {
    const ds = buildDataset(raw(['a', 'a#2', 'a'], [[1, 2, 3]], { format: 'csv' }), source)
    const ids = ds.channels.map((ch) => ch.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids.slice(0, 2)).toEqual(['a', 'a#2'])
  })

  it('reads the real 737 columns: 11 repeated tokens get #2 ids', () => {
    const ds = buildDataset(parseText(XPLANE_737_TEXT), source)
    expect(ds.channels).toHaveLength(173)
    expect(new Set(ds.channels.map((ch) => ch.id)).size).toBe(173)
    expect(ds.channels.filter((ch) => ch.id.endsWith('#2'))).toHaveLength(11)
    expect(channelById(ds, 'elev1,__deg#2')?.occurrence).toBe(2)
    expect(ds.format).toBe('xplane')
    expect(ds.timeSourceId).toBe('_totl,_time')
  })

  it('copies the basics: id "", name, size, format, rowCount, loadedAt', () => {
    const before = Date.now()
    const ds = buildDataset(raw(['_totl,_time'], [[0], [0.1]]), source)
    expect(ds).toMatchObject({ id: '', name: 'Data.txt', sizeBytes: 1234, format: 'xplane', rowCount: 2 })
    expect(ds.loadedAt).toBeGreaterThanOrEqual(before)
    expect(ds.loadedAt).toBeLessThanOrEqual(Date.now())
  })

  it('builds elapsed time, segments and sample rate from the preferred time column', () => {
    const totl = simTime(100)
    const real = totl.map((t) => 30 + t)
    const ds = buildDataset(raw(['_real,_time', '_totl,_time', 'v'], totl.map((t, i) => [real[i], t, i])), source)
    expect(ds.timeSourceId).toBe('_totl,_time')
    expect(ds.segments).toEqual([{ start: 0, end: 100, reason: 'start' }])
    expect(ds.sampleRateHz).toBeCloseTo(10, 6)
    expect(ds.elapsed[99]).toBeCloseTo(9.9, 9)
    expect(ds.warnings).toEqual([])
  })

  it('notes each reset and gap of the time source (like a flight reloaded mid-log)', () => {
    // At row 300 the sim reloads: sim time jumps 30 -> 900 s while mission time restarts at 0.05 s.
    const totl = simTime(400, { 0: 0.1, 300: 900 })
    const missn = simTime(400, { 0: 0.1, 300: 0.05 })
    expect(totl[299]).toBe(30)
    const rows = totl.map((t, i) => [t, missn[i]])
    const ds = buildDataset(raw(['_totl,_time', 'missn,_time'], rows), source)
    expect(ds.segments).toEqual([
      { start: 0, end: 300, reason: 'start' },
      { start: 300, end: 400, reason: 'gap' },
    ])
    expect(ds.warnings).toEqual(['Recording gap of 870.0 s at row 300.'])

    const resetOnly = buildDataset(raw(['missn,_time'], missn.map((t) => [t])), source)
    expect(resetOnly.timeSourceId).toBe('missn,_time')
    expect(resetOnly.warnings).toEqual(['Time resets at row 300 (a new flight was loaded?).'])
  })

  it('lists at most 5 time breaks, then summarises', () => {
    const breaks: Record<number, number> = {}
    for (let k = 1; k <= 8; k += 1) breaks[k * 20] = k % 2 === 0 ? 0 : 1000 * k
    const ds = buildDataset(raw(['_totl,_time'], simTime(200, breaks).map((t) => [t])), source)
    expect(ds.segments).toHaveLength(9)
    expect(ds.warnings).toHaveLength(6)
    expect(ds.warnings[0]).toMatch(/^Recording gap of [\d.]+ s at row 20\.$/)
    expect(ds.warnings[1]).toBe('Time resets at row 40 (a new flight was loaded?).')
    expect(ds.warnings[5]).toBe('…and 3 more time resets or gaps.')
  })

  it('puts parse warnings first, then the skipped-rows note', () => {
    const ds = buildDataset(
      raw(['_totl,_time'], [[0], [0.1]], { skippedRows: 3, warnings: ['The last line was incomplete and was skipped.'] }),
      source,
    )
    expect(ds.warnings).toEqual([
      'The last line was incomplete and was skipped.',
      'Skipped 3 unreadable rows (wrong number of values, or a line of text).',
    ])
    const csv = buildDataset(raw(['time'], [[0], [1]], { format: 'csv', skippedRows: 1 }), source)
    expect(csv.warnings).toEqual(['Skipped 1 unreadable row (wrong number of values, or no numbers).'])
  })

  it('falls back to row numbers when there is no time column', () => {
    const ds = buildDataset(parseText('alpha,beta\n1,2\n3,4\n5,6\n'), { name: 'a.csv', size: 20 })
    expect(ds.timeSourceId).toBeNull()
    expect(Array.from(ds.elapsed)).toEqual([0, 1, 2])
    expect(ds.segments).toEqual([{ start: 0, end: 3, reason: 'start' }])
    expect(ds.sampleRateHz).toBeNaN()
    expect(ds.warnings).toEqual(['No time column found; time is shown as row number.'])
  })

  it('accepts an empty table without throwing', () => {
    const ds = buildDataset(raw(['_totl,_time', 'v'], []), source)
    expect(ds.rowCount).toBe(0)
    expect(ds.elapsed).toHaveLength(0)
    expect(ds.segments).toEqual([])
  })

  it('uses the column stats the parser worker sent, and computes them when there are none (or not one per column)', () => {
    const rows = [
      [0, 5],
      [0.1, 7],
    ]
    const sent = [computeStats(Float64Array.of(0, 0.1)), { min: -1, max: 1, mean: 0, std: 1, finite: 2, constant: false }]
    expect(buildDataset(raw(['_totl,_time', 'v'], rows, { stats: sent }), source).channels[1].stats).toBe(sent[1])
    const computed = buildDataset(raw(['_totl,_time', 'v'], rows), source).channels[1].stats
    expect(computed).toEqual(computeStats(Float64Array.of(5, 7)))
    const short = buildDataset(raw(['_totl,_time', 'v'], rows, { stats: sent.slice(0, 1) }), source).channels[1].stats
    expect(short).toEqual(computed)
  })

  it('has a signature that is stable for the same file and changes with its content', () => {
    const text = xplaneText(
      ['_totl,_time', '_Vind,_kias'],
      simTime(50).map((t) => [t, 120]),
    )
    const a = buildDataset(parseText(text), source)
    const b = buildDataset(parseText(text), { name: 'renamed.txt', size: 99 })
    expect(a.signature).toMatch(/^[0-9a-f]{8}$/)
    expect(b.signature).toBe(a.signature)
    const fewerRows = xplaneText(['_totl,_time', '_Vind,_kias'], simTime(49).map((t) => [t, 120]))
    expect(buildDataset(parseText(fewerRows), source).signature).not.toBe(a.signature)
    const otherHeader = xplaneText(['_totl,_time', '_Vind,_keas'], simTime(50).map((t) => [t, 120]))
    expect(buildDataset(parseText(otherHeader), source).signature).not.toBe(a.signature)
    const shifted = xplaneText(['_totl,_time', '_Vind,_kias'], simTime(50).map((t) => [t + 5, 120]))
    expect(buildDataset(parseText(shifted), source).signature).not.toBe(a.signature)
  })

  it('fnv1a32 matches the reference FNV-1a values', () => {
    expect(fnv1a32('')).toBe('811c9dc5')
    expect(fnv1a32('a')).toBe('e40c292c')
    expect(fnv1a32('foobar')).toBe('bf9cf968')
  })
})
