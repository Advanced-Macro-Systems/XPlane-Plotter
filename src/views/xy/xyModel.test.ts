import { describe, expect, it } from 'vitest'
import { buildDataset } from '../../core/buildDataset'
import { generateDemoFlight } from '../../core/demo/generateDemo'
import { parseText } from '../../core/parse'
import { timeAxis } from '../../core/time'
import { demoWorkspace } from '../../store/demoWorkspace'
import { channel, dataset, elapsedAxis, range, workspace, wsArgs, xyConfig } from './xyFixtures'
import {
  MARKER_SHAPES,
  SAMPLE_STRIDE,
  buildXYData,
  computeFits,
  defaultLabels,
  disjoint,
  effectiveXY,
  finalLabels,
  fitCurve,
  unitMismatch,
  type XYData,
} from './xyModel'

/** x = 0..9, y = 2x + 1, y2 = −x (row 3 missing), seconds = row. */
function linearDataset() {
  const x = range(10)
  return dataset(
    [
      channel('x', x, 'X', 'kt'),
      channel('y', x.map((v) => 2 * v + 1), 'Y', 'deg'),
      channel('y2', x.map((v) => (v === 3 ? NaN : -v)), 'Y2', 'deg'),
      channel('z', x.map((v) => v * v), 'Z', 'lb'),
    ],
    x,
  )
}

function rowsOf(data: XYData, series = 0): number[] {
  const s = data.series[series]
  return Array.from({ length: s.count }, (_, k) => s.data[k * SAMPLE_STRIDE + 3])
}

describe('effectiveXY', () => {
  const ws = workspace({
    points: [
      { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 3 },
      { id: 't2', name: 'B', groupId: 'g2', start: 4, end: 6 },
      { id: 't3', name: 'C', groupId: 'g1', start: 6, end: 8, hidden: true },
    ],
  })

  it('falls back to every row without a zoom range or without test points', () => {
    const noView = effectiveXY(xyConfig({ source: 'view' }), ws, null)
    expect(noView.source).toBe('all')
    expect(noView.sourceNote).toMatch(/zoom range/)
    expect(effectiveXY(xyConfig({ source: 'view' }), ws, [2, 5]).source).toBe('view')
    const noPoints = effectiveXY(xyConfig({ source: 'points' }), workspace(), null)
    expect(noPoints.source).toBe('all')
    expect(noPoints.sourceNote).toMatch(/no test points/)
  })

  it('uses the visible points of the chosen groups only', () => {
    const all = effectiveXY(xyConfig({ source: 'points' }), ws, null)
    expect(all.points.map((p) => p.id)).toEqual(['t1', 't2'])
    expect(all.groupFiltered).toBe(false)
    const trim = effectiveXY(xyConfig({ source: 'points', groups: ['g1'] }), ws, null)
    expect(trim.points.map((p) => p.id)).toEqual(['t1'])
    expect(trim.groupIds).toEqual(['g1'])
    expect(trim.groupFiltered).toBe(true)
  })

  it('ignores a stale group filter', () => {
    const stale = effectiveXY(xyConfig({ source: 'points', groups: ['gone'] }), ws, null)
    expect(stale.groupIds).toEqual(['g1', 'g2'])
    expect(stale.groupFiltered).toBe(false)
  })

  it('allows group colours, means and fits through means only with test points', () => {
    const settings = xyConfig({ colorBy: 'group', fitTarget: 'means', showMeans: true })
    const plain = effectiveXY({ ...settings, source: 'all' }, ws, null)
    expect([plain.colorBy, plain.fitTarget, plain.showMeans]).toEqual(['series', 'samples', false])
    const points = effectiveXY({ ...settings, source: 'points' }, ws, null)
    expect([points.colorBy, points.fitTarget, points.showMeans]).toEqual(['group', 'means', true])
  })
})

