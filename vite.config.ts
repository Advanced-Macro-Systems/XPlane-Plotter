/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The built page's Content-Security-Policy (a <meta> at the top of <head>): code, styles, fonts, images and the parser
 * worker come only from the app's own origin, and nothing may be sent anywhere else (connect-src 'self'), so the
 * browser itself enforces "your file is never uploaded", even against a compromised dependency. The inline theme
 * script of index.html is allowed by its hash, computed here from the final HTML so that editing it never breaks the
 * page. Styles may be inline (index.html's first-paint colours, React and ECharts style properties). Build only: the
 * dev server injects inline scripts of its own (HMR, React refresh).
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'xpp-content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        const hashes = inlineScripts.map(([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`)
        const policy = [
          "default-src 'self'",
          ["script-src 'self'", ...hashes].join(' '),
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "worker-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ')
        const meta = { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy } }
        return { html, tags: [{ ...meta, injectTo: 'head-prepend' as const }] }
      },
    },
  }
}

/** What Rolldown's `getModuleInfo` tells about a module (the parts used here). */
type ModuleInfoLookup = (id: string) => {
  isEntry: boolean
  importers: readonly string[]
  dynamicImporters: readonly string[]
  importedIds: readonly string[]
} | null

/**
 * The app's core: modules of src/ that the start page loads (the entry reaches them through static imports) and that a
 * tab's lazy chunk imports too — the store, file reading, the demo flight, formulas, sessions, the channel groups. They
 * go in one chunk named "app-core" (a shared chunk is otherwise named after one of its modules, e.g. "Dropdown"). Found
 * from the module graph, not a list of files, so a module that only the tabs use never lands on the start page. (The
 * start page's modules are worked out on the first call: one `vite build` makes one client bundle.)
 */
function appCoreTest(): (id: string, info: ModuleInfoLookup) => boolean {
  let initial: Set<string> | null = null
  return (id, info) => {
    if (!/[\\/]src[\\/]/.test(id)) return false
    if (!initial) {
      // The build's entries (walking up from any module reaches them), then everything they import statically.
      const entries: string[] = []
      const seen = new Set<string>()
      const up = [id]
      while (up.length) {
        const at = up.pop() as string
        if (seen.has(at)) continue
        seen.add(at)
        const module = info(at)
        if (!module) continue
        if (module.isEntry) entries.push(at)
        up.push(...module.importers, ...module.dynamicImporters)
      }
      initial = new Set<string>()
      const down = [...entries]
      while (down.length) {
        const at = down.pop() as string
        if (initial.has(at)) continue
        initial.add(at)
        down.push(...(info(at)?.importedIds ?? []))
      }
    }
    const module = info(id)
    if (!module || !initial.has(id) || module.isEntry) return false
    return [...module.importers, ...module.dynamicImporters].some((importer) => !initial?.has(importer))
  }
}

const isAppCore = appCoreTest()

// BASE_PATH is set by the GitHub Pages workflow (e.g. /XPlane-Plotter/). Locally the app is served from /.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // Separate dependency caches let several dev servers run side by side (scripts/smoke.mjs sets this per port).
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
  plugins: [react(), contentSecurityPolicy()],
  worker: {
    // The file parser runs in a module worker (src/core/parse/parser.worker.ts).
    format: 'es',
  },
  build: {
    // ECharts is the bulk of the bundle; it is split into its own chunk below.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Named chunks (Rolldown's code-splitting groups: unlike manualChunks they have priorities, so a group that
        // brings its modules' imports along never takes React or ECharts out of their own chunks).
        codeSplitting: {
          groups: [
            { name: 'echarts', test: /node_modules[\\/](echarts|zrender)[\\/]/, priority: 3 },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
            // The X-Plane channel dictionary and the tables built from it. Only the dataset builder (loaded on demand:
            // store/app.ts loadDatasetBuilder) and the tabs read it, so the start page never waits for it. A group
            // brings its modules' imports along: keep this to modules that import nothing the start page needs.
            {
              name: 'channel-dictionary',
              test: /[\\/]src[\\/]core[\\/]channels[\\/](dictionary|overrides|entries)\.ts$/,
              priority: 2,
            },
            { name: (id, ctx) => (isAppCore(id, (other) => ctx.getModuleInfo(other)) ? 'app-core' : null), priority: 1 },
          ],
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Parsing the real 60 MB sample (opt-in via XPP_REAL_FILE) can take a few seconds.
    testTimeout: 60_000,
  },
})
