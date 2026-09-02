import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The hosted browser trial is served from buildaharness.com/try, so its build needs
// base '/try/'. Local dev and the Tauri desktop build (which serves chat-ui/dist from
// the app root) must stay at '/'. The deploy-chat-ui workflow sets CHAT_UI_BASE=/try/;
// nothing else does.
const base = process.env.CHAT_UI_BASE || '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 3010 },
})
