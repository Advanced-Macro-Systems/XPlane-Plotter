import { describe, expect, it } from 'vitest'
import { echarts } from './echarts'
import { MINUS } from './format'
import { baseOption, mergeOptions, readChartTheme, seriesColor, valueAxis, type ChartTheme } from './theme'

/**
 * styles/global.css as text. Vitest blanks CSS imports (even "?raw") and the app tsconfig has no Node types, so the file
 * is read through Node's builtin-module loader with a minimal local type.
 */
function readGlobalCss(): string {
  type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
  type NodeProcess = { getBuiltinModule?: (id: string) => unknown }
  const nodeProcess = (globalThis as unknown as { process?: NodeProcess }).process
  const fs = nodeProcess?.getBuiltinModule?.('node:fs') as Fs | undefined
  if (!fs) throw new Error('These tests need Node 20.16 or later (process.getBuiltinModule)')
  return fs.readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8')
}

/** The custom properties of the first block in styles/global.css that opens with `opening` (comments left out). */
function tokensOf(opening: string): Map<string, string> {
  const css = readGlobalCss()
  const start = css.indexOf(opening)
  expect(start).toBeGreaterThanOrEqual(0)
  const block = css.slice(start, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
  const tokens = new Map<string, string>()
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens.set(match[1], match[2].trim())
  return tokens
}

/** The light theme (the base `:root` block) and the dark theme's overrides. */
const lightTokens = () => tokensOf(':root {')
const darkTokens = () => tokensOf(":root[data-theme='dark'] {")

const LIGHT_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']

describe('readChartTheme', () => {
  it('gives the fixed paper theme', () => {
    const paper = readChartTheme('paper')
    expect(paper).toMatchObject({
      mode: 'paper',
      surface: '#ffffff',
      text: '#172b4d',
      textMuted: '#44546f',
      grid: '#e6e8ec',
      axis: '#8590a2',
      fontSize: 13,
    })
    expect(paper.series).toEqual(LIGHT_SERIES)
    expect(paper.font.startsWith("'Geist Variable'")).toBe(true)
    expect(paper.mono.startsWith("'Geist Mono Variable'")).toBe(true)
  })

  it('hands out a fresh paper theme each time', () => {
    const first = readChartTheme('paper')
    first.series[0] = '#000000'
    first.grid = '#000000'
    expect(readChartTheme('paper').series[0]).toBe('#2a78d6')
    expect(readChartTheme('paper').grid).toBe('#e6e8ec')
  })

  it('falls back to the light tokens of global.css outside the browser', () => {
    const tokens = lightTokens()
    for (const mode of ['light', 'dark'] as const) {
      const theme = readChartTheme(mode)
      expect(theme.mode).toBe(mode)
      expect(theme.surface).toBe(tokens.get('--chart-surface'))
      expect(theme.text).toBe(tokens.get('--chart-text'))
      expect(theme.textMuted).toBe(tokens.get('--chart-text-muted'))
      expect(theme.grid).toBe(tokens.get('--chart-grid'))
      expect(theme.axis).toBe(tokens.get('--chart-axis'))
      expect(theme.crosshair).toBe(tokens.get('--chart-crosshair'))
      expect(theme.selection).toBe(tokens.get('--chart-selection'))
      expect(theme.selectionBorder).toBe(tokens.get('--chart-selection-border'))
      expect(theme.zoomWindow).toBe(tokens.get('--chart-zoom-window'))
      expect(theme.series).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((slot) => tokens.get(`--series-${slot}`)))
      expect(theme.font).toBe(tokens.get('--font'))
      expect(theme.mono).toBe(tokens.get('--mono'))
      expect(theme.fontSize).toBe(12)
    }
  })

  it('keeps the paper series identical to the light screen series', () => {
    expect(readChartTheme('paper').series).toEqual(readChartTheme('light').series)
  })
})

