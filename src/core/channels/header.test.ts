import { describe, expect, it } from 'vitest'
import { DEMO_TOKENS } from '../demo/simulate'
import { XPLANE_737_HEADER } from '../parse/fixtures'
import type { ChannelMeta } from '../types'
import { allGroups, describeChannel, describeHeader } from '.'
import { allEntries, type Entry } from './entries'

const HEADER_737 = XPLANE_737_HEADER.split('|')
  .map((token) => token.trim())
  .filter(Boolean)

/** Every dictionary entry that is not an older spelling, in dictionary (= display) order. */
const XP12_ENTRIES: Entry[] = allEntries().filter((entry) => !/^Legacy/.test(entry.meta.notes ?? ''))

/** The X-Plane 12 tokens of one row, in slot order, as X-Plane writes them when only that row is ticked. */
function rowTokens(group: string): string[] {
  return XP12_ENTRIES.filter((entry) => entry.group === group).map((entry) => entry.token)
}

const PHYSICAL_EXEMPT = new Set(['ratio', 'flag', 'other'])

/** Consecutive runs of the same group: [group, column count]. */
function blocks(metas: readonly ChannelMeta[]): [string, number][] {
  const runs: [string, number][] = []
  for (const meta of metas) {
    const last = runs[runs.length - 1]
    if (last && last[0] === meta.group) last[1] += 1
    else runs.push([meta.group, 1])
  }
  return runs
}

function expectUniqueShorts(metas: readonly ChannelMeta[]): void {
  const shorts = metas.map((meta) => meta.short)
  expect(new Set(shorts).size).toBe(shorts.length)
}

