// Steady, level flight: finds the stretches of a log where the speed holds (its scatter and its trend both within a
// tolerance), the vertical speed is near zero, the wings are level and still, and the power setting does not move, for
// at least a minimum time — the trim points of a performance or stability test, found without dragging across each one
// by hand.
//
// O(n) per segment: prefix sums give any window's mean, scatter and least-squares trend in O(1).
//   1. A running window of a few seconds centred on each row marks the rows that are not in a manoeuvre: the speed's
//      trend across those seconds and its scatter within the tolerance, level, wings level and still, faster than the
//      floor.
//   2. Runs of such rows (a dip shorter than the running window, a gust, is bridged) are the candidate stretches.
//   3. Each run is cut into its longest windows that pass as a whole (scatter 2σ and trend × duration within the
//      tolerance, mean vertical speed within its tolerance and its swings within twice that, mean bank and its swings
//      within theirs), longest first. The end each start can reach is found once per run (two pointers), so cutting a
//      long run into many windows costs no more tests.
//   4. Each window is trimmed to the stable core of its hold: its ends go while the speed there (smoothed over ±1 s) is
//      more than a quarter of the tolerance off the window's own trend line (the end of the deceleration before it; a
//      steady drift lies on the line and stays). When the file records the power setting (throttle lever, else thrust,
//      engine power, torque or N1), the window is then cut to its longest stretch where that stays within ± a percentage
//      of its level (smoothed over ±1 s), a second short of a power change at its end: the speed lags the throttle by
//      seconds, so the speed alone would keep the throttle being set at the start and pulled for the next point at the
//      end. A window shorter than the minimum after this goes.
//   5. Windows of one run are one hold unless the speed changes by at least the tolerance between them (the transition
//      to the next hold), so holds a few knots apart stay apart while a drifting or settling hold gives one window: the
//      steadiest of its windows, the longer when they are alike.
//   6. Two windows of different runs close together (at most the minimum duration apart) are one hold that a gust
//      interrupted when the whole stretch passes, power included: they become one window. Otherwise both stay.
// Windows never cross a reset or a gap (Dataset.segments). Pure: no React, no DOM.

import { channelById } from '../dataset'
import type { Channel, Dataset, RowRange } from '../types'

/** The channels the search reads. Only `speed` is required. */
export interface SteadyChannels {
  /** The speed to hold: KIAS by default (any airspeed works) */
  speed: Channel
  /** Vertical speed (fpm, or m/s and ft/s converted); null when the file has none */
  vvi: Channel | null
  /** Altitude (ft, or m converted): its drift per minute stands in for the vertical speed when there is none */
  altitude: Channel | null
  /** Bank angle (deg, or rad converted); null to leave it out */
  bank: Channel | null
  /** The power setting: throttle lever, else thrust, engine power, torque or N1; null when the file has none */
  power: Channel | null
}

export interface SteadyOptions {
  /**
   * ± tolerance on the speed, in the speed channel's unit: the scatter (2σ about the trend) and the trend across the
   * window (least-squares drift × duration) must each stay within it.
   */
  speedTol: number
  /**
   * Vertical speed, fpm: its mean must stay within ± this and its swings (σ) within twice this (or, without a
   * vertical-speed channel, the altitude's drift per minute within ± this).
   */
  vviTol: number
  /** Shortest window, seconds (at least 1) */
  minDuration: number
  /** Degrees: the mean bank must stay within ± this and its swings (σ) within BANK_SWING of it; null = not checked */
  bankTol: number | null
  /**
   * Percent: the power setting, smoothed over ±1 s, must stay within ± this share of its level across the window (at
   * least ± 1 % of its range over the file), and its samples within twice that; null = not checked
   */
  powerTol: number | null
  /** Rows slower than this (the speed channel's unit) are on the ground or taxiing: never steady */
  floor: number
  /** Rows to search, [start, end); null or absent = the whole file */
  range?: RowRange | null
  /** The time base the windows' `from` and `to` are read on (one value per row, e.g. a TimeAxis's values); elapsed time when absent */
  time?: ArrayLike<number>
}

export interface SteadyWindow {
  /** Rows [start, end) */
  start: number
  end: number
  /** Duration in elapsed seconds, first to last row */
  seconds: number
  /** The first and last row's time on the time base asked for (elapsed seconds by default) */
  from: number
  to: number
  /** The speed over the window: mean, σ (about the mean) and least-squares drift per minute */
  speed: { mean: number; std: number; drift: number }
  /** Vertical speed mean and σ (fpm); null without a vertical-speed channel */
  vvi: { mean: number; std: number } | null
  /** Altitude drift, ft per minute (least squares); NaN without an altitude channel */
  altDrift: number
  /** Mean bank, degrees; NaN without a bank channel */
  bank: number
  /** The power setting over the window, in its own unit: mean, σ and least-squares drift per minute; null without one */
  power: { mean: number; std: number; drift: number } | null
}

// ------------------------------------------------------------------ channels and defaults

