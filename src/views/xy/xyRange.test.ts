import { describe, expect, it } from 'vitest'
import { niceRange, shownRange } from '../../charts/options/xyAxes'
import { constructionSeries, LAYOUT_SIZE } from '../../charts/options/xyConstructions'
import { xyChartOption, type XYChartInput, type XYZoomWindow } from '../../charts/options/xy'
import { readChartTheme } from '../../charts/theme'
import { PHYSICAL_RATIO } from '../../core/analysis/rangeEndurance'
import type { XYConfig } from '../../core/types'
import { chartDescription, FIT_OPTIONS, legendChips } from './xyControls'
import { channel, dataset, elapsedAxis, workspace, wsArgs, xyConfig } from './xyFixtures'
import { buildXYData, computeFits, defaultLabels, fitValue } from './xyModel'
import {
  constructionLabel,
  constructionSlots,
  dataSlots,
  ENDURANCE_SLOT,
  EXTRAPOLATED,
  labelNumber,
  NEEDS_TEST_POINTS,
  RANGE_SLOT,
  rangeResults,
} from './xyRange'
import { fitRows, fitTableTsv, rangeRows, rangeTableTsv } from './xyTables'

// A SYNTHETIC power-required curve P = A·V³ + B/V (no flight data): six steady points of ten samples each.
const A = 6e-5
const B = 3000
const SPEEDS = [64, 76, 88, 100, 112, 124]
const power = (v: number) => A * v ** 3 + B / v

function plot(patch: Partial<XYConfig> = {}, speeds = SPEEDS) {
  const v: number[] = []
  const p: number[] = []
  speeds.forEach((speed, k) => {
    for (let i = 0; i < 10; i += 1) {
      const wobble = 0.05 * Math.sin(i + k)
      v.push(speed + wobble)
      p.push(power(speed + wobble))
    }
  })
  const rows = v.map((_, i) => i)
  const ds = dataset([channel('v', v, 'KTAS', 'kt'), channel('p', p, 'Power', 'hp')], rows)
  const ws = workspace({
    points: speeds.map((_, k) => ({ id: `t${k}`, name: `P${k}`, groupId: 'g1', start: 10 * k, end: 10 * k + 10 })),
    xy: xyConfig({
      x: 'v',
      ys: ['p'],
      source: 'points',
      fitTarget: 'means',
      fit: 'power-model',
      rangeEndurance: true,
      axesFromZero: true,
      ...patch,
    }),
  })
  const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: elapsedAxis(ds), lines: false })
  const fits = computeFits(data, ws.xy.fit)
  const re = ws.xy.rangeEndurance ? rangeResults(fits) : null
  return { ds, ws, data, fits, re }
}

describe('physical fits in the X–Y model', () => {
  it('fits the power model through the means and samples its curve over the fitted speeds', () => {
    const { fits } = plot()
    expect(fits).toHaveLength(1)
    const f = fits[0]
    expect(f).toMatchObject({ kind: 'power-model', degree: 0, fit: null, problem: '', target: 'means' })
    expect(f.physical?.a).toBeCloseTo(A, 9)
    expect(f.physical?.b).toBeCloseTo(B, 1)
    expect(f.physical?.n).toBe(6)
    expect(f.curve.length).toBe(2 * 96)
    expect(f.curve[0]).toBeCloseTo(f.physical!.xMin, 12)
    expect(fitValue(f, 90)).toBeCloseTo(power(90), 4)
  })

  it('fits the drag model, and says why there is no fit', () => {
    expect(plot({ fit: 'drag-model' }).fits[0]).toMatchObject({ kind: 'drag-model', problem: '' })
    const one = plot({}, [80])
    expect(one.fits[0].physical).toBeNull()
    expect(one.fits[0].problem).toBe('Needs 2 or more test-point means with different positive x values (has 1).')
    const negative = plot({}, [-80, -90])
    expect(negative.fits[0].problem).toBe('A power model needs test-point means at positive x (speeds).')
  })

  it('offers the two physical models with their equations after the polynomials', () => {
    expect(FIT_OPTIONS.map((o) => o.value)).toEqual(['none', 'linear', 'poly2', 'poly3', 'power-model', 'drag-model'])
    expect(FIT_OPTIONS.find((o) => o.value === 'power-model')).toMatchObject({ label: 'Power', equation: 'A·V³ + B/V' })
    expect(FIT_OPTIONS.find((o) => o.value === 'drag-model')).toMatchObject({ label: 'Drag/thrust', equation: 'A·V² + B/V²' })
  })
})

