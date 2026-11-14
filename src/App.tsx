// App shell: header (file switcher, actions, tab bar), the open tab's view or the landing page, the loading card, the
// window-wide drop target, help, the session-import question and toasts, and the one hidden file input every
// "Open file" action clicks. The shell stays mounted for the whole visit, so it selects ids, never Dataset objects:
// React keeps a component's previous state for a while, which would keep a closed file's data in memory.

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
import { SessionImport } from './layout/SessionImport'
import { TAB_NAMES, TAB_ORDER, type HelpSection } from './layout/shellModel'
import { useShortcuts } from './layout/useShortcuts'
import { ViewBoundary } from './layout/ViewBoundary'
import { getActiveDataset, setTab, useApp } from './store/app'
import { Toasts } from './ui/Toasts'

/**
 * Each tab's view, as its own chunk: the start page paints without the charts, and a view that fails to load only
 * takes its own tab down. All of them are fetched in the background once the page is up, so tabs open at once.
 */
const IMPORTS: Record<TabId, () => Promise<ComponentType>> = {
  overview: () => import('./views/overview/OverviewView').then((m) => m.OverviewView),
  time: () => import('./views/time/TimeView').then((m) => m.TimeView),
  xy: () => import('./views/xy/XYView').then((m) => m.XYView),
  points: () => import('./views/points/PointsView').then((m) => m.PointsView),
  modes: () => import('./views/modes/ModesView').then((m) => m.ModesView),
  channels: () => import('./views/channels/ChannelsView').then((m) => m.ChannelsView),
}

/** Views whose code has arrived: they render at once, without a Suspense fallback (see TabView). */
const LOADED: Partial<Record<TabId, ComponentType>> = {}

function loadView(tab: TabId): Promise<ComponentType> {
  return IMPORTS[tab]().then((View) => {
    LOADED[tab] = View
    return View
  })
}

const VIEWS = Object.fromEntries(
  TAB_ORDER.map((tab) => [tab, lazy(() => loadView(tab).then((View) => ({ default: View })))]),
) as Record<TabId, LazyExoticComponent<ComponentType>>

/**
 * Fetches every view's chunk once the start page is on screen and the browser is idle (main.tsx asked for the dataset
 * builder before the page was drawn: someone may click the demo or drop a file right away). A dynamic import is fetched
 * once, whoever asks first: the start page never waits for them, and opening a file does not either.
 */
function usePrefetchViews(): void {
  useEffect(() => {
    const prefetch = () => {
      for (const tab of TAB_ORDER) void loadView(tab).catch(() => undefined)
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 2000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = setTimeout(prefetch, 800)
    return () => clearTimeout(timer)
  }, [])
}

/** While a file is being read, fetch the view it will open on, so it is ready when the loading card closes. */
function usePrefetchWhileLoading(tab: TabId): void {
  const loading = useApp((s) => s.loading !== null)
  useEffect(() => {
    if (loading && !LOADED[tab]) void loadView(tab).catch(() => undefined)
  }, [loading, tab])
}

export function App() {
  // The id only (see the note at the top).
  const activeId = useApp((s) => (s.activeId !== null && s.datasets.some((d) => d.id === s.activeId) ? s.activeId : null))
  const tab = useApp((s) => s.tab)
  const [help, setHelp] = useState<HelpSection | null>(null)

  // Without a file the help starts with recording; with one, with using the app.
  const openHelp = useCallback((section?: HelpSection) => setHelp(section ?? (getActiveDataset() ? 'use' : 'record')), [])
  useShortcuts(openHelp)
  usePrefetchViews()
  // The first file opens on the Overview; a later one on the open tab.
  usePrefetchWhileLoading(activeId ? tab : 'overview')

  return (
    <div className="app">
      <Header onHelp={openHelp} />
      <main className="app-main" aria-label={activeId ? TAB_NAMES[tab] : 'Start'}>
        {activeId ? (
          <ViewBoundary
            key={`${activeId}:${tab}`}
            name={TAB_NAMES[tab]}
            onLeave={tab === 'overview' ? undefined : () => setTab('overview')}
          >
            <TabView tab={tab} />
          </ViewBoundary>
        ) : (
          <Landing onHelp={openHelp} />
        )}
        <LoadingOverlay />
      </main>
      <DropOverlay />
      {help && <HelpDialog initial={help} onClose={() => setHelp(null)} />}
      <SessionImport />
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

/**
 * The open tab's view. A view whose code is already here renders directly: through React.lazy it would suspend for a
 * moment even then, and React keeps a fallback up for at least 300 ms, which showed as a blank main area just after
 * the loading card closed. Chosen once per mount (the boundary around it is keyed on the file and the tab).
 */
function TabView({ tab }: { tab: TabId }) {
  const [View] = useState<ComponentType>(() => LOADED[tab] ?? VIEWS[tab])
  return (
    <Suspense fallback={<ViewLoading />}>
      <View />
    </Suspense>
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
