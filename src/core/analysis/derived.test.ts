import { describe, expect, it } from 'vitest'
import { aliasForToken } from '../channels/alias'
import { computeStats } from '../dataset'
import type { Channel, Dataset, DerivedDef } from '../types'
import { availablePresets, slugify, withDerived, type DerivedPreset } from './derived'
import { compileExpression } from './expr'

/** A dataset as buildDataset would produce it (ids with #2 for repeats), without needing the parser. */
function makeDataset(columns: [token: string, values: number[]][], elapsed?: number[]): Dataset {
  const seen = new Map<string, number>()
  const channels: Channel[] = columns.map(([token, values], column) => {
    const occurrence = (seen.get(token) ?? 0) + 1
    seen.set(token, occurrence)
    const v = Float64Array.from(values)
    return {
      id: occurrence > 1 ? `${token}#${occurrence}` : token,
      token,
      occurrence,
      column,
      meta: { label: token, short: token, unit: '', quantity: 'other', group: 'other', known: false },
      values: v,
      stats: computeStats(v),
    }
  })
  const rowCount = columns[0]?.[1].length ?? 0
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 0,
    format: 'xplane',
    rowCount,
    channels,
    timeSourceId: null,
    elapsed: Float64Array.from(elapsed ?? Array.from({ length: rowCount }, (_, i) => i)),
    segments: [{ start: 0, end: rowCount, reason: 'start' }],
    sampleRateHz: 1,
    warnings: [],
    signature: 'test',
    loadedAt: 0,
  }
}

describe('X-Plane channel aliases used by the presets', () => {
  it.each([
    ['_Vind,_kias', 'Vind_kias'],
    ['_Vind,_keas', 'Vind_keas'],
    ['Vtrue,_ktas', 'Vtrue_ktas'],
    ['Vtrue,_ktgs', 'Vtrue_ktgs'],
    ['thrst,_1,lb', 'thrst_1_lb'],
    ['thrst,_2,lb', 'thrst_2_lb'],
    ['FF__1,_lb/h', 'FF_1_lb_h'],
    ['FF__2,_lb/h', 'FF_2_lb_h'],
    ['S-ref,ft*ft', 'S_ref_ft_ft'],
    ['___cl,total', 'cl_total'],
    ['Gload,norml', 'Gload_norml'],
    ['total,___lb', 'total_lb'],
    ['__VVI,__fpm', 'VVI_fpm'],
    ['p-alt,ftMSL', 'p_alt_ftMSL'],
    ['_drag,___lb', 'drag_lb'],
    ['_lift,___lb', 'lift_lb'],
  ])('%s -> %s', (token, alias) => {
    expect(aliasForToken(token)).toBe(alias)
  })
})

describe('slugify', () => {
  it.each([
    ['Power required', 'power_required'],
    ['  Specific   excess power ', 'specific_excess_power'],
    ['CL (n·W/qS)', 'cl_n_w_qs'],
    ['Dynamic pressure (lb/ft²)', 'dynamic_pressure_lb_ft2'],
    ['W/δ', 'w_delta'],
    ['Pressure ratio δ', 'pressure_ratio_delta'],
    ['Pérformance — été', 'performance_ete'],
    ['2nd climb', 'f_2nd_climb'],
    ['', 'formula'],
    ['!!!', 'formula'],
    ['pi', 'f_pi'],
    ['t', 'f_t'],
    ['G0', 'f_g0'],
    ['__x__', 'x'],
  ])('%j -> %s', (name, slug) => {
    expect(slugify(name)).toBe(slug)
  })

  it('always gives an identifier the formula language reads as a channel reference', () => {
    for (const name of ['α sweep', '123', 'e', 'Total thrust', '∆ speed', '中文']) {
      const slug = slugify(name)
      expect(slug).toMatch(/^[a-z_][a-z0-9_]*$/)
      expect(compileExpression(slug).refs).toEqual([slug])
    }
  })
})