describe('buildXYData', () => {
  const ds = linearDataset()
  const axis = elapsedAxis(ds)

  it('makes one series per Y channel with interleaved finite samples', () => {
    const data = buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ ys: ['y', 'y2'] }) })), view: null, axis, lines: false })
    expect(data.empty).toBe('')
    expect(data.series.map((s) => s.key)).toEqual(['*|y', '*|y2'])
    expect(data.series[0].count).toBe(10)
    expect(data.series[1].count).toBe(9) // row 3 is missing
    expect(Array.from(data.series[0].data.subarray(0, 8))).toEqual([0, 1, 0, 0, 1, 3, 1, 1])
    expect(rowsOf(data, 1)).not.toContain(3)
    expect(data.sampleCount).toBe(19)
    expect(data.tRange).toEqual([0, 9])
    expect(data.series[0].lineData.length).toBe(0)
  })

  it('keeps each channel on the slot of its position in the chosen list', () => {
    const data = buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ ys: ['missing', 'y2'] }) })), view: null, axis, lines: false })
    expect(data.series).toHaveLength(1)
    expect(data.series[0].slot).toBe(1)
    expect(data.series[0].y.index).toBe(1)
  })

  it('colours and shapes each Y channel by its stored slot, so removing another Y never re-colours it', () => {
    const before = buildXYData({
      ds,
      ...wsArgs(workspace({ xy: xyConfig({ ys: ['y', 'y2', 'z', 'x'], ySlots: [0, 1, 2, 3] }) })),
      view: null,
      axis,
      lines: false,
    })
    // 'y' removed: the store keeps the others' slots (store/app setXY).
    const after = buildXYData({
      ds,
      ...wsArgs(workspace({ xy: xyConfig({ ys: ['y2', 'z', 'x'], ySlots: [1, 2, 3] }) })),
      view: null,
      axis,
      lines: false,
    })
    const look = (data: XYData) => new Map(data.series.map((s) => [s.y.ch.id, `${s.slot}:${s.shape}`]))
    for (const id of ['y2', 'z', 'x']) expect(look(after).get(id)?.split(':')[0]).toBe(look(before).get(id)?.split(':')[0])
    expect(after.legend.map((l) => l.slot)).toEqual([1, 2, 3])
    // Shapes tell the Y channels apart when colour shows the groups: by slot as well.
    const grouped = buildXYData({
      ds,
      ...wsArgs(
        workspace({
          points: [{ id: 't1', name: 'A', groupId: 'g1', start: 0, end: 4 }],
          xy: xyConfig({ source: 'points', colorBy: 'group', ys: ['y2', 'z'], ySlots: [4, 2] }),
        }),
      ),
      view: null,
      axis,
      lines: false,
    })
    expect(grouped.series.map((s) => s.shape)).toEqual([MARKER_SHAPES[4], MARKER_SHAPES[2]])
    expect(grouped.means.map((m) => [m.y.ch.id, m.y.slot])).toEqual([
      ['y2', 4],
      ['z', 2],
    ])
    expect(grouped.legend.filter((l) => l.kind === 'shape').map((l) => [l.slot, l.shape])).toEqual([
      [4, MARKER_SHAPES[4]],
      [2, MARKER_SHAPES[2]],
    ])
  })

  it('plots only the zoom range with the view source', () => {
    const data = buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ source: 'view' }) })), view: [2, 5], axis, lines: false })
    expect(rowsOf(data)).toEqual([2, 3, 4])
  })

  it('breaks lines between time segments', () => {
    const segmented = { ...ds, segments: [{ start: 0, end: 4, reason: 'start' as const }, { start: 4, end: 10, reason: 'reset' as const }] }
    const data = buildXYData({ ds: segmented, ...wsArgs(workspace()), view: null, axis, lines: true })
    const line = data.series[0].lineData
    expect(line.length).toBe((10 + 2) * SAMPLE_STRIDE)
    // row 3, then the separator, then row 4
    expect(line[3 * SAMPLE_STRIDE + 3]).toBe(3)
    expect(Number.isNaN(line[4 * SAMPLE_STRIDE])).toBe(true)
    expect(line[5 * SAMPLE_STRIDE + 3]).toBe(4)
  })

  it('colours by group with test points, plots overlapping rows once and keeps the point of each sample', () => {
    const ws = workspace({
      points: [
        { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 4 },
        { id: 't2', name: 'B', groupId: 'g1', start: 2, end: 6 },
        { id: 't3', name: 'C', groupId: 'g2', start: 7, end: 9 },
        { id: 't4', name: 'D', groupId: 'g2', start: 9, end: 10, hidden: true },
      ],
      xy: xyConfig({ source: 'points', colorBy: 'group' }),
    })
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis, lines: false })
    expect(data.series.map((s) => [s.key, s.slot, s.name])).toEqual([
      ['g1|y', 0, 'Trim'],
      ['g2|y', 3, 'Dynamic'],
    ])
    expect(rowsOf(data, 0)).toEqual([0, 1, 2, 3, 4, 5])
    expect(Array.from(data.series[0].pointIndex ?? [])).toEqual([0, 0, 0, 0, 1, 1])
    expect(rowsOf(data, 1)).toEqual([7, 8])
    // means: one per visible point
    expect(data.means.map((m) => [m.point.id, m.seriesKey, m.rows])).toEqual([
      ['t1', 'g1|y', 4],
      ['t2', 'g1|y', 4],
      ['t3', 'g2|y', 2],
    ])
    expect(data.means[0].x.mean).toBeCloseTo(1.5)
    expect(data.means[0].yStats.mean).toBeCloseTo(4)
    expect(data.means[2].t).toBe(7)
    expect(data.legend.map((l) => [l.name, l.kind])).toEqual([
      ['Trim', 'colour'],
      ['Dynamic', 'colour'],
    ])
  })

  it('tells colour entities apart by shape when colour cannot', () => {
    const ws = workspace({
      points: [{ id: 't1', name: 'A', groupId: 'g1', start: 0, end: 4 }],
      xy: xyConfig({ source: 'points', colorBy: 'group', ys: ['y', 'y2'] }),
    })
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis, lines: false })
    expect(data.series.map((s) => s.shape)).toEqual(['circle', 'rect'])
    expect(data.series.map((s) => s.name)).toEqual(['Trim · Y', 'Trim · Y2'])
    expect(data.legend.map((l) => `${l.kind}:${l.name}`)).toEqual(['colour:Trim', 'shape:Y [deg]', 'shape:Y2 [deg]'])

    const many = buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ ys: ['y', 'y2', 'z', 'x'] }) })), view: null, axis, lines: false })
    expect(many.series.map((s) => s.shape)).toEqual(MARKER_SHAPES.slice(0, 4))
    const few = buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ ys: ['y', 'y2'] }) })), view: null, axis, lines: false })
    expect(few.series.map((s) => s.shape)).toEqual(['circle', 'circle'])
  })

  it('explains an empty plot', () => {
    expect(buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ x: null }) })), view: null, axis, lines: false }).empty).toMatch(/X axis/)
    expect(buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ ys: [] }) })), view: null, axis, lines: false }).empty).toMatch(/Y axis/)
    const hidden = workspace({
      points: [{ id: 't1', name: 'A', groupId: 'g1', start: 0, end: 4, hidden: true }],
      xy: xyConfig({ source: 'points' }),
    })
    expect(buildXYData({ ds, ...wsArgs(hidden), view: null, axis, lines: false }).empty).toMatch(/hidden/)
    const blank = dataset([channel('x', [1, 2], 'X', ''), channel('y', [NaN, NaN], 'Y', '')], [0, 1])
    expect(buildXYData({ ds: blank, ...wsArgs(workspace()), view: null, axis: elapsedAxis(blank), lines: false }).empty).toMatch(/no values/)
  })
})

