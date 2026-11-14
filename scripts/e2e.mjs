/* global document, window, StorageEvent -- used inside page.evaluate / waitForFunction callbacks, which run in the browser */
// End-to-end check of the BUILT app in a real browser (local Chrome or Edge via playwright-core; nothing downloaded).
//
//   npm run build && npm run e2e -- [--file path/to/Data.txt] [--out test-results] [--headed] [--base-path /XPlane-Plotter/]
//                                   [--port 4317] [--dist dist]
//
// It serves dist/ (or --dist, a build made with `vite build --outDir`, so several checks can run side by side) with
// `vite preview`, opens the landing page, loads the demo flight and (optionally) a real log through
// the real file input, visits every tab in light and dark, drags a selection and saves a test point, picks the X–Y
// range-and-endurance preset on the demo, runs Find steady points (on the real log it adds what it finds) and Add
// points from times, and screenshots each step into --out. It fails (exit 1) on any console error, page error or
// failed step.

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const OUT = resolve(arg('out', 'test-results'))
const FILE = arg('file', process.env.XPP_REAL_FILE ?? '')
const PORT = Number(arg('port', '4317'))
const BASE_PATH = arg('base-path', '/')
const DIST = arg('dist', '')
const BASE = `http://localhost:${PORT}${BASE_PATH}`
const TABS = ['overview', 'time', 'xy', 'points', 'modes', 'channels']

mkdirSync(OUT, { recursive: true })

const problems = []
const timings = {}
const log = (...m) => console.log('[e2e]', ...m)

function startServer() {
  const where = DIST ? ['--outDir', DIST] : []
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--base', BASE_PATH, ...where],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  server.stderr.on('data', (d) => process.stderr.write(d))
  return server
}

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await sleep(150)
  }
  throw new Error(`Preview server did not start on ${BASE}`)
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: !flag('headed') })
    } catch (error) {
      log(`could not launch ${channel}: ${error.message.split('\n')[0]}`)
    }
  }
  throw new Error('No local Chrome or Edge found for playwright-core')
}

async function step(name, fn) {
  const t0 = performance.now()
  try {
    await fn()
    timings[name] = Math.round(performance.now() - t0)
    log(`ok   ${name} (${timings[name]} ms)`)
  } catch (error) {
    problems.push(`${name}: ${error.message.split('\n')[0]}`)
    log(`FAIL ${name}: ${error.message.split('\n')[0]}`)
  }
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('xpp:theme', t)
    document.documentElement.dataset.theme = t
    window.dispatchEvent(new StorageEvent('storage', { key: 'xpp:theme', newValue: t }))
  }, theme)
  await sleep(400)
}

async function visitTabs(page, prefix) {
  for (const tab of TABS) {
    await step(`${prefix}: tab ${tab}`, async () => {
      await page.getByTestId(`tab-${tab}`).click()
      await page.getByTestId(`view-${tab}`).waitFor({ state: 'visible', timeout: 10_000 })
      await sleep(900) // charts render on the next frames
      await shot(page, `${prefix}-${tab}`)
    })
  }
}

async function dragSelection(page) {
  await page.getByTestId('tab-time').click()
  await page.getByTestId('view-time').waitFor()
  await page.getByTestId('time-mode-select').click()
  const area = page.getByTestId('time-plot-area').first()
  const box = await area.boundingBox()
  if (!box) throw new Error('time-plot-area has no box')
  const y = box.y + box.height * 0.5
  await page.mouse.move(box.x + box.width * 0.35, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.42, y, { steps: 8 })
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 })
  await page.mouse.up()
  await page.getByTestId('selection-bar').waitFor({ state: 'visible', timeout: 5000 })
}

/** Saves a dragged selection as a test point and checks that the Points table gained exactly one row. */
async function saveSelectionAsPoint(page, shotName) {
  await page.getByTestId('tab-points').click()
  await page.getByTestId('view-points').waitFor()
  const before = await page.getByTestId('points-row').count()
  await dragSelection(page)
  if (shotName) await shot(page, `${shotName}-selection`)
  await page.getByTestId('save-point-button').click()
  await page.getByTestId('save-point-confirm').click()
  await page.getByTestId('tab-points').click()
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="points-row"]').length === n,
    before + 1,
    { timeout: 5000, polling: 100 },
  )
  if (shotName) await shot(page, `${shotName}-points`)
}

/**
 * X–Y range and endurance on the demo: the jet preset (it makes the Total thrust formula), the constructions' summary
 * under the plot and the results table with both speeds.
 */
async function rangeEndurance(page, shotName) {
  await page.getByTestId('tab-xy').click()
  await page.getByTestId('view-xy').waitFor()
  await page.getByRole('button', { name: 'Plot preset' }).click()
  await page.getByRole('menuitem', { name: /^Range & endurance — jet/ }).click()
  await page.getByTestId('xy-re-summary').waitFor({ state: 'visible', timeout: 5000 })
  const table = page.getByTestId('xy-re-table')
  await table.waitFor({ state: 'visible', timeout: 5000 })
  const text = await table.innerText()
  if ((text.match(/\d+(\.\d+)? kt/g) ?? []).length < 2) throw new Error(`no V_E and V_R in the table: ${text.slice(0, 200)}`)
  await sleep(600)
  await shot(page, shotName)
}

/** The number of test-point rows, once it equals `n`. */
async function pointRows(page, n) {
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="points-row"]').length === count, n, {
    timeout: 5000,
    polling: 100,
  })
}