describe('withDerived', () => {
  const ds = makeDataset(
    [
      ['_Vind,_kias', [100, 110, 120]],
      ['elev1,__deg', [1, 2, 3]],
      ['elev1,__deg', [10, 20, 30]],
    ],
    [0, 0.5, 1],
  )

  it('appends one channel per formula after the file channels, evaluated in order', () => {
    const defs: DerivedDef[] = [
      { id: 'fx:double', name: 'Double', unit: 'kt', expression: 'Vind_kias * 2' },
      { id: 'fx:sum', name: 'Elevator sum', unit: 'deg', expression: 'elev1_deg + elev1_deg_2 + [elev1,__deg#2]' },
      { id: 'fx:chained', name: 'Chained', unit: '', expression: 'double - Vind_kias + t' },
    ]
    const { dataset, errors } = withDerived(ds, defs)
    expect(errors).toEqual([])
    expect(dataset).not.toBe(ds)
    expect(dataset.channels.map((c) => c.id)).toEqual([
      '_Vind,_kias',
      'elev1,__deg',
      'elev1,__deg#2',
      'fx:double',
      'fx:sum',
      'fx:chained',
    ])
    const [double, sum, chained] = dataset.channels.slice(3)
    expect(Array.from(double.values)).toEqual([200, 220, 240])
    expect(Array.from(sum.values)).toEqual([21, 42, 63])
    expect(Array.from(chained.values)).toEqual([100, 110.5, 121])
    expect(double).toMatchObject({
      id: 'fx:double',
      token: '',
      occurrence: 1,
      column: -1,
      meta: { label: 'Double', short: 'Double', unit: 'kt', quantity: 'other', group: 'derived', known: false },
      derived: { expression: 'Vind_kias * 2' },
    })
    expect(double.stats).toEqual(computeStats(double.values))
    // The input dataset is untouched.
    expect(ds.channels).toHaveLength(3)
  })

  it('drops existing derived channels before re-evaluating', () => {
    const first = withDerived(ds, [{ id: 'fx:a', name: 'A', unit: '', expression: '1' }]).dataset
    const second = withDerived(first, [{ id: 'fx:b', name: 'B', unit: '', expression: '2' }]).dataset
    expect(second.channels.map((c) => c.id)).toEqual(['_Vind,_kias', 'elev1,__deg', 'elev1,__deg#2', 'fx:b'])
    expect(withDerived(first, []).dataset.channels).toHaveLength(3)
  })

  it('skips and reports failing formulas while the others still evaluate', () => {
    const { dataset, errors } = withDerived(ds, [
      { id: 'fx:bad_name', name: 'Bad', unit: '', expression: 'Vind_kas * 2' },
      { id: 'fx:bad_syntax', name: 'Bad', unit: '', expression: '1 +' },
      { id: 'fx:ok', name: 'OK', unit: '', expression: 'Vind_kias / 10' },
      { id: 'fx:uses_bad', name: 'Uses bad', unit: '', expression: 'bad_name + 1' },
      { id: 'fx:ok', name: 'Duplicate', unit: '', expression: '1' },
      { id: 'nope', name: 'No prefix', unit: '', expression: '1' },
    ])
    expect(dataset.channels.map((c) => c.id)).toEqual(['_Vind,_kias', 'elev1,__deg', 'elev1,__deg#2', 'fx:ok'])
    expect(errors.map((e) => e.id)).toEqual(['fx:bad_name', 'fx:bad_syntax', 'fx:uses_bad', 'fx:ok', 'nope'])
    expect(errors[0].message).toMatch(/Vind_kas/)
    expect(errors[0].message).toMatch(/Did you mean Vind_kias\?/)
    expect(errors[1].message).toMatch(/ends unexpectedly/)
  })

  it('computes NaN-aware stats for derived channels', () => {
    const { dataset } = withDerived(ds, [{ id: 'fx:inv', name: 'Inverse', unit: '', expression: '1 / (Vind_kias - 110)' }])
    const ch = dataset.channels[3]
    expect(Number.isNaN(ch.values[1])).toBe(true)
    expect(ch.stats.finite).toBe(2)
  })

  it("differentiates within the dataset's segments (no spike at a sim reset or recording gap)", () => {
    // Pressure altitude climbs 10 ft per 0.1 s in both runs, but jumps from 0 to 10 000 ft where the second starts:
    // elapsed time advances by only one step there, so a difference across it would read 50 000 ft/s.
    const alt = Array.from({ length: 8 }, (_, i) => (i < 4 ? 10 * i : 10_000 + 10 * i))
    const elapsed = alt.map((_, i) => i * 0.1)
    const twoRuns: Dataset = {
      ...makeDataset([['p-alt,ftMSL', alt]], elapsed),
      segments: [
        { start: 0, end: 4, reason: 'start' },
        { start: 4, end: 8, reason: 'reset' },
      ],
    }
    const { dataset, errors } = withDerived(twoRuns, [{ id: 'fx:rate', name: 'Rate', unit: 'ft/s', expression: 'diff(p_alt_ftMSL)' }])
    expect(errors).toEqual([])
    for (const v of dataset.channels[1].values) expect(v).toBeCloseTo(100, 9)
  })
})

