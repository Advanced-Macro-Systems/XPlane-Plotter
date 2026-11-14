import { describe, expect, it } from 'vitest'
import { fitFirstOrder, fitOscillation } from '../analysis/modes'
import { buildDataset } from '../dataset'
import { parseText } from '../parse'
import {
  DEMO_AIRCRAFT,
  DEMO_DEFAULT_SEED,
  DEMO_DURATION_S,
  DEMO_EVENTS,
  DEMO_FILE_NAME,
  DEMO_MODES,
  DEMO_TOKENS,
  type DemoEvent,
  formatCell,
  generateDemoFlight,
} from './generateDemo'

/** The default demo, generated once for the whole file (about a quarter of a second). */
const TEXT = generateDemoFlight()

interface Log {
  lines: string[]
  tokens: string[]
  columns: Float64Array[]
  rows: number
}

/** A minimal X-Plane table reader, independent of core/parse, so the format itself is what gets tested. */
function readLog(text: string): Log {
  const lines = text.split('\r\n')
  const tokens = lines[1].split('|').slice(0, -1).map((cell) => cell.trim())
  // the file ends with CRLF, so the last split element is empty
  const dataLines = lines.slice(2, -1)
  const columns = tokens.map(() => new Float64Array(dataLines.length))
  dataLines.forEach((line, row) => {
    const cells = line.split('|')
    for (let c = 0; c < tokens.length; c += 1) columns[c][row] = Number(cells[c])
  })
  return { lines, tokens, columns, rows: dataLines.length }
}

const LOG = readLog(TEXT)

/** Values of a channel (first occurrence of the token unless asked otherwise) */
function col(token: string, occurrence = 1, log: Log = LOG): Float64Array {
  let seen = 0
  for (let c = 0; c < log.tokens.length; c += 1) {
    if (log.tokens[c] === token && (seen += 1) === occurrence) return log.columns[c]
  }
  throw new Error(`no column ${token} #${occurrence}`)
}

const TIME = col('_totl,_time')

/** Row range [i0, i1) covering times [start, end) */
function rows(start: number, end: number, time: Float64Array = TIME): [number, number] {
  let i0 = 0
  while (i0 < time.length && time[i0] < start) i0 += 1
  let i1 = i0
  while (i1 < time.length && time[i1] < end) i1 += 1
  return [i0, i1]
}

function mean(values: Float64Array, i0 = 0, i1 = values.length): number {
  let sum = 0
  for (let i = i0; i < i1; i += 1) sum += values[i]
  return sum / (i1 - i0)
}

function std(values: Float64Array, i0: number, i1: number): number {
  const m = mean(values, i0, i1)
  let sum = 0
  for (let i = i0; i < i1; i += 1) sum += (values[i] - m) ** 2
  return Math.sqrt(sum / (i1 - i0 - 1))
}

/** Least-squares line y = a + b·x */
function line(x: number[], y: number[]): { a: number; b: number } {
  const mx = x.reduce((s, v) => s + v, 0) / x.length
  const my = y.reduce((s, v) => s + v, 0) / y.length
  let sxy = 0
  let sxx = 0
  x.forEach((v, i) => {
    sxy += (v - mx) * (y[i] - my)
    sxx += (v - mx) ** 2
  })
  const b = sxy / sxx
  return { a: my - b * mx, b }
}

/** ISA density ratio and speed of sound (kt) at pressure altitude h (ft) */
function isa(hFt: number): { sigma: number; aKt: number } {
  const theta = 1 - (0.0019812 * hFt) / 288.15
  return { sigma: Math.pow(theta, 4.25588), aKt: 661.4786 * Math.sqrt(theta) }
}

const demoEvent = (id: string): DemoEvent => {
  const found = DEMO_EVENTS.find((e) => e.id === id)
  if (!found) throw new Error(`no event ${id}`)
  return found
}