describe('disjoint', () => {
  it('sorts ranges by time and cuts overlaps', () => {
    expect(
      disjoint([
        { start: 5, end: 8, id: 'b' },
        { start: 0, end: 6, id: 'a' },
        { start: 1, end: 3, id: 'inside' },
      ]),
    ).toEqual([
      { start: 0, end: 6, id: 'a' },
      { start: 6, end: 8, id: 'b' },
    ])
  })
})

describe('computeFits', () => {
  const ds = linearDataset()
  const axis = elapsedAxis(ds)

  it('fits the samples of each Y channel exactly', () => {
    const data = buildXYData({ ds, ...wsArgs(workspace({ xy: xyConfig({ ys: ['y', 'y2'] }) })), view: null, axis, lines: false })
    const fits = computeFits(data, 'linear')
    expect(fits).toHaveLength(2)
    expect(fits[0].fit?.coeffs[0]).toBeCloseTo(1, 10)
    expect(fits[0].fit?.coeffs[1]).toBeCloseTo(2, 10)
    expect(fits[0].fit?.r2).toBeCloseTo(1, 10)
    expect(fits[1].fit?.n).toBe(9)
    expect(fits[0].curve).toEqual([0, 1, 9, 19])
    expect(computeFits(data, 'none')).toEqual([])
  })

  it('fits through the test-point means per group', () => {
    const ws = workspace({
      points: [
        { id: 't1', name: 'A', groupId: 'g1', start: 0, end: 2 },
        { id: 't2', name: 'B', groupId: 'g1', start: 4, end: 6 },
        { id: 't3', name: 'C', groupId: 'g2', start: 7, end: 9 },
      ],
      xy: xyConfig({ source: 'points', colorBy: 'group', fitTarget: 'means' }),
    })
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis, lines: false })
    const fits = computeFits(data, 'linear')
    expect(fits.map((f) => f.key)).toEqual(['g1|y', 'g2|y'])
    expect(fits[0].fit?.n).toBe(2)
    expect(fits[0].fit?.coeffs[1]).toBeCloseTo(2, 10)
    expect(fits[1].fit).toBeNull()
    expect(fits[1].problem).toMatch(/2 or more test-point means/)
  })

  it('fits only the samples inside the axes it is given, and counts the rest', () => {
    const x = range(12)
    const wild = dataset(
      [channel('x', x, 'α', 'deg'), channel('y', x.map((v) => (v === 11 ? -5e8 : 0.1 * v + 0.2)), 'CL', '')],
      x,
    )
    const data = buildXYData({ ds: wild, ...wsArgs(workspace()), view: null, axis: elapsedAxis(wild), lines: false })
    const all = computeFits(data, 'linear')
    expect(all[0].excluded).toBe(0)
    expect(Math.abs(all[0].fit?.coeffs[1] ?? 0)).toBeGreaterThan(1e6)
    const kept = computeFits(data, 'linear', { x: null, y: [-1, 2] })
    expect(kept[0].excluded).toBe(1)
    expect(kept[0].fit?.n).toBe(11)
    expect(kept[0].fit?.coeffs[1]).toBeCloseTo(0.1, 10)
    expect(kept[0].fit?.coeffs[0]).toBeCloseTo(0.2, 10)
  })

  it('samples curves across the fitted x range', () => {
    const curve = fitCurve({ degree: 2, coeffs: [0, 0, 1], stderr: [], r2: 1, rmse: 0, n: 3, xMin: -1, xMax: 1 })
    expect(curve.length).toBe(96 * 2)
    expect(curve.slice(0, 2)).toEqual([-1, 1])
    expect(curve.slice(-2)).toEqual([1, 1])
  })
})