/** X-Plane airspeeds in order of preference: indicated, equivalent, true (kt), then the mph versions. */
const AIRSPEED_IDS = ['_Vind,_kias', '_Vind,_keas', 'Vtrue,_ktas', '_Vind,__mph', 'Vtrue,mphas', 'Vtrue,__mph']
/** Vertical speed: X-Plane's VSI reading */
const VVI_IDS = ['__VVI,__fpm']
/** Altitudes that stand in for the vertical speed: pressure altitude first, then MSL (X-Plane 12, then 10/11) */
const ALTITUDE_IDS = ['p-alt,ftMSL', '___CG,ftMSL', '__alt,ftmsl', '__alt,__ind']
const BANK_IDS = ['_roll,__deg']
/**
 * The power setting, best first: engine 1's throttle lever (X-Plane 12, then 10/11), the throttle reaching it, then its
 * thrust, power, torque and N1. The lever leads: thrust follows it within a second or two and the speed seconds later.
 */
const POWER_IDS = [
  'thro1,handl',
  'thro1,_part',
  'thro1,engin',
  'thrst,_1,lb',
  'engn1,___hp',
  'power,_1,hp',
  'engn1,ft-lb',
  'engn1,trq_%',
  'trq_1,_ftlb',
  'N1__1,_pcnt',
]

/** Knots per unit of each speed unit the search knows (floors and default tolerances are set in knots). */
const KNOTS: Readonly<Record<string, number>> = { kt: 1, mph: 1 / 1.150779, 'm/s': 1 / 0.514444, 'km/h': 1 / 1.852 }
/** Multipliers to the units the vertical-speed, altitude and bank tolerances are set in: fpm, ft and degrees. */
const VVI_SCALE: Readonly<Record<string, number>> = { fpm: 1, 'm/s': 196.850394, 'ft/s': 60 }
const ALTITUDE_SCALE: Readonly<Record<string, number>> = { ft: 1, m: 3.28084 }
const BANK_SCALE: Readonly<Record<string, number>> = { deg: 1, rad: 180 / Math.PI }

const NOT_AIRSPEED = /ground|\bgs\b|wind|gust|vertical|climb|sound|total|nozzle|wash|swirl|\bvs\b|vvi|\bap\b|autopilot|dme/i
const AIRSPEED_WORDS = /air ?speed|\b[kv]?[ict]as\b|\bk?eas\b|\bspeed\b|velocity/i
/** A unit-less column named by an airspeed's abbreviation alone ("KIAS", "TAS"): knots, as pilots write them. */
const BARE_AIRSPEED = /^\s*k?(?:ias|eas|cas|tas)\s*$/i

/** Words that name a target or a setting, not the aircraft's own state ("Selected altitude", "AP VS"). */
const NOT_STATE = /target|select|dial|bug|command|\bcmd\b|autopilot|\bap\b|\bfd\b|limit|trim|demand/i
const VVI_WORDS = /vertical|climb|\bv\/?s\b|\bvvi\b|\bvsi\b|\broc\b|sink|h ?dot/i
const ALTITUDE_WORDS = /\balt\b|altitude|height|elevation|\bmsl\b|press(ure)? ?alt|\bh\b/i
const NOT_ALTITUDE = /terrain|ground|\bagl\b|radar|radio|\bra\b|cabin|density|distance|range/i
const BANK_WORDS = /bank|\broll\b|\bphi\b|φ/i
const NOT_BANK = /rate|aileron|wheel|stick|yoke/i
/** CSV columns that give the power setting, best first: throttle, thrust, power, torque, N1. */
const POWER_WORDS: readonly RegExp[] = [
  /throttle|\bthr\b|\bpla\b|\btla\b|power lever/i,
  /thrust/i,
  /\bpower\b|\bhp\b|\bshp\b/i,
  /torque|\btrq\b/i,
  /\bn1\b/i,
]
const POWER_KINDS = ['Throttle', 'Thrust', 'Power', 'Torque', 'N1'] as const
const NOT_POWER = /required|available|excess|specific|loading|weight|coefficient/i

/** The text a channel is recognised by: its label and its header token. */
const nameOf = (ch: Pick<Channel, 'meta' | 'token'>) => `${ch.meta.label} ${ch.token}`

/** How strongly a CSV airspeed's name says which airspeed it is: indicated first, then equivalent / calibrated, true. */
function airspeedRank(ch: Channel): number {
  const text = nameOf(ch)
  if (/\bk?ias\b|indicated/i.test(text)) return 0
  if (/\bk?[ec]as\b|equivalent|calibrated/i.test(text)) return 1
  if (/\bk?tas\b|true/i.test(text)) return 2
  return 3
}

/**
 * The airspeed channels a hold can be judged on, best first: KIAS, KEAS, KTAS (then their mph versions), then any
 * other channel whose unit is a speed and whose name says airspeed (a CSV "Airspeed (kt)"), or a unit-less column
 * named "KIAS", "IAS", "TAS"… (taken as knots, see speedUnit). Never ground speed or a vertical speed.
 */
