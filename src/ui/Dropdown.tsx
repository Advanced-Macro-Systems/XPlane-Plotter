import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MENU_ITEM_SELECTOR, menuKeyTarget, popupShift } from './popup'

interface DropdownProps {
  /** Content of the toggle button */
  label: ReactNode
  /** Accessible name when the label is only an icon */
  ariaLabel?: string
  buttonClassName?: string
  /** Tooltip on the toggle button */
  title?: string
  /** Which edge of the button the menu lines up with */
  align?: 'left' | 'right'
  /** Menu width in px (capped to the screen) */
  width?: number
  disabled?: boolean
  /**
   * What pops up, for assistive technology (aria-haspopup): 'menu' for a list of actions (give it role="menu" and its
   * items role="menuitem": focus then starts on the first item and ↑/↓/Home/End move between them), 'listbox' for a
   * list to pick from, 'dialog' for a panel of controls or a form (the popup gets role="dialog").
   */
  haspopup?: 'menu' | 'listbox' | 'dialog'
  /** Menu content; call `close()` after an action */
  children: (close: () => void) => ReactNode
}

/**
 * A button that opens a floating menu/panel. Closes on outside click, Escape, and when focus moves out of it (Tab past
 * its last control); stays on screen on narrow windows.
 */
export function Dropdown({
  label,
  ariaLabel,
  buttonClassName = 'btn',
  title,
  align = 'left',
  width = 260,
  disabled,
  haspopup = 'menu',
  children,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Focus is (or was last) on a control inside the open popup. */
  const focusInsideRef = useRef(false)
  const menuId = useId()
  const buttonId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      const dialog = document.querySelector('dialog[open]')
      if (dialog && !dialog.contains(wrapperRef.current)) return
      // Close only this menu: not the dialog or panel it sits in.
      event.preventDefault()
      event.stopPropagation()
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // Keep the popup inside the window (a phone screen is narrower than a menu lined up with a button near its edge).
  // Written to the element directly, before paint, so it never shows off screen first.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!open || !menu) return
    const place = () => {
      menu.style.translate = ''
      const shift = popupShift(menu.getBoundingClientRect(), document.documentElement.clientWidth)
      if (shift) menu.style.translate = `${shift}px 0`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // A real menu (role="menu" items): focus starts on its first item, as the WAI-ARIA menu-button pattern expects.
  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus({ preventScroll: true })
  }, [open])

  // Focus was inside the popup when it closed (after an action, say): the focused control went with the popup, which
  // drops focus to <body>. Hand it back to the toggle, before paint and before a dialog the action opens remembers its
  // opener (Modal does so in a passive effect), so that dialog returns focus here when it closes.
  useLayoutEffect(() => {
    if (open || !focusInsideRef.current) return
    focusInsideRef.current = false
    const active = document.activeElement
    if (!active || active === document.body) buttonRef.current?.focus({ preventScroll: true })
  }, [open])

  const close = () => setOpen(false)

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.matches(MENU_ITEM_SELECTOR)) return
    const items = menuItems(menuRef.current)
    const next = menuKeyTarget(event.key, items.indexOf(target), items.length)
    if (next === null) return
    event.preventDefault()
    items[next].focus()
  }

  return (
    <div
      className="dropdown"
      ref={wrapperRef}
      onBlur={(event) => {
        // Focus left for good (Tab past the last control): close. A click on a non-focusable part of the popup moves
        // focus nowhere (relatedTarget null) and keeps it open; outside clicks are handled on pointerdown.
        const next = event.relatedTarget as Node | null
        if (open && next && !wrapperRef.current?.contains(next)) {
          focusInsideRef.current = false
          setOpen(false)
        }
      }}
    >
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className={buttonClassName}
        aria-label={ariaLabel}
        title={title}
        aria-haspopup={haspopup}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className={`dropdown-menu dropdown-${align}`}
          role={haspopup === 'dialog' ? 'dialog' : undefined}
          aria-labelledby={haspopup === 'dialog' ? buttonId : undefined}
          style={{ width: `min(${width}px, calc(100vw - 16px))` }}
          onKeyDown={onMenuKeyDown}
          onFocus={() => {
            focusInsideRef.current = true
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

/** The focusable menu items of a popup, in order (disabled and hidden ones left out). */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (el) => !el.matches(':disabled, [aria-disabled="true"]') && el.getClientRects().length > 0,
  )
}
