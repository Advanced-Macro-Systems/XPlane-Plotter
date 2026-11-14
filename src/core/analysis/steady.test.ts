import { describe, expect, it } from 'vitest'
import { computeStats } from '../dataset'
import type { Channel, Dataset, Segment } from '../types'
import {
  STEADY_DEFAULTS,
  airspeedChannels,
  findSteadyWindows,
  localHalfWidth,
  powerKind,
  speedUnit,
  steadyChannels,
  steadyDefaults,
  type SteadyChannels,
  type SteadyOptions,
} from './steady'

// Synthetic flights only (no flight data): legs of steady holds and speed changes at 10 rows per second, with a fixed
// pseudo-random chop on the speed and the vertical speed.

interface Leg {
  /** Seconds */
  s: number
  /** Speed at the end of the leg (a change) or held (a hold), kt */
  kt: number
  vvi?: number
  bank?: number
}

interface Flight {
  t: number[]
  kias: number[]
  vvi: number[]
  alt: number[]
  roll: number[]
  /** The holds' time windows and speeds (legs whose speed equals the previous leg's end) */
  holds: { from: number; to: number; kt: number }[]
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32 - 0.5
  }
}

function fly(start: number, legs: readonly Leg[], opts: { rate?: number; chop?: number; vviChop?: number; seed?: number } = {}): Flight {
  const rate = opts.rate ?? 10
  const chop = opts.chop ?? 0.15
  const vviChop = opts.vviChop ?? 15
  const next = random(opts.seed ?? 7)
  const f: Flight = { t: [], kias: [], vvi: [], alt: [], roll: [], holds: [] }
  let time = 0
  let speed = start
  let altitude = 10_000
  let gust = 0
  for (const leg of legs) {
    const rows = Math.round(leg.s * rate)
    const from = speed
    if (leg.kt === from) f.holds.push({ from: time, to: time + leg.s, kt: leg.kt })
    for (let k = 0; k < rows; k += 1) {
      const u = (k + 1) / rows
      speed = from + (leg.kt - from) * u
      // Smooth chop: a low-pass of white noise, so it wanders the way turbulence does.
      gust = 0.9 * gust + 0.1 * next() * 2 * chop * 4
      const vvi = (leg.vvi ?? 0) + next() * 2 * vviChop
      altitude += (vvi / 60) / rate
      f.t.push(time)
      f.kias.push(speed + gust + next() * chop)
      f.vvi.push(vvi)
      f.alt.push(altitude)
      f.roll.push((leg.bank ?? 0) + next() * 0.4)
      time += 1 / rate
    }
  }
  return f
}

function channel(id: string, values: readonly number[], unit: string, label = id): Channel {
  const v = Float64Array.from(values)
  return {
    id,
    token: id,
    occurrence: 1,
    column: 0,
    meta: { label, short: label, unit, quantity: 'other', group: 'other', known: false },
    values: v,
    stats: computeStats(v),
  }
}

function dataset(f: Flight, segments?: Segment[], channels?: Channel[]): Dataset {
  const n = f.t.length
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 1000,
    format: 'xplane',
    rowCount: n,
    channels: channels ?? [
      channel('_Vind,_kias', f.kias, 'kt', 'KIAS'),
      channel('__VVI,__fpm', f.vvi, 'fpm', 'VS'),
      channel('p-alt,ftMSL', f.alt, 'ft', 'PA'),
      channel('_roll,__deg', f.roll, 'deg', 'Bank'),
    ],
    timeSourceId: null,
    elapsed: Float64Array.from(f.t),
    segments: segments ?? [{ start: 0, end: n, reason: 'start' }],
    sampleRateHz: 10,
    warnings: [],
    signature: 'sig',
    loadedAt: 0,
  }
}

const OPTIONS: SteadyOptions = steadyDefaults('kt')