describe('labels', () => {
  const kias = channel('_Vind,_kias', [1], 'KIAS', 'kt')
  const ktas = channel('Vtrue,_ktas', [1], 'KTAS', 'kt')
  const pitch = channel('pitch,__deg', [1], 'Pitch', 'deg')

  it('names the axes and the title after the channels', () => {
    expect(defaultLabels(kias, [pitch])).toEqual({ title: 'Pitch vs KIAS', x: 'KIAS [kt]', y: 'Pitch [deg]' })
    expect(defaultLabels(pitch, [kias, ktas]).y).toBe('KIAS, KTAS [kt]')
    expect(defaultLabels(kias, [ktas, pitch]).y).toBe('KTAS [kt], Pitch [deg]')
    expect(defaultLabels(null, []).title).toBe('')
  })

  it('prefers the user labels', () => {
    const defaults = defaultLabels(kias, [pitch])
    expect(finalLabels({ title: ' My plot ', xLabel: '', yLabel: 'θ' }, defaults)).toEqual({ title: 'My plot', x: 'KIAS [kt]', y: 'θ' })
  })

  it('warns when the Y channels have different units', () => {
    expect(unitMismatch([kias, ktas])).toBeNull()
    expect(unitMismatch([kias, pitch])).toMatch(/share one axis.*KIAS in kt; Pitch in deg/)
  })
})

describe('the demo flight', () => {
  const text = generateDemoFlight()
  const ds = { ...buildDataset(parseText(text), { name: 'Demo', size: text.length }), id: 'demo' }
  const ws = demoWorkspace(ds)

  it('opens on the elevator-to-trim curve through the five trim-point means', () => {
    const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: timeAxis(ds, ws.timeBase), lines: false })
    expect(data.empty).toBe('')
    expect(data.effective.source).toBe('points')
    expect(data.effective.colorBy).toBe('group')
    expect(data.series).toHaveLength(1)
    expect(data.series[0].name).toBe('Trim points')
    expect(data.means).toHaveLength(5)
    const fits = computeFits(data, ws.xy.fit)
    expect(fits).toHaveLength(1)
    expect(fits[0].target).toBe('means')
    expect(fits[0].fit?.n).toBe(5)
    expect(fits[0].fit?.r2).toBeGreaterThan(0.9)
  })
})
