import { useState } from 'react'
import { ICON_PATHS, Icon, IconButton } from './icons'

/**
 * The repositories handed to the open article, searched when claims are verified. A GitHub address is typed here; a folder on this computer is
 * chosen with the folder button where the browser can. Held for this visit only: a folder or token never goes into the article.
 */
export function RepoBar({ repos, busy, onAddGithub, onPickFolder, onRemove }: { repos: string[]; busy: boolean; onAddGithub: (address: string) => void; onPickFolder?: () => void; onRemove: (name: string) => void }): React.JSX.Element {
  const [address, setAddress] = useState('')
  function add(): void {
    const a = address.trim()
    if (!a || busy) return
    onAddGithub(a)
    setAddress('')
  }
  return (
    <details className="write__allsrc write__repos" open={repos.length > 0}>
      <summary>Repositories to check claims against{repos.length > 0 ? ` (${repos.length})` : ''}</summary>
      <ul className="write__list" aria-label="Repositories">
        {repos.map((r) => (
          <li key={r} className="write__dsrc">
            <span className="write__dsrcname">{r}</span>
            <span className="write__rowacts"><IconButton label={`Stop using ${r}`} icon="close" onClick={() => onRemove(r)} disabled={busy} /></span>
          </li>
        ))}
      </ul>
      <div className="write__rowacts">
        <input
          aria-label="GitHub repository address"
          value={address}
          disabled={busy}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="github.com/owner/repo (Enter adds it)"
        />
        {onPickFolder && <button type="button" className="write__iconbtn" aria-label="Use a repository folder on this computer" title="Use a repository folder on this computer" onClick={onPickFolder} disabled={busy}><Icon d={ICON_PATHS.folder} /></button>}
      </div>
    </details>
  )
}