function search(ds: Dataset, patch: Partial<SteadyOptions> = {}, speedId?: string) {
  const channels = steadyChannels(ds, speedId) as SteadyChannels
  return findSteadyWindows(ds, channels, { ...OPTIONS, ...patch })
}

/** A test card: four holds of 50 s at 250, 240, 230, 220 kt, each reached by a 20 kt/min deceleration. */
const CARD: Leg[] = [
  { s: 50, kt: 250 },
  { s: 30, kt: 240, vvi: -60 },
  { s: 50, kt: 240 },
  { s: 30, kt: 230, vvi: -60 },
  { s: 50, kt: 230 },
  { s: 30, kt: 220, vvi: -60 },
  { s: 50, kt: 220 },
]

describe('findSteadyWindows', () => {
  it('finds every hold of a test card, at its speed, inside the hold', () => {
    const f = fly(250, CARD)
    const ds = dataset(f)
    const found = search(ds)
    expect(found.map((w) => Math.round(w.speed.mean))).toEqual([250, 240, 230, 220])
    found.forEach((w, i) => {
      const hold = f.holds[i]
      expect(Math.abs(w.speed.mean - hold.kt)).toBeLessThan(0.3)
      // The stable core: the hold, give or take a second at either end (the speed moves 0.3 kt in the first second of
      // a deceleration, less than the chop), and not more than a few seconds short of it.
      expect(ds.elapsed[w.start]).toBeGreaterThanOrEqual(hold.from - 1.5)
      expect(ds.elapsed[w.end - 1]).toBeLessThanOrEqual(hold.to + 1.5)
      expect(w.seconds).toBeGreaterThan(hold.to - hold.from - 10)
      expect(w.vvi && Math.abs(w.vvi.mean)).toBeLessThan(10)
      expect(Math.abs(w.altDrift)).toBeLessThan(20)
      expect(Math.abs(w.bank)).toBeLessThan(0.5)
    })
  })

  it('never takes in the deceleration before a hold (trimmed to the stable core)', () => {
    // A slow, asymptotic settle: the last knot comes off over 8 s.
    const legs: Leg[] = [
      { s: 40, kt: 260 },
      { s: 20, kt: 245 },
      { s: 8, kt: 244 },
      { s: 60, kt: 244 },
    ]
    const f = fly(260, legs, { chop: 0.05 })
    const found = search(dataset(f))
    const last = found.at(-1)
    expect(last).toBeDefined()
    if (!last) return
    expect(f.t[last.start]).toBeGreaterThan(60 - 0.5)
    expect(Math.abs(last.speed.mean - 244)).toBeLessThan(0.15)
  })

  it('needs the minimum duration', () => {
    const f = fly(200, [
      { s: 15, kt: 200 },
      { s: 20, kt: 180 },
      { s: 40, kt: 180 },
    ])
    const ds = dataset(f)
    expect(search(ds).map((w) => Math.round(w.speed.mean))).toEqual([180])
    expect(search(ds, { minDuration: 10 }).map((w) => Math.round(w.speed.mean))).toEqual([200, 180])
    expect(search(ds, { minDuration: 45 })).toEqual([])
  })

  it('leaves out climbs, descents and turns at a steady speed', () => {
    const f = fly(150, [
      { s: 60, kt: 150, vvi: 600 },
      { s: 60, kt: 150, vvi: -400 },
      { s: 60, kt: 150, bank: 25 },
      { s: 60, kt: 150 },
    ])
    const ds = dataset(f)
    const found = search(ds)
    expect(found).toHaveLength(1)
    expect(ds.elapsed[found[0].start]).toBeGreaterThanOrEqual(179)
    // Turns count once the bank check is off.
    expect(search(ds, { bankTol: null }).some((w) => ds.elapsed[w.start] < 170)).toBe(true)
  })

  it('leaves out a phugoid: the speed swings with the vertical speed', () => {
    const rate = 10
    const t: number[] = []
    const kias: number[] = []
    const vvi: number[] = []
    const alt: number[] = []
    const roll: number[] = []
    const w = (2 * Math.PI) / 60
    for (let i = 0; i < 240 * rate; i += 1) {
      const s = i / rate
      const decay = Math.exp(-0.004 * s)
      t.push(s)
      kias.push(220 + 6 * decay * Math.cos(w * s))
      alt.push(10_000 - 120 * decay * Math.cos(w * s))
      vvi.push(120 * 60 * w * decay * Math.sin(w * s))
      roll.push(0)
    }
    expect(search(dataset({ t, kias, vvi, alt, roll, holds: [] }))).toEqual([])
  })

  it('ignores the ground: nothing slower than the floor', () => {
    const f = fly(0, [
      { s: 60, kt: 0 },
      { s: 60, kt: 30 },
      { s: 60, kt: 30 },
    ])
    expect(search(dataset(f))).toEqual([])
    expect(search(dataset(f), { floor: 20 }).map((w) => Math.round(w.speed.mean))).toEqual([30])
  })

  it('never crosses a reset or a gap', () => {
    const f = fly(200, [{ s: 120, kt: 200 }])
    const cut = 600
    const segments: Segment[] = [
      { start: 0, end: cut, reason: 'start' },
      { start: cut, end: f.t.length, reason: 'reset' },
    ]
    const found = search(dataset(f, segments))
    expect(found).toHaveLength(2)
    expect(found[0].end).toBeLessThanOrEqual(cut)
    expect(found[1].start).toBeGreaterThanOrEqual(cut)
  })

  it('searches only the rows asked for', () => {
    const f = fly(250, CARD)
    const ds = dataset(f)
    const rows = [Math.round(70 * 10), Math.round(150 * 10)] as const
    const found = search(ds, { range: rows })
    expect(found.map((w) => Math.round(w.speed.mean))).toEqual([240])
    expect(found[0].start).toBeGreaterThanOrEqual(rows[0])
    expect(found[0].end).toBeLessThanOrEqual(rows[1])
  })

  it('gives each window’s first and last time on the time base asked for', () => {
    const f = fly(250, CARD)
    const ds = dataset(f)
    const [first] = search(ds)
    expect(first.from).toBe(ds.elapsed[first.start])
    expect(first.to).toBe(ds.elapsed[first.end - 1])
    const clock = ds.elapsed.map((t) => t + 1000)
    const [other] = search(ds, { time: clock })
    expect([other.from, other.to]).toEqual([clock[first.start], clock[first.end - 1]])
  })

  it('holds the speed within the tolerance: a drift beyond it shortens the window', () => {
    // 4 kt/min for 90 s: 6 kt in all; the trend across a window may move it 2 kt at most.
    const f = fly(200, [{ s: 90, kt: 206 }], { chop: 0.05 })
    const found = search(dataset(f))
    expect(found).toHaveLength(1)
    expect(Math.abs(found[0].speed.drift)).toBeCloseTo(4, 0)
    expect((Math.abs(found[0].speed.drift) * found[0].seconds) / 60).toBeLessThanOrEqual(2.001)
    // Twice the tolerance, twice the time (4 kt at 4 kt/min); with 7 kt the whole leg is one window.
    expect(search(dataset(f), { speedTol: 4 })[0].seconds).toBeGreaterThan(55)
    expect(search(dataset(f), { speedTol: 4 })[0].seconds).toBeLessThanOrEqual(60.1)
    expect(search(dataset(f), { speedTol: 7 })[0].seconds).toBeGreaterThan(80)
  })

  it('keeps the whole of a steady drift within the tolerance (its ends lie on its trend, nothing to trim)', () => {
    const f = fly(200, [{ s: 50, kt: 201.6 }], { chop: 0.05 })
    const found = search(dataset(f))
    expect(found).toHaveLength(1)
    expect(found[0].seconds).toBeGreaterThan(47)
  })

  it('finds one window for one drifting hold (not one per stretch of it)', () => {
    // Settles from 222 to 225 kt at 4 kt/min, then holds: one hold, one window.
    const f = fly(222, [
      { s: 45, kt: 225 },
      { s: 60, kt: 225.5 },
    ])
    const found = search(dataset(f))
    expect(found).toHaveLength(1)
    expect(found[0].speed.mean).toBeGreaterThan(224)
  })

  it('keeps one window for a hold that a short blip of vertical speed interrupted', () => {
    const f = fly(230, [
      { s: 40, kt: 230 },
      { s: 4, kt: 230, vvi: 900 },
      { s: 40, kt: 230 },
    ])
    const found = search(dataset(f))
    expect(found).toHaveLength(1)
    expect(found[0].seconds).toBeGreaterThan(70)
  })

  it('judges the altitude drift when there is no vertical speed', () => {
    const f = fly(120, [
      { s: 60, kt: 120, vvi: 500 },
      { s: 60, kt: 120 },
    ])
    const ds = dataset(f, undefined, [channel('_Vind,_kias', f.kias, 'kt', 'KIAS'), channel('p-alt,ftMSL', f.alt, 'ft', 'PA')])
    const found = search(ds)
    expect(found).toHaveLength(1)
    expect(found[0].vvi).toBeNull()
    expect(ds.elapsed[found[0].start]).toBeGreaterThanOrEqual(55)
    expect(Math.abs(found[0].altDrift)).toBeLessThan(20)
  })

  it('copes with missing samples and without the optional channels', () => {
    const f = fly(250, CARD)
    const kias = f.kias.map((v, i) => (i % 37 === 0 ? NaN : v))
    const ds = dataset(f, undefined, [channel('_Vind,_kias', kias, 'kt', 'KIAS')])
    const found = search(ds)
    expect(found.map((w) => Math.round(w.speed.mean))).toEqual([250, 240, 230, 220])
    expect(found[0].vvi).toBeNull()
    expect(found[0].altDrift).toBeNaN()
    expect(found[0].bank).toBeNaN()
  })

  it('gives nothing for a tolerance of zero or too few rows', () => {
    const ds = dataset(fly(250, CARD))
    expect(search(ds, { speedTol: 0 })).toEqual([])
    expect(search(ds, { range: [10, 12] })).toEqual([])
  })

  it('tells holds a few knots apart by the deceleration between them', () => {
    // 4 kt steps, 0.2 kt/s decelerations: one run of candidate rows from 148 down to 128 kt.
    const legs: Leg[] = [{ s: 45, kt: 148 }]
    for (let kt = 144; kt >= 128; kt -= 4) legs.push({ s: 20, kt }, { s: 45, kt })
    const found = search(dataset(fly(148, legs, { chop: 0.1 })))
    expect(found.map((w) => Math.round(w.speed.mean))).toEqual([148, 144, 140, 136, 132, 128])
    // 5 kt steps at a 3 kt tolerance.
    const wide: Leg[] = [{ s: 45, kt: 155 }]
    for (let kt = 150; kt >= 130; kt -= 5) wide.push({ s: 20, kt }, { s: 45, kt })
    expect(search(dataset(fly(155, wide, { chop: 0.1 })), { speedTol: 3 }).map((w) => Math.round(w.speed.mean))).toEqual([
      155, 150, 145, 140, 135, 130,
    ])
  })

  it('keeps both of two holds close together when the stretch across them does not pass', () => {
    // 6 kt apart, 10 s between them: within twice a 4 kt tolerance, yet two holds.
    const f = fly(146, [
      { s: 60, kt: 146 },
      { s: 10, kt: 140 },
      { s: 60, kt: 140 },
    ])
    expect(search(dataset(f), { speedTol: 4 }).map((w) => Math.round(w.speed.mean))).toEqual([146, 140])
  })

  it('searches 200,000 rows in well under a second', () => {
    const legs: Leg[] = []
    for (let k = 0; k < 40; k += 1) legs.push({ s: 25, kt: 300 - 5 * (k + 1), vvi: -50 }, { s: 25, kt: 300 - 5 * (k + 1) })
    const f = fly(300, legs, { rate: 100 })
    const ds = dataset(f)
    expect(ds.rowCount).toBe(200_000)
    const t0 = performance.now()
    const found = search(ds)
    const ms = performance.now() - t0
    expect(found.length).toBeGreaterThanOrEqual(38)
    expect(ms).toBeLessThan(1000)
  })

  it('cuts one long run into hundreds of holds without searching it over and over', () => {
    // 5.5 hours of cruise whose speed swings ± 2.5 kt every 90 s: one run, a hold at every crest and trough.
    const f = shaped(20_000, (s) => 250 + 2.5 * Math.sin((2 * Math.PI * s) / 90), { chop: 0.05 })
    const ds = shapedDataset(f)
    expect(ds.rowCount).toBe(200_000)
    const t0 = performance.now()
    const found = search(ds)
    const ms = performance.now() - t0
    expect(found.length).toBeGreaterThan(400)
    expect(ms).toBeLessThan(1000)
  })
})

