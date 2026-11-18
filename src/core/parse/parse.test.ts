import { describe, expect, it } from 'vitest'
import { XPLANE_737_HEADER, XPLANE_737_ROWS, XPLANE_737_TEXT, xplaneLine as xpLine, xplaneText } from './fixtures'
import { ParseError, createStreamingParser, parseFile, parseText, type RawTable } from './index'

// ------------------------------------------------------------------ helpers

const HEAD = ['_real,_time', '_totl,_time', '_Vind,_kias']

/** A Data.txt: blank first line, header, rows, each line ended with CRLF. */
function xpText(rows: readonly (readonly (string | number)[])[], header: readonly string[] = HEAD): string {
  return xplaneText(header, rows)
}

function column(table: RawTable, name: string): number[] {
  const index = table.headers.indexOf(name)
  if (index < 0) throw new Error(`no column ${name}`)
  return Array.from(table.columns[index])
}

function errorOf(run: () => unknown): ParseError {
  try {
    run()
  } catch (error) {
    if (error instanceof ParseError) return error
    throw error
  }
  throw new Error('expected a ParseError')
}

/** Parses text pushed in the given pieces; returns the table or the error message (for comparing outcomes). */
function outcome(pieces: readonly string[]): RawTable | string {
  const parser = createStreamingParser()
  try {
    for (const piece of pieces) parser.push(piece)
    return parser.finish()
  } catch (error) {
    if (error instanceof ParseError) return `ParseError: ${error.message}`
    throw error
  }
}

function piecesOf(text: string, size: number): string[] {
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size))
  return pieces
}