describe('generateDemoFlight: X-Plane Data.txt format', () => {
  it('starts with a blank line, then a header of real X-Plane tokens right-aligned in 13 characters', () => {
    expect(LOG.lines[0]).toBe('')
    expect(LOG.tokens).toEqual([...DEMO_TOKENS])
    expect(LOG.lines[1]).toBe(DEMO_TOKENS.map((token) => token.padStart(13) + ' | ').join(''))
    expect(LOG.lines[1].startsWith('  _real,_time |   _totl,_time |')).toBe(true)
    for (const token of DEMO_TOKENS) expect(token).toMatch(/^[\w*/-]{5},[\w*/,-]{5}$/)
  })

  it('writes every row like printf("%13.5f | "), with the trailing "| " and CRLF line ends', () => {
    expect(TEXT.endsWith(' | \r\n')).toBe(true)
    expect(TEXT.includes('\n\n')).toBe(false)
    const cell = /^ *-?\d+\.\d{5}$/
    let badLines = 0
    let badCells = 0
    for (let r = 2; r < LOG.lines.length - 1; r += 1) {
      const cells = LOG.lines[r].split(' | ')
      // n cells, then the empty remainder after the trailing "| "
      if (cells.length !== DEMO_TOKENS.length + 1 || cells[cells.length - 1] !== '') badLines += 1
      for (let c = 0; c < cells.length - 1; c += 1) if (cells[c].length !== 13 || !cell.test(cells[c])) badCells += 1
    }
    expect(badLines).toBe(0)
    expect(badCells).toBe(0)
  })

  it('has a repeated token (left and right elevator) like real logs', () => {
    expect(DEMO_TOKENS.filter((token) => token === 'elev1,__deg')).toHaveLength(2)
    expect(mean(col('elev1,__deg', 2)) - mean(col('elev1,__deg', 1))).toBeCloseTo(0.04, 2)
  })

  it('is about 11.5 minutes at 10 Hz, 70–90 channels, under 10 MB', () => {
    expect(DEMO_TOKENS.length).toBeGreaterThanOrEqual(70)
    expect(DEMO_TOKENS.length).toBeLessThanOrEqual(90)
    expect(LOG.rows).toBe(DEMO_DURATION_S * 10 + 1)
    expect(DEMO_DURATION_S).toBeGreaterThanOrEqual(600)
    expect(DEMO_DURATION_S).toBeLessThanOrEqual(720)
    expect(TEXT.length).toBeLessThan(10_000_000)
    const nonFinite = LOG.columns.reduce((count, values) => count + values.filter((v) => !Number.isFinite(v)).length, 0)
    expect(nonFinite).toBe(0)
  })

  it('formats values the way X-Plane prints its 32-bit floats', () => {
    expect(formatCell(0)).toBe('      0.00000')
    expect(formatCell(12.5)).toBe('     12.50000')
    expect(formatCell(-3.25)).toBe('     -3.25000')
    expect(formatCell(1 / 3)).toBe('      0.33333')
    expect(formatCell(-0.000001)).toBe('     -0.00000')
    expect(formatCell(987329.1)).toBe(' 987329.12500')
    // wider than 13 characters: printf just overflows the field
    expect(formatCell(-16777217)).toBe('-16777216.00000')
  })

  it('samples at the requested rate, with times starting at 0 and only millisecond jitter', () => {
    const steps = TIME.slice(1).map((t, i) => t - TIME[i])
    expect(TIME[0]).toBe(0)
    expect(Math.min(...steps)).toBeGreaterThan(0.09)
    expect(Math.max(...steps)).toBeLessThan(0.11)
    expect(TIME[TIME.length - 1]).toBeCloseTo(DEMO_DURATION_S, 1)
    const slow = readLog(generateDemoFlight({ rateHz: 2 }))
    expect(slow.rows).toBe(DEMO_DURATION_S * 2 + 1)
    expect(slow.tokens).toEqual(LOG.tokens)
  })
})