describe('range and endurance results', () => {
  it('finds V_E and V_R of each fit, with V_R/V_E = 3^¼ for the physical model', () => {
    const { re } = plot()
    expect(re).toHaveLength(1)
    const r = re![0].re
    expect(r.endurance!.v).toBeCloseTo((B / (3 * A)) ** 0.25, 3)
    expect(r.range!.v).toBeCloseTo((B / A) ** 0.25, 3)
    expect(r.ratio).toBeCloseTo(PHYSICAL_RATIO, 12)
    // V_E = 63.9 lies just below the slowest point (64): extrapolated; V_R = 84 is inside.
    expect(r.endurance!.extrapolated).toBe(true)
    expect(r.range!.extrapolated).toBe(false)
  })

  it('works for polynomial fits through the samples too, and gives none for a straight line', () => {
    const quadratic = plot({ fit: 'poly2', fitTarget: 'samples' })
    expect(quadratic.re![0].re.endurance?.v).toBeGreaterThan(55)
    expect(quadratic.re![0].re.range?.v).toBeGreaterThan(quadratic.re![0].re.endurance!.v)
    const line = plot({ fit: 'linear' })
    expect(line.re![0].re.endurance).toBeNull()
    expect(line.re![0].re.enduranceNote).toMatch(/straight line/)
  })

  it('holds every point back with a reason (a range and endurance preset on a log without test points yet)', () => {
    const { fits } = plot()
    const [held] = rangeResults(fits, NEEDS_TEST_POINTS)
    expect(held.re).toMatchObject({ endurance: null, range: null, enduranceNote: NEEDS_TEST_POINTS, rangeNote: NEEDS_TEST_POINTS })
    expect(held.re.slope).toBeNaN()
    expect(held.re.ratio).toBeNaN()
    // The fit itself stays (it is drawn and listed under Fit results).
    expect(held.fit).toBe(fits[0])
    expect(NEEDS_TEST_POINTS).toMatch(/^Save steady level test points first/)
  })

  it('labels the points with the x unit, the fit when there are several, and extrapolation', () => {
    const point = { v: 72.41, y: 50, extrapolated: false }
    expect(constructionLabel('endurance', point, 'kt')).toEqual({
      text: 'Max endurance V_E = 72 kt',
      lead: 'Max endurance V',
      sub: 'E',
      tail: ' = 72 kt',
      value: ' = 72 kt',
      short: 'V',
      extrapolated: false,
    })
    const far = constructionLabel('range', { ...point, v: 94.6, extrapolated: true }, 'kt')
    expect(far).toMatchObject({ text: 'Max range V_R = 95 kt (extrapolated)', value: ' = 95 kt', extrapolated: true })
    expect(far.tail).toBe(` = 95 kt ${EXTRAPOLATED}`)
    expect(constructionLabel('range', point, '', 'Heavy')).toMatchObject({ text: 'Heavy: max range V_R = 72', short: 'Heavy: V' })
    expect(labelNumber(72.5)).toBe('73')
    expect(labelNumber(15.62)).toBe('15.6')
    expect(labelNumber(0.6234)).toBe('0.623')
    expect(labelNumber(-25.2)).toBe('−25')
    expect(labelNumber(Number.NaN)).toBe('—')
  })
})

