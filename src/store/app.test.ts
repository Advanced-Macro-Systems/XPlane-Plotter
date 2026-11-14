import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDataset } from '../core/buildDataset'
import { parseText } from '../core/parse'
import { xplaneText } from '../core/parse/fixtures'
import {
  addGroup,
  addPanel,
  closeDataset,
  dismissToast,
  getWorkspace,
  holdToast,
  latestUndoToast,
  openFiles,
  readRecent,
  runToastAction,
  saveDerived,
  setActive,
  setModes,
  setPanels,
  setTab,
  setTracked,
  setXY,
  toast,
  toastLifetime,
  updatePanel,
  useApp,
} from './app'
import { MAX_GROUPS } from './defaults'

const shown = () => useApp.getState().toasts.map((t) => t.message)

/** localStorage stand-in with an optional quota (characters of keys + values), like a browser's. */
class MemoryStorage {
  private data = new Map<string, string>()
  quota = Number.POSITIVE_INFINITY
  get length(): number {
    return this.data.size
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    let used = 0
    for (const [k, v] of this.data) if (k !== key) used += k.length + v.length
    if (used + key.length + String(value).length > this.quota) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    this.data.set(key, String(value))
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  keys(): string[] {
    return [...this.data.keys()]
  }
}

/** A small synthetic X-Plane log; `reset` adds a sim reset (time going back) halfway. */
function logText(rows = 40, reset = false): string {
  const data = Array.from({ length: rows }, (_, i) => {
    const t = reset && i >= rows / 2 ? (i - rows / 2) * 0.1 : i * 0.1
    return [t, 120 + i, 3000 + 2 * i]
  })
  return xplaneText(['_totl,_time', '_Vind,_kias', 'p-alt,ftMSL'], data)
}

const signatureOf = (text: string) => buildDataset(parseText(text), { name: 'x', size: text.length }).signature
const fileOf = (text: string, name = 'Synth_run.txt') => new File([text], name, { type: 'text/plain' })
/** Waits past the 400 ms debounce of the workspace save. */
const saved = () => new Promise((resolve) => setTimeout(resolve, 450))

function resetStore(): void {
  for (const t of useApp.getState().toasts) dismissToast(t.id)
  useApp.setState({ datasets: [], activeId: null, workspaces: {}, tab: 'overview', view: null, selection: null, saveFailed: false })
}

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    for (const t of useApp.getState().toasts) dismissToast(t.id)
    vi.useRealTimers()
  })

  it('keeps a toast that offers an action for 20 s, long enough to reach it by keyboard', () => {
    expect(toastLifetime('info', true)).toBe(20000)
    expect(toastLifetime('error', false)).toBe(9000)
    expect(toastLifetime('info', false)).toBe(4500)
    toast('Deleted test point “A”.', 'info', { label: 'Undo', run: () => {} })
    toast('Saved.', 'success')
    vi.advanceTimersByTime(4600)
    expect(shown()).toEqual(['Deleted test point “A”.'])
    vi.advanceTimersByTime(15300)
    expect(shown()).toEqual(['Deleted test point “A”.'])
    vi.advanceTimersByTime(200)
    expect(shown()).toEqual([])
  })

  it('stops a toast’s time while the pointer or focus holds it, then gives it at least 4 s more', () => {
    toast('Removed the panel.', 'info', { label: 'Undo', run: () => {} })
    const id = useApp.getState().toasts[0].id
    vi.advanceTimersByTime(19000)
    holdToast(id, 'pointer', true)
    holdToast(id, 'focus', true)
    vi.advanceTimersByTime(60000)
    expect(shown()).toHaveLength(1)
    // The pointer leaves, focus stays: still held.
    holdToast(id, 'pointer', false)
    vi.advanceTimersByTime(60000)
    expect(shown()).toHaveLength(1)
    holdToast(id, 'focus', false)
    vi.advanceTimersByTime(3900)
    expect(shown()).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(shown()).toHaveLength(0)
  })

  it('resumes with the time it had left when that is longer', () => {
    toast('Removed the panel.', 'info', { label: 'Undo', run: () => {} })
    const id = useApp.getState().toasts[0].id
    vi.advanceTimersByTime(5000)
    holdToast(id, 'pointer', true)
    vi.advanceTimersByTime(30000)
    holdToast(id, 'pointer', false)
    vi.advanceTimersByTime(14900)
    expect(shown()).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(shown()).toHaveLength(0)
  })

  it('runs an action once and closes its toast; Ctrl/Cmd+Z finds the newest Undo', () => {
    const undone: string[] = []
    toast('Deleted “A”.', 'info', { label: 'Undo', run: () => undone.push('A') })
    toast('Restored your workspace.', 'success', { label: 'Start fresh', run: () => undone.push('fresh') })
    toast('Deleted “B”.', 'info', { label: 'Undo', run: () => undone.push('B') })
    toast('Saved.', 'success')
    expect(latestUndoToast()?.message).toBe('Deleted “B”.')
    runToastAction(latestUndoToast()!.id)
    expect(undone).toEqual(['B'])
    expect(latestUndoToast()?.message).toBe('Deleted “A”.')
    runToastAction(latestUndoToast()!.id)
    expect(undone).toEqual(['B', 'A'])
    expect(latestUndoToast()).toBeNull()
    expect(shown()).toEqual(['Restored your workspace.', 'Saved.'])
  })

  it('shows at most four toasts: a new one pushes out the oldest', () => {
    for (const n of [1, 2, 3, 4, 5]) toast(`Message ${n}`, 'info', { label: 'Undo', run: () => {} })
    expect(shown()).toEqual(['Message 2', 'Message 3', 'Message 4', 'Message 5'])
    // The pushed-out toast's timer is gone too: holding it does nothing, and nothing comes back.
    vi.advanceTimersByTime(20100)
    expect(shown()).toEqual([])
  })
})

