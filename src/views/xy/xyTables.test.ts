import { describe, expect, it } from 'vitest'
import { buildXYData, computeFits } from './xyModel'
import { channel, dataset, elapsedAxis, range, workspace, wsArgs, xyConfig } from './xyFixtures'
import { equationText, fitRows, fitTableTsv, meanRows, meansTableTsv, plainNumber, samplesCsv, textCell } from './xyTables'

function setup() {
  const x = range(10)
  const ds = dataset(
    [
      channel('x', x, 'CL', ''),
      channel('y', x.map((v) => -3 * v + 1.5 + (v % 2 ? 0.01 : -0.01)), 'Elevator', 'deg'),
      channel('w', x.map((v) => v * 10), 'Weight', 'lb'),
    ],
    x.map((v) => v * 0.5),
  )
  const ws = workspace({
    points: [
      { id: 't1', name: '=cmd()', groupId: 'g1', start: 0, end: 3 },
      { id: 't2', name: 'Trim, "B"', groupId: 'g1', start: 4, end: 7 },
      { id: 't3', name: 'C', groupId: 'g2', start: 7, end: 10 },
    ],
    xy: xyConfig({ source: 'points', colorBy: 'group', fitTarget: 'samples', ys: ['y', 'w'] }),
  })
  const data = buildXYData({ ds, ...wsArgs(ws), view: null, axis: elapsedAxis(ds), lines: false })
  return { ds, ws, data }
}

describe('fit rows', () => {
  it('names the equation with the short names and lists slope and intercept', () => {
    const { data } = setup()
    const rows = fitRows(data, computeFits(data, 'linear'))
    expect(rows.map((r) => r.name)).toEqual(['Trim · Elevator', 'Trim · Weight', 'Dynamic · Elevator', 'Dynamic · Weight'])
    const first = rows[0]
    expect(first.equation).toMatch(/^Elevator = −3(\.\d+)?·CL \+ 1\.\d+$/)
    expect(first.yTitle).toBe('Elevator [deg]')
    expect(first.coefficients.map((c) => c.name)).toEqual(['slope', 'intercept'])
    expect(first.coefficients[0].value).toBeCloseTo(-3, 1)
    expect(first.coefficients[0].se).toBeGreaterThan(0)
    expect(first.n).toBe(6)
  })

  it('says whose fit each equation chip is, so colour is not the only clue', () => {
    const { data } = setup()
    const rows = fitRows(data, computeFits(data, 'linear'))
    expect(rows[0].grouped).toBe(true)
    expect(equationText(rows[0], true)).toMatch(/^Trim · Elevator: Elevator = −3/)
    expect(equationText(rows[0], false)).toMatch(/^Elevator = −3/)
    // A channel's fit already starts with the channel; a fit that failed says which one.
    expect(equationText({ name: 'Elevator [deg]', grouped: false, equation: 'Elevator = 2·CL', problem: '' }, true)).toBe('Elevator = 2·CL')
    expect(equationText({ name: 'Dynamic', grouped: true, equation: '', problem: 'Needs 2 or more test-point means.' }, true)).toBe(
      'Dynamic: Needs 2 or more test-point means.',
    )
    expect(equationText({ name: 'Dynamic', grouped: true, equation: '', problem: 'Needs 2 or more test-point means.' }, false)).toBe(
      'Needs 2 or more test-point means.',
    )
  })

  it('names higher-order coefficients by power', () => {
    const { data } = setup()
    const rows = fitRows(data, computeFits(data, 'poly3'))
    expect(rows[0].coefficients.map((c) => c.name)).toEqual(['c₃ (x³)', 'c₂ (x²)', 'c₁ (x)', 'c₀'])
  })

  it('copies as TSV with plain numbers and defused text', () => {
    const { data } = setup()
    const tsv = fitTableTsv(data, fitRows(data, computeFits(data, 'linear')))
    const lines = tsv.split('\r\n')
    expect(lines[0]).toBe('series\tx\ty\tfit\tthrough\tequation\tr2\trmse\tn\tleft_out\tc0\tc0_se\tc1\tc1_se')
    const cells = lines[1].split('\t')
    expect(cells.slice(0, 5)).toEqual(['Trim · Elevator', 'CL', 'Elevator [deg]', 'linear', 'samples'])
    expect(cells[5]).toMatch(/^Elevator = -3/)
    expect(cells[9]).toBe('0')
    expect(Number(cells[12])).toBeCloseTo(-3, 1)
    expect(tsv).not.toContain('−')
    expect(tsv.endsWith('\r\n')).toBe(true)
  })
})

describe('means table', () => {
  it('has one row per point with x and every Y channel', () => {
    const { data } = setup()
    const rows = meanRows(data)
    expect(rows.map((r) => r.point.id)).toEqual(['t1', 't2', 't3'])
    expect(rows[0].x.mean).toBeCloseTo(1)
    expect(rows[0].ys.map((s) => s?.mean)).toEqual([expect.closeTo(-1.5, 1), expect.closeTo(10, 6)])
    const tsv = meansTableTsv(data, rows).split('\r\n')
    expect(tsv[0]).toBe('point\tgroup\trows\tCL mean\tCL sd\tElevator [deg] mean\tElevator [deg] sd\tWeight [lb] mean\tWeight [lb] sd')
    expect(tsv[1].startsWith("'=cmd()\tTrim\t3\t1\t1\t")).toBe(true)
    // A double quote makes the field quoted (RFC 4180), even in TSV.
    expect(tsv[2].startsWith('"Trim, ""B"""\t')).toBe(true)
  })
})

describe('samples CSV', () => {
  it('lists every plotted sample with its point and full-precision values', () => {
    const { ds, data } = setup()
    const csv = samplesCsv(ds, data).split('\r\n')
    expect(csv[0]).toBe('series,y_channel,point,row,elapsed_s,x: CL,y')
    expect(csv[1]).toBe(`Trim · Elevator,Elevator [deg],'=cmd(),0,0,0,${ds.channels[1].values[0]}`)
    expect(csv.filter(Boolean)).toHaveLength(1 + data.sampleCount)
    expect(csv.some((line) => line.includes('"Trim, ""B"""'))).toBe(true)
  })
})

describe('cells', () => {
  it('writes numbers plainly and text safely', () => {
    expect(plainNumber(-0.5)).toBe('-0.5')
    expect(plainNumber(NaN)).toBe('')
    expect(plainNumber(Infinity)).toBe('')
    expect(textCell('−3.0', ',')).toBe("'-3.0")
    expect(textCell('a,b', ',')).toBe('"a,b"')
    expect(textCell('+1', '\t')).toBe("'+1")
  })
})