describe('range and endurance tables', () => {
  it('lists V_E, V_R, the curve there, the slope, the ratio, the fit and the warnings', () => {
    const { data, re } = plot()
    const [row] = rangeRows(data, re!)
    expect(row).toMatchObject({ name: 'Power [hp]', xUnit: 'kt', yUnit: 'hp', kind: 'power-model', target: 'means', n: 6 })
    expect(row.modelRatio).toBeCloseTo(PHYSICAL_RATIO, 12)
    expect(row.equation).toMatch(/^Power = 6(\.0+)?×10⁻⁵·KTAS³ \+ 3000\/KTAS$/)
    expect(row.notes).toHaveLength(1)
    expect(row.notes[0]).toMatch(/^V_E is extrapolated: below the slowest point fitted \(6[34](\.\d+)? kt\)\.$/)
    expect(row.slope).toBeCloseTo(row.range!.y / row.range!.v, 12)
    const tsv = rangeTableTsv(data, [row]).split('\r\n')
    expect(tsv[0].split('\t')).toEqual([
      'series',
      'x',
      'y',
      'x_unit',
      'y_unit',
      'fit',
      'through',
      'V_E',
      'y_at_V_E',
      'V_R',
      'y_at_V_R',
      'y_over_V_at_V_R',
      'V_R_over_V_E',
      'model_V_R_over_V_E',
      'V_E_extrapolated',
      'V_R_extrapolated',
      'equation',
      'r2',
      'n',
      'notes',
    ])
    const cells = tsv[1].split('\t')
    expect(cells.slice(0, 7)).toEqual(['Power [hp]', 'KTAS [kt]', 'Power [hp]', 'kt', 'hp', 'power model', 'means'])
    // Plain numbers at full precision, for a spreadsheet or MATLAB.
    expect(Number(cells[7])).toBe(row.endurance!.v)
    expect(Number(cells[12])).toBe(row.ratio)
    expect(cells[14]).toBe('yes')
    expect(cells[15]).toBe('no')
    expect(cells[16]).not.toContain('−')
  })

  it('names the physical coefficients in the fit table and its TSV', () => {
    const { data, fits } = plot({ fit: 'drag-model' })
    const rows = fitRows(data, fits)
    expect(rows[0].coefficients.map((c) => c.name)).toEqual(['A (V²)', 'B (1/V²)'])
    const tsv = fitTableTsv(data, rows).split('\r\n')
    expect(tsv[0]).toBe('series\tx\ty\tfit\tthrough\tequation\tr2\trmse\tn\tleft_out\tA\tA_se\tB\tB_se')
    const cells = tsv[1].split('\t')
    expect(cells[3]).toBe('drag model')
    expect(Number(cells[10])).toBe(fits[0].physical!.a)
    expect(Number(cells[12])).toBe(fits[0].physical!.b)
  })

  it('adds the constructions to the legend and the description', () => {
    const { data, fits, re } = plot()
    const chips = legendChips(data, fits, 'power-model', 'points', re)
    // Keys drawn as the lines are: dashed guides through the minimum, the solid tangent from the origin.
    expect(chips.slice(-2)).toEqual([
      { key: 're-e', name: 'Max endurance (minimum)', kind: 'guide', slot: ENDURANCE_SLOT, shape: 'circle', line: 'dashed' },
      { key: 're-r', name: 'Max range (tangent from origin)', kind: 'guide', slot: RANGE_SLOT, shape: 'circle', line: 'solid' },
    ])
    // The fit is drawn dotted with the constructions, solid without.
    expect(chips.find((c) => c.kind === 'fit')).toMatchObject({ name: 'Power model fit', line: 'dotted' })
    expect(legendChips(data, fits, 'power-model', 'points', null).find((c) => c.kind === 'fit')?.line).toBe('solid')
    const text = chartDescription(data, defaultLabels(data.x, [data.ys[0].ch]), fits, 'power-model', re)
    expect(text).toMatch(/power model fit through the means; maximum endurance at 63\.8\d kt, maximum range at 84\.0\d kt$/)
  })
})

type Series = Record<string, unknown> & { id?: string; type?: string; name?: string }

function chart(
  patch: Partial<XYConfig> = {},
  mode: 'light' | 'dark' | 'paper' = 'light',
  figure: XYZoomWindow | boolean | null = false,
  extra: Partial<XYChartInput> = {},
) {
  const { data, fits, re, ws } = plot(patch)
  const opt = xyChartOption(
    {
      data,
      fits,
      style: 'points',
      showSamples: true,
      labels: defaultLabels(data.x, data.ys.map((y) => y.ch)),
      time: { label: 'Elapsed time', format: (v) => `${v} s` },
      re,
      axesFromZero: ws.xy.axesFromZero === true,
      ...(figure ? { figure: { zoom: figure === true ? null : figure } } : {}),
      ...extra,
    },
    readChartTheme(mode),
  ) as Record<string, unknown>
  return { opt, series: opt.series as Series[], re }
}

/** The construction labels as the chart option draws them: [position, formatter] of V_E and V_R. */
function drawnLabels(series: Series[]): [string, string][] {
  const markers = series.find((s) => s.id === 're-pts:*|p') as { data: { label?: { position: string; formatter: string } }[] }
  return markers.data.map((d) => [d.label?.position ?? '', d.label?.formatter ?? ''])
}

