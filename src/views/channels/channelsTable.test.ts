import { describe, expect, it } from 'vitest'
import { allGroups, groupById } from '../../core/channels'
import { derivedChannel, fileChannel, makeDataset } from '../../core/export/testFixtures'
import type { Channel } from '../../core/types'
import {
  ALL_GROUPS,
  FILE_ORDER,
  channelCounts,
  channelHelp,
  channelRows,
  channelsTableText,
  countsText,
  filterRows,
  groupOptions,
  nextSort,
  sortRows,
  statText,
  statTitle,
  type ChannelFilter,
} from './channelsTable'

/** Five rows: a known channel, an unknown one, a constant one, one with no values, and a formula. */
function dataset() {
  const kias: Channel = {
    ...fileChannel('_Vind,_kias', 1, 0, [100, 101, Number.NaN, 103], 'KIAS', 'kt'),
    meta: {
      label: 'Indicated airspeed',
      short: 'KIAS',
      unit: 'kt',
      quantity: 'speed',
      group: 'other',
      description: 'Airspeed shown on the ASI',
      sign: 'Always positive',
      known: true,
    },
  }
  const mystery = fileChannel('mystr,_foo', 1, 1, [-5, 2, 7, -1], '=mystery', '')
  const weight = fileChannel('empty,___lb', 1, 2, [9000, 9000, 9000, 9000], 'Empty weight', 'lb')
  const blank = fileChannel('blank,_col', 1, 3, [Number.NaN, Number.NaN, Number.NaN, Number.NaN], 'Blank', '')
  const q = derivedChannel('q', 'Dynamic pressure', 'Pa', 'Vind_kias * 2', [200, 202, Number.NaN, 206])
  return makeDataset([kias, mystery, weight, blank, q], [0, 0.5, 1, 1.5])
}

const ALL: ChannelFilter = { query: '', group: ALL_GROUPS, hideConstant: false, onlyUnknown: false }
const ids = (rows: { ch: Channel }[]) => rows.map((r) => r.ch.id)

