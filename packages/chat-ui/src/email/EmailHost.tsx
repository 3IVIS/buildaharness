import { useEffect, useState } from 'react'
import type { AssistantConfig } from '@buildaharness/aielia'
import { appSwitchHandler, type AppId } from '../app-switch'
import { desktopEmailPlatform } from './desktop-platform'
import { createSampleMailbox, type SampleMailbox } from './sample-mode'
import { SampleMailboxView } from './SampleMailboxView'
import '../write/write.css'

/**
 * Email as a screen of the desktop app. It uses the app's own model connection (no second sign-in) and reaches mail only through Rust commands
 * (network and secrets behind the F7 interfaces). Loaded only when opened (see App.tsx). Until a real mail account is connected (a later phase)
 * it shows the sample mailbox, as the web page does.
 */
export default function EmailHost({ config, onClose, onSwitch }: { config: AssistantConfig; onClose: () => void; onSwitch?: (target: AppId) => void }): React.JSX.Element {
  const [sample, setSample] = useState<SampleMailbox | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let live = true
    // The platform is built first so a missing Tauri plugin is reported here, not later in the middle of mail work.
    desktopEmailPlatform(config)
      .then(() => createSampleMailbox())
      .then((s) => { if (live) setSample(s) }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [config])

  const appSwitch = appSwitchHandler('email', { desktop: (target) => (target === 'chat' ? onClose() : onSwitch?.(target)), desktopApp: true })

  if (error) return <div className="write-host"><div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div><p role="alert">Email could not start: {error}</p></div>
  if (!sample) return <div className="write-host"><div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div><p>Opening Email…</p></div>
  return <div className="write-host"><SampleMailboxView sample={sample} onConnect={() => undefined} appSwitch={appSwitch} /></div>
}
