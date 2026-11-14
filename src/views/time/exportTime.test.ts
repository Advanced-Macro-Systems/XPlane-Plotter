import { describe, expect, it } from 'vitest'
import { readChartTheme } from '../../charts/theme'
import type { PanelConfig, TestPoint, TimeAxis } from '../../core/types'
import { channel, dataset, range, workspace } from '../xy/xyFixtures'
import { timeFigure } from './exportTime'
import { xFrame } from './timeMath'

type AnyRecord = Record<string, unknown>
const rec = (value: unknown) => value as AnyRecord
const list = (value: unknown) => value as AnyRecord[]

const paper = readChartTheme('paper')

/** 100 rows at 1 s; four channels in knots. */
function stack(panels: PanelConfig[], points: TestPoint[] = []) {
  const t = range(100)
  const ds = dataset(
    ['a', 'b', 'c', 'd'].map((id, i) => channel(id, t.map((v) => v + i), id.toUpperCase(), 'kt')),
    t,
  )
  const axis: TimeAxis = { id: 'elapsed', label: 'Elapsed time', unit: 's', values: ds.elapsed }
  const frame = xFrame(axis)
  return { ds, ws: workspace({ panels, points }), axis, frame, window: [frame.min, frame.max] as const }
}

/** Line colours of the figure's series, panel by panel. */
function lineColours(figure: ReturnType<typeof timeFigure>): string[] {
  return list(rec(figure?.option).series).map((s) => String(rec(s.lineStyle).color))
}

describe('timeFigure', () => {
  it('draws each line in its channel’s colour slot, as on screen', () => {
    const figure = timeFigure(
      stack([
        { id: 'p1', channelIds: ['b', 'c'], slots: [1, 2] },
        { id: 'p2', channelIds: ['a', 'missing', 'd'], slots: [4, 0, 6] },
      ]),
    )
    expect(lineColours(figure)).toEqual([paper.series[1], paper.series[2], paper.series[4], paper.series[6]])
  })

  it('counts by position for panels saved before slots were stored', () => {
    const figure = timeFigure(stack([{ id: 'p1', channelIds: ['a', 'b'] }]))
    expect(lineColours(figure)).toEqual([paper.series[0], paper.series[1]])
  })

  it('makes no figure without a channel to draw', () => {
    expect(timeFigure(stack([{ id: 'p1', channelIds: ['missing'] }]))).toBeNull()
  })

  it('names overlapping and adjacent test points in separate rows instead of on top of each other', () => {
    const point = (id: string, name: string, start: number, end: number): TestPoint => ({ id, name, groupId: 'g1', start, end })
    const figure = timeFigure(
      stack(
        [{ id: 'p1', channelIds: ['a'] }],
        [
          point('t1', 'Trim 250 KIAS', 10, 40),
          point('t2', 'Trim 250 steady', 12, 38),
          point('t3', 'Trim 240 KIAS', 40, 70),
          point('t4', 'Hidden one', 10, 40),
        ].map((p) => (p.id === 't4' ? { ...p, hidden: true } : p)),
      ),
    )
    const areas = list(rec(list(rec(figure?.option).series)[0].markArea).data) as unknown as AnyRecord[][]
    // The hidden point has no band.
    expect(areas).toHaveLength(3)
    const labels = areas.map((pair) => rec(pair[0].label))
    expect(labels.map((l) => l.formatter)).toEqual(['Trim 250 KIAS', 'Trim 250 steady', 'Trim 240 KIAS'])
    // The two names that would print in the same place are a row apart; the next point's name clears both.
    expect(new Set([labels[0].distance, labels[1].distance])).toEqual(new Set([4, 20]))
    expect(labels[2].distance).toBe(4)
  })

  it('lays the names out at the widths its measure gives (the image export measures them as drawn)', () => {
    const fonts = new Set<string>()
    const figure = timeFigure({
      ...stack([{ id: 'p1', channelIds: ['a'] }], [{ id: 't1', name: 'Steady', groupId: 'g1', start: 10, end: 40 }]),
      measureText: (_, font) => {
        fonts.add(font)
        return 30
      },
    })
    expect([...fonts]).toEqual([`${paper.fontSize - 2}px ${paper.font}`])
    const areas = list(rec(list(rec(figure?.option).series)[0].markArea).data) as unknown as AnyRecord[][]
    expect(rec(areas[0][0].label)).toMatchObject({ show: true, width: 38 })
  })
})
