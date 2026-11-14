import { describe, expect, it } from 'vitest'
import { isUndoKey } from './toastKeys'

const key = (over: Partial<Parameters<typeof isUndoKey>[0]> = {}) => ({
  key: 'z',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: { tagName: 'BUTTON' },
  ...over,
})

describe('isUndoKey', () => {
  it('is Ctrl+Z, or Cmd+Z on a Mac, also with Caps Lock on', () => {
    expect(isUndoKey(key(), { dialogOpen: false })).toBe(true)
    expect(isUndoKey(key({ ctrlKey: false, metaKey: true }), { dialogOpen: false })).toBe(true)
    expect(isUndoKey(key({ key: 'Z' }), { dialogOpen: false })).toBe(true)
  })

  it('leaves other keys and modifier combinations alone (Ctrl+Shift+Z is redo)', () => {
    expect(isUndoKey(key({ ctrlKey: false }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key({ shiftKey: true }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key({ altKey: true }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key({ key: 'y' }), { dialogOpen: false })).toBe(false)
  })

  it('never takes a text field’s own undo, nor acts behind a dialog', () => {
    expect(isUndoKey(key({ target: { tagName: 'INPUT', type: 'text' } }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key({ target: { tagName: 'TEXTAREA' } }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key({ target: { isContentEditable: true } }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key(), { dialogOpen: true })).toBe(false)
    expect(isUndoKey(key({ defaultPrevented: true }), { dialogOpen: false })).toBe(false)
    expect(isUndoKey(key({ isComposing: true }), { dialogOpen: false })).toBe(false)
  })
})
