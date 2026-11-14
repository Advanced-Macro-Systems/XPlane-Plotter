// Publication exports: render an option offscreen (hidden container) at a chosen size and download PNG or SVG.
// Callers build the option with readChartTheme('paper') so exports are white-background regardless of the UI theme.
// OWNER: charts agent. Public API below is a contract; keep these signatures.

import { echarts, type ECharts, type EChartsOption } from './echarts'
import { chartFontsReady } from './fonts'

export interface ExportImageOptions {
  format: 'png' | 'svg'
  /** CSS pixels of the figure */
  width: number
  height: number
  /** PNG only: device pixel ratio (default 3 → e.g. 1800×1050 px for a 600×350 figure) */
  pixelRatio?: number
  /** Without extension */
  filename: string
  /** Default '#ffffff' */
  background?: string
}

const DEFAULT_PIXEL_RATIO = 3
const DEFAULT_BACKGROUND = '#ffffff'
/** Browsers refuse, or silently leave blank, canvases much beyond this many pixels per side. */
const MAX_CANVAS_SIDE = 16384

/**
 * Renders `option` offscreen (animation off), downloads the file, disposes the instance.
 * A dataZoom slider in the option is left out of the image (it is screen chrome); the zoom window still applies.
 */
export async function exportOptionImage(option: EChartsOption, opts: ExportImageOptions): Promise<void> {
  const { filename, ...render } = opts
  const url = await renderOptionToDataUrl(option, render)
  downloadBlob(imageFileName(filename, opts.format), dataUrlToBlob(url))
}

/**
 * Same rendering, returned as a data URL (for previews / tests) instead of downloading.
 * PNG: "data:image/png;base64,…" at width·pixelRatio × height·pixelRatio pixels (the ratio is lowered if the image would
 * exceed 16384 px a side). SVG: "data:image/svg+xml;charset=UTF-8,<percent-encoded SVG>".
 * Throws a RangeError for a non-positive or oversized width/height, and an Error outside a browser.
 */
export async function renderOptionToDataUrl(
  option: EChartsOption,
  opts: Omit<ExportImageOptions, 'filename'>,
): Promise<string> {
  if (typeof document === 'undefined') throw new Error('Chart images can only be rendered in a browser')
  const { format } = opts
  const width = figureSize(opts.width, 'width')
  const height = figureSize(opts.height, 'height')
  const pixelRatio = format === 'png' ? exportPixelRatio(opts.pixelRatio, width, height) : 1
  const background = opts.background ?? DEFAULT_BACKGROUND

  await chartFontsReady()
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  // Laid out at the figure size (ECharts measures it) but far off screen.
  container.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;overflow:hidden;pointer-events:none;`
  document.body.appendChild(container)
  let chart: ECharts | null = null
  try {
    chart = echarts.init(container, null, {
      renderer: format === 'svg' ? 'svg' : 'canvas',
      width,
      height,
      devicePixelRatio: pixelRatio,
    })
    // The SVG renderer paints the option's backgroundColor; getDataURL's backgroundColor covers the PNG.
    chart.setOption({ ...option, animation: false, backgroundColor: background })
    await nextFrame()
    const url = chart.getDataURL({
      type: format,
      pixelRatio,
      backgroundColor: background,
      excludeComponents: ['dataZoom'],
    })
    if (!url) throw new Error('The chart could not be rendered')
    return url
  } finally {
    chart?.dispose()
    container.remove()
  }
}

/**
 * Decodes a data: URL into a Blob of its media type: base64 payloads byte for byte, percent-encoded text (ECharts' SVG
 * URLs, "data:image/svg+xml;charset=UTF-8,%3Csvg…") back to the string, which Blob stores as UTF-8.
 */
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma < 0) throw new Error('Not a data URL')
  const [mime, ...params] = url.slice('data:'.length, comma).split(';')
  const type = mime.trim() || 'text/plain'
  const payload = url.slice(comma + 1)
  if (params.some((param) => param.trim().toLowerCase() === 'base64')) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type })
  }
  return new Blob([decodeURIComponent(payload)], { type })
}

/**
 * The download name for an image: `name` with the characters Windows and macOS forbid (and control characters)
 * replaced, trimmed, at most 120 characters, plus the extension; "chart" when nothing usable is left.
 */
export function imageFileName(name: string, format: 'png' | 'svg'): string {
  const cleaned = Array.from(String(name), (char) => (char.charCodeAt(0) < 32 || FORBIDDEN.includes(char) ? '_' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const stem = cleaned
    .replace(new RegExp(`\\.${format}$`, 'i'), '') // the caller already added the extension
    .replace(/^[.\s]+/, '') // no hidden files
    .slice(0, 120)
    .replace(/[.\s]+$/, '') // Windows drops trailing dots and spaces
  return `${stem || 'chart'}.${format}`
}

// ---------------------------------------------------------------------------------------------------------- helpers

const FORBIDDEN = '\\/:*?"<>|\u007f'

function figureSize(value: number, name: 'width' | 'height'): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_CANVAS_SIDE) {
    throw new RangeError(`The image ${name} must be between 1 and ${MAX_CANVAS_SIDE} pixels (got ${value})`)
  }
  return Math.round(value)
}

function exportPixelRatio(requested: number | undefined, width: number, height: number): number {
  const ratio = requested !== undefined && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_PIXEL_RATIO
  return Math.min(ratio, MAX_CANVAS_SIDE / Math.max(width, height))
}

/** One animation frame, or 50 ms when frames are paused (a background tab). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 50)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    }
  })
}

/** Saves a Blob through a temporary <a download> (core/export has its own helper; charts don't depend on it). */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Revoking straight after click() can cancel the download in some browsers: give it time to start.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}
