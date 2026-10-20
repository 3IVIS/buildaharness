import { useEffect, useRef, useState } from 'react'
import type { ArticleMeta } from '@buildaharness/aielia'

interface Props {
  meta: ArticleMeta
  onSave(text: string): void
}

/** What a scratchpad starts with in an article that kept a list of ideas before: the ideas still waiting, one under the other. */
export const scratchpadOf = (meta: ArticleMeta): string => meta.scratchpad ?? (meta.ideas ?? []).filter((i) => i.state === 'open').map((i) => i.text).join('\n\n')

/**
 * Ideas: a scratchpad. Click and write; nothing else to fill in. It is saved as you pause and kept with the article, and Aielia reads it
 * when it answers or proposes text.
 */
export function IdeasPanel({ meta, onSave }: Props): React.JSX.Element {
  const saved = scratchpadOf(meta)
  const [text, setText] = useState(saved)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  // Another article, or a note added from the chat, replaces the text; the writer's own typing does not.
  useEffect(() => { if (!dirty.current) setText(saved) }, [saved, meta.id])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const change = (value: string): void => {
    setText(value)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { dirty.current = false; onSave(value) }, 600)
  }
  const leave = (): void => {
    if (!dirty.current) return
    if (timer.current) clearTimeout(timer.current)
    dirty.current = false
    onSave(text)
  }

  return (
    <>
      <h2 className="write__panehead">Ideas</h2>
      <textarea aria-label="Scratchpad" className="write__scratch" value={text} onChange={(e) => change(e.target.value)} onBlur={leave} placeholder="Jot down points, facts, quotes, angles…" spellCheck />
    </>
  )
}
