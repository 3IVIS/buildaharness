import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FirstRun } from './FirstRun'
import { SampleMailboxView } from './SampleMailboxView'
import { createSampleMailbox, type SampleMailbox } from './sample-mode'
import { loadEmailConnection, saveEmailConnection, type EmailConnection } from './email-config'
import { registerEmailServiceWorker } from './register-sw'
import '../write/write.css'

/**
 * With no mail account the page opens the sample mailbox (the invented mailbox over the fake provider); first run, the two connection steps, is one click
 * away. Connecting a real mail account is wired in a later phase, so `account` is false for now and first run keeps asking for it.
 */
function Root(): React.JSX.Element {
  const [connection, setConnection] = useState<EmailConnection | undefined>(() => loadEmailConnection())
  const [settingUp, setSettingUp] = useState(false)
  const [sample, setSample] = useState<SampleMailbox | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (settingUp) return
    let live = true
    createSampleMailbox().then((s) => { if (live) setSample(s) }, (e) => setError(String(e)))
    return () => { live = false }
  }, [settingUp])

  if (error) return <p role="alert">Could not start: {error}</p>
  if (settingUp) {
    return (
      <FirstRun
        state={{ account: false, connection: !!connection }}
        onSaveConnection={(c) => { saveEmailConnection(c); setConnection(loadEmailConnection()) }}
        onSample={() => setSettingUp(false)}
      />
    )
  }
  if (!sample) return <p>Opening the sample mailbox…</p>
  return <SampleMailboxView sample={sample} onConnect={() => setSettingUp(true)} />
}

if (import.meta.env?.PROD) void registerEmailServiceWorker()
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
