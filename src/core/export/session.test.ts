import { describe, expect, it } from 'vitest'
import type { Workspace } from '../types'
import {
  MAX_SESSION_BYTES,
  parseSession,
  serializeSession,
  SESSION_APP,
  SESSION_LIMITS,
  SESSION_VERSION,
  sessionFileName,
} from './session'
import { makeWorkspace, sampleDataset } from './testFixtures'

const ds = sampleDataset()

/** A valid session as a plain object, to break in the error tests. */
function sessionObject(): Record<string, unknown> {
  return JSON.parse(serializeSession(ds, makeWorkspace())) as Record<string, unknown>
}

function workspaceOf(file: Record<string, unknown>): Record<string, unknown> {
  return file.workspace as Record<string, unknown>
}

describe('serializeSession / parseSession', () => {
  it('round-trips the workspace and records the dataset it belongs to', () => {
    const ws: Workspace = makeWorkspace({
      timeBase: 'ch:_totl,_time',
      panels: [
        { id: 'p1', channelIds: ['_Vind,_kias', 'fx:q'], yZero: true },
        { id: 'p2', channelIds: [] },
      ],
      points: [
        { id: 't1', name: 'Steady 250', groupId: 'g1', start: 0, end: 3, note: 'trim set "2.5 deg"' },
        { id: 't2', name: 'Hidden', groupId: 'g2', start: 3, end: 6, hidden: true },
      ],
      modes: { channelId: null, source: 'point:t1', model: 'first-order', detrend: 'none' },
    })
    ws.xy = { ...ws.xy, groups: ['g2'] }
    const text = serializeSession(ds, ws)
    const file = parseSession(text)
    expect(file.app).toBe(SESSION_APP)
    expect(file.version).toBe(SESSION_VERSION)
    expect(new Date(file.savedAt).toISOString()).toBe(file.savedAt)
    expect(file.dataset).toEqual({ name: 'Data.txt', signature: 'abc12345', rowCount: 6 })
    expect(file.workspace).toEqual(ws)
  })

  it('names the file after the log: its stem, made safe, then .xpp-session.json', () => {
    expect(sessionFileName('Data_run1.txt')).toBe('Data_run1.xpp-session.json')
    expect(sessionFileName('Flight 2 / CG aft.csv')).toBe('Flight_2_CG_aft.xpp-session.json')
    expect(sessionFileName('Demo flight (synthetic)')).toBe('Demo_flight_synthetic.xpp-session.json')
    expect(sessionFileName('')).toBe('session.xpp-session.json')
  })

  it('is readable JSON without the flight data', () => {
    const text = serializeSession(ds, makeWorkspace())
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "workspace": {')
    expect(text).not.toContain('"values"')
    expect(text).not.toContain('"channels"')
    expect(text).not.toContain('100')
  })

  it('drops unknown properties and false/empty optional flags, and accepts a byte-order mark', () => {
    const file = sessionObject()
    file.extra = 'ignored'
    const ws = workspaceOf(file)
    ws.someFutureSetting = 42
    ;(ws.points as Record<string, unknown>[])[0].hidden = false
    ;(ws.points as Record<string, unknown>[])[0].note = ''
    ;(ws.panels as Record<string, unknown>[])[0].yZero = false
    const parsed = parseSession(String.fromCharCode(0xfeff) + JSON.stringify(file))
    expect(parsed).not.toHaveProperty('extra')
    expect(parsed.workspace).not.toHaveProperty('someFutureSetting')
    expect(parsed.workspace.points[0]).toEqual({ id: 't1', name: 'Point, "one"', groupId: 'g1', start: 0, end: 3 })
    expect(parsed.workspace.panels[0]).toEqual({ id: 'p1', channelIds: ['_Vind,_kias'] })
  })
})

describe('parseSession errors', () => {
  const fails = (text: string) => () => parseSession(text)

  it('rejects anything that is not a session file with a readable message', () => {
    expect(fails('')).toThrow('This is not an X-Plane Plotter session file: it is empty.')
    expect(fails('{ nope')).toThrow('This is not an X-Plane Plotter session file: it is not valid JSON.')
    expect(fails('[1, 2]')).toThrow('This is not an X-Plane Plotter session file.')
    expect(fails('{"app": "something-else", "version": 1}')).toThrow('This is not an X-Plane Plotter session file.')
    expect(fails('null')).toThrow('This is not an X-Plane Plotter session file.')
  })

  it('recognises a flight log opened by mistake', () => {
    const log = '\n   _real,_time |   _totl,_time |   _Vind,_kias | \n      0.00000 |      0.00000 |    100.00000 | \n'
    expect(fails(log)).toThrow(/looks like a flight log/)
  })

  it('says when a newer version of the app saved the file', () => {
    const file = sessionObject()
    file.version = 2
    expect(fails(JSON.stringify(file))).toThrow(/saved by a newer version of X-Plane Plotter \(format 2/)
    const inner = sessionObject()
    workspaceOf(inner).version = 3
    expect(fails(JSON.stringify(inner))).toThrow(/newer version/)
    const odd = sessionObject()
    odd.version = 'one'
    expect(fails(JSON.stringify(odd))).toThrow(/format version \("one"\) is not supported/)
  })

  it('names the damaged field', () => {
    const cases: [(file: Record<string, unknown>) => void, RegExp][] = [
      [(f) => delete f.workspace, /workspace is missing/],
      [(f) => (f.dataset = 'x'), /dataset must be an object/],
      [(f) => ((f.dataset as Record<string, unknown>).rowCount = -1), /dataset\.rowCount must be a whole number/],
      [(f) => (f.savedAt = 5), /savedAt must be text/],
      [(f) => (workspaceOf(f).points = {}), /workspace\.points must be a list/],
      [(f) => ((workspaceOf(f).points as Record<string, unknown>[])[1].end = 2), /workspace\.points\[1\]\.end must be greater than start/],
      [(f) => ((workspaceOf(f).points as Record<string, unknown>[])[0].start = 1.5), /workspace\.points\[0\]\.start must be a whole number/],
      [(f) => ((workspaceOf(f).points as Record<string, unknown>[])[0].hidden = 'yes'), /workspace\.points\[0\]\.hidden must be true or false/],
      [(f) => ((workspaceOf(f).groups as Record<string, unknown>[])[0].slot = 8), /workspace\.groups\[0\]\.slot must be a colour slot/],
      [(f) => ((workspaceOf(f).panels as Record<string, unknown>[])[0].channelIds = ['a', 3]), /workspace\.panels\[0\]\.channelIds\[1\] must be text/],
      [(f) => ((workspaceOf(f).derived as Record<string, unknown>[])[0].id = 'q'), /workspace\.derived\[0\]\.id must start with "fx:"/],
      [(f) => ((workspaceOf(f).xy as Record<string, unknown>).fit = 'poly9'), /workspace\.xy\.fit must be one of "none", "linear", "poly2", "poly3"/],
      [(f) => ((workspaceOf(f).xy as Record<string, unknown>).x = 7), /workspace\.xy\.x must be a channel id or null/],
      [(f) => ((workspaceOf(f).modes as Record<string, unknown>).source = 'somewhere'), /workspace\.modes\.source must be/],
      [(f) => (workspaceOf(f).timeBase = 'ch:'), /workspace\.timeBase must be/],
      [(f) => (workspaceOf(f).tracked = 'KIAS'), /workspace\.tracked must be a list/],
    ]
    for (const [breakIt, message] of cases) {
      const file = sessionObject()
      breakIt(file)
      expect(fails(JSON.stringify(file)), String(message)).toThrow(message)
    }
  })

  it('prefixes damaged-file messages so the user knows what happened', () => {
    const file = sessionObject()
    workspaceOf(file).groups = 'none'
    expect(fails(JSON.stringify(file))).toThrow(/^This session file is damaged or was edited by hand: workspace\.groups/)
  })

  it('refuses sessions with more items than the app can show without freezing, saying how many', () => {
    const point = (i: number) => ({ id: `t${i}`, name: `P${i}`, groupId: 'g1', start: 0, end: 1 })
    const atLimit = sessionObject()
    workspaceOf(atLimit).points = Array.from({ length: SESSION_LIMITS.points }, (_, i) => point(i))
    expect(parseSession(JSON.stringify(atLimit)).workspace.points).toHaveLength(SESSION_LIMITS.points)
    const tooMany = sessionObject()
    workspaceOf(tooMany).points = Array.from({ length: 20000 }, (_, i) => point(i))
    expect(fails(JSON.stringify(tooMany))).toThrow('This session has 20,000 test points; X-Plane Plotter reads at most 2,000.')
    const panels = sessionObject()
    workspaceOf(panels).panels = Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, channelIds: [] }))
    expect(fails(JSON.stringify(panels))).toThrow(/101 plot panels; X-Plane Plotter reads at most 100/)
    const formulas = sessionObject()
    workspaceOf(formulas).derived = Array.from({ length: 501 }, (_, i) => ({ id: `fx:f${i}`, name: 'f', unit: '', expression: '1' }))
    expect(fails(JSON.stringify(formulas))).toThrow(/501 formulas/)
    const groups = sessionObject()
    workspaceOf(groups).groups = Array.from({ length: 201 }, (_, i) => ({ id: `g${i}`, name: 'g', slot: 0 }))
    expect(fails(JSON.stringify(groups))).toThrow(/201 test-point groups/)
  })

  it('turns away a file too large to be a session, also by its size alone', () => {
    expect(fails(`{"app":"xplane-plotter","pad":"${'x'.repeat(5_000_001)}"}`)).toThrow(/far too large/)
    // Whatever the encoding (at most 3 UTF-8 bytes per character), a file over MAX_SESSION_BYTES is too long.
    expect(MAX_SESSION_BYTES).toBe(15_000_000)
  })
})
