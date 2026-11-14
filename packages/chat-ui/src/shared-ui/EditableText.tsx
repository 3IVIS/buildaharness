import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onSave: (value: string) => void
  /** What a screen reader calls it. */
  label: string
  /** Several lines: Enter saves, Shift+Enter starts a new line. */
  multiline?: boolean
  /** `click` (the default) edits on a click; `dblclick` leaves a single click for `onActivate`. */
  trigger?: 'click' | 'dblclick'
  onActivate?: () => void
  placeholder?: string
  className?: string
  /** Allow saving an empty value (to clear something). */
  allowEmpty?: boolean
}

/** Text that is edited where it stands: click it, type, press Enter (Escape puts it back). Leaving the box saves too. */
export function EditableText({ value, onSave, label, multiline = false, trigger = 'click', onActivate, placeholder, className, allowEmpty = false }: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const box = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  useEffect(() => { if (!editing) setText(value) }, [value, editing])
  useEffect(() => { if (editing) box.current?.focus() }, [editing])

  const finish = (save: boolean): void => {
    setEditing(false)
    const next = text.trim()
    if (save && next !== value.trim() && (next !== '' || allowEmpty)) onSave(next)
    else setText(value)
  }

  if (editing) {
    const common = {
      'aria-label': label,
      value: text,
      className: `write__editing ${className ?? ''}`,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
      onBlur: () => finish(true),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false) }
        else if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); finish(true) }
      },
    }
    return multiline
      ? <textarea ref={(el) => { box.current = el }} rows={2} {...common} />
      : <input ref={(el) => { box.current = el }} {...common} />
  }
  const show = value.trim() === '' ? (placeholder ?? '') : value
  const start = (): void => setEditing(true)
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={trigger === 'dblclick' ? 'Double-click to edit' : 'Click to edit'}
      className={`write__editable ${value.trim() === '' ? 'is-empty' : ''} ${className ?? ''}`}
      onClick={trigger === 'click' ? start : onActivate}
      onDoubleClick={trigger === 'dblclick' ? start : undefined}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); start() } }}
    >
      {show}
    </span>
  )
}
