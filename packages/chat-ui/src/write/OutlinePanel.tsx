import { useEffect, useRef, useState } from 'react'
import { applyOutlineText, expandOutlineSelection, outlineOf, outlineToText } from '@buildaharness/aielia'

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
 * Enter for a new section, type more hashes for a subsection, cut a line to move its section. The article follows. The ↗ at the end of a line
 * goes to that section in the text.
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

  /** The heading at the nth heading line, once what was typed has reached the article. */
  function headingAt(index: number): number | undefined {
    const entries = outlineOf(apply(box.current?.value ?? text))
    return entries[Math.min(index, entries.length - 1)]?.start
  }
  const lineAtCursor = (): number => {
    const value = box.current?.value ?? text
    const cursorLine = value.slice(0, box.current?.selectionStart ?? 0).split('\n').length - 1
    return Math.max(0, value.split('\n').slice(0, cursorLine + 1).filter((l) => l.trim()).length - 1)
  }
  // Double-click: the heading, then each larger group of headings, up to the one just below the whole outline, then the heading again.
  // The picked text stays marked while the box is not in use (the writer clicked in the box under the text); the browser would stop drawing it.
  const [picked, setPicked] = useState<{ start: number; end: number } | null>(null)
  const [focused, setFocused] = useState(false)
  const grown = useRef<{ start: number; end: number } | null>(null)
  const pressed = useRef<{ start: number; end: number } | null>(null)
  function doubleClick(): void {
    const t = box.current
    if (!t) return
    const at = t.selectionStart
    const prev = pressed.current
    pressed.current = null
    const inside = prev !== null && at >= prev.start && at <= prev.end
    let next = expandOutlineSelection(t.value, inside ? prev : { start: at, end: at })
    if (!next && inside) next = expandOutlineSelection(t.value, { start: at, end: at })
    if (!next) return
    t.setSelectionRange(next.range.start, next.range.end)
    grown.current = next.range
    setPicked(next.range)
    // the box under the text shows the heading the selection starts at
    const index = t.value.slice(0, next.range.start).split('\n').filter((l) => l.trim()).length
    const start = headingAt(index)
    if (start !== undefined) onSelect(start)
  }
  const selectHeading = (): void => { const at = headingAt(lineAtCursor()); if (at !== undefined) onSelect(at) }

  // The "go to the text" marks sit right after each line: a copy of the lines, invisible, with a mark at the end of each, laid over the box and scrolled with it.
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const lines = text.split('\n')
  let headingNo = -1
  let lineStart = 0
  const shownRange = !focused && picked && picked.end > picked.start ? picked : null

  return (
    <div className="write__outlineedit">
      <div className="write__outlinebox">
        <textarea
          ref={box}
          aria-label="Outline"
          className="write__outlinetext"
          value={text}
          wrap="off"
          spellCheck
          placeholder={'# Title\n## A section\n### A subsection\n\nStart a line with # to make a heading.'}
          onChange={(e) => {
            setText(e.target.value)
            if (timer.current) clearTimeout(timer.current)
            const value = e.target.value
            timer.current = setTimeout(() => apply(value), SETTLE_MS)
          }}
          onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
          onClick={selectHeading}
          onMouseDown={(e) => { if (e.detail <= 1) pressed.current = grown.current; else e.preventDefault() }}
          onDoubleClick={doubleClick}
          onFocus={() => setFocused(true)}
          onBlur={(e) => { setFocused(false); apply(e.target.value) }}
          onSelect={(e) => { setPicked({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }); const g = grown.current; if (g && (e.currentTarget.selectionStart !== g.start || e.currentTarget.selectionEnd !== g.end)) grown.current = null }}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') selectHeading() }}
        />
        <div className="write__outlinemarks">
          <div style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
            {lines.map((line, i) => {
              const isHeading = line.trim() !== ''
              if (isHeading) headingNo++
              const n = headingNo
              const name = line.replace(/^\s*#*\s*/, '').trim()
              const [from, to] = [lineStart, lineStart + line.length]
              lineStart = to + 1
              const hl = shownRange ? { a: Math.max(shownRange.start, from) - from, b: Math.min(shownRange.end, to) - from } : null
              return (
                <div key={i} className="write__outlinemarkline">
                  <span className="write__outlineghost">{hl && hl.b > hl.a ? <>{line.slice(0, hl.a)}<span className="write__sel">{line.slice(hl.a, hl.b)}</span>{line.slice(hl.b)}</> : line || ' '}</span>
                  {isHeading && <button type="button" className="write__outlinego" aria-label={`Go to the section: ${name || line.trim()}`} title="Go to this section in the text" onClick={() => { const at = headingAt(n); if (at !== undefined) onOpen(at) }}>↗</button>}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="write__outlinebar">
        <span className="write__muted">One heading per line. More # makes a subsection; a line without # joins the level above. ↗ goes to that section in the text.</span>
      </div>
    </div>
  )
}