/**
 * Find steady points from the Test points toolbar. With `add`, adds every new stretch it found and checks the table
 * gained them; returns how many were added. On the demo every trim point is found and already saved, so nothing is
 * added.
 */
async function findSteadyPoints(page, shotName, { add, atLeast = 1 }) {
  await page.getByTestId('tab-points').click()
  await page.getByTestId('view-points').waitFor()
  const before = await page.getByTestId('points-row').count()
  await page.getByTestId('find-steady-button').click()
  await page.getByTestId('steady-dialog').waitFor({ timeout: 10_000 })
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="steady-row"]').length >= n,
    atLeast,
    { timeout: 10_000, polling: 100 },
  )
  await sleep(300)
  await shot(page, shotName)
  const button = page.getByTestId('steady-add')
  if (!add || (await button.isDisabled())) {
    await page.keyboard.press('Escape')
    await page.getByTestId('steady-dialog').waitFor({ state: 'detached', timeout: 5000 })
    return 0
  }
  const count = Number(((await button.innerText()).match(/\d+/) ?? ['0'])[0])
  await button.click()
  await pointRows(page, before + count)
  return count
}

/** Add points from times: pastes `text`, expects the clock check to confirm a time axis, adds the windows. */
async function addPointsFromTimes(page, text, expected, shotName) {
  await page.getByTestId('tab-points').click()
  await page.getByTestId('view-points').waitFor()
  const before = await page.getByTestId('points-row').count()
  await page.getByTestId('add-times-button').click()
  await page.getByTestId('times-dialog').waitFor({ timeout: 10_000 })
  await page.getByTestId('times-input').fill(text)
  await page.getByTestId('times-verdict').waitFor({ state: 'visible', timeout: 5000 })
  const verdict = await page.getByTestId('times-verdict').innerText()
  if (!/^These times match /.test(verdict)) throw new Error(`no time axis confirmed: ${verdict}`)
  const rows = await page.getByTestId('times-row').count()
  if (rows !== expected) throw new Error(`${rows} windows read, expected ${expected}`)
  await shot(page, shotName)
  await page.getByTestId('times-add').click()
  await pointRows(page, before + expected)
}

const server = startServer()
let browser
try {
  await waitForServer()
  browser = await launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await step('landing (light)', async () => {
    await page.goto(BASE)
    await setTheme(page, 'light')
    await page.getByTestId('landing').waitFor({ timeout: 10_000 })
    await shot(page, 'landing-light')
  })
  await step('landing (dark)', async () => {
    await setTheme(page, 'dark')
    await shot(page, 'landing-dark')
    await setTheme(page, 'light')
  })

  await step('demo loads', async () => {
    await page.getByTestId('demo-button').click()
    await page.getByTestId('view-overview').waitFor({ timeout: 20_000 })
    await sleep(800)
    await shot(page, 'demo-overview')
  })
  await visitTabs(page, 'demo-light')

  await step('select + save test point (demo)', async () => {
    await saveSelectionAsPoint(page, 'demo')
  })

  await step('X–Y range and endurance (demo)', async () => {
    await rangeEndurance(page, 'demo-xy-range-endurance')
  })

  await step('find steady points (demo: finds the five trim points, all saved)', async () => {
    await findSteadyPoints(page, 'demo-find-steady', { add: false, atLeast: 5 })
  })

  await step('add points from times (demo)', async () => {
    // A synthetic table: the level start before the first trim point, and a line without a time.
    await addPointsFromTimes(page, 'Time (s) | IAS\n1-7 | 330\n(not flown) | 200', 1, 'demo-add-times')
  })

  await setTheme(page, 'dark')
  await visitTabs(page, 'demo-dark')
  await setTheme(page, 'light')

  if (FILE) {
    await step('real file loads', async () => {
      const t0 = performance.now()
      await page.getByTestId('file-input').setInputFiles(FILE)
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="loading-overlay"]'),
        undefined,
        { timeout: 120_000, polling: 100 },
      )
      timings['real file parse+build (ms)'] = Math.round(performance.now() - t0)
      await page.getByTestId('tab-overview').click()
      await sleep(1000)
      await shot(page, 'real-overview')
    })
    await visitTabs(page, 'real-light')
    await step('select + save test point (real)', async () => {
      await saveSelectionAsPoint(page, 'real')
    })
    await step('find steady points (real)', async () => {
      timings['real steady points added'] = await findSteadyPoints(page, 'real-find-steady', { add: true, atLeast: 0 })
      await shot(page, 'real-steady-points')
    })
    await setTheme(page, 'dark')
    await visitTabs(page, 'real-dark')
  }

  await step('narrow viewport (tablet)', async () => {
    await page.setViewportSize({ width: 820, height: 1000 })
    await setTheme(page, 'light')
    await page.getByTestId('tab-time').click()
    await sleep(800)
    await shot(page, 'tablet-time')
  })
} catch (error) {
  problems.push(`fatal: ${error.message}`)
} finally {
  await browser?.close()
  server.kill()
}

console.log('\n[e2e] timings (ms):', JSON.stringify(timings, null, 1))
if (problems.length) {
  console.log(`\n[e2e] ${problems.length} problem(s):`)
  for (const p of [...new Set(problems)]) console.log('  -', p)
  process.exit(1)
}
console.log(`\n[e2e] all steps passed. Screenshots in ${OUT}`)
