import { useRef, type RefObject } from 'react'
import type { ClaimMark } from '@buildaharness/aielia'

interface Props {
  textRef: RefObject<HTMLTextAreaElement>
  value: string
  marks: ClaimMark[]
  onChange(value: string): void
  onSelection(range: { start: number; end: number }): void
}

const TONE_LABEL: Record<ClaimMark['tone'], string> = { ok: 'supported', look: 'needs a look', bad: 'not supported' }

/**
 * The article text area with claims underlined. The underlines are drawn on a copy of the text behind the (transparent) text area, laid out
 * the same way and scrolled with it, so the writer types in a plain text area and the marks follow the words. The copy is hidden from screen
 * readers; the claim list under the text says the same thing in words.
 */
export function MarkedText({ textRef, value, marks, onChange, onSelection }: Props): React.JSX.Element {
  const back = useRef<HTMLDivElement | null>(null)
  const parts: React.ReactNode[] = []
  let at = 0
  for (const m of marks) {
    if (m.start > at) parts.push(value.slice(at, m.start))
    parts.push(<mark key={m.claimId} className={`write__mark write__mark--${m.tone}`}>{value.slice(m.start, m.end)}</mark>)
    at = m.end
  }
  parts.push(value.slice(at))
  const used = new Set(marks.map((m) => m.tone))

  return (
    <div className="write__editor">
      <div className="write__editbox">
      <div className="write__backdrop" ref={back} aria-hidden="true">{parts}{'\n'}</div>
      <textarea
        ref={textRef}
        aria-label="Article text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => { if (back.current) back.current.scrollTop = e.currentTarget.scrollTop }}
        onSelect={(e) => onSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        onClick={(e) => onSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        spellCheck
      />
      </div>
      {used.size > 0 && (
        <p className="write__marklegend">
          Underlined claims:{' '}
          {(['ok', 'look', 'bad'] as const).filter((t) => used.has(t)).map((t) => <span key={t} className={`write__tone write__tone--${t}`}>{TONE_LABEL[t]}</span>)}
        </p>
      )}
    </div>
  )
}
