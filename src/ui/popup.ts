// Pure rules for floating popups (ui/Dropdown): keeping a popup on screen and moving focus through a role="menu".

/** Least gap kept between a popup and the edge of the window (px). */
export const POPUP_MARGIN = 8

/**
 * How far to move a popup sideways (px) so it stays inside [margin, viewportWidth − margin]: a menu lined up with a
 * button near the right edge of a phone screen would otherwise run off it (and scroll the page sideways). When the
 * popup is wider than the room, its left edge wins.
 */
export function popupShift(
  rect: { left: number; right: number },
  viewportWidth: number,
  margin = POPUP_MARGIN,
): number {
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right) || !(viewportWidth > 0)) return 0
  let shift = 0
  if (rect.right > viewportWidth - margin) shift = viewportWidth - margin - rect.right
  if (rect.left + shift < margin) shift = margin - rect.left
  return Math.round(shift)
}

/**
 * The menu item to focus for a key in a role="menu" popup (WAI-ARIA menu pattern): ↓/↑ move to the next/previous item
 * and wrap, Home/End go to the first/last. `index` is the focused item (−1 when none is); null = not a menu key.
 */
export function menuKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % count
    case 'ArrowUp':
      return index < 0 ? count - 1 : (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Menu items in a popup that can take focus: role menuitem / menuitemcheckbox / menuitemradio, enabled, shown. */
export const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
