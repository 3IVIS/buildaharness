import { useCallback, useEffect, useState } from 'react'
import type { LocalDiscovery, LocalMailSource } from '@buildaharness/aielia'
import { monitorLog } from './monitor'

interface Props {
  source: LocalMailSource
  /** Names for the mail program's accounts. Asking for them uses Mail's automation (a permission prompt), so it is offered, never done by itself. */
  listAccountNames?: () => Promise<Array<{ id: string; name: string }>>
  /** Opens the right pane of System Settings (the desktop app does this; a test passes a spy). */
  openFullDiskAccessSettings?: () => void
  onUse: (accountIds: string[]) => void
  /** The sign-in route that always exists. */
  onSignIn: () => void
  onCancel: () => void
}

type Phase = { kind: 'checking' } | { kind: 'ready'; d: LocalDiscovery } | { kind: 'blocked'; reason: string; d?: LocalDiscovery }

const SENTENCE: Record<string, { title: string; body: string }> = {
  permission_denied: { title: 'Aielia needs permission to read Apple Mail\'s folder', body: 'macOS keeps Mail\'s files private. To let Aielia read them, switch on Full Disk Access for Aielia in System Settings, then come back here and check again. This permission is broad, so it is optional: you can sign in to an account instead.' },
  not_found: { title: 'No Apple Mail mail was found on this computer', body: 'Either Mail has not been set up here yet, or it keeps its mail somewhere Aielia does not look. You can sign in to an account instead.' },
  unsupported_layout: { title: 'This version of Apple Mail stores mail in a way Aielia does not know yet', body: 'Aielia checked and stopped rather than guess, so nothing was read. You can sign in to an account instead.' },
  unsupported_platform: { title: 'Reading Apple Mail works on a Mac', body: 'On this computer you can sign in to an account instead.' },
}
const FALLBACK = { title: 'Aielia could not read Apple Mail', body: 'Nothing was read. You can sign in to an account instead.' }

/**
 * First run on the desktop app: use the mail Apple Mail already has, with no second sign-in. Says what it found (by account and count, never message
 * text), what it will and will not do (read only, nothing leaves this computer to read it), and why a permission is needed when it is. A refused
 * permission, a missing store or an unknown layout each end at the sign-in route, so the screen is never a dead end.
 */
export function LocalMailSetup({ source, listAccountNames, openFullDiskAccessSettings, onUse, onSignIn, onCancel }: Props): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [namesError, setNamesError] = useState<string | undefined>()

  const check = useCallback(async () => {
    setPhase({ kind: 'checking' })
    try {
      const d = await source.discover()
      monitorLog('local_discover', { available: d.available, reason: d.reason ?? null, layout: d.layout ?? null, accounts: d.accounts.length, messages: d.messageCount })
      if (d.available && d.accounts.length > 0) { setPicked(new Set(d.accounts.map((a) => a.id))); setPhase({ kind: 'ready', d }) }
      else setPhase({ kind: 'blocked', reason: d.available ? 'not_found' : String(d.reason ?? 'other'), d })
    } catch (e) {
      monitorLog('local_discover_error', { error: e instanceof Error ? e.message : String(e) })
      setPhase({ kind: 'blocked', reason: e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'other' })
    }
  }, [source])
  useEffect(() => { void check() }, [check])

  const showNames = async (): Promise<void> => {
    if (!listAccountNames) return
    setNamesError(undefined)
    try { setNames(new Map((await listAccountNames()).map((a) => [a.id, a.name]))) } catch (e) { setNamesError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <section className="local-setup" aria-label="Use the mail on this computer">
      <h2>Use the mail already on this computer</h2>
      {phase.kind === 'checking' && <p role="status">Looking for Apple Mail…</p>}
      {phase.kind === 'ready' && (
        <>
          <p>Aielia found these accounts in Apple Mail. It reads what Mail has already downloaded, so you do not sign in again. Reading is read-only and nothing is sent anywhere to do it.</p>
          <ul className="local-setup__accounts">
            {phase.d.accounts.map((a, i) => (
              <li key={`${a.scheme}:${a.id}`}>
                <label>
                  <input type="checkbox" checked={picked.has(a.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(a.id); else n.delete(a.id); setPicked(n) }} />
                  {' '}{names.get(a.id) ?? (a.scheme === 'local' ? 'On this computer' : `Account ${i + 1}`)}
                  <span className="local-setup__count"> {a.messages.toLocaleString()} messages, {a.mailboxes} folders</span>
                </label>
              </li>
            ))}
          </ul>
          {listAccountNames && names.size === 0 && <p><button type="button" onClick={() => void showNames()}>Show account names</button> <span className="local-setup__note">This asks Mail for its account names, and macOS will ask you to allow it.</span></p>}
          {namesError && <p role="alert">Could not get the names: {namesError}</p>}
          <p className="local-setup__note">Aielia never reads an account&apos;s text with the AI until you switch that on for the account in Settings. Moving, flagging and saving drafts go through Mail itself and ask for one more permission the first time. Sending is always done by you in Mail.</p>
          <p>
            <button type="button" className="reply__primary" disabled={picked.size === 0} onClick={() => onUse([...picked])}>Use these accounts</button>
            {' '}<button type="button" onClick={onSignIn}>Sign in to an account instead</button>
            {' '}<button type="button" onClick={onCancel}>Back</button>
          </p>
        </>
      )}
      {phase.kind === 'blocked' && (() => {
        const s = SENTENCE[phase.reason] ?? FALLBACK
        return (
          <div role="group" aria-label={s.title}>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            {phase.reason === 'permission_denied' && (
              <ol>
                <li>Open System Settings, Privacy &amp; Security, Full Disk Access.</li>
                <li>Switch on Aielia (add it with the + button if it is not listed).</li>
                <li>Come back here and press Check again.</li>
              </ol>
            )}
            <p>
              {phase.reason === 'permission_denied' && openFullDiskAccessSettings && <><button type="button" onClick={openFullDiskAccessSettings}>Open System Settings</button>{' '}</>}
              {(phase.reason === 'permission_denied' || phase.reason === 'not_found') && <><button type="button" onClick={() => void check()}>Check again</button>{' '}</>}
              <button type="button" className="reply__primary" onClick={onSignIn}>Sign in to an account instead</button>
              {' '}<button type="button" onClick={onCancel}>Back</button>
            </p>
          </div>
        )
      })()}
    </section>
  )
}
