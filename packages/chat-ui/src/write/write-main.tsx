import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { envOverridesFromImportMetaEnv } from '../browser-config'
import { ConnectionSettings } from './ConnectionSettings'
import { WriteApp } from './WriteApp'
import { clearConnection, loadConnection, saveConnection, toAssistantConfig, webProxyOf, type WriteConnection } from './write-config'
import { createWriteServices, type WriteServices } from './write-services'

/**
 * The Write page's own connection (its own storage and settings, apart from /try): asks for a key if there is none, then opens the page.
 * Saving changed connection settings rebuilds the services; articles live in their own storage and are untouched.
 */
function Root(): React.JSX.Element {
  const [connection, setConnection] = useState<WriteConnection | undefined>(() => loadConnection())
  const [services, setServices] = useState<WriteServices | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!connection) { setServices(undefined); return }
    let live = true
    const defaults = envOverridesFromImportMetaEnv(import.meta.env)
    createWriteServices(toAssistantConfig(connection, defaults), webProxyOf(connection, defaults)).then((s) => { if (live) setServices(s) }, (e) => setError(String(e)))
    return () => { live = false }
  }, [connection])

  if (error) return <p role="alert">Could not start: {error}</p>
  if (!connection) return <FirstRun onSave={(c) => { saveConnection(c); setConnection(loadConnection()) }} />
  if (!services) return <p>Opening your articles…</p>
  return (
    <WriteApp
      services={services}
      connection={{
        value: connection,
        onSave: (c) => { saveConnection(c); setServices(undefined); setConnection(loadConnection()) },
        onForget: () => { clearConnection(); setServices(undefined); setConnection(undefined) },
      }}
    />
  )
}

/** First visit: just how to reach a model. Everything else is in Settings, when it is wanted. */
function FirstRun({ onSave }: { onSave: (c: WriteConnection) => void }): React.JSX.Element {
  const [draft] = useState<WriteConnection>({ provider: 'anthropic', apiKey: '' })
  return (
    <div style={{ maxWidth: 480, margin: '10vh auto', padding: 16, font: '16px system-ui' }}>
      <h1>Aielia Write</h1>
      <ConnectionSettings value={draft} onSave={onSave} showWeb={false} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