describe('the recent-file list', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps only well-formed entries, so a damaged list can never break the start page', () => {
    storage.setItem(
      'xpp:recent',
      JSON.stringify([
        { signature: 's1', name: { evil: 1 }, rows: 5, points: 1, savedAt: '2026-11-01T10:00:00Z' },
        null,
        7,
        'text',
        [],
        { name: 'no signature.txt', rows: 1, points: 0, savedAt: '' },
        { signature: 's2', name: 'Flight A.txt', rows: '5', points: -1, savedAt: 42 },
        { signature: 's2', name: 'listed twice.txt', rows: 1, points: 1, savedAt: '' },
        { signature: 's3', name: 'x'.repeat(1000), rows: 10, points: 0, savedAt: '2026-11-01T10:00:00Z' },
      ]),
    )
    expect(readRecent()).toEqual([
      { signature: 's2', name: 'Flight A.txt', rows: Number.NaN, points: Number.NaN, savedAt: '' },
      { signature: 's3', name: 'x'.repeat(260), rows: 10, points: 0, savedAt: '2026-11-01T10:00:00Z' },
    ])
  })

  it('reads junk that is not a list as an empty list, and lists at most 8 files', () => {
    storage.setItem('xpp:recent', '{"signature":"s1"}')
    expect(readRecent()).toEqual([])
    storage.setItem('xpp:recent', 'not json')
    expect(readRecent()).toEqual([])
    const many = Array.from({ length: 12 }, (_, i) => ({ signature: `s${i}`, name: `f${i}.txt`, rows: 1, points: 0, savedAt: '' }))
    storage.setItem('xpp:recent', JSON.stringify(many))
    expect(readRecent().map((r) => r.signature)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])
  })
})

