// Messages between parseFile() (main thread) and parser.worker.ts.

import type { RawTable } from './table'

/** Main thread -> worker: the file to parse. */
export interface ParseRequest {
  file: Blob
}

/**
 * Worker -> main thread. 'progress' arrives at most every ~80 ms (fraction of bytes read, 0..1); then exactly one
 * 'done' (the column buffers are transferred, not copied) or 'error'.
 */
export type ParseResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; table: RawTable }
  | {
      type: 'error'
      message: string
      /** true for a ParseError (user-facing message) */
      isParseError: boolean
      /** Error name, e.g. "RangeError" when the browser ran out of memory */
      name: string
    }
