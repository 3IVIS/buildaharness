import { useRef, useState, type RefObject } from 'react'
import type { TextPiece } from '@buildaharness/aielia'
import { IconButton } from './icons'

interface Props {
  textRef: RefObject<HTMLTextAreaElement>
  value: string
  pieces: TextPiece[]
  onChange(value: string): void
  onSelection(range: { start: number; end: number }): void
  /** Selects the next larger unit (sentence, paragraph, section, article) around the selection. */
  onGrow(): void
  /** Goes back to the smaller selection. */
  onShrink(): void
  /** What the current selection was grown to, when it was. */
  unit?: string
}

const TINT_KEY = 'aielia-write.tint'
function loadTint(): boolean {
  try {
    return localStorage.getItem(TINT_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * The article text area with what needs attention shown inside the text: each sentence that makes a claim gets a slight tint (green when its
 * source backs it, orange when it still needs a source, red when a source says the opposite); an open comment is a dotted underline, a suggested
 * change a dashed one, and a heading whose section needs review a bar under it. The marks are drawn on a copy of the text behind the (transparent)
 * text area, laid out the same way and scrolled with it, so the writer types in a plain text area and the marks follow the words. Nothing changes
 * the layout of the text. The copy is hidden from screen readers; the line under the text and the box under that say the same in words.
 */
export function MarkedText({ textRef, value, pieces, onChange, onSelection, onGrow, onShrink, unit }: Props): React.JSX.Element {
  const back = useRef<HTMLDivElement | null>(null)
  const [tint, setTint] = useState(loadTint)
  const shown = tint ? pieces : []
  const parts: React.ReactNode[] = []
  let at = 0
  for (const p of shown) {
    if (p.start > at) parts.push(value.slice(at, p.start))
    const cls = ['write__mark', p.tone && `write__mark--${p.tone}`, p.commentIds.length > 0 && 'has-comment', p.suggestionIds.length > 0 && 'has-suggestion', p.reviewSectionId && 'has-review'].filter(Boolean).join(' ')
    parts.push(<mark key={`${p.start}-${p.end}`} className={cls}>{value.slice(p.start, p.end)}</mark>)
    at = p.end
  }
  parts.push(value.slice(at))
  const has = (f: (p: TextPiece) => boolean): boolean => pieces.some(f)

  return (
    <div className="write__editor">
      <div className="write__editbox">
      <div className="write__backdrop" ref={back} aria-hidden="true">{parts}{'\n'}</div>
      <textarea
        ref={textRef}
        aria-label="Article text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.altKey && e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); onGrow() } else if (e.altKey && e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); onShrink() } }}
        onScroll={(e) => { if (back.current) back.current.scrollTop = e.currentTarget.scrollTop }}
        onSelect={(e) => onSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        onClick={(e) => onSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        spellCheck
      />
      </div>
      <div className="write__selbar" role="group" aria-label="Select text">
        <IconButton label="Select more: sentence, then paragraph, then section (Alt+Shift+Up)" icon="grow" onClick={onGrow} disabled={value.length === 0} />
        <IconButton label="Select less (Alt+Shift+Down)" icon="shrink" onClick={onShrink} disabled={value.length === 0} />
        {unit && <span className="write__muted" aria-live="polite">Selected: {unit}</span>}
      </div>
      {pieces.length > 0 && (
        <p className="write__marklegend">
          <label className="write__tintswitch" title="Show or hide the colours and underlines in the text">
            <input type="checkbox" checked={tint} onChange={(e) => { setTint(e.target.checked); try { localStorage.setItem(TINT_KEY, e.target.checked ? 'on' : 'off') } catch { /* the choice just is not remembered */ } }} aria-label="Show marks in the text" /> Marks
          </label>
          {tint && (
            <>
              {has((p) => p.tone === 'ok') && <span className="write__tone write__tone--ok">backed by a source</span>}
              {has((p) => p.tone === 'tried') && <span className="write__tone write__tone--tried">looked for, none found</span>}
              {has((p) => p.tone === 'look') && <span className="write__tone write__tone--look">not looked at yet</span>}
              {has((p) => p.tone === 'bad') && <span className="write__tone write__tone--bad">against a source</span>}
              {has((p) => p.commentIds.length > 0) && <span className="write__tone write__tone--comment">open comment</span>}
              {has((p) => p.suggestionIds.length > 0) && <span className="write__tone write__tone--suggestion">suggested change</span>}
              {has((p) => p.reviewSectionId !== undefined) && <span className="write__tone write__tone--review">needs review</span>}
            </>
          )}
        </p>
      )}
    </div>
  )
}
