/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// BASE_PATH is set by the GitHub Pages workflow (e.g. /XPlane-Plotter/). Locally the app is served from /.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // Separate dependency caches let several dev servers run side by side (scripts/smoke.mjs sets this per port).
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
  plugins: [react()],
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
