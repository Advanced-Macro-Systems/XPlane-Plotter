// Chart colours and type, read from the CSS tokens in styles/global.css so charts follow the light/dark theme, plus a
// fixed 'paper' theme (white background, dark ink, light-mode series colours) for publication exports.
// OWNER: charts agent. Public API below is a contract; keep these signatures.

import { useSyncExternalStore } from 'react'
import type { EChartsOption } from './echarts'
import { axisLabel, formatNumber } from './format'
import { useShownTheme } from '../lib/theme'

export type ChartMode = 'light' | 'dark' | 'paper'

export interface ChartTheme {
  mode: ChartMode
  surface: string
  text: string
  textMuted: string
  grid: string
  axis: string
  crosshair: string
  selection: string
  selectionBorder: string
  /** The 8 categorical slots, in fixed order (never cycled beyond 8 — callers cap series at 8) */
  series: string[]
  font: string
  mono: string
  /** Base font size in px for axis labels (paper exports use larger text) */
  fontSize: number
}

// Light-mode values of the tokens in styles/global.css (keep in step with it): what readChartTheme falls back to when a
// token can't be read (tests, no DOM). The paper theme reuses the series colours and fonts.
const FONT = "'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const MONO = "'Geist Mono Variable', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
const LIGHT_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const LIGHT = {
  surface: '#ffffff',
  text: '#172b4d',
  textMuted: '#626f86',
  grid: '#ebecf0',
  axis: '#b3b9c4',
  crosshair: '#44546f',
  selection: 'rgba(12, 102, 228, 0.12)',
  selectionBorder: 'rgba(12, 102, 228, 0.55)',
}
/** The app's popover shadow (--shadow, light). */
const LIGHT_SHADOW = '0 8px 16px -4px rgba(9, 30, 66, 0.2), 0 0 1px rgba(9, 30, 66, 0.3)'

/** The custom property behind each theme colour. */
const TOKENS = {
  surface: '--chart-surface',
  text: '--chart-text',
  textMuted: '--chart-text-muted',
  grid: '--chart-grid',
  axis: '--chart-axis',
  crosshair: '--chart-crosshair',
  selection: '--chart-selection',
  selectionBorder: '--chart-selection-border',
} satisfies Record<keyof typeof LIGHT, string>

/** Axis-label size on screen; paper exports are larger so text survives being scaled down into a report. */
const SCREEN_FONT_SIZE = 12
const PAPER_FONT_SIZE = 13