/** A flight from functions of time at 10 rows per second: speed, and optionally vertical speed, bank and throttle. */
function shaped(
  seconds: number,
  speedAt: (s: number) => number,
  opts: { vvi?: (s: number) => number; bank?: (s: number) => number; throttle?: (s: number) => number; chop?: number } = {},
) {
  const next = random(11)
  const f = { t: [] as number[], kias: [] as number[], vvi: [] as number[], alt: [] as number[], roll: [] as number[], thr: [] as number[] }
  let altitude = 10_000
  for (let i = 0; i < seconds * 10; i += 1) {
    const s = i / 10
    const vvi = (opts.vvi?.(s) ?? 0) + next() * 20
    altitude += vvi / 600
    f.t.push(s)
    f.kias.push(speedAt(s) + next() * 2 * (opts.chop ?? 0.15))
    f.vvi.push(vvi)
    f.alt.push(altitude)
    f.roll.push((opts.bank?.(s) ?? 0) + next() * 0.4)
    f.thr.push(opts.throttle?.(s) ?? NaN)
  }
  return f
}

/** X-Plane's channels for a shaped flight (the throttle lever when it has one). */
function shapedDataset(f: ReturnType<typeof shaped>): Dataset {
  const channels = [
    channel('_Vind,_kias', f.kias, 'kt', 'KIAS'),
    channel('__VVI,__fpm', f.vvi, 'fpm', 'VS'),
    channel('p-alt,ftMSL', f.alt, 'ft', 'PA'),
    channel('_roll,__deg', f.roll, 'deg', 'Bank'),
  ]
  if (f.thr.some((v) => Number.isFinite(v))) channels.push(channel('thro1,handl', f.thr, '', 'Thr 1'))
  return dataset({ ...f, holds: [] }, undefined, channels)
}

