// Keeps a failing view from blanking the whole app: the header, tabs and other views stay usable, and the problem is
// shown in place with a way back. A view whose code could not be fetched (e.g. the site was updated while this page
// stayed open) needs a reload rather than another try.

import { AlertIcon } from '@primer/octicons-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isChunkLoadError } from './shellModel'

interface Props {
  /** What the view is called, for the message */
  name: string
  children: ReactNode
  /** Leaves for the overview; absent when the failing view is the overview */
  onLeave?: () => void
}

interface State {
  error: Error | null
}

export class ViewBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`The ${this.props.name} view failed`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { name, onLeave } = this.props
    const stale = isChunkLoadError(error.message)
    return (
      <div className="view">
        <div className="view-scroll">
          <div className="empty-state sh-view-error" role="alert">
            <AlertIcon size={24} />
            <h2>{stale ? `${name} could not be loaded` : `${name} hit a problem`}</h2>
            <p className="sh-view-error-text">
              {stale
                ? 'This page may be older than the site: reload it to get the latest version. Your open files will need to be opened again; their test points are saved in this browser.'
                : error.message || 'Something went wrong while drawing this view.'}
            </p>
            <div className="sh-view-error-actions">
              {stale ? (
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  Reload the page
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
                  Try again
                </button>
              )}
              {onLeave && (
                <button type="button" className="btn" onClick={onLeave}>
                  Go to the overview
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }
}
