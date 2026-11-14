import { describe, expect, it } from 'vitest'
import type { Channel } from '../types'
import { allGroups, channelTitle, describeChannel, groupById, loggingGuide, recordingSteps } from '.'
import { CHANNEL_ROWS } from './dictionary'
import { allEntries, entryFor, LOW_CONFIDENCE_NOTE } from './entries'
import { GROUP_ROWS } from './groupRows'
import { OVERRIDES } from './overrides'
import type { Quantity } from './schema'

const QUANTITIES: readonly Quantity[] = [
  'time',
  'speed',
  'angle',
  'angular-rate',
  'angular-accel',
  'length',
  'altitude',
  'mass',
  'force',
  'moment',
  'power',
  'rpm',
  'percent',
  'pressure',
  'temperature',
  'flow',
  'ratio',
  'flag',
  'position',
  'other',
]

/** Display units the dictionary may use ('' = ratio, flag or code). */
const UNITS = new Set([
  '', 'kt', 'mph', 'deg', 'deg/s', 'deg/s²', 'rad/s', 'ft', 'm', 'm/s', 'nm', 'mi', 'lb', 'lb·ft', 'N·m', 'hp', 'W',
  'rpm', '%', 'psi', 'psf', 'inHg', 'lb/h', 'gal/h', 'gal', 'lb/(lb·h)', 'lb/(hp·h)', 's', 'min', 'h', 'ft²', 'g',
  'fpm', '°C', '°F/°C', 'm/s²', 'ft/s²', 'fps', '1/s', 'V', 'A', 'Wh', 'kHz', '10 kHz', 'dots', 'mi/gal', 'nm/lb',
  'mph·mi/gal',
])

const entries = allEntries()
const texts = (meta: { label: string; short: string; description?: string; sign?: string; notes?: string }) =>
  [meta.label, meta.short, meta.description ?? '', meta.sign ?? '', meta.notes ?? ''].join(' | ')

function channel(meta: Channel['meta']): Channel {
  return { id: 'x', token: 'x', occurrence: 1, column: 0, meta, values: new Float64Array(0), stats: { min: NaN, max: NaN, mean: NaN, std: NaN, finite: 0, constant: true } }
}

