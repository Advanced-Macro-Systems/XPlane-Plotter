import { describe, expect, it } from 'vitest'
import type { Workspace } from '../core/types'
import {
  codeSegments,
  compactSpan,
  datasetSummary,
  dragHasFiles,
  fadeEdges,
  fileStem,
  isChunkLoadError,
  formatBytes,
  formatCount,
  isSessionFileName,
  isTypingTarget,
  loadingText,
  matlabPartName,
  matlabSavedText,
  modeRowsFor,
  plural,
  recentSummary,
  recentWhen,
  scrollToReveal,
  shortcutFor,
  splitRangeText,
  tabForKey,
  TAB_ORDER,
  type KeyLike,
} from './shellModel'

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: { tagName: 'BODY' },
  ...extra,
})

describe('tabForKey', () => {
  it('maps 1–6 to the tabs in tab-bar order', () => {
    expect(TAB_ORDER.map((_, i) => tabForKey(String(i + 1)))).toEqual([...TAB_ORDER])
  })
  it('ignores other keys', () => {
    for (const k of ['0', '7', '9', 'a', '', '12', 'F1']) expect(tabForKey(k)).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('is true for text fields, text areas, selects and editable content', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTypingTarget({ tagName: 'input', type: 'search' })).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
  it('is false for buttons, checkboxes and the page', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget('INPUT')).toBe(false)
  })
})

describe('shortcutFor', () => {
  const ctx = { hasDataset: true, dialogOpen: false }

  it('switches tabs with 1–6 when a file is open', () => {
    expect(shortcutFor(key('3'), ctx)).toEqual({ kind: 'tab', tab: 'xy' })
    expect(shortcutFor(key('3'), { ...ctx, hasDataset: false })).toBeNull()
  })
  it('never switches while typing, in a dialog or with a modifier', () => {
    expect(shortcutFor(key('2', { target: { tagName: 'INPUT', type: 'text' } }), ctx)).toBeNull()
    expect(shortcutFor(key('2'), { ...ctx, dialogOpen: true })).toBeNull()
    expect(shortcutFor(key('2', { ctrlKey: true }), ctx)).toBeNull()
    expect(shortcutFor(key('2', { altKey: true }), ctx)).toBeNull()
    expect(shortcutFor(key('2', { defaultPrevented: true }), ctx)).toBeNull()
    expect(shortcutFor(key('2', { isComposing: true }), ctx)).toBeNull()
  })
  it('opens the picker with Ctrl+O or Cmd+O, even while typing', () => {
    expect(shortcutFor(key('o', { ctrlKey: true }), ctx)).toEqual({ kind: 'open' })
    expect(shortcutFor(key('O', { metaKey: true }), { hasDataset: false, dialogOpen: false })).toEqual({ kind: 'open' })
    expect(shortcutFor(key('o', { ctrlKey: true, target: { tagName: 'INPUT' } }), ctx)).toEqual({ kind: 'open' })
    // Ctrl+Shift+O is the browser's bookmarks manager: leave it alone.
    expect(shortcutFor(key('O', { ctrlKey: true, shiftKey: true }), ctx)).toBeNull()
    expect(shortcutFor(key('o'), ctx)).toBeNull()
  })
  it('opens the help with ?', () => {
    expect(shortcutFor(key('?', { shiftKey: true }), ctx)).toEqual({ kind: 'help' })
    expect(shortcutFor(key('?', { shiftKey: true }), { hasDataset: false, dialogOpen: false })).toEqual({ kind: 'help' })
    expect(shortcutFor(key('?', { target: { tagName: 'TEXTAREA' } }), ctx)).toBeNull()
  })
})

