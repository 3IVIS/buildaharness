import { useEffect, useRef, useState } from 'react'

export interface ArticleItem {
  id: string
  title: string
  name?: string
}

const shownName = (a: ArticleItem): string => (a.name ?? a.title) || 'Untitled'

/** The article's short name in the header, cut off with an ellipsis when it is long. Opens a list of articles and a way to rename the current one. */
export function ArticleSwitcher({ articles, activeId, onSelect, onRename, onNew, onExport, onImport }: { articles: ArticleItem[]; activeId: string | undefined; onSelect: (id: string) => void; onRename: () => void; onNew: () => void; onExport: () => void; onImport: (file: File) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const active = articles.find((a) => a.id === activeId)
  return (
    <div className="write__switcher" ref={box}>
      <button type="button" className="write__switch" aria-haspopup="listbox" aria-expanded={open} aria-label="Article" title={active ? shownName(active) : 'No articles yet'} onClick={() => setOpen((o) => !o)}>
        <span className="write__switchname">{active ? shownName(active) : 'No articles yet'}</span>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <input ref={picker} type="file" accept="application/json,.json" hidden aria-label="Choose an exported article" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = '' }} />
      {open && (
        <ul className="write__menu" role="listbox" aria-label="Articles">
          {articles.map((a) => (
            <li key={a.id} role="option" aria-selected={a.id === activeId}>
              <button type="button" className={a.id === activeId ? 'is-on' : ''} title={shownName(a)} onClick={() => { setOpen(false); onSelect(a.id) }}><span className="write__switchname">{shownName(a)}</span></button>
            </li>
          ))}
          <li role="presentation" className="write__menu-sep"><button type="button" onClick={() => { setOpen(false); onNew() }}>New article…</button></li>
          <li role="presentation"><button type="button" onClick={() => { setOpen(false); onRename() }} disabled={!active}>Rename this article…</button></li>
          <li role="presentation"><button type="button" onClick={() => { setOpen(false); onExport() }} disabled={!active}>Export this article</button></li>
          <li role="presentation"><button type="button" onClick={() => { setOpen(false); picker.current?.click() }}>Import an article…</button></li>
        </ul>
      )}
    </div>
  )
}