describe('generateDemoFlight: determinism', () => {
  it('gives the same text for the same seed, and the default seed by default', () => {
    expect(generateDemoFlight({ seed: DEMO_DEFAULT_SEED })).toBe(TEXT)
    expect(generateDemoFlight({ seed: 1 })).toBe(generateDemoFlight({ seed: 1 }))
  })

  it('gives a different flight (same layout) for a different seed', () => {
    const other = generateDemoFlight({ seed: 2 })
    expect(other).not.toBe(TEXT)
    expect(other.length).toBe(TEXT.length)
    expect(readLog(other).tokens).toEqual(LOG.tokens)
  })
})

describe('generateDemoFlight: physics', () => {
  it('stays in a plausible envelope (speed, altitude, alpha, CL, Mach, load factor)', () => {
    const range = (token: string) => {
      const values = col(token)
      return [Math.min(...values), Math.max(...values)]
    }
    const [kiasMin, kiasMax] = range('_Vind,_kias')
    expect(kiasMin).toBeGreaterThan(195)
    expect(kiasMax).toBeLessThan(340)
    const [altMin, altMax] = range('p-alt,ftMSL')
    expect(altMin).toBeGreaterThan(11_500)
    expect(altMax).toBeLessThan(13_000)
    const [alphaMin, alphaMax] = range('alpha,__deg')
    expect(alphaMin).toBeGreaterThan(-1)
    expect(alphaMax).toBeLessThan(10)
    const [clMin, clMax] = range('___cl,total')
    expect(clMin).toBeGreaterThanOrEqual(0.2)
    expect(clMax).toBeLessThanOrEqual(1.2)
    expect(range('_Mach,ratio')[1]).toBeLessThan(0.65)
    const [nzMin, nzMax] = range('Gload,norml')
    expect(nzMin).toBeGreaterThan(0.7)
    expect(nzMax).toBeLessThan(1.4)
  })

  it('burns fuel monotonically and keeps total weight = empty + payload + fuel', () => {
    const fuel = col('_fuel,___lb')
    const total = col('total,___lb')
    let increases = 0
    for (let i = 1; i < fuel.length; i += 1) if (fuel[i] > fuel[i - 1]) increases += 1
    expect(increases).toBe(0)
    expect(fuel[0] - fuel[fuel.length - 1]).toBeGreaterThan(500)
    for (let i = 0; i < fuel.length; i += 97) {
      expect(total[i]).toBeCloseTo(DEMO_AIRCRAFT.emptyWeightLb + DEMO_AIRCRAFT.payloadLb + fuel[i], 1)
    }
  })

  it('keeps the air data consistent with ISA (KEAS = KTAS·√σ, Mach = KTAS/a, KIAS above KEAS)', () => {
    const kias = col('_Vind,_kias')
    const keas = col('_Vind,_keas')
    const ktas = col('Vtrue,_ktas')
    const mach = col('_Mach,ratio')
    const alt = col('p-alt,ftMSL')
    for (let i = 0; i < kias.length; i += 13) {
      const air = isa(alt[i])
      expect(Math.abs(keas[i] - ktas[i] * Math.sqrt(air.sigma))).toBeLessThan(0.05)
      expect(Math.abs(mach[i] - ktas[i] / air.aKt)).toBeLessThan(2e-4)
      expect(kias[i]).toBeGreaterThan(keas[i])
    }
  })

  it('ties the flight path together: VVI = TAS·sin(γ) and α = θ − γ with wings level', () => {
    const vvi = col('__VVI,__fpm')
    const ktas = col('Vtrue,_ktas')
    const vpath = col('vpath,__deg')
    const alpha = col('alpha,__deg')
    const pitch = col('pitch,__deg')
    const roll = col('_roll,__deg')
    const beta = col('_beta,__deg')
    const toRad = Math.PI / 180
    let level = 0
    let worstVvi = 0
    let worstAlpha = 0
    for (let i = 0; i < vvi.length; i += 1) {
      const expected = ktas[i] * 1.6878098571 * Math.sin(vpath[i] * toRad) * 60
      worstVvi = Math.max(worstVvi, Math.abs(vvi[i] - expected))
      if (Math.abs(roll[i]) < 1 && Math.abs(beta[i]) < 1) {
        level += 1
        worstAlpha = Math.max(worstAlpha, Math.abs(alpha[i] - (pitch[i] - vpath[i])))
      }
    }
    // tolerances: sensor noise (VVI 2.5 fpm, angles ~0.01°) and gusts in the airspeed
    expect(worstVvi).toBeLessThan(30)
    expect(level).toBeGreaterThan(5000)
    expect(worstAlpha).toBeLessThan(0.12)
  })

  it('derives CL from the load factor and lift/drag from the coefficients (parabolic polar)', () => {
    const cl = col('___cl,total')
    const cd = col('___cd,total')
    const lift = col('_lift,___lb')
    const drag = col('_drag,___lb')
    const ld = col('__L/D,_aero')
    const nz = col('Gload,norml')
    const weight = col('total,___lb')
    const keas = col('_Vind,_keas')
    const s = col('S-ref,ft*ft')
    const speedbrake = col('sbrak,postn')
    const flaps = col('_flap,postn')
    expect(s[0]).toBe(1341)
    for (let i = 0; i < cl.length; i += 7) {
      const q = (keas[i] * keas[i]) / 295.37 // dynamic pressure from EAS, lbf/ft²
      expect(Math.abs(cl[i] / ((nz[i] * weight[i]) / (q * 1341)) - 1)).toBeLessThan(0.01)
      expect(Math.abs(lift[i] / (cl[i] * q * 1341) - 1)).toBeLessThan(0.005)
      expect(Math.abs(drag[i] / (cd[i] * q * 1341) - 1)).toBeLessThan(0.005)
      expect(ld[i]).toBeCloseTo(lift[i] / drag[i], 3)
      if (speedbrake[i] === 0 && flaps[i] === 0) {
        expect(cd[i]).toBeCloseTo(DEMO_AIRCRAFT.cd0 + DEMO_AIRCRAFT.k * cl[i] * cl[i], 4)
      }
    }
  })

  it('runs the engines consistently: fuel flow ∝ thrust (TSFC ≈ 0.6), N1 tracks thrust', () => {
    for (const side of ['1', '2']) {
      const thrust = col(`thrst,_${side},lb`)
      const ff = col(`FF__${side},_lb/h`)
      const n1 = col(`N1__${side},_pcnt`)
      for (let i = 0; i < thrust.length; i += 11) {
        expect(ff[i] / thrust[i]).toBeGreaterThan(0.55)
        expect(ff[i] / thrust[i]).toBeLessThan(0.7)
      }
      // N1 rises with thrust: compare the means of the lowest and highest thrust quartiles
      const order = [...thrust.keys()].sort((a, b) => thrust[a] - thrust[b])
      const quarter = Math.floor(order.length / 4)
      const n1Low = order.slice(0, quarter).reduce((sum, i) => sum + n1[i], 0) / quarter
      const n1High = order.slice(-quarter).reduce((sum, i) => sum + n1[i], 0) / quarter
      expect(n1High - n1Low).toBeGreaterThan(10)
    }
  })

  it('integrates position from ground speed and track', () => {
    const distFt = col('_dist,___ft')
    const distNm = col('_dist,___nm')
    const gs = col('Vtrue,_ktgs')
    const vx = col('___vX,__m/s')
    const vz = col('___vZ,__m/s')
    const track = col('hpath,_true')
    let flown = 0
    for (let i = 1; i < distFt.length; i += 1) {
      expect(distFt[i]).toBeGreaterThanOrEqual(distFt[i - 1])
      flown += 0.5 * (gs[i] + gs[i - 1]) * 1.6878098571 * (TIME[i] - TIME[i - 1])
    }
    expect(flown / distFt[distFt.length - 1]).toBeCloseTo(1, 3)
    expect(distNm[distNm.length - 1] * 6076.12).toBeCloseTo(distFt[distFt.length - 1], -1)
    for (let i = 0; i < track.length; i += 17) {
      // X-Plane's local frame: x east, z south
      const fromVelocity = ((Math.atan2(vx[i], -vz[i]) * 180) / Math.PI + 360) % 360
      const diff = Math.abs(((fromVelocity - track[i] + 540) % 360) - 180)
      expect(diff).toBeLessThan(0.1)
    }
  })

  it('holds steady trim points whose elevator angle falls as CL rises (static stability)', () => {
    const trims = DEMO_EVENTS.filter((e) => e.kind === 'trim')
    expect(trims.length).toBeGreaterThanOrEqual(4)
    const kias = col('_Vind,_kias')
    const vvi = col('__VVI,__fpm')
    const cl = col('___cl,total')
    const cd = col('___cd,total')
    const elevator = col('elev1,__deg')
    const trim = col('_trim,_elev')
    const alpha = col('alpha,__deg')
    const points = trims.map((e) => {
      const [i0, i1] = rows(e.start, e.end)
      // 40 s at 10 Hz (frame jitter can move one sample across either edge)
      expect(i1 - i0).toBeGreaterThanOrEqual(398)
      expect(Math.abs(mean(kias, i0, i1) - (e.kias ?? 0))).toBeLessThan(1.5)
      expect(std(kias, i0, i1)).toBeLessThan(1.5)
      expect(Math.abs(mean(vvi, i0, i1))).toBeLessThan(60)
      return {
        cl: mean(cl, i0, i1),
        elevator: mean(elevator, i0, i1),
        trim: mean(trim, i0, i1),
        alpha: mean(alpha, i0, i1),
      }
    })
    const clValues = points.map((p) => p.cl)
    expect(Math.min(...clValues)).toBeLessThan(0.35)
    expect(Math.max(...clValues)).toBeGreaterThan(0.7)
    const elevatorSlope = line(clValues, points.map((p) => p.elevator)).b
    expect(elevatorSlope).toBeLessThan(-3.5)
    expect(elevatorSlope).toBeGreaterThan(-5)
    expect(line(clValues, points.map((p) => p.trim)).b).toBeGreaterThan(0)
    expect(line(clValues, points.map((p) => p.alpha)).b).toBeGreaterThan(0)

    // The drag polar through every steady sample gives back CD0 and k
    const x: number[] = []
    const y: number[] = []
    for (const e of trims) {
      const [i0, i1] = rows(e.start, e.end)
      for (let i = i0; i < i1; i += 1) {
        x.push(cl[i] * cl[i])
        y.push(cd[i])
      }
    }
    const polar = line(x, y)
    expect(polar.a).toBeCloseTo(DEMO_AIRCRAFT.cd0, 4)
    expect(polar.b).toBeCloseTo(DEMO_AIRCRAFT.k, 3)
  })
})