describe('channelRows', () => {
  it('flags formulas, unknown file columns and constant channels', () => {
    const rows = channelRows(dataset())
    expect(rows.map((r) => [r.formula, r.unknown, r.constant])).toEqual([
      [false, false, false],
      [false, true, false],
      [false, true, true],
      [false, true, true],
      [true, false, false],
    ])
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('names each row’s group from the dictionary', () => {
    const rows = channelRows(dataset())
    expect(rows[0].group).toMatchObject({ id: groupById('other').id, name: groupById('other').name })
    expect(rows[4].group).toMatchObject({ id: groupById('derived').id, name: groupById('derived').name })
  })
})

describe('filterRows', () => {
  const rows = channelRows(dataset())

  it('keeps everything without a filter', () => {
    expect(filterRows(rows, ALL)).toHaveLength(5)
  })

  it('searches labels, units, tokens and aliases', () => {
    expect(ids(filterRows(rows, { ...ALL, query: 'indicated' }))).toEqual(['_Vind,_kias'])
    expect(ids(filterRows(rows, { ...ALL, query: 'Vind_kias' }))).toEqual(['_Vind,_kias'])
    expect(ids(filterRows(rows, { ...ALL, query: 'pa dynamic' }))).toEqual(['fx:q'])
  })

  it('hides constant channels and shows only unknown ones', () => {
    expect(ids(filterRows(rows, { ...ALL, hideConstant: true }))).toEqual(['_Vind,_kias', 'mystr,_foo', 'fx:q'])
    expect(ids(filterRows(rows, { ...ALL, onlyUnknown: true }))).toEqual(['mystr,_foo', 'empty,___lb', 'blank,_col'])
  })

  it('filters by group', () => {
    expect(ids(filterRows(rows, { ...ALL, group: 'derived' }))).toEqual(['fx:q'])
  })
})

describe('groupOptions', () => {
  it('lists the groups present in picker order with their counts', () => {
    const options = groupOptions(channelRows(dataset()))
    const order = new Map(allGroups().map((g, i) => [g.id, g.order ?? i]))
    const expected = [
      { id: 'other', count: 4 },
      { id: 'derived', count: 1 },
    ].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    expect(options.map(({ id, count }) => ({ id, count }))).toEqual(expected)
  })
})

describe('sorting', () => {
  const rows = channelRows(dataset())

  it('cycles ascending, descending, file order', () => {
    const asc = nextSort(FILE_ORDER, 'mean')
    expect(asc).toEqual({ key: 'mean', dir: 'asc' })
    const desc = nextSort(asc, 'mean')
    expect(desc).toEqual({ key: 'mean', dir: 'desc' })
    expect(nextSort(desc, 'mean')).toEqual(FILE_ORDER)
    expect(nextSort(desc, 'label')).toEqual({ key: 'label', dir: 'asc' })
  })

  it('sorts numbers with missing values last in both directions', () => {
    expect(ids(sortRows(rows, { key: 'mean', dir: 'asc' }))).toEqual([
      'mystr,_foo',
      '_Vind,_kias',
      'fx:q',
      'empty,___lb',
      'blank,_col',
    ])
    expect(ids(sortRows(rows, { key: 'mean', dir: 'desc' })).at(-1)).toBe('blank,_col')
    expect(ids(sortRows(rows, { key: 'finite', dir: 'desc' })).slice(0, 2)).toEqual(['mystr,_foo', 'empty,___lb'])
  })

  it('sorts text naturally and puts channels without a unit last', () => {
    expect(ids(sortRows(rows, { key: 'label', dir: 'asc' }))[0]).toBe('mystr,_foo')
    expect(ids(sortRows(rows, { key: 'unit', dir: 'asc' }))).toEqual([
      '_Vind,_kias',
      'empty,___lb',
      'fx:q',
      'mystr,_foo',
      'blank,_col',
    ])
  })

  it('sorts by flags: formulas, then unknown, then constant', () => {
    expect(ids(sortRows(rows, { key: 'flags', dir: 'desc' }))).toEqual([
      'fx:q',
      'empty,___lb',
      'blank,_col',
      'mystr,_foo',
      '_Vind,_kias',
    ])
  })

  it('keeps file order without a sort and never changes its input', () => {
    const shuffled = [rows[3], rows[0], rows[4], rows[1], rows[2]]
    expect(ids(sortRows(shuffled, FILE_ORDER))).toEqual(ids(rows))
    expect(ids(shuffled)[0]).toBe('blank,_col')
  })
})

describe('counts', () => {
  const rows = channelRows(dataset())

  it('counts constant, unknown and formula channels', () => {
    expect(channelCounts(rows)).toEqual({ total: 5, constant: 2, unknown: 3, formulas: 1 })
  })

  it('counts the rows shown, out of the whole file, when filtered', () => {
    expect(countsText(channelCounts(rows), 5)).toBe('5 channels · 2 constant · 3 unknown · 1 formula')
    // KIAS and the formula: neither constant nor unknown, whatever the rest of the file holds.
    expect(countsText(channelCounts([rows[0], rows[4]]), 5)).toBe('2 of 5 channels · 0 constant · 0 unknown · 1 formula')
    expect(countsText(channelCounts(rows.slice(1, 3)), 5)).toBe('2 of 5 channels · 1 constant · 2 unknown')
    expect(countsText({ total: 1, constant: 0, unknown: 0, formulas: 0 }, 1)).toBe('1 channel · 0 constant · 0 unknown')
  })
})

describe('statistics in the narrow number columns', () => {
  it('keeps 4 significant figures and writes small magnitudes as exponents, so nothing is cut', () => {
    expect(statText(0.00031416)).toBe('3.142e−4')
    expect(statText(-0.00071234)).toBe('−7.123e−4')
    expect(statText(-4.2516e-7)).toBe('−4.252e−7')
    expect(statText(0.0061234)).toBe('0.006123')
    expect(statText(12000.4)).toBe('12000')
    expect(statText(123456.7)).toBe('123457')
    expect(statText(-512345678)).toBe('−5.123e8')
    expect(statText(2e6)).toBe('2e6')
    expect(statText(-250.256)).toBe('−250.3')
    expect(statText(0)).toBe('0')
    expect(statText(Number.NaN)).toBe('—')
    for (const v of [0.00031416, -0.00071234, -4.2516e-7, 123456.7, -98765.4321, 1.5e12]) expect(statText(v).length).toBeLessThanOrEqual(10)
  })

  it('gives the value to 7 figures in the tooltip', () => {
    expect(statTitle(0.00031416)).toBe('0.00031416')
    expect(statTitle(-250.256)).toBe('−250.256')
  })
})

describe('channelsTableText', () => {
  const rows = channelRows(dataset())

  it('writes plain numbers, empty cells for missing values and CRLF lines', () => {
    const csv = channelsTableText(rows, ',')
    const lines = csv.split('\r\n')
    expect(lines[0].split(',')).toEqual([
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
    ])
    expect(lines).toHaveLength(rows.length + 2)
    expect(lines.at(-1)).toBe('')
    // The mystery channel: ASCII minus, full precision.
    const cells = lines[2].split(',')
    const min = cells.indexOf('-5')
    expect(min).toBeGreaterThan(0)
    expect(Number(cells[min + 1])).toBeCloseTo(0.75, 12)
    expect(cells[min + 2]).toBe('7')
    // No values at all: empty statistics.
    expect(lines[4]).toContain(',,,,,0,1,0,1,')
  })

  it('quotes cells with the delimiter and defuses spreadsheet formulas', () => {
    const csv = channelsTableText(rows, ',')
    // The id "_Vind,_kias" holds a comma.
    expect(csv).toContain('"_Vind,_kias"')
    // A label starting with "=" is not run as a formula by a spreadsheet.
    expect(csv).toContain("'=mystery")
    const tsv = channelsTableText(rows, '\t')
    expect(tsv.split('\r\n')[1].split('\t')[4]).toBe('_Vind,_kias')
  })
})

describe('channelHelp', () => {
  it('joins the description, sign convention and expression', () => {
    const [kias, , , , q] = dataset().channels
    expect(channelHelp(kias)).toBe('Airspeed shown on the ASI\nSign: Always positive')
    expect(channelHelp(q)).toBe('Dynamic pressure\n= Vind_kias * 2')
  })
})
