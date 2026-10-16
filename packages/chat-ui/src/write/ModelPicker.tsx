import { useEffect, useId, useState } from 'react'

/** A model id box with suggestions. Any id can be typed; the list only suggests. The change is applied when the box loses focus or Enter is pressed. */
export function ModelPicker({ label, value, suggestions, onChange }: { label: string; value: string; suggestions: string[]; onChange: (model: string) => void }): React.JSX.Element {
  const listId = useId()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = (): void => {
    const m = text.trim()
    if (m && m !== value) onChange(m)
    else setText(value)
  }
  return (
    <span className="write__model">
      <input aria-label={label} title={label} list={listId} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }} spellCheck={false} />
      <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
    </span>
  )
}
