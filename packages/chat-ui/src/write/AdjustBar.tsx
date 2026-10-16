import { useId, useState } from 'react'
import { PARAMETER_GROUPS, WRITE_PARAMETERS, adjustmentInstruction, findParameter } from '@buildaharness/aielia'

/**
 * Two dropdowns for the chat: first what to adjust (a parameter, or "something else"), then a box where the writer picks an option or types
 * their own. Sending composes an instruction and hands it to the chat as an ordinary message.
 */
export function AdjustBar({ disabled, onSend }: { disabled: boolean; onSend: (message: string) => void }): React.JSX.Element {
  const listId = useId()
  const [paramId, setParamId] = useState('')
  const [aspect, setAspect] = useState('')
  const [value, setValue] = useState('')
  const param = findParameter(paramId)
  const other = paramId === 'other'
  const label = other ? aspect : param?.label ?? ''
  const ready = label.trim() !== '' && value.trim() !== ''

  function send(): void {
    if (!ready) return
    onSend(adjustmentInstruction(label, value, param?.kind ?? 'setting'))
    setValue('')
  }

  return (
    <div className="write__adjust" role="group" aria-label="Adjust">
      <select aria-label="Adjust" value={paramId} onChange={(e) => { setParamId(e.target.value); setValue('') }}>
        <option value="">Adjust…</option>
        {PARAMETER_GROUPS.map((g) => (
          <optgroup key={g.id} label={g.label}>
            {WRITE_PARAMETERS.filter((x) => x.group === g.id).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </optgroup>
        ))}
        <option value="other">Something else…</option>
      </select>
      {other && <input aria-label="What to adjust" value={aspect} onChange={(e) => setAspect(e.target.value)} placeholder="What to adjust, e.g. pacing" />}
      {paramId !== '' && (
        <>
          <input aria-label="How" list={listId} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }} placeholder={other ? 'How, in your own words' : 'Pick an option or type your own'} />
          <datalist id={listId}>{(param?.options ?? []).map((o) => <option key={o} value={o} />)}</datalist>
          <button type="button" onClick={send} disabled={disabled || !ready}>Send adjustment</button>
        </>
      )}
    </div>
  )
}
