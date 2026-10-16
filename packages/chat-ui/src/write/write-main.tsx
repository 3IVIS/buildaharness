import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { resolveConfig, type AssistantConfig } from '@buildaharness/aielia'
import { BrowserConfigStore } from '../browser-config-store'
import { envOverridesFromImportMetaEnv } from '../browser-config'
import { hasModelCredentials } from '../key-gate'
import { WriteApp } from './WriteApp'
import { createWriteServices, type WriteServices } from './write-services'

/** Loads the visitor's own key, asks for one if there is none, then opens the page. The key stays in this browser. */
function Root(): React.JSX.Element {
  const store = new BrowserConfigStore()
  const [config, setConfig] = useState<AssistantConfig | undefined>()
  const [services, setServices] = useState<WriteServices | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void store.load().then((persisted) => setConfig(resolveConfig(persisted, envOverridesFromImportMetaEnv(import.meta.env)).config))
  }, [])
  useEffect(() => {
    if (config && hasModelCredentials(config)) createWriteServices(config).then(setServices, (e) => setError(String(e)))
  }, [config])

  if (error) return <p role="alert">Could not start: {error}</p>
  if (!config) return <p>Loading…</p>
  if (!hasModelCredentials(config)) return <KeyForm onSave={async (patch) => { await store.save(patch); setConfig(resolveConfig(await store.load(), envOverridesFromImportMetaEnv(import.meta.env)).config) }} />
  if (!services) return <p>Opening your articles…</p>
  return <WriteApp services={services} />
}

function KeyForm({ onSave }: { onSave: (patch: Partial<AssistantConfig>) => Promise<void> }): React.JSX.Element {
  const [backend, setBackend] = useState<'anthropic' | 'openai' | 'openrouter'>('anthropic')
  const [key, setKey] = useState('')
  return (
    <form style={{ maxWidth: 480, margin: '10vh auto', padding: 16, font: '16px system-ui' }} onSubmit={(e) => { e.preventDefault(); void onSave({ llmBackend: backend, apiKey: key.trim() }) }}>
      <h1>Aielia Write</h1>
      <p>Aielia has no account of its own. Bring a key from Anthropic, OpenAI or OpenRouter; it stays in this browser and is sent only to that provider.</p>
      <select aria-label="Provider" value={backend} onChange={(e) => setBackend(e.target.value as typeof backend)}>
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
        <option value="openrouter">OpenRouter</option>
      </select>
      <input aria-label="API key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" style={{ display: 'block', width: '100%', margin: '8px 0' }} />
      <button type="submit" disabled={!key.trim()}>Start writing</button>
    </form>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
