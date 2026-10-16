import { useCallback, useEffect, useRef, useState } from 'react'
import { computeReadiness, effectiveSourceStatus, sourcesForClaim, type ArticleBundle, type Claim, type Source, type VersionComparison, type WritePermissions } from '@buildaharness/aielia'
import type { WriteServices } from './write-services'
import './write.css'

type Tab = 'text' | 'outline' | 'issues' | 'sources' | 'history' | 'chat' | 'settings'
type VersionRow = { index: number; kind: 'published' | 'checkpoint'; label?: string; at: string; readiness: { openComments: number; unsourcedFactualClaims: number } }
interface ChatLine { id: number; from: 'you' | 'aielia'; text: string }

const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'outline', label: 'Outline' },
  { id: 'issues', label: 'Issues' },
  { id: 'sources', label: 'Sources' },
  { id: 'history', label: 'History' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
]

const ICONS: Record<Tab, string> = {
  text: 'M5 5h14M5 9h14M5 13h14M5 17h9',
  outline: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  issues: 'M12 3 2.5 20h19L12 3zM12 10v4M12 17h.01',
  sources: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  chat: 'M4 5h16v11H9l-5 4z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
}

/** The desktop layout starts at 960 px (see write.css). jsdom has no matchMedia, which reads as a phone. */
const isWide = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 960px)').matches === true

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
  const [tab, setTab] = useState<Tab>(() => (isWide() ? 'outline' : 'text'))
  // Desktop: the side panel opens when a rail button is clicked and closes when it is clicked again.
  const [railOpen, setRailOpen] = useState<boolean>(() => isWide())
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [viewing, setViewing] = useState<{ mode: 'view' | 'compare'; markdown: string; diff?: VersionComparison } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [chatInput, setChatInput] = useState('')
  const [askForEdits, setAskForEdits] = useState(false)
  const [perms, setPerms] = useState<WritePermissions | undefined>()
  const permsRef = useRef<WritePermissions | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)

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
      void service.updateText(activeId, value, { analyze: permsRef.current?.autoCheck === true }).then((o) => { setBundle(o.bundle); void refreshList() }, (err) => setNotice(String(err)))
    }, 800)
  }

  /** Puts the cursor at the start of a section in the text and scrolls to it. */
  function jumpTo(start: number): void {
    const ta = textRef.current
    if (!ta) return
    const at = Math.min(start, ta.value.length)
    ta.focus()
    ta.setSelectionRange(at, at)
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24
    ta.scrollTop = Math.max(0, (ta.value.slice(0, at).split('\n').length - 1) * lineHeight - lineHeight * 2)
    if (!isWide()) setTab('text')
  }

  function pickTab(id: Tab): void {
    if (isWide() && tab === id && railOpen) setRailOpen(false)
    else {
      setTab(id)
      setRailOpen(true)
    }
  }
  const isOn = (id: Tab): boolean => tab === id && (railOpen || id === 'text' || id === 'chat')

  useEffect(() => {
    if (!activeId) { setVersions([]); return }
    void service.history(activeId).then((v) => setVersions(v as VersionRow[]), () => undefined)
    setViewing(null)
  }, [service, activeId, bundle?.snapshots.length])

  async function saveVersion(): Promise<void> {
    if (!activeId) return
    const label = window.prompt('Name this version (optional)?') ?? undefined
    await run('Saving the version', async () => {
      await service.updateText(activeId, draft, { analyze: false })
      await service.saveVersion(activeId, label)
      await reload(activeId)
    })
  }

  /** Saves what is in the text box now, so a comparison or a restore starts from what the writer sees, not from the last autosave. */
  async function flushDraft(): Promise<void> {
    if (!activeId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await service.updateText(activeId, draft, { analyze: false })
  }

  async function openVersion(index: number, mode: 'view' | 'compare'): Promise<void> {
    if (!activeId) return
    await run('Opening the version', async () => {
      if (mode === 'compare') await flushDraft()
      const snap = await service.getVersion(activeId, index)
      setViewing(mode === 'view' ? { mode, markdown: snap.markdown } : { mode, markdown: snap.markdown, diff: await service.compareWithCurrent(activeId, index) })
    })
  }

  async function restoreVersion(index: number): Promise<void> {
    if (!activeId) return
    if (!window.confirm('Restore this version as your working article? The article as it is now is saved first, so nothing is lost.')) return
    await run('Restoring', async () => {
      await flushDraft()
      await service.restore(activeId, index)
      await reload(activeId)
      setNotice('Restored. The article as it was before is in History.')
    })
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
        <select className="write__switch" aria-label="Article" value={activeId ?? ''} onChange={(e) => void select(e.target.value)} disabled={articles.length === 0}>
          {articles.length === 0 && <option value="">No articles yet</option>}
          {articles.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <div className="write__actions">
          <button type="button" onClick={() => void createArticle()}>New</button>
          <button type="button" onClick={() => void check()} disabled={!activeId || busy !== null}>Check article</button>
          <button type="button" onClick={() => void publish()} disabled={!activeId || busy !== null}>Publish</button>
          <button type="button" onClick={() => void exportArticle()} disabled={!activeId}>Export</button>
          <label className="write__import">Import<input type="file" accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importArticle(f); e.target.value = '' }} /></label>
        </div>
      </header>
      {(busy || notice) && <p className="write__notice" role="status">{busy ? `${busy}…` : notice}</p>}

      {readiness && (
        <p className="write__status" aria-label="How close the article is to publishable">
          {readiness.unsourcedFactualClaims} unsourced · {readiness.staleOrUnsupportedClaims} stale or unsupported · {readiness.openComments} open comment{readiness.openComments === 1 ? '' : 's'} · {readiness.sectionsNeedingReview} section{readiness.sectionsNeedingReview === 1 ? '' : 's'} to review
        </p>
      )}

      <main className="write__main" data-open={railOpen ? "true" : "false"}>
        <nav className="write__rail" aria-label="Panels">
          {TABS.map((t) => (
            <button key={t.id} type="button" data-tab={t.id} className={isOn(t.id) ? 'is-on' : ''} aria-pressed={isOn(t.id)} aria-label={t.label} onClick={() => pickTab(t.id)}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d={ICONS[t.id]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <aside className="write__panel" aria-label="Side panel">
          {activeId && bundle && meta ? (
            <>
              <section className={`write__pane write__panel-pane ${tab === 'outline' ? 'is-shown' : ''}`} aria-label="Outline">
                <h2 className="write__panehead">Outline</h2>
                <p className="write__muted">The headings of your text. Click one to go there.</p>
                <ul className="write__list write__outline">
                  {meta.sections.map((s) => (
                    <li key={s.id} style={{ marginLeft: `${Math.max(0, s.level - 1) * 12}px` }}>
                      <button type="button" className="write__link" onClick={() => jumpTo(s.span.start)}>{s.heading || '(opening)'}</button>
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
              <section className={`write__pane write__panel-pane ${tab === 'issues' ? 'is-shown' : ''}`} aria-label="Issues">
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
              <section className={`write__pane write__panel-pane ${tab === 'sources' ? 'is-shown' : ''}`} aria-label="Sources">
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
              <section className={`write__pane write__panel-pane ${tab === 'history' ? 'is-shown' : ''}`} aria-label="History">
                <h2 className="write__panehead">History</h2>
                <p className="write__muted">Versions of this article. Published versions are frozen. The others are saved before a large change or a suggestion you accept, and when you press Save version.</p>
                <button type="button" onClick={() => void saveVersion()} disabled={busy !== null}>Save version</button>
                <ul className="write__list">
                  {versions.map((v) => (
                    <li key={v.index}>
                      <strong>{v.label ?? (v.kind === 'published' ? 'Published' : 'Saved')}</strong> <span className="write__badge">{v.kind === 'published' ? 'published' : 'saved'}</span>
                      <p className="write__reason">{new Date(v.at).toLocaleString()} · then: {v.readiness.openComments} open comment{v.readiness.openComments === 1 ? '' : 's'}, {v.readiness.unsourcedFactualClaims} unsourced</p>
                      <button type="button" onClick={() => void openVersion(v.index, 'view')}>View</button>
                      <button type="button" onClick={() => void openVersion(v.index, 'compare')}>Compare with now</button>
                      <button type="button" onClick={() => void restoreVersion(v.index)}>Restore</button>
                    </li>
                  ))}
                  {versions.length === 0 && <li className="write__muted">No saved versions yet.</li>}
                </ul>
                {viewing && (
                  <div className="write__version" aria-label="Version detail">
                    <h3>{viewing.mode === 'view' ? 'Text of this version' : 'Changes since this version'}</h3>
                    {viewing.mode === 'view' ? (
                      <pre className="write__pre">{viewing.markdown}</pre>
                    ) : (
                      <>
                        <p className="write__muted">{viewing.diff && viewing.diff.changedLines === 0 ? 'The text is the same as now.' : `${viewing.diff?.changedLines ?? 0} changed lines. Red was in that version, green is in the article now.`}</p>
                        <pre className="write__pre write__diff">{(viewing.diff?.text ?? []).filter((l) => l.type !== 'same').map((l, i) => <span key={i} className={`write__diff--${l.type}`}>{l.type === 'add' ? '+ ' : '- '}{l.text}{'\n'}</span>)}</pre>
                        {(viewing.diff?.claims.length ?? 0) > 0 && <ul className="write__list">{viewing.diff?.claims.map((c) => <li key={c.quote}>{c.quote}<p className="write__reason">{STATUS_LABEL[c.from] ?? 'not in the article'} → {STATUS_LABEL[c.to] ?? 'not in the article'}</p></li>)}</ul>}
                        {(viewing.diff?.sources.length ?? 0) > 0 && <ul className="write__list">{viewing.diff?.sources.map((x) => <li key={x.id}>Source {x.address ?? x.id}: {x.change}</li>)}</ul>}
                      </>
                    )}
                    <button type="button" onClick={() => setViewing(null)}>Close</button>
                  </div>
                )}
                <h3>Suggested changes you decided</h3>
                <ul className="write__list">
                  {meta.suggestions.filter((x) => x.state !== 'pending').map((x) => <li key={x.id}><span className="write__badge">{x.state.replace('_', ' ')}</span> <del>{x.span.quote}</del> → <ins>{x.replacement}</ins></li>)}
                  {meta.suggestions.every((x) => x.state === 'pending') && <li className="write__muted">None yet.</li>}
                </ul>
              </section>
            </>
          ) : (
            <p className="write__muted">Create or import an article to use the panels.</p>
          )}
          <section className={`write__pane write__panel-pane ${tab === 'settings' ? 'is-shown' : ''}`} aria-label="Settings">
            <SettingsPane perms={perms} spent={services.spentUsd()} onSave={(p) => run('Saving', async () => { await services.permissions.set(p); permsRef.current = p; setPerms(p) })} />
          </section>
        </aside>
        {!activeId || !bundle || !meta ? (
          <p className="write__empty">Create an article, or import one, to begin.</p>
        ) : (
          <section className={`write__pane write__pane--text ${tab === 'text' ? 'is-shown' : ''}`} aria-label="Text">
            <textarea ref={textRef} aria-label="Article text" value={draft} onChange={(e) => onType(e.target.value)} spellCheck />
          </section>
        )}
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
