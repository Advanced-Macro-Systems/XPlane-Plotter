import { describe, expect, it } from 'vitest'
import { expandRows, formatCitation, notCheckableText } from './cite'
import { PERF_OPEN } from './performance'
import { CHECKLISTS, checkDef, sharedIds } from './registry'

describe('checklist registry', () => {
  it('lists every check once per checklist, each with a title, a reason and at least one source', () => {
    for (const { defs } of Object.values(CHECKLISTS)) {
      expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length)
      for (const d of defs) {
        expect(d.title).not.toBe('')
        expect(d.why.length).toBeGreaterThan(20)
        expect(d.cite.length).toBeGreaterThan(0)
      }
    }
    expect(CHECKLISTS.dynamic.defs).toHaveLength(23)
    expect(CHECKLISTS.static.defs).toHaveLength(24)
    expect(CHECKLISTS.performance.defs).toHaveLength(33)
  })

  it('shares the ids the specs share, with the same meaning in every checklist', () => {
    expect(sharedIds()).toEqual(expect.arrayContaining(['time-base', 'sample-rate', 'throttle-fixed', 'configuration-constant', 'trim-fixed', 'weather', 'envelope']))
    expect(checkDef('static', 'stabilised')?.severity).toBe('advisory')
    expect(checkDef('performance', 'stabilised')?.severity).toBe('advisory')
    expect(checkDef('static', 'near-stall')?.severity).toBe('advisory')
    expect(checkDef('performance', 'near-stall')?.severity).toBe('advisory')
  })

  it('cites what the specs cite and tags the configuration tolerances as engineering judgement', () => {
    const cites = (kind: 'dynamic' | 'static' | 'performance', id: string) => checkDef(kind, id)?.cite ?? []
    expect(cites('dynamic', 'hq-level')).toContain('Cook p.271')
    expect(cites('dynamic', 'trimmed-start')).toEqual(expect.arrayContaining(['FD12b p.37', 'App src/core/analysis/steady.ts']))
    expect(cites('static', 'flight-path')).toContain('App dictionary.ts line 55')
    expect(cites('static', 'wings-level')).toContain('App src/core/analysis/steady.ts line 243')
    expect(cites('static', 'trim-variable')).toEqual(expect.arrayContaining(['App dictionary.ts lines 210, 214, 381', 'App src/views/xy/xyPresets.ts line 38']))
    expect(cites('performance', 'time-base')).toEqual(expect.arrayContaining(['App src/views/modes/modesModel.ts line 111', 'App src/core/channels/groupRows.ts (row 0)']))
    expect(cites('performance', 'weight-column')).toContain('App src/core/channels/guide.ts line 58')
    expect(PERF_OPEN.U1.citations).toContain('NATO AG-300 v14 p.13-7')
    for (const kind of ['dynamic', 'static', 'performance'] as const) expect(checkDef(kind, 'configuration-constant')?.judgement).toBe(true)
    expect(checkDef('static', 'configuration-match')?.judgement).toBe(true)
    expect(checkDef('performance', 'configuration-match')?.judgement).toBe(true)
  })

  it('formats citations in their short form and names the Data Output rows', () => {
    expect(formatCitation('NATO 13-10')).toBe('NATO AG-300 v14 p.13-10')
    expect(formatCitation('B p.7')).toBe('Brief p.7')
    expect(formatCitation('FD10 slide 25')).toBe('FD10 s.25')
    expect(formatCitation('BS slide 20')).toBe('Briefing slides s.20')
    expect(formatCitation('Cook p.47')).toBe('Cook p.47')
    expect(formatCitation('MIL p.40')).toBe('MIL-F-8785C guide p.40')
    expect(formatCitation('EJ')).toBeNull()
    expect(formatCitation('App src/core/analysis/steady.ts line 243')).toBe('App steady.ts')
    expect(expandRows('row {63}')).toBe('row 63 (Weight and balance)')
    expect(expandRows('row {25}')).toBe('row 25* (Throttle (commanded)) (* find by name)')
    expect(notCheckableText('row {152}')).toBe('Not checkable — log row 152 (Aircraft point weather precip/wind)')
    expect(notCheckableText('Needs a fit')).toBe('Needs a fit')
  })
})

describe('declaresModes', () => {
  it('counts a note that names the automatic modes, not the notes the app writes itself', async () => {
    const { declaresModes } = await import('./helpers')
    expect(declaresModes('ALT HOLD + HDG, A/T off')).toBe(true)
    expect(declaresModes('hand-flown, autopilot off')).toBe(true)
    expect(declaresModes('Found steady: KIAS within ± 2 kt, VS within ± 100 fpm, throttle within ± 3 %, at least 20 s.')).toBe(false)
    expect(declaresModes('From times: “300-320” on real time.')).toBe(false)
    expect(declaresModes(undefined)).toBe(false)
  })
})