describe('range and endurance on the chart', () => {
  it('draws the fit dotted with both constructions, markers and labels, axes from zero', () => {
    const { opt, series } = chart()
    const ids = series.map((s) => s.id)
    for (const id of ['re-e-v:*|p', 're-e-h:*|p', 're-r-t:*|p', 're-r-v:*|p', 're-pts:*|p']) expect(ids).toContain(id)
    // V_E lies just below the fitted speeds: the curve is carried on (dashed) down to it.
    expect(ids).toContain('re-ext-low:*|p')
    const fit = series.find((s) => s.id === 'fit:*|p') as { lineStyle: Record<string, unknown> }
    expect(fit.lineStyle).toMatchObject({ type: [0.1, 4.5], cap: 'round' })
    const theme = readChartTheme('light')
    const guide = series.find((s) => s.id === 're-e-v:*|p') as { lineStyle: Record<string, unknown>; name: string }
    expect(guide.lineStyle).toMatchObject({ color: theme.series[ENDURANCE_SLOT], type: [4, 3] })
    expect(guide.name).toBe('Max endurance (minimum)')
    const tangent = series.find((s) => s.id === 're-r-t:*|p') as { data: number[][]; lineStyle: Record<string, unknown> }
    expect(tangent.data[0]).toEqual([0, 0])
    expect(tangent.lineStyle).toMatchObject({ color: theme.series[RANGE_SLOT], type: 'solid' })
    // Both axes from zero, rounded, with ticks on whole steps.
    const xAxis = opt.xAxis as Record<string, number>
    const yAxis = opt.yAxis as Record<string, number>
    expect([xAxis.min, xAxis.max, xAxis.splitNumber]).toEqual([0, 140, 7])
    expect([yAxis.min, yAxis.max]).toEqual([0, 140])
    // The vertical guides start at the x axis; the horizontal one spans it.
    const across = series.find((s) => s.id === 're-e-h:*|p') as { data: number[][] }
    expect(across.data.map((p) => p[0])).toEqual([0, 140])
    expect((guide as unknown as { data: number[][] }).data[0][1]).toBe(0)
  })

  it('labels the markers in ink, with the subscript, and keeps the labels inside the plot', () => {
    const { series } = chart({}, 'dark')
    const markers = series.find((s) => s.id === 're-pts:*|p') as { data: { label: Record<string, unknown> }[] }
    expect(markers.data).toHaveLength(2)
    const theme = readChartTheme('dark')
    const label = markers.data[0].label as { formatter: string; rich: { t: { color: string } }; position: string }
    expect(label.formatter).toBe('{t|Max endurance V}{s|E}{t| = 64 kt (extrapolated)}')
    expect(label.rich.t.color).toBe(theme.text)
    expect(['left', 'right']).toContain(label.position)
    expect((markers.data[1].label as { formatter: string }).formatter).toBe('{t|Max range V}{s|R}{t| = 84 kt}')
  })

  it('draws them into an exported figure too, with legend entries', () => {
    const { opt, series } = chart({}, 'paper', true)
    expect(series.map((s) => s.id)).toContain('re-pts:*|p')
    const legend = (opt.legend as { data: string[] }).data
    expect(legend).toEqual(expect.arrayContaining(['Max endurance (minimum)', 'Max range (tangent from origin)']))
  })

  it('places the labels for the plotting area the screen measured and the zoom it shows, or for an exported figure', () => {
    expect(drawnLabels(chart().series)[0]).toEqual(['left', '{t|Max endurance V}{s|E}{t| = 64 kt (extrapolated)}'])
    // A phone's plotting area (measured): too narrow for the label on one line, so "(extrapolated)" goes below.
    const phone = drawnLabels(chart({}, 'light', false, { plot: { width: 250, height: 180 } }).series)
    expect(phone[0][1]).toMatch(/\n\{t\|\(extrapolated\)\}$/)
    // Before the first measurement the chart's size, less the axes, gives the same estimate.
    const estimated = drawnLabels(chart({}, 'light', false, { size: { width: 360, height: 250 } }).series)
    expect(estimated[0][1]).toBe(phone[0][1])
    // Zoomed so that V_E sits at the left edge: its label leaves the left side.
    const zoom: XYZoomWindow = { x: { startValue: 60, endValue: 140 }, y: { startValue: 40, endValue: 140 } }
    expect(drawnLabels(chart({}, 'light', false, { labelZoom: zoom }).series)[0][0]).not.toBe('left')
    // An exported figure keeps the zoom it is given and places its labels for it.
    expect(drawnLabels(chart({}, 'paper', zoom, { size: { width: 900, height: 600 } }).series)[0][0]).not.toBe('left')
  })

  it('draws the markers opaque, so the lines behind do not show through', () => {
    const { series } = chart({}, 'paper', true)
    const markers = series.find((s) => s.id === 're-pts:*|p') as { itemStyle: { opacity: number }; data: { itemStyle: { opacity: number } }[] }
    expect(markers.itemStyle.opacity).toBe(1)
    for (const item of markers.data) expect(item.itemStyle.opacity).toBe(1)
  })

  it('draws the constructions in ink when the data use their colours, told apart by line style', () => {
    expect(constructionSlots([0])).toEqual({ endurance: ENDURANCE_SLOT, range: RANGE_SLOT })
    expect(constructionSlots([0, 1])).toEqual({ endurance: null, range: null })
    expect(constructionSlots([2])).toEqual({ endurance: null, range: null })
    expect(constructionSlots([0, 3, 7])).toEqual({ endurance: ENDURANCE_SLOT, range: RANGE_SLOT })
    // The plotted channel kept the orange slot (a second test-point group is orange too).
    const { data, fits, re } = plot({ ySlots: [RANGE_SLOT] })
    expect(dataSlots(data)).toEqual([RANGE_SLOT])
    const theme = readChartTheme('light')
    const { series } = chart({ ySlots: [RANGE_SLOT] })
    const style = (id: string) => (series.find((s) => s.id === id) as { lineStyle: Record<string, unknown> }).lineStyle
    expect(style('re-e-v:*|p')).toMatchObject({ color: theme.text, type: [4, 3] })
    expect(style('re-e-h:*|p')).toMatchObject({ color: theme.text, type: [4, 3] })
    expect(style('re-r-t:*|p')).toMatchObject({ color: theme.text, type: 'solid' })
    expect(style('re-r-v:*|p')).toMatchObject({ color: theme.text, type: [8, 3, 1.5, 3] })
    // In colour the V_R guide is dashed like the others.
    expect((chart().series.find((s) => s.id === 're-r-v:*|p') as { lineStyle: Record<string, unknown> }).lineStyle.type).toEqual([4, 3])
    // The legend keys follow: neutral ink (slot null).
    const chips = legendChips(data, fits, 'power-model', 'points', re)
    expect(chips.filter((c) => c.kind === 'guide').map((c) => c.slot)).toEqual([null, null])
  })

  it('leaves the chart as it was without the markers; axes from zero alone moves only the axes', () => {
    const off = chart({ rangeEndurance: false, axesFromZero: false })
    expect(off.series.some((s) => String(s.id).startsWith('re-'))).toBe(false)
    expect((off.series.find((s) => s.id === 'fit:*|p') as { lineStyle: Record<string, unknown> }).lineStyle).toEqual({
      width: 2,
      color: expect.any(String),
    })
    expect((off.opt.xAxis as Record<string, unknown>).min).toBeNull()
    const zero = chart({ rangeEndurance: false })
    expect(zero.series.some((s) => String(s.id).startsWith('re-'))).toBe(false)
    expect((zero.opt.xAxis as Record<string, unknown>).min).toBe(0)
    expect((zero.opt.yAxis as Record<string, unknown>).min).toBe(0)
  })
})

