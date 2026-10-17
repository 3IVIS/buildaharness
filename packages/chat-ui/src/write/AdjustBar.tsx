import { useId, useState } from 'react'
import { PARAMETER_GROUPS, WRITE_PARAMETERS, adjustmentInstruction, findParameter } from '@buildaharness/aielia'

export type ChatAction = 'check' | 'verify'

/**
 * One dropdown for the chat: what to adjust (a parameter from the table, or "something else"), or an action to run (check the article). Pick a
 * parameter and a box appears to choose an option or type your own; press Enter and it is sent as an ordinary chat message. An action runs
 * as soon as it is picked.
 */
export function AdjustBar({ disabled, checkLabel, verifyLabel, onSend, onAction }: { disabled: boolean; checkLabel: string; verifyLabel: string; onSend: (message: string) => void; onAction: (action: ChatAction) => void }): React.JSX.Element {
  const listId = useId()
  const [paramId, setParamId] = useState('')
  const [aspect, setAspect] = useState('')
  const [value, setValue] = useState('')
  const param = findParameter(paramId)
  const other = paramId === 'other'
  const label = other ? aspect : param?.label ?? ''
  const ready = label.trim() !== '' && value.trim() !== ''

  function send(): void {
    if (!ready || disabled) return
    onSend(adjustmentInstruction(label, value, param?.kind ?? 'setting'))
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
          setParamId(e.target.value)
          setValue('')
        }}
      >
        <option value="">Adjust or do…</option>
        <optgroup label="Do">
          <option value="action:check">{checkLabel}</option>
          <option value="action:verify">{verifyLabel}</option>
        </optgroup>
        {PARAMETER_GROUPS.map((g) => (
          <optgroup key={g.id} label={g.label}>
            {WRITE_PARAMETERS.filter((x) => x.group === g.id).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </optgroup>
        ))}
        <option value="other">Something else…</option>
      </select>
      {other && <input aria-label="What to adjust" value={aspect} onChange={(e) => setAspect(e.target.value)} placeholder="What to adjust, for example pacing" />}
      {paramId !== '' && (
        <>
          <input aria-label="How" list={listId} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }} placeholder={other ? 'How, in your own words, then Enter' : 'Pick an option or type your own, then Enter'} />
          <datalist id={listId}>{(param?.options ?? []).map((o) => <option key={o} value={o} />)}</datalist>
        </>
      )}
    </div>
  )
}
