// Start-up options from the URL, for links and automated screenshots:
//   ?demo            load the synthetic demo flight
//   ?tab=time        open a tab (overview | time | xy | points | modes | channels)
//   ?theme=dark      force light / dark / system for this visit (also saved like a normal choice)

import { openDemo, setTab } from '../store/app'
import type { TabId } from '../core/types'
import { setThemeChoice } from './theme'

const TABS: readonly TabId[] = ['overview', 'time', 'xy', 'points', 'modes', 'channels']

export function initFromUrl(): void {
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme')
  if (theme === 'light' || theme === 'dark' || theme === 'system') setThemeChoice(theme)
  const tab = params.get('tab') as TabId | null
  if (params.has('demo')) {
    void openDemo().then(() => {
      if (tab && TABS.includes(tab)) setTab(tab)
    })
  } else if (tab && TABS.includes(tab)) {
    setTab(tab)
  }
}
