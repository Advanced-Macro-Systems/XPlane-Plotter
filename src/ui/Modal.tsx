import { XIcon } from '@primer/octicons-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** Buttons shown at the bottom right */
  footer?: ReactNode
  width?: number
  /** Added to the dialog's own class, for a dialog with its own size or layout */
  className?: string
}

/**
 * Accessible modal built on <dialog>: focus is trapped, Escape and the backdrop close it, and focus goes back to the
 * element that opened it when it closes.
 */
export function Modal({ title, onClose, children, footer, width = 480, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // The browser's own focus restore never runs here: React removes the <dialog> before the cleanup below closes it,
    // which would leave focus on <body> (the next Tab would jump to the end of the page). So remember the opener.
    const opener = focusedElement()
    if (!dialog.open) dialog.showModal()
    // React's autoFocus runs before the dialog opens; the field to type in is marked data-autofocus and focused here.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onCancel = (event: Event) => {
      event.preventDefault()
      onCloseRef.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open) dialog.close()
      // Back to the opener, unless an action already moved focus somewhere that is still on the page.
      const now = focusedElement()
      if ((!now || dialog.contains(now)) && opener && opener.isConnected && !dialog.contains(opener)) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : 'modal'}
      aria-labelledby={titleId}
      style={{ width: `min(${width}px, calc(100vw - 24px))` }}
      onMouseDown={(event) => {
        // A press on the backdrop (outside the content box) closes the dialog.
        if (event.target === event.currentTarget) onCloseRef.current()
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </dialog>
  )
}

/** The focused element, or null when focus is nowhere in particular (<body>, or an element no longer on the page). */
function focusedElement(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body && active.isConnected ? active : null
}