/** Tables equal value by value (NaN equals NaN, -0 differs from 0), or the same error. */
function expectSame(actual: RawTable | string, expected: RawTable | string, context: string): void {
  if (typeof expected === 'string' || typeof actual === 'string') {
    expect(actual, context).toEqual(expected)
    return
  }
  expect({ ...actual, columns: null }, context).toEqual({ ...expected, columns: null })
  expect(actual.columns.length, context).toBe(expected.columns.length)
  expected.columns.forEach((values, c) => {
    expect(actual.columns[c].length, context).toBe(values.length)
    for (let i = 0; i < values.length; i += 1) {
      if (!Object.is(actual.columns[c][i], values[i])) {
        throw new Error(`${context}: column ${c} row ${i}: ${actual.columns[c][i]} vs ${values[i]}`)
      }
    }
  })
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------------ X-Plane

describe('parseText: X-Plane Data.txt', () => {
  it('reads a real 737 header (173 columns, repeated and three-part tokens) and rows', () => {
    const table = parseText(XPLANE_737_TEXT)
    expect(table.format).toBe('xplane')
    expect(table.headers).toHaveLength(173)
    expect(table.headers[0]).toBe('_real,_time')
    expect(table.headers[172]).toBe('vstb2,_drag')
    expect(table.headers).toContain('thrst,_1,lb')
    expect(table.headers).toContain('Lailn,1,deg')
    const repeated = [...new Set(table.headers)].filter((h) => table.headers.filter((x) => x === h).length === 2)
    expect(repeated).toHaveLength(11)
    expect(repeated).toContain('elev1,__deg')
    expect(table.rowCount).toBe(3)
    expect(table.skippedRows).toBe(0)
    expect(table.warnings).toEqual([])
    for (const values of table.columns) {
      expect(values).toHaveLength(3)
      expect(values.buffer.byteLength).toBe(3 * 8)
    }
    // The reload: mission time resets, sim time jumps, real time jumps.
    expect(column(table, '_real,_time')).toEqual([50, 56, 68])
    expect(column(table, '_totl,_time')).toEqual([30, 900, 900.1])
    expect(column(table, 'missn,_time')).toEqual([30, 0.05, 0.15])
  })

  it('does not need the blank first line, and reads LF, CRLF and a UTF-8 BOM alike', () => {
    const lf = [XPLANE_737_HEADER, ...XPLANE_737_ROWS].join('\n')
    const reference = parseText(XPLANE_737_TEXT)
    expectSame(parseText(lf), reference, 'LF, header on line 1')
    expectSame(parseText(`\uFEFF${XPLANE_737_TEXT}`), reference, 'BOM')
    expectSame(parseText(`\uFEFF${lf}\n\n\n`), reference, 'BOM + trailing blank lines')
  })

  it('skips and counts rows with the wrong number of cells; blank lines are ignored, not counted', () => {
    const text = [
      '',
      xpLine(HEAD),
      xpLine([1, 2, 3]),
      xpLine([1, 2]),
      '',
      '   \t  ',
      xpLine([1, 2, 3, 4]),
      xpLine([4, 5, 6]),
      '',
    ].join('\r\n')
    const table = parseText(text)
    expect(table.rowCount).toBe(2)
    expect(table.skippedRows).toBe(2)
    expect(table.warnings).toEqual([])
    expect(column(table, '_Vind,_kias')).toEqual([3, 6])
  })

  it('skips an incomplete last line with a warning instead of counting it', () => {
    const complete = xpText([[1, 2, 3]])
    const cutAfterCell = complete + xpLine([4, 5])
    const cutMidNumber = `${complete}${xpLine([4, 5, 6]).slice(0, -6)}`
    for (const text of [cutAfterCell, cutMidNumber]) {
      const table = parseText(text)
      expect(table.rowCount).toBe(1)
      expect(table.skippedRows).toBe(0)
      expect(table.warnings).toEqual(['The last line was incomplete and was skipped.'])
    }
    // Unterminated but complete (ends with "|"): accepted.
    const unterminated = parseText(complete + xpLine([4, 5, 6]))
    expect(unterminated.rowCount).toBe(2)
    expect(unterminated.warnings).toEqual([])
    expect(parseText(`${complete}${xpLine([4, 5, 6]).trimEnd()}`).rowCount).toBe(2)
    // A short line that IS terminated is an ordinary skipped row.
    const terminatedShort = parseText(`${complete}${xpLine([4, 5])}\r\n`)
    expect(terminatedShort.skippedRows).toBe(1)
    expect(terminatedShort.warnings).toEqual([])
  })

  it('skips a repeated identical header without counting it', () => {
    const text = ['', xpLine(HEAD), xpLine([1, 2, 3]), xpLine(HEAD), xpLine([4, 5, 6]), ''].join('\r\n')
    const table = parseText(text)
    expect(table.rowCount).toBe(2)
    expect(table.skippedRows).toBe(0)
    expect(table.warnings).toEqual([
      'The column header appears 1 more time further down the file (the output was restarted?); that line was skipped.',
    ])
  })

  it('stops at a different header (Data Output changed mid-recording) and reads only the first table', () => {
    for (const other of [['a,_b', 'c,_d'], ['a,_b', 'c,_d', 'e,_f']]) {
      const text = ['', xpLine(HEAD), xpLine([1, 2, 3]), xpLine([4, 5, 6]), xpLine(other), xpLine([7, 8, 9]), ''].join(
        '\r\n',
      )
      const parser = createStreamingParser()
      parser.push(text)
      const table = parser.finish()
      expect(parser.stopped).toBe(true)
      expect(table.headers).toEqual(HEAD)
      expect(table.rowCount).toBe(2)
      expect(table.skippedRows).toBe(0)
      expect(table.warnings).toEqual([
        'The Data Output selection changed during the recording (a new column header at line 5); only the first ' +
          'table (2 rows) was read.',
      ])
    }
  })

  it('uses the later header when the header changes before any data row', () => {
    const text = ['', xpLine(HEAD), xpLine(['a,_b', 'c,_d']), xpLine([7, 8]), ''].join('\r\n')
    const table = parseText(text)
    expect(table.headers).toEqual(['a,_b', 'c,_d'])
    expect(column(table, 'c,_d')).toEqual([8])
    expect(table.warnings).toEqual(['The column header changed before any data was recorded; the later header was used.'])
  })

  it('skips a stray line of text (a typed note, garbled bytes) as one bad row and reads on', () => {
    const rows = Array.from({ length: 6 }, (_, i) => xpLine([i, i + 0.5, 100 + i]))
    for (const stray of ['phugoid run starts here', 'Ã¿Ã¾ garbled | Ã¿ | x', '  note: CG aft | trim 2 | ', 'a,_b ; c']) {
      const text = ['', xpLine(HEAD), ...rows.slice(0, 3), stray, ...rows.slice(3), ''].join('\r\n')
      const table = parseText(text)
      expect(table.headers).toEqual(HEAD)
      expect(table.rowCount).toBe(6)
      expect(table.skippedRows).toBe(1)
      expect(table.warnings).toEqual([])
      expect(column(table, '_Vind,_kias')).toEqual([100, 101, 102, 103, 104, 105])
    }
    // Before any data row it does not replace the header either.
    const early = parseText(['', xpLine(HEAD), 'flight 2: steady climb', ...rows, ''].join('\r\n'))
    expect(early.headers).toEqual(HEAD)
    expect(early.rowCount).toBe(6)
    expect(early.warnings).toEqual([])
    // Unterminated at the very end: the incomplete last line (rule 7), not counted.
    const last = parseText(['', xpLine(HEAD), ...rows, 'end of test'].join('\r\n'))
    expect(last.rowCount).toBe(6)
    expect(last.skippedRows).toBe(0)
    expect(last.warnings).toEqual(['The last line was incomplete and was skipped.'])
  })

  it('still takes a line of X-Plane column names as a new header, even with one column', () => {
    const one = parseText(['', xpLine(HEAD), xpLine([1, 2, 3]), xpLine(['a,_b']), xpLine([4]), ''].join('\r\n'))
    expect(one.rowCount).toBe(1)
    expect(one.warnings[0]).toMatch(/^The Data Output selection changed during the recording/)
    // A minority of odd cells (an unknown token) does not hide a real header.
    const odd = parseText(['', xpLine(HEAD), xpLine([1, 2, 3]), xpLine(['a,_b', 'c,_d', 'odd']), xpLine([4, 5, 6]), ''].join('\r\n'))
    expect(odd.rowCount).toBe(1)
    expect(odd.warnings[0]).toMatch(/^The Data Output selection changed during the recording/)
  })

  it('stores nan / inf / empty / garbage as NaN and parses other number forms', () => {
    const header = ['a,_1', 'b,_2', 'c,_3', 'd,_4', 'e,_5', 'f,_6', 'g,_7', 'h,_8', 'i,_9', 'j,_10', 'k,_11', 'l,_12']
    const cells = ['nan', '-nan(ind)', 'inf', '1.#INF', '', 'abc', '1e999', 'Infinity', '1.5e3', '-2.5E-2', '+7', '.5']
    const table = parseText(xpText([cells], header))
    expect(table.rowCount).toBe(1)
    expect(table.columns.map((values) => values[0])).toEqual([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 1500, -0.025, 7, 0.5])
  })

  it('accepts a row whose cells are all nan (it is not a header)', () => {
    const table = parseText(xpText([[1, 2, 3], ['nan', 'nan', 'nan']]))
    expect(table.rowCount).toBe(2)
    expect(column(table, '_totl,_time')).toEqual([2, NaN])
    expect(table.warnings).toEqual([])
  })

  it('keeps -0 and reads large values exactly', () => {
    const table = parseText(xpText([['-0.00000', '1234567890123.4567', '-143.75827']]))
    expect(Object.is(table.columns[0][0], -0)).toBe(true)
    expect(table.columns[1][0]).toBe(Number('1234567890123.4567')) // 17 digits: the Number() path
    expect(table.columns[2][0]).toBe(-143.75827)
  })

  it('grows its column buffers and trims them to exactly rowCount', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [i * 0.1, i * 0.05, 100 + (i % 7)])
    const text = xpText(rows)
    const parser = createStreamingParser() // no size hint: starts small and doubles
    for (const piece of piecesOf(text, 997)) parser.push(piece)
    const table = parser.finish()
    expect(table.rowCount).toBe(5000)
    for (const values of table.columns) expect(values.buffer.byteLength).toBe(5000 * 8)
    expect(table.columns[0][4999]).toBe(499.9)
    // With a size hint the estimate may overshoot; the result is trimmed the same way.
    expectSame(parseText(text), table, 'size hint')
  })
})