describe('findSteadyWindows: power and lateral steadiness', () => {
  // Two holds flown the way a student flies them: the throttle hunts for 15 s after the speed arrives, then stays put,
  // and is pulled for the next point 5 s before the speed starts to fall.
  const throttleAt = (s: number) => {
    if (s < 15) return 0.6 + 0.07 * Math.sin((2 * Math.PI * s) / 4)
    if (s < 55) return 0.6
    if (s < 90) return 0.45
    if (s < 105) return 0.55 + 0.07 * Math.sin((2 * Math.PI * s) / 4)
    if (s < 145) return 0.55
    return 0.42
  }
  const speedAt = (s: number) => (s < 60 ? 250 : s < 90 ? 250 - (s - 60) / 3 : s < 150 ? 240 : 240 - (s - 150) / 3)
  const ds = shapedDataset(shaped(180, speedAt, { throttle: throttleAt }))

  it('keeps to the steady power: not the throttle still being set, nor its pull seconds before the speed falls', () => {
    const found = search(ds)
    expect(found.map((w) => Math.round(w.speed.mean))).toEqual([250, 240])
    const [first, second] = found
    // The throttle's swings die down into the band (± 3 % of its level) a second or so before they stop.
    expect(ds.elapsed[first.start]).toBeGreaterThanOrEqual(13)
    expect(ds.elapsed[first.end - 1]).toBeLessThanOrEqual(54.1)
    expect(ds.elapsed[second.start]).toBeGreaterThanOrEqual(103)
    expect(ds.elapsed[second.end - 1]).toBeLessThanOrEqual(144.1)
    expect(first.seconds).toBeGreaterThan(30)
    expect(first.power?.mean).toBeCloseTo(0.6, 2)
    expect(second.power?.mean).toBeCloseTo(0.55, 2)
    // On the speed alone the windows take in both, and the throttle scatters four times as much.
    const speedOnly = search(ds, { powerTol: null })
    expect(ds.elapsed[speedOnly[0].start]).toBeLessThan(10)
    expect(ds.elapsed[speedOnly[0].end - 1]).toBeGreaterThan(56)
    expect(first.power?.std ?? NaN).toBeLessThan((speedOnly[0].power?.std ?? 0) / 4)
  })

  it('reports the power setting of each window, and none without a power channel', () => {
    const plain = dataset(fly(250, CARD))
    expect(steadyChannels(plain)?.power).toBeNull()
    expect(search(plain)[0].power).toBeNull()
    const channels = steadyChannels(ds)
    expect(channels?.power?.id).toBe('thro1,handl')
    expect(powerKind(channels?.power as Channel)).toBe('Throttle')
  })

  it('leaves out a dutch roll: the bank swings though its mean stays level', () => {
    const rolling = shapedDataset(shaped(120, () => 230, { bank: (s) => 6 * Math.sin((2 * Math.PI * s) / 5) }))
    expect(search(rolling)).toEqual([])
    // Turbulence rocks the wings by a degree or so: still steady.
    const rocking = shapedDataset(shaped(120, () => 230, { bank: (s) => 1.2 * Math.sin((2 * Math.PI * s) / 7) }))
    expect(search(rocking)).toHaveLength(1)
    expect(search(rolling, { bankTol: null })).toHaveLength(1)
  })
})