describe('saving workspaces in the browser', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    resetStore()
  })
  afterEach(() => {
    resetStore()
    vi.unstubAllGlobals()
  })

  it('warns once, and keeps a lasting flag, when the browser cannot save; a later save that works clears it', async () => {
    storage.quota = 200
    await openFiles([fileOf(logText())])
    await saved()
    expect(useApp.getState().saveFailed).toBe(true)
    const warning = useApp.getState().toasts.find((t) => t.kind === 'error')
    expect(warning?.message).toMatch(/could not save your workspace/)
    expect(warning?.action?.label).toBe('Save session')
    // Once per page load: another failed save adds no second warning.
    setTracked(['_Vind,_kias'])
    await saved()
    expect(useApp.getState().toasts.filter((t) => t.kind === 'error')).toHaveLength(1)
    storage.quota = Number.POSITIVE_INFINITY
    setTracked(['p-alt,ftMSL'])
    await saved()
    expect(useApp.getState().saveFailed).toBe(false)
    expect(readRecent()).toHaveLength(1)
  })

  it('makes room by removing saved workspaces of files no longer listed, then saves', async () => {
    const text = logText()
    const listed = { signature: 'listed', name: 'kept.txt', rows: 10, points: 2, savedAt: '' }
    storage.setItem('xpp:recent', JSON.stringify([listed]))
    storage.setItem('xpp:ws:listed', 'x'.repeat(300))
    for (let i = 0; i < 5; i += 1) storage.setItem(`xpp:ws:orphan${i}`, 'x'.repeat(300))
    storage.setItem('other-app:key', 'x'.repeat(300))
    storage.quota = 2700
    await openFiles([fileOf(text)])
    await saved()
    expect(useApp.getState().saveFailed).toBe(false)
    expect(storage.keys().filter((k) => k.startsWith('xpp:ws:orphan'))).toEqual([])
    expect(storage.getItem('xpp:ws:listed')).not.toBeNull()
    expect(storage.getItem('other-app:key')).not.toBeNull()
    expect(storage.getItem(`xpp:ws:${signatureOf(text)}`)).not.toBeNull()
    expect(readRecent().map((r) => r.name)).toEqual(['Synth_run.txt', 'kept.txt'])
  })
})

describe('restoring a saved workspace', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    resetStore()
  })
  afterEach(() => {
    resetStore()
    vi.unstubAllGlobals()
  })

  it('drops damaged formulas before evaluating them, and keeps the rest of the workspace', async () => {
    const text = logText()
    const base = { version: 1, points: [{ id: 't1', name: 'Steady', groupId: 'g1', start: 2, end: 9 }] }
    storage.setItem(
      `xpp:ws:${signatureOf(text)}`,
      JSON.stringify({
        ...base,
        derived: [
          null,
          { id: 'fx:a', name: { a: 1 }, unit: '', expression: '1' },
          { id: 'fx:b', name: 'Doubled', unit: { u: 1 }, expression: 'Vind_kias * 2' },
        ],
      }),
    )
    await openFiles([fileOf(text)])
    const { datasets, toasts } = useApp.getState()
    expect(datasets).toHaveLength(1)
    expect(getWorkspace()?.points.map((p) => p.name)).toEqual(['Steady'])
    expect(getWorkspace()?.derived).toEqual([{ id: 'fx:b', name: 'Doubled', unit: '', expression: 'Vind_kias * 2' }])
    const doubled = datasets[0].channels.find((c) => c.id === 'fx:b')
    expect(doubled?.meta.unit).toBe('')
    expect(doubled?.values[0]).toBe(240)
    expect(toasts.map((t) => t.message).join(' ')).toMatch(/Restored your workspace/)
  })

  it('starts fresh from the restore message: the default workspace, without formulas', async () => {
    const text = logText()
    storage.setItem(
      `xpp:ws:${signatureOf(text)}`,
      JSON.stringify({
        version: 1,
        points: [{ id: 't1', name: 'Steady', groupId: 'g1', start: 2, end: 9 }],
        derived: [{ id: 'fx:b', name: 'Doubled', unit: '', expression: 'Vind_kias * 2' }],
      }),
    )
    await openFiles([fileOf(text)])
    expect(getWorkspace()?.points).toHaveLength(1)
    const restore = useApp.getState().toasts.find((t) => t.action?.label === 'Start fresh')
    expect(restore).toBeDefined()
    runToastAction(restore?.id ?? -1)
    expect(getWorkspace()?.points).toEqual([])
    expect(getWorkspace()?.derived).toEqual([])
    expect(useApp.getState().datasets[0].channels.some((c) => c.id === 'fx:b')).toBe(false)
  })

  it('never starts a file fresh once another file is on screen: its Start fresh closes with it', async () => {
    const text = logText()
    const key = `xpp:ws:${signatureOf(text)}`
    const points = [
      { id: 't1', name: 'Steady 1', groupId: 'g1', start: 2, end: 9 },
      { id: 't2', name: 'Steady 2', groupId: 'g1', start: 12, end: 19 },
    ]
    storage.setItem(key, JSON.stringify({ version: 1, points }))
    await openFiles([fileOf(text, 'First.txt')])
    const first = useApp.getState().activeId!
    const restore = useApp.getState().toasts.find((t) => t.action?.label === 'Start fresh')!
    expect(restore.action?.datasetId).toBe(first)

    await openFiles([fileOf(logText(50), 'Second.txt')])
    expect(shown()).not.toContain(restore.message)
    runToastAction(restore.id)
    await saved()
    expect(useApp.getState().workspaces[first].points).toHaveLength(2)
    expect((JSON.parse(storage.getItem(key) ?? '{}') as { points?: unknown[] }).points).toHaveLength(2)
  })

  it('opens the file fresh, and says so, when the saved workspace is not one this version reads', async () => {
    for (const junk of [{ version: 2, points: [] }, [1, 2], 'text', 42]) {
      resetStore()
      const text = logText()
      storage.setItem(`xpp:ws:${signatureOf(text)}`, JSON.stringify(junk))
      await openFiles([fileOf(text)])
      const { datasets, toasts } = useApp.getState()
      expect(datasets).toHaveLength(1)
      expect(getWorkspace()?.points).toEqual([])
      expect(toasts.map((t) => t.message)).toContain('The saved workspace for Synth_run.txt could not be read and was ignored.')
    }
  })
})

