import { useEffect, useState } from 'react'
import type { ArticleMeta, Brief, StyleProfile } from '@buildaharness/aielia'
import { EditableText } from './EditableText'
import { IconButton } from './icons'

interface Props {
  meta: ArticleMeta
  profiles: StyleProfile[]
  busy: boolean
  onBrief(brief: Brief): void
  onUse(profileId: string | null): void
  onSaveProfile(profile: { id?: string; name: string; voice: string; terms: { use: string; instead?: string }[] }): void
  onDeleteProfile(id: string): void
}

const FIELDS: { key: keyof Brief; label: string; hint: string }[] = [
  { key: 'audience', label: 'Audience', hint: 'Who is this for?' },
  { key: 'purpose', label: 'Purpose', hint: 'What should it do for the reader?' },
  { key: 'tone', label: 'Tone', hint: 'For example plain, warm, dry' },
  { key: 'length', label: 'Length', hint: 'For example about 1,200 words' },
  { key: 'notes', label: 'Notes', hint: 'Anything else Aielia should keep in mind' },
]

/** One term per line: `use` or `use | instead`. */
export const termsToText = (terms: StyleProfile['terms']): string => terms.map((t) => (t.instead ? `${t.use} | ${t.instead}` : t.use)).join('\n')
export const textToTerms = (text: string): { use: string; instead?: string }[] =>
  text.split('\n').flatMap((line) => {
    const [use, instead] = line.split('|').map((x) => x.trim())
    return use ? [instead ? { use, instead } : { use }] : []
  })

/**
 * Style: the brief for this article (audience, purpose, tone, length, notes) and a writing profile (voice and terminology) that can be
 * saved once and used in any article. Aielia is given both whenever it proposes text, suggests ideas or answers about the article.
 */
export function StylePanel({ meta, profiles, busy, onBrief, onUse, onSaveProfile, onDeleteProfile }: Props): React.JSX.Element {
  const brief = meta.brief ?? {}
  const current = meta.style
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [voice, setVoice] = useState('')
  const [terms, setTerms] = useState('')
  useEffect(() => { setEditing(false) }, [meta.id])
  const saved = current ? profiles.find((p) => p.id === current.id) : undefined
  const outdated = Boolean(saved && JSON.stringify(saved) !== JSON.stringify(current))

  const startEdit = (p?: StyleProfile): void => {
    setName(p?.name ?? '')
    setVoice(p?.voice ?? '')
    setTerms(p ? termsToText(p.terms) : '')
    setEditing(true)
  }

  return (
    <>
      <h2 className="write__panehead">Style</h2>
      <h3 className="write__subhead">Brief for this article</h3>
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

      <h3 className="write__subhead">Writing profile</h3>
      <label className="write__field">
        <span className="write__reason">Use for this article</span>
        <select aria-label="Writing profile" className="write__wide" value={current?.id ?? ''} disabled={busy} onChange={(e) => onUse(e.target.value || null)}>
          <option value="">None</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {current && !saved && <option value={current.id}>{current.name} (not saved)</option>}
        </select>
      </label>
      {current && (
        <p className="write__reason">
          {current.voice || 'No voice described.'}{current.terms.length > 0 ? ` · ${current.terms.length} term${current.terms.length === 1 ? '' : 's'}` : ''}
          {outdated && saved && <> · The saved profile has changed. <button type="button" className="write__link" onClick={() => onUse(saved.id)}>Use the new version</button></>}
        </p>
      )}
      <p>
        <button type="button" className="write__link" onClick={() => startEdit(saved)}>{saved ? `Edit ${saved.name}` : 'New profile'}</button>
        {saved && <> · <button type="button" className="write__link" onClick={() => startEdit()}>New profile</button></>}
        {saved && <IconButton label={`Delete the profile ${saved.name}`} icon="close" onClick={() => onDeleteProfile(saved.id)} />}
      </p>
      {editing && (
        <form className="write__form" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; onSaveProfile({ id: profiles.find((p) => p.id === saved?.id && p.name === name.trim())?.id, name, voice, terms: textToTerms(terms) }); setEditing(false) }}>
          <input aria-label="Profile name" className="write__wide" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, for example House style" />
          <textarea aria-label="Voice" className="write__wide" rows={3} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="How it should sound: plain and direct, no hype, second person" />
          <textarea aria-label="Terms" className="write__wide" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder={'One term per line. "customer | user" means say customer, not user.'} />
          <button type="submit" className="write__primary" disabled={!name.trim()}>Save profile</button>{' '}
          <button type="button" className="write__link" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
    </>
  )
}
