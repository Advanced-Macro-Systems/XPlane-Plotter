import { AlertIcon, CheckCircleIcon, InfoIcon, XIcon } from '@primer/octicons-react'
import { dismissToast, useApp } from '../store/app'

/** Short messages, bottom right. Errors are announced assertively. */
export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
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
              onClick={() => {
                t.action?.run()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  )
}
