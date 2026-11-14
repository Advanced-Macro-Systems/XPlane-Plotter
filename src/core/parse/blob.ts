// Streams a File/Blob through the streaming parser: blob.stream() + a streaming UTF-8 TextDecoder, so a large log is
// never held in memory as one string. Used by the parser worker and by parseFile()'s main-thread fallback.

import { createStreamingParser } from './streaming'
import type { RawTable } from './table'

export interface BlobParseOptions {
  /** Fraction of bytes read (0..1): 0 first, then at most every `progressIntervalMs` while reading */
  onProgress?: (fraction: number) => void
  /** Rejects with an AbortError DOMException as soon as it is noticed (between chunks) */
  signal?: AbortSignal
  progressIntervalMs?: number
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export async function parseBlob(blob: Blob, options: BlobParseOptions = {}): Promise<RawTable> {
  const { onProgress, signal, progressIntervalMs = 80 } = options
  const checkAborted = () => {
    if (signal?.aborted) throw abortError()
  }
  checkAborted()
  const parser = createStreamingParser({ sizeHint: blob.size })
  onProgress?.(0)

  if (typeof blob.stream !== 'function') {
    // Engines without Blob streams: read the whole text at once.
    const text = await blob.text()
    checkAborted()
    parser.push(text)
    return parser.finish()
  }

  const reader = blob.stream().getReader()
  const decoder = new TextDecoder('utf-8')
  let loaded = 0
  let lastReport = performance.now()
  let drained = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      checkAborted()
      if (done) {
        drained = true
        break
      }
      loaded += value.byteLength
      parser.push(decoder.decode(value, { stream: true }))
      // The header changed mid-file: the rest of the file would be ignored anyway.
      if (parser.stopped) break
      if (onProgress) {
        const now = performance.now()
        if (now - lastReport >= progressIntervalMs) {
          lastReport = now
          onProgress(blob.size > 0 ? Math.min(1, loaded / blob.size) : 1)
        }
      }
    }
  } finally {
    if (!drained) await reader.cancel().catch(() => undefined)
  }
  // Flush a multi-byte character split across the last chunk boundary (or U+FFFD for a truncated one).
  parser.push(decoder.decode())
  return parser.finish()
}
