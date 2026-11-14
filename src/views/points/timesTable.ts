// "Add points from times": reads a pasted table of test-point times (one window per line, as they are written down in
// the cockpit or kept in a spreadsheet), finds the rows of each window on a time axis, and, when the lines list
// the speed held, works out which of the log's clocks the times were read from: each window's mean speed is compared
// with the speed listed on its line, on every time axis. Pure: no React, no DOM.

import { rangeStats } from '../../core/analysis/stats'
import { rangeToRows, timeAxis, timeBases } from '../../core/time'
import type { Channel, Dataset, RowRange, TimeAxis, TimeBaseId } from '../../core/types'

/** Which airspeed a table's speeds are (from its header or a unit after a number). */
export type SpeedKind = 'ias' | 'eas' | 'tas'

/** One window read from the paste. */
export interface TimesWindow {
  /** 1-based line of the paste (a "·" also starts a new line) */
  line: number
  /** The line as typed, trimmed */
  text: string
  /** Start and end as typed, seconds (clock times hh:mm:ss read as seconds of the day) */
  from: number
  to: number
  /** One time was typed: the window is ± the pad around it */
  single: boolean
  /** The speed listed on the line, or null */
  speed: number | null
}

export interface SkippedLine {
  line: number
  text: string
  reason: string
}

export interface ParsedTimes {
  windows: TimesWindow[]
  skipped: SkippedLine[]
  /** The header line (column names), when the paste has one */
  header: string | null
  /** The airspeed the header (or a unit like "KIAS" after a number) names */
  speedKind: SpeedKind | null
  /** Some times were written as clock times (hh:mm:ss or mm:ss) */
  clock: boolean
}

/** Seconds either side of a single time. */
export const SINGLE_TIME_PAD = 10

/** Why a line gave no window. */
export const NO_TIME = 'no time on it'
const TOO_MANY = 'more numbers than a window and a speed'

// ------------------------------------------------------------------ reading the paste

interface Token {
  kind: 'range' | 'number'
  from: number
  to: number
  /** A speed unit followed the number ("300 kt", "310 KIAS") */
  speed: boolean
  /** A time unit followed it ("300 s") or it is a clock time: a time, never a speed */
  time: boolean
  clock: boolean
  /** The cell it is in */
  cell: number
  /** Words come before it on the line ("(not recorded) 140", "n/a | 140") */
  afterWords: boolean
}