// --------------------------------------------------------------------------------------------- presets

const KT = 1852 / 3600 // m/s per knot
const FT = 0.3048
const LBF = 0.45359237 * 9.80665 // N per lbf
const G = 9.80665
const HP = 550 * FT * LBF // W per hp

/** A short, plausible piston-twin record at 1 Hz (two engines) with every channel the presets can use. */
const rows = {
  keas: [100, 100, 101, 102, 102],
  ktas: [110, 110.5, 111, 112, 112],
  ktgs: [100, 100, 101, 102, 102],
  vvi: [0, 500, 500, 0, -300],
  nz: [1, 1.02, 1, 0.98, 1],
  weight: [2400, 2400, 2399.9, 2399.9, 2399.8],
  sref: [174, 174, 174, 174, 174],
  lift: [2400, 2448, 2400, 2352, 2400],
  drag: [200, 205, 210, 215, 220],
  palt: [5000, 5008, 5016, 5020, 40000],
  t1: [210, 212, 214, 216, 218],
  t2: [190, 190, 195, 195, 190],
  ff1: [50, 50, 52, 52, 50],
  ff2: [40, 40, 42, 42, 40],
}
const time = [0, 1, 2, 3, 4]

function twinDataset(): Dataset {
  return makeDataset(
    [
      ['_Vind,_kias', rows.keas],
      ['_Vind,_keas', rows.keas],
      ['Vtrue,_ktas', rows.ktas],
      ['Vtrue,_ktgs', rows.ktgs],
      ['__VVI,__fpm', rows.vvi],
      ['Gload,norml', rows.nz],
      ['total,___lb', rows.weight],
      ['S-ref,ft*ft', rows.sref],
      ['_lift,___lb', rows.lift],
      ['_drag,___lb', rows.drag],
      ['p-alt,ftMSL', rows.palt],
      ['thrst,_1,lb', rows.t1],
      ['thrst,_2,lb', rows.t2],
      ['FF__1,_lb/h', rows.ff1],
      ['FF__2,_lb/h', rows.ff2],
    ],
    time,
  )
}

/** Hand-computed (plain arithmetic, no formula engine) expected value of each preset at row i. */
function expected(id: string, i: number): number {
  const v = (k: number) => rows.ktas[k] * KT
  const q = 0.5 * 1.225 * (rows.keas[i] * KT) ** 2
  const s = rows.sref[i] * FT * FT
  const thrust = rows.t1[i] + rows.t2[i]
  const ff = rows.ff1[i] + rows.ff2[i]
  // Rates by central differences (one-sided at the ends), 1 s spacing: dV/dt from TAS, dh/dt from pressure altitude.
  const rate = (f: (k: number) => number) => (i === 0 ? f(1) - f(0) : i === 4 ? f(4) - f(3) : (f(i + 1) - f(i - 1)) / 2)
  const dvdt = rate(v)
  const dhdt = rate((k) => rows.palt[k] * FT)
  const h = rows.palt[i]
  const delta = h <= 36089.24 ? (1 - 6.8755856e-6 * h) ** 5.2558797 : 0.22336 * Math.exp(-4.80634e-5 * (h - 36089.24))
  let fuel = 0
  for (let k = 1; k <= i; k += 1) fuel += ((rows.ff1[k] + rows.ff2[k] + rows.ff1[k - 1] + rows.ff2[k - 1]) / 2) * 1
  switch (id) {
    case 'total_thrust':
      return thrust
    case 'total_fuel_flow':
      return ff
    case 'dynamic_pressure_pa':
      return q
    case 'dynamic_pressure_lb_ft2':
      return q / (LBF / FT ** 2)
    case 'cl_from_weight':
      return (rows.nz[i] * rows.weight[i] * LBF) / (q * s)
    case 'cd_from_drag':
      return (rows.drag[i] * LBF) / (q * s)
    case 'cd_from_thrust':
      return ((thrust - rows.weight[i] * (dhdt / v(i) + dvdt / G)) * LBF) / (q * s)
    case 'lift_to_drag_ratio':
      return rows.lift[i] / rows.drag[i]
    case 'power_required_kw':
      return (rows.drag[i] * LBF * v(i)) / 1000
    case 'power_required_hp':
      return (rows.drag[i] * LBF * v(i)) / HP
    case 'thrust_power_kw':
      return (thrust * LBF * v(i)) / 1000
    case 'thrust_power_hp':
      return (thrust * LBF * v(i)) / HP
    case 'specific_excess_power':
      return dhdt + (v(i) / G) * dvdt
    case 'energy_height':
      return h + v(i) ** 2 / (2 * G) / FT
    case 'flight_path_angle':
      return (Math.asin((rows.vvi[i] * FT) / 60 / v(i)) * 180) / Math.PI
    case 'specific_range':
      return rows.ktgs[i] / ff
    case 'specific_air_range':
      return rows.ktas[i] / ff
    case 'specific_endurance':
      return 1000 / ff
    case 'fuel_used':
      return fuel / 3600
    case 'pressure_ratio_delta':
      return delta
    case 'w_delta':
      return rows.weight[i] / delta
    default:
      throw new Error(`no expected value for ${id}`)
  }
}

