import { useCallback, useEffect, useState } from 'react'
import { AppleMailActions, tauriLocalMailSource, tauriScriptRunner, type AssistantConfig, type LocalMailActions, type LocalMailSource } from '@buildaharness/aielia'
import { appSwitchHandler, type AppId } from '../app-switch'
import { desktopEmailPlatform, type Invoke } from './desktop-platform'
import type { ILLMClient } from '@buildaharness/runtime'
import type { WorkbenchEvent } from '@buildaharness/aielia'
import { createSampleMailbox, type SampleMailbox } from './sample-mode'
import { createLocalMailbox } from './local-mode'
import { LocalMailSetup } from './LocalMailSetup'
import { SampleMailboxView } from './SampleMailboxView'
import '../write/write.css'

/** What the local-mail route needs from the desktop app. A test passes its own; the app builds it from Tauri's `invoke` when the user opens the setup. */
export interface LocalMailKit {
  source: LocalMailSource
  actions?: LocalMailActions
  listAccountNames?: () => Promise<Array<{ id: string; name: string }>>
  openFullDiskAccessSettings?: () => void
}

async function tauriLocalKit(): Promise<LocalMailKit> {
  const core = await import('@tauri-apps/api/core')
  const invoke = core.invoke as Invoke
  const actions = new AppleMailActions(tauriScriptRunner(invoke))
  return {
    source: tauriLocalMailSource(invoke), actions, listAccountNames: () => actions.listAccounts(),
    openFullDiskAccessSettings: () => { void invoke('mail_local_open_privacy_settings', { pane: 'full_disk_access' }) },
  }
}

/**
 * Email as a screen of the desktop app. It uses the app's own model connection (no second sign-in) and reaches mail only through Rust commands
 * (network and secrets behind the F7 interfaces). Loaded only when opened (see App.tsx). It opens on the sample mailbox. "Connect" offers the mail Apple Mail
 * already has on this computer (no second sign-in, read-only); the sign-in route is not wired in the desktop app yet and says so.
 */
export default function EmailHost({ config, onClose, onSwitch, localKit }: { config: AssistantConfig; onClose: () => void; onSwitch?: (target: AppId) => void; localKit?: LocalMailKit }): React.JSX.Element {
  const [mailbox, setMailbox] = useState<SampleMailbox | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [kit, setKit] = useState<LocalMailKit | undefined>()
  const [setup, setSetup] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [llm, setLlm] = useState<ILLMClient | undefined>()
  const [activity, setActivity] = useState<WorkbenchEvent[]>([])

  useEffect(() => {
    let live = true
    // The platform is built first so a missing Tauri plugin is reported here, not later in the middle of mail work.
    desktopEmailPlatform(config)
      .then((p) => { if (live) setLlm(p.llm); return createSampleMailbox() })
      .then((s) => { if (live) setMailbox(s) }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [config])

  const openSetup = useCallback(async () => {
    setNotice(undefined)
    try { setKit(localKit ?? (await tauriLocalKit())); setSetup(true) } catch (e) { setNotice(`Reading the mail on this computer is not available: ${e instanceof Error ? e.message : String(e)}`) }
  }, [localKit])

  const chooseAccounts = async (ids: string[]): Promise<void> => {
    if (!kit) return
    setBusy(true)
    try {
      setActivity([])
      setMailbox(await createLocalMailbox({ source: kit.source, accountIds: ids, ...(kit.actions ? { actions: kit.actions } : {}), ...(llm ? { llm } : {}), onEvent: (e) => setActivity((a) => [...a.slice(-300), e]) }))
      setSetup(false)
    } catch (e) {
      setNotice(`Aielia could not read that mail: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy(false) }
  }

  const appSwitch = appSwitchHandler('email', { desktop: (target) => (target === 'chat' ? onClose() : onSwitch?.(target)), desktopApp: true })

  if (error) return <div className="write-host"><div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div><p role="alert">Email could not start: {error}</p></div>
  if (!mailbox) return <div className="write-host"><div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div><p>Opening Email…</p></div>
  if (setup && kit) {
    return (
      <div className="write-host">
        <LocalMailSetup
          source={kit.source} {...(kit.listAccountNames ? { listAccountNames: kit.listAccountNames } : {})} {...(kit.openFullDiskAccessSettings ? { openFullDiskAccessSettings: kit.openFullDiskAccessSettings } : {})}
          onUse={(ids) => void chooseAccounts(ids)}
          onSignIn={() => { setSetup(false); setNotice('Signing in to an account is not available in the desktop app yet. Reading the mail Apple Mail already has works without it.') }}
          onCancel={() => setSetup(false)}
        />
        {busy && <p role="status">Reading your mail…</p>}
        {notice && <p role="alert">{notice}</p>}
      </div>
    )
  }
  return (
    <div className="write-host">
      {notice && <p role="status" className="write-host__notice">{notice}</p>}
      <SampleMailboxView sample={mailbox} onConnect={() => void openSetup()} appSwitch={appSwitch} activity={activity} />
    </div>
  )
}
