import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText, downloadBlob, downloadText, safeFilename } from './download'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('safeFilename', () => {
  it('keeps letters, digits, dots, dashes and underscores; everything else becomes one underscore', () => {
    expect(safeFilename('CG fwd / 250 kt')).toBe('CG_fwd_250_kt')
    expect(safeFilename('Data_737-800 v1.2')).toBe('Data_737-800_v1.2')
    expect(safeFilename('  ..hidden?  ')).toBe('hidden')
    expect(safeFilename('a<>:"/\\|?*b')).toBe('a_b')
  })

  it('drops accents, trims to a sane length and avoids reserved Windows names', () => {
    expect(safeFilename('Vitesse élevée — Ø')).toBe('Vitesse_elevee')
    expect(safeFilename('x'.repeat(300))).toHaveLength(100)
    expect(safeFilename('CON')).toBe('CON_')
    expect(safeFilename('nul.txt')).toBe('nul.txt_')
  })

  it('falls back when nothing usable is left', () => {
    expect(safeFilename('')).toBe('export')
    expect(safeFilename('///', 'points')).toBe('points')
    expect(safeFilename('日本語')).toBe('export')
  })
})

describe('downloads outside a browser', () => {
  it('do nothing instead of throwing', () => {
    expect(() => downloadText('a.txt', 'hello')).not.toThrow()
    expect(() => downloadBlob('a.bin', new Blob(['x']))).not.toThrow()
  })

  it('copyText resolves false without a clipboard or document', async () => {
    await expect(copyText('hello')).resolves.toBe(false)
  })
})

/** A minimal DOM: just what download.ts touches. */
function fakeDocument(execCommand: (command: string) => boolean = () => true) {
  const appended: Record<string, unknown>[] = []
  const document = {
    body: { appendChild: (node: Record<string, unknown>) => appended.push(node) },
    activeElement: null,
    getSelection: () => null,
    execCommand: vi.fn(execCommand),
    createElement: (tag: string) => {
      const node: Record<string, unknown> = {
        tag,
        style: {},
        clicked: 0,
        removed: 0,
        click() {
          node.clicked = (node.clicked as number) + 1
        },
        remove() {
          node.removed = (node.removed as number) + 1
        },
        setAttribute(name: string, value: string) {
          node[name] = value
        },
        select() {},
        setSelectionRange() {},
      }
      return node
    },
  }
  vi.stubGlobal('document', document)
  return { document, appended }
}

describe('downloads in a browser', () => {
  it('clicks a hidden <a download> link to an object URL and revokes the URL afterwards', async () => {
    vi.useFakeTimers()
    const { appended } = fakeDocument()
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob)
      return 'blob:fake'
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    downloadText('points.csv', 'a,b\r\n', 'text/csv')
    expect(appended).toHaveLength(1)
    const link = appended[0]
    expect(link).toMatchObject({ tag: 'a', href: 'blob:fake', download: 'points.csv', clicked: 1, removed: 1 })
    expect(created[0].type).toBe('text/csv;charset=utf-8')
    // CSV gets a UTF-8 byte-order mark so Excel reads units like "°" correctly.
    const bytes = new Uint8Array(await created[0].arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(revoke).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:fake')
  })

  it('adds no byte-order mark to other text', async () => {
    fakeDocument()
    let blob: Blob | null = null
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    downloadText('script.m', '% MATLAB', 'text/x-matlab')
    expect(blob).not.toBeNull()
    expect(await (blob as unknown as Blob).text()).toBe('% MATLAB')
  })

  it('copies with the async clipboard when it works', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    const { document, appended } = fakeDocument(() => true)
    await expect(copyText('fallback')).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(appended[0]).toMatchObject({ tag: 'textarea', value: 'fallback', removed: 1 })

    fakeDocument(() => false)
    await expect(copyText('nope')).resolves.toBe(false)
  })
})
