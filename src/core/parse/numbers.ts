// Number parsing for log cells.
//
// X-Plane writes every value as "[-]digits.ddddd" and a long log holds millions of them, so the hot path is a
// hand-written char-code parser for [sign]digits[.digits][(e|E)[sign]digits]. It is exact, not approximate: when the
// decimal mantissa has at most 15 digits (< 2^53) and the power of ten is within ±22 (10^22 is the largest exact
// double power of ten), one IEEE division or multiplication of two exactly representable values is correctly rounded
// (Clinger's fast path) — the same double Number() returns. Anything else (longer mantissas, "nan", "1.#INF",
// hex, text) goes through parseCell(), which uses Number() on the trimmed cell text.

const ZERO = 48
const NINE = 57
const PLUS = 43
const MINUS = 45
const DOT = 46
const COMMA = 44
const LOWER_E = 101
const UPPER_E = 69

const POW10 = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20,
  1e21, 1e22,
]

/** Longest mantissa (in digits) the fast path handles exactly: 10^15 - 1 < 2^53. */
const MAX_FAST_DIGITS = 15

/** What a cell holds. Only CELL_NUMBER cells have a finite value; the others are stored as NaN. */
export const CELL_EMPTY = 0
export const CELL_NUMBER = 1
/** A spelled-out missing value: "nan", "-nan(ind)", "inf", "1.#INF", "Infinity", or a number too large for a double */
export const CELL_MISSING = 2
export const CELL_TEXT = 3
export type CellKind = typeof CELL_EMPTY | typeof CELL_NUMBER | typeof CELL_MISSING | typeof CELL_TEXT

export interface CellResult {
  value: number
  kind: CellKind
}

/** NaN / infinity spellings of C runtimes (glibc, MSVC) and JavaScript. */
const MISSING_SPELLING = /^[+-]?(?:nan|inf(?:inity)?|1\.#(?:inf|ind|qnan|snan)0*)(?:\([\w ]*\))?$/i

/**
 * The fast path. Reuse one instance: `scan()` returns the value and leaves the index just after the number in `end`.
 */
export class NumberScanner {
  /** Index just after the characters consumed by the last scan() that returned a number */
  end = 0

  /**
   * Parses [sign]digits[.digits][(e|E)[sign]digits] starting exactly at s[start] and not reading at or beyond `limit`.
   * With `decimalComma`, "," is accepted as the decimal point too. Returns NaN when the text there is not such a
   * number or is outside the exact fast path (more than 15 significant digits, huge exponents): the caller then
   * falls back to parseCell(). Never returns ±Infinity.
   */
  scan(s: string, start: number, limit: number, decimalComma: boolean): number {
    let i = start
    let c = i < limit ? s.charCodeAt(i) : -1
    let negative = false
    if (c === MINUS || c === PLUS) {
      negative = c === MINUS
      i += 1
      c = i < limit ? s.charCodeAt(i) : -1
    }
    let mantissa = 0
    let digits = 0
    let fraction = 0
    while (c >= ZERO && c <= NINE) {
      mantissa = mantissa * 10 + (c - ZERO)
      digits += 1
      i += 1
      c = i < limit ? s.charCodeAt(i) : -1
    }
    if (c === DOT || (c === COMMA && decimalComma)) {
      i += 1
      c = i < limit ? s.charCodeAt(i) : -1
      while (c >= ZERO && c <= NINE) {
        mantissa = mantissa * 10 + (c - ZERO)
        digits += 1
        fraction += 1
        i += 1
        c = i < limit ? s.charCodeAt(i) : -1
      }
    }
    if (digits === 0 || digits > MAX_FAST_DIGITS) return NaN
    let exponent = 0
    if (c === LOWER_E || c === UPPER_E) {
      let j = i + 1
      let e = j < limit ? s.charCodeAt(j) : -1
      let exponentNegative = false
      if (e === MINUS || e === PLUS) {
        exponentNegative = e === MINUS
        j += 1
        e = j < limit ? s.charCodeAt(j) : -1
      }
      let exponentDigits = 0
      while (e >= ZERO && e <= NINE) {
        // Cap the accumulator: anything this large is outside the fast path anyway.
        if (exponent < 100_000) exponent = exponent * 10 + (e - ZERO)
        exponentDigits += 1
        j += 1
        e = j < limit ? s.charCodeAt(j) : -1
      }
      if (exponentDigits === 0) return NaN
      if (exponentNegative) exponent = -exponent
      i = j
    }
    const power = exponent - fraction
    let value: number
    if (power === 0) value = mantissa
    else if (power < 0) {
      if (power < -22) return NaN
      value = mantissa / POW10[-power]
    } else {
      if (power > 22) return NaN
      value = mantissa * POW10[power]
    }
    this.end = i
    return negative ? -value : value
  }
}

/**
 * The general path for one cell's text (already trimmed). Writes the value (NaN unless it is a finite number) and the
 * cell kind into `out`. With `decimalComma`, a "," decimal separator is accepted ("1,25" -> 1.25).
 */
export function parseCell(text: string, decimalComma: boolean, out: CellResult): void {
  if (text === '') {
    out.value = NaN
    out.kind = CELL_EMPTY
    return
  }
  const raw = Number(decimalComma ? text.replace(',', '.') : text)
  if (Number.isFinite(raw)) {
    out.value = raw
    out.kind = CELL_NUMBER
    return
  }
  out.value = NaN
  // ±Infinity ("Infinity", "1e999") is stored as NaN like the other missing-value spellings.
  out.kind = raw === Infinity || raw === -Infinity || MISSING_SPELLING.test(text) ? CELL_MISSING : CELL_TEXT
}

const sharedScanner = new NumberScanner()
const sharedCell: CellResult = { value: NaN, kind: CELL_EMPTY }

/**
 * A cell's numeric value: NaN for empty cells, text and missing-value spellings (Infinity is stored as NaN).
 * Convenience wrapper around the same two paths the parser uses.
 */
export function parseNumber(text: string, decimalComma = false): number {
  const trimmed = text.trim()
  const fast = sharedScanner.scan(trimmed, 0, trimmed.length, decimalComma)
  if (!Number.isNaN(fast) && sharedScanner.end === trimmed.length) return fast
  parseCell(trimmed, decimalComma, sharedCell)
  return sharedCell.value
}
