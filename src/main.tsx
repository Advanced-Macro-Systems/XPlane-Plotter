// Fonts and global styles first, so each component's own CSS (imported through App) comes after and wins ties.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/global.css'
import './styles/ui.css'
import './components/view.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme } from './lib/theme'
import { initFromUrl } from './lib/urlInit'
import { loadDatasetBuilder } from './store/app'

applyTheme()
initFromUrl()
// The dataset builder (with the channel dictionary) is not part of the start page, but the demo or a file opened the
// moment the page appears needs it: ask for it now, so it downloads while React draws the page (the network is idle
// then), not after.
void loadDatasetBuilder().catch(() => undefined)

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
