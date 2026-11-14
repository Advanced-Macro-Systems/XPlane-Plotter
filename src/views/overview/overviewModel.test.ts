import { describe, expect, it } from 'vitest'
import { computeStats } from '../../core/dataset'
import type { Channel, ChannelMeta, Dataset, Segment, Workspace } from '../../core/types'
import {
  decimateBySegment,
  equalAspectRanges,
  formatRate,
  glancePanels,
  glanceTime,
  groundTrack,
  trackPlotBox,
  groupsShown,
  markerLegend,
  overviewFigures,
  plainChannels,
  pointBands,
  segmentMarkers,
  segmentSummary,
  toPairs,
} from './overviewModel'

function meta(label: string, unit: string, extra: Partial<ChannelMeta> = {}): ChannelMeta {
  return { label, short: label, unit, quantity: 'other', group: 'other', known: false, ...extra }
}

function channel(id: string, values: readonly number[], m: ChannelMeta, column = 0): Channel {
  const v = Float64Array.from(values)
  return { id, token: id.replace(/#\d+$/, ''), occurrence: 1, column, meta: m, values: v, stats: computeStats(v) }
}

function dataset(channels: Channel[], elapsed: readonly number[], extra: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 1000,
    format: 'xplane',
    rowCount: elapsed.length,
    channels,
    timeSourceId: channels[0]?.id ?? null,
    elapsed: Float64Array.from(elapsed),
    segments: [{ start: 0, end: elapsed.length, reason: 'start' }],
    sampleRateHz: 10,
    warnings: [],
    signature: 'sig',
    loadedAt: 0,
    ...extra,
  }
}

const ramp = (n: number, from = 0, step = 1) => Array.from({ length: n }, (_, i) => from + i * step)

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return {
    version: 1,
    timeBase: 'elapsed',
    panels: [],
    groups: [
      { id: 'g1', name: 'Trim', slot: 0 },
      { id: 'g2', name: 'Dynamic', slot: 3 },
    ],
    points: [],
    derived: [],
    xy: {
      x: null,
      ys: [],
      source: 'all',
      style: 'points',
      colorBy: 'series',
      fit: 'none',
      fitTarget: 'samples',
      showSamples: true,
      showMeans: true,
      title: '',
      xLabel: '',
      yLabel: '',
    },
    modes: { channelId: null, source: 'selection', model: 'oscillation', detrend: 'linear' },
    tracked: [],
    ...patch,
  }
}