describe('DEMO_EVENTS', () => {
  it('fall inside the flight, in order, without overlapping', () => {
    const ids = new Set<string>()
    let previousEnd = 0
    for (const e of DEMO_EVENTS) {
      expect(ids.has(e.id)).toBe(false)
      ids.add(e.id)
      expect(e.start).toBeGreaterThanOrEqual(previousEnd)
      expect(e.end).toBeGreaterThan(e.start)
      expect(e.end).toBeLessThanOrEqual(DEMO_DURATION_S)
      previousEnd = e.end
      if (e.input) {
        expect(e.input.start).toBeGreaterThanOrEqual(e.start)
        expect(e.input.end).toBeLessThanOrEqual(e.end)
        expect(DEMO_TOKENS).toContain(e.input.channel)
      }
      if (e.response) {
        expect(e.response.start).toBeGreaterThanOrEqual(e.start)
        expect(e.response.end).toBeLessThanOrEqual(e.end)
        for (const channel of e.response.channels) expect(DEMO_TOKENS).toContain(channel)
      }
    }
    expect(TIME[TIME.length - 1]).toBeGreaterThanOrEqual(DEMO_EVENTS[DEMO_EVENTS.length - 1].end - 0.05)
  })

  it('publish the injected mode parameters', () => {
    expect(demoEvent('short-period').response).toMatchObject({ model: 'oscillation', ...DEMO_MODES.shortPeriod })
    expect(demoEvent('phugoid').response).toMatchObject({ model: 'oscillation', ...DEMO_MODES.phugoid })
    expect(demoEvent('dutch-roll').response).toMatchObject({ model: 'oscillation', ...DEMO_MODES.dutchRoll })
    expect(demoEvent('roll-subsidence').response).toMatchObject({ model: 'first-order', ...DEMO_MODES.rollSubsidence })
    const phugoid = demoEvent('phugoid').response
    expect((phugoid?.end ?? 0) - (phugoid?.start ?? 0)).toBeGreaterThanOrEqual(3 * DEMO_MODES.phugoid.periodS)
    expect(DEMO_MODES.shortPeriod.periodS).toBeGreaterThanOrEqual(3)
    expect(DEMO_MODES.shortPeriod.periodS).toBeLessThanOrEqual(4)
    expect(DEMO_MODES.phugoid.periodS).toBeGreaterThanOrEqual(55)
    expect(DEMO_MODES.phugoid.periodS).toBeLessThanOrEqual(65)
    expect(DEMO_MODES.dutchRoll.periodS).toBeGreaterThanOrEqual(5)
    expect(DEMO_MODES.dutchRoll.periodS).toBeLessThanOrEqual(6)
  })

  it('match the control inputs in the log', () => {
    const active = (token: string, threshold: number): [number, number] => {
      const values = col(token)
      let first = -1
      let last = -1
      for (let i = 0; i < values.length; i += 1) {
        if (Math.abs(values[i]) > threshold) {
          if (first < 0) first = i
          last = i
        }
      }
      return [TIME[first], TIME[last]]
    }
    // the pedals only move for the rudder doublet; the throttles only split for the differential-thrust test
    const pedals = active('ruddr,stick', 0.01)
    const doublet = demoEvent('dutch-roll').input
    expect(pedals[0]).toBeGreaterThanOrEqual(doublet?.start ?? NaN)
    expect(pedals[1]).toBeLessThanOrEqual(doublet?.end ?? NaN)
    const split = col('thro1,handl').map((v, i) => v - col('thro2,handl')[i])
    const [s0, s1] = rows(demoEvent('differential-thrust').start, demoEvent('differential-thrust').end)
    expect(Math.max(...split.slice(s0, s1))).toBeGreaterThan(0.3)
    expect(Math.max(...split.slice(0, s0).map(Math.abs))).toBeLessThan(0.01)
    // the elevator doublet and pulse move the stick by more than 1° of elevator
    const stick = col('_elev,stick')
    for (const id of ['short-period', 'phugoid']) {
      const input = demoEvent(id).input
      const [i0, i1] = rows(input?.start ?? 0, input?.end ?? 0)
      expect(Math.max(...stick.slice(i0, i1).map(Math.abs)) * DEMO_AIRCRAFT.elevatorDegPerRatio).toBeGreaterThan(1)
    }
  })
})