describe('the dictionary', () => {
  it('holds the research: 930 entries, 839 tokens, confidence 221 / 521 / 188, 174 groups', () => {
    expect(CHANNEL_ROWS).toHaveLength(930)
    expect(new Set(CHANNEL_ROWS.map((row) => row[0])).size).toBe(839)
    const confidence = { h: 0, m: 0, l: 0 }
    for (const row of CHANNEL_ROWS) confidence[row[10]] += 1
    expect(confidence).toEqual({ h: 221, m: 521, l: 188 })
    expect(GROUP_ROWS).toHaveLength(174)
    expect(GROUP_ROWS[173][0]).toBe('legacy-rows')
    expect(new Set(CHANNEL_ROWS.map((row) => `${row[0]}#${row[1]}`)).size).toBe(930)
  })

  it('lifts the 53 context rules into data and keeps them out of the visible notes', () => {
    const rules = CHANNEL_ROWS.filter((row) => row[11])
    expect(rules).toHaveLength(53)
    const tokens = new Set(CHANNEL_ROWS.map((row) => row[0]))
    for (const row of rules) {
      const rule = row[11]!
      const kinds = [rule.after, rule.before, rule.notAfter, rule.orderOnly, rule.nthInFile].filter((x) => x !== undefined)
      expect(kinds.length, row[0]).toBeGreaterThan(0)
      for (const token of [...(rule.after ?? []), ...(rule.before ?? []), ...(rule.notAfter ?? [])]) expect(tokens.has(token), token).toBe(true)
      if (rule.block) expect(tokens.has(rule.block.marker)).toBe(true)
    }
    expect(entryFor('_side,___lb', 1)?.context).toEqual({ after: ['_drag,___lb'] })
    expect(entryFor('stat1,__deg', 2)?.context).toEqual({ orderOnly: true })
    expect(entryFor('____P,deg/s', 1)?.context).toEqual({ notAfter: ['acc-z,_m/ss'] })
    for (const entry of entries) expect(texts(entry.meta)).not.toMatch(/Context:/)
  })

  it('gives every entry a known meaning with a label, a short name of at most 16 characters, a clean unit and a quantity', () => {
    for (const entry of entries) {
      const key = `${entry.token}#${entry.occurrence}`
      const { meta } = entry
      expect(meta.known, key).toBe(true)
      expect(meta.label.trim(), key).not.toBe('')
      expect(meta.short.trim(), key).not.toBe('')
      expect(meta.short.length, `${key} ${meta.short}`).toBeLessThanOrEqual(16)
      expect(UNITS.has(meta.unit), `${key} ${meta.unit}`).toBe(true)
      expect(QUANTITIES, key).toContain(meta.quantity as Quantity)
      if (!['ratio', 'flag', 'other'].includes(meta.quantity)) expect(meta.unit, key).not.toBe('')
      expect(meta.description?.trim(), key).toBeTruthy()
    }
  })

  it('gives each occurrence of a repeated token its own label', () => {
    const labels = new Map<string, Set<string>>()
    const counts = new Map<string, number>()
    for (const entry of entries) {
      labels.set(entry.token, (labels.get(entry.token) ?? new Set()).add(entry.meta.label))
      counts.set(entry.token, (counts.get(entry.token) ?? 0) + 1)
    }
    for (const [token, n] of counts) expect(labels.get(token)?.size, token).toBe(n)
  })

  it('keeps descriptions to two sentences', () => {
    const sentences = (text: string) => (text.replace(/\b(e\.g|i\.e|vs)\./g, 'x').match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [text]).length
    for (const entry of entries) expect(sentences(entry.meta.description ?? ''), entry.token).toBeLessThanOrEqual(2)
  })

  it('marks inferred meanings in the notes, and only those', () => {
    let low = 0
    for (const entry of entries) {
      const marked = (entry.meta.notes ?? '').endsWith(LOW_CONFIDENCE_NOTE)
      expect(marked, entry.token).toBe(entry.confidence === 'l')
      if (marked) low += 1
    }
    expect(low).toBe(188)
  })

  it('keeps 169 legacy aliases that name what X-Plane 12 writes instead', () => {
    const legacy = entries.filter((entry) => /^Legacy/.test(entry.meta.notes ?? ''))
    expect(legacy).toHaveLength(169)
    expect(describeChannel('____Q,rad/s', 1)).toMatchObject({ group: 'angular-velocities', unit: 'rad/s', short: 'Q', known: true })
    expect(describeChannel('hpath,__deg', 1).notes).toContain('`hpath,_true`')
  })

  it('applies every override to an existing entry', () => {
    for (const key of Object.keys(OVERRIDES)) {
      const [token, occurrence] = [key.slice(0, key.lastIndexOf('#')), Number(key.slice(key.lastIndexOf('#') + 1))]
      expect(entryFor(token, occurrence), key).toBeDefined()
    }
  })

  it('carries the pitfalls students hit most', () => {
    const vvi = describeChannel('__VVI,__fpm', 1)
    expect(vvi.short).toBe('VVI')
    expect(vvi.notes).toMatch(/lags the true climb rate/)
    // The true (geometric) climb rate comes from the CG altitude; pressure altitude follows it only in ISA weather.
    expect(vvi.notes).toMatch(/differentiate `___CG,ftMSL`/)
    expect(vvi.notes).toMatch(/`p-alt,ftMSL` matches it only in ISA weather/)
    expect(describeChannel('p-alt,ftMSL', 1).notes).toMatch(/only in ISA weather/)
    const total = describeChannel('total,___lb', 1)
    expect(total.notes).toMatch(/empty \+ payload \+ fuel \+ jettisonable \+ ice/)
    expect(total.description).toMatch(/empty \+ payload \+ fuel \+ jettisonable \+ ice/)
    expect(describeChannel('gross,___lb', 1).notes).toMatch(/NOT the current weight/)
    expect(describeChannel('gross,___lb', 1).notes).not.toMatch(/empty \+ payload \+ fuel\)/)
    expect(describeChannel('_beta,__deg', 1).sign).toMatch(/opposite to the usual textbook β/)
    expect(describeChannel('elev1,__deg', 1).sign).toMatch(/trailing edge DOWN/)
    // The Flight controls ratios are fractions of full travel, not angles, and _elev,_surf is + nose-up: the opposite
    // sign of elev1,__deg. Their short names (legends, axis titles) must not read like the angle.
    const elevator = describeChannel('_elev,_surf', 1)
    expect(elevator).toMatchObject({ short: 'Elevator ratio', unit: '' })
    expect(elevator.sign).toMatch(/nose-up/)
    expect(describeChannel('ailrn,_surf', 1).short).toBe('Aileron ratio')
    expect(describeChannel('ruddr,_surf', 1).short).toBe('Rudder ratio')
    // The local OpenGL frame is not a pair of plot axes, and its Y is not altitude.
    expect(['____X,____m', '____Y,____m', '____Z,____m', '___vY,__m/s'].map((token) => describeChannel(token, 1).short)).toEqual([
      'X local',
      'Y local',
      'Z local',
      'vY local',
    ])
  })

  it('contains nothing measured in private flight logs', () => {
    // Version numbers ("12.0.8") are fine; any other number of three or more digits must be a documented constant,
    // a convention (squawk 1200, frequencies in kHz) or a Data Output row index.
    const allowed = new Set([
      '0.0023769', '0.7376', '1.15078', '1.225', '57.2958', '6076.12', '29.92', '3600', '360', '100', '1200', '2700',
      '11030', '110.30', '119900', '119.900', '737', '127', '135', '136', '137', '138', '140', '148', '150', '151', '152',
      '167', '340', '12.0', '12.4',
    ])
    // Approximate constants with a unit ("lags about … s", "τ ≈ … s", "mask about … s") are what numerical checks on a
    // log measure, however small. Each one must be a documented value or come from a public log, and be listed here.
    const approximate =
      /(?:\b(?:about|approx(?:imately)?|roughly|around|nearly)\s+|[≈~]\s*)[+−-]?\d+(?:[.,]\d+)?\s*(?:s|ms|sec|min|h|ft|m|km|nm|kt|mph|fpm|°|deg|%|lb|g)(?![A-Za-z0-9])/gi
    const documented = new Set([
      'about 6 lb', // avgas density, lb per US gallon
      'about −90°', // propeller-disc angle of attack in cruise, from a public X-Plane 12 log
    ])
    // The guard itself: it must catch the usual phrasings (made-up values).
    const once = new RegExp(approximate.source, 'i')
    for (const phrase of ['lags about 3 s', 'τ ≈ 4 s', 'mask roughly 5 s', '~7 kt low', 'about −6 ft', 'around 9%', 'nearly 3°'])
      expect(once.test(phrase), phrase).toBe(true)
    for (const phrase of ['about 0 in steady flight', 'about +sin θ', '20–25 /s', 'e.g. below 40 kt']) expect(once.test(phrase), phrase).toBe(false)

    const groupTexts = allGroups().map((group) => `${group.name} | ${group.description}`)
    const guideTexts = [
      ...recordingSteps(),
      ...loggingGuide().flatMap((rec) => [rec.title, rec.summary, ...rec.rows.map((row) => row.why)]),
    ]
    for (const text of [...entries.map((entry) => texts(entry.meta)), ...groupTexts, ...guideTexts]) {
      expect(text).not.toMatch(/\b(737|C172|Cessna)\b[^.]*\blogs?\b/i)
      expect(text).not.toMatch(/\blogs?\b[^.]*\b(737|C172)\b/i)
      expect(text).not.toMatch(/737-800|\b(correlation|corr|rms)\b|\b(the user|user's|student)\b/i)
      const numbers = text.replace(/\b\d+\.\d+\.\d+\b/g, '').match(/(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []
      for (const number of numbers) {
        if (number.replace(/\D/g, '').replace(/^0+/, '').length >= 3) expect(allowed.has(number), `${number} in: ${text}`).toBe(true)
      }
      for (const match of text.matchAll(approximate)) expect(documented.has(match[0]), `"${match[0]}" in: ${text}`).toBe(true)
    }
  })
})

describe('groups', () => {
  it('lists the X-Plane 12 rows in display order, then the legacy rows, Formulas and Other', () => {
    const groups = allGroups()
    expect(groups).toHaveLength(176)
    expect(groups.slice(0, 5).map((group) => group.id)).toEqual(['frame-rate', 'times', 'sim-stats', 'speeds', 'mach-vvi-gload'])
    expect(groups[173].id).toBe('legacy-rows')
    expect(groups.slice(-2).map((group) => [group.id, group.name, group.order])).toEqual([
      ['derived', 'Formulas', 9000],
      ['other', 'Other', 9999],
    ])
    groups.slice(0, 174).forEach((group, i) => expect(group.order).toBe(i))
    expect(groupById('speeds')).toMatchObject({ name: 'Speeds', index: 3 })
    expect(groupById('angular-accelerations').index).toBe(167)
    expect(groupById('runway-conditions').index).toBeNull()
    expect(groupById('no-such-row')).toMatchObject({ id: 'other', name: 'Other' })
  })

  it('has a group for every channel', () => {
    const ids = new Set(allGroups().map((group) => group.id))
    for (const entry of entries) expect(ids.has(entry.meta.group), entry.token).toBe(true)
    expect(ids.has(describeChannel('nothing,known', 1).group)).toBe(true)
  })
})

describe('describeChannel', () => {
  it('returns the dictionary entry of a token and occurrence, as a fresh object', () => {
    expect(describeChannel('_Vind,_kias', 1)).toMatchObject({ label: 'Indicated airspeed', short: 'KIAS', unit: 'kt', group: 'speeds', known: true })
    expect(describeChannel('_side,___lb', 2)).toMatchObject({ group: 'gear-forces', short: 'Gear side' })
    expect(describeChannel('elev1,__deg', 2).label).not.toBe(describeChannel('elev1,__deg', 1).label)
    const meta = describeChannel('alpha,__deg', 1)
    meta.label = 'changed'
    expect(describeChannel('alpha,__deg', 1).label).toBe('Angle of attack')
    expect(describeChannel('sync_,butn\u0000', 1)).toMatchObject({ group: 'ap-modes', known: true })
  })

  it('derives engines and tanks beyond the dictionary from the engine-1 / tank-1 entry', () => {
    const cases: [string, string, string, string][] = [
      ['N1__3,_pcnt', 'N1__1,_pcnt', 'N1, engine 3', 'N1 eng 3'],
      ['thrst,_4,lb', 'thrst,_1,lb', 'Thrust, engine 4', 'Thrust eng 4'],
      ['FF__5,_lb/h', 'FF__1,_lb/h', 'Fuel flow, engine 5', 'FF eng 5'],
      ['fuel4,___lb', 'fuel1,___lb', 'Fuel tank 4', 'Tank 4'],
    ]
    for (const [token, template, label, short] of cases) {
      const meta = describeChannel(token, 1)
      const base = describeChannel(template, 1)
      expect(meta, token).toMatchObject({ label, short, unit: base.unit, quantity: base.quantity, group: base.group, known: true })
    }
    expect(describeChannel('N1__3,_pcnt', 1).notes).toBe('Pattern match: engine 3 (from the engine-1 entry).')
    expect(describeChannel('fuel4,___lb', 1).notes).toBe('Pattern match: tank 4 (from the tank-1 entry).')
    expect(describeChannel('thrst,_4,lb', 1).description).toBe('Net thrust of engine 4.')
    // Only exact shapes: a different unit field or a flight level is not an engine number.
    expect(describeChannel('N1__3,_pcnx', 1).known).toBe(false)
    expect(describeChannel('+-ISA,FL240', 1).known).toBe(false)
  })

  it('names unknown X-Plane tokens from their text and normalises the unit', () => {
    expect(describeChannel('ab_cd,__deg', 1)).toEqual({ label: 'ab cd', short: 'ab cd', unit: 'deg', quantity: 'angle', group: 'other', known: false })
    const units: [string, string, string][] = [
      ['zzzzz,_kias', 'kt', 'speed'],
      ['zzzzz,_keas', 'kt', 'speed'],
      ['zzzzz,_ktas', 'kt', 'speed'],
      ['zzzzz,_ktgs', 'kt', 'speed'],
      ['zzzzz,__deg', 'deg', 'angle'],
      ['zzzzz,deg/s', 'deg/s', 'angular-rate'],
      ['zzzzz,_d/ss', 'deg/s²', 'angular-accel'],
      ['zzzzz,__fpm', 'fpm', 'speed'],
      ['zzzzz,ftMSL', 'ft', 'length'],
      ['zzzzz,ftagl', 'ft', 'length'],
      ['zzzzz,___lb', 'lb', 'mass'],
      ['zzzzz,lb-ft', 'lb·ft', 'moment'],
      ['zzzzz,ft-lb', 'lb·ft', 'moment'],
      ['zzzzz,_pcnt', '%', 'percent'],
      ['zzzzz,__psi', 'psi', 'pressure'],
      ['zzzzz,_lb/h', 'lb/h', 'flow'],
      ['zzzzz,lblbh', 'lb/(lb·h)', 'other'],
      ['zzzzz,__rpm', 'rpm', 'rpm'],
      ['zzzzz,___hp', 'hp', 'power'],
      ['zzzzz,__0/1', '', 'flag'],
      ['zzzzz,ft*ft', 'ft²', 'other'],
      ['zzzzz,_time', 's', 'time'],
      ['zzzzz,ratio', '', 'ratio'],
    ]
    for (const [token, unit, quantity] of units) expect(describeChannel(token, 1), token).toMatchObject({ label: 'zzzzz', unit, quantity, known: false })
    expect(describeChannel('zzzzz,_type', 1)).toMatchObject({ label: 'zzzzz type', unit: '' })
    expect(describeChannel('zzzzz,__deg', 2)).toMatchObject({ label: 'zzzzz (2)', short: 'zzzzz (2)' })
  })

  it('splits the unit out of CSV headers and keeps the label free of it', () => {
    expect(describeChannel('Time (s)', 1)).toEqual({ label: 'Time', short: 'Time', unit: 's', quantity: 'time', group: 'other', known: false })
    expect(describeChannel('Airspeed (kt)', 1)).toMatchObject({ label: 'Airspeed', unit: 'kt', quantity: 'speed' })
    expect(describeChannel('alpha [deg]', 1)).toMatchObject({ label: 'alpha', unit: 'deg', quantity: 'angle' })
    expect(describeChannel('time_s', 1)).toMatchObject({ label: 'time', unit: 's' })
    expect(describeChannel('Roll_Rate_deg_sec', 1)).toMatchObject({ label: 'Roll Rate', unit: 'deg/s' })
    expect(describeChannel('KIAS [kts]', 1)).toMatchObject({ label: 'KIAS', unit: 'kt' })
    expect(describeChannel('beta', 1)).toMatchObject({ label: 'beta', short: 'beta', unit: '', known: false })
    expect(describeChannel('Time (s)', 2).label).toBe('Time (2)')
  })

  it('numbers repeats of a numbered token beyond the dictionary, and marks other repeats', () => {
    expect(describeChannel('_gear,__rat', 5)).toMatchObject({ label: 'Gear 5 deployment', short: 'Gear 5 deploy', known: true })
    expect(describeChannel('fadec,__0/1', 3)).toMatchObject({ short: 'FADEC eng 3', known: true })
    expect(describeChannel('elev1,__deg', 3)).toMatchObject({ short: 'δe right (3)', group: 'elevator-deflections', known: true })
  })
})

describe('channelTitle', () => {
  it('is "<short> [<unit>]", or the short alone without a unit', () => {
    expect(channelTitle(channel(describeChannel('_Vind,_kias', 1)))).toBe('KIAS [kt]')
    expect(channelTitle(channel(describeChannel('_Mach,ratio', 1)))).toBe('Mach')
    expect(channelTitle(channel(describeChannel('Time (s)', 1)))).toBe('Time [s]')
  })
})
