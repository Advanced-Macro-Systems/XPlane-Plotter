import { describe, expect, it } from 'vitest'
import { echarts } from './echarts'
import { dataUrlToBlob, imageFileName, renderOptionToDataUrl } from './exportChart'
import { baseOption, mergeOptions, readChartTheme, valueAxis } from './theme'

describe('dataUrlToBlob', () => {
  it('decodes base64 payloads byte for byte', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]
    const blob = dataUrlToBlob(`data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`)
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(bytes)
  })

  it('decodes percent-encoded SVG (ECharts data URLs) back to UTF-8 text', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Δα − 5 % é, 100%</text></svg>'
    const blob = dataUrlToBlob(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`)
    expect(blob.type).toBe('image/svg+xml')
    expect(await blob.text()).toBe(svg)
    expect(blob.size).toBe(new TextEncoder().encode(svg).length)
  })

  it('round-trips the SVG data URL ECharts itself produces', async () => {
    const theme = readChartTheme('paper')
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 320, height: 200 })
    try {
      chart.setOption(
        mergeOptions(baseOption(theme), {
          xAxis: valueAxis(theme, 'Time (s)'),
          yAxis: valueAxis(theme, 'Pitch θ (°)'),
          series: [{ type: 'line', data: [[0, -1], [1, 2]] }],
        }),
      )
      const url = chart.getDataURL({ type: 'svg' })
      expect(url.startsWith('data:image/svg+xml;charset=UTF-8,')).toBe(true)
      const text = await dataUrlToBlob(url).text()
      // Each render mints new CSS class names; everything else must match.
      const withoutClassNames = (svg: string) => svg.replace(/zr\d+-cls-\d+/g, 'cls')
      expect(withoutClassNames(text)).toBe(withoutClassNames(chart.renderToSVGString()))
      expect(text.startsWith('<svg')).toBe(true)
      expect(text).toContain('Pitch θ (°)')
    } finally {
      chart.dispose()
    }
  })

  it('rejects anything that is not a data URL', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow('Not a data URL')
    expect(() => dataUrlToBlob('data:image/png;base64')).toThrow('Not a data URL')
  })
})

describe('imageFileName', () => {
  it('adds the extension and replaces characters file systems forbid', () => {
    expect(imageFileName('Run 3: CG fwd/aft', 'png')).toBe('Run 3_ CG fwd_aft.png')
    expect(imageFileName('a\u0001b<c>|d?*', 'svg')).toBe('a_b_c__d__.svg')
  })

  it('never doubles the extension or leaves a hidden or empty name', () => {
    expect(imageFileName('plot.png', 'png')).toBe('plot.png')
    expect(imageFileName('plot.PNG', 'png')).toBe('plot.png')
    expect(imageFileName('', 'svg')).toBe('chart.svg')
    expect(imageFileName('  ..  ', 'png')).toBe('chart.png')
    expect(imageFileName('.hidden', 'png')).toBe('hidden.png')
    expect(imageFileName('name. ', 'svg')).toBe('name.svg')
  })

  it('keeps names to a sensible length', () => {
    const name = imageFileName('x'.repeat(500), 'png')
    expect(name.length).toBeLessThanOrEqual(124)
    expect(name.endsWith('.png')).toBe(true)
  })
})

describe('renderOptionToDataUrl', () => {
  it('explains that it needs a browser', async () => {
    await expect(renderOptionToDataUrl({}, { format: 'png', width: 600, height: 350 })).rejects.toThrow(/browser/)
  })
})