export function airspeedChannels(ds: Dataset): Channel[] {
  const known = AIRSPEED_IDS.map((id) => channelById(ds, id)).filter((ch): ch is Channel => ch !== undefined)
  const others = ds.channels.filter((ch) => {
    if (known.includes(ch) || ch.derived) return false
    const bare = ch.meta.unit === '' && !ch.meta.known && (BARE_AIRSPEED.test(ch.token) || BARE_AIRSPEED.test(ch.meta.label))
    if (!bare && !Object.hasOwn(KNOTS, ch.meta.unit)) return false
    const text = `${ch.meta.label} ${ch.meta.short} ${ch.token}`
    if (NOT_AIRSPEED.test(text)) return false
    return ch.meta.known ? ch.meta.group === 'speeds' : AIRSPEED_WORDS.test(text)
  })
  others.sort((a, b) => airspeedRank(a) - airspeedRank(b))
  return [...known, ...others].filter((ch) => ch.stats.finite > 2)
}

/** A speed channel's unit for the tolerances and the tables: its own when it is a speed unit, else knots ("KIAS"). */
export function speedUnit(ch: Pick<Channel, 'meta'>): string {
  return Object.hasOwn(KNOTS, ch.meta.unit) ? ch.meta.unit : 'kt'
}

/** A CSV (or unknown) column that gives the vertical speed: fpm, or m/s and ft/s when its name says so. */
function isVerticalSpeed(ch: Channel): boolean {
  const text = nameOf(ch)
  if (!Object.hasOwn(VVI_SCALE, ch.meta.unit) || NOT_STATE.test(text) || /vario|total energy/i.test(text)) return false
  return ch.meta.unit === 'fpm' || VVI_WORDS.test(text)
}

function isAltitude(ch: Channel): boolean {
  const text = nameOf(ch)
  return Object.hasOwn(ALTITUDE_SCALE, ch.meta.unit) && ALTITUDE_WORDS.test(text) && !NOT_ALTITUDE.test(text) && !NOT_STATE.test(text)
}

function isBank(ch: Channel): boolean {
  const text = nameOf(ch)
  return Object.hasOwn(BANK_SCALE, ch.meta.unit) && BANK_WORDS.test(text) && !NOT_BANK.test(text) && !NOT_STATE.test(text)
}

/**
 * The search's channels: `speedId` (else the best airspeed), the vertical speed, an altitude, the bank and the power
 * setting. X-Plane's own columns first; in a CSV (columns the dictionary does not know) they are recognised by unit and
 * name: fpm is a vertical speed, ft or m named "alt", "altitude" or "height" an altitude, deg or rad named "bank",
 * "roll" or "phi" the bank, and a column named throttle, thrust, power, torque or N1 the power setting.
 */
export function steadyChannels(ds: Dataset, speedId?: string | null): SteadyChannels | null {
  const speeds = airspeedChannels(ds)
  const speed = (speedId ? speeds.find((ch) => ch.id === speedId) : undefined) ?? speeds[0]
  if (!speed) return null
  const usable = (ch: Channel | undefined): ch is Channel => ch !== undefined && ch.stats.finite > 2
  const first = (ids: readonly string[]) => ids.map((id) => channelById(ds, id)).find(usable) ?? null
  const unknown = ds.channels.filter((ch) => !ch.meta.known && !ch.derived && ch !== speed && usable(ch))
  const varies = (ch: Channel | undefined): ch is Channel => usable(ch) && !ch.stats.constant
  const named = POWER_WORDS.map((words) =>
    unknown.find((ch) => varies(ch) && words.test(nameOf(ch)) && !NOT_POWER.test(nameOf(ch)) && !NOT_STATE.test(nameOf(ch))),
  )
  return {
    speed,
    vvi: first(VVI_IDS) ?? unknown.find(isVerticalSpeed) ?? null,
    altitude: first(ALTITUDE_IDS) ?? unknown.find(isAltitude) ?? null,
    bank: first(BANK_IDS) ?? unknown.find(isBank) ?? null,
    power: POWER_IDS.map((id) => channelById(ds, id)).find(varies) ?? named.find((ch) => ch !== undefined) ?? null,
  }
}

/** What the power channel is, for the dialog: "Throttle", "Thrust", "Power", "Torque" or "N1". */
export function powerKind(ch: Pick<Channel, 'meta' | 'token'>): string {
  const group = ch.meta.group
  if (group.startsWith('throttle')) return 'Throttle'
  if (group === 'engine-thrust') return 'Thrust'
  if (group === 'engine-power') return 'Power'
  if (group === 'engine-torque') return 'Torque'
  if (group === 'n1') return 'N1'
  const at = POWER_WORDS.findIndex((words) => words.test(nameOf(ch)))
  return at >= 0 ? POWER_KINDS[at] : 'Power'
}

/** The defaults: ± 2 kt, ± 100 fpm, 20 s, wings within ± 5°, power within ± 3 %, nothing slower than 40 kt. */
export const STEADY_DEFAULTS = { speedTolKt: 2, vviTol: 100, minDuration: 20, bankTol: 5, powerTol: 3, floorKt: 40 } as const