function evaluatePreset(ds: Dataset, preset: DerivedPreset): Float64Array {
  const { dataset, errors } = withDerived(ds, [
    { id: `fx:${preset.id}`, name: preset.name, unit: preset.unit, expression: preset.expression },
  ])
  expect(errors).toEqual([])
  return dataset.channels[dataset.channels.length - 1].values
}

describe('availablePresets', () => {
  it('offers every preset when all inputs exist, each matching hand-computed values', () => {
    const ds = twinDataset()
    const presets = availablePresets(ds)
    expect(presets.map((p) => p.id)).toEqual([
      'total_thrust',
      'total_fuel_flow',
      'dynamic_pressure_pa',
      'dynamic_pressure_lb_ft2',
      'cl_from_weight',
      'cd_from_drag',
      'cd_from_thrust',
      'lift_to_drag_ratio',
      'power_required_kw',
      'power_required_hp',
      'thrust_power_kw',
      'thrust_power_hp',
      'specific_excess_power',
      'energy_height',
      'flight_path_angle',
      'specific_range',
      'specific_air_range',
      'specific_endurance',
      'fuel_used',
      'pressure_ratio_delta',
      'w_delta',
    ])
    for (const preset of presets) {
      expect(preset.id).toBe(slugify(preset.name))
      expect(preset.description.length).toBeGreaterThan(30)
      const values = evaluatePreset(ds, preset)
      for (let i = 0; i < 5; i += 1) {
        const want = expected(preset.id, i)
        expect(values[i], `${preset.id} row ${i}`).toBeCloseTo(want, Math.abs(want) > 100 ? 6 : 9)
      }
    }
  })

  it('reproduces textbook numbers', () => {
    const ds = twinDataset()
    const at = (id: string, row: number) => {
      const preset = availablePresets(ds).find((p) => p.id === id)
      if (!preset) throw new Error(`missing preset ${id}`)
      return evaluatePreset(ds, preset)[row]
    }
    // 100 KEAS: q = ½·1.225·(51.444 m/s)² = 1621.0 Pa = 33.86 lb/ft².
    expect(at('dynamic_pressure_pa', 0)).toBeCloseTo(1621.0, 2)
    expect(at('dynamic_pressure_lb_ft2', 0)).toBeCloseTo(33.855, 2)
    // CL = 2400 lb / (33.855 lb/ft² × 174 ft²) = 0.4074; CD = 200 / 5890.8 = 0.03395.
    expect(at('cl_from_weight', 0)).toBeCloseTo(0.40741, 4)
    expect(at('cd_from_drag', 0)).toBeCloseTo(0.033951, 5)
    expect(at('lift_to_drag_ratio', 0)).toBe(12)
    // 200 lb at 110 KTAS (185.66 ft/s): 37 132 ft·lbf/s = 67.51 hp = 50.34 kW.
    expect(at('power_required_hp', 0)).toBeCloseTo(67.512, 2)
    expect(at('power_required_kw', 0)).toBeCloseTo(50.344, 2)
    // 500 ft/min at 110.5 KTAS: γ = asin(2.54 / 56.846) = 2.561°.
    expect(at('flight_path_angle', 1)).toBeCloseTo(2.561, 3)
    // ISA: δ(5000 ft) = 0.8320, δ(40 000 ft) = 0.1851.
    expect(at('pressure_ratio_delta', 0)).toBeCloseTo(0.83204, 4)
    expect(at('pressure_ratio_delta', 4)).toBeCloseTo(0.18509, 4)
    // 90 lb/h: 1.111 nm/lb at 100 kt ground speed, 11.11 h per 1000 lb.
    expect(at('specific_range', 0)).toBeCloseTo(1.1111, 4)
    expect(at('specific_endurance', 0)).toBeCloseTo(11.111, 3)
    // Fuel used after 4 s: (90 + 92 + 94 + 92) lb·s/h ÷ 3600 = 0.10222 lb.
    expect(at('fuel_used', 4)).toBeCloseTo(0.102222, 6)
    // Energy height at 5000 ft and 110 KTAS: 5000 + 535.67 ft.
    expect(at('energy_height', 0)).toBeCloseTo(5535.67, 1)
  })

  it('lists exactly the channel aliases each expression uses in `requires`', () => {
    const ds = twinDataset()
    const aliases = new Set(ds.channels.map((c) => aliasForToken(c.token, c.occurrence)))
    for (const preset of availablePresets(ds)) {
      const refs = compileExpression(preset.expression).refs
      expect(new Set(refs), preset.id).toEqual(new Set(preset.requires))
      for (const alias of preset.requires) expect(aliases.has(alias), alias).toBe(true)
    }
  })

  it('sums however many engines exist (1..N)', () => {
    const three = makeDataset([
      ['thrst,_1,lb', [100]],
      ['thrst,_2,lb', [200]],
      ['thrst,_3,lb', [300]],
      ['FF__1,_lb/h', [10]],
      ['FF__2,_lb/h', [20]],
      ['FF__3,_lb/h', [30]],
      ['Vtrue,_ktas', [120]],
    ])
    const presets = availablePresets(three)
    const total = presets.find((p) => p.id === 'total_thrust')
    expect(total?.expression).toBe('thrst_1_lb + thrst_2_lb + thrst_3_lb')
    expect(evaluatePreset(three, total as DerivedPreset)[0]).toBe(600)
    const sar = presets.find((p) => p.id === 'specific_air_range') as DerivedPreset
    expect(evaluatePreset(three, sar)[0]).toBeCloseTo(2, 12)

    const single = makeDataset([
      ['thrst,_1,lb', [100]],
      ['FF__1,_lb/h', [10]],
      ['Vtrue,_ktas', [120]],
    ])
    const singlePresets = availablePresets(single)
    expect(singlePresets.map((p) => p.id)).not.toContain('total_thrust')
    expect(singlePresets.map((p) => p.id)).not.toContain('total_fuel_flow')
    const thrustPower = singlePresets.find((p) => p.id === 'thrust_power_kw') as DerivedPreset
    expect(thrustPower.expression).toBe('thrst_1_lb * lb2n * (Vtrue_ktas * kt2ms) / 1000')
    expect(evaluatePreset(single, thrustPower)[0]).toBeCloseTo((100 * LBF * 120 * KT) / 1000, 9)
  })

  it('offers only the presets whose inputs exist (Cessna dynamic-modes channels)', () => {
    const cessna = makeDataset(
      [
        '_Vind,_kias',
        '_Vind,_keas',
        'Vtrue,_ktas',
        'Vtrue,_ktgs',
        '__VVI,__fpm',
        'Gload,norml',
        'alpha,__deg',
        'pitch,__deg',
        'p-alt,ftMSL',
      ].map((token) => [token, [1, 2]]),
    )
    expect(availablePresets(cessna).map((p) => p.id)).toEqual([
      'dynamic_pressure_pa',
      'dynamic_pressure_lb_ft2',
      'specific_excess_power',
      'energy_height',
      'flight_path_angle',
      'pressure_ratio_delta',
    ])
    expect(availablePresets(makeDataset([['Airspeed (kt)', [1]]]))).toEqual([])
  })

  it('takes dh/dt and energy height from the geometric altitude when it is logged', () => {
    // A steady 600 ft/min climb at constant TAS on a hot day: pressure altitude rises 5 % slower (T_std/T).
    const both = makeDataset(
      [
        ['Vtrue,_ktas', [100, 100, 100]],
        ['___CG,ftMSL', [1000, 1010, 1020]],
        ['p-alt,ftMSL', [900, 909.5, 919]],
      ],
      [0, 1, 2],
    )
    const presets = availablePresets(both)
    const ps = presets.find((p) => p.id === 'specific_excess_power') as DerivedPreset
    expect(ps.requires).toEqual(['CG_ftMSL', 'Vtrue_ktas'])
    expect(ps.description).toMatch(/geometric altitude/)
    for (const v of evaluatePreset(both, ps)) expect(v).toBeCloseTo(10 * FT, 12)
    const energy = presets.find((p) => p.id === 'energy_height') as DerivedPreset
    expect(energy.requires).toEqual(['CG_ftMSL', 'Vtrue_ktas'])
    expect(evaluatePreset(both, energy)[0]).toBeCloseTo(1000 + (100 * KT) ** 2 / (2 * G) / FT, 6)
  })

  it('takes dh/dt from pressure altitude (lag-free), or from VVI when altitude is not logged', () => {
    // A steady 600 ft/min climb at constant TAS: Ps = 3.048 m/s either way.
    const withAltitude = makeDataset(
      [
        ['Vtrue,_ktas', [100, 100, 100]],
        ['__VVI,__fpm', [0, 0, 0]], // a lagging indicator still reading zero must not matter
        ['p-alt,ftMSL', [1000, 1010, 1020]],
      ],
      [0, 1, 2],
    )
    const fromAltitude = availablePresets(withAltitude).find((p) => p.id === 'specific_excess_power') as DerivedPreset
    expect(fromAltitude.requires).toEqual(['p_alt_ftMSL', 'Vtrue_ktas'])
    expect(fromAltitude.description).toMatch(/ISA/)
    for (const v of evaluatePreset(withAltitude, fromAltitude)) expect(v).toBeCloseTo(10 * FT, 12)

    const vviOnly = makeDataset(
      [
        ['Vtrue,_ktas', [100, 100, 100]],
        ['__VVI,__fpm', [600, 600, 600]],
      ],
      [0, 1, 2],
    )
    const fromVvi = availablePresets(vviOnly).find((p) => p.id === 'specific_excess_power') as DerivedPreset
    expect(fromVvi.requires).toEqual(['VVI_fpm', 'Vtrue_ktas'])
    expect(fromVvi.description).toMatch(/lags/)
    for (const v of evaluatePreset(vviOnly, fromVvi)) expect(v).toBeCloseTo(10 * FT, 12)
  })

  it('is offered for the full X-Plane 12 header of the 737 performance log', () => {
    const header =
      '_real,_time|_totl,_time|missn,_time|timer,_time|_zulu,_time|local,_time|hobbs,_time|_Vind,_kias|' +
      '_Vind,_keas|Vtrue,_ktas|Vtrue,_ktgs|_Vind,__mph|Vtrue,mphas|Vtrue,mphgs|_Mach,ratio|__VVI,__fpm|' +
      'toten,vario|Gload,norml|Gload,axial|Gload,_side|alpha,__deg|_beta,__deg|hpath,_true|vpath,__deg|' +
      '_slip,__deg|pitch,__deg|_roll,__deg|hding,_true|hding,__mag|p-alt,ftMSL|total,___lb|gross,___lb|' +
      'FF__1,_lb/h|FF__2,_lb/h|thrst,_1,lb|thrst,_2,lb|elev1,__deg|elev1,__deg|__L/D,_aero|___cl,total|' +
      '___cd,total|S-ref,ft*ft|_lift,___lb|_drag,___lb|_side,___lb|wing1,_lift|wing1,_lift|wing1,_drag|' +
      'wing1,_drag|hstab,_lift|hstab,_lift|hstab,_drag|hstab,_drag'
    const ds = makeDataset(header.split('|').map((token) => [token, [1, 2, 3]]))
    const presets = availablePresets(ds)
    expect(presets).toHaveLength(21)
    for (const preset of presets) expect(withDerived(ds, [{ ...preset, id: `fx:${preset.id}` }]).errors).toEqual([])
  })
})
