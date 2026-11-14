/* global document -- used inside page.waitForFunction callbacks, which run in the browser */
// Quick visual check of ONE tab while developing it: starts the Vite dev server, opens the app with the demo flight
// (or a real log) on that tab, screenshots it, and prints console errors.
//
//   node scripts/smoke.mjs <tab> [--port 5301] [--theme light|dark] [--file path/to/Data.txt] [--width 1440] [--height 900]
//                                [--wait 1500] [--out test-results] [--full]
//
// The screenshot path is printed at the end (open it with an image viewer, or the Read tool).

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const tab = args[0] && !args[0].startsWith('--') ? args[0] : 'overview'
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const PORT = Number(arg('port', '5301'))
const THEME = arg('theme', 'light')
const FILE = arg('file', '')
const WIDTH = Number(arg('width', '1440'))
const HEIGHT = Number(arg('height', '900'))
const WAIT = Number(arg('wait', '1500'))
const OUT = resolve(arg('out', 'test-results'))
mkdirSync(OUT, { recursive: true })

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, VITE_CACHE_DIR: `node_modules/.vite-smoke-${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))

const errors = []
let browser
try {
  const base = `http://localhost:${PORT}/`
  for (let i = 0; ; i += 1) {
    try {
      if ((await fetch(base)).ok) break
    } catch {
      // not up yet
    }
    if (i > 150) throw new Error(`dev server did not start:\n${serverLog}`)
    await sleep(100)
  }
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true })
      break
    } catch {
      // try the next browser
    }
  }
  if (!browser) throw new Error('No local Chrome or Edge found')
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  if (FILE) {
    await page.goto(`${base}?theme=${THEME}`)
    await page.getByTestId('file-input').setInputFiles(FILE)
    await page.waitForFunction(() => !document.querySelector('[data-testid="loading-overlay"]') && document.querySelector('[data-testid^="view-"]'), undefined, { timeout: 120_000 })
    await page.getByTestId(`tab-${tab}`).click()
  } else {
    await page.goto(`${base}?demo&tab=${tab}&theme=${THEME}`)
  }
  await page.getByTestId(`view-${tab}`).waitFor({ timeout: 30_000 })
  await sleep(WAIT)
  const path = join(OUT, `smoke-${tab}-${THEME}${FILE ? '-file' : ''}.png`)
  await page.screenshot({ path, fullPage: args.includes('--full') })
  console.log(`[smoke] screenshot: ${path}`)
} catch (error) {
  errors.push(`fatal: ${error.message}`)
} finally {
  await browser?.close()
  server.kill()
}
if (errors.length) {
  console.log(`[smoke] ${errors.length} error(s):`)
  for (const e of [...new Set(errors)]) console.log('  -', e)
  process.exitCode = 1
} else {
  console.log('[smoke] no console errors')
}