describe('text helpers', () => {
  it('groups thousands and pluralises', () => {
    expect(formatCount(12345)).toBe('12,345')
    expect(formatCount(Number.NaN)).toBe('—')
    expect(plural(1, 'row')).toBe('1 row')
    expect(plural(12345, 'row')).toBe('12,345 rows')
    expect(plural(2, 'test point')).toBe('2 test points')
    expect(plural(0, 'reset')).toBe('0 resets')
  })

  it('formats sizes in decimal units', () => {
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(45_210)).toBe('45.2 kB')
    expect(formatBytes(12_345_678)).toBe('12.3 MB')
    expect(formatBytes(999_700)).toBe('1 MB')
    expect(formatBytes(1_250_000_000)).toBe('1.25 GB')
    expect(formatBytes(-1)).toBe('—')
  })

  it('summarises a dataset for the switcher', () => {
    expect(datasetSummary({ rowCount: 12345, channels: new Array(173) })).toBe('12,345 rows · 173 ch')
  })

  it('describes the loading phase', () => {
    expect(loadingText({ phase: 'reading', progress: 0.423 }, false)).toBe('Reading… 42%')
    expect(loadingText({ phase: 'reading', progress: 1.2 }, false)).toBe('Reading… 100%')
    expect(loadingText({ phase: 'reading', progress: Number.NaN }, false)).toBe('Reading… 0%')
    expect(loadingText({ phase: 'building', progress: 1 }, false)).toBe('Building channels…')
    expect(loadingText({ phase: 'building', progress: 1 }, true)).toBe('Generating the demo flight…')
  })

  it('splits rangeText into span and duration', () => {
    expect(splitRangeText('120.0 s – 340.5 s · 220.5 s')).toEqual({ span: '120.0 s – 340.5 s', duration: '220.5 s' })
    expect(splitRangeText('no duration')).toEqual({ span: 'no duration', duration: '' })
  })

  it('compacts a span with one unit', () => {
    expect(compactSpan('120.0 s – 340.5 s')).toBe('120.0 – 340.5 s')
    expect(compactSpan('0.512 h – 0.630 h')).toBe('0.512 – 0.630 h')
    expect(compactSpan('row 10 – row 99')).toBe('rows 10–99')
    expect(compactSpan('09:15:15 – 09:20:00')).toBe('09:15:15 – 09:20:00')
    expect(compactSpan('12.5 s – 1.20 min')).toBe('12.5 s – 1.20 min')
  })

  it('says when a recent file was saved', () => {
    const now = new Date(2026, 10, 14, 15, 30)
    expect(recentWhen(new Date(2026, 10, 14, 14, 2).toISOString(), now)).toBe('Today, 14:02')
    expect(recentWhen(new Date(2026, 10, 13, 9, 15).toISOString(), now)).toBe('Yesterday, 09:15')
    expect(recentWhen(new Date(2026, 10, 2, 9, 15).toISOString(), now)).toBe('2 Nov 2026')
    expect(recentWhen('not a date', now)).toBe('')
  })

  it('summarises a recent file', () => {
    expect(recentSummary({ rows: 12345, points: 5 })).toBe('12,345 rows · 5 test points')
    expect(recentSummary({ rows: 100, points: 1 })).toBe('100 rows · 1 test point')
    expect(recentSummary({ rows: 4012, points: 0 })).toBe('4,012 rows · no test points')
    expect(recentSummary({ rows: Number.NaN, points: 2 })).toBe('2 test points')
    expect(recentSummary({ rows: Number.NaN, points: Number.NaN })).toBe('')
  })

  it('recognises file drags and session files', () => {
    expect(dragHasFiles(['Files'])).toBe(true)
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true)
    expect(dragHasFiles(['text/plain'])).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
    expect(isSessionFileName('Data_737.xpp-session.json')).toBe(true)
    expect(isSessionFileName('SESSION.JSON ')).toBe(true)
    expect(isSessionFileName('Data.txt')).toBe(false)
  })

  it('splits backtick code spans out of guide text', () => {
    expect(codeSegments('Sim time `_totl,_time` is the time axis')).toEqual([
      { text: 'Sim time ', code: false },
      { text: '_totl,_time', code: true },
      { text: ' is the time axis', code: false },
    ])
    expect(codeSegments('`total,___lb`, never `gross,___lb`.')).toEqual([
      { text: 'total,___lb', code: true },
      { text: ', never ', code: false },
      { text: 'gross,___lb', code: true },
      { text: '.', code: false },
    ])
    expect(codeSegments('plain')).toEqual([{ text: 'plain', code: false }])
    expect(codeSegments('one ` stray')).toEqual([{ text: 'one ` stray', code: false }])
    expect(codeSegments('')).toEqual([])
  })

  it('recognises a view whose code could not be downloaded', () => {
    expect(isChunkLoadError('Failed to fetch dynamically imported module: https://x.github.io/assets/TimeView-1a2b.js')).toBe(true)
    expect(isChunkLoadError('error loading dynamically imported module: https://x/assets/a.js')).toBe(true)
    expect(isChunkLoadError('Importing a module script failed.')).toBe(true)
    expect(isChunkLoadError("Cannot read properties of undefined (reading 'values')")).toBe(false)
  })

  it('strips the extension of a file name', () => {
    expect(fileStem('Data 737.txt')).toBe('Data 737')
    expect(fileStem('Demo flight (synthetic).txt')).toBe('Demo flight (synthetic)')
    expect(fileStem('README')).toBe('README')
    expect(fileStem('.txt')).toBe('.txt')
  })
})