describe('findSteadyWindows: CSV logs', () => {
  // A hold, a climb at a steady speed (1,000 fpm), a level turn (25° bank) and another hold, all at 230 kt.
  const legs: Leg[] = [
    { s: 60, kt: 230 },
    { s: 60, kt: 230, vvi: 1000 },
    { s: 40, kt: 230, bank: 25 },
    { s: 60, kt: 230 },
  ]
  const f = fly(230, legs)
  const metres = f.alt.map((ft) => ft / 3.28084)

  it('reads the vertical speed, altitude and bank of a CSV by unit and name, and a bare "KIAS" as knots', () => {
    const ds = dataset(f, undefined, [
      channel('KIAS', f.kias, '', 'KIAS'),
      channel('VS (fpm)', f.vvi, 'fpm', 'VS'),
      channel('Alt (m)', metres, 'm', 'Alt'),
      channel('Roll (deg)', f.roll, 'deg', 'Roll'),
      channel('Throttle (%)', f.kias.map((_, i) => (i < 1200 ? 62 : 75)), '%', 'Throttle'),
    ])
    const channels = steadyChannels(ds) as SteadyChannels
    expect([channels.speed.id, channels.vvi?.id, channels.altitude?.id, channels.bank?.id, channels.power?.id]).toEqual([
      'KIAS',
      'VS (fpm)',
      'Alt (m)',
      'Roll (deg)',
      'Throttle (%)',
    ])
    expect(speedUnit(channels.speed)).toBe('kt')
    const found = findSteadyWindows(ds, channels, OPTIONS)
    expect(found).toHaveLength(2)
    expect(ds.elapsed[found[0].end - 1]).toBeLessThanOrEqual(60.5)
    expect(ds.elapsed[found[1].start]).toBeGreaterThanOrEqual(159.5)
  })

  it('judges the climb by an altitude in metres when there is no vertical speed', () => {
    const ds = dataset(f, undefined, [channel('Airspeed (kt)', f.kias, 'kt', 'Airspeed'), channel('Altitude (m)', metres, 'm', 'Altitude')])
    const channels = steadyChannels(ds) as SteadyChannels
    expect(channels.vvi).toBeNull()
    expect(channels.altitude?.id).toBe('Altitude (m)')
    const found = findSteadyWindows(ds, channels, OPTIONS)
    expect(found.some((w) => ds.elapsed[w.start] < 115 && ds.elapsed[w.end - 1] > 65)).toBe(false)
    expect(Math.abs(found[0].altDrift)).toBeLessThan(20)
  })

  it('cannot check level flight with the speed alone', () => {
    const ds = dataset(f, undefined, [channel('Airspeed (kt)', f.kias, 'kt', 'Airspeed'), channel('Target alt (ft)', f.alt, 'ft', 'Target alt')])
    const channels = steadyChannels(ds) as SteadyChannels
    expect([channels.vvi, channels.altitude, channels.bank, channels.power]).toEqual([null, null, null, null])
  })
})

