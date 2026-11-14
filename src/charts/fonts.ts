// Waits for the chart fonts before anything is drawn.
// OWNER: charts agent.
//
// Why: chart text is measured on a canvas, and zrender caches every string's width per font string for the page's
// lifetime (a module-private LRU with no reset). Text measured while Geist is still loading keeps the fallback face's
// widths, so labels overlap or clip even after chart.resize(). Charts therefore render for the first time only once
// the fonts are in.

import { readChartTheme } from './theme'

let ready: Promise<void> | null = null

/**
 * Resolves once the chart fonts (sans and mono, screen and paper sizes) are loaded — immediately when they already
 * are, or outside a browser — and after `timeoutMs` at the latest, so a font that never arrives cannot hide the charts.
 * The first call decides; later calls share its promise.
 */
export function chartFontsReady(timeoutMs = 3000): Promise<void> {
  if (ready) return ready
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts || typeof fonts.load !== 'function') {
    ready = Promise.resolve()
    return ready
  }
  const specs = new Set<string>()
  for (const theme of [readChartTheme('light'), readChartTheme('paper')]) {
    specs.add(`${theme.fontSize}px ${theme.font}`)
    specs.add(`${theme.fontSize}px ${theme.mono}`)
  }
  // A face that fails to load (or a spec the browser rejects) just leaves the fallback in place.
  const load = (spec: string): Promise<unknown> => {
    try {
      return fonts.load(spec).catch(() => undefined)
    } catch {
      return Promise.resolve()
    }
  }
  const loaded = Promise.all([...specs].map(load)).then(() => undefined)
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ready = Promise.race([loaded, timeout])
  return ready
}
