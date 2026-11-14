// Pure keyboard rule for the toasts (ui/Toasts): Ctrl/Cmd+Z runs the newest Undo, so an undo never needs a long trip
// with Tab to the corner of the page.

import { isTypingTarget, type KeyLike } from '../layout/shellModel'

/**
 * Whether a key press means "undo the last change" for the toasts: Ctrl+Z (⌘Z on a Mac) with no other modifier, not
 * while typing (a text field keeps its own undo) and not while a dialog is open.
 */
export function isUndoKey(event: KeyLike, ctx: { dialogOpen: boolean }): boolean {
  if (event.defaultPrevented || event.isComposing || ctx.dialogOpen) return false
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false
  return event.key.toLowerCase() === 'z' && !isTypingTarget(event.target)
}