/** Default options for a speed in `unit` (kt, mph, m/s, km/h; anything else is taken as knots). */
export function steadyDefaults(unit: string): SteadyOptions {
  const perKnot = 1 / (Object.hasOwn(KNOTS, unit) ? KNOTS[unit] : 1)
  return {
    speedTol: Number((STEADY_DEFAULTS.speedTolKt * perKnot).toPrecision(2)),
    vviTol: STEADY_DEFAULTS.vviTol,
    minDuration: STEADY_DEFAULTS.minDuration,
    bankTol: STEADY_DEFAULTS.bankTol,
    powerTol: STEADY_DEFAULTS.powerTol,
    floor: STEADY_DEFAULTS.floorKt * perKnot,
  }
}

/** The multiplier from a channel's unit to the unit a tolerance is set in (1 when the unit is not in the table). */
function scaleOf(ch: Channel, table: Readonly<Record<string, number>>): number {
  return Object.hasOwn(table, ch.meta.unit) ? table[ch.meta.unit] : 1
}

// ------------------------------------------------------------------ prefix sums

/**
 * Prefix sums of a channel's finite samples over rows [from, to): count, Σx, Σx², Σy, Σxy, Σy² with x the time and y
 * the value (times `scale`), each taken from a reference (the first time and the first finite value) so long or offset
 * series keep their precision. Index k holds the sums over rows [from, from + k).
 */
interface Prefix {
  n: Float64Array
  x: Float64Array
  xx: Float64Array
  y: Float64Array
  xy: Float64Array
  yy: Float64Array
  /** The value subtracted from every sample */
  y0: number
}

function prefixSums(values: ArrayLike<number>, time: ArrayLike<number>, from: number, to: number, scale = 1): Prefix {
  const size = to - from + 1
  const p: Prefix = {
    n: new Float64Array(size),
    x: new Float64Array(size),
    xx: new Float64Array(size),
    y: new Float64Array(size),
    xy: new Float64Array(size),
    yy: new Float64Array(size),
    y0: 0,
  }
  for (let i = from; i < to; i += 1) {
    if (Number.isFinite(values[i])) {
      p.y0 = values[i] * scale
      break
    }
  }
  const t0 = time[from]
  for (let i = from, k = 0; i < to; i += 1, k += 1) {
    const v = values[i] * scale
    const t = time[i] - t0
    const ok = Number.isFinite(v) && Number.isFinite(t)
    const y = ok ? v - p.y0 : 0
    const x = ok ? t : 0
    p.n[k + 1] = p.n[k] + (ok ? 1 : 0)
    p.x[k + 1] = p.x[k] + x
    p.xx[k + 1] = p.xx[k] + x * x
    p.y[k + 1] = p.y[k] + y
    p.xy[k + 1] = p.xy[k] + x * y
    p.yy[k + 1] = p.yy[k] + y * y
  }
  return p
}

/** What a window [a, b) of prefix indices says about its channel. */
interface Moments {
  n: number
  mean: number
  /** Mean time of the samples, seconds from the first row of the prefix */
  tMean: number
  /** σ about the mean (n − 1) */
  std: number
  /** Least-squares slope per second; NaN with fewer than 3 samples or no time spread */
  slope: number
  /** σ of the residuals about the least-squares line (n − 2); NaN with fewer than 3 samples */
  residual: number
}

function moments(p: Prefix, a: number, b: number): Moments {
  const n = p.n[b] - p.n[a]
  if (n < 1) return { n: 0, mean: NaN, tMean: NaN, std: NaN, slope: NaN, residual: NaN }
  const sx = p.x[b] - p.x[a]
  const sy = p.y[b] - p.y[a]
  const mx = sx / n
  const my = sy / n
  const sxx = Math.max(0, p.xx[b] - p.xx[a] - sx * mx)
  const syy = Math.max(0, p.yy[b] - p.yy[a] - sy * my)
  const sxy = p.xy[b] - p.xy[a] - sx * my
  const std = n > 1 ? Math.sqrt(syy / (n - 1)) : 0
  if (n < 3 || !(sxx > 0)) return { n, mean: my + p.y0, tMean: mx, std, slope: NaN, residual: NaN }
  const slope = sxy / sxx
  const residual = Math.sqrt(Math.max(0, syy - slope * sxy) / (n - 2))
  return { n, mean: my + p.y0, tMean: mx, std, slope, residual }
}

// ------------------------------------------------------------------ the search

/** Half-width (s) of the running window that judges each row where it is: a quarter of the shortest window, 2–10 s. */
export function localHalfWidth(minDuration: number): number {
  return Math.min(10, Math.max(2, minDuration / 4))
}

/** Half-width (s) of the smoothing that judges a window's ends when they are trimmed, and of the power setting's. */
const TRIM_SMOOTHING_S = 1
/**
 * The bank's swings (σ) may be at most this share of the bank tolerance (2° for ± 5°): turbulence rocks the wings by a
 * degree or so, a dutch roll or wing rock by several.
 */