describe('overviewFigures', () => {
  const time = channel('_totl,_time', ramp(6, 100, 0.1), meta('Sim time', 's', { known: true }))
  const kias = channel('_Vind,_kias', [200, 201, 202, 203, 204, 205], meta('KIAS', 'kt', { known: true }), 1)
  const empty = channel('empty,___lb', [9, 9, 9, 9, 9, 9], meta('empty', 'lb'), 2)
  const fx: Channel = { ...channel('fx:q', [1, 2, 3, 4, 5, 6], meta('q', 'Pa', { group: 'derived' }), -1), token: '', derived: { expression: 'x' } }
  const segments: Segment[] = [
    { start: 0, end: 2, reason: 'start' },
    { start: 2, end: 4, reason: 'reset' },
    { start: 4, end: 6, reason: 'gap' },
  ]
  const ds = dataset([time, kias, empty, fx], [0, 0.1, 0.2, 0.3, 0.4, 0.5], { segments })

  it('counts rows, channels, known and constant columns, formulas and segments', () => {
    const ws = workspace({
      points: [
        { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 2 },
        { id: 't2', name: 'B', groupId: 'g1', start: 2, end: 4 },
      ],
    })
    expect(overviewFigures(ds, ws)).toEqual({
      durationS: 0.5,
      rows: 6,
      rateHz: 10,
      channels: 4,
      fileChannels: 3,
      known: 2,
      constant: 1,
      formulas: 1,
      segments: 3,
      resets: 1,
      gaps: 1,
      points: 2,
      groupsUsed: 1,
    })
    expect(overviewFigures(ds, null).points).toBe(0)
  })

  it('summarises segments and rates', () => {
    expect(segmentSummary({ resets: 0, gaps: 0 })).toBe('continuous time')
    expect(segmentSummary({ resets: 1, gaps: 0 })).toBe('1 reset')
    expect(segmentSummary({ resets: 2, gaps: 3 })).toBe('2 resets · 3 gaps')
    expect(formatRate(10)).toBe('10 Hz')
    expect(formatRate(9.9834)).toBe('9.98 Hz')
    expect(formatRate(Number.NaN)).toBe('—')
  })

  it('folds a long list of channel groups, but never just a few', () => {
    expect(groupsShown(47, false)).toBe(18)
    expect(groupsShown(47, true)).toBe(47)
    expect(groupsShown(22, false)).toBe(22)
    expect(groupsShown(23, false)).toBe(18)
    expect(groupsShown(3, false)).toBe(3)
    expect(groupsShown(0, false)).toBe(0)
  })

  it('plots against row numbers when the file has no time column', () => {
    expect(glanceTime({ timeSourceId: '_totl,_time' })).toEqual({
      base: 'elapsed',
      axisName: 'Elapsed time [s]',
      against: 'elapsed time',
    })
    expect(glanceTime({ timeSourceId: null })).toEqual({ base: 'index', axisName: 'Row', against: 'row number' })
  })

  it('names the segment-boundary lines by what they are', () => {
    expect(markerLegend(1, 0)).toBe('Sim reset')
    expect(markerLegend(0, 1)).toBe('Recording gap')
    expect(markerLegend(3, 0)).toBe('3 sim resets')
    expect(markerLegend(0, 2)).toBe('2 recording gaps')
    expect(markerLegend(1, 2)).toBe('1 sim reset and 2 recording gaps')
    expect(markerLegend(2, 1)).toBe('2 sim resets and 1 recording gap')
    expect(markerLegend(0, 0)).toBe('')
  })
})

