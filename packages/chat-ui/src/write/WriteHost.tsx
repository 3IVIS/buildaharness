import { useEffect, useState } from 'react'
import type { AssistantConfig } from '@buildaharness/aielia'
import { WriteApp } from './WriteApp'
import { desktopWritePlatform } from './desktop-platform'
import { createWriteServicesFor, type WriteServices } from './write-services'
import { appSwitchHandler } from '../app-switch'

/**
 * Write as a screen of the desktop app. It uses the app's own connection (the model, the key or the Claude CLI session, and the search key), so
 * there is no second sign-in; its articles, spending cap and permissions are its own. Loaded only when opened (see App.tsx), so the chat does
 * not carry the Write code.
 */
export default function WriteHost({ config, onClose }: { config: AssistantConfig; onClose: () => void }): React.JSX.Element {
  const [services, setServices] = useState<WriteServices | undefined>()
  const [error, setError] = useState<string | undefined>()
  // Bumped after all the data was deleted, so the services are built again from the empty store.
  const [fresh, setFresh] = useState(0)

  useEffect(() => {
    let live = true
    desktopWritePlatform(config)
      .then((platform) => createWriteServicesFor(config, platform))
      .then((s) => { if (live) setServices(s) }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [config, fresh])

  // Inside the desktop app the switch is in place: the chat screen takes over again.
  const appSwitch = appSwitchHandler('write', { desktop: () => onClose(), desktopApp: true })

  return (
    <div className="write-host">
      {/* Once Write is open, the way back is the Chat/Write drop-down in its title; until then (opening, or failed to start) a plain button. */}
      {services ? <WriteApp services={services} appSwitch={appSwitch} onDeleted={() => { setServices(undefined); setFresh((n) => n + 1) }} /> : (
        <>
          <div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div>
          {error ? <p role="alert">Write could not start: {error}</p> : <p>Opening your articles…</p>}
        </>
      )}
    </div>
  )
}
