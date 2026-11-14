import { describe, expect, it } from 'vitest'
import { menuKeyTarget, popupShift } from './popup'

describe('popupShift', () => {
  it('leaves a popup that fits alone', () => {
    expect(popupShift({ left: 20, right: 300 }, 1440)).toBe(0)
  })

  it('moves a popup that runs off the right edge back inside, 8 px from it', () => {
    // A 374 px menu lined up with a button 48 px in, on a 390 px phone screen.
    expect(popupShift({ left: 48, right: 422 }, 390)).toBe(-40)
  })

  it('moves a popup that runs off the left edge (right-aligned to a button near the left)', () => {
    expect(popupShift({ left: -30, right: 200 }, 390)).toBe(38)
  })

  it('keeps the left edge on screen when the popup is wider than the room', () => {
    expect(popupShift({ left: 40, right: 640 }, 390)).toBe(-32)
  })

  it('does nothing without a usable measurement', () => {
    expect(popupShift({ left: Number.NaN, right: 10 }, 390)).toBe(0)
    expect(popupShift({ left: 0, right: 10 }, 0)).toBe(0)
  })
})

describe('menuKeyTarget', () => {
  it('moves with the arrow keys, wrapping at the ends', () => {
    expect(menuKeyTarget('ArrowDown', 0, 3)).toBe(1)
    expect(menuKeyTarget('ArrowDown', 2, 3)).toBe(0)
    expect(menuKeyTarget('ArrowUp', 0, 3)).toBe(2)
    expect(menuKeyTarget('ArrowUp', 2, 3)).toBe(1)
  })

  it('starts at the first (↓) or last (↑) item when none has focus', () => {
    expect(menuKeyTarget('ArrowDown', -1, 3)).toBe(0)
    expect(menuKeyTarget('ArrowUp', -1, 3)).toBe(2)
  })

  it('jumps with Home and End, and ignores other keys and empty menus', () => {
    expect(menuKeyTarget('Home', 2, 3)).toBe(0)
    expect(menuKeyTarget('End', 0, 3)).toBe(2)
    expect(menuKeyTarget('Enter', 0, 3)).toBeNull()
    expect(menuKeyTarget('ArrowDown', -1, 0)).toBeNull()
  })
})