describe('glancePanels', () => {
  const n = 5
  const xplane = dataset(
    [
      channel('_totl,_time', ramp(n), meta('Sim time', 's')),
      channel('_Vind,_kias', ramp(n, 200), meta('Indicated airspeed', 'kt'), 1),
      channel('Vtrue,_ktas', ramp(n, 250), meta('True airspeed', 'kt'), 2),
      channel('___CG,ftMSL', ramp(n, 12000), meta('Altitude MSL', 'ft'), 3),
      channel('p-alt,ftMSL', ramp(n, 11900), meta('Pressure altitude', 'ft'), 4),
      channel('pitch,__deg', ramp(n, 2), meta('Pitch', 'deg'), 5),
      channel('_roll,__deg', ramp(n, -1), meta('Roll', 'deg'), 6),
    ],
    ramp(n),
  )

  it('shows altitude (pressure first), airspeed and attitude', () => {
    expect(glancePanels(xplane)).toEqual([
      { key: 'altitude', title: 'Pressure altitude', unit: 'ft', channelIds: ['p-alt,ftMSL'] },
      { key: 'airspeed', title: 'Airspeed', unit: 'kt', channelIds: ['_Vind,_kias', 'Vtrue,_ktas'] },
      { key: 'attitude', title: 'Attitude', unit: 'deg', channelIds: ['pitch,__deg', '_roll,__deg'] },
    ])
  })

  it('never mixes units in one panel, and uses the label for a one-channel panel', () => {
    const odd = dataset(
      [
        channel('_totl,_time', ramp(n), meta('Sim time', 's')),
        channel('_Vind,_kias', ramp(n, 200), meta('Indicated airspeed', 'kt'), 1),
        channel('Vtrue,_ktas', ramp(n, 120), meta('True airspeed', 'm/s'), 2),
      ],
      ramp(n),
    )
    expect(glancePanels(odd)).toEqual([{ key: 'airspeed', title: 'Indicated airspeed', unit: 'kt', channelIds: ['_Vind,_kias'] }])
  })

  it('falls back to the first plain channels (no time, no constants)', () => {
    const csv = dataset(
      [
        channel('time', ramp(n), meta('time', 's')),
        channel('flat', [1, 1, 1, 1, 1], meta('flat', ''), 1),
        channel('a', ramp(n), meta('a', 'm'), 2),
        channel('b', ramp(n, 3), meta('b', 'N'), 3),
        channel('c', ramp(n, 5), meta('c', ''), 4),
        channel('d', ramp(n, 7), meta('d', ''), 5),
      ],
      ramp(n),
      { format: 'csv' },
    )
    expect(plainChannels(csv).map((ch) => ch.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(glancePanels(csv).map((p) => [p.title, p.unit, p.channelIds])).toEqual([
      ['a', 'm', ['a']],
      ['b', 'N', ['b']],
      ['c', '', ['c']],
    ])
  })
})

describe('decimateBySegment', () => {
  const x = Float64Array.from(ramp(1000))
  const y = Float64Array.from(ramp(1000).map((v) => Math.sin(v / 20)))

  it('is plain LTTB for one segment', () => {
    const out = decimateBySegment(x, y, [{ start: 0, end: 1000, reason: 'start' }], 100)
    expect(out.x.length).toBe(100)
    expect(out.x[0]).toBe(0)
    expect(out.x[99]).toBe(999)
  })

  it('breaks the line between segments and keeps their ends', () => {
    const segments: Segment[] = [
      { start: 0, end: 600, reason: 'start' },
      { start: 600, end: 1000, reason: 'reset' },
    ]
    const out = decimateBySegment(x, y, segments, 100)
    const breaks = Array.from(out.y).flatMap((v, i) => (Number.isNaN(v) ? [i] : []))
    expect(breaks).toHaveLength(1)
    const at = breaks[0]
    expect(out.x[at - 1]).toBe(599)
    expect(out.x[at]).toBe(600)
    expect(out.x[at + 1]).toBe(600)
    expect(out.x.length).toBeLessThanOrEqual(102)
  })

  it('turns pairs with missing values into line breaks', () => {
    expect(toPairs([0, 1, 2], [5, Number.NaN, 7])).toEqual([
      [0, 5],
      [1, null],
      [2, 7],
    ])
  })
})

describe('segment markers and test-point bands', () => {
  const ds = dataset([channel('_totl,_time', ramp(10), meta('Sim time', 's'))], ramp(10, 0, 0.5), {
    segments: [
      { start: 0, end: 4, reason: 'start' },
      { start: 4, end: 7, reason: 'reset' },
      { start: 7, end: 10, reason: 'gap' },
    ],
  })

  it('marks each boundary at its elapsed time', () => {
    expect(segmentMarkers(ds)).toEqual([
      { x: 2, reason: 'reset' },
      { x: 3.5, reason: 'gap' },
    ])
  })

  it('bands visible points from their first to last row', () => {
    const ws = workspace({
      points: [
        { id: 't1', name: 'A', groupId: 'g2', start: 2, end: 5 },
        { id: 't2', name: 'B', groupId: 'g1', start: 0, end: 1, hidden: true },
        { id: 't3', name: 'C', groupId: 'gone', start: 8, end: 20 },
      ],
    })
    expect(pointBands(ds, ws)).toEqual([
      { from: 1, to: 2 },
      { from: 4, to: 4.5 },
    ])
    expect(pointBands(ds, null)).toEqual([])
  })
})

describe('groundTrack', () => {
  it('is null without latitude and longitude', () => {
    expect(groundTrack(dataset([channel('_totl,_time', ramp(3), meta('t', 's'))], ramp(3)))).toBeNull()
  })

  it('draws the fixes in row order, breaking at missing fixes and sim resets', () => {
    const lat = [0, 51.4, 51.41, Number.NaN, 51.42, 51.43, 51.44]
    const lon = [0, -2.6, -2.59, -2.58, -2.57, -2.56, -2.55]
    const ds = dataset(
      [
        channel('_totl,_time', ramp(7), meta('t', 's')),
        channel('__lat,__deg', lat, meta('Latitude', 'deg'), 1),
        channel('__lon,__deg', lon, meta('Longitude', 'deg'), 2),
      ],
      ramp(7),
      {
        segments: [
          { start: 0, end: 5, reason: 'start' },
          { start: 5, end: 7, reason: 'reset' },
        ],
      },
    )
    const track = groundTrack(ds)
    expect(track).not.toBeNull()
    expect(track?.path).toEqual([
      [-2.6, 51.4],
      [-2.59, 51.41],
      [null, null],
      [-2.57, 51.42],
      [null, null],
      [-2.56, 51.43],
      [-2.55, 51.44],
    ])
    expect(track?.start).toEqual({ lon: -2.6, lat: 51.4, t: 1 })
    expect(track?.end).toEqual({ lon: -2.55, lat: 51.44, t: 6 })
    expect(track?.lonExtent).toEqual([-2.6, -2.55])
    expect(track?.latExtent).toEqual([51.4, 51.44])
  })

  it('keeps about maxPoints fixes and always the last one', () => {
    const n = 10_000
    const ds = dataset(
      [
        channel('_totl,_time', ramp(n), meta('t', 's')),
        channel('__lat,__deg', ramp(n, 50, 1e-5), meta('Latitude', 'deg'), 1),
        channel('__lon,__deg', ramp(n, 1, 1e-5), meta('Longitude', 'deg'), 2),
      ],
      ramp(n),
    )
    const track = groundTrack(ds, 500)
    expect(track?.path.length).toBeLessThanOrEqual(501)
    expect(track?.path.length).toBeGreaterThan(400)
    expect(track?.end.t).toBe(n - 1)
  })

  it('is null for an aircraft that never moves', () => {
    const ds = dataset(
      [
        channel('_totl,_time', ramp(3), meta('t', 's')),
        channel('__lat,__deg', [51, 51, 51], meta('Latitude', 'deg'), 1),
        channel('__lon,__deg', [-2, -2, -2], meta('Longitude', 'deg'), 2),
      ],
      ramp(3),
    )
    expect(groundTrack(ds)).toBeNull()
  })

  it('shows a parked stretch before a sim reload as one position and starts the track where it moves', () => {
    // Rows 0–3 parked at one spot (a few centimetres of jitter), then the reload puts the aircraft in flight elsewhere.
    const lat = [50, 50.0000001, 50, 50.0000001, 51.0, 51.01, 51.02, 51.03]
    const lon = [-1, -1, -1.0000001, -1, -2.0, -2.01, -2.02, -2.03]
    const ds = dataset(
      [
        channel('_totl,_time', ramp(8), meta('t', 's')),
        channel('__lat,__deg', lat, meta('Latitude', 'deg'), 1),
        channel('__lon,__deg', lon, meta('Longitude', 'deg'), 2),
      ],
      ramp(8),
      {
        segments: [
          { start: 0, end: 4, reason: 'start' },
          { start: 4, end: 8, reason: 'reset' },
        ],
      },
    )
    const track = groundTrack(ds)!
    expect(track.path.slice(0, 3)).toEqual([[-1, 50], [null, null], [-2, 51]])
    expect(track.path).toHaveLength(6)
    expect(track.start).toEqual({ lon: -2, lat: 51, t: 4 })
    expect(track.end).toEqual({ lon: -2.03, lat: 51.03, t: 7 })
    // The track starts after the reload: nothing moved before it, so that is the Start, not a restart.
    expect(track.restarts).toEqual([])
    // The parked position stays on the map.
    expect(track.latExtent[0]).toBe(50)
  })

  it('marks where the track picks up again after a recording gap', () => {
    const lat = [51.0, 51.01, 51.02, 51.2, 51.21, 51.22]
    const lon = [-2.0, -2.01, -2.02, -2.2, -2.21, -2.22]
    const ds = dataset(
      [
        channel('_totl,_time', ramp(6), meta('t', 's')),
        channel('__lat,__deg', lat, meta('Latitude', 'deg'), 1),
        channel('__lon,__deg', lon, meta('Longitude', 'deg'), 2),
      ],
      ramp(6),
      {
        segments: [
          { start: 0, end: 3, reason: 'start' },
          { start: 3, end: 6, reason: 'gap' },
        ],
      },
    )
    const track = groundTrack(ds)!
    expect(track.start).toEqual({ lon: -2, lat: 51, t: 0 })
    expect(track.restarts).toEqual([{ lon: -2.2, lat: 51.2, t: 3, reason: 'gap' }])
    expect(track.end).toEqual({ lon: -2.22, lat: 51.22, t: 5 })
    expect(track.path[3]).toEqual([null, null])
  })
})

describe('trackPlotBox', () => {
  const insets = { left: 66, right: 28, top: 22, bottom: 48 }

  it('makes the plot as tall as the track is long north–south, within limits', () => {
    // 400 km east–west by 100 km north–south in a 398 px card: the plot area is 304 px wide and 76 px would do, so 200.
    expect(trackPlotBox({ eastWest: 400, northSouth: 100 }, 398, insets).height).toBe(200)
    // Square-ish: as tall as wide (plus the margins).
    expect(trackPlotBox({ eastWest: 10, northSouth: 8 }, 398, insets).height).toBe(Math.round(304 * 0.8 + 70))
    // North–south or no east–west extent at all: the tallest box.
    expect(trackPlotBox({ eastWest: 1, northSouth: 50 }, 398, insets).height).toBe(420)
    expect(trackPlotBox({ eastWest: 0, northSouth: 5 }, 398, insets).height).toBe(420)
  })

  it('gives equalAspectRanges the plot area’s shape, so latitude spans about what the track needs', () => {
    const size = { eastWest: 400, northSouth: 100 }
    const box = trackPlotBox(size, 398, insets)
    expect(box.aspect).toBeCloseTo(304 / 130)
    // The latitude axis spans ~1.7× the track's north–south extent (it was ~4.5× in a 465 px box).
    const shown = (304 / box.aspect) * (400 / 304)
    expect(shown / size.northSouth).toBeLessThan(2)
    expect(trackPlotBox(size, 0, insets)).toEqual({ height: 300, aspect: 1 })
  })
})

describe('equalAspectRanges', () => {
  const span = (r: [number, number]) => r[1] - r[0]

  it('gives equal ground distance per pixel on both axes', () => {
    // At 60° a degree of longitude is half a degree of latitude.
    const r = equalAspectRanges([0, 2], [59.5, 60.5], 1, 0)
    expect(span(r.lon)).toBeCloseTo(2, 3)
    expect(span(r.lat)).toBeCloseTo(1, 3)
    expect((r.lon[0] + r.lon[1]) / 2).toBeCloseTo(1, 9)
    expect((r.lat[0] + r.lat[1]) / 2).toBeCloseTo(60, 9)
  })

  it('widens the short side to fill a wide or tall plot', () => {
    const wide = equalAspectRanges([0, 2], [59.5, 60.5], 2, 0)
    expect(span(wide.lon)).toBeCloseTo(4, 3)
    expect(span(wide.lat)).toBeCloseTo(1, 3)
    const tall = equalAspectRanges([0, 2], [59.5, 60.5], 0.5, 0)
    expect(span(tall.lon)).toBeCloseTo(2, 3)
    expect(span(tall.lat)).toBeCloseTo(2, 3)
  })

  it('pads, and never collapses to zero', () => {
    const padded = equalAspectRanges([0, 1], [-0.5, 0.5], 1, 0.1)
    expect(span(padded.lat)).toBeCloseTo(1.2, 6)
    const point = equalAspectRanges([5, 5], [10, 10], 1, 0)
    expect(span(point.lat)).toBeGreaterThan(0)
    expect(span(point.lon)).toBeGreaterThan(0)
    // An unusable aspect counts as square (cos 0.5° makes the longitude span a hair over 1°).
    const bad = equalAspectRanges([0, 1], [0, 1], Number.NaN, 0)
    expect(span(bad.lon)).toBeCloseTo(1 / Math.cos((0.5 * Math.PI) / 180), 9)
    expect(span(bad.lat)).toBeCloseTo(1, 9)
  })
})