export const BANK_SWING = 0.4
/** The power setting's band is never narrower than ± this share of its range over the file. */
const POWER_FLOOR = 0.01
/** Seconds a window ends before a power change at its end: thrust follows the lever, and the speed follows both. */
const POWER_LAG_S = 1

/**
 * Steady, level windows in the dataset, in time order (see the comment at the top for the method). Windows that
 * overlap existing test points are NOT left out here: the caller decides what to do with them.
 */
export function findSteadyWindows(ds: Dataset, channels: SteadyChannels, options: SteadyOptions): SteadyWindow[] {
  const time = ds.elapsed
  const n = Math.min(ds.rowCount, time.length)
  const range = options.range ?? null
  const lo = range ? Math.max(0, Math.min(n, Math.floor(range[0]))) : 0
  const hi = range ? Math.max(lo, Math.min(n, Math.ceil(range[1]))) : n
  const speedTol = options.speedTol
  const minDuration = Math.max(1, Number.isFinite(options.minDuration) ? options.minDuration : 0)
  if (!(speedTol > 0) || !(options.vviTol >= 0) || hi - lo < 3) return []
  const settings: SteadyOptions = { ...options, speedTol, minDuration }
  const out: SteadyWindow[] = []
  const segments = ds.segments.length ? ds.segments : [{ start: 0, end: n, reason: 'start' as const }]
  for (const segment of segments) {
    const from = Math.max(lo, segment.start)
    const to = Math.min(hi, segment.end)
    if (to - from < 3 || time[to - 1] - time[from] < minDuration) continue
    out.push(...searchSegment(time, from, to, channels, settings))
  }
  return out
}

/** A window [a, b) of prefix indices and the run it came from. */
interface Found {
  a: number
  b: number
  run: number
}

