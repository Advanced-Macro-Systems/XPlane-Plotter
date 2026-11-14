// Rendering rules of the X–Y option that the view tests (views/xy/xyOption.test.ts) do not pin: large (batched)
// drawing for big series coloured by time, and the contrast of the colour-by-time ramps.

import { describe, expect, it } from 'vitest'
import type { XYData, XYSampleSeries } from '../../views/xy/xyModel'
import { readChartTheme } from '../theme'
import { LARGE_SCATTER_FROM, TIME_BANDS, TIME_RAMP_DARK, TIME_RAMP_LIGHT, xyChartOption } from './xy'

type Series = Record<string, unknown> & { id?: string; type?: string }

/** A whole-file X–Y model with one series of `count` samples spread evenly over time 0..count-1. */
function model(count: number, colorBy: XYData['effective']['colorBy']): XYData {
  const data = new Float32Array(count * 4)
  for (let i = 0; i < count; i += 1) data.set([i % 97, (i * 7) % 89, i, i], i * 4)
  const values = Float64Array.from({ length: count }, (_, i) => i)
  const ch = {
    id: 'y',
    token: 'y',
    occurrence: 1,
    column: 0,
    meta: { label: 'Y', short: 'Y', unit: '', quantity: 'other', group: 'other', known: false },
    values,
    stats: { min: 0, max: count - 1, mean: 0, std: 0, finite: count, constant: false },
  }
  const series: XYSampleSeries = {
    key: '*|y',
    y: { ch, index: 0 },
    group: null,
    slot: 0,
    shape: 'circle',
    name: 'Y',
    data,
    count,
    lineData: new Float32Array(0),
    pointIndex: null,
  }
  return {
    x: { ...ch, id: 'x', token: 'x' },
    ys: [{ ch, index: 0 }],
    effective: {
      source: 'all',
      sourceNote: '',
      colorBy,
      fitTarget: 'samples',
      showMeans: false,
      groupIds: [],
      groupFiltered: false,
      points: [],
    },
    series: [series],
    means: [],
    tRange: [0, count - 1],
    sampleCount: count,
    legend: [],
    empty: '',
  }
}

function scatters(data: XYData): Series[] {
  const option = xyChartOption(
    {
      data,
      fits: [],
      style: 'points',
      showSamples: true,
      labels: { title: '', x: 'X', y: 'Y' },
      time: { label: 'Elapsed time', format: (v) => `${v} s` },
    },
    readChartTheme('light'),
  ) as { series: Series[] }
  return option.series.filter((s) => s.type === 'scatter' && String(s.id).startsWith('pts:'))
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

describe('xyChartOption large drawing', () => {
  it('draws every time band of a large series in large (batched) mode, whatever the band sizes', () => {
    // 6 000 samples in 12 bands: 500 per band, under the 2000 at which one scatter alone would go large.
    const bands = scatters(model(6000, 'time'))
    expect(bands).toHaveLength(TIME_BANDS)
    for (const band of bands) {
      expect(band.large).toBe(true)
      expect(band.largeThreshold).toBe(0)
      expect((band.data as Float32Array).length / 4).toBeLessThan(LARGE_SCATTER_FROM)
    }
  })

  it('keeps small series in normal mode, coloured by time or not, and large ones large', () => {
    for (const band of scatters(model(600, 'time'))) expect(band.largeThreshold).toBe(LARGE_SCATTER_FROM)
    expect(scatters(model(600, 'series'))[0].largeThreshold).toBe(LARGE_SCATTER_FROM)
    // ECharts goes large when a scatter has at least largeThreshold samples.
    expect(scatters(model(LARGE_SCATTER_FROM, 'series'))[0].largeThreshold).toBeLessThanOrEqual(LARGE_SCATTER_FROM)
  })
})

describe('colour-by-time ramps', () => {
  it('get brighter (dark) or darker (light) monotonically, early to late', () => {
    const dark = TIME_RAMP_DARK.map(luminance)
    const light = TIME_RAMP_LIGHT.map(luminance)
    for (let i = 1; i < dark.length; i += 1) expect(dark[i]).toBeGreaterThan(dark[i - 1])
    for (let i = 1; i < light.length; i += 1) expect(light[i]).toBeLessThan(light[i - 1])
  })

  it('keep their faint end at 2:1 or more against the chart surface (dark --chart-surface, light and paper white)', () => {
    // The dark --chart-surface of styles/global.css ("night cockpit" navy), and a lighter grey dark surface for margin.
    expect(contrast(TIME_RAMP_DARK[0], '#0d1421')).toBeGreaterThanOrEqual(2)
    expect(contrast(TIME_RAMP_DARK[0], '#22272b')).toBeGreaterThanOrEqual(2)
    expect(contrast(TIME_RAMP_LIGHT[0], '#ffffff')).toBeGreaterThanOrEqual(2)
  })
})
