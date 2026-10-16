import { useCallback, useEffect, useRef, useState } from 'react'
import { computeReadiness, effectiveSourceStatus, sourcesForClaim, type ArticleBundle, type Claim, type Source, type WritePermissions } from '@buildaharness/aielia'
import type { WriteServices } from './write-services'
import './write.css'

type Tab = 'text' | 'outline' | 'issues' | 'sources' | 'chat' | 'settings'
interface ChatLine { id: number; from: 'you' | 'aielia'; text: string }

const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'outline', label: 'Outline' },
  { id: 'issues', label: 'Issues' },
  { id: 'sources', label: 'Sources' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
]

const STATUS_LABEL: Record<string, string> = {
  none: 'no source',
  attached: 'source attached, not checked',
  supported: 'supported',
  partly_supported: 'partly supported',
  not_supported: 'not supported',
  contradicted: 'contradicted',
  stale: 'stale: the text or a source changed',
  not_checked: 'not checked',
}

let lineId = 0

export function WriteApp({ services }: { services: WriteServices }): React.JSX.Element {
  const { service, port } = services
  const [articles, setArticles] = useState<{ id: string; title: string }[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [bundle, setBundle] = useState<ArticleBundle | undefined>()
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<Tab>('text')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [chatInput, setChatInput] = useState('')
  const [askForEdits, setAskForEdits] = useState(false)
  const [perms, setPerms] = useState<WritePermissions | undefined>()
  const permsRef = useRef<WritePermissions | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshList = useCallback(async () => setArticles(await service.list()), [service])
  const reload = useCallback(
    async (id: string) => {
      const b = await service.get(id)
      setBundle(b)
      setDraft(b.markdown)
    },
    [service],
  )

  useEffect(() => {
    void services.permissions.get().then((p) => { permsRef.current = p; setPerms(p) })
    void (async () => {
      await refreshList()
      const remembered = await port.getActive()
      const list = await service.list()
      const first = list.find((a) => a.id === remembered) ?? list[0]
      if (first) {
        setActiveId(first.id)
        await reload(first.id)
      }
    })().catch((err) => setNotice(String(err)))
  }, [service, port, refreshList, reload])

  async function run(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label)
    setNotice(null)
    try {
      await work()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function select(id: string): Promise<void> {
    setActiveId(id)
    await port.setActive(id)
    await reload(id)
  }

  async function createArticle(): Promise<void> {
    const title = window.prompt('Title of the new article?')?.trim()
    if (!title) return
    await run('Creating', async () => {
      const id = await service.create(title, `# ${title}\n\n`)
      await refreshList()
      await select(id)
    })
  }

  function onType(value: string): void {
    setDraft(value)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (!activeId) return
      // Structure only (no model call) unless the writer allowed automatic checks: sections re-anchor, suggestions refresh.
      void service.updateText(activeId, value, { analyze: permsRef.current?.autoCheck === true }).then((o) => setBundle(o.bundle), (err) => setNotice(String(err)))
    }, 800)
  }

  async function check(): Promise<void> {
    if (!activeId) return
    await run('Checking the article', async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const o = await service.updateText(activeId, draft)
      const full = o.changedSectionIds.length === 0 ? await service.analyze(activeId) : o
      setBundle((await service.get(activeId)) ?? full.bundle)
      if (full.extraction?.status === 'not_extracted') setNotice('The claim check could not run. Nothing was marked as checked.')
    })
  }

  async function publish(): Promise<void> {
    if (!activeId) return
    const label = window.prompt('Label for this published version (optional)?') ?? undefined
    await run('Publishing', async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      await service.updateText(activeId, draft, { analyze: false })
      const b = await service.publish(activeId, label?.trim() || undefined)
      setBundle(b)
      const r = computeReadiness(b.meta)
      const open = r.unsourcedFactualClaims + r.staleOrUnsupportedClaims + r.openComments + r.sectionsNeedingReview
      setNotice(open > 0 ? `Published as a frozen snapshot. ${open} item${open === 1 ? ' was' : 's were'} still open; ${open === 1 ? 'it is' : 'they are'} recorded with it.` : 'Published as a frozen snapshot.')
    })
  }

  async function exportArticle(): Promise<void> {
    if (!activeId) return
    const folder = await service.exportArticle(activeId)
    const blob = new Blob([JSON.stringify(folder, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${bundle?.meta.title ?? 'article'}.aielia-article.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function importArticle(file: File): Promise<void> {
    await run('Importing', async () => {
      let folder: Record<string, string>
      try {
        folder = JSON.parse(await file.text()) as Record<string, string>
      } catch {
        throw new Error('That file is not an exported article.')
      }
      const r = await service.importArticle(folder)
      if (!r.ok) throw new Error(r.reason)
      await refreshList()
      await select(r.id)
    })
  }

  async function sendChat(): Promise<void> {
    const text = chatInput.trim()
    if (!text) return
    setChatInput('')
    setChat((c) => [...c, { id: ++lineId, from: 'you', text }])
    await run(askForEdits ? 'Asking for edits' : 'Thinking', async () => {
      if (activeId) await service.updateText(activeId, draft, { analyze: false })
      if (askForEdits && activeId) {
        // Record what the writer said (comments, corrections) the same way a chat turn does, then turn the request into suggestions.
        const reply = await services.chat(text, activeId)
        const r = await service.suggest(activeId, text)
        setBundle(await service.get(activeId))
        const summary = r.status === 'failed' ? 'I could not turn that into edits.' : r.added.length === 0 ? 'I found nothing to change in the text for that.' : `I added ${r.added.length} suggested change${r.added.length === 1 ? '' : 's'}. Open Issues to accept or reject them.`
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: `${reply}\n\n${summary}` }])
      } else {
        const reply = await services.chat(text, activeId)
        if (activeId) setBundle(await service.get(activeId))
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: reply }])
      }
    })
  }

  const meta = bundle?.meta
  const readiness = meta ? computeReadiness(meta) : undefined

  return (
    <div className="write">
      <header className="write__bar">
        <h1 className="write__title">Aielia Write</h1>
        <select aria-label="Article" value={activeId ?? ''} onChange={(e) => void select(e.target.value)} disabled={articles.length === 0}>
          {articles.length === 0 && <option value="">No articles yet</option>}
          {articles.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <button type="button" onClick={() => void createArticle()}>New</button>
        <button type="button" onClick={() => void check()} disabled={!activeId || busy !== null}>Check article</button>
        <button type="button" onClick={() => void publish()} disabled={!activeId || busy !== null}>Publish</button>
        <button type="button" onClick={() => void exportArticle()} disabled={!activeId}>Export</button>
        <label className="write__import">Import<input type="file" accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importArticle(f); e.target.value = '' }} /></label>
      </header>
      {(busy || notice) && <p className="write__notice" role="status">{busy ? `${busy}…` : notice}</p>}

      <nav className="write__tabs" aria-label="Sections of the page">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'is-on' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      <main className="write__main">
        {!activeId || !bundle || !meta ? (
          <p className="write__empty">Create an article, or import one, to begin.</p>
        ) : (
          <>
            <section className={`write__pane write__pane--text ${tab === 'text' ? 'is-shown' : ''}`} aria-label="Text">
              <textarea aria-label="Article text" value={draft} onChange={(e) => onType(e.target.value)} spellCheck />
            </section>
            <section className={`write__pane ${tab === 'outline' ? 'is-shown' : ''}`} aria-label="Outline">
              <ul className="write__list">
                {meta.sections.map((s) => (
                  <li key={s.id}>
                    <strong>{s.heading || '(opening)'}</strong>
                    {s.review.state !== 'clean' && (
                      <span className={`write__badge write__badge--${s.review.state}`}>
                        {s.review.state === 'needs_review' ? 'needs review' : s.review.state.replace('_', ' ')}
                      </span>
                    )}
                    {s.review.reason && <p className="write__reason">{s.review.reason}</p>}
                    {s.review.state === 'needs_review' && <button type="button" onClick={() => void run('Saving', async () => { await service.setReview(activeId, s.id, 'clean'); await reload(activeId) })}>Mark clean</button>}
                  </li>
                ))}
              </ul>
            </section>
            <section className={`write__pane ${tab === 'issues' ? 'is-shown' : ''}`} aria-label="Issues">
              {readiness && (
                <p className="write__counts">
                  {readiness.unsourcedFactualClaims} unsourced · {readiness.staleOrUnsupportedClaims} stale or unsupported · {readiness.openComments} open comments · {readiness.sectionsNeedingReview} sections to review
                </p>
              )}
              <h2>Suggested changes</h2>
              <ul className="write__list">
                {meta.suggestions.filter((s) => s.state === 'pending').map((s) => (
                  <li key={s.id}>
                    <p><del>{s.span.quote}</del> → <ins>{s.replacement}</ins></p>
                    <p className="write__reason">{s.reason}</p>
                    <button type="button" onClick={() => void run('Applying', async () => { const r = await service.acceptSuggestionAndUpdate(activeId, s.id, undefined, { analyze: false }); if (!r.ok) setNotice(r.reason); await reload(activeId) })}>Accept</button>
                    <button type="button" onClick={() => void run('Saving', async () => { await service.rejectSuggestionById(activeId, s.id); await reload(activeId) })}>Reject</button>
                  </li>
                ))}
                {meta.suggestions.every((s) => s.state !== 'pending') && <li className="write__muted">None waiting.</li>}
              </ul>
              <h2>Reviewer comments</h2>
              <ul className="write__list">
                {meta.comments.map((c) => (
                  <li key={c.id}>
                    <strong>{c.label ?? c.id}</strong>{c.reviewer ? ` (${c.reviewer})` : ''} <span className="write__badge">{c.state}</span>
                    <p>{c.text}</p>
                    {c.decision && <p className="write__reason">You decided: {c.decision}</p>}
                    {c.conflictsWith.length > 0 && <p className="write__warn">In conflict with {c.conflictsWith.map((id) => meta.comments.find((x) => x.id === id)?.label ?? id).join(', ')}. You have not chosen.</p>}
                    {c.state === 'open' && (
                      <>
                        <button type="button" onClick={() => void run('Saving', async () => { await service.setCommentState(activeId, c.id, 'addressed'); await reload(activeId) })}>Mark addressed</button>
                        <button type="button" onClick={() => void run('Saving', async () => { await service.setCommentState(activeId, c.id, 'dismissed'); await reload(activeId) })}>Dismiss</button>
                      </>
                    )}
                  </li>
                ))}
                {meta.comments.length === 0 && <li className="write__muted">Paste reviewer comments into the chat and they will appear here.</li>}
              </ul>
              <h2>Claims</h2>
              <ul className="write__list">
                {meta.claims.filter((c) => c.kind === 'factual').map((c) => (
                  <li key={c.id}>
                    <p>{c.quote}</p>
                    <span className={`write__badge write__badge--${effectiveSourceStatus(c, meta.sources)}`}>{STATUS_LABEL[effectiveSourceStatus(c, meta.sources)]}</span>
                    {c.needsRecheck && <span className="write__badge write__badge--needs_review">moved or changed, check</span>}
                    {!c.confirmed && <button type="button" onClick={() => void run('Saving', async () => { await service.confirmClaim(activeId, c.id); await reload(activeId) })}>Confirm</button>}
                    <button type="button" onClick={() => void run('Checking the claim', async () => { await service.checkClaim(activeId, c.id); await reload(activeId) })}>Check</button>
                  </li>
                ))}
                {meta.claims.length === 0 && <li className="write__muted">Press “Check article” to find the claims.</li>}
              </ul>
              {meta.corrections.length > 0 && (
                <>
                  <h2>Your corrections</h2>
                  <ul className="write__list">{meta.corrections.map((c) => <li key={c.id}>{c.note}{c.supersedes ? <span className="write__reason"> replaces: {c.supersedes}</span> : null}</li>)}</ul>
                </>
              )}
            </section>
            <section className={`write__pane ${tab === 'sources' ? 'is-shown' : ''}`} aria-label="Sources">
              <SourceForm onAdd={(input) => run('Adding the source', async () => { await service.addSource(activeId, input); await reload(activeId) })} />
              <ul className="write__list">
                {meta.sources.map((s) => (
                  <li key={s.id}>
                    <strong>{s.kind === 'say_so' ? 'Your say-so' : s.address ?? s.kind}</strong> <span className="write__badge">{s.freshness}</span>
                    {s.trust === 'lower' && <span className="write__badge">lower trust</span>}
                    <p className="write__reason">{s.note ?? (s.passage ? `${s.passage.slice(0, 160)}${s.passage.length > 160 ? '…' : ''}` : '')}</p>
                    <AttachControl claims={meta.claims.filter((c) => c.kind === 'factual')} sourceId={s.id} attached={(c) => sourcesForClaim(meta, c.id).some((x: Source) => x.id === s.id)} onAttach={(claimId) => run('Attaching', async () => { await service.attachSource(activeId, claimId, s.id); await reload(activeId) })} />
                  </li>
                ))}
                {meta.sources.length === 0 && <li className="write__muted">No sources yet. Add a passage, a file or your own say-so.</li>}
              </ul>
            </section>
          </>
        )}
        <section className={`write__pane ${tab === 'settings' ? 'is-shown' : ''}`} aria-label="Settings">
          <SettingsPane perms={perms} spent={services.spentUsd()} onSave={(p) => run('Saving', async () => { await services.permissions.set(p); permsRef.current = p; setPerms(p) })} />
        </section>
        <section className={`write__pane write__pane--chat ${tab === 'chat' ? 'is-shown' : ''}`} aria-label="Chat">
          <ul className="write__chat" aria-live="polite">
            {chat.map((l) => <li key={l.id} className={`write__line write__line--${l.from}`}>{l.text}</li>)}
            {chat.length === 0 && <li className="write__muted">Talk to Aielia about the article, or paste reviewer comments here.</li>}
          </ul>
          <label className="write__toggle"><input type="checkbox" checked={askForEdits} onChange={(e) => setAskForEdits(e.target.checked)} /> Ask for edits (they arrive as suggestions)</label>
          <div className="write__compose">
            <textarea aria-label="Message" value={chatInput} onChange={(e) => setChatInput(e.target.value)} rows={3} />
            <button type="button" onClick={() => void sendChat()} disabled={busy !== null || !chatInput.trim()}>Send</button>
          </div>
        </section>
      </main>
    </div>
  )
}

