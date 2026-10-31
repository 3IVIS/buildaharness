import { useEffect, useRef, useState } from 'react'
import { APP_LABEL, type AppId } from '../app-switch'
import './app-switcher.css'

const ORDER: AppId[] = ['chat', 'write']

/**
 * The small drop-down after "Aielia" in the page title: "Chat ▾" / "Write ▾". It lists both screens, marks the open one, and
 * calls onSelect for the other. Shown only where there is a place to switch to (see appSwitchHandler).
 */
export function AppSwitcher({ current, onSelect, disabled = false }: { current: AppId; onSelect: (target: AppId) => void; disabled?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Opening puts the focus on the open screen's item, so the arrow keys and Enter work at once.
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [open])

  function close(refocus: boolean): void {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  function onMenuKey(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <span className="app-switcher" ref={root}>
      <button
        type="button"
        ref={button}
        className="app-switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch between Aielia Chat and Aielia Write"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {APP_LABEL[current]}<span className="app-switcher__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="app-switcher__menu" role="menu" aria-label="Switch app" onKeyDown={onMenuKey}>
          {ORDER.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === current}
              className="app-switcher__item"
              onClick={() => { close(true); if (id !== current) onSelect(id) }}
            >
              <span className="app-switcher__check" aria-hidden="true">{id === current ? '✓' : ''}</span>Aielia {APP_LABEL[id]}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
