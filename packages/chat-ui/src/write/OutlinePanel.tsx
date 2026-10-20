import { useEffect, useRef, useState } from 'react'
import { applyOutlineText, outlineOf, outlineToText } from '@buildaharness/aielia'

interface Props {
  /** The text as it is now: the outline is drawn from it, so it always matches what is written. */
  markdown: string
  /** Changes the article: a heading reworded, added, moved or taken out. */
  onChange(markdown: string): void
  /** Opens the text at that section. */
  onOpen(start: number): void
  /** The writer put the cursor on a heading: the box under the text shows that heading, as if it were clicked in the article. */
  onSelect(start: number): void
}

/** How long to wait after typing before the article follows: a line being retyped should not look like a deleted section. */
const SETTLE_MS = 700

/**
 * The outline as plain text, one heading per line, written the way it is in the article (`## Name`). Click or move to a line and the box under the text shows that heading. Edit it like text: reword a line, press
 * Enter for a new section, type more hashes for a subsection, cut a line to move its section. The article follows. "Open this section" shows
 * the text of the line the cursor is on.
 */
export function OutlinePanel({ markdown, onChange, onOpen, onSelect }: Props): React.JSX.Element {
  const [text, setText] = useState(() => outlineToText(markdown))
  const box = useRef<HTMLTextAreaElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ markdown, text, onChange })
  latest.current = { markdown, text, onChange }
  // What this panel last produced: a change of the article that is not that comes from elsewhere (the text, the chat), and replaces what is shown.
  const produced = useRef<string | null>(null)

  useEffect(() => {
    if (markdown === produced.current) return
    setText(outlineToText(markdown))
  }, [markdown])

  function apply(value: string): string {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const next = applyOutlineText(latest.current.markdown, value)
    if (next !== latest.current.markdown) { produced.current = next; latest.current.onChange(next) }
    return next
  }
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); apply(latest.current.text) } }, [])

  /** The heading the cursor is on, once what was typed has reached the article. */
  function headingAtCursor(): number | undefined {
    const value = box.current?.value ?? text
    const cursorLine = value.slice(0, box.current?.selectionStart ?? 0).split('\n').length - 1
    const index = Math.max(0, value.split('\n').slice(0, cursorLine + 1).filter((l) => l.trim()).length - 1)
    const entries = outlineOf(apply(value))
    return entries[Math.min(index, entries.length - 1)]?.start
  }
  const selectHeading = (): void => { const at = headingAtCursor(); if (at !== undefined) onSelect(at) }
  function openAtCursor(): void {
    const at = headingAtCursor()
    if (at !== undefined) onOpen(at)
  }

  return (
    <div className="write__outlineedit">
      <textarea
        ref={box}
        aria-label="Outline"
        className="write__outlinetext"
        value={text}
        spellCheck
        placeholder={'# Title\n## A section\n### A subsection\n\nStart a line with # to make a heading.'}
        onChange={(e) => {
          setText(e.target.value)
          if (timer.current) clearTimeout(timer.current)
          const value = e.target.value
          timer.current = setTimeout(() => apply(value), SETTLE_MS)
        }}
        onBlur={(e) => apply(e.target.value)}
        onClick={selectHeading}
        onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') selectHeading() }}
      />
      <div className="write__outlinebar">
        <span className="write__muted">One heading per line. More # makes a subsection; a line without # joins the level above.</span>
        <button type="button" className="write__link" onClick={openAtCursor}>Open this section</button>
      </div>
    </div>
  )
}
