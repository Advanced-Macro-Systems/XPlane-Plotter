// File parsing: X-Plane 12 Data.txt (pipe-separated) and generic CSV / TSV / semicolon-separated text.
// OWNER: parser agent. Public API below is a contract used by the store; keep these signatures.
//
// One implementation serves both entry points: createStreamingParser() (./streaming.ts, where the row acceptance rule
// is documented). parseText() pushes the whole text into it; parseFile() streams the file through it in a module
// worker (./parser.worker.ts), or on the main thread when no worker can be started.

import { abortError, parseBlob } from './blob'
import type { ParseRequest, ParseResponse } from './protocol'
import { createStreamingParser } from './streaming'
import { ParseError, type RawTable } from './table'

export { ParseError } from './table'
export type { RawTable } from './table'
export { createStreamingParser } from './streaming'
export type { StreamingParser, StreamingParserOptions } from './streaming'

/**
 * Parses a whole file's text synchronously. Detects the format (X-Plane pipe table, CSV, TSV, semicolon CSV).
 * Throws ParseError for unreadable input. Must share its implementation with the worker's streaming parser.
 */
export function parseText(text: string): RawTable {
  const parser = createStreamingParser({ sizeHint: text.length })
  parser.push(text)
  return parser.finish()
}

/**
 * Parses a File/Blob off the main thread (module Web Worker), streaming it in chunks and reporting progress 0..1.
 * Falls back to parsing on the main thread when a Worker cannot be created. Rejects with ParseError (or an
 * AbortError DOMException when `signal` aborts). Column buffers are transferred, not copied.
 */
export function parseFile(file: Blob, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<RawTable> {
  if (signal?.aborted) return Promise.reject(abortError())
  const worker = startWorker()
  if (!worker) return parseOnMainThread(file, onProgress, signal)

  return new Promise<RawTable>((resolve, reject) => {
    let started = false
    let settled = false
    const settle = () => {
      settled = true
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (settled) return
      settle()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      started = true
      if (settled) return
      const message = event.data
      if (message.type === 'progress') {
        onProgress?.(Math.min(1, Math.max(0, message.fraction)))
      } else if (message.type === 'done') {
        settle()
        onProgress?.(1)
        resolve(message.table)
      } else {
        settle()
        reject(
          message.isParseError
            ? new ParseError(message.message)
            : message.name === 'RangeError'
              ? new RangeError(message.message)
              : new Error(message.message),
        )
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      if (settled) return
      event.preventDefault()
      settle()
      // The worker script never ran (blocked or failed to load): parse here instead.
      if (!started) parseOnMainThread(file, onProgress, signal).then(resolve, reject)
      else reject(new Error(event.message || 'The file reader stopped unexpectedly.'))
    }
    worker.onmessageerror = () => {
      if (settled) return
      settle()
      reject(new Error('The parsed table could not be received from the background reader.'))
    }
    worker.postMessage({ file } satisfies ParseRequest)
  })
}

function startWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

async function parseOnMainThread(
  file: Blob,
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<RawTable> {
  const table = await parseBlob(file, { onProgress, signal })
  onProgress?.(1)
  return table
}