/** Reads the CSS custom properties of the current document for 'light'/'dark'; 'paper' is a fixed palette. */
export function readChartTheme(mode: ChartMode): ChartTheme {
  if (mode === 'paper') return paperTheme()
  // The tokens are whatever the page shows now (<html data-theme>): `mode` should be that theme.
  const style = rootStyle()
  const read = (name: string, fallback: string): string => style?.getPropertyValue(name).trim() || fallback
  return {
    mode,
    surface: read(TOKENS.surface, LIGHT.surface),
    text: read(TOKENS.text, LIGHT.text),
    textMuted: read(TOKENS.textMuted, LIGHT.textMuted),
    grid: read(TOKENS.grid, LIGHT.grid),
    axis: read(TOKENS.axis, LIGHT.axis),
    crosshair: read(TOKENS.crosshair, LIGHT.crosshair),
    selection: read(TOKENS.selection, LIGHT.selection),
    selectionBorder: read(TOKENS.selectionBorder, LIGHT.selectionBorder),
    series: LIGHT_SERIES.map((fallback, slot) => read(`--series-${slot + 1}`, fallback)),
    // zrender writes the font into a double-quoted SVG attribute without escaping it, so keep its quotes single.
    font: read('--font', FONT).replace(/"/g, "'"),
    mono: read('--mono', MONO).replace(/"/g, "'"),
    fontSize: SCREEN_FONT_SIZE,
  }
}

/** The theme for the theme showing now; re-renders when the user switches theme. */
export function useChartTheme(): ChartTheme {
  const shown = useShownTheme()
  // Also re-render when a token changes without a theme switch (see onThemeAttributeChange).
  useSyncExternalStore(subscribeTokens, readTokenVersion, readTokenVersion)
  return screenTheme(shown)
}

/** Colour of categorical slot `slot` (0-based, wraps at 8 only as a last resort). */
export function seriesColor(theme: ChartTheme, slot: number): string {
  const count = theme.series.length
  if (count === 0) return theme.text
  const index = Number.isFinite(slot) ? Math.trunc(slot) : 0
  return theme.series[((index % count) + count) % count]
}

/**
 * Shared option defaults: font family/size, text colours, tooltip look (surface-overlay background, shadow, no border),
 * axis line/label/split-line styling (solid hairline grid), animation off for large data.
 * View option builders merge their own options on top of this — with mergeOptions, not a spread, so nested styles
 * survive (`{ ...baseOption(theme), tooltip: { trigger: 'axis' } }` would drop the whole tooltip look).
 * Axes are styled per axis by valueAxis. ECharts components with their own text colours (legend, dataZoom slider,
 * title) are not created here: style them from the theme where they are added.
 */
export function baseOption(theme: ChartTheme): EChartsOption {
  const screen = theme.mode !== 'paper'
  const pointerLine = { color: theme.crosshair, width: 1, type: 'solid' as const }
  const pointerLabel = {
    backgroundColor: theme.crosshair,
    color: theme.surface,
    fontFamily: theme.font,
    fontSize: theme.fontSize - 1,
    padding: [3, 6],
    borderRadius: 4,
    formatter: (params: { value: unknown }) => plainValue(params.value),
  }
  return {
    // On screen the card behind the chart is the surface; an export paints its own.
    backgroundColor: screen ? 'transparent' : theme.surface,
    color: [...theme.series],
    // Animating tens of thousands of samples costs frames and helps nobody reading a flight log.
    animation: false,
    textStyle: { fontFamily: theme.font, fontSize: theme.fontSize, color: theme.text },
    // <EChart> hands its ariaLabel to the aria component as the description. Decal textures stay opt-in.
    aria: { enabled: true, decal: { show: false } },
    axisPointer: { lineStyle: pointerLine, label: pointerLabel },
    tooltip: {
      confine: true,
      // Track the crosshair without easing: a lagging tooltip shows the wrong sample.
      transitionDuration: 0,
      // The tooltip is HTML in the page, so on screen it can use the live overlay and shadow tokens.
      backgroundColor: screen ? `var(--surface-overlay, ${theme.surface})` : theme.surface,
      // Otherwise ECharts draws a border in the nearest series' colour.
      borderWidth: 0,
      borderRadius: 8,
      padding: [8, 10],
      extraCssText: `border-radius:8px;box-shadow:${screen ? `var(--shadow, ${LIGHT_SHADOW})` : LIGHT_SHADOW};`,
      className: 'chart-tooltip',
      textStyle: { color: theme.text, fontFamily: theme.font, fontSize: theme.fontSize, lineHeight: 18 },
      valueFormatter: (value: unknown) => plainValue(value),
      axisPointer: {
        type: 'line',
        snap: true,
        animation: false,
        lineStyle: pointerLine,
        crossStyle: pointerLine,
        label: pointerLabel,
      },
    },
  }
}

/** Value-axis styling (hairline grid, muted labels, compact number formatter, name in the axis title position). */
export function valueAxis(theme: ChartTheme, name: string, extra?: Record<string, unknown>): Record<string, unknown> {
  const axis: Record<string, unknown> = {
    type: 'value',
    // Fit the data rather than include zero: flight data often sits far from it (altitude, weight). Use min: 0 to pin it.
    scale: true,
    name,
    nameLocation: 'middle',
    // ECharts 6 moves the name clear of the tick labels (nameMoveOverlap), so this is the gap beyond them.
    nameGap: 10,
    nameTextStyle: { color: theme.textMuted, fontFamily: theme.font, fontSize: theme.fontSize },
    // Keep the axis line on the plot edge even when the other axis crosses zero.
    axisLine: { show: true, onZero: false, lineStyle: { color: theme.axis, width: 1 } },
    axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: theme.grid, width: 1, type: 'solid' } },
    axisLabel: {
      color: theme.textMuted,
      fontFamily: theme.font,
      fontSize: theme.fontSize,
      hideOverlap: true,
      formatter: (value: number) => axisLabel(value),
    },
  }
  return extra ? mergeOptions(axis, extra) : axis
}