function searchSegment(
  time: Float64Array,
  from: number,
  to: number,
  channels: SteadyChannels,
  options: SteadyOptions,
): SteadyWindow[] {
  const { speedTol, vviTol, minDuration, floor } = options
  const bankTol = options.bankTol !== null && Number.isFinite(options.bankTol) ? options.bankTol : null
  const powerTol = options.powerTol !== null && options.powerTol >= 0 && Number.isFinite(options.powerTol) ? options.powerTol : null
  const speed = prefixSums(channels.speed.values, time, from, to)
  const vvi = channels.vvi ? prefixSums(channels.vvi.values, time, from, to, scaleOf(channels.vvi, VVI_SCALE)) : null
  const altitude =
    !vvi && channels.altitude ? prefixSums(channels.altitude.values, time, from, to, scaleOf(channels.altitude, ALTITUDE_SCALE)) : null
  const bank =
    channels.bank && bankTol !== null ? prefixSums(channels.bank.values, time, from, to, scaleOf(channels.bank, BANK_SCALE)) : null
  const m = to - from
  const at = (k: number) => time[from + k]
  /** Duration of prefix window [a, b): first to last row */
  const duration = (a: number, b: number) => (b > a ? at(b - 1) - at(a) : 0)

  /** Level and wings level over [a, b): the same test for a row's running window and for a whole window. */
  const level = (a: number, b: number): boolean => {
    if (vvi) {
      const v = moments(vvi, a, b)
      if (v.n >= 1 && Math.abs(v.mean) > vviTol) return false
      if (v.n > 1 && v.std > 2 * vviTol) return false
    } else if (altitude) {
      const h = moments(altitude, a, b)
      if (Number.isFinite(h.slope) && Math.abs(h.slope * 60) > vviTol) return false
    }
    if (bank && bankTol !== null) {
      const r = moments(bank, a, b)
      if (r.n >= 1 && Math.abs(r.mean) > bankTol) return false
      if (r.n > 1 && r.std > BANK_SWING * bankTol) return false
    }
    return true
  }
  /** The speed holds over [a, b): fast enough, scatter and trend across the window within the tolerance. */
  const holds = (a: number, b: number): boolean => {
    const s = moments(speed, a, b)
    if (s.n < 1 || !(s.mean >= floor)) return false
    if (s.n < 3) return true
    if (!(2 * s.residual <= speedTol)) return false
    return !(Math.abs(s.slope) * duration(a, b) > speedTol)
  }
  const passes = (a: number, b: number) => holds(a, b) && level(a, b)

  // The power setting, smoothed over ±1 s, and the width of the band it must stay in over a window. The samples
  // themselves may swing twice as far (turbulence in the thrust, a pilot nudging the lever), no more: smoothing alone
  // would let the throttle's last swings through as they die down.
  const smoothedPower = channels.power && powerTol !== null ? movingAverage(channels.power.values, time, from, to, TRIM_SMOOTHING_S) : null
  const rawPower = channels.power ? channels.power.values.subarray(from, to) : null
  const powerFloor = channels.power ? POWER_FLOOR * Math.max(0, channels.power.stats.max - channels.power.stats.min) : 0
  /** The bands over [a, b): the smoothed power within ± powerTol % of its level, the samples within twice that. */
  const bands = (a: number, b: number): Band[] | null => {
    if (!smoothedPower || !rawPower) return null
    const width = 2 * Math.max(((powerTol ?? 0) / 100) * Math.abs(medianOf(smoothedPower, a, b)), powerFloor)
    if (!Number.isFinite(width)) return null
    return [
      { values: smoothedPower, width },
      { values: rawPower, width: 2 * width },
    ]
  }
  /** The power setting stays within its bands over all of [a, b). */
  const powerSteady = (a: number, b: number): boolean => {
    const set = bands(a, b)
    if (!set) return true
    return set.every(({ values, width }) => {
      let min = Infinity
      let max = -Infinity
      for (let i = a; i < b; i += 1) {
        const v = values[i]
        if (v < min) min = v
        if (v > max) max = v
      }
      return !(max - min > width)
    })
  }
  /** [a, b) cut to its longest stretch of steady power, a second short of a power change at its end; null: none. */
  const powerCore = (a: number, b: number): [number, number] | null => {
    const set = bands(a, b)
    if (!set) return [a, b]
    const best = longestWithin(set, a, b, duration)
    if (!best) return null
    const [start, stop] = best
    let end = stop
    if (stop < b) while (end - start > 2 && at(end - 1) > at(stop - 1) - POWER_LAG_S) end -= 1
    return [start, end]
  }

  // 1. Rows not in a manoeuvre: their centred running window of ±h seconds passes.
  const h = localHalfWidth(minDuration)
  const candidate = new Uint8Array(m)
  let left = 0
  let right = 0
  for (let k = 0; k < m; k += 1) {
    const t = at(k)
    while (at(left) < t - h) left += 1
    if (right < k + 1) right = k + 1
    while (right < m && at(right) <= t + h) right += 1
    if (speed.n[right] - speed.n[left] >= 3 && passes(left, right)) candidate[k] = 1
  }

  // 2. Runs of such rows; a dip no longer than h does not end a run.
  const runs: [number, number][] = []
  let k = 0
  while (k < m) {
    if (!candidate[k]) {
      k += 1
      continue
    }
    const start = k
    let end = k + 1
    while (end < m) {
      if (candidate[end]) {
        end += 1
        continue
      }
      let next = end
      while (next < m && !candidate[next]) next += 1
      if (next < m && at(next) - at(end - 1) <= h) end = next
      else break
    }
    runs.push([start, end])
    k = end
  }

  /** A window cut to the core of its hold (step 4), or null when what is left is too short. */
  const shape = (a: number, b: number): [number, number] | null => {
    let w: [number, number] = [a, b]
    const core = trimEnds(speed, at, a, b, speedTol / 4)
    if (duration(core[0], core[1]) >= minDuration && passes(core[0], core[1])) w = core
    const steadyPower = powerCore(w[0], w[1])
    if (!steadyPower || duration(steadyPower[0], steadyPower[1]) < minDuration) return null
    if (steadyPower[0] === w[0] && steadyPower[1] === w[1]) return w
    // The stretch of steady power: its longest window that still holds (it may take in a drift the rest of the
    // window diluted), trimmed to its core.
    const inner = passes(steadyPower[0], steadyPower[1])
      ? steadyPower
      : longestPassing(passes, steadyPower[0], steadyPower[1], duration)
    if (!inner || duration(inner[0], inner[1]) < minDuration) return null
    const again = trimEnds(speed, at, inner[0], inner[1], speedTol / 4)
    return duration(again[0], again[1]) >= minDuration && passes(again[0], again[1]) ? again : inner
  }
  /** The speed on a window's own trend line at row k (a transition between holds shows as a step between lines). */
  const lineAt = (w: Found, row: number) => {
    const fit = moments(speed, w.a, w.b)
    return fit.mean + (Number.isFinite(fit.slope) ? fit.slope * (at(row) - at(0) - fit.tMean) : 0)
  }
  /** The steadiest window of a hold: long, and less so the more of the tolerance its trend uses. */
  const score = (w: Found) => {
    const s = moments(speed, w.a, w.b)
    const seconds = duration(w.a, w.b)
    const used = Number.isFinite(s.slope) ? Math.min(1, (Math.abs(s.slope) * seconds) / speedTol) : 0
    return seconds * (1 - 0.5 * used)
  }

  // 3–5. The longest passing windows of each run, cut to their cores; one window per hold.
  const found: Found[] = []
  runs.forEach(([a, b], run) => {
    const windows = longestWindows(passes, a, b, duration, minDuration)
      .map(([wa, wb]) => shape(wa, wb))
      .filter((w): w is [number, number] => w !== null)
      .map(([wa, wb]): Found => ({ a: wa, b: wb, run }))
      .sort((x, y) => x.a - y.a)
    let best: Found | null = null
    let last: Found | null = null
    for (const w of windows) {
      const transition = last !== null && Math.abs(lineAt(w, w.a) - lineAt(last, last.b - 1)) >= speedTol
      if (best && !transition) {
        if (score(w) > score(best)) best = w
      } else {
        if (best) found.push(best)
        best = w
      }
      last = w
    }
    if (best) found.push(best)
  })
  found.sort((x, y) => x.a - y.a)

  // 6. One hold a gust interrupted (two runs): two windows close together become one when the whole stretch passes.
  const merged: Found[] = []
  const near = Math.max(minDuration, 2 * h)
  for (const w of found) {
    const last = merged.at(-1)
    if (last && last.run !== w.run && at(w.a) - at(last.b - 1) <= near && passes(last.a, w.b) && powerSteady(last.a, w.b)) {
      merged[merged.length - 1] = { a: last.a, b: w.b, run: w.run }
      continue
    }
    merged.push(w)
  }

  const reported = options.time ?? time
  const powerValues = channels.power?.values
  return merged.map(({ a, b }) => {
    const s = moments(speed, a, b)
    const v = vvi ? moments(vvi, a, b) : null
    const alt = channels.altitude
      ? prefixSums(channels.altitude.values, time, from + a, from + b, scaleOf(channels.altitude, ALTITUDE_SCALE))
      : null
    const altSlope = alt ? moments(alt, 0, b - a).slope : NaN
    const p = powerValues ? moments(prefixSums(powerValues, time, from + a, from + b), 0, b - a) : null
    return {
      start: from + a,
      end: from + b,
      seconds: duration(a, b),
      from: reported[from + a],
      to: reported[from + b - 1],
      speed: { mean: s.mean, std: s.std, drift: Number.isFinite(s.slope) ? s.slope * 60 : NaN },
      vvi: v && v.n > 0 ? { mean: v.mean, std: v.std } : null,
      altDrift: Number.isFinite(altSlope) ? altSlope * 60 : NaN,
      bank: channels.bank ? meanOf(channels.bank.values, from + a, from + b) * scaleOf(channels.bank, BANK_SCALE) : NaN,
      power: p && p.n > 0 ? { mean: p.mean, std: p.std, drift: Number.isFinite(p.slope) ? p.slope * 60 : NaN } : null,
    }
  })
}

