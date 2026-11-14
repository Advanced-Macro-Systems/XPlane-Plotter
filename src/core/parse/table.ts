// The parser's output type and its user-facing error. They live in their own module (re-exported by ./index) so the
// worker bundle (parser.worker.ts -> streaming.ts) never imports index.ts, which constructs the worker itself.

import type { ChannelStats, DatasetFormat } from '../types'

/** The parsed table, before any interpretation (no channel meanings, no time handling). */
export interface RawTable {
  format: DatasetFormat
  /** Header cells, trimmed, in file order. Duplicates are kept as they are (e.g. "elev1,__deg" twice). */
  headers: string[]
  /** One Float64Array per header, each exactly `rowCount` long. Unparseable / missing cells are NaN. */
  columns: Float64Array[]
  rowCount: number
  /** Data rows dropped (wrong field count, unparseable). Blank lines are not counted. */
  skippedRows: number
  /** Human-readable notes, e.g. "Last line was incomplete and was skipped." */
  warnings: string[]
  /**
   * computeStats of each column, when the parser worker already worked them out (off the main thread: on a big log
   * that pass over every value would freeze the page); buildDataset computes any that are missing.
   */
  stats?: ChannelStats[]
}

/** A file that cannot be read as a table at all (empty, binary, no header, no numeric rows). Message is user-facing. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}
