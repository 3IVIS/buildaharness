import { useEffect, useState } from 'react'
import { type WritePermissions } from '@buildaharness/aielia'
import { ModelPicker } from './ModelPicker'
import { ConnectionSettings } from './ConnectionSettings'
import { Hint } from './Hint'
import type { WriteConnection } from './write-config'

interface Props {
  perms: WritePermissions | undefined
  autoModel: string
  chatModel: string
  suggestions: string[]
  onAutoModel: (model: string) => void
  onSave: (p: WritePermissions) => Promise<void>
  /** The connection to the model and the web, when this page owns it. */
  connection?: { value: WriteConnection; onSave: (c: WriteConnection) => void; onForget: () => void }
  /** A GitHub token field, for a host where Write keeps the token itself (there is no connection screen to hold it). */
  /** Where the spending is counted: 'browser' (default) or 'app'. */
  hostName?: 'browser' | 'app'
  github?: { token: string | undefined; onSave: (token: string | undefined) => Promise<void> }
  /** Deletes everything the writer has stored here, after asking. */
  onDeleteAll?: () => void
  busy?: boolean
}

export function SettingsPane({ perms, autoModel, chatModel, suggestions, onAutoModel, onSave, connection, github, hostName = 'browser', onDeleteAll, busy }: Props): React.JSX.Element {
  const [cap, setCap] = useState<string>('')
  const [ghToken, setGhToken] = useState<string>(github?.token ?? '')
  useEffect(() => setCap(perms?.spendCapUsd !== undefined ? String(perms.spendCapUsd) : ''), [perms])
  if (!perms) return <p className="write__muted">Loading…</p>
  const save = (next: Partial<WritePermissions>): Promise<void> => onSave({ ...perms, ...next })
  return (
    <div className="write__form">
      <h2 className="write__panehead">Settings<Hint text="Aielia only changes your text through suggestions you accept. These are the other things it may do on its own." /></h2>
      {connection && <ConnectionSettings value={connection.value} onSave={connection.onSave} onForget={connection.onForget} />}
      {github && (
        <label>GitHub token<Hint text="Only needed to read a private repository, or to avoid GitHub's request limit. Sent only to GitHub." />
          <input aria-label="GitHub token" type="password" autoComplete="off" value={ghToken} onChange={(e) => setGhToken(e.target.value)} onBlur={() => { if (ghToken.trim() !== (github.token ?? '')) void github.onSave(ghToken.trim() || undefined) }} />
        </label>
      )}
      <label><input type="checkbox" checked={perms.captureChat} onChange={(e) => void save({ captureChat: e.target.checked })} /> Remember what I say in chat<Hint text="Reviewer comments, decisions and corrections you mention are kept with the article." /></label>
      <label><input type="checkbox" checked={perms.recheckBeforePublish} onChange={(e) => void save({ recheckBeforePublish: e.target.checked })} /> Reread web sources before publishing<Hint text="Reads your web sources again before you publish and tells you which changed." /></label>
      <label><input type="checkbox" checked={perms.autoCheck} onChange={(e) => void save({ autoCheck: e.target.checked })} /> Check by itself when I stop typing<Hint text="Looks for claims and checks what an edit affects after each pause. Uses your key." /></label>
      <label>Model for automatic checks
        <ModelPicker label="Model for the automatic checks" value={autoModel} suggestions={suggestions} onChange={onAutoModel} />
      </label>
      {autoModel === chatModel && <p className="write__warn">Same model as the chat<Hint text="A different, smaller model gives you a second opinion and costs less." /></p>}
      <label>Spending cap, US$<Hint text="Stops using your key after this much. Leave blank for no limit." />
        <input aria-label="Spending cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => { const n = Number(cap); void save({ spendCapUsd: cap.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined }) }} />
      </label>
      {onDeleteAll && (
        <div className="write__danger">
          <button type="button" className="write__dangerbtn" onClick={onDeleteAll} disabled={busy}>Delete all my data</button>
          <p className="write__muted">Removes every article with its versions, comments and sources, the chat, your settings and the spending record from this {hostName}. Your key stays.</p>
        </div>
      )}
    </div>
  )
}
