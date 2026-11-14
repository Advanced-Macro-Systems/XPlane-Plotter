// While a file is read (store.loading): a calm card over the dimmed main area with the file name, the phase, a
// progress bar and Cancel. Rendered only while loading, so tests can wait for it to disappear.

import { DEMO_FILE_NAME } from '../core/demo/generateDemo'
import { cancelLoading, useApp } from '../store/app'
import { loadingText } from './shellModel'

export function LoadingOverlay() {
  const loading = useApp((s) => s.loading)
  if (!loading) return null
  const demo = loading.name === DEMO_FILE_NAME
  const reading = loading.phase === 'reading'
  const percent = Math.round(Math.max(0, Math.min(1, loading.progress || 0)) * 100)
  const phase = loadingText(loading, demo)

  return (
    <div className="sh-loading" data-testid="loading-overlay">
      <div className="sh-loading-card" role="group" aria-label={`Opening ${loading.name}`}>
        {/* Announce the phase, not every percent. */}
        <span className="sr-only" role="status">
          {reading ? `Reading ${loading.name}` : phase}
        </span>
        <div className="sh-loading-head">
          <span className="spinner" aria-hidden="true" />
          <span className="eyebrow">{demo ? 'Demo flight' : 'Opening file'}</span>
        </div>
        <p className="sh-loading-name" title={loading.name}>
          {loading.name}
        </p>
        <div
          className={`progress sh-loading-bar${reading ? '' : ' sh-loading-bar-busy'}`}
          role="progressbar"
          aria-label={phase}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={reading ? percent : undefined}
        >
          <span style={{ width: reading ? `${percent}%` : undefined }} />
        </div>
        <div className="sh-loading-foot">
          <span className="sh-loading-phase" aria-hidden="true">
            {phase}
          </span>
          {/* Only reading can be stopped: building the channels is one short step that finishes anyway. */}
          {!demo && reading && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={cancelLoading}>
              Cancel
            </button>
          )}
        </div>
        <p className="sh-loading-note">Read on this computer: nothing is uploaded.</p>
      </div>
    </div>
  )
}