/**
 * The longest passing windows of run [a, b), longest first, as many as fit: the longest window, then the longest in
 * what is left on either side of it, and so on, down to the minimum duration.
 *
 * Each cut is searched by two pointers (for each start the end grows while the window still passes; shrinking a
 * passing window nearly always keeps it passing, so the end only moves forward). One sweep of the whole run records
 * where its end stood for every start; a cut's own sweep follows it only until its end meets the run's, after which the
 * two decide alike and the cut reads the record. So cutting a long run into hundreds of windows costs about one sweep.
 */
function longestWindows(
  passes: (a: number, b: number) => boolean,
  a: number,
  b: number,
  duration: (a: number, b: number) => number,
  minDuration: number,
): [number, number][] {
  // The run's sweep: where the end stood for each start, and whether that window passes (a start whose window from
  // further back no longer passes, a hold's flat start having let it run into the ramp after it, has none).
  const endAt = new Int32Array(b - a)
  const passed = new Uint8Array(b - a)
  let end = a
  for (let start = a; start < b; start += 1) {
    if (end < start + 1) end = start + 1
    while (end < b && passes(start, end + 1)) end += 1
    endAt[start - a] = end
    passed[start - a] = passes(start, end) ? 1 : 0
  }
  /** The longest passing window in [pa, pb): what a sweep of [pa, pb) alone finds. */
  const longestIn = (pa: number, pb: number): [number, number] | null => {
    let best: [number, number] | null = null
    let bestSeconds = -1
    let stop = pa
    let synced = false
    for (let start = pa; start < pb; start += 1) {
      let good: boolean
      if (synced && endAt[start - a] < pb) {
        stop = endAt[start - a]
        good = passed[start - a] === 1
      } else {
        if (stop < start + 1) stop = start + 1
        while (stop < pb && passes(start, stop + 1)) stop += 1
        good = passes(start, stop)
        if (stop === endAt[start - a] && stop < pb) synced = true
      }
      if (!good) continue
      const seconds = duration(start, stop)
      if (seconds > bestSeconds) {
        best = [start, stop]
        bestSeconds = seconds
      }
      // Every later start ends by pb too, so its window is shorter.
      if (stop >= pb) break
    }
    return best
  }
  const out: [number, number][] = []
  const pending: [number, number][] = [[a, b]]
  while (pending.length) {
    const [pa, pb] = pending.pop() as [number, number]
    if (duration(pa, pb) < minDuration) continue
    const best = longestIn(pa, pb)
    if (!best || duration(best[0], best[1]) < minDuration) continue
    out.push(best)
    pending.push([pa, best[0]], [best[1], pb])
  }
  return out
}