function SourceForm({ onAdd }: { onAdd: (input: { kind: Source['kind']; address?: string; passage?: string; note?: string }) => Promise<void> }): React.JSX.Element {
  const [kind, setKind] = useState<'upload' | 'web' | 'say_so'>('upload')
  const [address, setAddress] = useState('')
  const [text, setText] = useState('')
  async function readFile(file: File): Promise<void> {
    setText(await file.text())
    setAddress(file.name)
  }
  return (
    <form className="write__form" onSubmit={(e) => { e.preventDefault(); void onAdd(kind === 'say_so' ? { kind, note: text } : { kind, address: address || undefined, passage: text }).then(() => { setText(''); setAddress('') }) }}>
      <select aria-label="Kind of source" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="upload">A file or pasted text</option>
        <option value="web">A web page (paste the passage)</option>
        <option value="say_so">My own word</option>
      </select>
      {kind !== 'say_so' && <input aria-label="Name or address" placeholder="File name or address" value={address} onChange={(e) => setAddress(e.target.value)} />}
      <textarea aria-label="Source text" placeholder={kind === 'say_so' ? 'What you know, in a sentence' : 'The passage'} value={text} onChange={(e) => setText(e.target.value)} rows={4} />
      {kind === 'upload' && <input type="file" aria-label="Choose a text file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f) }} />}
      <button type="submit" disabled={!text.trim()}>Add source</button>
    </form>
  )
}

function AttachControl({ claims, sourceId, attached, onAttach }: { claims: Claim[]; sourceId: string; attached: (c: Claim) => boolean; onAttach: (claimId: string) => Promise<void> }): React.JSX.Element {
  const free = claims.filter((c) => !attached(c))
  if (claims.length === 0) return <span className="write__muted">Find the claims first.</span>
  return (
    <select aria-label={`Attach source ${sourceId} to a claim`} value="" onChange={(e) => { if (e.target.value) void onAttach(e.target.value) }}>
      <option value="">Attach to a claim…</option>
      {free.map((c) => <option key={c.id} value={c.id}>{c.quote.slice(0, 70)}</option>)}
    </select>
  )
}

function SettingsPane({ perms, spent, onSave }: { perms: WritePermissions | undefined; spent: number; onSave: (p: WritePermissions) => Promise<void> }): React.JSX.Element {
  const [cap, setCap] = useState<string>('')
  useEffect(() => setCap(perms?.spendCapUsd !== undefined ? String(perms.spendCapUsd) : ''), [perms])
  if (!perms) return <p className="write__muted">Loading…</p>
  const save = (next: Partial<WritePermissions>): Promise<void> => onSave({ ...perms, ...next })
  return (
    <div className="write__form">
      <p>Aielia only ever changes your text as suggestions you accept. These are the other things it may do on its own.</p>
      <label><input type="checkbox" checked={perms.captureChat} onChange={(e) => void save({ captureChat: e.target.checked })} /> Remember reviewer comments, decisions and corrections I mention in chat</label>
      <label><input type="checkbox" checked={perms.autoCheck} onChange={(e) => void save({ autoCheck: e.target.checked })} /> Check claims and effects by itself when I stop typing (uses your key)</label>
      <label>Stop using my key after this much, in US dollars (blank for no limit)
        <input aria-label="Spending cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => { const n = Number(cap); void save({ spendCapUsd: cap.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined }) }} />
      </label>
      <p className="write__muted">Spent so far in this browser: ${spent.toFixed(2)}</p>
    </div>
  )
}