describe('sideways-scrolling tab strip', () => {
  it('fades the edges that hide tabs', () => {
    expect(fadeEdges(0, 400, 400)).toBeNull()
    expect(fadeEdges(0, 400, 700)).toBe('right')
    expect(fadeEdges(150, 400, 700)).toBe('both')
    expect(fadeEdges(300, 400, 700)).toBe('left')
    // Fractional scroll positions on zoomed pages.
    expect(fadeEdges(299.5, 400, 700)).toBe('left')
    expect(fadeEdges(0.5, 400, 700)).toBe('right')
  })

  it('scrolls just enough to show the open tab, with room for the fade', () => {
    // In sight: nothing to do.
    expect(scrollToReveal(100, 80, 0, 400, 40)).toBeNull()
    // Off the right edge: its right side ends 40 px inside the view.
    expect(scrollToReveal(500, 100, 0, 400, 40)).toBe(240)
    // Off the left edge: its left side starts 40 px inside the view, never before 0.
    expect(scrollToReveal(200, 100, 300, 400, 40)).toBe(160)
    expect(scrollToReveal(10, 100, 300, 400, 40)).toBe(0)
    // A tab wider than the room left for margins: centred as well as it can be.
    expect(scrollToReveal(500, 380, 0, 400, 40)).toBe(490)
  })
})

describe('modeRowsFor', () => {
  const ws: Pick<Workspace, 'modes' | 'points'> = {
    modes: { channelId: 'a', source: 'selection', model: 'oscillation', detrend: 'linear' },
    points: [{ id: 't1', name: 'Phugoid', groupId: 'g1', start: 100, end: 400 }],
  }

  it('uses the selection, the zoom range or the analysed test point', () => {
    expect(modeRowsFor(ws, [5, 10], [0, 50])).toEqual([5, 10])
    expect(modeRowsFor({ ...ws, modes: { ...ws.modes, source: 'view' } }, [5, 10], [0, 50])).toEqual([0, 50])
    expect(modeRowsFor({ ...ws, modes: { ...ws.modes, source: 'point:t1' } }, null, null)).toEqual([100, 400])
  })
  it('is null when that window does not exist', () => {
    expect(modeRowsFor(ws, null, [0, 50])).toBeNull()
    expect(modeRowsFor({ ...ws, modes: { ...ws.modes, source: 'point:gone' } }, [1, 2], null)).toBeNull()
  })
})

describe('MATLAB script names', () => {
  it('names a one-plot script after its part and keeps the plain name for the whole workspace', () => {
    expect(matlabPartName('xpp_Data_run1.m', null)).toBe('xpp_Data_run1.m')
    expect(matlabPartName('xpp_Data_run1.m', 'time')).toBe('xpp_Data_run1_time.m')
    expect(matlabPartName('xpp_Data_run1.m', 'xy')).toBe('xpp_Data_run1_xy.m')
    expect(matlabPartName('xpp_Data_run1.m', 'modes')).toBe('xpp_Data_run1_modes.m')
  })

  it('stays a name MATLAB can run (at most 63 characters before .m)', () => {
    const whole = `xpp_${'a'.repeat(55)}_b_c.m` // 63 characters before .m
    const part = matlabPartName(whole, 'modes')
    expect(part).toMatch(/^xpp_a+_modes\.m$/)
    expect(part.length - 2).toBeLessThanOrEqual(63)
    expect(matlabPartName(`xpp_${'a'.repeat(56)}__x.m`, 'xy')).not.toMatch(/__xy/)
  })

  it('confirms every export the same way, naming what the script holds', () => {
    expect(matlabSavedText('xpp_Data_xy.m', 'xy', 'Data.txt')).toBe(
      'Saved xpp_Data_xy.m (test-point table and X–Y plot). Put it next to Data.txt and run it in MATLAB: figures and tables go to ./out/.',
    )
    expect(matlabSavedText('xpp_Data.m', null, 'Data.txt')).toMatch(/^Saved xpp_Data\.m \(test-point table, X–Y plot, time histories and mode fit\)/)
  })
})
