import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// XYFlow base CSS must come before index.css so our overrides always win
import '@xyflow/react/dist/style.css'
import './index.css'
import { App } from './App'
import { initLangfuse } from './services/langfuse'

// Initialise Langfuse canvas event tracking.
// No-op unless VITE_LANGFUSE_ENABLED=true is set in .env.local
initLangfuse()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
