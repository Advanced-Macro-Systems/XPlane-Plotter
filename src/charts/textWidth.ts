// The width of text as the browser draws it, for layouts that place labels before ECharts draws them (the names of the
// test points in the time-history figure). A 2D canvas's measureText, as zrender measures chart text. Browser only.
// OWNER: charts agent.

let context: CanvasRenderingContext2D | null | undefined

/**
 * Width (px) of `text` drawn in `font` (a CSS font, e.g. "11px 'Geist Variable', sans-serif"), or NaN where nothing
 * can measure it (outside a browser, or a canvas the browser refuses): callers then estimate. Measure once the chart
 * fonts are in (charts/fonts.ts chartFontsReady), else the fallback face's widths come back.
 */
export function canvasTextWidth(text: string, font: string): number {
  if (context === undefined) {
    try {
      context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    } catch {
      context = null
    }
  }
  if (!context) return Number.NaN
  context.font = font
  return context.measureText(text).width
}
