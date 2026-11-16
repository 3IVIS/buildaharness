import { useState } from 'react'
import { type DisconnectResult, type MailPermissions, type MailPrivacy } from '@buildaharness/aielia'

export interface SettingsAccount { id: string; address: string; provider: string; privacy: MailPrivacy }

interface Props {
  accounts: SettingsAccount[]
  permissions: MailPermissions
  onPrivacy: (accountId: string, next: MailPrivacy) => void
  onPermissions: (next: MailPermissions) => void
  onDisconnect: (accountId: string) => Promise<DisconnectResult>
  onDeleteAll: () => Promise<void>
}

const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean)

/** Email settings: per-account read switch and exclusions, what Aielia may do alone, the spending cap, delete all data, disconnect an account. */
export function MailSettings(p: Props): React.JSX.Element {
  const [revoke, setRevoke] = useState<DisconnectResult | null>(null)
  const [confirm, setConfirm] = useState<'all' | string | null>(null)
  const [deleted, setDeleted] = useState(false)
  return (
    <div className="email-settings">
      <h2>Email settings</h2>
      {p.accounts.map((a) => (
        <fieldset key={a.id} aria-label={`Account ${a.address}`}>
          <legend>{a.address}</legend>
          <label><input type="checkbox" checked={a.privacy.aieliaMayRead} onChange={(e) => p.onPrivacy(a.id, { ...a.privacy, aieliaMayRead: e.target.checked })} /> Aielia may read this account&apos;s mail</label>
          {!a.privacy.aieliaMayRead && <p className="email-settings__note">Switched off: no text of this account is sent to the AI.</p>}
          <label>Never read these folders (comma separated)
            <input aria-label={`Excluded folders for ${a.address}`} defaultValue={a.privacy.excludedFolders.join(', ')} onBlur={(e) => p.onPrivacy(a.id, { ...a.privacy, excludedFolders: list(e.target.value) })} />
          </label>
          <label>Never read mail from (addresses, or @domain)
            <input aria-label={`Excluded senders for ${a.address}`} defaultValue={a.privacy.excludedSenders.join(', ')} onBlur={(e) => p.onPrivacy(a.id, { ...a.privacy, excludedSenders: list(e.target.value) })} />
          </label>
          {confirm === a.id ? (
            <span role="alertdialog" aria-label="Confirm disconnect">
              Remove the sign-in and every stored message of {a.address} from this device?
              <button type="button" onClick={async () => { setRevoke(await p.onDisconnect(a.id)); setConfirm(null) }}>Disconnect</button>
              <button type="button" onClick={() => setConfirm(null)}>Keep</button>
            </span>
          ) : <button type="button" onClick={() => setConfirm(a.id)}>Disconnect {a.address}</button>}
        </fieldset>
      ))}
      {revoke && (
        <div role="status" className="email-settings__revoke">
          <p>Disconnected. The token and the stored mail are gone from this device. The permission you gave still exists at {revoke.revoke.where} until you remove it there.</p>
          <p>{revoke.revoke.steps}</p>
          {revoke.revoke.url && <p><a href={revoke.revoke.url} target="_blank" rel="noreferrer noopener">{revoke.revoke.url}</a></p>}
        </div>
      )}
      <fieldset aria-label="What Aielia may do alone">
        <legend>What Aielia may do without asking</legend>
        <label><input type="checkbox" checked={p.permissions.organiseWithoutAsking} onChange={(e) => p.onPermissions({ ...p.permissions, organiseWithoutAsking: e.target.checked })} /> File and label mail (each change is logged and can be undone)</label>
        <p className="email-settings__note">Sending a message always needs your approval.</p>
        <label>Spending cap in dollars (empty means none)
          <input aria-label="Spending cap" inputMode="decimal" defaultValue={p.permissions.spendCapUsd ?? ''} onBlur={(e) => {
            const n = Number(e.target.value)
            const { spendCapUsd: _drop, ...rest } = p.permissions
            p.onPermissions(e.target.value.trim() && Number.isFinite(n) && n > 0 ? { ...rest, spendCapUsd: n } : rest)
          }} />
        </label>
      </fieldset>
      <div>
        {confirm === 'all' ? (
          <span role="alertdialog" aria-label="Confirm delete all data">
            Delete every account&apos;s sign-in, stored mail, settings and spend totals from this device?
            <button type="button" onClick={async () => { await p.onDeleteAll(); setConfirm(null); setDeleted(true) }}>Delete everything</button>
            <button type="button" onClick={() => setConfirm(null)}>Keep</button>
          </span>
        ) : <button type="button" onClick={() => setConfirm('all')}>Delete all data</button>}
        {deleted && <p role="status">All Email data on this device was deleted.</p>}
      </div>
    </div>
  )
}
