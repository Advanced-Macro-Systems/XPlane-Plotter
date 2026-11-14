import { describe, expect, it } from 'vitest'

/**
 * The start page's static import graph, read from the sources: what the browser must load before the landing page can
 * paint. Node's fs and path come through the builtin-module loader (the app tsconfig has no Node types).
 */
type Fs = { readFileSync(path: string, encoding: 'utf8'): string; existsSync(path: string): boolean; statSync(path: string): { isFile(): boolean } }
type Path = { resolve(...parts: string[]): string; dirname(path: string): string; relative(from: string, to: string): string }

function node(): { fs: Fs; path: Path; src: string } {
  type NodeProcess = { getBuiltinModule?: (id: string) => unknown }
  const nodeProcess = (globalThis as unknown as { process?: NodeProcess }).process
  const fs = nodeProcess?.getBuiltinModule?.('node:fs') as Fs | undefined
  const path = nodeProcess?.getBuiltinModule?.('node:path') as Path | undefined
  const url = nodeProcess?.getBuiltinModule?.('node:url') as { fileURLToPath(url: URL): string } | undefined
  if (!fs || !path || !url) throw new Error('These tests need Node 20.16 or later (process.getBuiltinModule)')
  return { fs, path, src: path.dirname(url.fileURLToPath(new URL(import.meta.url))) }
}

/** Every module the entry reaches through static, non-type imports (dynamic import() excluded), relative to src/. */
function staticClosure(entry: string): Map<string, string | null> {
  const { fs, path, src } = node()
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = path.resolve(path.dirname(from), spec)
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return null
  }
  const importsOf = (file: string): string[] => {
    const text = fs.readFileSync(file, 'utf8')
    const specs: string[] = []
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
      if (m[1]) continue
      const names = m[2].trim()
      // import { type A, type B } from '...' is type-only too.
      if (/^\{[^}]*\}$/.test(names) && names.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((n) => n.startsWith('type'))) continue
      specs.push(m[3])
    }
    for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1])
    return specs.flatMap((spec) => resolveImport(file, spec) ?? []).filter((f) => /\.tsx?$/.test(f))
  }
  const start = path.resolve(src, entry)
  const parent = new Map<string, string | null>([[start, null]])
  const queue = [start]
  while (queue.length) {
    const file = queue.shift() as string
    for (const next of importsOf(file)) {
      if (parent.has(next)) continue
      parent.set(next, file)
      queue.push(next)
    }
  }
  const rel = (file: string) => path.relative(src, file).split('\\').join('/')
  return new Map([...parent].map(([file, from]) => [rel(file), from === null ? null : rel(from)]))
}

/** The import chain from the entry to `module` (for the failure message). */
function chain(graph: Map<string, string | null>, module: string): string {
  const steps: string[] = []
  for (let at: string | null | undefined = module; at; at = graph.get(at)) steps.unshift(at)
  return steps.join(' -> ')
}

describe('the start page', () => {
  const graph = staticClosure('main.tsx')

  it('never waits for the channel dictionary: only the dataset builder and the tabs read it, loaded on demand', () => {
    expect(graph.has('App.tsx')).toBe(true)
    expect(graph.has('store/app.ts')).toBe(true)
    for (const heavy of [
      'core/channels/dictionary.ts',
      'core/channels/entries.ts',
      'core/channels/overrides.ts',
      'core/channels/index.ts',
      'core/buildDataset.ts',
    ]) {
      expect(graph.has(heavy), graph.has(heavy) ? chain(graph, heavy) : heavy).toBe(false)
    }
  })

  it('does not load the charts or a tab before a file is open', () => {
    for (const module of graph.keys()) {
      expect(module.startsWith('views/') || module.startsWith('charts/options/') || module === 'charts/echarts.ts', chain(graph, module)).toBe(false)
    }
  })
})