// ------------------------------------------------------------------ errors

describe('parseText: unreadable input', () => {
  it('rejects empty and whitespace-only files', () => {
    expect(errorOf(() => parseText('')).message).toBe('The file is empty.')
    expect(errorOf(() => parseText('\uFEFF')).message).toBe('The file is empty.')
    expect(errorOf(() => parseText(' \r\n\t\n\n')).message).toBe('The file contains only blank lines.')
  })

  it('treats NUL bytes as blanks: a log cut off by a power loss still opens', () => {
    const padded = parseText(`${xpText([[1, 2, 3], [4, 5, 6]])}${'\0'.repeat(5000)}`)
    expect(padded.rowCount).toBe(2)
    expect(padded.warnings).toEqual([])
    const cut = parseText(`${xpText([[1, 2, 3]])}${xpLine([4, 5, 6]).slice(0, -8)}${'\0'.repeat(100)}`)
    expect(cut.rowCount).toBe(1)
    expect(cut.warnings).toEqual(['The last line was incomplete and was skipped.'])
    expect(errorOf(() => parseText('\0'.repeat(10))).message).toMatch(/only zero bytes/)
  })

  it('rejects binary content and recognises UTF-16 text', () => {
    expect(errorOf(() => parseText('\u0089PNG\r\n\u001a\n\0\0\0\rIHDR\0\0\u0001')).message).toMatch(/binary data/)
    const zip = `PK\u0003\u0004\u0014\0\u0006\0\b\0\0\0!\0${'[Content_Types].xml'.repeat(4)}\n`
    expect(errorOf(() => parseText(zip)).message).toMatch(/binary data/)
    const bytes = new Uint8Array([0xff, 0xfe, ...[...'a,b\r\n1,2\r\n'].flatMap((c) => [c.charCodeAt(0), 0])])
    expect(errorOf(() => parseText(new TextDecoder().decode(bytes))).message).toMatch(/UTF-16/)
  })

  it('opens an X-Plane 12 log whose header holds a stray NUL (after "sync_,butn")', () => {
    const header = ['_real,_time', 'sync_,butn\0', '_Vind,_kias']
    const text = xpText([[1, 0, 250], [2, 1, 251]], header)
    const table = parseText(text)
    expect(table.headers).toEqual(['_real,_time', 'sync_,butn', '_Vind,_kias'])
    expect(table.rowCount).toBe(2)
    expect(table.warnings).toEqual([])
    expect(column(table, '_Vind,_kias')).toEqual([250, 251])
    for (const size of [1, 7, 4096]) expectSame(outcome(piecesOf(text, size)), table, `pieces of ${size}`)
  })

  it('takes up to 1/64 of the first 4096 characters as stray NULs, and more as binary content', () => {
    const text = xpText(Array.from({ length: 120 }, (_, i) => [i, i + 0.5, 200 + i]))
    expect(text.length).toBeGreaterThan(4096)
    /** The text with its first `count` double spaces (all well inside the first 4096 characters) as " \0". */
    const withNuls = (count: number): string => {
      let n = 0
      return text.replace(/ {2}/g, (pair) => (n++ < count ? ' \0' : pair))
    }
    expect(withNuls(64).indexOf('\0', 4096 - 64)).toBe(-1)
    expectSame(outcome([withNuls(64)]), parseText(text), '64 NULs')
    expect(errorOf(() => parseText(withNuls(65))).message).toMatch(/binary data/)
  })

  it('rejects an X-Plane table without a header line', () => {
    const message = errorOf(() => parseText(`${xpLine([1, 2, 3])}\r\n${xpLine([4, 5, 6])}\r\n`)).message
    expect(message).toMatch(/No header line/)
    expect(errorOf(() => parseText('# just a comment\n')).message).toMatch(/No header line/)
  })

  it('rejects a header without rows, and rows that never match the header', () => {
    expect(errorOf(() => parseText(xpText([]))).message).toBe('The file has a column header but no complete data rows.')
    const message = errorOf(() => parseText(xpText([[1, 2], [3, 4]]))).message
    expect(message).toMatch(/None of the 2 rows below the header could be read/)
    expect(message).toMatch(/3 values/)
    expect(errorOf(() => parseText('name,comment\nalpha,beta\n')).message).toMatch(/None of the 1 row below the header/)
  })

  it('keeps throwing the same error, and finish() returns the same table twice', () => {
    const parser = createStreamingParser()
    expect(() => parser.finish()).toThrow(ParseError)
    expect(() => parser.push('x')).toThrow('The file is empty.')
    const ok = createStreamingParser()
    ok.push(xpText([[1, 2, 3]]))
    const table = ok.finish()
    expect(ok.finish()).toBe(table)
    expect(() => ok.push('more')).toThrow()
  })
})

