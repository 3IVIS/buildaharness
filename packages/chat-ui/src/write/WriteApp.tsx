import { useCallback, useEffect, useRef, useState } from 'react'
import { claimMarks, collectIssues, computeReadiness, effectiveSourceStatus, issueCount, type ArticleBundle, type ChangeSummary, type DependencyKind, type IssueCategory, type StyleProfile, type WritePermissions } from '@buildaharness/aielia'
import type { ChatAction } from './AdjustBar'
import { ArticleSwitcher, type ArticleItem } from './ArticleSwitcher'
import { ChatPane, type ChatLine } from './ChatPane'
import { HistoryPanel, type VersionRow, type Viewing } from './HistoryPanel'
import { IdeasPanel } from './IdeasPanel'
import { StylePanel } from './StylePanel'
import { MarkedText } from './MarkedText'
import { IssuesPanel, type ResolveNote } from './IssuesPanel'
import { LinksPanel } from './LinksPanel'
import { OutlinePanel } from './OutlinePanel'
import { SettingsPane } from './SettingsPane'
import { TextNotes, looksLikeLink, type NoteKind } from './TextNotes'
import { Icon } from './icons'
import type { WriteServices } from './write-services'
import './write.css'

type Tab = 'text' | 'outline' | 'style' | 'ideas' | 'issues' | 'links' | 'history' | 'chat' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'outline', label: 'Outline' },
  { id: 'style', label: 'Style' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'issues', label: 'Issues' },
  { id: 'links', label: 'Links' },
  { id: 'history', label: 'History' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
]

const RAIL_ICONS: Record<Tab, string> = {
  text: 'M5 5h14M5 9h14M5 13h14M5 17h9',
  outline: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  style: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  ideas: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  issues: 'M12 3 2.5 20h19L12 3zM12 10v4M12 17h.01',
  links: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  chat: 'M4 5h16v11H9l-5 4z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
}

/** The desktop layout starts at 960 px (see write.css). jsdom has no matchMedia, which reads as a phone. */
/** The side rail layout (tablet and desktop) starts at 640 px; below that the rail is a bottom bar and the chat is a sheet. See write.css. */
const isWide = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 640px)').matches === true

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

const isTextFile = (f: File): boolean => f.type.startsWith('text/') || ['.txt', '.md', '.csv', '.tsv', '.json', '.log'].some((ext) => f.name.toLowerCase().endsWith(ext))

let lineId = 0

