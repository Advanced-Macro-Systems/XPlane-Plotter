// Opt-in tests against real logs (never committed): set XPP_REAL_FILE to a Data.txt path, or to several paths
// separated by the OS path-list delimiter (";" on Windows, ":" elsewhere), e.g.
//   XPP_REAL_FILE="C:\logs\Data.txt" npx vitest run src/core/parse/realFile.test.ts
// Without it the suite is skipped.

import { describe, expect, it } from 'vitest'
import { buildDataset } from '../dataset'
import { timeBases } from '../time'
import { createStreamingParser, parseFile, parseText, type RawTable } from './index'

// The app's tsconfig has no Node types (src is browser code), so the few Node APIs used here are typed locally.
interface NodeProcess {
  env: Record<string, string | undefined>
  platform: string
}
interface NodeFs {
  readFileSync(path: string): Uint8Array<ArrayBuffer>
}

const nodeProcess = (globalThis as { process?: NodeProcess }).process
const files = (nodeProcess?.env.XPP_REAL_FILE ?? '')
  .split(nodeProcess?.platform === 'win32' ? ';' : ':')
  .map((path) => path.trim())
  .filter(Boolean)

async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const specifier: string = 'node:fs' // not a literal import: keeps TypeScript from looking for Node's types
  const fs = (await import(/* @vite-ignore */ specifier)) as NodeFs
  return fs.readFileSync(path)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function expectSameTable(actual: RawTable, expected: RawTable): void {
  expect(actual.format).toBe(expected.format)
  expect(actual.headers).toEqual(expected.headers)
  expect(actual.rowCount).toBe(expected.rowCount)
  expect(actual.skippedRows).toBe(expected.skippedRows)
  expect(actual.warnings).toEqual(expected.warnings)
  expect(actual.columns.length).toBe(expected.columns.length)
  for (let c = 0; c < expected.columns.length; c += 1) {
    const a = actual.columns[c]
    const b = expected.columns[c]
    let same = a.length === b.length
    for (let i = 0; same && i < b.length; i += 1) same = Object.is(a[i], b[i])
    expect(same, `column ${c} (${expected.headers[c]})`).toBe(true)
  }
}

describe.skipIf(files.length === 0)('real logs (XPP_REAL_FILE)', () => {
  for (const path of files) {
    it(`reads ${baseName(path)}`, async () => {
      const bytes = await readBytes(path)
      const text = new TextDecoder().decode(bytes)
      const started = performance.now()
      const raw = parseText(text)
      const parseMs = performance.now() - started

      expect(raw.rowCount).toBeGreaterThan(0)
      expect(raw.columns.length).toBe(raw.headers.length)
      for (const column of raw.columns) {
        expect(column.length).toBe(raw.rowCount)
        expect(column.buffer.byteLength).toBe(raw.rowCount * 8)
      }

      const buildStarted = performance.now()
      const ds = buildDataset(raw, { name: baseName(path), size: bytes.length })
      const buildMs = performance.now() - buildStarted
      expect(ds.elapsed.length).toBe(raw.rowCount)
      for (let i = 1; i < ds.elapsed.length; i += 1) {
        if (ds.elapsed[i] < ds.elapsed[i - 1]) throw new Error(`elapsed decreases at row ${i}`)
      }
      expect(ds.segments[0].start).toBe(0)
      expect(ds.segments[ds.segments.length - 1].end).toBe(raw.rowCount)

      // The same table when the text arrives in 64 KB chunks, and through the Blob streaming path (parseFile).
      const parser = createStreamingParser({ sizeHint: text.length })
      for (let i = 0; i < text.length; i += 65_536) parser.push(text.slice(i, i + 65_536))
      expectSameTable(parser.finish(), raw)
      const fileStarted = performance.now()
      expectSameTable(await parseFile(new Blob([bytes])), raw)
      const fileMs = performance.now() - fileStarted

      const constant = ds.channels.filter((ch) => ch.stats.constant).length
      console.info(
        [
          `${baseName(path)}: ${(bytes.length / 1e6).toFixed(1)} MB — parseText ${parseMs.toFixed(0)} ms, ` +
            `parseFile (Blob stream) ${fileMs.toFixed(0)} ms, buildDataset ${buildMs.toFixed(0)} ms`,
          `  ${raw.rowCount} rows x ${raw.headers.length} columns, ${raw.skippedRows} skipped, ${constant} constant`,
          `  time source ${ds.timeSourceId}, ${ds.sampleRateHz.toFixed(2)} Hz, ` +
            `${ds.elapsed[ds.elapsed.length - 1].toFixed(1)} s elapsed`,
          `  segments ${JSON.stringify(ds.segments)}`,
          `  repeated-token ids ${ds.channels.filter((ch) => ch.occurrence > 1).map((ch) => ch.id).join(', ') || '-'}`,
          `  time bases ${timeBases(ds).map((b) => `${b.label}${b.available ? '' : ` [${b.reason}]`}`).join('; ')}`,
          `  warnings ${JSON.stringify(ds.warnings)}`,
          `  signature ${ds.signature}`,
        ].join('\n'),
      )
    })
  }
})