// ------------------------------------------------------------------ CSV / TSV

describe('parseText: CSV, TSV and semicolon files', () => {
  it('reads comma-separated values with a header', () => {
    const table = parseText('time,alpha,beta\n0,1.5,-2\n0.1,1.6,-2.1\n')
    expect(table.format).toBe('csv')
    expect(table.headers).toEqual(['time', 'alpha', 'beta'])
    expect(table.rowCount).toBe(2)
    expect(column(table, 'alpha')).toEqual([1.5, 1.6])
    expect(table.warnings).toEqual([])
  })

  it('handles RFC 4180 quotes: delimiters, doubled quotes, quoted numbers', () => {
    const table = parseText('"Time (s)","Speed, indicated (kt)","Note ""x"""\r\n"0.5","120",7\r\n1,"121.5", "8" \r\n')
    expect(table.headers).toEqual(['Time (s)', 'Speed, indicated (kt)', 'Note "x"'])
    expect(table.columns.map((values) => Array.from(values))).toEqual([
      [0.5, 1],
      [120, 121.5],
      [7, 8],
    ])
  })

  it('handles line breaks inside quoted cells (header and data)', () => {
    const header = parseText('"Airspeed\r\n(kt)",Altitude\r\n120,3000\r\n121,3010\r\n')
    expect(header.headers).toEqual(['Airspeed (kt)', 'Altitude'])
    expect(header.rowCount).toBe(2)
    const data = parseText('t,note,v\n1,"two\nlines",3\n4,x,6\n')
    expect(data.rowCount).toBe(2)
    expect(column(data, 'v')).toEqual([3, 6])
    expect(data.warnings).toEqual([
      'Column "note" has no numeric values (text such as dates cannot be plotted); it is kept as an empty channel.',
    ])
  })

  it('recovers from a quote that never closes', () => {
    const table = parseText('t,v\n1,2\n"3,4\n5,6\n')
    expect(table.rowCount).toBe(2)
    expect(table.skippedRows).toBe(1)
    expect(column(table, 'v')).toEqual([2, 6])
  })

  it('treats an all-numeric first row as data and names the columns', () => {
    const table = parseText('1,2,3\n4,5,6\n')
    expect(table.headers).toEqual(['Column 1', 'Column 2', 'Column 3'])
    expect(table.rowCount).toBe(2)
    expect(column(table, 'Column 1')).toEqual([1, 4])
    expect(table.warnings).toEqual([
      'The first row contains only numbers, so it was read as data and the columns were named "Column 1" to "Column 3".',
    ])
  })

  it('keeps text columns (dates, clock times) as NaN with a warning', () => {
    const table = parseText('date,time,v\n2026-01-13,12:00:01,5\n2026-01-13,12:00:02,6\n')
    expect(table.rowCount).toBe(2)
    expect(column(table, 'date')).toEqual([NaN, NaN])
    expect(column(table, 'v')).toEqual([5, 6])
    expect(table.warnings).toEqual([
      '2 columns have no numeric values (text such as dates cannot be plotted) and are kept as empty channels: ' +
        '"date", "time".',
    ])
  })

  it('skips rows without any number (e.g. a units row) and counts them', () => {
    const table = parseText('time,speed\ns,kt\n0,100\n1,101\n')
    expect(table.rowCount).toBe(2)
    expect(table.skippedRows).toBe(1)
  })

  it('handles trailing delimiters, empty header cells and single columns', () => {
    const trailing = parseText('a,b,\r\n1,2,\r\n3,4,\r\n')
    expect(trailing.headers).toEqual(['a', 'b'])
    expect(trailing.rowCount).toBe(2)
    const emptyLast = parseText('a,b,c\n1,2,\n')
    expect(emptyLast.rowCount).toBe(1)
    expect(column(emptyLast, 'c')).toEqual([NaN])
    expect(parseText('a,,c\n1,2,3\n').headers).toEqual(['a', 'Column 2', 'c'])
    const single = parseText('time\n0\n0.5\n1\n')
    expect(single.headers).toEqual(['time'])
    expect(column(single, 'time')).toEqual([0, 0.5, 1])
  })

  it('reads tab-separated values', () => {
    const table = parseText('time\tAirspeed (kt)\talt\r\n0.0\t120.5\t3000\r\n0.1\t 121 \t3001\r\n')
    expect(table.format).toBe('csv')
    expect(table.headers).toEqual(['time', 'Airspeed (kt)', 'alt'])
    expect(column(table, 'Airspeed (kt)')).toEqual([120.5, 121])
  })

  it('reads semicolon-separated values with decimal commas', () => {
    const table = parseText('Zeit (s);Geschwindigkeit (kt);Höhe\n0,1;120,5;1000\n0,2;121,25;1001.5\n')
    expect(table.headers).toEqual(['Zeit (s)', 'Geschwindigkeit (kt)', 'Höhe'])
    expect(table.columns.map((values) => Array.from(values))).toEqual([
      [0.1, 0.2],
      [120.5, 121.25],
      [1000, 1001.5],
    ])
  })

  it('only counts delimiters outside quotes when choosing one', () => {
    expect(parseText('"a;b",c\n1,2\n').headers).toEqual(['a;b', 'c'])
    expect(parseText('"a\tb",c\n1,2\n').headers).toEqual(['a b', 'c'])
  })

  it('takes the more frequent of ";" and "," (a name may hold either), and TAB whenever there is one', () => {
    const semicolonInName = parseText('time_s,Fuel flow (lb/h; total),speed_kt\n0,1200,250\n1,1210,251\n')
    expect(semicolonInName.headers).toEqual(['time_s', 'Fuel flow (lb/h; total)', 'speed_kt'])
    expect(column(semicolonInName, 'Fuel flow (lb/h; total)')).toEqual([1200, 1210])
    const commaInName = parseText('Zeit;Wert (1,5 m);Höhe\n0,1;2,5;100\n')
    expect(commaInName.headers).toEqual(['Zeit', 'Wert (1,5 m)', 'Höhe'])
    expect(column(commaInName, 'Wert (1,5 m)')).toEqual([2.5])
    // A tie keeps ";" (whose files may use "," in numbers).
    expect(parseText('a;b,c\n1;2\n').headers).toEqual(['a', 'b,c'])
    expect(parseText('t\tPosition (x, y)\tSpeed, ground\n1\t2\t3\n').headers).toEqual(['t', 'Position (x, y)', 'Speed, ground'])
  })

  it('reads a "|" inside a CSV column name as text, not as an X-Plane table', () => {
    const quoted = parseText('time_s,"Mode A|B",speed_kt\n0,1,250\n1,2,251\n')
    expect(quoted.format).toBe('csv')
    expect(quoted.headers).toEqual(['time_s', 'Mode A|B', 'speed_kt'])
    expect(quoted.rowCount).toBe(2)
    const bare = parseText('time,a|b,c\n1,2,3\n')
    expect(bare.format).toBe('csv')
    expect(bare.headers).toEqual(['time', 'a|b', 'c'])
    // X-Plane: two or more "|", or one at the end of the line (a log of a single column).
    expect(parseText(xpText([[1, 2, 3]])).format).toBe('xplane')
    const single = parseText(['', xpLine(['_totl,_time']), xpLine([0.5]), xpLine([0.6]), ''].join('\r\n'))
    expect(single.format).toBe('xplane')
    expect(column(single, '_totl,_time')).toEqual([0.5, 0.6])
  })
})