describe('opening files', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    resetStore()
  })
  afterEach(() => {
    resetStore()
    vi.unstubAllGlobals()
  })

  it('leaves the data-quality note to the Overview when the file opens there, else shows it with a way there', async () => {
    await openFiles([fileOf(logText(40, true), 'First.txt')])
    expect(useApp.getState().tab).toBe('overview')
    expect(useApp.getState().datasets[0].warnings.length).toBeGreaterThan(0)
    expect(useApp.getState().toasts).toEqual([])
    setTab('time')
    await openFiles([fileOf(logText(50, true), 'Second.txt')])
    const note = useApp.getState().toasts.find((t) => t.message === useApp.getState().datasets[1].warnings[0])
    expect(note?.action?.label).toBe('Show')
    // It shows this file's notes: it belongs to the file.
    expect(note?.action?.datasetId).toBe(useApp.getState().datasets[1].id)
    runToastAction(note!.id)
    expect(useApp.getState().tab).toBe('overview')
  })

  it('never makes a ninth test-point group (8 colour slots): the last group is used instead', async () => {
    await openFiles([fileOf(logText())])
    const ids = Array.from({ length: MAX_GROUPS - 1 }, (_, i) => addGroup(`Group ${i + 2}`))
    expect(new Set(getWorkspace()?.groups.map((g) => g.slot)).size).toBe(MAX_GROUPS)
    const ninth = addGroup('Group 9')
    expect(getWorkspace()?.groups).toHaveLength(MAX_GROUPS)
    expect(ninth).toBe(ids.at(-1))
    expect(useApp.getState().toasts.at(-1)?.message).toMatch(/at most 8 test-point groups/)
  })
})

