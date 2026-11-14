// App shell: header (file switcher, actions, tab bar), the open tab's view or the landing page, the loading card, the
// window-wide drop target, help and toasts, and the one hidden file input every "Open file" action clicks.

import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
import type { TabId } from './core/types'
import { DropOverlay } from './layout/DropOverlay'
import { openPickedFiles } from './layout/fileActions'
import { registerFileInput } from './layout/filePicker'
import { Header } from './layout/Header'
import { HelpDialog } from './layout/HelpDialog'
import { Landing } from './layout/Landing'
import './layout/layout.css'
import { LoadingOverlay } from './layout/LoadingOverlay'
import { TAB_NAMES, TAB_ORDER, type HelpSection } from './layout/shellModel'
import { useShortcuts } from './layout/useShortcuts'
import { ViewBoundary } from './layout/ViewBoundary'
import { getActiveDataset, setTab, useActiveDataset, useApp } from './store/app'
import { Toasts } from './ui/Toasts'

/**
 * Each tab's view, as its own chunk: the start page paints without the charts, and a view that fails to load only
 * takes its own tab down. All of them are fetched in the background once the page is up, so tabs open at once.
 */
const LOADERS: Record<TabId, () => Promise<ComponentType>> = {
  overview: () => import('./views/overview/OverviewView').then((m) => m.OverviewView),
  time: () => import('./views/time/TimeView').then((m) => m.TimeView),
  xy: () => import('./views/xy/XYView').then((m) => m.XYView),
  points: () => import('./views/points/PointsView').then((m) => m.PointsView),
  modes: () => import('./views/modes/ModesView').then((m) => m.ModesView),
  channels: () => import('./views/channels/ChannelsView').then((m) => m.ChannelsView),
}

const VIEWS = Object.fromEntries(
  TAB_ORDER.map((tab) => [tab, lazy(() => LOADERS[tab]().then((View) => ({ default: View })))]),
) as Record<TabId, LazyExoticComponent<ComponentType>>

/** Fetches every view's chunk when the browser is idle (a dynamic import is fetched once, whoever asks first). */
function usePrefetchViews(): void {
  useEffect(() => {
    const prefetch = () => {
      for (const tab of TAB_ORDER) void LOADERS[tab]().catch(() => undefined)
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 2000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = setTimeout(prefetch, 800)
    return () => clearTimeout(timer)
  }, [])
}

export function App() {
  const ds = useActiveDataset()
  const tab = useApp((s) => s.tab)
  const [help, setHelp] = useState<HelpSection | null>(null)
  const View = VIEWS[tab]

  // Without a file the help starts with recording; with one, with using the app.
  const openHelp = useCallback((section?: HelpSection) => setHelp(section ?? (getActiveDataset() ? 'use' : 'record')), [])
  useShortcuts(openHelp)
  usePrefetchViews()

  return (
    <div className="app">
      <Header onHelp={openHelp} />
      <main className="app-main" aria-label={ds ? TAB_NAMES[tab] : 'Start'}>
        {ds ? (
          <ViewBoundary
            key={`${ds.id}:${tab}`}
            name={TAB_NAMES[tab]}
            onLeave={tab === 'overview' ? undefined : () => setTab('overview')}
          >
            <Suspense fallback={<ViewLoading />}>
              <View />
            </Suspense>
          </ViewBoundary>
        ) : (
          <Landing onHelp={openHelp} />
        )}
        <LoadingOverlay />
      </main>
      <DropOverlay />
      {help && <HelpDialog initial={help} onClose={() => setHelp(null)} />}
      <Toasts />
      <input
        ref={registerFileInput}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        accept=".txt,.csv,.tsv,.dat,.log,text/plain,text/csv"
        onChange={(event) => {
          // Copy the list before clearing the input (clearing lets the same file be picked again).
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length) void openPickedFiles(files)
        }}
      />
    </div>
  )
}

/** While a view's code arrives (first open only, usually never seen): a quiet spinner, shown after a short delay. */
function ViewLoading() {
  return (
    <div className="view sh-view-loading" role="status" aria-label="Loading the view">
      <span className="spinner" aria-hidden="true" />
    </div>
  )
}