// ------------------------------------------------------------------ chunk boundaries

describe('streaming: chunk boundaries anywhere give the same result', () => {
  const csv = '"Time (s)","Note"\r\n0.5,"a\r\nb"\r\n1,"c,""d"""\r\n1.5,e\r\n'
  const fixtures: Record<string, string> = {
    'real 737 lines + BOM': `\uFEFF${XPLANE_737_TEXT}`,
    'X-Plane: repeated header, bad row, incomplete last line': `${[
      '',
      xpLine(HEAD),
      xpLine([1, 2, 3]),
      xpLine(HEAD),
      xpLine([1, 2]),
      xpLine([4, 5, 6]),
    ].join('\r\n')}\r\n${xpLine([7, 8, 9]).slice(0, -5)}`,
    'X-Plane: header change': ['', xpLine(HEAD), xpLine([1, 2, 3]), xpLine(['a,_b']), xpLine([4]), ''].join('\n'),
    'CSV with quotes and line breaks in cells': csv,
    'semicolon + decimal comma': 'a;b\r\n1,5;2,25\r\n3;4,75',
    headerless: '1\t2\n3\t4\n',
    'binary (error)': `a | b |\r\n\0\0\0\0\r\n1 | 2 |\r\n`,
    'NUL padding after a power loss': `${xpText([[1, 2, 3]])}${xpLine([4, 5, 6]).slice(0, -8)}${'\0'.repeat(5000)}`,
    'header only (error)': xpText([]),
  }

  for (const [name, text] of Object.entries(fixtures)) {
    it(name, () => {
      const whole = outcome([text])
      for (const size of [1, 2, 3, 5, 7, 16, 64, 1000, 4095, 4096, 4097]) {
        expectSame(outcome(piecesOf(text, size)), whole, `${name}, ${size}-character chunks`)
      }
      const next = random(text.length)
      for (let round = 0; round < 25; round += 1) {
        const pieces: string[] = []
        for (let i = 0; i < text.length; ) {
          const size = next() < 0.2 ? 0 : 1 + Math.floor(next() * 300)
          pieces.push(text.slice(i, i + size))
          i += size
        }
        expectSame(outcome(pieces), whole, `${name}, random chunks round ${round}`)
      }
    })
  }

  it('every two-piece split of a CRLF file (mid-number, mid-"\\r\\n", mid-BOM line)', () => {
    const text = `\uFEFF${xpText([[1.5, -2.25, 3], [4, 5, 6e-3], ['nan', '', 7]])}${xpLine([8, 9])}`
    const whole = outcome([text])
    expect(typeof whole).not.toBe('string')
    for (let i = 0; i <= text.length; i += 1) {
      expectSame(outcome([text.slice(0, i), text.slice(i)]), whole, `split at ${i}`)
    }
  })
})