/**
 * parseText, buildDataset and the mode fits are written by other modules: the end-to-end checks below are skipped
 * while any of them is still a notImplemented() stub.
 */
function pipelineAvailable(): boolean {
  try {
    const mini = '\r\n  _totl,_time |   alpha,__deg | \r\n      0.00000 |       1.00000 | \r\n      0.10000 |       2.00000 | \r\n'
    buildDataset(parseText(mini), { name: 'mini.txt', size: mini.length })
    const t = Float64Array.from({ length: 60 }, (_, i) => i * 0.1)
    fitOscillation(t, t.map((v) => Math.exp(-0.2 * v) * Math.cos(2 * v)))
    fitFirstOrder(t, t.map((v) => Math.exp(-v)))
    return true
  } catch (error) {
    return !(error instanceof Error && /not implemented/i.test(error.message))
  }
}

describe('generateDemoFlight: end to end through the parser, the dataset and the mode fits', () => {
  const ready = pipelineAvailable()

  it.skipIf(!ready)('loads as one continuous segment whose elapsed time is the sim time DEMO_EVENTS use', () => {
    const dataset = buildDataset(parseText(TEXT), { name: DEMO_FILE_NAME, size: TEXT.length })
    expect(dataset.rowCount).toBe(LOG.rows)
    expect(dataset.timeSourceId).toBe('_totl,_time')
    expect(dataset.segments).toHaveLength(1)
    expect(dataset.warnings).toEqual([])
    expect(dataset.sampleRateHz).toBeCloseTo(10, 1)
    expect(dataset.channels.map((c) => c.id)).toContain('elev1,__deg#2')
    let worst = 0
    for (let i = 0; i < TIME.length; i += 1) worst = Math.max(worst, Math.abs(dataset.elapsed[i] - TIME[i]))
    expect(worst).toBeLessThan(1e-3)
  })

  /** The parsed demo as a Log (first occurrence of each token) */
  const parsed = (): Log => {
    const raw = parseText(TEXT)
    expect(raw.format).toBe('xplane')
    expect(raw.rowCount).toBe(LOG.rows)
    expect(raw.skippedRows).toBe(0)
    expect(raw.headers).toEqual([...DEMO_TOKENS])
    return { lines: [], tokens: raw.headers, columns: raw.columns, rows: raw.rowCount }
  }

  const responseWindow = (log: Log, token: string, id: string) => {
    const response = demoEvent(id).response
    const time = col('_totl,_time', 1, log)
    const [i0, i1] = rows(response?.start ?? 0, response?.end ?? 0, time)
    return { t: time.slice(i0, i1), y: col(token, 1, log).slice(i0, i1) }
  }

  const within = (value: number, expected: number, tolerance: number) =>
    expect(Math.abs(value / expected - 1)).toBeLessThan(tolerance)

  it.skipIf(!ready)('recovers the short period and the phugoid within 10%', () => {
    const log = parsed()
    const sp = responseWindow(log, 'alpha,__deg', 'short-period')
    const spFit = fitOscillation(sp.t, sp.y)
    expect(spFit.ok).toBe(true)
    within(spFit.periodS, DEMO_MODES.shortPeriod.periodS, 0.1)
    within(spFit.zeta, DEMO_MODES.shortPeriod.zeta, 0.1)

    const ph = responseWindow(log, 'Vtrue,_ktas', 'phugoid')
    const phFit = fitOscillation(ph.t, ph.y, { detrend: 'linear' })
    expect(phFit.ok).toBe(true)
    expect(phFit.cycles).toBeGreaterThanOrEqual(3)
    within(phFit.periodS, DEMO_MODES.phugoid.periodS, 0.1)
    within(phFit.zeta, DEMO_MODES.phugoid.zeta, 0.1)
  })

  it.skipIf(!ready)('recovers the dutch roll and the roll-subsidence time constant within 10%', () => {
    const log = parsed()
    const dr = responseWindow(log, '_beta,__deg', 'dutch-roll')
    const drFit = fitOscillation(dr.t, dr.y)
    expect(drFit.ok).toBe(true)
    within(drFit.periodS, DEMO_MODES.dutchRoll.periodS, 0.1)
    within(drFit.zeta, DEMO_MODES.dutchRoll.zeta, 0.1)

    const roll = responseWindow(log, '____P,deg/s', 'roll-subsidence')
    const rollFit = fitFirstOrder(roll.t, roll.y)
    expect(rollFit.ok).toBe(true)
    within(rollFit.tau, DEMO_MODES.rollSubsidence.tauS, 0.1)
  })
})
