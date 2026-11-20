import { useCallback, useEffect, useRef, useState } from 'react'
import { AppleMailActions, tauriLocalMailSource, tauriScriptRunner, type AssistantConfig, type LocalMailActions, type LocalMailSource } from '@buildaharness/aielia'
import { appSwitchHandler, type AppId } from '../app-switch'
import { desktopEmailPlatform, type Invoke } from './desktop-platform'
import type { ILLMClient } from '@buildaharness/runtime'
import type { WorkbenchEvent } from '@buildaharness/aielia'
import { createSampleMailbox, type SampleMailbox } from './sample-mode'
import { createLocalMailbox } from './local-mode'
import { LocalMailSetup } from './LocalMailSetup'
import { monitorLog, startEmailMonitor } from './monitor'
import { SampleMailboxView } from './SampleMailboxView'
import '../write/write.css'

/** What the local-mail route needs from the desktop app. A test passes its own; the app builds it from Tauri's `invoke` when the user opens the setup. */
export interface LocalMailKit {
  source: LocalMailSource
  actions?: LocalMailActions
  listAccountNames?: () => Promise<Array<{ id: string; name: string }>>
  openFullDiskAccessSettings?: () => void
  appName?: string
  revealApp?: () => void
  restartApp?: () => void
}

/** A workbench event for the record: the long fields (what was sent to the model and what came back) are cut short. */
const briefly = (e: WorkbenchEvent): Record<string, unknown> => (e.kind === 'model_end' ? { kind: e.kind, n: e.n, label: e.label, ms: e.ms, prompt: e.prompt.slice(0, 300), response: e.response.slice(0, 300) } : { ...e })

async function tauriLocalKit(): Promise<LocalMailKit> {
  const core = await import('@tauri-apps/api/core')
  const invoke = core.invoke as Invoke
  const actions = new AppleMailActions(tauriScriptRunner(invoke))
  const appName = await import('@tauri-apps/api/app').then((m) => m.getName(), () => undefined)
  return {
    source: tauriLocalMailSource(invoke), actions, listAccountNames: () => actions.listAccounts(),
    openFullDiskAccessSettings: () => { void invoke('mail_local_open_privacy_settings', { pane: 'full_disk_access' }) },
    ...(appName ? { appName } : {}),
    revealApp: () => { void invoke('mail_local_reveal_app') },
    restartApp: () => { void invoke('mail_local_restart_app') },
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

  // A supervised test session can switch on a record of what is done here (only when the app was started with the monitor path; see monitor.ts).
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined
    let stop: (() => void) | undefined, gone = false
    void import('@tauri-apps/api/core').then(async (core) => { const s = await startEmailMonitor(core.invoke as Invoke); if (gone) s?.(); else stop = s }, () => undefined)
    return () => { gone = true; stop?.() }
  }, [])

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

  const [chosen, setChosen] = useState<{ ids: string[]; labels: Record<string, string>; active: string } | undefined>()
  const loaded = useRef(new Map<string, SampleMailbox>())

  /** One account at a time: its own folders, its own review, no ambiguity about which mail Aielia is looking at. Each is read once and kept. */
  const openAccount = async (id: string): Promise<void> => {
    if (!kit) return
    setBusy(true)
    monitorLog('open_account', { account: id.slice(0, 8), model: llm ? 'connected' : 'none' })
    try {
      let box = loaded.current.get(id)
      if (!box) {
        setActivity([])
        box = await createLocalMailbox({ source: kit.source, accountIds: [id], ...(kit.actions ? { actions: kit.actions } : {}), ...(llm ? { llm } : {}), onEvent: (e) => { setActivity((a) => [...a.slice(-300), e]); monitorLog('workbench', briefly(e)) } })
        loaded.current.set(id, box)
      }
      setMailbox(box)
      setChosen((c) => (c ? { ...c, active: id } : c))
      setSetup(false)
      monitorLog('mailbox_ready', { account: id.slice(0, 8) })
    } catch (e) {
      monitorLog('use_accounts_failed', { error: e instanceof Error ? e.message : String(e) })
      setNotice(`Aielia could not read that mail: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy(false) }
  }

  const chooseAccounts = async (ids: string[], labels: Record<string, string>): Promise<void> => {
    monitorLog('use_accounts', { accounts: ids.length })
    loaded.current.clear()
    setChosen({ ids, labels, active: ids[0]! })
    await openAccount(ids[0]!)
  }

  const appSwitch = appSwitchHandler('email', { desktop: (target) => (target === 'chat' ? onClose() : onSwitch?.(target)), desktopApp: true })

  if (error) return <div className="write-host"><div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div><p role="alert">Email could not start: {error}</p></div>
  if (!mailbox) return <div className="write-host"><div className="write-host__bar"><button type="button" onClick={onClose}>← Back to chat</button></div><p>Opening Email…</p></div>
  if (setup && kit) {
    return (
      <div className="write-host write local-setup-page">
        <LocalMailSetup
          source={kit.source} {...(kit.listAccountNames ? { listAccountNames: kit.listAccountNames } : {})} {...(kit.openFullDiskAccessSettings ? { openFullDiskAccessSettings: kit.openFullDiskAccessSettings } : {})} {...(kit.appName ? { appName: kit.appName } : {})} {...(kit.revealApp ? { revealApp: kit.revealApp } : {})} {...(kit.restartApp ? { restartApp: kit.restartApp } : {})}
          onUse={(ids, labels) => void chooseAccounts(ids, labels)}
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
      {chosen && chosen.ids.length > 1 && (
        <div className="write-host__bar write-host__accounts">
          <label>Account{' '}
            <select aria-label="Mail account" value={chosen.active} disabled={busy} onChange={(e) => void openAccount(e.target.value)}>
              {chosen.ids.map((id) => <option key={id} value={id}>{chosen.labels[id] ?? id.slice(0, 8)}</option>)}
            </select>
          </label>
          {busy && <span role="status"> Reading this account…</span>}
        </div>
      )}
      <SampleMailboxView sample={mailbox} onConnect={() => void openSetup()} appSwitch={appSwitch} activity={activity} />
    </div>
  )
}