// ------------------------------------------------------------------ parseFile (main-thread fallback in Node)

describe('parseFile', () => {
  it('streams a Blob through the same parser (Node has no Worker: main-thread fallback)', async () => {
    const progress: number[] = []
    const table = await parseFile(new Blob([XPLANE_737_TEXT]), (fraction) => progress.push(fraction))
    expectSame(table, parseText(XPLANE_737_TEXT), 'parseFile vs parseText')
    expect(progress[0]).toBe(0)
    expect(progress[progress.length - 1]).toBe(1)
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
  })

  it('decodes a UTF-8 character split across chunks', async () => {
    const bytes = new TextEncoder().encode('Pitch (°),t\n1,2\n')
    const at = bytes.indexOf(0xb0) // second byte of "°"
    const table = await parseFile(new Blob([bytes.slice(0, at), bytes.slice(at)]))
    expect(table.headers).toEqual(['Pitch (°)', 't'])
  })

  it('rejects with ParseError for unreadable files', async () => {
    await expect(parseFile(new Blob([]))).rejects.toBeInstanceOf(ParseError)
    await expect(parseFile(new Blob(['\n\n']))).rejects.toThrow('The file contains only blank lines.')
  })

  it('rejects with an AbortError when aborted', async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(parseFile(new Blob([XPLANE_737_TEXT]), undefined, aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    const controller = new AbortController()
    const pending = parseFile(new Blob([XPLANE_737_TEXT]), undefined, controller.signal)
    controller.abort()
    const error: unknown = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('AbortError')
  })
})
