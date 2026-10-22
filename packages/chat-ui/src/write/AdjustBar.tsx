import { useId, useState } from 'react'
import { ICON_PATHS, Icon } from './icons'
import { PARAMETER_GROUPS, adjustmentChoices, adjustmentFromText, type ParameterGroup } from '@buildaharness/aielia'

export type ChatAction = 'check' | 'verify' | 'prepare'

/**
 * One dropdown for the chat: a category of adjustment (or "something else"), or an action to run (check the article). Pick a category and one
 * box appears, with that category's "Aspect: option" suggestions to choose from or your own words; press Enter and it is sent as an ordinary
 * chat message. An action runs as soon as it is picked.
 */
export function AdjustBar({ disabled, checkLabel, verifyLabel, repos = [], onRepoVerify, onPickRepoFolder, onRemoveRepo, onSend, onAction }: { disabled: boolean; checkLabel: string; verifyLabel: string; /** Repositories already handed to the article. */ repos?: string[]; /** Runs the check against a repository: the address typed (empty means the ones already attached). Absent: the option is not offered. */ onRepoVerify?: (address: string) => void; onPickRepoFolder?: () => void; onRemoveRepo?: (name: string) => void; onSend: (message: string) => void; onAction: (action: ChatAction) => void }): React.JSX.Element {
  const listId = useId()
  const [paramId, setParamId] = useState('')
  const [value, setValue] = useState('')
  const repoMode = paramId === 'action:verify_repo'
  const [repoAddress, setRepoAddress] = useState('')
  const other = paramId === 'other'
  const group = PARAMETER_GROUPS.find((g) => g.id === paramId)?.id as ParameterGroup | undefined

  function send(): void {
    if (value.trim() === '' || disabled) return
    onSend(adjustmentFromText(group, value))
    setValue('')
  }

  return (
    <div className="write__adjust" role="group" aria-label="Adjust">
      <select
        aria-label="Adjust"
        value={paramId}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === 'action:check') { setParamId(''); onAction('check'); return }
          if (e.target.value === 'action:verify') { setParamId(''); onAction('verify'); return }
          if (e.target.value === 'action:prepare') { setParamId(''); onAction('prepare'); return }
          setParamId(e.target.value)
          setValue('')
        }}
      >
        <option value="">Adjust or do…</option>
        <optgroup label="Do">
          <option value="action:check">{checkLabel}</option>
          <option value="action:verify">{verifyLabel}</option>
          {onRepoVerify && <option value="action:verify_repo">Verify the claims against a repository</option>}
          <option value="action:prepare">Fill in the style and links from the article</option>
        </optgroup>
        <optgroup label="Adjust">
          {PARAMETER_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          <option value="other">Something else…</option>
        </optgroup>
      </select>
      {repoMode && onRepoVerify && (
        <div className="write__repobox" role="group" aria-label="Repository to check against">
          {repos.map((r) => (
            <span key={r} className="write__chip">{r}{onRemoveRepo && <button type="button" className="write__chipx" aria-label={`Stop using ${r}`} onClick={() => onRemoveRepo(r)}>×</button>}</span>
          ))}
          <input
            aria-label="Repository address"
            value={repoAddress}
            disabled={disabled}
            autoFocus
            onChange={(e) => setRepoAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const a = repoAddress; setRepoAddress(''); setParamId(''); onRepoVerify(a) } }}
            placeholder={repos.length > 0 ? 'Another GitHub address, or Enter to use the ones above' : 'github.com/owner/repo, then Enter'}
          />
          {onPickRepoFolder && <button type="button" className="write__iconbtn" aria-label="Use a repository folder on this computer" title="Use a repository folder on this computer" disabled={disabled} onClick={() => { setParamId(''); onPickRepoFolder() }}><Icon d={ICON_PATHS.folder} /></button>}
        </div>
      )}
      {paramId !== '' && !repoMode && (
        <>
          <input aria-label="How" list={listId} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }} placeholder={other ? 'What to change, in your own words, then Enter' : 'Pick a suggestion or type your own, then Enter'} />
          <datalist id={listId}>{group && adjustmentChoices(group).map((o) => <option key={o} value={o} />)}</datalist>
        </>
      )}
    </div>
  )
}