const NUMBER = String.raw`\d+(?:\.\d+)?`
const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?`
const VALUE = `(?:${CLOCK}|${NUMBER})`
const DASH = String.raw`\s*(?:-|–|—|−|‒|to|\.\.|→)\s*`
const UNIT = String.raw`\s*(kts?|knots?|kias|keas|ktas|kcas|ias|eas|tas|cas|mph)\b`
const TIME_UNIT = String.raw`\s*(s|secs?|seconds)\b`
/** A value, a range of two, and a unit after it. A number glued to letters ("t1", "P2") is part of a name. */
const TOKEN = new RegExp(String.raw`(?<![A-Za-z\d.])(${VALUE})(?:${DASH}(${VALUE}))?(?:${UNIT}|${TIME_UNIT})?`, 'gi')
/**
 * A label at the start of a line or its first cell, not a time: "Point 1:", "Run 2 -", "Test point 3)", "#4", "5." and
 * "6)". Without it "Point 1: 300 320" would read as the window 1–300 s.
 */
const LABEL =
  /^\s*(?:(?:(?:test\s*)?(?:points?|pts?|p|runs?|tps?|holds?|legs?|lines?|items?|steps?|cases?|cards?|no\.?|nr\.?|number)\s*#?\s*|#\s*)\d+[a-z]?(?![\d.]|:\d)\s*[:.)\]–—-]?\s*|\d+\s*[:.)\]](?=\s|$)\s*)/i

/** "6:40" -> 400, "14:30:15" -> 52215, "420" -> 420 */
function seconds(text: string): number {
  if (!text.includes(':')) return Number(text)
  const parts = text.split(':').map(Number)
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
}

function kindOf(text: string): SpeedKind | null {
  if (/\bk?eas\b/i.test(text)) return 'eas'
  if (/\bk?tas\b/i.test(text)) return 'tas'
  if (/\bk?[ic]as\b/i.test(text)) return 'ias'
  return null
}

/** The values in a line's cells, each with its cell and whether words come before it. */
function tokens(parts: readonly string[]): Token[] {
  const out: Token[] = []
  parts.forEach((cell, index) => {
    const before = parts.slice(0, index).join(' ')
    for (const m of cell.matchAll(TOKEN)) {
      const clock = m[1].includes(':') || (m[2]?.includes(':') ?? false)
      const from = seconds(m[1])
      const to = m[2] !== undefined ? seconds(m[2]) : from
      out.push({
        kind: m[2] !== undefined ? 'range' : 'number',
        from,
        to,
        speed: m[3] !== undefined,
        time: m[4] !== undefined || clock,
        clock,
        cell: index,
        afterWords: /\p{L}/u.test(`${before} ${cell.slice(0, m.index)}`),
      })
    }
  })
  return out
}

/**
 * Cells of a line: split at tabs and pipes, keeping empty cells (a blank spreadsheet cell keeps its column), or, when
 * there are none, at commas and semicolons. A Markdown row's outer pipes ("| a | b |") add no cells. A label in front
 * of the first cell ("Point 1:") goes.
 */
function cells(raw: string): string[] {
  const line = raw.replace(/^[ \u00a0]+|[ \u00a0\r]+$/g, '')
  let parts: string[]
  if (/[\t|]/.test(line)) {
    parts = line.split(/[\t|]/).map((c) => c.trim())
    if (line.startsWith('|')) parts.shift()
    if (line.endsWith('|')) parts.pop()
  } else parts = line.split(/[,;]/).map((c) => c.trim())
  if (parts.length) parts[0] = parts[0].replace(LABEL, '')
  return parts
}

interface Roles {
  /** Columns holding the time (one with a window or a single time, or two: start and end) */
  time: number[]
  speed: number | null
  /** Columns that name or number the point ("Run", "#"): never a time */
  label: number[]
}

const TIME_WORDS =
  /\b(times?|t|t[0-2]|secs?|seconds|start|end|from|to|window|begin|stop|clock|elapsed|timestamp|real|sim|utc|zulu|local|when)\b|\(s\)|\[s\]/i
const SPEED_WORDS = /\b(k?ias|k?cas|k?eas|k?tas|speed|airspeed|kts?|knots?|v)\b/i
const LABEL_WORDS = /^\s*(#|no\.?|nr\.?|number|points?|pts?|runs?|tps?|test(\s*points?)?|holds?|legs?|lines?|items?|steps?|cases?|cards?|names?|notes?|comments?|remarks?)\s*$/i

function headerRoles(header: string): Roles | null {
  const names = cells(header)
  const time: number[] = []
  const label: number[] = []
  let speed: number | null = null
  names.forEach((name, i) => {
    if (speed === null && SPEED_WORDS.test(name) && !TIME_WORDS.test(name)) speed = i
    else if (TIME_WORDS.test(name) && time.length < 2) time.push(i)
    else if (LABEL_WORDS.test(name)) label.push(i)
  })
  return time.length || speed !== null ? { time, speed, label } : null
}

/** How the lines without a header lay out a time and a speed, from the lines with a window and one number. */
type Layout = 'time-speed' | 'speed-time' | null

function layoutOf(lines: readonly Token[][]): Layout {
  let timeFirst = 0
  let speedFirst = 0
  for (const line of lines) {
    if (line.length !== 2) continue
    const [x, y] = line
    if (x.kind === 'range' && y.kind === 'number' && !y.time) timeFirst += 1
    else if (x.kind === 'number' && !x.time && y.kind === 'range') speedFirst += 1
  }
  return timeFirst > speedFirst ? 'time-speed' : speedFirst > timeFirst ? 'speed-time' : null
}

type Read = { times: Token[]; speed: number | null } | string

/**
 * A line's times and speed without a header: a window is the time, a number after it (or before it, or one with a
 * unit, "300 kt") the speed, two plain numbers a window (or a time and its speed, when the other lines are laid out
 * that way) and three a window and its speed. A number alone is a time unless it stands where the speed goes: after
 * words ("(not recorded) 140", "n/a | 140") or blank time cells ("\t\t140"). `positional`: the cells are a table's
 * columns (not when a header has already picked them).
 */
function readFree(found: readonly Token[], layout: Layout, positional = true): Read {
  if (!found.length) return NO_TIME
  const withUnit = found.find((t) => t.speed && t.kind === 'number')
  const plain = found.filter((t) => t !== withUnit && !t.speed)
  const range = plain.find((t) => t.kind === 'range')
  if (withUnit) return plain.length ? { times: range ? [range] : plain, speed: withUnit.from } : NO_TIME
  if (range) {
    // The speed is the number after the window ("150-180 250"), else the one before it ("250 | 150-180").
    const at = plain.indexOf(range)
    const after = plain.slice(at + 1).find((t) => t.kind === 'number' && !t.time)
    const before = plain.slice(0, at).findLast((t) => t.kind === 'number' && !t.time)
    return { times: [range], speed: (after ?? before)?.from ?? null }
  }
  if (plain.length === 1) {
    const [only] = plain
    if (only.time) return { times: [only], speed: null }
    if (only.afterWords) return NO_TIME
    if (positional && only.cell > 0 && layout !== 'speed-time') return NO_TIME
    if (positional && only.cell === 0 && layout === 'speed-time') return NO_TIME
    return { times: [only], speed: null }
  }
  if (plain.length === 2) {
    const [x, y] = plain
    if (layout === 'time-speed' && !y.time) return { times: [x], speed: y.from }
    if (layout === 'speed-time' && !x.time) return { times: [y], speed: x.from }
    return { times: plain, speed: null }
  }
  if (plain.length === 3) {
    return layout === 'speed-time' && !plain[0].time
      ? { times: plain.slice(1), speed: plain[0].from }
      : { times: plain.slice(0, 2), speed: plain[2].from }
  }
  return TOO_MANY
}

/** A line's times and speed through a header's columns; without a time column the other cells are read freely. */
function readByRoles(found: readonly Token[], roles: Roles): Read {
  const speedToken = roles.speed !== null ? found.find((t) => t.cell === roles.speed && t.kind === 'number') : undefined
  if (roles.time.length) {
    const times = found.filter((t) => roles.time.includes(t.cell))
    return times.length ? { times, speed: speedToken?.from ?? null } : NO_TIME
  }
  const rest = found.filter((t) => t.cell !== roles.speed && !roles.label.includes(t.cell))
  const free = readFree(rest, null, false)
  return typeof free === 'string' ? free : { times: free.times, speed: speedToken?.from ?? free.speed }
}

/** A window from time tokens: a range, two numbers, or one number (a single time). */
function windowOf(times: readonly Token[]): { from: number; to: number; single: boolean } | null {
  const range = times.find((t) => t.kind === 'range')
  if (range) return { from: Math.min(range.from, range.to), to: Math.max(range.from, range.to), single: range.from === range.to }
  if (times.length === 1) return { from: times[0].from, to: times[0].from, single: true }
  if (times.length === 2) {
    const [a, b] = [times[0].from, times[1].from]
    return { from: Math.min(a, b), to: Math.max(a, b), single: a === b }
  }
  return null
}

/**
 * Reads a pasted table: one window per line ("150-180 250", "150 180", "210–240, 240 kt", "330–360 | 220", a single
 * time "300" for ± `pad` seconds around it), cells split by tabs, pipes, commas or semicolons, a "·" between rows of a
 * table flattened onto one line, a label in front ("Point 1:") ignored. A header line ("Time (s) | IAS") says which
 * column holds the time and which the speed; without one the lines say it themselves (see readFree). Lines with no time
 * ("(not flown) 230", "(not recorded) | 140") are skipped with the reason.
 */
export function parseTimesTable(text: string): ParsedTimes {
  const lines = text.split(/\r?\n|·|•/)
  const parsed: ParsedTimes = { windows: [], skipped: [], header: null, speedKind: null, clock: false }
  let roles: Roles | null = null
  const data: { number: number; text: string; found: Token[]; cells: number }[] = []
  lines.forEach((raw, index) => {
    let line = raw.trim()
    let body = raw
    const number = index + 1
    if (!line || /^[\s|:+=-]+$/.test(line)) return
    // A header run into the first row ("Time (s) | IAS: 300 | 320").
    const fused = !data.length && parsed.header === null ? /^([^\d:]*[A-Za-z)\]][^\d:]*):\s*(\S.*)$/.exec(line) : null
    if (fused && tokens(cells(fused[2])).length) {
      parsed.header = fused[1].trim()
      roles = headerRoles(parsed.header)
      parsed.speedKind ??= kindOf(parsed.header)
      line = fused[2].trim()
      body = fused[2]
    }
    const parts = cells(body)
    const found = tokens(parts)
    if (!found.length && !data.length && parsed.header === null) {
      parsed.header = line
      roles = headerRoles(line)
      parsed.speedKind ??= kindOf(line)
      return
    }
    data.push({ number, text: line, found, cells: parts.length })
  })
  const layout = layoutOf(data.map((d) => d.found))
  for (const { number, text: line, found, cells: count } of data) {
    // A line typed without the header's separators ("150-180 250" under "Time | IAS") is read on its own.
    const read = roles && count > 1 ? readByRoles(found, roles) : readFree(found, layout)
    if (typeof read === 'string') {
      parsed.skipped.push({ line: number, text: line, reason: read })
      continue
    }
    const window = windowOf(read.times)
    if (!window) {
      parsed.skipped.push({ line: number, text: line, reason: read.times.length ? TOO_MANY : NO_TIME })
      continue
    }
    if (read.times.some((t) => t.clock)) parsed.clock = true
    if (found.some((t) => t.speed)) parsed.speedKind ??= kindOf(line.slice(line.search(/\d/)))
    parsed.windows.push({ line: number, text: line, ...window, speed: read.speed !== null && read.speed > 0 ? read.speed : null })
  }
  return parsed
}

// ------------------------------------------------------------------ windows on a time axis

/**
 * The rows of a window on an axis (typed seconds; hours on a clock axis), or null when no sample lies in it: outside
 * the log, or in a gap of this axis (a sim-time jump).
 */
export function windowRows(axis: TimeAxis, window: Pick<TimesWindow, 'from' | 'to' | 'single'>, pad = SINGLE_TIME_PAD): RowRange | null {
  const values = axis.values
  const n = values.length
  if (n === 0) return null
  const scale = axis.clock || axis.unit === 'h' ? 1 / 3600 : 1
  const lo = (window.single ? window.from - pad : window.from) * scale
  const hi = (window.single ? window.to + pad : window.to) * scale
  if (!(hi >= values[0]) || !(lo <= values[n - 1])) return null
  const [start, end] = rangeToRows(values, lo, hi)
  // rangeToRows gives the row just before a window that holds no sample; that is not a window of data.
  return end > start && values[start] >= lo && values[end - 1] <= hi ? [start, end] : null
}

/** Within this difference (in the speed's unit) a window's mean speed agrees with the speed listed. */
export const MATCH_LIMIT = 2
/** The times match an axis when at least this share of the listed speeds (of the windows inside the log) agree. */
export const MATCH_SHARE = 0.75

/** How well one time axis fits the listed speeds. */
export interface BaseMatch {
  id: TimeBaseId
  /** "Real time" */
  label: string
  /** The X-Plane column it reads ("_real,_time"); null for elapsed time */
  token: string | null
  /** Windows inside the log on this axis */
  inside: number
  /** |mean speed − listed speed| of each window with a listed speed that lies inside */
  errors: number[]
  /** Of those, how many agree (within MATCH_LIMIT) */
  agree: number
  /** The lines whose window lies inside but whose speed is more than MATCH_LIMIT off, with how far, worst first */
  off: { line: number; error: number }[]
  /** Windows with a listed speed that lie outside the log on this axis (or hold no sample) */
  outside: number
  /** Their lines */
  outsideLines: number[]
  /** Median of `errors` */
  median: number
  /** The largest difference among the windows that agree */
  max: number
}

function median(values: readonly number[]): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The time axes a pasted time can be read on: every available one but row numbers. */
export function timeBaseChoices(ds: Dataset): { id: TimeBaseId; label: string }[] {
  return timeBases(ds)
    .filter((b) => b.available && b.id !== 'index')
    .map((b) => ({ id: b.id, label: b.label }))
}

/**
 * Each time axis scored by how well the windows' mean speed (on `speed`) matches the speeds listed, best first: the most
 * windows whose speed agrees, then the smallest median difference. Windows outside the log on an axis are counted
 * apart, so one typo does not rule out the axis all the others match. Without listed speeds every axis scores NaN and
 * the order is the toolbar's.
 */
export function matchTimeBases(
  ds: Dataset,
  windows: readonly TimesWindow[],
  speed: Channel | null,
  pad = SINGLE_TIME_PAD,
): BaseMatch[] {
  const out = timeBaseChoices(ds).map((base): BaseMatch => {
    const axis = timeAxis(ds, base.id)
    const errors: number[] = []
    const off: { line: number; error: number }[] = []
    const outsideLines: number[] = []
    let inside = 0
    for (const w of windows) {
      const rows = windowRows(axis, w, pad)
      if (rows) inside += 1
      if (w.speed === null || !speed) continue
      const stats = rows ? rangeStats(speed.values, rows[0], rows[1]) : null
      if (!stats || !(stats.n > 0)) {
        outsideLines.push(w.line)
        continue
      }
      const error = Math.abs(stats.mean - w.speed)
      errors.push(error)
      if (!(error <= MATCH_LIMIT)) off.push({ line: w.line, error })
    }
    const agreeing = errors.filter((e) => e <= MATCH_LIMIT)
    return {
      id: base.id,
      label: base.label,
      token: base.id.startsWith('ch:') ? base.id.slice(3) : null,
      inside,
      errors,
      agree: agreeing.length,
      off: off.sort((a, b) => b.error - a.error),
      outside: outsideLines.length,
      outsideLines,
      median: median(errors),
      max: agreeing.length ? Math.max(...agreeing) : NaN,
    }
  })
  const rank = (m: BaseMatch) => (Number.isFinite(m.median) ? m.median : Infinity)
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.agree - a.m.agree || rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m)
}

export interface ClockVerdict {
  /** The axis to preselect */
  id: TimeBaseId
  /** The sentence for the dialog */
  message: string
  /** The listed speeds confirm the axis */
  confirmed: boolean
}

/** "±1.2 kt" style number: one decimal below 10, whole above. */
function amount(value: number, unit: string): string {
  const text = value < 9.95 ? value.toFixed(1) : String(Math.round(value))
  return unit ? `${text} ${unit}` : text
}

/** "Real time (X-Plane _real,_time)" */
export function baseName(match: Pick<BaseMatch, 'label' | 'token'>): string {
  return match.token ? `${match.label} (X-Plane ${match.token})` : match.label
}

/** "line 1 is 50 kt off", "lines 1 and 4 are 50 and 12 kt off", "lines 1, 4, 7 and 2 more are off" */
function offText(off: readonly { line: number; error: number }[], unit: string): string {
  if (off.length === 1) return `line ${off[0].line} is ${amount(off[0].error, unit)} off`
  if (off.length === 2) {
    return `lines ${off[0].line} and ${off[1].line} are ${amount(off[0].error, '')} and ${amount(off[1].error, unit)} off`
  }
  const shown = off.slice(0, 3).map((o) => o.line)
  const more = off.length - shown.length
  return `lines ${shown.join(', ')}${more ? ` and ${more} more` : ''} are more than ${amount(MATCH_LIMIT, unit)} off`
}

/** "Line 18 lies outside the log on this axis." */
function outsideText(lines: readonly number[]): string {
  if (!lines.length) return ''
  const shown = lines.slice(0, 3)
  const more = lines.length - shown.length
  const which =
    lines.length === 1 ? `Line ${lines[0]} lies` : `Lines ${shown.join(', ')}${more ? ` and ${more} more` : ''} lie`
  return ` ${which} outside the log on this axis.`
}

/**
 * Which axis the times were read on, and what to tell the user: the best-matching axis when most listed speeds
 * (MATCH_SHARE of the windows inside the log) agree there, naming the lines that do not and those outside the log,
 * with how far off the current axis is; otherwise the current axis.
 */
export function clockVerdict(matches: readonly BaseMatch[], current: TimeBaseId, unit: string): ClockVerdict {
  const best = matches[0]
  const listed = matches.some((m) => m.errors.length > 0 || m.outside > 0)
  if (!best || !listed) {
    const here = matches.find((m) => m.id === current) ?? best
    return {
      id: here?.id ?? current,
      message: `No speeds are listed, so the times are read on ${here ? here.label.toLowerCase() : 'the current axis'} (the axis Time history shows).`,
      confirmed: false,
    }
  }
  const checked = best.errors.length
  if (!(best.agree > 0 && best.agree >= Math.ceil(MATCH_SHARE * checked))) {
    const here = matches.find((m) => m.id === current) ?? best
    const how = checked
      ? `, ${best.agree} of ${checked} speeds within ${amount(MATCH_LIMIT, unit)}${Number.isFinite(best.median) ? `, ${amount(best.median, unit)} off on average` : ''}`
      : ''
    return {
      id: here.id,
      message: `No time axis matches the listed speeds well (the closest is ${baseName(best)}${how}): check the times and the speed channel.`,
      confirmed: false,
    }
  }
  const agree =
    best.agree === checked
      ? `speeds agree within ${amount(best.max, unit)} (median ${amount(best.median, unit)})`
      : `${best.agree} of ${checked} speeds agree within ${amount(best.max, unit)} (median ${amount(best.median, unit)}); ${offText(best.off, unit)}`
  const here = matches.find((m) => m.id === current)
  const other =
    here && here.id !== best.id
      ? ` On ${here.label.toLowerCase()} they would be ${Number.isFinite(here.median) ? `${amount(here.median, unit)} off` : 'outside the log'}.`
      : ''
  return {
    id: best.id,
    message: `These times match ${baseName(best)}: ${agree}.${outsideText(best.outsideLines)}${other}`,
    confirmed: true,
  }
}
