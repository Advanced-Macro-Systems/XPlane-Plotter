// Pure logic of the Channels tab table: rows with their group and flags, filtering, sorting, counts and the CSV / TSV
// text of the table. No React here (unit-tested in node).

import { MINUS, formatNumber } from '../../charts/format'
import { matchesChannel } from '../../components/channelGroups'
import { allGroups, channelTitle, groupById } from '../../core/channels'
import { channelAlias } from '../../core/channels/alias'
import type { Channel, Dataset } from '../../core/types'

export interface ChannelRow {
  ch: Channel
  /** Position in the dataset: file columns in file order, then formulas */
  index: number
  group: { id: string; name: string; order: number }
  /** A formula channel */
  formula: boolean
  /** A file column the channel dictionary does not know */
  unknown: boolean
  /** Every finite sample is equal (or there are none) */
  constant: boolean
}

export function channelRows(ds: Dataset): ChannelRow[] {
  const order = new Map(allGroups().map((g, i) => [g.id, g.order ?? i]))
  return ds.channels.map((ch, index) => {
    const group = groupById(ch.meta.group)
    return {
      ch,
      index,
      group: { id: group.id, name: group.name, order: order.get(group.id) ?? 9999 },
      formula: !!ch.derived,
      unknown: !ch.derived && !ch.meta.known,
      constant: ch.stats.constant,
    }
  })
}

// ------------------------------------------------------------------------------------------------ filtering

export const ALL_GROUPS = 'all'

export interface ChannelFilter {
  query: string
  /** A group id, or ALL_GROUPS */
  group: string
  hideConstant: boolean
  onlyUnknown: boolean
}

export function filterRows(rows: readonly ChannelRow[], filter: ChannelFilter): ChannelRow[] {
  return rows.filter(
    (row) =>
      (filter.group === ALL_GROUPS || row.group.id === filter.group) &&
      (!filter.hideConstant || !row.constant) &&
      (!filter.onlyUnknown || row.unknown) &&
      matchesChannel(row.ch, filter.query),
  )
}

export interface GroupOption {
  id: string
  name: string
  count: number
}

/** The groups present, in picker order, with how many channels each holds. */
export function groupOptions(rows: readonly ChannelRow[]): GroupOption[] {
  const groups = new Map<string, GroupOption & { order: number }>()
  for (const row of rows) {
    const entry = groups.get(row.group.id)
    if (entry) entry.count += 1
    else groups.set(row.group.id, { id: row.group.id, name: row.group.name, count: 1, order: row.group.order })
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ id, name, count }) => ({ id, name, count }))
}

// ------------------------------------------------------------------------------------------------ sorting

export type SortKey =
  | 'file'
  | 'label'
  | 'group'
  | 'short'
  | 'id'
  | 'unit'
  | 'min'
  | 'mean'
  | 'max'
  | 'std'
  | 'finite'
  | 'flags'

export interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

export const FILE_ORDER: SortState = { key: 'file', dir: 'asc' }

/** A header click: ascending, then descending, then back to file order. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: 'asc' }
  return current.dir === 'asc' ? { key, dir: 'desc' } : FILE_ORDER
}

const NUMERIC: ReadonlySet<SortKey> = new Set(['min', 'mean', 'max', 'std', 'finite'])

function numericValue(row: ChannelRow, key: SortKey): number {
  const s = row.ch.stats
  switch (key) {
    case 'min':
      return s.min
    case 'mean':
      return s.mean
    case 'max':
      return s.max
    case 'std':
      return s.std
    default:
      return s.finite
  }
}

/** Formula first, then unknown, then constant (a row's most notable flag). */
function flagWeight(row: ChannelRow): number {
  return (row.formula ? 4 : 0) + (row.unknown ? 2 : 0) + (row.constant ? 1 : 0)
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

function compareText(a: ChannelRow, b: ChannelRow, key: SortKey): number {
  switch (key) {
    case 'label':
      return collator.compare(a.ch.meta.label, b.ch.meta.label)
    case 'group':
      return a.group.order - b.group.order || collator.compare(a.group.name, b.group.name)
    case 'short':
      return collator.compare(a.ch.meta.short, b.ch.meta.short)
    case 'id':
      return collator.compare(a.ch.id, b.ch.id)
    case 'unit':
      // Channels without a unit go after those with one.
      return Number(!a.ch.meta.unit) - Number(!b.ch.meta.unit) || collator.compare(a.ch.meta.unit, b.ch.meta.unit)
    case 'flags':
      return flagWeight(a) - flagWeight(b)
    default:
      return a.index - b.index
  }
}

/** Sorted copy; ties keep file order and missing numbers (NaN) always go last. */
export function sortRows(rows: readonly ChannelRow[], sort: SortState): ChannelRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  if (NUMERIC.has(sort.key)) {
    return [...rows].sort((a, b) => {
      const va = numericValue(a, sort.key)
      const vb = numericValue(b, sort.key)
      const missingA = Number.isNaN(va)
      const missingB = Number.isNaN(vb)
      if (missingA || missingB) return missingA === missingB ? a.index - b.index : missingA ? 1 : -1
      return (va - vb) * dir || a.index - b.index
    })
  }
  return [...rows].sort((a, b) => compareText(a, b, sort.key) * dir || a.index - b.index)
}

