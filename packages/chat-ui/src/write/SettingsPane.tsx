import { useEffect, useState } from 'react'
import { callTypeLabel, type WritePermissions } from '@buildaharness/aielia'
import { ModelPicker } from './ModelPicker'

interface Props {
  perms: WritePermissions | undefined
  spent: number
  spentByType: { id: string; usd: number; calls: number }[]
  autoModel: string
  chatModel: string
  suggestions: string[]
  onAutoModel: (model: string) => void
  onSave: (p: WritePermissions) => Promise<void>
}

export function SettingsPane({ perms, spent, spentByType, autoModel, chatModel, suggestions, onAutoModel, onSave }: Props): React.JSX.Element {
  const [cap, setCap] = useState<string>('')
  useEffect(() => setCap(perms?.spendCapUsd !== undefined ? String(perms.spendCapUsd) : ''), [perms])
  if (!perms) return <p className="write__muted">Loading…</p>
  const save = (next: Partial<WritePermissions>): Promise<void> => onSave({ ...perms, ...next })
  return (
    <div className="write__form">
      <h2 className="write__panehead">Settings</h2>
      <p className="write__muted">Aielia only ever changes your text as suggestions you accept. These are the other things it may do on its own.</p>
      <label><input type="checkbox" checked={perms.captureChat} onChange={(e) => void save({ captureChat: e.target.checked })} /> Remember reviewer comments, decisions and corrections I mention in chat</label>
      <label><input type="checkbox" checked={perms.recheckBeforePublish} onChange={(e) => void save({ recheckBeforePublish: e.target.checked })} /> Read my web sources again before I publish, and tell me which changed</label>
      <label><input type="checkbox" checked={perms.autoCheck} onChange={(e) => void save({ autoCheck: e.target.checked })} /> Check claims and effects by itself when I stop typing (uses your key)</label>
      <label>Model for the automatic checks
        <ModelPicker label="Model for the automatic checks" value={autoModel} suggestions={suggestions} onChange={onAutoModel} />
      </label>
      {autoModel === chatModel && <p className="write__warn">The automatic checks use the same model as the chat. A different, smaller model gives you a second opinion and costs less.</p>}
      <label>Stop using my key after this much, in US dollars (blank for no limit)
        <input aria-label="Spending cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => { const n = Number(cap); void save({ spendCapUsd: cap.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined }) }} />
      </label>
      <p className="write__muted">Spent so far in this browser: ${spent.toFixed(2)}</p>
      {spentByType.length > 0 && (
        <details className="write__allsrc">
          <summary>Where it went</summary>
          <ul className="write__rows" aria-label="Spending by kind of call">
            {spentByType.map((t) => (
              <li key={t.id}><div className="write__rowmain">{callTypeLabel(t.id)}<div className="write__reason">${t.usd.toFixed(2)} · {t.calls} call{t.calls === 1 ? '' : 's'}</div></div></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
