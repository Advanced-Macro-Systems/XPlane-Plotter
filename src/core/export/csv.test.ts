import { describe, expect, it } from 'vitest'
import { csvField, datasetCsv, pointsTableCsv } from './csv'
import { makeWorkspace, sampleDataset } from './testFixtures'

const lines = (csv: string) => csv.split('\r\n')

describe('csvField', () => {
  it('quotes only fields with the delimiter, a quote or a line break (RFC 4180), doubling quotes', () => {
    expect(csvField('plain text', ',')).toBe('plain text')
    expect(csvField('a,b', ',')).toBe('"a,b"')
    expect(csvField('say "hi"', ',')).toBe('"say ""hi"""')
    expect(csvField('two\nlines', ',')).toBe('"two\nlines"')
    expect(csvField('cr\rhere', ',')).toBe('"cr\rhere"')
    expect(csvField('a,b', '\t')).toBe('a,b')
    expect(csvField('a\tb', '\t')).toBe('"a\tb"')
  })
})

describe('datasetCsv', () => {
  const ds = sampleDataset()

  it('writes two header rows (titles with units, then raw tokens) and CRLF line endings', () => {
    const csv = datasetCsv(ds, { channelIds: ['_Vind,_kias', 'elev1,__deg#2'], ranges: null, includeTime: false, delimiter: ',' })
    const rows = lines(csv)
    expect(rows[0]).toBe('KIAS [kt],elev1 (2) [deg]')
    expect(rows[1]).toBe('"_Vind,_kias","elev1,__deg"')
    expect(rows[2]).toBe('100,-1')
    expect(rows).toHaveLength(2 + ds.rowCount + 1)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('writes NaN as an empty cell and numbers at full (shortest round-trip) precision', () => {
    const csv = datasetCsv(ds, { channelIds: ['_Vind,_kias', 'thrst,_1,lb'], ranges: null, includeTime: false, delimiter: ',' })
    const rows = lines(csv)
    expect(rows[3]).toBe('101,0.2')
    expect(rows[4]).toBe(',0.30000000000000004')
    expect(rows[5]).toBe('103,1e+21')
    expect(rows[6]).toBe('104,0')
    expect(rows[7]).toBe('105,5e-7')
  })

  it('prepends row, elapsed_s and the time source without repeating it', () => {
    const csv = datasetCsv(ds, { channelIds: ['_totl,_time', '_Vind,_kias'], ranges: null, includeTime: true, delimiter: ',' })
    const rows = lines(csv)
    expect(rows[0]).toBe('row,elapsed_s,Sim time [s],KIAS [kt]')
    expect(rows[1]).toBe('row,elapsed_s,"_totl,_time","_Vind,_kias"')
    expect(rows[2]).toBe('0,0,10,100')
    expect(rows[7]).toBe('5,2.5,12.5,105')
  })

  it('shows a formula channel with its expression in the token row', () => {
    const rows = lines(datasetCsv(ds, { channelIds: ['fx:q'], ranges: null, includeTime: false, delimiter: ',' }))
    expect(rows[0]).toBe('q [Pa]')
    expect(rows[1]).toBe('Vind_kias * 2')
    expect(rows[2]).toBe('200')
  })

  it('writes ranges in order with a leading point column, clamped to the file', () => {
    const csv = datasetCsv(ds, {
      channelIds: ['elev1,__deg'],
      ranges: [
        { name: 'Second, "B"', range: [4, 9] },
        { name: 'First', range: [0, 2] },
      ],
      includeTime: true,
      delimiter: ',',
    })
    expect(lines(csv)).toEqual([
      'point,row,elapsed_s,Sim time [s],elev1 [deg]',
      'point,row,elapsed_s,"_totl,_time","elev1,__deg"',
      '"Second, ""B""",4,2,12,5',
      '"Second, ""B""",5,2.5,12.5,6',
      'First,0,0,10,1',
      'First,1,0.5,10.5,2',
      '',
    ])
  })

  it('defuses spreadsheet formulas in text cells but never touches numbers', () => {
    const rows = lines(
      datasetCsv(ds, { channelIds: ['elev1,__deg#2'], ranges: [{ name: '=HYPERLINK("x")', range: [0, 1] }], includeTime: false, delimiter: ',' }),
    )
    expect(rows[2]).toBe(`"'=HYPERLINK(""x"")",-1`)
  })

  it('writes TSV with tabs, ignores unknown ids and repeats, and returns "" without columns', () => {
    const tsv = datasetCsv(ds, { channelIds: ['nope', '_Vind,_kias', '_Vind,_kias'], ranges: null, includeTime: false, delimiter: '\t' })
    expect(lines(tsv)[1]).toBe('_Vind,_kias')
    const wide = datasetCsv(ds, { channelIds: ['_Vind,_kias', 'elev1,__deg'], ranges: null, includeTime: true, delimiter: '\t' })
    expect(lines(wide)[0]).toBe('row\telapsed_s\tSim time [s]\tKIAS [kt]\telev1 [deg]')
    expect(datasetCsv(ds, { channelIds: [], ranges: null, includeTime: false, delimiter: ',' })).toBe('')
  })
})

describe('pointsTableCsv', () => {
  const ds = sampleDataset()
  const ws = makeWorkspace()

  it('has one header row: point, group, times, rows, n, then mean/std/min/max/drift per channel, hidden last', () => {
    const header = lines(pointsTableCsv(ds, ws, ['_Vind,_kias', 'elev1,__deg']))[0]
    expect(header).toBe(
      'point,group,start_s,end_s,duration_s,start_row,end_row,n,' +
        'KIAS [kt] mean,KIAS [kt] std,KIAS [kt] min,KIAS [kt] max,KIAS [kt] drift_per_min,' +
        'elev1 [deg] mean,elev1 [deg] std,elev1 [deg] min,elev1 [deg] max,elev1 [deg] drift_per_min,hidden',
    )
  })

  it('computes the statistics of each point (NaN ignored; drift needs 3 samples)', () => {
    const rows = lines(pointsTableCsv(ds, ws, ['_Vind,_kias', 'elev1,__deg']))
    // Point 1: rows [0, 3) at 0, 0.5, 1 s -> KIAS 100, 101, NaN (2 samples: no drift); elev1 1, 2, 3 (+2 per s).
    expect(rows[1]).toBe(`"Point, ""one""",CG fwd,0,1,1,0,3,3,100.5,${Math.sqrt(0.5)},100,101,,2,1,1,3,120,0`)
    // Point 2: rows [2, 6), hidden -> KIAS NaN, 103, 104, 105; elev1 3..6. The name is defused, not quoted.
    expect(rows[2]).toBe(
      `'=SUM(A1),"CG ""aft"", test",1,2.5,1.5,2,6,4,104,1,103,105,120,4.5,${Math.sqrt(5 / 3)},3,6,120,1`,
    )
    expect(rows[3]).toBe('')
  })

  it('keeps points whose range is outside the file, with empty statistics', () => {
    const outside = makeWorkspace({
      points: [{ id: 'x', name: 'gone', groupId: 'missing', start: 10, end: 20 }],
    })
    const row = lines(pointsTableCsv(ds, outside, ['_Vind,_kias']))[1]
    expect(row).toBe('gone,,,,,6,6,0,,,,,,0')
  })

  it('writes TSV and ignores unknown channel ids', () => {
    const tsv = pointsTableCsv(ds, ws, ['nope'], '\t')
    expect(lines(tsv)[0]).toBe('point\tgroup\tstart_s\tend_s\tduration_s\tstart_row\tend_row\tn\thidden')
    expect(lines(tsv)[1]).toBe('"Point, ""one"""\tCG fwd\t0\t1\t1\t0\t3\t3\t0')
  })
})
