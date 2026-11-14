// The modifier key people know for shortcuts on their computer.

const isApple =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')

/** "⌘" on Apple devices, "Ctrl" elsewhere (for hints like "Ctrl+O"). */
export function commandKey(): string {
  return isApple ? '⌘' : 'Ctrl'
}