// ------------------------------------------------------------------------------------------------ statistics

/**
 * A statistic in the table's narrow number columns: 4 significant figures, and below 10^−3 or from 10^6 up in exponent
 * form ("3.142e−4", not "0.00031416"), so every value fits its column whole and is never cut with an ellipsis.
 */
export function statText(value: number): string {
  const magnitude = Math.abs(value)
  if (Number.isFinite(value) && value !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)) {
    const [mantissa, exponent] = value.toExponential(3).split('e')
    return `${mantissa.replace(/\.?0+$/, '')}e${Number(exponent)}`.replace(/-/g, MINUS)
  }
  return formatNumber(value, 4)
}

/** The same value to 7 significant figures, for the cell's tooltip. */
export function statTitle(value: number): string {
  return formatNumber(value, 7)
}

// ------------------------------------------------------------------------------------------------ counts

export interface ChannelCounts {
  total: number
  constant: number
  unknown: number
  formulas: number
}

export function channelCounts(rows: readonly ChannelRow[]): ChannelCounts {
  let constant = 0
  let unknown = 0
  let formulas = 0
  for (const row of rows) {
    if (row.constant) constant += 1
    if (row.unknown) unknown += 1
    if (row.formula) formulas += 1
  }
  return { total: rows.length, constant, unknown, formulas }
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`

/**
 * "173 channels · 24 constant · 0 unknown" for the rows shown (`shown`, from channelCounts of those rows), with
 * "40 of 173 channels" when a filter hides some (`fileTotal` is every channel), and formulas when any.
 */
export function countsText(shown: ChannelCounts, fileTotal: number): string {
  const total =
    shown.total === fileTotal ? plural(fileTotal, 'channel') : `${shown.total.toLocaleString('en-GB')} of ${plural(fileTotal, 'channel')}`
  const parts = [total, `${shown.constant.toLocaleString('en-GB')} constant`, `${shown.unknown.toLocaleString('en-GB')} unknown`]
  if (shown.formulas > 0) parts.push(plural(shown.formulas, 'formula'))
  return parts.join(' · ')
}

// ------------------------------------------------------------------------------------------------ CSV / TSV

/** A text cell: quoted when needed, and defused when a spreadsheet would read it as a formula. */
function textCell(text: string, delimiter: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return safe.includes(delimiter) || /["\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** A number cell: shortest round-trip text with an ASCII minus; empty when missing. */
function numberCell(value: number): string {
  return Number.isFinite(value) ? String(value) : ''
}

/**
 * The table as CSV (or TSV): one line per channel with its group, names, formula alias, unit, statistics and flags.
 * Plain numbers (full precision, ASCII minus), CRLF line ends.
 */
export function channelsTableText(rows: readonly ChannelRow[], delimiter: ',' | '\t'): string {
  const header = [
    'group',
    'label',
    'short',
    'title',
    'id',
    'formula_alias',
    'unit',
    'min',
    'mean',
    'max',
    'std',
    'finite',
    'constant',
    'formula',
    'unknown',
    'expression',
  ]
  const lines = [header.join(delimiter)]
  for (const row of rows) {
    const { ch } = row
    lines.push(
      [
        textCell(row.group.name, delimiter),
        textCell(ch.meta.label, delimiter),
        textCell(ch.meta.short, delimiter),
        textCell(channelTitle(ch), delimiter),
        textCell(ch.id, delimiter),
        textCell(channelAlias(ch), delimiter),
        textCell(ch.meta.unit, delimiter),
        numberCell(ch.stats.min),
        numberCell(ch.stats.mean),
        numberCell(ch.stats.max),
        numberCell(ch.stats.std),
        String(ch.stats.finite),
        row.constant ? '1' : '0',
        row.formula ? '1' : '0',
        row.unknown ? '1' : '0',
        textCell(ch.derived?.expression ?? '', delimiter),
      ].join(delimiter),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

/** Title tooltip for a channel's label: the description, sign convention and notes the dictionary has. */
export function channelHelp(ch: Channel): string {
  const parts = [ch.meta.description ?? ch.meta.label]
  if (ch.meta.sign) parts.push(`Sign: ${ch.meta.sign}`)
  if (ch.meta.notes) parts.push(`Note: ${ch.meta.notes}`)
  if (ch.derived) parts.push(`= ${ch.derived.expression}`)
  return parts.join('\n')
}
