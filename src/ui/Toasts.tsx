import { AlertIcon, CheckCircleIcon, InfoIcon, XIcon } from '@primer/octicons-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { commandKey } from '../layout/platform'
import { dismissToast, holdToast, isUndoAction, latestUndoToast, runToastAction, useApp } from '../store/app'
import { isUndoKey } from './toastKeys'

/**
 * Short messages, bottom right. Errors are announced assertively. A toast's time stops while the pointer is over it or
 * focus is in it, and Ctrl/Cmd+Z runs the newest Undo of the open file from anywhere on the page (an Undo closes when
 * another file becomes active: store/app.ts).
 */
export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const regionRef = useRef<HTMLDivElement>(null)
  /** Focus is in a toast, and where it came from (to go back there when that toast closes). */
  const focusInsideRef = useRef(false)
  const returnRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isUndoKey(event, { dialogOpen: document.querySelector('dialog[open]') !== null })) return
      const undo = latestUndoToast()
      if (!undo) return
      event.preventDefault()
      runToastAction(undo.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The toast that had focus closed (Undo, Dismiss): its button went with it, which drops focus to <body>. Go back to
  // where focus came from, or else to the newest toast left.
  useLayoutEffect(() => {
    if (!focusInsideRef.current) return
    const active = document.activeElement
    if (active && active !== document.body) return
    focusInsideRef.current = false
    const back = returnRef.current
    if (back?.isConnected) back.focus({ preventScroll: true })
    else regionRef.current?.querySelector<HTMLElement>('.toast:last-child button')?.focus({ preventScroll: true })
  }, [toasts])

  const undoHint = `${commandKey()}+Z`
  return (
    <div
      ref={regionRef}
      className="toasts"
      aria-live="polite"
      onFocus={(event) => {
        const from = event.relatedTarget
        if (!focusInsideRef.current && from instanceof HTMLElement && !event.currentTarget.contains(from)) {
          returnRef.current = from
        }
        focusInsideRef.current = true
      }}
      onBlur={(event) => {
        // Focus moved out of the toasts, or to nothing (a click on the page) while the button is still there: forget
        // it. A button that goes away with its toast is handled by the layout effect above.
        const next = event.relatedTarget
        const left = next instanceof Node ? !event.currentTarget.contains(next) : event.target.isConnected
        if (left) focusInsideRef.current = false
      }}
    >
      {toasts.map((t) => {
        const undo = isUndoAction(t.action)
        return (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => holdToast(t.id, 'pointer', true)}
            onMouseLeave={() => holdToast(t.id, 'pointer', false)}
            onFocus={() => holdToast(t.id, 'focus', true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) holdToast(t.id, 'focus', false)
            }}
          >
            {t.kind === 'error' ? (
              <AlertIcon className="toast-icon" />
            ) : t.kind === 'success' ? (
              <CheckCircleIcon className="toast-icon" />
            ) : (
              <InfoIcon className="toast-icon" />
            )}
            <p className="toast-text">{t.message}</p>
            {t.action && (
              <button
                type="button"
                className="btn btn-sm btn-ghost toast-action"
                title={undo ? `Undo (${undoHint})` : undefined}
                aria-keyshortcuts={undo ? 'Control+Z Meta+Z' : undefined}
                onClick={() => runToastAction(t.id)}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <XIcon />
            </button>
          </div>
        )
      })}
    </div>
  )
}