describe('the two themes in global.css', () => {
  it('gives dark its own value for every colour and shadow of light, so it never inherits a light one', () => {
    const light = lightTokens()
    const dark = darkTokens()
    const colours = [...light].filter(([, value]) => /#|rgb/.test(value)).map(([name]) => name)
    expect(colours.length).toBeGreaterThan(60)
    expect(colours.filter((name) => !dark.has(name))).toEqual([])
    expect([...dark.keys()].filter((name) => !light.has(name))).toEqual([])
  })

  it('keeps the chart selection and the zoom window apart in dark (magenta selection, cyan window)', () => {
    const dark = darkTokens()
    expect(dark.get('--chart-selection')).not.toBe(dark.get('--chart-zoom-window'))
    expect(dark.get('--chart-selection-border')).not.toBe(dark.get('--chart-zoom-window-border'))
  })
})

describe('seriesColor', () => {
  const theme = readChartTheme('paper')

  it('picks slots in fixed order', () => {
    expect(seriesColor(theme, 0)).toBe('#2a78d6')
    expect(seriesColor(theme, 7)).toBe('#e34948')
  })

  it('wraps only as a last resort, and tolerates odd slots', () => {
    expect(seriesColor(theme, 8)).toBe('#2a78d6')
    expect(seriesColor(theme, -1)).toBe('#e34948')
    expect(seriesColor(theme, 2.7)).toBe('#1baf7a')
    expect(seriesColor(theme, Number.NaN)).toBe('#2a78d6')
    expect(seriesColor({ ...theme, series: [] }, 3)).toBe(theme.text)
  })
})

describe('baseOption', () => {
  const paper = readChartTheme('paper')
  const screen = readChartTheme('light')

  it('turns animation off and sets type, ink and the categorical palette', () => {
    const option = baseOption(paper) as Record<string, unknown>
    expect(option.animation).toBe(false)
    expect(option.color).toEqual(paper.series)
    expect(option.textStyle).toEqual({ fontFamily: paper.font, fontSize: 13, color: '#172b4d' })
    expect(option.aria).toMatchObject({ enabled: true, decal: { show: false } })
  })

  it('paints the background only for paper', () => {
    expect((baseOption(paper) as Record<string, unknown>).backgroundColor).toBe('#ffffff')
    expect((baseOption(screen) as Record<string, unknown>).backgroundColor).toBe('transparent')
  })

  it('styles the tooltip: no border, overlay background, rounded, shadowed, confined, no easing', () => {
    const tooltip = (baseOption(screen) as { tooltip: Record<string, unknown> }).tooltip
    expect(tooltip).toMatchObject({ borderWidth: 0, padding: [8, 10], confine: true, transitionDuration: 0 })
    expect(tooltip.backgroundColor).toBe('var(--surface-overlay, #ffffff)')
    expect(tooltip.extraCssText).toContain('border-radius:8px')
    expect(tooltip.extraCssText).toContain('box-shadow:var(--shadow,')
    expect(tooltip.axisPointer).toMatchObject({
      type: 'line',
      lineStyle: { color: screen.crosshair, width: 1, type: 'solid' },
    })
    const paperTooltip = (baseOption(paper) as { tooltip: Record<string, unknown> }).tooltip
    expect(paperTooltip.backgroundColor).toBe('#ffffff')
    expect(paperTooltip.extraCssText).not.toContain('var(')
  })

  it('formats tooltip values and crosshair labels like the rest of the app', () => {
    const tooltip = (baseOption(paper) as { tooltip: { valueFormatter: (value: unknown) => string } }).tooltip
    expect(tooltip.valueFormatter(-1234.5)).toBe(`${MINUS}1235`)
    expect(tooltip.valueFormatter([1, 0.5])).toBe('1, 0.5')
    expect(tooltip.valueFormatter(null)).toBe('—')
    const pointer = (baseOption(paper) as { axisPointer: { label: { formatter: (p: { value: unknown }) => string } } })
      .axisPointer
    expect(pointer.label.formatter({ value: 0.1 + 0.2 })).toBe('0.3')
  })

  it('draws the crosshair on its own layer without highlighting samples, so hovering repaints only that layer', () => {
    const pointer = (baseOption(screen) as { axisPointer: Record<string, unknown> }).axisPointer
    expect(pointer).toMatchObject({ zlevel: 1, triggerEmphasis: false })
    // ECharts reads an axis tooltip's pointer zlevel and triggerEmphasis from this global axisPointer component.
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 200, height: 100 })
    chart.setOption(
      mergeOptions(baseOption(screen), {
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value' },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'line',
            data: [
              [0, 1],
              [1, 2],
            ],
          },
        ],
      }),
    )
    type Model = { getModel(): { getComponent(type: string): { get(key: string): unknown } } }
    const global = (chart as unknown as Model).getModel().getComponent('axisPointer')
    expect(global.get('zlevel')).toBe(1)
    expect(global.get('triggerEmphasis')).toBe(false)
    chart.dispose()
  })
})

