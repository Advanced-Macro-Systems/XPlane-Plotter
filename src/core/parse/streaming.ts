// The streaming table parser shared by parseText() and the parser worker. Text is push()ed in chunks of any size —
// a chunk may end anywhere, even inside a number or between "\r" and "\n" — and finish() returns the RawTable.
//
// ACCEPTANCE RULE. The MATLAB exporter (readXPlaneLog in core/export/matlabLibrary.ts) re-reads the original log and
// must accept exactly the rows this parser accepts, so it mirrors these rules — change both together.
//
//  1. Lines. The text is split at "\n"; one trailing "\r" per line is removed; a UTF-8 BOM at the very start is
//     ignored. "Blank" characters are space, tab and NUL (a log cut off by a power loss can end in NUL bytes, and
//     X-Plane 12 writes a NUL after the column name "sync_,butn"). Blank lines (empty, or only blank characters) are
//     ignored everywhere and never counted.
//  2. Header. The first non-blank line that does not start with "#" is the header. Characters between double quotes
//     do not count in this rule (an unclosed quote runs to the end of the line). If the header has at least two "|",
//     or ends with "|" (blanks aside), the file is an X-Plane table (no quoting). Otherwise it is CSV-like with
//     RFC 4180 double quotes (a quoted cell may contain the delimiter, "" for a quote, and line breaks), and the
//     delimiter is TAB if the header has one; else whichever of ";" and "," it has more of (";" on a tie, "," when
//     it has neither). With ";" a decimal comma is accepted in numbers ("1,25").
//  3. Cells. A line is split at every delimiter and each cell is trimmed of blanks. If the header's last cell is
//     empty (X-Plane ends every line with "| "), that trailing empty cell is dropped — from the header and from
//     every data line that ends with a delimiter. X-Plane lines always drop it.
//     A CSV header whose cells are all numbers is no header: the columns are named "Column 1", "Column 2", ... and
//     that line is the first data line. An X-Plane header must contain at least one non-numeric cell.
//  4. Values. A cell is a number if it parses as a decimal number ([sign]digits[.digits][e[sign]digits], or anything
//     else JavaScript's Number() accepts). Everything else is NaN: empty cells, text, and "nan"/"inf" spellings.
//     Infinite values are stored as NaN.
//  5. Header-like lines are lines with at least one non-empty cell where no cell is a number or a nan/inf spelling.
//     A header-like line identical to the header (same trimmed cells) is skipped and not counted: X-Plane repeats
//     the header when the output restarts. In an X-Plane file a DIFFERENT header-like line that looks like a header
//     (it contains "|", and more than half of its non-empty cells are shaped like X-Plane column names: no blank or
//     comma, then a comma, then no blank or comma, as in "_Vind,_kias") means the Data Output selection changed
//     mid-recording: reading stops there with a warning (only the first table is read) — unless no row has been
//     accepted yet, in which case the new header replaces the old one. Any other header-like line of an X-Plane file
//     (a note typed into the log, garbled bytes) is never a data row: it is skipped and counted, like a bad row (or
//     is the incomplete last line of rule 7).
//  6. A data line is ACCEPTED iff it has exactly as many cells as the header (CSV-like files: and at least one cell
//     is a number). Any other data line is skipped and counted in `skippedRows`, EXCEPT rule 7.
//  7. The last line of the file, when it is not terminated by "\n", is incomplete if it has fewer cells than the
//     header or (X-Plane) does not end with "|" (a row cut off mid-write): it is skipped with the warning
//     "The last line was incomplete and was skipped." and not counted.
//
// Errors (ParseError, user-facing): empty or whitespace-only input; first 4096 characters (a trailing run of NULs
// aside) that hold NULs and are either UTF-16 text or more than 1/64 NUL and other control characters (binary: a few
// stray NULs in plain text are blanks); no header line; and a header without a single accepted row.

import type { DatasetFormat } from '../types'
import { CELL_EMPTY, CELL_MISSING, CELL_NUMBER, CELL_TEXT, NumberScanner, parseCell, type CellResult } from './numbers'
import { ParseError, type RawTable } from './table'

