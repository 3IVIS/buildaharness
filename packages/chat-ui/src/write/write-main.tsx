import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { envOverridesFromImportMetaEnv } from '../browser-config'
import { applyBrowserLayerSettings } from '../layer-env'
import { ConnectionSettings } from './ConnectionSettings'
import { DialogProvider } from './dialogs'
import { WriteApp } from './WriteApp'
import { clearConnection, loadConnection, saveConnection, toAssistantConfig, webProxyOf, type WriteConnection } from './write-config'
import { markSettingsShared, writeConnectionFromChat } from '../shared-settings'
import { createWriteServices, type WriteServices } from './write-services'
import { createSampleServices } from './sample-services'
import { appSwitchHandler } from '../app-switch'
import { AppSwitcher } from '../components/AppSwitcher'
import { ProxyNotice } from '../components/ProxyNotice'
import { PRIVACY_URL, TERMS_URL } from '@buildaharness/aielia'

/** Write's first start: copies the chat page's connection when there is one (and saves it, as if the writer had entered it). */
function seedFromChat(): WriteConnection | undefined {
  const found = writeConnectionFromChat()
  if (found) saveConnection(found)
  return loadConnection()
}

/**
 * The Write page's own connection (its own storage and settings, apart from the Chat page): with no key it opens a sample article to look around in
 * (the key form is one click away), and with a key it opens the visitor's own articles.
 * Saving changed connection settings rebuilds the services; articles live in their own storage and are untouched.
 */
function Root(): React.JSX.Element {
  const [connection, setConnection] = useState<WriteConnection | undefined>(() => loadConnection() ?? seedFromChat())
  const [services, setServices] = useState<WriteServices | undefined>()
  const [error, setError] = useState<string | undefined>()
  // The visitor asked to add a key from the sample.
  const [settingUp, setSettingUp] = useState(false)

  useEffect(() => {
    if (!connection) {
      setServices(undefined)
      if (settingUp) return
      let live = true
      createSampleServices().then((s) => { if (live) setServices(s) }, (e) => setError(String(e)))
      return () => { live = false }
    }
    let live = true
    // The shared flag readers in the assistant code read process.env, which a browser tab lacks ("process is not defined").
    applyBrowserLayerSettings(undefined)
    const defaults = envOverridesFromImportMetaEnv(import.meta.env)
    createWriteServices(toAssistantConfig(connection, defaults), webProxyOf(connection, defaults), connection.githubToken).then((s) => { if (live) setServices(s) }, (e) => setError(String(e)))
    return () => { live = false }
  }, [connection, settingUp])

  if (error) return <p role="alert">Could not start: {error}</p>
  if (!connection && settingUp) return <FirstRun onSave={(c) => { saveConnection(c); setSettingUp(false); setConnection(loadConnection()) }} onBack={() => setSettingUp(false)} />
  if (!services) return <p>{connection ? 'Opening your articles…' : 'Opening the sample…'}</p>
  return (
    <WriteApp
      services={services}
      appSwitch={appSwitchHandler('write')}
      onDeleted={() => { setServices(undefined); setConnection(loadConnection()) }}
      sample={connection ? undefined : { onAddKey: () => setSettingUp(true) }}
      connection={connection ? {
        value: connection,
        onSave: (c) => { saveConnection(c); setServices(undefined); setConnection(loadConnection()) },
        onForget: () => { clearConnection(); markSettingsShared(); setServices(undefined); setConnection(undefined) },
      } : undefined}
    />
  )
}

/** Adding a key (from the sample): just how to reach a model. OpenRouter comes first, since one key there reaches many models. Everything else is in Settings, when it is wanted. */
function FirstRun({ onSave, onBack }: { onSave: (c: WriteConnection) => void; onBack: () => void }): React.JSX.Element {
  const [draft] = useState<WriteConnection>({ provider: 'openrouter', apiKey: '' })
  // The same Chat/Write drop-down as inside the app, so a first-time visitor can still reach Chat from here.
  const appSwitch = appSwitchHandler('write')
  return (
    <div className="write write--setup">
      <header className="write__bar">
        <h1 className="write__title"><a className="brand-link" href="https://myaielia.com" target="_blank" rel="noopener noreferrer" title="Go to myaielia.com">Aielia</a> {appSwitch ? <AppSwitcher current="write" onSelect={appSwitch} /> : 'Write'}</h1>
        <span className="write__badge" title="Early-stage alpha software — expect rough edges and breaking changes.">Alpha</span>
      </header>
      <main className="write__setup">
        <div className="write__setupcard">
          <button type="button" className="write__link write__setupback" onClick={onBack}>← Back to the sample</button>
          <h2>Connect your AI</h2>
          <p className="write__muted">Aielia has no account of its own. Add a key from a model provider to write with it; the key stays in this browser.</p>
          <DialogProvider><ConnectionSettings value={draft} onSave={onSave} showWeb={false} /></DialogProvider>
        </div>
        <div className="write__setupfoot">
          <ProxyNotice bare />
          <p>By using Aielia you agree to the <a href={TERMS_URL} target="_blank" rel="noreferrer">Terms</a> and acknowledge the <a href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy Policy</a>.</p>
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
