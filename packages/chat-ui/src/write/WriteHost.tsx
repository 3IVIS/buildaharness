import { useEffect, useState } from 'react'
import type { AssistantConfig } from '@buildaharness/aielia'
import { WriteApp } from './WriteApp'
import { desktopWritePlatform } from './desktop-platform'
import { createWriteServicesFor, type WriteServices } from './write-services'

/**
 * Write as a screen of the desktop app. It uses the app's own connection (the model, the key or the Claude CLI session, and the search key), so
 * there is no second sign-in; its articles, spending cap and permissions are its own. Loaded only when opened (see App.tsx), so the chat does
 * not carry the Write code.
 */
export default function WriteHost({ config, onClose }: { config: AssistantConfig; onClose: () => void }): React.JSX.Element {
  const [services, setServices] = useState<WriteServices | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let live = true
    desktopWritePlatform(config)
      .then((platform) => createWriteServicesFor(config, platform))
      .then((s) => { if (live) setServices(s) }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [config])

  return (
    <div className="write-host">
      <div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div>
      {error ? <p role="alert">Write could not start: {error}</p> : services ? <WriteApp services={services} /> : <p>Opening your articles…</p>}
    </div>
  )
}