describe('construction labels', () => {
  it('try the upper left first, and move to another side when data are there', () => {
    const { data, re } = plot()
    const fitColor = () => '#000000'
    const theme = readChartTheme('light')
    const open = constructionSeries({ results: re!, data, x: [0, 140], y: [0, 140], showSamples: true, fitColor }, theme)
    expect(open.labels.map((l) => [l.side, l.dy])).toEqual([
      ['left', -19],
      ['left', -19],
    ])
    expect(open.legend).toEqual(['Max endurance (minimum)', 'Max range (tangent from origin)'])
    // Put a cloud of means just above-left of the range point: its label goes elsewhere.
    const vR = re![0].re.range!
    const crowded = {
      ...data,
      means: [
        ...data.means,
        ...Array.from({ length: 12 }, (_, i) => ({ ...data.means[0], x: { ...data.means[0].x, mean: vR.v - 3 - 2 * i }, yStats: { ...data.means[0].yStats, mean: vR.y + 6 } })),
      ],
    }
    const moved = constructionSeries({ results: re!, data: crowded, x: [0, 140], y: [0, 140], showSamples: false, fitColor }, theme)
    expect([moved.labels[1].side, moved.labels[1].dy]).not.toEqual(['left', -19])
    expect(LAYOUT_SIZE.width).toBeGreaterThan(LAYOUT_SIZE.height)
  })

  it('are placed for the plot size they are drawn at, so a narrow plot does not stack them', () => {
    const { data, re } = plot()
    const input = { results: re!, data, x: [0, 140] as const, y: [0, 140] as const, showSamples: true, fitColor: () => '#000' }
    const theme = readChartTheme('light')
    const wide = constructionSeries(input, theme).labels
    const narrow = constructionSeries({ ...input, size: { width: 260, height: 200 } }, theme).labels
    // On the default size both labels sit at the upper left of their markers; on a phone-sized plot they would cover
    // each other there, so one of them moves.
    expect(wide.map((l) => [l.side, l.dy])).toEqual([
      ['left', -19],
      ['left', -19],
    ])
    expect(narrow.map((l) => [l.side, l.dy])).not.toEqual(wide.map((l) => [l.side, l.dy]))
  })

  const insideOf = (labels: readonly { box: { left: number; right: number; top: number; bottom: number } }[], size: { width: number; height: number }) => {
    for (const { box } of labels) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(size.width)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.bottom).toBeLessThanOrEqual(size.height)
    }
  }

  it('stay inside a phone-sized plot: a label too long for one line puts "(extrapolated)" on a second line', () => {
    const { data, re } = plot()
    const theme = readChartTheme('light')
    const size = { width: 250, height: 180 }
    const out = constructionSeries({ results: re!, data, x: [0, 140], y: [0, 140], showSamples: true, fitColor: () => '#000', size }, theme)
    expect(out.labels).toHaveLength(2)
    insideOf(out.labels, size)
    // "Max endurance V_E = 64 kt (extrapolated)" on one line is wider than the plot.
    const [endurance] = out.labels
    expect(endurance.form).not.toBe('line')
    expect(endurance.text).toMatch(/V_E = 64 kt\n\(extrapolated\)$/)
    const markers = out.series.find((s) => s.id === 're-pts:*|p') as { data: { label: { formatter: string } }[] }
    expect(markers.data[0].label.formatter).toMatch(/\{t\| = 64 kt\}\n\{t\|\(extrapolated\)\}$/)
    // Narrower still: the short form, and still inside.
    const tiny = { width: 140, height: 120 }
    const short = constructionSeries({ results: re!, data, x: [0, 140], y: [0, 140], showSamples: true, fitColor: () => '#000', size: tiny }, theme)
    insideOf(short.labels, tiny)
    expect(short.labels[0].text).toBe('V_E = 64 kt\n(extrapolated)')
  })

  it('follow the zoom window: placed inside it, and none for a marker zoomed out of view', () => {
    const { data, re } = plot()
    const theme = readChartTheme('light')
    const input = { results: re!, data, x: [0, 140] as const, y: [0, 140] as const, showSamples: true, fitColor: () => '#000' }
    // Zoomed so that V_E (63.9 kt) sits near the left edge: its label cannot go on its left any more.
    const zoomed = constructionSeries({ ...input, view: { x: [60, 140], y: [40, 140] } }, theme)
    expect(zoomed.labels).toHaveLength(2)
    insideOf(zoomed.labels, LAYOUT_SIZE)
    expect(zoomed.labels[0].side).not.toBe('left')
    // V_E zoomed out of view: ECharts clips its marker, and it gets no label.
    const past = constructionSeries({ ...input, view: { x: [70, 140], y: [40, 140] } }, theme)
    expect(past.labels.map((l) => l.text)).toEqual(['Max range V_R = 84 kt'])
  })

  it('draw nothing for points outside the x range', () => {
    const { data, re } = plot()
    const out = constructionSeries(
      { results: re!, data, x: [100, 140], y: [0, 140], showSamples: true, fitColor: () => '#000' },
      readChartTheme('light'),
    )
    expect(out.series).toEqual([])
    expect(out.legend).toEqual([])
  })
})

describe('axis ranges set by the app', () => {
  it('round to whole steps and say how many there are', () => {
    expect(niceRange([3, 147])).toEqual([0, 160])
    expect(shownRange(null, [64, 124], [63.9], true)).toEqual({ range: [0, 140], splits: 7 })
    expect(shownRange([10, 20], [0, 1000], [], false)).toEqual({ range: [10, 20], splits: 5 })
    expect(shownRange(null, [Infinity, -Infinity], [], false)).toBeNull()
    expect(shownRange(null, [5, 5], [], false)).toBeNull()
  })
})
