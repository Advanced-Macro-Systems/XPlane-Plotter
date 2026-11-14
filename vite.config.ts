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
        manualChunks(id) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) return 'echarts'
          if (id.includes('node_modules/react')) return 'react'
          // The X-Plane channel dictionary and the tables built from it, under a name that says so (a shared chunk
          // is otherwise named after one of its modules, e.g. "Dropdown").
          if (/[\\/]src[\\/]core[\\/]channels[\\/](dictionary|overrides|entries|groupRows)\.ts$/.test(id)) {
            return 'channel-dictionary'
          }
          return undefined
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
