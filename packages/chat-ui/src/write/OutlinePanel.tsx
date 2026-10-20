import { useState } from 'react'
import { outlineOf } from '@buildaharness/aielia'
import { IconButton } from './icons'

interface Props {
  /** The text as it is now: the outline is drawn from it, so it always matches what is written. */
  markdown: string
  /** Opens the text at that section. */
  onOpen(start: number): void
  /** Changes the heading in the text. */
  onRename(start: number, heading: string): void
}

/** The headings of the text, numbered. Click one to read that section; the pencil renames it (the heading in the text changes). */
export function OutlinePanel({ markdown, onOpen, onRename }: Props): React.JSX.Element {
  const entries = outlineOf(markdown)
  const [editing, setEditing] = useState<number | null>(null)
  const [text, setText] = useState('')
  if (entries.length === 0) return <p className="write__muted">No headings yet. Start a line with # to make one.</p>

  const finish = (start: number, save: boolean): void => {
    setEditing(null)
    if (save) onRename(start, text)
  }
  return (
    <ol className="write__outline" aria-label="Outline">
      {entries.map((e) => (
        <li key={e.start} className={e.number === '' ? 'write__outline-title' : ''} style={{ marginLeft: `${e.depth * 18}px` }}>
          {e.number !== '' && <span className="write__outline-no">{e.number}</span>}
          {editing === e.start ? (
            <input
              autoFocus
              aria-label={`Heading: ${e.heading}`}
              className="write__editing"
              value={text}
              onChange={(ev) => setText(ev.target.value)}
              onBlur={() => finish(e.start, true)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(e.start, true) } else if (ev.key === 'Escape') { ev.preventDefault(); finish(e.start, false) } }}
            />
          ) : (
            <>
              <button type="button" className="write__link write__headingtext" aria-label={`Heading: ${e.heading}`} onClick={() => onOpen(e.start)}>{e.heading}</button>
              <span className="write__rowacts"><IconButton label={`Rename ${e.heading}`} icon="rename" onClick={() => { setText(e.heading); setEditing(e.start) }} /></span>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}
