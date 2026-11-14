// Readable names for columns the dictionary does not know: X-Plane-style "name,unit" tokens and CSV headers such as
// "Airspeed (kt)", "alpha [deg]" or "time_s". Units are normalised to the app's spelling and a quantity is guessed.

import type { ChannelMeta } from '../types'
import type { Quantity } from './schema'

/** Unit field of an X-Plane token (underscores removed, lower case) -> display unit. */
const XPLANE_UNITS: Readonly<Record<string, string>> = {
  kias: 'kt',
  keas: 'kt',
  ktas: 'kt',
  ktgs: 'kt',
  kt: 'kt',
  kts: 'kt',
  knots: 'kt',
  mph: 'mph',
  mphas: 'mph',
  mphgs: 'mph',
  deg: 'deg',
  'deg/s': 'deg/s',
  'd/s': 'deg/s',
  'd/sec': 'deg/s',
  'rad/s': 'rad/s',
  'd/ss': 'deg/s²',
  fpm: 'fpm',
  ftmsl: 'ft',
  ftagl: 'ft',
  ftref: 'ft',
  ft: 'ft',
  feet: 'ft',
  m: 'm',
  'm/s': 'm/s',
  'm/ss': 'm/s²',
  fts2: 'ft/s²',
  nm: 'nm',
  sm: 'mi',
  lb: 'lb',
  lbs: 'lb',
  'lb-ft': 'lb·ft',
  'ft-lb': 'lb·ft',
  ftlb: 'lb·ft',
  'n-mtr': 'N·m',
  hp: 'hp',
  rpm: 'rpm',
  pcnt: '%',
  psi: 'psi',
  psf: 'psf',
  inhg: 'inHg',
  'lb/h': 'lb/h',
  pph: 'lb/h',
  'gal/h': 'gal/h',
  gph: 'gal/h',
  gal: 'gal',
  lblbh: 'lb/(lb·h)',
  lbhph: 'lb/(hp·h)',
  '0/1': '',
  ratio: '',
  part: '',
  'ft*ft': 'ft²',
  time: 's',
  sec: 's',
  '/sec': '1/s',
  hours: 'h',
  min: 'min',
  degc: '°C',
  degf: '°F',
  volt: 'V',
  amp: 'A',
  watt: 'W',
  kg: 'kg',
  km: 'km',
  pa: 'Pa',
  hpa: 'hPa',
  kpa: 'kPa',
}

/** Raw unit fields that mean "no unit" but say what kind of number it is. */
const UNITLESS_QUANTITY: Readonly<Record<string, Quantity>> = { '0/1': 'flag', ratio: 'ratio', part: 'ratio' }

/** Display unit -> quantity. */
const UNIT_QUANTITY: Readonly<Record<string, Quantity>> = {
  kt: 'speed',
  mph: 'speed',
  'm/s': 'speed',
  fpm: 'speed',
  'km/h': 'speed',
  deg: 'angle',
  rad: 'angle',
  'deg/s': 'angular-rate',
  'rad/s': 'angular-rate',
  'deg/s²': 'angular-accel',
  ft: 'length',
  m: 'length',
  nm: 'length',
  mi: 'length',
  km: 'length',
  lb: 'mass',
  kg: 'mass',
  N: 'force',
  'lb·ft': 'moment',
  'N·m': 'moment',
  hp: 'power',
  W: 'power',
  kW: 'power',
  rpm: 'rpm',
  '%': 'percent',
  psi: 'pressure',
  psf: 'pressure',
  inHg: 'pressure',
  Pa: 'pressure',
  hPa: 'pressure',
  kPa: 'pressure',
  '°C': 'temperature',
  '°F': 'temperature',
  K: 'temperature',
  'lb/h': 'flow',
  'gal/h': 'flow',
  'kg/s': 'flow',
  s: 'time',
  ms: 'time',
  min: 'time',
  h: 'time',
  g: 'ratio',
}

/** A display unit for an X-Plane unit field ("_kias" -> "kt"); undefined when it is not a recognised unit. */
export function xplaneUnit(field: string): string | undefined {
  const key = field.replace(/_/g, '').trim().toLowerCase()
  return Object.hasOwn(XPLANE_UNITS, key) ? XPLANE_UNITS[key] : undefined
}

/** Quantity guessed from a display unit (and the raw field, for unit-less ratios and on/off flags). */
export function quantityForUnit(unit: string, rawField = ''): Quantity {
  if (unit) return Object.hasOwn(UNIT_QUANTITY, unit) ? UNIT_QUANTITY[unit] : 'other'
  const key = rawField.replace(/_/g, '').trim().toLowerCase()
  return Object.hasOwn(UNITLESS_QUANTITY, key) ? UNITLESS_QUANTITY[key] : 'other'
}

