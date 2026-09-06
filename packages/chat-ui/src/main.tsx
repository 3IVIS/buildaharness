import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'

async function bootstrap(): Promise<void> {
  // E2E only: publish the scripted-client / in-memory-FS factories on window before <App/> mounts
  // and builds its assistant, so a Playwright `addInitScript` can wire the B1 test hooks. The
  // `=== '1'` guard is constant-folded to `false` in production builds, so this dynamic import is
  // tree-shaken out entirely — the E2E runtime never ships to real users. See e2e/e2e-runtime.ts.
  if (import.meta.env.VITE_E2E === '1') {
    await import('./e2e/e2e-runtime')
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
