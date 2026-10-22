import { useRef, useState, type RefObject } from 'react'
import type { TextPiece } from '@buildaharness/aielia'

interface Props {
  textRef: RefObject<HTMLTextAreaElement>
  value: string
  pieces: TextPiece[]
  onChange(value: string): void
  onSelection(range: { start: number; end: number }): void
  /** Where the cursor or selection is in the text; a selection stays drawn while the box is not in use. */
  selection: { start: number; end: number } | null
  /** Alt+Shift+Up: selects the next larger unit (sentence, paragraph, section, article) around the selection. */
  onGrow(): void
  /** Alt+Shift+Down: goes back to the smaller selection. */
  onShrink(): void
  /** A click is starting: the page notes what was selected by earlier double-clicks, because the click itself changes the selection. */
  onPress(): void
  /** A double-click at this place in the text: select the sentence, and on each further double-click the next larger unit, then start over. */
  onDoubleClick(at: number): void
  /** A passage a job has just written, lit for a moment so the eye finds it. */
  flash?: { start: number; end: number } | null
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
export function MarkedText({ textRef, value, pieces, onChange, onSelection, onGrow, onShrink, onPress, onDoubleClick, selection, flash }: Props): React.JSX.Element {
  const back = useRef<HTMLDivElement | null>(null)
  const [tint, setTint] = useState(loadTint)
  const shown = tint ? pieces : []
  // While the text box is not the one in use (the writer clicked in the box under the text, say), the browser stops drawing the selection. It is
  // drawn here instead, in the copy behind the text, so the picked text stays marked until the writer clicks in the text again.
  const [focused, setFocused] = useState(false)
  const kept = !focused && selection && selection.end > selection.start ? { start: Math.min(selection.start, value.length), end: Math.min(selection.end, value.length) } : undefined
  const cuts = new Set<number>([0, value.length])
  for (const p of shown) { cuts.add(p.start); cuts.add(p.end) }
  if (kept) { cuts.add(kept.start); cuts.add(kept.end) }
  const lit = flash ? { start: Math.min(flash.start, value.length), end: Math.min(flash.end, value.length) } : undefined
  if (lit && lit.end > lit.start) { cuts.add(lit.start); cuts.add(lit.end) }
  const edges = [...cuts].filter((n) => n >= 0 && n <= value.length).sort((x, y) => x - y)
  const parts: React.ReactNode[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const [from, to] = [edges[i], edges[i + 1]]
    const p = shown.find((x) => x.start <= from && x.end >= to)
    const inSelection = kept !== undefined && from >= kept.start && to <= kept.end
    const inFlash = lit !== undefined && lit.end > lit.start && from >= lit.start && to <= lit.end
    if (!p && !inSelection && !inFlash) { parts.push(value.slice(from, to)); continue }
    const cls = ['write__mark', p?.tone && `write__mark--${p.tone}`, p && p.commentIds.length > 0 && 'has-comment', p && p.suggestionIds.length > 0 && 'has-suggestion', p?.reviewSectionId && 'has-review', inSelection && 'write__sel', inFlash && 'write__flash'].filter(Boolean).join(' ')
    parts.push(<mark key={`${from}-${to}`} className={cls}>{value.slice(from, to)}</mark>)
  }
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
        onMouseDown={(e) => { if (e.detail <= 1) onPress(); else e.preventDefault() /* the browser would select a word; the double-click selects a sentence */ }}
        onDoubleClick={(e) => onDoubleClick(e.currentTarget.selectionStart)}
        onScroll={(e) => { if (back.current) back.current.scrollTop = e.currentTarget.scrollTop }}
        onSelect={(e) => onSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        onClick={(e) => onSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        spellCheck
      />
      </div>
      {pieces.length > 0 && (
        <p className="write__marklegend">
          <label className="write__tintswitch" title="Show or hide the colours and underlines in the text">
            <input type="checkbox" checked={tint} onChange={(e) => { setTint(e.target.checked); try { localStorage.setItem(TINT_KEY, e.target.checked ? 'on' : 'off') } catch { /* the choice just is not remembered */ } }} aria-label="Show marks in the text" /> Marks
          </label>
          {tint && (
            <>
              {has((p) => p.tone === 'ok') && <span className="write__tone write__tone--ok" title="A source backs this claim">sourced</span>}
              {has((p) => p.tone === 'tried') && <span className="write__tone write__tone--tried" title="A source was looked for and none was found">no source found</span>}
              {has((p) => p.tone === 'look') && <span className="write__tone write__tone--look" title="A claim with no source yet, or a source that has not been checked against it">needs checking</span>}
              {has((p) => p.tone === 'bad') && <span className="write__tone write__tone--bad" title="A source says the opposite">contradicted</span>}
              {has((p) => p.commentIds.length > 0) && <span className="write__tone write__tone--comment" title="There is an open comment on this text">comment</span>}
              {has((p) => p.suggestionIds.length > 0) && <span className="write__tone write__tone--suggestion" title="A change is suggested for this text">suggested edit</span>}
              {has((p) => p.reviewSectionId !== undefined) && <span className="write__tone write__tone--review" title="This section is flagged because something it depends on changed">to review</span>}
            </>
          )}
        </p>
      )}
    </div>
  )
}