describe('valueAxis', () => {
  const theme = readChartTheme('paper')

  it('styles a value axis: fitted scale, middle name, solid hairline grid, no ticks, compact labels', () => {
    const axis = valueAxis(theme, 'Indicated airspeed (kt)')
    expect(axis).toMatchObject({
      type: 'value',
      scale: true,
      name: 'Indicated airspeed (kt)',
      nameLocation: 'middle',
      nameTextStyle: { color: theme.textMuted },
      axisLine: { show: true, onZero: false, lineStyle: { color: theme.axis, width: 1 } },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: theme.grid, width: 1, type: 'solid' } },
      axisLabel: { color: theme.textMuted },
    })
    const formatter = (axis.axisLabel as { formatter: (value: number) => string }).formatter
    expect(formatter(0.30000000000000004)).toBe('0.3')
    expect(formatter(-5)).toBe(`${MINUS}5`)
  })

  it('merges extra settings deeply, keeping the styling it does not override', () => {
    const axis = valueAxis(theme, 'Row', { min: 0, position: 'bottom', axisLabel: { show: false } })
    expect(axis.min).toBe(0)
    expect(axis.position).toBe('bottom')
    expect(axis.axisLabel).toMatchObject({ show: false, color: theme.textMuted })
    expect(typeof (axis.axisLabel as { formatter: unknown }).formatter).toBe('function')
  })
})

describe('mergeOptions', () => {
  it('merges plain objects key by key and replaces everything else', () => {
    const values = new Float64Array([1, 2])
    const base = { tooltip: { confine: true, textStyle: { color: 'a', fontSize: 12 } }, series: [{ id: 'a' }], k: 1 }
    const merged = mergeOptions(base, { tooltip: { trigger: 'axis', textStyle: { color: 'b' } }, series: [{ id: 'b' }] }, {
      data: values,
    })
    expect(merged).toEqual({
      tooltip: { confine: true, trigger: 'axis', textStyle: { color: 'b', fontSize: 12 } },
      series: [{ id: 'b' }],
      k: 1,
      data: values,
    })
    expect((merged as unknown as { data: unknown }).data).toBe(values)
  })

  it('does not modify its inputs and skips missing overrides', () => {
    const base = { tooltip: { confine: true } }
    const override = { tooltip: { trigger: 'axis' } }
    const merged = mergeOptions(base, override, undefined, null)
    expect(base).toEqual({ tooltip: { confine: true } })
    expect(override).toEqual({ tooltip: { trigger: 'axis' } })
    expect(merged.tooltip).not.toBe(base.tooltip)
  })
})

describe('a paper-theme chart rendered by ECharts', () => {
  function renderSvg(theme: ChartTheme): string {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 350 })
    try {
      chart.setOption(
        mergeOptions(baseOption(theme), {
          grid: { left: 70, right: 20, top: 20, bottom: 50 },
          xAxis: valueAxis(theme, 'Time <s>'),
          yAxis: valueAxis(theme, 'Pitch "θ"'),
          tooltip: { trigger: 'axis' },
          series: [
            {
              type: 'line',
              name: '<script>alert(1)</script>',
              showSymbol: false,
              lineStyle: { width: 2 },
              color: seriesColor(theme, 0),
              data: [
                [0, -2],
                [5, 1.5],
                [10, 3],
              ],
            },
          ],
        }),
      )
      return chart.renderToSVGString()
    } finally {
      chart.dispose()
    }
  }

  it('renders with the theme colours, escaped names and app number formatting', () => {
    const theme = readChartTheme('paper')
    const svg = renderSvg(theme)
    expect(svg).toContain(theme.grid)
    expect(svg).toContain(theme.series[0])
    expect(svg).toContain('Time &lt;s&gt;')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain(`${MINUS}2`)
    // The font sits inside a double-quoted style attribute: its own quotes must stay single.
    expect(svg).toContain("'Geist Variable'")
    expect(svg).not.toContain('"Geist')
  })
})