describe('colour slots follow the channel', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    resetStore()
  })
  afterEach(() => {
    resetStore()
    vi.unstubAllGlobals()
  })

  /** Ten synthetic channels in degrees (one unit, so any of them can share a panel or the X–Y Y axis). */
  const TOKENS = Array.from({ length: 10 }, (_, i) => `chan${i},__deg`)
  const wideLog = () =>
    xplaneText(
      ['_totl,_time', ...TOKENS],
      Array.from({ length: 30 }, (_, r) => [r * 0.1, ...TOKENS.map((_, i) => i + r / 10)]),
    )
  const panelOf = (id: string) => getWorkspace()?.panels.find((p) => p.id === id)
  const [a, b, c, d, e] = TOKENS

  it('keeps the others’ slots when a channel leaves a panel, and gives a channel added the lowest free slot', async () => {
    await openFiles([fileOf(wideLog())])
    const id = addPanel([a, b, c])
    expect(panelOf(id)?.slots).toEqual([0, 1, 2])
    updatePanel(id, { channelIds: [b, c] })
    expect(panelOf(id)).toMatchObject({ channelIds: [b, c], slots: [1, 2] })
    updatePanel(id, { channelIds: [b, c, d] })
    expect(panelOf(id)?.slots).toEqual([1, 2, 0])
    updatePanel(id, { channelIds: [b, c, d, e] })
    expect(panelOf(id)?.slots).toEqual([1, 2, 0, 3])
    // Other edits leave the slots alone.
    updatePanel(id, { yZero: true })
    expect(panelOf(id)?.slots).toEqual([1, 2, 0, 3])
    // A panel edited without slots (a view's own edit) gets them from the same panel before the change.
    const before = getWorkspace()?.panels ?? []
    setPanels(before.map((p) => (p.id === id ? { id, channelIds: [c, e] } : p)))
    expect(panelOf(id)?.slots).toEqual([2, 3])
    // Undo puts the panels back with their slots.
    setPanels(before)
    expect(panelOf(id)?.slots).toEqual([1, 2, 0, 3])
  })

  it('never gives a panel more than 8 channels, nor two channels the same slot', async () => {
    await openFiles([fileOf(wideLog())])
    const id = addPanel(TOKENS)
    expect(panelOf(id)?.channelIds).toEqual(TOKENS.slice(0, 8))
    expect(panelOf(id)?.slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    updatePanel(id, { channelIds: [...TOKENS.slice(1, 8), TOKENS[9], TOKENS[8]] })
    expect(panelOf(id)?.channelIds).toEqual([...TOKENS.slice(1, 8), TOKENS[9]])
    expect(panelOf(id)?.slots).toEqual([1, 2, 3, 4, 5, 6, 7, 0])
  })

  it('does the same for the X–Y Y channels; a list given with its own slots keeps them', async () => {
    await openFiles([fileOf(wideLog())])
    setXY({ x: a, ys: [b, c, d] })
    const xy = () => getWorkspace()!.xy
    expect(xy().ySlots).toEqual([0, 1, 2])
    setXY({ ys: [c, d] })
    expect(xy().ySlots).toEqual([1, 2])
    setXY({ ys: [c, d, e] })
    expect(xy().ySlots).toEqual([1, 2, 0])
    setXY({ title: 'Trim curve' })
    expect(xy().ySlots).toEqual([1, 2, 0])
    // A preset brings the colours in order; slots that do not fit the list are re-derived instead.
    setXY({ ys: [e, b], ySlots: [0, 1] })
    expect(xy().ySlots).toEqual([0, 1])
    setXY({ ys: [e, b, c], ySlots: [0, 0, 9] })
    expect(xy().ySlots).toEqual([0, 1, 2])
  })

  it('keeps a renamed formula where it is used, with its colour slot', async () => {
    await openFiles([fileOf(wideLog())])
    const expression = 'chan0_deg + chan1_deg'
    expect(saveDerived({ name: 'Angle sum', unit: 'deg', expression }, 'angle_sum')).toEqual({ ok: true, id: 'fx:angle_sum' })
    const fx = 'fx:angle_sum'
    // "Plot it" (a panel of its own), a panel it shares, the X–Y Y list, a test-point column and Modes.
    const solo = addPanel([fx])
    const shared = addPanel([a, fx, b])
    updatePanel(shared, { channelIds: [fx, b] })
    setXY({ x: c, ys: [d, fx, e] })
    setXY({ ys: [fx, e] })
    setTracked([fx, a])
    setModes({ channelId: fx })
    expect(panelOf(shared)?.slots).toEqual([1, 2])
    expect(getWorkspace()?.xy.ySlots).toEqual([1, 2])

    const renamed = saveDerived({ name: 'Angle total', unit: 'deg', expression }, 'angle_total', fx)
    expect(renamed).toEqual({ ok: true, id: 'fx:angle_total' })
    const ws = getWorkspace()!
    expect(ws.derived.map((def) => def.id)).toEqual(['fx:angle_total'])
    expect(panelOf(solo)).toMatchObject({ channelIds: ['fx:angle_total'], slots: [0] })
    expect(panelOf(shared)).toMatchObject({ channelIds: ['fx:angle_total', b], slots: [1, 2] })
    expect(ws.xy).toMatchObject({ x: c, ys: ['fx:angle_total', e], ySlots: [1, 2] })
    expect(ws.tracked).toEqual(['fx:angle_total', a])
    expect(ws.modes.channelId).toBe('fx:angle_total')

    // On the X axis too.
    setXY({ x: 'fx:angle_total' })
    saveDerived({ name: 'Angle total 2', unit: 'deg', expression }, 'angle_total_2', 'fx:angle_total')
    expect(getWorkspace()?.xy).toMatchObject({ x: 'fx:angle_total_2', ys: ['fx:angle_total_2', e], ySlots: [1, 2] })
  })
})

