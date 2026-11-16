import { useEffect, useRef, useState } from 'react'

/**
 * A model id box with a dropdown on its right. Pick a model that is known to be available, or type any id. The typed id is applied when the
 * box loses focus or Enter is pressed; a pick from the list is applied at once.
 */
export function ModelPicker({ label, value, suggestions, onChange, placeholder }: { label: string; value: string; suggestions: string[]; onChange: (model: string) => void; /** Shown while the box is empty (a backend whose own default model is used). */ placeholder?: string }): React.JSX.Element {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement | null>(null)
  useEffect(() => setText(value), [value])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const commit = (): void => {
    const m = text.trim()
    if (m && m !== value) onChange(m)
    else setText(value)
  }
  return (
    <span className="write__model" ref={box}>
      <input aria-label={label} title={label} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} spellCheck={false} />
      <button type="button" className="write__chev" aria-label={`${label}: choose from the list`} aria-haspopup="listbox" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul className="write__menu write__menu--right" role="listbox" aria-label={`${label}: models`}>
          {suggestions.length === 0 && <li className="write__muted">No list for this provider. Type a model id.</li>}
          {suggestions.map((m) => (
            <li key={m} role="option" aria-selected={m === value}>
              <button type="button" className={m === value ? 'is-on' : ''} onClick={() => { setOpen(false); setText(m); if (m !== value) onChange(m) }}>{m}</button>
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}