/** The longest window inside [a, b) that passes, by one two-pointer sweep of [a, b) (see longestWindows). */
function longestPassing(
  passes: (a: number, b: number) => boolean,
  a: number,
  b: number,
  duration: (a: number, b: number) => number,
): [number, number] | null {
  let best: [number, number] | null = null
  let bestSeconds = -1
  let end = a
  for (let start = a; start < b; start += 1) {
    if (end < start + 1) end = start + 1
    while (end < b && passes(start, end + 1)) end += 1
    if (!passes(start, end)) continue
    const seconds = duration(start, end)
    if (seconds > bestSeconds) {
      best = [start, end]
      bestSeconds = seconds
    }
    if (end >= b) break
  }
  return best
}

/**
 * [a, b) without the ends where the speed, smoothed over ±1 s, is still more than `limit` off the window's own trend
 * line (the end of the deceleration before a hold, the start of the next one); a steady drift, on the line, stays.
 * Twice: the line moves as the ends go.
 */
function trimEnds(speed: Prefix, at: (k: number) => number, a: number, b: number, limit: number): [number, number] {
  let start = a
  let end = b
  for (let pass = 0; pass < 2; pass += 1) {
    const fit = moments(speed, start, end)
    if (!Number.isFinite(fit.mean)) break
    const slope = Number.isFinite(fit.slope) ? fit.slope : 0
    const line = (k: number) => fit.mean + slope * (at(k) - at(0) - fit.tMean)
    const smoothed = (k: number) => {
      let p = k
      let q = k + 1
      while (p > start && at(p - 1) >= at(k) - TRIM_SMOOTHING_S) p -= 1
      while (q < end && at(q) <= at(k) + TRIM_SMOOTHING_S) q += 1
      return moments(speed, p, q).mean
    }
    while (end - start > 2 && !(Math.abs(smoothed(start) - line(start)) <= limit)) start += 1
    while (end - start > 2 && !(Math.abs(smoothed(end - 1) - line(end - 1)) <= limit)) end -= 1
  }
  return [start, end]
}

/**
 * Rows [from, to) of `values` averaged over ±`half` seconds around each (finite samples only; NaN where there are
 * none), indexed from `from`.
 */
function movingAverage(values: ArrayLike<number>, time: ArrayLike<number>, from: number, to: number, half: number): Float64Array {
  const out = new Float64Array(to - from)
  let lo = from
  let hi = from
  let sum = 0
  let count = 0
  for (let i = from; i < to; i += 1) {
    while (hi < to && time[hi] <= time[i] + half) {
      if (Number.isFinite(values[hi])) {
        sum += values[hi]
        count += 1
      }
      hi += 1
    }
    while (time[lo] < time[i] - half) {
      if (Number.isFinite(values[lo])) {
        sum -= values[lo]
        count -= 1
      }
      lo += 1
    }
    out[i - from] = count > 0 ? sum / count : NaN
  }
  return out
}

/** The median of the finite values in [a, b); NaN when there are none. */
function medianOf(values: Float64Array, a: number, b: number): number {
  const finite = values.slice(a, b).filter((v) => Number.isFinite(v)).sort()
  if (!finite.length) return NaN
  const mid = finite.length >> 1
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2
}

/** A series (indexed like the prefix sums) and the width its values must stay within. */
interface Band {
  values: ArrayLike<number>
  width: number
}

/**
 * The longest stretch of [a, b) where every series stays within its band (max − min ≤ width over its finite values),
 * by two pointers with monotone queues of each series' running maximum and minimum; null when [a, b) has no row where
 * every series is finite.
 */
function longestWithin(
  bands: readonly Band[],
  a: number,
  b: number,
  duration: (a: number, b: number) => number,
): [number, number] | null {
  const queues = bands.map(() => ({ max: new Int32Array(b - a), min: new Int32Array(b - a), maxHead: 0, maxTail: 0, minHead: 0, minTail: 0 }))
  let start = a
  let best: [number, number] | null = null
  let bestSeconds = -1
  for (let end = a; end < b; end += 1) {
    if (!bands.every((band) => Number.isFinite(band.values[end]))) continue
    bands.forEach(({ values }, i) => {
      const q = queues[i]
      const v = values[end]
      while (q.maxTail > q.maxHead && values[q.max[q.maxTail - 1]] <= v) q.maxTail -= 1
      q.max[q.maxTail++] = end
      while (q.minTail > q.minHead && values[q.min[q.minTail - 1]] >= v) q.minTail -= 1
      q.min[q.minTail++] = end
    })
    const outside = () => bands.some(({ values, width }, i) => values[queues[i].max[queues[i].maxHead]] - values[queues[i].min[queues[i].minHead]] > width)
    while (outside()) {
      start += 1
      for (const q of queues) {
        while (q.maxHead < q.maxTail && q.max[q.maxHead] < start) q.maxHead += 1
        while (q.minHead < q.minTail && q.min[q.minHead] < start) q.minHead += 1
      }
    }
    const seconds = duration(start, end + 1)
    if (seconds > bestSeconds) {
      best = [start, end + 1]
      bestSeconds = seconds
    }
  }
  return best
}

function meanOf(values: ArrayLike<number>, start: number, end: number): number {
  let n = 0
  let sum = 0
  for (let i = start; i < end; i += 1) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    n += 1
    sum += v
  }
  return n ? sum / n : NaN
}
