import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDataset } from '../core/dataset'
import { parseText } from '../core/parse'
import { xplaneText } from '../core/parse/fixtures'
import {
  addGroup,
  dismissToast,
  getWorkspace,
  holdToast,
  latestUndoToast,
  openFiles,
  readRecent,
  runToastAction,
  setTab,
  setTracked,
  toast,
  toastLifetime,
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