describe('steadyChannels and defaults', () => {
  it('prefers KIAS, then KEAS and KTAS; never ground or vertical speed', () => {
    const f = fly(200, [{ s: 10, kt: 200 }])
    const ds = dataset(f, undefined, [
      channel('Vtrue,_ktgs', f.kias, 'kt', 'Ground speed'),
      channel('Vtrue,_ktas', f.kias, 'kt', 'True airspeed'),
      channel('_Vind,_keas', f.kias, 'kt', 'Equivalent airspeed'),
      channel('__VVI,__fpm', f.vvi, 'fpm', 'Vertical speed'),
      channel('Airspeed (kt)', f.kias, 'kt', 'Airspeed'),
      channel('Wind speed (kt)', f.kias, 'kt', 'Wind speed'),
    ])
    expect(airspeedChannels(ds).map((c) => c.id)).toEqual(['_Vind,_keas', 'Vtrue,_ktas', 'Airspeed (kt)'])
    expect(steadyChannels(ds)?.speed.id).toBe('_Vind,_keas')
    expect(steadyChannels(ds, 'Vtrue,_ktas')?.speed.id).toBe('Vtrue,_ktas')
    expect(steadyChannels(ds, 'Vtrue,_ktgs')?.speed.id).toBe('_Vind,_keas')
    expect(steadyChannels(ds)?.vvi?.id).toBe('__VVI,__fpm')
    expect(steadyChannels(dataset(f, undefined, [channel('Vtrue,_ktgs', f.kias, 'kt', 'Ground speed')]))).toBeNull()
  })

  it('sets its defaults in the speed’s own unit', () => {
    expect(steadyDefaults('kt')).toEqual({ speedTol: 2, vviTol: 100, minDuration: 20, bankTol: 5, powerTol: 3, floor: 40 })
    expect(speedUnit({ meta: { unit: 'mph' } as Channel['meta'] })).toBe('mph')
    expect(speedUnit({ meta: { unit: '' } as Channel['meta'] })).toBe('kt')
    expect(steadyDefaults('mph').speedTol).toBeCloseTo(2.3, 5)
    expect(steadyDefaults('m/s').speedTol).toBeCloseTo(1, 5)
    expect(steadyDefaults('m/s').floor).toBeCloseTo(40 * 0.514444, 3)
    expect(STEADY_DEFAULTS.minDuration).toBe(20)
    expect(localHalfWidth(20)).toBe(5)
    expect(localHalfWidth(4)).toBe(2)
    expect(localHalfWidth(120)).toBe(10)
  })
})
