import { useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import './site-nav.css'

const SITE = 'https://myaielia.com'
const MENU = [
  { href: `${SITE}/how-it-works`, label: 'How it works' },
  { href: `${SITE}/try`, label: 'Try it' },
  { href: `${SITE}/install`, label: 'Install' },
  { href: `${SITE}/harness-comparison`, label: 'Comparison' },
  { href: `${SITE}/harness-faceoff`, label: 'Faceoff' },
  { href: `${SITE}/harness-architecture`, label: 'Architecture' },
  { href: `${SITE}/harness-evaluation`, label: 'Evaluation' },
  { href: 'https://buildaharness.com', label: 'For developers ↗' },
  { href: 'https://github.com/3IVIS/buildaharness', label: 'GitHub ↗' },
  { href: `${SITE}/terms.html`, label: 'Terms' },
  { href: `${SITE}/privacy.html`, label: 'Privacy' },
  { href: `${SITE}/impressum.html`, label: 'Impressum' },
]

/** The website's collapsed top-right menu (the ⋯ button and the full-site list), shown on the web pages only; the desktop app has no website around it. */
export function SiteNav(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  if (isTauri()) return null
  return (
    <div className="site-nav" ref={ref}>
      <div className="site-nav__full">
        <button type="button" className="site-nav__toggle" aria-label="Open site menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
        {open && (
          <nav className="site-nav__menu" aria-label="Full site menu" onClick={() => setOpen(false)}>
            {MENU.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
          </nav>
        )}
      </div>
    </div>
  )
}