export function WriteApp({ services }: { services: WriteServices }): React.JSX.Element {
  const { service, port } = services
  const [articles, setArticles] = useState<ArticleItem[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [bundle, setBundle] = useState<ArticleBundle | undefined>()
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<Tab>(() => (isWide() ? 'outline' : 'text'))
  // Desktop: the side panel opens when a rail button is clicked and closes when it is clicked again.
  const [railOpen, setRailOpen] = useState<boolean>(() => isWide())
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [working, setWorking] = useState<ChangeSummary | undefined>(undefined)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [chatInput, setChatInput] = useState('')
  const [askForEdits, setAskForEdits] = useState(false)
  // Where the cursor or selection is in the text: the comments and sources under it are for that text.
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [notes, setNotes] = useState<ResolveNote[]>([])
  const [, setModelTick] = useState(0)
  const [perms, setPerms] = useState<WritePermissions | undefined>()
  const permsRef = useRef<WritePermissions | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const chatModel = services.models.chat()

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
  }, [service, port, refreshList, reload, services.permissions])

  useEffect(() => {
    if (!activeId) { setVersions([]); setWorking(undefined); return }
    void service.history(activeId).then((v) => setVersions(v as VersionRow[]), () => undefined)
    void service.changeSinceLastVersion(activeId).then(setWorking, () => undefined)
    setViewing(null)
  }, [service, activeId, bundle])

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

  /** Saves what is in the text box now, so a comparison, a restore or a batch starts from what the writer sees, not from the last autosave. */
  async function flushDraft(): Promise<void> {
    if (!activeId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await service.updateText(activeId, draft, { analyze: false })
  }

  /** Runs a change to the article that starts from the saved text, then shows the result. */
  const [profiles, setProfiles] = useState<StyleProfile[]>([])
  useEffect(() => { void service.profiles().then(setProfiles).catch(() => undefined) }, [service])

  const change = (label: string, work: (id: string) => Promise<void>): void => {
    if (!activeId) return
    void run(label, async () => { await flushDraft(); await work(activeId); await reload(activeId) })
  }

  async function select(id: string): Promise<void> {
    setActiveId(id)
    await port.setActive(id)
    await reload(id)
  }

  async function createArticle(): Promise<void> {
    const title = window.prompt('Name of the new article?')?.trim()
    if (!title) return
    await run('Creating', async () => {
      const id = await service.create(title, `# ${title}\n\n`)
      await refreshList()
      await select(id)
    })
  }

  async function renameArticle(): Promise<void> {
    if (!activeId) return
    const current = articles.find((a) => a.id === activeId)
    const name = window.prompt('New name for this article?', current?.name ?? current?.title ?? '')?.trim()
    if (!name) return
    await run('Renaming', async () => { await service.rename(activeId, name); await refreshList() })
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

  /** Puts the cursor at a place in the text and scrolls to it. */
  function jumpTo(start: number): void {
    const ta = textRef.current
    if (!ta) return
    const at = Math.min(start, ta.value.length)
    ta.focus()
    ta.setSelectionRange(at, at)
    setSelection({ start: at, end: at })
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24
    ta.scrollTop = Math.max(0, (ta.value.slice(0, at).split('\n').length - 1) * lineHeight - lineHeight * 2)
    if (!isWide()) setTab('text')
  }

  function pickTab(id: Tab): void {
    if (isWide() && tab === id && railOpen) setRailOpen(false)
    else { setTab(id); setRailOpen(true) }
  }
  const isOn = (id: Tab): boolean => tab === id && (railOpen || id === 'text' || id === 'chat')

  // ---- publish, export, import
  async function publish(): Promise<void> {
    if (!activeId) return
    const label = window.prompt('Label for this published version (optional)?') ?? undefined
    await run('Publishing', async () => {
      await flushDraft()
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
    a.download = `${bundle?.meta.name ?? bundle?.meta.title ?? 'article'}.aielia-article.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function importArticle(file: File): Promise<void> {
    await run('Importing', async () => {
      let folder: Record<string, string>
      try { folder = JSON.parse(await file.text()) as Record<string, string> } catch { throw new Error('That file is not an exported article.') }
      const r = await service.importArticle(folder)
      if (!r.ok) throw new Error(r.reason)
      await refreshList()
      await select(r.id)
    })
  }

  // ---- history
  const saveVersion = (): void => {
    const label = window.prompt('Name this version (optional)?') ?? undefined
    change('Saving the version', async (id) => { await service.saveVersion(id, label) })
  }
  const openVersion = (index: number, mode: 'view' | 'compare'): void => {
    if (!activeId) return
    void run('Opening the version', async () => {
      if (mode === 'compare') await flushDraft()
      const snap = await service.getVersion(activeId, index)
      setViewing(mode === 'view' ? { mode, markdown: snap.markdown } : { mode, markdown: snap.markdown, diff: await service.compareWithCurrent(activeId, index) })
    })
  }
  const restoreVersion = (index: number): void => {
    if (!window.confirm('Restore this version as your working article? The article as it is now is saved first, so nothing is lost.')) return
    change('Restoring', async (id) => { await service.restore(id, index); setNotice('Restored. The article as it was before is in History.') })
  }

  // ---- links
  const findLinks = (): void => change('Looking for links between sections', async (id) => {
    const r = await service.findDependencies(id, chatModel)
    setNotice(r.status === 'failed' ? 'The search for links could not run. Nothing was changed.' : r.added.length === 0 ? 'No new links found.' : `Found ${r.added.length} possible link${r.added.length === 1 ? '' : 's'} (${chatModel}). Confirm the ones that are right.`)
  })
  const removeLink = (linkId: string, origin: string): void => {
    if (origin !== 'proposed' && !window.confirm('Remove this link? You confirmed or drew it yourself.')) return
    change('Removing the link', async (id) => { await service.removeDependency(id, linkId) })
  }

  // ---- comments and sources under the text
  async function addSourceAndPlace(src: { kind: 'web' | 'upload' | 'say_so'; address?: string; passage?: string; note?: string }, attach: boolean): Promise<void> {
    if (!activeId) return
    const sid = await service.addSource(activeId, src)
    if (src.kind === 'web') {
      const read = await service.readSource(activeId, sid)
      if (read.status === 'read') setNotice('I read the page and stored its text.')
      else if (read.reason) setNotice(`Link stored. ${read.reason}${read.status === 'unreachable' ? ' Paste the passage instead.' : ''}`)
    }
    if (attach && selection) {
      const r = await service.attachSourceToText(activeId, selection, sid)
      if (!r.ok) setNotice(r.reason)
    } else {
      const r = await service.proposeLinksForSource(activeId, sid, chatModel)
      setNotice(r.status === 'failed' ? 'Source stored. Finding where it belongs could not run.' : r.added.length === 0 ? 'Source stored. I did not find a claim it bears on.' : `Source stored. It may back ${r.added.length} claim${r.added.length === 1 ? '' : 's'}: click in the text to confirm.`)
    }
  }

  const addNote = (kind: NoteKind, text: string): void => {
    if (!selection) return
    change(kind === 'comment' ? 'Adding the comment' : 'Adding the source', async (id) => {
      if (kind === 'comment') {
        const r = await service.addComment(id, selection, text)
        if (!r.ok) setNotice(r.reason)
      } else if (kind === 'say_so') await addSourceAndPlace({ kind: 'say_so', note: text }, true)
      else await addSourceAndPlace(looksLikeLink(text) ? { kind: 'web', address: text } : { kind: 'upload', passage: text }, true)
    })
  }

  const dropFiles = (files: File[], attach: boolean, say = false): void => {
    change('Adding the files', async () => {
      const lines: string[] = []
      for (const f of files) {
        if (!isTextFile(f)) { lines.push(`${f.name}: only text files can be read for now.`); continue }
        await addSourceAndPlace({ kind: 'upload', address: f.name, passage: await f.text() }, attach)
        lines.push(`${f.name}: added.`)
      }
      if (say) setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: `${lines.join('\n')}\nI stored ${files.length === 1 ? 'it' : 'them'} and looked for the claims they bear on. Click in the text to see and confirm them under it.`, model: chatModel }])
      else setNotice(lines.join(' '))
    })
  }

  // ---- ideas
  const suggestIdeas = (request: string): void => change(`Finding ideas with ${chatModel}`, async (id) => {
    const r = await service.suggestIdeas(id, request, chatModel)
    setNotice(r.status === 'failed' ? 'The search for ideas could not run.' : r.added.length === 0 ? 'I had nothing new to add.' : `Added ${r.added.length} idea${r.added.length === 1 ? '' : 's'} (${chatModel}).`)
  })
  const writeIdeas = (ids: string[]): void => change(`Writing the ideas in with ${chatModel}`, async (id) => {
    const r = await service.writeIdeasIn(id, ids, undefined, chatModel)
    setNotice(r.status === 'failed' ? 'I could not turn the ideas into edits.' : r.added.length === 0 ? 'I found no place in the text for those ideas.' : `I added ${r.added.length} suggested change${r.added.length === 1 ? '' : 's'} from your ideas (${chatModel}). Accept them in Issues.`)
  })

  // ---- issues in batches
  const resolveCategory = (category: IssueCategory): void => change('Working on it', async (id) => {
    const r = await service.resolveCategory(id, category, { model: chatModel })
    setNotes([{ category, done: r.done, note: r.note }])
  })
  const resolveAll = (): void => change(`Resolving with ${chatModel}`, async (id) => {
    const reports = await service.resolveAll(id, { model: chatModel })
    setNotes(reports.filter((r) => r.done > 0 || r.note).map((r) => ({ category: r.category, done: r.done, note: r.note })))
  })

  // ---- chat
  /** A check started from the chat, with the model chosen there. The result is said in the chat, with the model's name. */
  const checkFromChat = (): void => {
    if (!activeId) return
    const used = services.models.chat()
    setChat((c) => [...c, { id: ++lineId, from: 'you', text: 'Check the article' }])
    void run(`Checking with ${used}`, async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const o = await service.updateText(activeId, draft, { model: used })
      const full = o.changedSectionIds.length === 0 ? await service.analyze(activeId, used) : o
      const b = await service.get(activeId)
      setBundle(b)
      let text: string
      if (!full.extraction || full.extraction.status === 'not_extracted') {
        text = 'The check could not run, so nothing was marked as checked.'
      } else {
        const factual = b.meta.claims.filter((c) => c.kind === 'factual')
        const statuses = factual.map((c) => effectiveSourceStatus(c, b.meta.sources))
        const supported = statuses.filter((x) => x === 'supported').length
        const unsourced = statuses.filter((x) => x === 'none' || x === 'attached').length
        const flagged = full.resolution?.flagged.length ?? 0
        text = `I found ${factual.length} factual claim${factual.length === 1 ? '' : 's'}: ${supported} supported, ${unsourced} without a checked source, ${statuses.length - supported - unsourced} to look at.${flagged > 0 ? ` ${flagged} other section${flagged === 1 ? '' : 's'} may need a look because of what changed.` : ''} Details are in Issues.`
      }
      setChat((c) => [...c, { id: ++lineId, from: 'aielia', text, model: used }])
    })
  }

  /** One chat message, the same path whether typed or composed by the Adjust control. `edits` overrides "Suggest edits" for this message. */
  async function sendChat(override?: string, edits?: boolean): Promise<void> {
    const text = (override ?? chatInput).trim()
    if (!text) return
    const wantEdits = edits ?? askForEdits
    if (override === undefined) setChatInput('')
    setChat((c) => [...c, { id: ++lineId, from: 'you', text }])
    await run(wantEdits ? 'Asking for edits' : 'Thinking', async () => {
      if (activeId) await service.updateText(activeId, draft, { analyze: false })
      if (wantEdits && activeId) {
        // Record what the writer said (comments, corrections) the same way a chat turn does, then turn the request into suggestions.
        const { reply, model: said } = await services.chat(text, activeId)
        const r = await service.suggest(activeId, text, said)
        setBundle(await service.get(activeId))
        const summary = r.status === 'failed' ? 'I could not turn that into edits.' : r.added.length === 0 ? 'I found nothing to change in the text for that.' : `I added ${r.added.length} suggested change${r.added.length === 1 ? '' : 's'}. Open Issues to accept or reject them.`
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: `${reply}\n\n${summary}`, model: said }])
      } else {
        const { reply, model: said } = await services.chat(text, activeId)
        if (activeId) setBundle(await service.get(activeId))
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: reply, model: said }])
      }
    })
  }

  const meta = bundle?.meta
  const readiness = meta ? computeReadiness(meta) : undefined
  const issues = meta ? issueCount(collectIssues(meta)) : 0
  const ready = Boolean(activeId && bundle && meta)

  return (
    <div className="write">
      <header className="write__bar">
        <h1 className="write__title">Aielia Write</h1>
        <ArticleSwitcher articles={articles} activeId={activeId} onSelect={(id) => void select(id)} onRename={() => void renameArticle()} onNew={() => void createArticle()} onExport={() => void exportArticle()} onImport={(f) => void importArticle(f)} />
        <div className="write__actions">
          <button type="button" className="write__primary" onClick={() => void publish()} disabled={!activeId || busy !== null}>Publish</button>
        </div>
      </header>
      {(busy || notice) && <p className="write__notice" role="status">{busy ? `${busy}…` : notice}</p>}

      {readiness && (
        <p className="write__status" aria-label="How close the article is to publishable">
          {readiness.unsourcedFactualClaims} unsourced · {readiness.staleOrUnsupportedClaims} stale or unsupported · {readiness.openComments} open comment{readiness.openComments === 1 ? '' : 's'} · {readiness.sectionsNeedingReview} section{readiness.sectionsNeedingReview === 1 ? '' : 's'} to review
        </p>
      )}

      <main className="write__main" data-open={railOpen ? 'true' : 'false'} data-tab={tab}>
        <nav className="write__rail" aria-label="Panels">
          {TABS.map((t) => (
            <button key={t.id} type="button" data-tab={t.id} className={isOn(t.id) ? 'is-on' : ''} aria-pressed={isOn(t.id)} aria-label={t.label} onClick={() => pickTab(t.id)}>
              <Icon d={RAIL_ICONS[t.id]} size={22} />
              <span>{t.label}</span>
              {t.id === 'issues' && issues > 0 && <span className="write__railbadge" aria-label={`${issues} issues`}>{issues}</span>}
            </button>
          ))}
        </nav>
        <aside className="write__panel" aria-label="Side panel">
          {ready && meta ? (
            <>
              <section className={`write__pane write__panel-pane ${tab === 'outline' ? 'is-shown' : ''}`} aria-label="Outline">
                <OutlinePanel meta={meta} onJump={jumpTo} onRename={(sid, h) => change('Renaming the heading', async (id) => { const r = await service.renameSection(id, sid, h); if (!r.ok) setNotice(r.reason) })} onPurpose={(sid, t) => change('Saving', async (id) => { await service.setSectionPurpose(id, sid, t) })} onClear={(sid) => change('Saving', async (id) => { await service.setReview(id, sid, 'clean') })} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'style' ? 'is-shown' : ''}`} aria-label="Style">
                <StylePanel meta={meta} profiles={profiles} busy={busy !== null} onBrief={(b) => change('Saving the brief', async (id) => { await service.setBrief(id, b) })} onUse={(pid) => change('Saving', async (id) => { const r = await service.useProfile(id, pid); if (!r.ok && r.reason) setNotice(r.reason) })} onSaveProfile={(p) => change('Saving the profile', async (id) => { const saved = await service.saveProfile(p); if (saved) await service.useProfile(id, saved.id); setProfiles(await service.profiles()) })} onDeleteProfile={(pid) => change('Deleting the profile', async () => { await service.deleteProfile(pid); setProfiles(await service.profiles()) })} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'ideas' ? 'is-shown' : ''}`} aria-label="Ideas">
                <IdeasPanel meta={meta} busy={busy !== null} model={chatModel} onAdd={(t) => change('Adding the idea', async (id) => { const r = await service.addIdea(id, { text: t }); if (!r.ok) setNotice(r.reason) })} onSuggest={suggestIdeas} onEdit={(iid, t) => change('Saving', async (id) => { await service.updateIdea(id, iid, { text: t }) })} onWrite={writeIdeas} onRemove={(iid) => change('Saving', async (id) => { await service.deleteIdea(id, iid) })} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'issues' ? 'is-shown' : ''}`} aria-label="Issues">
                <IssuesPanel
                  meta={meta}
                  busy={busy !== null}
                  model={chatModel}
                  notes={notes}
                  onResolve={resolveCategory}
                  onResolveAll={resolveAll}
                  onClearNotes={() => setNotes([])}
                  onAccept={(sid) => change('Applying', async (id) => { const r = await service.acceptSuggestionAndUpdate(id, sid, undefined, { analyze: false }); if (!r.ok) setNotice(r.reason) })}
                  onReject={(sid) => change('Saving', async (id) => { await service.rejectSuggestionById(id, sid) })}
                  onEditSuggestion={(sid, t) => change('Saving', async (id) => { await service.editSuggestion(id, sid, t) })}
                  onCommentState={(cid, st) => change('Saving', async (id) => { await service.setCommentState(id, cid, st) })}
                  onEditComment={(cid, t) => change('Saving', async (id) => { await service.editComment(id, cid, { text: t }) })}
                  onClearSection={(sid) => change('Saving', async (id) => { await service.setReview(id, sid, 'clean') })}
                  onConfirmLink={(lid) => change('Saving', async (id) => { await service.confirmDependency(id, lid) })}
                  onRemoveLink={(lid) => change('Saving', async (id) => { await service.removeDependency(id, lid) })}
                  onEditCorrection={(cid, t) => change('Saving', async (id) => { await service.editCorrection(id, cid, { note: t }) })}
                  onJump={jumpTo}
                />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'links' ? 'is-shown' : ''}`} aria-label="Links">
                <LinksPanel meta={meta} busy={busy !== null} model={chatModel} onFind={findLinks} onConfirm={(lid) => change('Saving', async (id) => { await service.confirmDependency(id, lid) })} onRemove={removeLink} onAdd={(f, t, k: DependencyKind) => change('Adding the link', async (id) => { const r = await service.addDependency(id, f, t, k); if (!r.ok) setNotice(r.reason) })} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'history' ? 'is-shown' : ''}`} aria-label="History">
                <HistoryPanel versions={versions} working={working} viewing={viewing} busy={busy !== null} statusLabel={STATUS_LABEL} onSave={saveVersion} onView={(i) => openVersion(i, 'view')} onCompare={(i) => openVersion(i, 'compare')} onRestore={restoreVersion} onRename={(i, l) => change('Saving', async (id) => { await service.renameVersion(id, i, l) })} onClose={() => setViewing(null)} />
              </section>
            </>
          ) : (
            <p className="write__muted">Create or import an article to use the panels.</p>
          )}
          <section className={`write__pane write__panel-pane ${tab === 'settings' ? 'is-shown' : ''}`} aria-label="Settings">
            <SettingsPane perms={perms} spent={services.spentUsd()} spentByType={services.spendByType()} autoModel={services.models.auto()} chatModel={chatModel} suggestions={services.models.suggestions} onAutoModel={(m) => void services.models.setAuto(m).then(() => setModelTick((t) => t + 1))} onSave={(p) => run('Saving', async () => { await services.permissions.set(p); permsRef.current = p; setPerms(p) })} />
          </section>
        </aside>
        {ready && meta ? (
          <section className={`write__pane write__pane--text ${tab === 'text' || tab === 'chat' ? 'is-shown' : ''}`} aria-label="Text">
            <MarkedText textRef={textRef} value={draft} marks={claimMarks(meta, draft)} onChange={onType} onSelection={setSelection} />
            <TextNotes
              meta={meta}
              markdown={draft}
              selection={selection}
              busy={busy !== null}
              model={chatModel}
              onAdd={addNote}
              onFiles={(files) => dropFiles(files, selection !== null)}
              onEditComment={(cid, t) => change('Saving', async (id) => { await service.editComment(id, cid, { text: t }) })}
              onResolveComment={(cid) => change('Saving', async (id) => { await service.setCommentState(id, cid, 'addressed') })}
              onDeleteComment={(cid) => change('Saving', async (id) => { await service.deleteComment(id, cid) })}
              onDetach={(claimId, sourceId) => change('Saving', async (id) => { await service.detachSource(id, claimId, sourceId) })}
              onConfirm={(claimId, sourceId) => change('Saving', async (id) => { const link = meta.links.find((l) => l.kind === 'supported_by' && l.from.id === claimId && l.to.id === sourceId); if (link) await service.confirmDependency(id, link.id) })}
              onRead={(sourceId) => change('Reading the page', async (id) => {
                const r = await service.readSource(id, sourceId, services.models.auto())
                setNotice(r.status === 'read' ? 'I read the page and stored its text.' : r.status === 'unchanged' ? 'The page has not changed.' : r.status === 'changed' ? `The page has changed. ${r.impacts.filter((i) => i.impact !== 'none').length} claim${r.impacts.filter((i) => i.impact !== 'none').length === 1 ? '' : 's'} may be affected. Accept the new text to use it.` : r.reason ?? 'The page could not be read.')
              })}
              onAcceptNew={(sourceId) => change('Saving', async (id) => { const r = await service.acceptSourceChange(id, sourceId); if (!r.ok && r.reason) setNotice(r.reason) })}
              onCheck={(claimId) => change(`Checking with ${chatModel}`, async (id) => { const r = await service.checkClaim(id, claimId, chatModel); setNotice(r.status === 'checked' ? `Checked with ${chatModel}: ${r.verdict.replace('_', ' ')}. ${r.reason}` : r.status === 'no_sources' ? 'There is no stored passage to check against.' : r.reason) })}
            />
          </section>
        ) : (
          <p className="write__empty">Create an article, or import one, to begin.</p>
        )}
        <ChatPane
          onClose={() => setTab('text')}
          lines={chat}
          model={chatModel}
          suggestions={services.models.suggestions}
          onModel={(m) => void services.models.setChat(m).then(() => setModelTick((t) => t + 1))}
          input={chatInput}
          onInput={setChatInput}
          edits={askForEdits}
          onEdits={setAskForEdits}
          busy={busy !== null}
          canAct={Boolean(activeId)}
          shown={tab === 'chat'}
          onSend={() => void sendChat()}
          onAdjust={(m) => { setAskForEdits(true); void sendChat(m, true) }}
          onAction={(a: ChatAction) => { if (a === 'check') checkFromChat() }}
          onSaveIdea={(l) => change('Saving', async (id) => { const r = await service.addIdea(id, { text: l.text, origin: 'assistant', model: l.model }); if (!r.ok) setNotice(r.reason) })}
          onDropFiles={(files) => dropFiles(files, false, true)}
        />
      </main>
    </div>
  )
}

