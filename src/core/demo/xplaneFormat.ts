// Writes a table in X-Plane 12's Data.txt layout, byte for byte:
//   - a blank first line,
//   - a header line of tokens, each right-aligned in 13 characters and followed by " | ",
//   - one line per row, every value printed like C's printf("%13.5f") followed by " | ",
//   - CRLF line ends (X-Plane on Windows), including after the last row.
// X-Plane's datarefs are 32-bit floats, so values are rounded to float32 first (large values then show float
// granularity, e.g. "987329.00000", as in real logs).
//
// The text is assembled in a byte buffer and decoded once: building ~600 000 cells as separate strings made string
// garbage the main cost of generating the demo.

const CELL_WIDTH = 13
const SEPARATOR = ' | '
const EOL = '\r\n'
/** Bytes per cell when the value fits the field: 13 characters + " | " */
const CELL_BYTES = CELL_WIDTH + SEPARATOR.length

const SPACE = 0x20
const BAR = 0x7c
const DOT = 0x2e
const MINUS = 0x2d
const ZERO = 0x30
const CR = 0x0d
const LF = 0x0a

/** Below this magnitude |value|·1e5 is an exact integer in double precision, so the digits can be computed exactly. */
const EXACT_LIMIT = 1e9

/**
 * Writes the characters of `value` as printf("%.5f") prints its float32 rounding, ending just before `end`, and returns
 * how many were written. Matches Number.prototype.toFixed(5): rounding half away from zero (a float32 times 1e5 is
 * exact in a double and never lands on a tie), "-0.00000" for tiny negatives, "0.00000" for −0.
 */
function writeDigits(value: number, out: Uint8Array, end: number): number {
  const f = Number.isFinite(value) ? Math.fround(value) : 0
  const magnitude = Math.abs(f)
  if (magnitude >= EXACT_LIMIT) {
    const text = f.toFixed(5)
    for (let k = 0; k < text.length; k += 1) out[end - text.length + k] = text.charCodeAt(k)
    return text.length
  }
  const scaled = Math.round(magnitude * 100_000)
  // both parts fit in 32-bit integers, which keeps the digit loops on fast integer arithmetic
  let whole = Math.floor(scaled / 100_000) | 0
  let fraction = (scaled - whole * 100_000) | 0
  let n = 0
  for (let k = 0; k < 5; k += 1) {
    out[end - ++n] = ZERO + (fraction % 10)
    fraction = (fraction / 10) | 0
  }
  out[end - ++n] = DOT
  do {
    out[end - ++n] = ZERO + (whole % 10)
    whole = (whole / 10) | 0
  } while (whole > 0)
  if (f < 0) out[end - ++n] = MINUS
  return n
}

const scratch = new Uint8Array(64)

/** One value as X-Plane prints it: right-aligned in 13 characters (wider values overflow the field, as in printf). */
export function formatCell(value: number): string {
  const n = writeDigits(value, scratch, scratch.length)
  const text = String.fromCharCode(...scratch.subarray(scratch.length - n))
  return text.length < CELL_WIDTH ? text.padStart(CELL_WIDTH) : text
}

/** The whole log: blank line, header, then `rowCount` rows taken from `columns` (one array per token). */
export function formatXPlaneLog(tokens: readonly string[], columns: readonly Float64Array[], rowCount: number): string {
  let header = EOL
  for (const token of tokens) header += token.padStart(CELL_WIDTH) + SEPARATOR
  header += EOL

  const rowBytes = columns.length * CELL_BYTES + EOL.length
  let buffer = new Uint8Array(header.length + rowCount * rowBytes + 256)
  let pos = 0
  for (let k = 0; k < header.length; k += 1) buffer[pos++] = header.charCodeAt(k)

  for (let row = 0; row < rowCount; row += 1) {
    // a value too wide for its field makes the row longer: grow the buffer if this row might not fit
    if (pos + rowBytes + 64 * columns.length > buffer.length) {
      const larger = new Uint8Array(Math.max(buffer.length * 2, pos + 2 * rowBytes + 64 * columns.length))
      larger.set(buffer.subarray(0, pos))
      buffer = larger
    }
    for (const column of columns) {
      const n = writeDigits(column[row], scratch, scratch.length)
      for (let k = n; k < CELL_WIDTH; k += 1) buffer[pos++] = SPACE
      for (let k = scratch.length - n; k < scratch.length; k += 1) buffer[pos++] = scratch[k]
      buffer[pos++] = SPACE
      buffer[pos++] = BAR
      buffer[pos++] = SPACE
    }
    buffer[pos++] = CR
    buffer[pos++] = LF
  }
  return new TextDecoder().decode(buffer.subarray(0, pos))
}
