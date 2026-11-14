// Module Web Worker that parses a dropped file off the main thread (see parseFile() in ./index.ts and ./protocol.ts).
// It imports only the streaming parser and the column statistics, never ./index.ts (which constructs this worker).

import { computeStats } from '../channelStats'
import { parseBlob } from './blob'
import type { ParseRequest, ParseResponse } from './protocol'
import { ParseError } from './table'

/** The parts of DedicatedWorkerGlobalScope used here (the app's TS lib is DOM, not WebWorker). */
interface ParserWorkerScope {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null
  postMessage(message: ParseResponse, options?: StructuredSerializeOptions): void
}

const scope = self as unknown as ParserWorkerScope

function post(message: ParseResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, { transfer })
}

async function parse(file: Blob): Promise<void> {
  try {
    const table = await parseBlob(file, { onProgress: (fraction) => post({ type: 'progress', fraction }) })
    // The column statistics read every value once: here, rather than on the main thread while the page waits.
    table.stats = table.columns.map(computeStats)
    // Every column owns an exactly-sized ArrayBuffer, so they can all be transferred (zero-copy).
    post({ type: 'done', table }, table.columns.map((column) => column.buffer as ArrayBuffer))
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      isParseError: error instanceof ParseError,
      name: error instanceof Error ? error.name : 'Error',
    })
  }
}

scope.onmessage = (event) => {
  void parse(event.data.file)
}