describe('undo toasts belong to their file', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    resetStore()
  })
  afterEach(() => {
    resetStore()
    vi.unstubAllGlobals()
  })

  it('closes an Undo when another file opens, so neither a click nor Ctrl/Cmd+Z reaches the file off screen', async () => {
    await openFiles([fileOf(logText(40), 'First.txt')])
    const first = useApp.getState().activeId!
    const undone: string[] = []
    toast('Deleted test point “A”.', 'info', { label: 'Undo', run: () => undone.push('A') })
    toast('Could not save in this browser.', 'error', { label: 'Save session', run: () => undone.push('session') })
    // Scoped to the file active when it was shown.
    expect(useApp.getState().toasts.find((t) => t.message.startsWith('Deleted'))?.action?.datasetId).toBe(first)
    expect(latestUndoToast()?.message).toBe('Deleted test point “A”.')

    await openFiles([fileOf(logText(50), 'Second.txt')])
    expect(useApp.getState().activeId).not.toBe(first)
    expect(shown()).not.toContain('Deleted test point “A”.')
    // An action that names no file is not an Undo, and it stays.
    expect(shown()).toContain('Could not save in this browser.')
    expect(latestUndoToast()).toBeNull()

    // An Undo of the new file is the one Ctrl/Cmd+Z runs; going back to the first file closes it in turn.
    toast('Removed the panel.', 'info', { label: 'Undo', run: () => undone.push('panel') })
    const second = useApp.getState().activeId!
    expect(latestUndoToast()?.action?.datasetId).toBe(second)
    setActive(first)
    expect(latestUndoToast()).toBeNull()
    expect(shown()).not.toContain('Removed the panel.')
    expect(undone).toEqual([])
  })

  it('never runs, nor offers to Ctrl/Cmd+Z, an Undo of a file that is not the active one', async () => {
    await openFiles([fileOf(logText(40), 'First.txt')])
    const first = useApp.getState().activeId!
    await openFiles([fileOf(logText(50), 'Second.txt')])
    const undone: string[] = []
    // Shown for the first file while the second is active (a late toast): it never counts as the newest Undo.
    toast('Deleted “A”.', 'info', { label: 'Undo', datasetId: first, run: () => undone.push('A') })
    toast('Deleted “B”.', 'info', { label: 'Undo', run: () => undone.push('B') })
    expect(latestUndoToast()?.message).toBe('Deleted “B”.')
    const stale = useApp.getState().toasts.find((t) => t.message === 'Deleted “A”.')!
    runToastAction(stale.id)
    expect(undone).toEqual([])
    expect(shown()).not.toContain('Deleted “A”.')
    runToastAction(latestUndoToast()!.id)
    expect(undone).toEqual(['B'])
  })

  it('closes the Undo of a file that is closed', async () => {
    await openFiles([fileOf(logText(40), 'First.txt')])
    const first = useApp.getState().activeId!
    toast('Deleted “A”.', 'info', { label: 'Undo', run: () => {} })
    closeDataset(first)
    expect(latestUndoToast()).toBeNull()
    expect(shown()).not.toContain('Deleted “A”.')
  })

  it('treats any other action that names its file (Plot it, Show) the same way, without making it an Undo', async () => {
    await openFiles([fileOf(logText(40), 'First.txt')])
    const first = useApp.getState().activeId!
    const ran: string[] = []
    toast('Saved “Speed sum”.', 'success', { label: 'Plot it', datasetId: first, run: () => ran.push('plot') })
    const plot = useApp.getState().toasts.at(-1)!
    // Ctrl/Cmd+Z only ever undoes.
    expect(latestUndoToast()).toBeNull()
    await openFiles([fileOf(logText(50), 'Second.txt')])
    expect(shown()).not.toContain('Saved “Speed sum”.')
    // A click that was on its way (the toast was on screen a moment ago) does nothing either.
    runToastAction(plot.id)
    expect(ran).toEqual([])
  })
})