describe('describeHeader on whole headers', () => {
  it('knows every column of the parser fixture header: labels, shorts, units, unique shorts', () => {
    expect(HEADER_737).toHaveLength(173)
    const metas = describeHeader(HEADER_737)
    expect(metas).toHaveLength(173)
    for (const meta of metas) {
      expect(meta.known).toBe(true)
      expect(meta.label.trim()).not.toBe('')
      expect(meta.short.trim()).not.toBe('')
      expect(meta.short.length).toBeLessThanOrEqual(16)
      if (!PHYSICAL_EXEMPT.has(meta.quantity)) expect(meta.unit).not.toBe('')
    }
    expectUniqueShorts(metas)
  })

  it('knows every column of the demo log, with unique shorts', () => {
    const metas = describeHeader(DEMO_TOKENS)
    expect(metas).toHaveLength(DEMO_TOKENS.length)
    for (const meta of metas) {
      expect(meta.known).toBe(true)
      expect(meta.label.trim()).not.toBe('')
      expect(meta.short.trim()).not.toBe('')
    }
    expectUniqueShorts(metas)
  })

  it('gives every repeated token a different label per occurrence (left / right halves)', () => {
    for (const header of [HEADER_737, [...DEMO_TOKENS]]) {
      const metas = describeHeader(header)
      const labels = new Map<string, Set<string>>()
      const counts = new Map<string, number>()
      header.forEach((token, i) => {
        counts.set(token, (counts.get(token) ?? 0) + 1)
        const set = labels.get(token) ?? new Set<string>()
        set.add(metas[i].label)
        labels.set(token, set)
      })
      for (const [token, n] of counts) expect(labels.get(token)?.size, token).toBe(n)
    }
    const metas = describeHeader(HEADER_737)
    expect(metas[132]).toMatchObject({ label: 'Elevator 1, left half', short: 'δe left', unit: 'deg' })
    expect(metas[133]).toMatchObject({ label: 'Elevator 1, right half', short: 'δe right', unit: 'deg' })
    expect(metas[149].label).toBe('Wing 1 lift (left)')
    expect(metas[150].label).toBe('Wing 1 lift (right)')
  })

  it('reads the fixture header as contiguous row blocks in X-Plane 12 display order', () => {
    const runs = blocks(describeHeader(HEADER_737))
    expect(runs.map(([group]) => group)).toEqual([
      'times',
      'speeds',
      'mach-vvi-gload',
      'aoa-sideslip-paths',
      'pitch-roll-headings',
      'lat-lon-alt',
      'location-velocity-distance',
      'angular-accelerations',
      'angular-velocities',
      'weight-balance',
      'payload-weights',
      'fuel-weights',
      'fuel-temp-tanks',
      'joystick',
      'servos',
      'artificial-stability',
      'flight-controls',
      'trim-flaps-slats-speedbrakes',
      'start-fuel-flow',
      'idle-speed',
      'throttle-commanded',
      'throttle-actual',
      'mixture',
      'n1',
      'n2',
      'epr',
      'fuel-flow',
      'sfc',
      'fuel-pressure',
      'fuel-temp-fcu',
      'engine-power',
      'engine-thrust',
      'engine-rpm',
      'aileron-deflections-1',
      'roll-spoilers-1',
      'roll-spoilers-2',
      'elevator-deflections',
      'rudder-deflections',
      'lift-drag-coefficients',
      'lift-drag',
      'angular-moments',
      'wing-lift',
      'wing-drag',
      'stab-lift',
      'stab-drag',
    ])
    // Each group appears once (contiguous), in the order allGroups() lists the rows.
    const order = new Map(allGroups().map((group) => [group.id, group.order]))
    const positions = runs.map(([group]) => order.get(group) ?? -1)
    expect(new Set(runs.map(([group]) => group)).size).toBe(runs.length)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('names the key channels the way the plots need them', () => {
    const byToken = new Map(describeHeader(HEADER_737).map((meta, i) => [HEADER_737[i], meta]))
    const pick = (token: string) => {
      const meta = byToken.get(token)
      return meta && { short: meta.short, unit: meta.unit, quantity: meta.quantity, group: meta.group }
    }
    expect(pick('_Vind,_kias')).toEqual({ short: 'KIAS', unit: 'kt', quantity: 'speed', group: 'speeds' })
    expect(pick('Vtrue,_ktas')).toMatchObject({ short: 'KTAS', unit: 'kt' })
    expect(pick('_Mach,ratio')).toMatchObject({ short: 'Mach', unit: '' })
    expect(pick('__VVI,__fpm')).toMatchObject({ short: 'VVI', unit: 'fpm' })
    expect(pick('Gload,norml')).toMatchObject({ short: 'nz', unit: 'g' })
    expect(pick('alpha,__deg')).toMatchObject({ short: 'α', unit: 'deg', quantity: 'angle' })
    expect(pick('_beta,__deg')).toMatchObject({ short: 'β', unit: 'deg' })
    expect(pick('pitch,__deg')).toMatchObject({ short: 'θ pitch' })
    expect(pick('_roll,__deg')).toMatchObject({ short: 'φ roll' })
    expect(pick('hding,_true')).toMatchObject({ short: 'ψ true' })
    expect(pick('____P,deg/s')).toMatchObject({ short: 'P', unit: 'deg/s', quantity: 'angular-rate' })
    expect(pick('____Q,deg/s')).toMatchObject({ short: 'Q', unit: 'deg/s' })
    expect(pick('____R,deg/s')).toMatchObject({ short: 'R', unit: 'deg/s' })
    expect(pick('_Pdot,_d/ss')).toMatchObject({ unit: 'deg/s²', quantity: 'angular-accel' })
    expect(pick('_elev,_surf')).toMatchObject({ short: 'Elevator ratio', unit: '' })
    expect(pick('____X,____m')).toMatchObject({ short: 'X local', unit: 'm' })
    expect(pick('thro1,handl')).toMatchObject({ short: 'Throttle 1', unit: '' })
    expect(pick('N1__1,_pcnt')).toMatchObject({ short: 'N1 eng 1', unit: '%' })
    expect(pick('thrst,_1,lb')).toMatchObject({ short: 'Thrust eng 1', unit: 'lb', quantity: 'force' })
    expect(pick('FF__1,_lb/h')).toMatchObject({ short: 'FF eng 1', unit: 'lb/h' })
    expect(pick('___cl,total')).toMatchObject({ short: 'CL', unit: '' })
    expect(pick('___cd,total')).toMatchObject({ short: 'CD', unit: '' })
    expect(pick('__L/D,_aero')).toMatchObject({ short: 'L/D' })
    expect(pick('____M,lb-ft')).toMatchObject({ unit: 'lb·ft', quantity: 'moment' })
    expect(pick('S-ref,ft*ft')).toMatchObject({ unit: 'ft²' })
    expect(pick('_zulu,_time')).toMatchObject({ unit: 'h', quantity: 'time' })
    expect(pick('total,___lb')?.short).not.toBe(pick('gross,___lb')?.short)
  })
})

describe('describeHeader tells shared tokens apart by their row', () => {
  it('labels the aerodynamic and the gear side force differently, in different groups', () => {
    const header = [...rowTokens('lift-drag'), ...rowTokens('gear-forces'), ...rowTokens('engine-forces')]
    expect(header.filter((token) => token === '_side,___lb')).toHaveLength(3)
    const metas = describeHeader(header)
    const sides = metas.filter((_, i) => header[i] === '_side,___lb')
    expect(sides.map((meta) => meta.group)).toEqual(['lift-drag', 'gear-forces', 'engine-forces'])
    expect(new Set(sides.map((meta) => meta.label)).size).toBe(3)
    expect(new Set(sides.map((meta) => meta.short)).size).toBe(3)
    const axial = metas.filter((_, i) => header[i] === 'axial,___lb').map((meta) => meta.group)
    expect(axial).toEqual(['gear-forces', 'engine-forces'])
  })

  it('reads a row ticked on its own as that row, whatever its tokens occur as elsewhere', () => {
    // Gear forces alone: its "_side,___lb" is the 1st one in the file but still the gear side force.
    expect(describeHeader(rowTokens('gear-forces')).map((meta) => meta.group)).toEqual(
      rowTokens('gear-forces').map(() => 'gear-forces'),
    )
    const ambiguous: Record<string, string> = {
      // Identical tokens: only the block order tells these rows apart, so a lone row reads as the first of them.
      'metar-clouds-winds-3': 'metar-clouds-winds-2',
      'motor-stator-b-temp': 'motor-stator-a-temp',
    }
    for (const group of new Set(XP12_ENTRIES.map((entry) => entry.group))) {
      const metas = describeHeader(rowTokens(group))
      for (const meta of metas) expect(meta.group, group).toBe(ambiguous[group] ?? group)
    }
  })

  it('resolves every column of a header with every X-Plane 12 row ticked to its own entry', () => {
    const header = XP12_ENTRIES.map((entry) => entry.token)
    const metas = describeHeader(header)
    metas.forEach((meta, i) => {
      const entry = XP12_ENTRIES[i]
      expect(meta.group, `${entry.token}#${entry.occurrence}`).toBe(entry.group)
      expect(meta.label.startsWith(entry.meta.label), `${entry.token}#${entry.occurrence}`).toBe(true)
    })
    expectUniqueShorts(metas)
  })

  it('uses the neighbours for the wind at the aircraft and for the motion-platform rates', () => {
    const local = describeHeader(rowTokens('point-weather-precip-wind'))
    expect(local[6]).toMatchObject({ group: 'point-weather-precip-wind', label: 'Wind direction at aircraft' })
    const rates = describeHeader([...rowTokens('angular-velocities'), ...rowTokens('motion-platform')])
    expect(rates.map((meta) => meta.group)).toEqual([
      'angular-velocities',
      'angular-velocities',
      'angular-velocities',
      'motion-platform',
      'motion-platform',
      'motion-platform',
      'motion-platform',
      'motion-platform',
      'motion-platform',
    ])
    expect(rates[6].label).not.toBe(rates[0].label)
    expect(rates[6].short).not.toBe(rates[0].short)
    // Motion platform first: the second P/Q/R block is still the body rates.
    const swapped = describeHeader([...rowTokens('motion-platform'), ...rowTokens('angular-velocities')])
    expect(swapped.slice(6).map((meta) => meta.group)).toEqual(['angular-velocities', 'angular-velocities', 'angular-velocities'])
  })

  it('tells METAR layers 2 and 3, and stator A and B, apart by block order', () => {
    const metar = describeHeader([...rowTokens('metar-clouds-winds-2'), ...rowTokens('metar-clouds-winds-3')])
    expect(blocks(metar).map(([group]) => group)).toEqual(['metar-clouds-winds-2', 'metar-clouds-winds-3'])
    const stators = describeHeader([...rowTokens('motor-stator-a-temp'), ...rowTokens('motor-stator-b-temp')])
    expect(stators.map((meta) => meta.short)).toEqual(['Stator A T 1', 'Stator A T 2', 'Stator B T 1', 'Stator B T 2'])
  })

  it('reads X-Plane 10/11 throttle rows: commanded first, then actual', () => {
    const metas = describeHeader(['thro1,_part', 'thro2,_part', 'thro1,_part', 'thro2,_part'])
    expect(metas.map((meta) => [meta.group, meta.short])).toEqual([
      ['throttle-commanded', 'Throttle 1'],
      ['throttle-commanded', 'Throttle 2'],
      ['throttle-actual', 'Throttle used 1'],
      ['throttle-actual', 'Throttle used 2'],
    ])
  })
})

describe('describeHeader with numbered and unknown columns', () => {
  it('derives engines and tanks beyond the dictionary from engine 1 / tank 1', () => {
    const header = ['N1__1,_pcnt', 'N1__2,_pcnt', 'N1__3,_pcnt', 'N1__4,_pcnt', 'fuel1,___lb', 'fuel2,___lb', 'fuel3,___lb', 'fuel4,___lb']
    const metas = describeHeader(header)
    expect(metas.map((meta) => meta.short)).toEqual(['N1 eng 1', 'N1 eng 2', 'N1 eng 3', 'N1 eng 4', 'Tank 1', 'Tank 2', 'Tank 3', 'Tank 4'])
    expect(metas[3]).toMatchObject({ label: 'N1, engine 4', group: 'n1', unit: '%', known: true })
    expect(metas[3].notes).toContain('Pattern match: engine 4 (from the engine-1 entry).')
    expect(blocks(metas)).toEqual([
      ['n1', 4],
      ['fuel-weights', 4],
    ])
  })

  it('numbers the short names of rudders and elevator sets beyond the dictionary, also when unit 1 has no number', () => {
    // Rudder 1 is "δr" and elevator 1 "δe left" / "δe right" (no number): unit 3 must not repeat them.
    const rudders = describeHeader(['rudr1,__deg', 'rudr2,__deg', 'rudr3,__deg', 'rudr4,__deg'])
    expect(rudders.map((meta) => meta.short)).toEqual(['δr', 'δr 2', 'δr 3', 'δr 4'])
    expect(rudders.map((meta) => meta.label)).toEqual(['Rudder 1 deflection', 'Rudder 2 deflection', 'Rudder 3 deflection', 'Rudder 4 deflection'])
    expect(rudders.every((meta) => meta.group === 'rudder-deflections' && meta.known)).toBe(true)

    const elevators = describeHeader(['elev1,__deg', 'elev1,__deg', 'elev2,__deg', 'elev2,__deg', 'elev3,__deg', 'elev3,__deg'])
    expect(elevators.map((meta) => meta.short)).toEqual(['δe left', 'δe right', 'δe2 left', 'δe2 right', 'δe3 left', 'δe3 right'])
    expect(elevators[5]).toMatchObject({ label: 'Elevator 3, right half', group: 'elevator-deflections', unit: 'deg', known: true })
    expect(blocks(elevators)).toEqual([['elevator-deflections', 6]])

    // The same names column by column, without the rest of the header.
    expect(describeChannel('rudr3,__deg', 1).short).toBe('δr 3')
    expect(describeChannel('elev3,__deg', 1).short).toBe('δe3 left')
    expect(describeChannel('elev3,__deg', 2).short).toBe('δe3 right')
  })

  it('numbers gear and engine columns that repeat a token beyond the dictionary', () => {
    const metas = describeHeader(['_gear,__rat', '_gear,__rat', '_gear,__rat', '_gear,__rat', '_gear,__rat'])
    expect(metas.map((meta) => meta.short)).toEqual(['Gear 1 deploy', 'Gear 2 deploy', 'Gear 3 deploy', 'Gear 4 deploy', 'Gear 5 deploy'])
    expect(metas.every((meta) => meta.group === 'gear-deployment' && meta.known)).toBe(true)
  })

  it('skips unknown columns between and inside rows, and keeps the rest of the row', () => {
    const header = ['wing1,_lift', 'mystery,col', 'wing1,_lift', 'Elapsed (s)', '_Vind,_kias']
    const metas = describeHeader(header)
    expect(metas[0]).toMatchObject({ group: 'wing-lift', label: 'Wing 1 lift (left)' })
    expect(metas[2]).toMatchObject({ group: 'wing-lift', label: 'Wing 1 lift (right)' })
    expect(metas[1]).toEqual(describeChannel('mystery,col', 1))
    expect(metas[3]).toEqual(describeChannel('Elapsed (s)', 1))
    expect(metas[4]).toMatchObject({ short: 'KIAS', known: true })
  })

  it('matches describeChannel for headers the dictionary does not know', () => {
    const header = ['a,_x', 'b,_y', 'a,_x', 'a,_x', 'Time (s)', 'alpha [deg]']
    const occurrences = [1, 1, 2, 3, 1, 1]
    describeHeader(header).forEach((meta, i) => expect(meta).toEqual(describeChannel(header[i], occurrences[i])))
  })

  it('keeps short names unique when two columns would share one', () => {
    const metas = describeHeader(['__L/D,_aero', '__L/D,ratio', 'KIAS', 'KIAS', '_Vind,_kias'])
    expectUniqueShorts(metas)
    expect(metas[0].short).toBe('L/D')
    expect(metas[1].short).toBe('L/D (2)')
  })

  it('strips control characters and pandas ".1" suffixes before the lookup', () => {
    const metas = describeHeader(['sync_,butn\u0000', 'elev1,__deg', 'elev1,__deg.1'])
    expect(metas[0]).toMatchObject({ group: 'ap-modes', known: true })
    expect(metas[2]).toMatchObject({ label: 'Elevator 1, right half', group: 'elevator-deflections' })
  })

  it('returns an empty list for an empty header', () => {
    expect(describeHeader([])).toEqual([])
  })

  it('is fast: a 200-column header in well under 5 ms', () => {
    const header = [...HEADER_737, ...DEMO_TOKENS.slice(0, 27)]
    expect(header).toHaveLength(200)
    describeHeader(header) // build the lookup tables once
    let best = Infinity
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now()
      describeHeader(header)
      best = Math.min(best, performance.now() - start)
    }
    expect(best).toBeLessThan(4)
  })
})