const NUL = 0
const LF = 10
const CR = 13
const TAB = 9
const SPACE = 32
const QUOTE = 34
const HASH = 35
const SEMICOLON = 59
const COMMA = 44
const PIPE = 124
const BOM = 0xfeff

/** Characters checked for NUL bytes before any line is read (so the outcome never depends on chunk sizes). */
const PROBE_LENGTH = 4096
/**
 * Binary content: NUL and other control characters (TAB, LF and CR aside) are more than this share of the probe.
 * A few stray NULs in plain text are blanks (rule 1): X-Plane 12 writes one after the column name "sync_,butn".
 * Binary files (a spreadsheet, an image, a MAT-file) have them by the dozen in their first few kilobytes.
 */
const BINARY_SHARE = 1 / 64
/** A quoted CSV cell may span at most this many lines; beyond that the opening quote is taken as a stray character. */
const MAX_RECORD_LINES = 100
/** Upper bound for the up-front column allocation (cells), whatever the size estimate says. */
const MAX_INITIAL_CELLS = 8_000_000
const MIN_CAPACITY = 256

const MESSAGE_BINARY =
  'This file does not look like a text log (it contains binary data). Open the Data.txt that X-Plane writes in its ' +
  'main folder, or a CSV/TSV table.'
const MESSAGE_UTF16 =
  'This file is saved as UTF-16 ("Unicode") text, which cannot be read. Save it as UTF-8 or ANSI text and open it again.'
const MESSAGE_NO_HEADER =
  'No header line was found. An X-Plane Data.txt starts with a line of column names such as ' +
  '"_real,_time | _totl,_time | …" — the top of this file seems to be missing.'

export interface StreamingParserOptions {
  /**
   * Expected total input length (characters or bytes). Optional: it only sizes the column buffers up front so they
   * rarely need to grow.
   */
  sizeHint?: number
}

export interface StreamingParser {
  /** Feeds the next piece of text. Throws ParseError as soon as the input is known to be unreadable. */
  push(chunk: string): void
  /** Ends the input and returns the table (columns trimmed to exactly rowCount). Throws ParseError. */
  finish(): RawTable
  /** true once further input is ignored (the header changed mid-file): callers may stop reading early. */
  readonly stopped: boolean
}

export function createStreamingParser(options: StreamingParserOptions = {}): StreamingParser {
  return new TableParser(options.sizeHint ?? 0)
}

type Phase = 'preamble' | 'data' | 'stopped'

function isBlank(code: number): boolean {
  return code === SPACE || code === TAB || code === NUL
}

/** trim() that also removes NUL characters (see rule 1). */
function trimCell(cell: string): string {
  const trimmed = cell.trim()
  return trimmed.includes('\0') ? trimmed.replace(/^[\s\0]+|[\s\0]+$/g, '') : trimmed
}

/** Header cells are compared and displayed with runs of whitespace (including line breaks) collapsed. */
function normalizeCell(cell: string): string {
  return cell.replace(/[\s\0]+/g, ' ').trim()
}

/** An X-Plane column name (a normalised cell): no blank or comma, a comma, no blank or comma ("_Vind,_kias"). */
const XPLANE_NAME = /^[^, ]+,[^, ]+/

/**
 * Rule 5: more than half of the non-empty (normalised) cells are shaped like X-Plane column names, as in a new header
 * after the Data Output selection changed; a note typed into the log or a line of garbled bytes is not.
 */
function looksLikeXPlaneHeader(cells: readonly string[]): boolean {
  let filled = 0
  let names = 0
  for (const cell of cells) {
    if (!cell) continue
    filled += 1
    if (XPLANE_NAME.test(cell)) names += 1
  }
  return 2 * names > filled
}