/** Units written by hand in CSV headers (lower case) -> display unit ("kts" -> "kt", "deg/sec" -> "deg/s"). */
const CSV_UNITS: Readonly<Record<string, string>> = {
  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  ms: 'ms',
  min: 'min',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  kt: 'kt',
  kts: 'kt',
  knots: 'kt',
  kias: 'kt',
  ktas: 'kt',
  mph: 'mph',
  'km/h': 'km/h',
  kmh: 'km/h',
  'm/s': 'm/s',
  mps: 'm/s',
  fpm: 'fpm',
  'ft/min': 'fpm',
  deg: 'deg',
  degs: 'deg',
  degrees: 'deg',
  '°': 'deg',
  rad: 'rad',
  'deg/s': 'deg/s',
  'deg/sec': 'deg/s',
  dps: 'deg/s',
  'rad/s': 'rad/s',
  'deg/s2': 'deg/s²',
  'deg/s²': 'deg/s²',
  ft: 'ft',
  feet: 'ft',
  m: 'm',
  km: 'km',
  nm: 'nm',
  lb: 'lb',
  lbs: 'lb',
  lbf: 'lb',
  kg: 'kg',
  n: 'N',
  'lb·ft': 'lb·ft',
  'lb-ft': 'lb·ft',
  'ft-lb': 'lb·ft',
  'n·m': 'N·m',
  hp: 'hp',
  w: 'W',
  kw: 'kW',
  rpm: 'rpm',
  '%': '%',
  pct: '%',
  percent: '%',
  psi: 'psi',
  psf: 'psf',
  inhg: 'inHg',
  pa: 'Pa',
  hpa: 'hPa',
  kpa: 'kPa',
  '°c': '°C',
  degc: '°C',
  c: '°C',
  '°f': '°F',
  degf: '°F',
  k: 'K',
  'lb/h': 'lb/h',
  'lb/hr': 'lb/h',
  pph: 'lb/h',
  'gal/h': 'gal/h',
  gph: 'gal/h',
  g: 'g',
  '-': '',
}

/** Unambiguous snake-case unit suffixes ("time_s", "alt_ft", "Roll_Rate_deg_sec"). */
const CSV_SUFFIXES: readonly (readonly [RegExp, string])[] = [
  [/[_\s]+deg[_\s]+(?:per[_\s]+)?(?:s|sec)$/i, 'deg/s'],
  [/[_\s]+rad[_\s]+(?:per[_\s]+)?(?:s|sec)$/i, 'rad/s'],
  [/[_\s]+(?:s|sec|secs|seconds)$/i, 's'],
  [/[_\s]+(?:deg|degs|degrees)$/i, 'deg'],
  [/[_\s]+rad$/i, 'rad'],
  [/[_\s]+(?:kt|kts|knots)$/i, 'kt'],
  [/[_\s]+(?:ft|feet)$/i, 'ft'],
  [/[_\s]+m$/i, 'm'],
  [/[_\s]+mps$/i, 'm/s'],
  [/[_\s]+fpm$/i, 'fpm'],
  [/[_\s]+(?:lb|lbs)$/i, 'lb'],
  [/[_\s]+(?:pct|percent)$/i, '%'],
  [/[_\s]+psi$/i, 'psi'],
  [/[_\s]+rpm$/i, 'rpm'],
  [/[_\s]+hp$/i, 'hp'],
  [/[_\s]+g$/i, 'g'],
]

const spaced = (text: string) => text.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()

function withOccurrence(label: string, unit: string, quantity: Quantity, occurrence: number): ChannelMeta {
  const name = occurrence > 1 ? `${label} (${occurrence})` : label
  return { label: name, short: name, unit, quantity, group: 'other', known: false }
}

/** "Airspeed (kt)" -> { label "Airspeed", unit "kt" }; "time_s" -> { "time", "s" }; a plain name has no unit. */
export function splitCsvHeader(header: string): { label: string; unit: string } {
  const text = header.trim()
  const bracket = /^(.*?)[\s_]*[([]\s*([^)\]]*?)\s*[)\]]\s*$/.exec(text)
  if (bracket && bracket[1].trim()) {
    const raw = bracket[2].trim()
    const key = raw.toLowerCase()
    return { label: spaced(bracket[1]), unit: Object.hasOwn(CSV_UNITS, key) ? CSV_UNITS[key] : raw }
  }
  for (const [suffix, unit] of CSV_SUFFIXES) {
    const match = suffix.exec(text)
    if (match && match.index > 0) return { label: spaced(text.slice(0, match.index)), unit }
  }
  return { label: spaced(text) || text, unit: '' }
}

/**
 * Meaning of a column the dictionary does not know (known: false, group 'other').
 * X-Plane-style tokens: underscores are padding and the field after the last comma is the unit when it is one
 * ("ab_cd,__deg" -> label "ab cd", unit "deg"; "abcde,_type" -> label "abcde type", no unit). CSV headers: a unit in
 * brackets or a snake-case unit suffix is split off, so the label stays free of it ("Time (s)" -> "Time", "s").
 * A repeated header gets " (2)", " (3)"… on its label and short.
 */
export function fallbackMeta(token: string, occurrence: number): ChannelMeta {
  const text = token.trim()
  if (text.includes(',')) {
    const parts = text.split(',')
    const last = parts[parts.length - 1]
    const unit = xplaneUnit(last)
    const nameParts = unit === undefined ? parts : parts.slice(0, -1)
    const label = nameParts.map(spaced).filter(Boolean).join(' ') || text
    return withOccurrence(label, unit ?? '', quantityForUnit(unit ?? '', last), occurrence)
  }
  const { label, unit } = splitCsvHeader(text)
  return withOccurrence(label || text, unit, quantityForUnit(unit), occurrence)
}
