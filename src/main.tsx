import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// XYFlow base CSS must come before index.css so our overrides always win
import '@xyflow/react/dist/style.css'
import './index.css'
import { App } from './App'
import { initLangfuse } from './services/langfuse'

// §10 — Apply saved theme before React mounts to avoid first-frame flash.
const _theme = localStorage.getItem('itsharness:theme') ?? 'dark'
document.documentElement.setAttribute('data-theme', _theme)

// Initialise Langfuse canvas event tracking.
// No-op unless VITE_LANGFUSE_ENABLED=true is set in .env.local
initLangfuse()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