function sameCells(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Odd number of double quotes: a quoted cell continues on the next line. */
function hasOpenQuote(text: string): boolean {
  let count = 0
  for (let q = text.indexOf('"'); q !== -1; q = text.indexOf('"', q + 1)) count += 1
  return count % 2 === 1
}

/**
 * Splits one CSV/TSV record (which may contain line breaks inside quotes) into raw cells, RFC 4180 style: a cell that
 * starts with a double quote (after blanks) runs to the matching quote, "" inside it is one quote, and any text after
 * the closing quote up to the delimiter is kept. Returns null when a quoted cell is still open at the end of the
 * record, unless `lenient`, which closes it at the end.
 */
export function splitQuoted(record: string, delimiter: string, lenient: boolean): string[] | null {
  const cells: string[] = []
  const n = record.length
  const tabIsBlank = delimiter !== '\t'
  let i = 0
  for (;;) {
    let j = i
    while (j < n) {
      const c = record.charCodeAt(j)
      if (c === SPACE || c === NUL || (c === TAB && tabIsBlank)) j += 1
      else break
    }
    if (j < n && record.charCodeAt(j) === QUOTE) {
      let value = ''
      let k = j + 1
      for (;;) {
        const q = record.indexOf('"', k)
        if (q === -1) {
          if (!lenient) return null
          value += record.slice(k)
          k = n
          break
        }
        if (record.charCodeAt(q + 1) === QUOTE) {
          value += record.slice(k, q + 1)
          k = q + 2
          continue
        }
        value += record.slice(k, q)
        k = q + 1
        break
      }
      const d = record.indexOf(delimiter, k)
      value += d === -1 ? record.slice(k) : record.slice(k, d)
      cells.push(value)
      if (d === -1) return cells
      i = d + 1
    } else {
      const d = record.indexOf(delimiter, i)
      if (d === -1) {
        cells.push(record.slice(i))
        return cells
      }
      cells.push(record.slice(i, d))
      i = d + 1
    }
  }
}

class TableParser implements StreamingParser {
  private readonly sizeHint: number
  private readonly numbers = new NumberScanner()
  private readonly cell: CellResult = { value: NaN, kind: CELL_EMPTY }

  // ---- input
  /** Text received but not yet split into complete lines (the partial last line, or everything during the probe) */
  private pending: string[] = []
  private seenInput = false
  private totalChars = 0
  private probe = ''
  private probeDone = false
  /** The probe was nothing but NUL characters */
  private zeroBytes = false
  private sawText = false
  /** Physical lines read so far: the 1-based number of the line being processed */
  private lineNo = 0
  /** Cache for hasQuote(): index of the next '"' in the current chunk text; -2 = not searched yet, -1 = none */
  private quotePos = -2
  private failure: unknown = null
  private result: RawTable | null = null

  // ---- format (fixed by the header)
  private phase: Phase = 'preamble'
  private format: DatasetFormat = 'xplane'
  private delimiter = PIPE
  private delimiterChar = '|'
  private quoting = false
  private decimalComma = false
  private dropTrailingEmpty = false
  private headerless = false
  /** The header's cells as written (normalized), to recognise a repeated header */
  private headerCells: string[] = []
  private headers: string[] = []

  // ---- columns
  private ncols = 0
  private columns: Float64Array[] = []
  private capacity = 0
  private rowCount = 0

  // ---- the row being scanned (outputs of scanLine / handleCells)
  private rowCells = 0
  private rowNumbers = 0
  private rowTexts = 0
  private rowMissing = 0
  private rowEndsWithDelimiter = false

  // ---- bookkeeping
  private skippedRows = 0
  private firstBadCells = -1
  private repeatedHeaders = 0
  private incompleteLastLine = false
  private readonly notes: string[] = []

  // ---- a CSV record whose quoted cell continues on the next line(s)
  private open: string[] | null = null
  private openTerminated = true

  constructor(sizeHint: number) {
    this.sizeHint = Number.isFinite(sizeHint) && sizeHint > 0 ? sizeHint : 0
  }

  get stopped(): boolean {
    return this.phase === 'stopped'
  }

  push(chunk: string): void {
    if (this.failure !== null) throw this.failure
    if (this.result) throw new Error('StreamingParser.push() was called after finish().')
    if (chunk.length === 0 || this.phase === 'stopped') return
    let text = chunk
    if (!this.seenInput) {
      this.seenInput = true
      if (text.charCodeAt(0) === BOM) text = text.slice(1)
      if (text.length === 0) return
    }
    try {
      this.totalChars += text.length
      if (!this.probeDone) {
        this.probe += text.slice(0, PROBE_LENGTH - this.probe.length)
        if (this.probe.length < PROBE_LENGTH) {
          this.pending.push(text)
          return
        }
        this.checkProbe()
      }
      this.consume(text)
    } catch (error) {
      this.failure = error
      throw error
    }
  }

  finish(): RawTable {
    if (this.failure !== null) throw this.failure
    if (this.result) return this.result
    try {
      if (!this.probeDone) this.checkProbe()
      // Only when the whole input was shorter than the probe can `pending` still hold complete lines.
      const text = this.pending.join('')
      this.pending = []
      if (!this.stopped && text.length > 0) this.consume(text)
      // What is left is the last line, not terminated by "\n".
      const last = this.pending.join('')
      this.pending = []
      if (!this.stopped && last.length > 0) {
        this.quotePos = -2
        this.processLine(last, 0, last.length, false)
      }
      // End of file inside a quoted CSV cell: re-read those lines as if the quote closed at the end of its line.
      while (this.open !== null) this.recoverOpenRecord()
      this.result = this.buildResult()
      return this.result
    } catch (error) {
      this.failure = error
      throw error
    }
  }

  // ------------------------------------------------------------------ input -> lines

  private checkProbe(): void {
    this.probeDone = true
    // A trailing run of NULs is a log cut off by a power loss (blank, rule 1), not binary content.
    const probe = this.probe.replace(/\0+$/, '')
    this.zeroBytes = probe.length === 0 && this.probe.length > 0
    this.probe = ''
    if (probe.indexOf('\0') === -1) return
    // UTF-16 text of ASCII characters decodes (as UTF-8) to every other character being NUL.
    let even = 0
    let odd = 0
    let control = 0
    for (let i = 0; i < probe.length; i += 1) {
      const c = probe.charCodeAt(i)
      if (c === NUL) {
        if (i % 2 === 0) even += 1
        else odd += 1
      } else if (c < SPACE && c !== TAB && c !== LF && c !== CR) {
        control += 1
      }
    }
    const nul = even + odd
    if (nul * 3 >= probe.length && Math.max(even, odd) >= nul * 0.9) throw new ParseError(MESSAGE_UTF16)
    // A few stray NULs in plain text are blanks (rule 1), like the one X-Plane 12 writes after "sync_,butn".
    if (nul + control > probe.length * BINARY_SHARE) throw new ParseError(MESSAGE_BINARY)
  }

  /** Processes every complete line in pending + chunk and keeps the unterminated rest. */
  private consume(chunk: string): void {
    let nl = chunk.indexOf('\n')
    if (nl === -1) {
      this.pending.push(chunk)
      return
    }
    let text = chunk
    if (this.pending.length > 0) {
      const head = this.pending.length === 1 ? this.pending[0] : this.pending.join('')
      this.pending = []
      text = head + chunk
      // Usually `head` is one partial line, but text buffered during the probe can hold whole lines.
      nl = text.indexOf('\n')
    }
    this.quotePos = -2
    let pos = 0
    while (nl !== -1) {
      this.processLine(text, pos, nl, true)
      if (this.phase === 'stopped') return
      pos = nl + 1
      nl = text.indexOf('\n', pos)
    }
    if (pos < text.length) this.pending.push(text.slice(pos))
  }

  /** One physical line text[start, end) (without its "\n"). `terminated`: false only for an unterminated last line. */
  private processLine(text: string, start: number, end: number, terminated: boolean): void {
    this.lineNo += 1
    const stop = end > start && text.charCodeAt(end - 1) === CR ? end - 1 : end
    if (this.phase === 'stopped') return
    if (this.open !== null) {
      this.continueRecord(text.slice(start, stop), terminated)
      return
    }
    this.routeLine(text, start, stop, terminated, true)
  }

  /**
   * A line that does not continue an open quoted cell. `cached`: `text` is the current chunk, so the quote-position
   * cache applies (it keeps the search for quotes linear in the chunk length).
   */
  private routeLine(text: string, start: number, end: number, terminated: boolean, cached: boolean): void {
    let i = start
    while (i < end && isBlank(text.charCodeAt(i))) i += 1
    if (i === end) return
    this.sawText = true
    if (this.phase === 'preamble') {
      if (text.charCodeAt(i) === HASH) return
      const line = text.slice(start, end)
      if (!line.includes('|') && hasOpenQuote(line)) {
        this.openRecord(line, terminated)
        return
      }
      this.beginTable(line, terminated)
      return
    }
    if (this.quoting && this.hasQuote(text, start, end, cached)) {
      const line = text.slice(start, end)
      const cells = splitQuoted(line, this.delimiterChar, false)
      if (cells === null) this.openRecord(line, terminated)
      else this.handleCells(cells, terminated)
      return
    }
    this.handleLine(text, start, end, terminated)
  }

  private hasQuote(text: string, start: number, end: number, cached: boolean): boolean {
    if (!cached) {
      const q = text.indexOf('"', start)
      return q !== -1 && q < end
    }
    if (this.quotePos === -2 || (this.quotePos !== -1 && this.quotePos < start)) {
      this.quotePos = text.indexOf('"', start)
    }
    return this.quotePos !== -1 && this.quotePos < end
  }

  // ------------------------------------------------------------------ CSV records spanning several lines

  private openRecord(line: string, terminated: boolean): void {
    this.open = [line]
    this.openTerminated = terminated
    if (!terminated) this.recoverOpenRecord()
  }

  private continueRecord(line: string, terminated: boolean): void {
    const open = this.open ?? []
    open.push(line)
    this.openTerminated = terminated
    const record = open.join('\n')
    if (this.phase === 'preamble') {
      if (!hasOpenQuote(record)) {
        this.open = null
        this.beginTable(record, terminated)
        return
      }
    } else {
      const cells = splitQuoted(record, this.delimiterChar, false)
      if (cells !== null) {
        this.open = null
        this.handleCells(cells, terminated)
        return
      }
    }
    if (!terminated || open.length >= MAX_RECORD_LINES) this.recoverOpenRecord()
  }

  /**
   * A quote opened a cell that never closed (end of file, or too many lines): read the first line on its own as if
   * the quote closed at its end, then re-read the following lines normally. Each call consumes at least one line.
   */
  private recoverOpenRecord(): void {
    const lines = this.open ?? []
    this.open = null
    if (lines.length === 0) return
    const lastTerminated = this.openTerminated
    const firstTerminated = lines.length > 1 || lastTerminated
    if (this.phase === 'preamble') this.beginTable(lines[0], firstTerminated)
    else this.handleCells(splitQuoted(lines[0], this.delimiterChar, true) ?? [lines[0]], firstTerminated)
    for (let k = 1; k < lines.length; k += 1) {
      const terminated = k < lines.length - 1 || lastTerminated
      if (this.open !== null) this.continueRecord(lines[k], terminated)
      else this.routeLine(lines[k], 0, lines[k].length, terminated, false)
    }
  }

  // ------------------------------------------------------------------ header

  private beginTable(record: string, terminated: boolean): void {
    this.chooseFormat(record)
    const cells =
      this.quoting && record.includes('"')
        ? (splitQuoted(record, this.delimiterChar, true) ?? [record])
        : record.split(this.delimiterChar)
    this.setHeader(cells, record.length)
    // A CSV whose first line is all numbers has no header: that line is also the first data row.
    if (this.headerless) this.handleCells(cells, terminated)
  }

  /** Rule 2. Only characters outside double quotes count: "Mode A|B" or "lb/h; total" inside a quoted name do not. */
  private chooseFormat(header: string): void {
    let pipes = 0
    let tabs = 0
    let semicolons = 0
    let commas = 0
    let quoted = false
    // The last character that is not blank (a quoted stretch counts as its quote characters).
    let last = 0
    for (let i = 0; i < header.length; i += 1) {
      const c = header.charCodeAt(i)
      if (c === QUOTE) quoted = !quoted
      else if (quoted) continue
      else if (c === PIPE) pipes += 1
      else if (c === TAB) tabs += 1
      else if (c === SEMICOLON) semicolons += 1
      else if (c === COMMA) commas += 1
      if (!isBlank(c)) last = c
    }
    // X-Plane writes "name | name | ... | ": a single "|" inside a CSV column name does not make a pipe table.
    if (pipes >= 2 || last === PIPE) {
      this.format = 'xplane'
      this.delimiter = PIPE
      this.quoting = false
      this.decimalComma = false
      this.dropTrailingEmpty = true
    } else {
      // A TAB is never part of a column name; between ";" and "," (either may sit inside a name, and a ";" file may
      // use "," in numbers) the more frequent one separates the cells.
      this.format = 'csv'
      this.delimiter = tabs > 0 ? TAB : semicolons > 0 && semicolons >= commas ? SEMICOLON : COMMA
      this.quoting = true
      this.decimalComma = this.delimiter === SEMICOLON
      this.dropTrailingEmpty = false
    }
    this.delimiterChar = String.fromCharCode(this.delimiter)
  }

  /** Sets (or replaces) the header and allocates the columns. `lineLength` sizes the initial buffers. */
  private setHeader(rawCells: readonly string[], lineLength: number): void {
    const cells = rawCells.map(normalizeCell)
    if (cells.length > 1 && cells[cells.length - 1] === '') {
      cells.pop()
      this.dropTrailingEmpty = true
    }
    let numbers = 0
    let texts = 0
    for (const text of cells) {
      parseCell(text, this.decimalComma, this.cell)
      if (this.cell.kind === CELL_NUMBER) numbers += 1
      else if (this.cell.kind === CELL_TEXT) texts += 1
    }
    if (this.format === 'xplane' && texts === 0) throw new ParseError(MESSAGE_NO_HEADER)
    this.headerless = this.format === 'csv' && texts === 0 && numbers > 0
    this.headerCells = this.headerless ? [] : cells
    this.headers = cells.map((name, i) => (this.headerless || name === '' ? `Column ${i + 1}` : name))
    this.ncols = cells.length
    this.allocate(lineLength)
    this.phase = 'data'
  }

  private allocate(lineLength: number): void {
    let capacity = MIN_CAPACITY
    if (this.sizeHint > 0) {
      // X-Plane pads every cell to the same width, so data lines are about as long as the header line.
      const estimate = Math.ceil((this.sizeHint / Math.max(lineLength + 1, 8)) * 1.05) + 16
      const budget = Math.floor(MAX_INITIAL_CELLS / this.ncols)
      capacity = Math.max(MIN_CAPACITY, Math.min(estimate, budget))
    }
    this.capacity = capacity
    this.columns = Array.from({ length: this.ncols }, () => new Float64Array(capacity))
    this.rowCount = 0
  }

  private grow(): void {
    const capacity = this.capacity * 2
    for (let c = 0; c < this.ncols; c += 1) {
      const next = new Float64Array(capacity)
      next.set(this.columns[c])
      this.columns[c] = next
    }
    this.capacity = capacity
  }

  // ------------------------------------------------------------------ data rows

  /** A data line without quotes (every X-Plane line): scanned in place, values written straight into the columns. */
  private handleLine(text: string, start: number, end: number, terminated: boolean): void {
    if (this.rowCount === this.capacity) this.grow()
    this.scanLine(text, start, end)
    if (this.rowTexts > 0 && this.rowNumbers === 0 && this.rowMissing === 0) {
      if (this.headerLikeRow(text.slice(start, end).split(this.delimiterChar), terminated)) return
    }
    this.decideRow(terminated)
  }

  /** A CSV record already split into cells (it had quotes, or it is the first row of a headerless file). */
  private handleCells(cells: readonly string[], terminated: boolean): void {
    if (this.rowCount === this.capacity) this.grow()
    let count = cells.length
    if (this.dropTrailingEmpty && count > 1 && trimCell(cells[count - 1]) === '') count -= 1
    const row = this.rowCount
    let numbers = 0
    let texts = 0
    let missing = 0
    for (let c = 0; c < count; c += 1) {
      parseCell(trimCell(cells[c]), this.decimalComma, this.cell)
      const kind = this.cell.kind
      if (kind === CELL_NUMBER) numbers += 1
      else if (kind === CELL_TEXT) texts += 1
      else if (kind === CELL_MISSING) missing += 1
      if (c < this.ncols) this.columns[c][row] = this.cell.value
    }
    this.rowCells = count
    this.rowNumbers = numbers
    this.rowTexts = texts
    this.rowMissing = missing
    this.rowEndsWithDelimiter = true
    if (texts > 0 && numbers === 0 && missing === 0 && this.headerLikeRow(cells, terminated)) return
    this.decideRow(terminated)
  }

  /**
   * The hot loop: splits text[start, end) at the delimiter and parses each cell into the columns at row `rowCount`
   * (the row only becomes real when decideRow() accepts it; otherwise the next row overwrites it).
   */
  private scanLine(text: string, start: number, end: number): void {
    const delimiter = this.delimiter
    const tabIsBlank = delimiter !== TAB
    const columns = this.columns
    const ncols = this.ncols
    const row = this.rowCount
    const numbers = this.numbers
    const decimalComma = this.decimalComma
    let cells = 0
    let numeric = 0
    let texts = 0
    let missing = 0
    let endsWithDelimiter = false
    let i = start
    for (;;) {
      while (i < end) {
        const c = text.charCodeAt(i)
        if (c === SPACE || (c === TAB && tabIsBlank) || c === NUL) i += 1
        else break
      }
      if (i >= end) {
        // An empty last cell: the line ends with a delimiter (and blanks).
        endsWithDelimiter = cells > 0
        if (!(this.dropTrailingEmpty && cells > 0)) {
          if (cells < ncols) columns[cells][row] = NaN
          cells += 1
        }
        break
      }
      let value = numbers.scan(text, i, end, decimalComma)
      let next = i
      if (!Number.isNaN(value)) {
        // A number must be followed by blanks, then the delimiter or the end of the line.
        next = numbers.end
        while (next < end) {
          const c = text.charCodeAt(next)
          if (c === SPACE || (c === TAB && tabIsBlank) || c === NUL) next += 1
          else break
        }
        if (next < end && text.charCodeAt(next) !== delimiter) value = NaN
      }
      if (!Number.isNaN(value)) {
        numeric += 1
      } else {
        next = i
        while (next < end && text.charCodeAt(next) !== delimiter) next += 1
        parseCell(trimCell(text.slice(i, next)), decimalComma, this.cell)
        value = this.cell.value
        const kind = this.cell.kind
        if (kind === CELL_NUMBER) numeric += 1
        else if (kind === CELL_TEXT) texts += 1
        else if (kind === CELL_MISSING) missing += 1
      }
      if (cells < ncols) columns[cells][row] = value
      cells += 1
      if (next >= end) break
      i = next + 1
    }
    this.rowCells = cells
    this.rowNumbers = numeric
    this.rowTexts = texts
    this.rowMissing = missing
    this.rowEndsWithDelimiter = endsWithDelimiter
  }

  /**
   * Rule 5. Returns true when the line was consumed (repeated header, new header, end of the first table, or a stray
   * line of text in an X-Plane log).
   */
  private headerLikeRow(rawCells: readonly string[], terminated: boolean): boolean {
    const cells = rawCells.map(normalizeCell)
    if (this.dropTrailingEmpty && cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
    if (sameCells(cells, this.headerCells)) {
      this.repeatedHeaders += 1
      return true
    }
    if (this.format !== 'xplane') return false
    if (!(rawCells.length > 1 && looksLikeXPlaneHeader(cells))) {
      // A note typed into the log, or garbled bytes: not a new table, and never a data row (it holds no number).
      if (!terminated && (this.rowCells < this.ncols || !this.rowEndsWithDelimiter)) {
        this.incompleteLastLine = true
      } else {
        this.skippedRows += 1
        if (this.firstBadCells < 0) this.firstBadCells = this.rowCells
      }
      return true
    }
    if (this.rowCount === 0) {
      this.notes.push('The column header changed before any data was recorded; the later header was used.')
      this.setHeader(cells, cells.join(' | ').length)
      return true
    }
    this.notes.push(
      `The Data Output selection changed during the recording (a new column header at line ${this.lineNo}); ` +
        `only the first table (${this.rowCount} rows) was read.`,
    )
    this.phase = 'stopped'
    this.pending = []
    return true
  }

  /** Rules 6 and 7 for the row just scanned. */
  private decideRow(terminated: boolean): void {
    const cells = this.rowCells
    if (!terminated && (cells < this.ncols || (this.format === 'xplane' && !this.rowEndsWithDelimiter))) {
      this.incompleteLastLine = true
      return
    }
    if (cells === this.ncols && (this.format === 'xplane' || this.rowNumbers > 0)) {
      this.rowCount += 1
      return
    }
    this.skippedRows += 1
    if (this.firstBadCells < 0) this.firstBadCells = cells
  }

  // ------------------------------------------------------------------ result

  private buildResult(): RawTable {
    if (!this.sawText) {
      throw new ParseError(
        this.totalChars === 0
          ? 'The file is empty.'
          : this.zeroBytes
            ? 'The file contains only zero bytes: it was probably damaged when X-Plane or the computer stopped while ' +
              'writing it.'
            : 'The file contains only blank lines.',
      )
    }
    if (this.phase === 'preamble') throw new ParseError(MESSAGE_NO_HEADER)
    if (this.rowCount === 0) throw new ParseError(this.noRowsMessage())

    const rowCount = this.rowCount
    // slice() gives each column its own exactly-sized buffer (transferable from the worker without extra bytes).
    const columns = this.columns.map((column) => (column.length === rowCount ? column : column.slice(0, rowCount)))
    this.columns = []

    const warnings = [...this.notes]
    if (this.incompleteLastLine) warnings.push('The last line was incomplete and was skipped.')
    if (this.repeatedHeaders > 0) {
      const n = this.repeatedHeaders
      warnings.push(
        `The column header appears ${n} more time${n === 1 ? '' : 's'} further down the file (the output was ` +
          `restarted?); ${n === 1 ? 'that line was' : 'those lines were'} skipped.`,
      )
    }
    if (this.headerless) {
      warnings.push(
        this.ncols === 1
          ? 'The first row contains only numbers, so it was read as data and the column was named "Column 1".'
          : `The first row contains only numbers, so it was read as data and the columns were named "Column 1" to ` +
              `"Column ${this.ncols}".`,
      )
    }
    const empty = this.headers.filter((_, c) => !columns[c].some((v) => !Number.isNaN(v)))
    if (empty.length > 0) {
      const names = empty.slice(0, 5).map((name) => `"${name}"`).join(', ') + (empty.length > 5 ? ', …' : '')
      warnings.push(
        empty.length === 1
          ? `Column ${names} has no numeric values (text such as dates cannot be plotted); it is kept as an empty channel.`
          : `${empty.length} columns have no numeric values (text such as dates cannot be plotted) and are kept as ` +
              `empty channels: ${names}.`,
      )
    }
    return {
      format: this.format,
      headers: this.headers,
      columns,
      rowCount,
      skippedRows: this.skippedRows,
      warnings,
    }
  }

  private noRowsMessage(): string {
    const skipped = this.skippedRows
    if (skipped === 0) return 'The file has a column header but no complete data rows.'
    const rows = `${skipped} row${skipped === 1 ? '' : 's'}`
    if (this.format === 'xplane') {
      return (
        `None of the ${rows} below the header could be read: each should have ${this.ncols} values separated by ` +
        `"|", like the header, but the first one has ${this.firstBadCells}. The file may be damaged.`
      )
    }
    const name = this.delimiter === TAB ? 'tabs' : this.delimiter === SEMICOLON ? '";"' : '","'
    return (
      `None of the ${rows} below the header could be read: each should have ${this.ncols} values separated by ` +
      `${name}, at least one of them a number. X-Plane Plotter reads X-Plane Data.txt files and CSV/TSV tables of numbers.`
    )
  }
}
