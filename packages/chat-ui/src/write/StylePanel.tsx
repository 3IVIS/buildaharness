import type { ArticleMeta, Brief } from '@buildaharness/aielia'
import { EditableText } from './EditableText'

interface Props {
  meta: ArticleMeta
  /** There is text to read the style from. */
  hasText: boolean
  /** What the automatic reading of the text is doing: working, failed (with the reason), or not running. */
  reading?: { state: 'reading' | 'failed' | 'idle'; error?: string }
  busy: boolean
  onBrief(brief: Brief): void
  /** Reads the style from the text again, filling only what is empty. */
  onDerive(): void
}

const FIELDS: { key: keyof Brief; label: string; hint: string }[] = [
  { key: 'audience', label: 'Audience', hint: 'Who is this for?' },
  { key: 'purpose', label: 'Purpose', hint: 'What should it do for the reader?' },
  { key: 'tone', label: 'Tone', hint: 'For example plain, warm, dry' },
  { key: 'length', label: 'Length', hint: 'For example about 1,200 words' },
  { key: 'notes', label: 'Notes', hint: 'Anything else Aielia should keep in mind' },
]

/**
 * Style: the brief for this article (audience, purpose, tone, length, notes). It is drawn from the text as soon as there is about a page of it,
 * or the article is imported or pasted in; the writer edits any line, and Aielia is given it whenever it proposes text or answers about the article.
 */
export function StylePanel({ meta, hasText, reading = { state: 'idle' }, busy, onBrief, onDerive }: Props): React.JSX.Element {
  const brief = meta.brief ?? {}
  const empty = FIELDS.every((f) => !(brief[f.key] ?? '').trim())
  return (
    <>
      <h2 className="write__panehead">Style</h2>
      {empty && (
        <p className="write__muted">
          {!hasText ? 'This fills in by itself once the article is about a page long, or when you paste or import text.'
            : reading.state === 'reading' ? 'Reading the text to fill this in…'
            : reading.state === 'failed' ? `Could not read the text to fill this in: ${reading.error ?? 'the model gave no answer'}. Check your key and the model in Settings, then try “Fill the empty lines from the text”.`
            : 'Not filled in yet. It fills in by itself once the article is about a page long, or press “Fill the empty lines from the text”.'}
        </p>
      )}
      <ul className="write__rows">
        {FIELDS.map((f) => (
          <li key={f.key}>
            <div className="write__rowmain">
              <div className="write__reason">{f.label}</div>
              <EditableText label={f.label} value={brief[f.key] ?? ''} placeholder={f.hint} multiline allowEmpty onSave={(v) => onBrief({ ...brief, [f.key]: v })} />
            </div>
          </li>
        ))}
      </ul>
      {hasText && <button type="button" className="write__link" onClick={onDerive} disabled={busy}>Fill the empty lines from the text</button>}
    </>
  )
}