/**
 * Deep-merges option objects left to right into a new object: plain objects merge key by key; anything else (arrays,
 * functions, typed arrays, dates) replaces. Inputs are not modified.
 */
export function mergeOptions<T extends object>(base: T, ...overrides: ReadonlyArray<object | null | undefined>): T {
  let merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const override of overrides) {
    if (override) merged = mergeInto(merged, override as Record<string, unknown>)
  }
  return merged as T
}

// ------------------------------------------------------------------------------------- the theme shown on screen

type ScreenMode = 'light' | 'dark'

/** One theme object per screen mode, shared by every chart, so option builders memoised on the theme don't rebuild. */
const screenThemes = new Map<ScreenMode, ChartTheme>()
const tokenListeners = new Set<() => void>()
let tokenVersion = 0
let rootObserver: MutationObserver | null = null

function screenTheme(mode: ScreenMode): ChartTheme {
  const cached = screenThemes.get(mode)
  if (cached) return cached
  const theme = readChartTheme(mode)
  // The tokens are read from whichever theme the page shows, so only cache what was read while `mode` was showing.
  if (typeof document !== 'undefined' && pageMode() === mode) screenThemes.set(mode, theme)
  return theme
}

/**
 * <html data-theme> changed. lib/theme sets the attribute before notifying, so the render after a theme switch already
 * reads the new tokens; this catches what useShownTheme can't see (the attribute changed by other code) and wakes the
 * charts only when a value actually changed.
 */
function onThemeAttributeChange(): void {
  const showing = pageMode()
  let changed = false
  for (const [mode, cached] of screenThemes) {
    if (mode !== showing) {
      // Can't be checked while another theme shows: read it again when it shows.
      screenThemes.delete(mode)
      continue
    }
    const fresh = readChartTheme(mode)
    if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
      screenThemes.set(mode, fresh)
      changed = true
    }
  }
  if (!changed) return
  tokenVersion += 1
  for (const listener of tokenListeners) listener()
}

function subscribeTokens(listener: () => void): () => void {
  tokenListeners.add(listener)
  // One observer for the page's lifetime: it costs nothing between theme switches.
  if (!rootObserver && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    rootObserver = new MutationObserver(onThemeAttributeChange)
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }
  return () => {
    tokenListeners.delete(listener)
  }
}

function readTokenVersion(): number {
  return tokenVersion
}

/** The theme the page shows: <html data-theme="dark">, else light (the CSS base). */
function pageMode(): ScreenMode {
  return typeof document !== 'undefined' && document.documentElement?.dataset.theme === 'dark' ? 'dark' : 'light'
}

// ---------------------------------------------------------------------------------------------------------- helpers

function paperTheme(): ChartTheme {
  return {
    mode: 'paper',
    surface: '#ffffff',
    text: '#172b4d',
    textMuted: '#44546f',
    grid: '#e6e8ec',
    axis: '#8590a2',
    crosshair: '#44546f',
    selection: LIGHT.selection,
    selectionBorder: LIGHT.selectionBorder,
    series: [...LIGHT_SERIES],
    font: FONT,
    mono: MONO,
    fontSize: PAPER_FONT_SIZE,
  }
}

function rootStyle(): CSSStyleDeclaration | null {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.documentElement) return null
  return window.getComputedStyle(document.documentElement)
}

/** Tooltip and crosshair-label text for whatever value ECharts hands over. */
function plainValue(value: unknown): string {
  if (typeof value === 'number') return formatNumber(value)
  if (Array.isArray(value)) return value.map(plainValue).join(', ')
  if (value == null) return formatNumber(Number.NaN)
  return String(value)
}

function mergeInto(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value) ? mergeInto(current, value) : value
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
