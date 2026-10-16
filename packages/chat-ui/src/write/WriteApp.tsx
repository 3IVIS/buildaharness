import { useCallback, useEffect, useRef, useState } from 'react'
import { DEPENDENCY_KINDS, DEPENDENCY_LABEL, computeReadiness, dependenciesOf, effectiveSourceStatus, type DependencyKind, type ArticleBundle, type ChangeSummary, type VersionComparison, type WritePermissions } from '@buildaharness/aielia'
import { AdjustBar } from './AdjustBar'
import { ArticleSwitcher, type ArticleItem } from './ArticleSwitcher'
import { IdeasPanel } from './IdeasPanel'
import { ModelPicker } from './ModelPicker'
import { SourceDock, type NewSource } from './SourceDock'
import type { WriteServices } from './write-services'
import './write.css'

type Tab = 'text' | 'outline' | 'ideas' | 'issues' | 'links' | 'history' | 'chat' | 'settings'
type VersionRow = { index: number; kind: 'published' | 'checkpoint'; label?: string; at: string; change: ChangeSummary }
interface ChatLine { id: number; from: 'you' | 'aielia'; text: string; model?: string }

const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'outline', label: 'Outline' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'issues', label: 'Issues' },
  { id: 'links', label: 'Links' },
  { id: 'history', label: 'History' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
]

const ICONS: Record<Tab, string> = {
  text: 'M5 5h14M5 9h14M5 13h14M5 17h9',
  outline: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  issues: 'M12 3 2.5 20h19L12 3zM12 10v4M12 17h.01',
  ideas: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  links: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  chat: 'M4 5h16v11H9l-5 4z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
}

const ICON_PATHS = {
  view: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  compare: 'M7 7h11l-3-3M17 17H6l3 3',
  restore: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  published: 'M5 21V4M5 4h12l-2 4 2 4H5',
  saved: 'M6 3h12v18l-6-4-6 4z',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7M8 21v-6h8',
}

function Icon({ d, size = 18 }: { d: string; size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One line saying what a version changed: lines, then the sections, claims and sources it touched. */
function describeChange(c: ChangeSummary | undefined): string {
  if (!c) return 'Nothing saved yet'
  if (c.first) return 'First version'
  const parts: string[] = []
  parts.push(c.added === 0 && c.removed === 0 ? 'No text changes' : `+${c.added} −${c.removed} lines`)
  if (c.sections.length > 0) parts.push(c.sections.length <= 3 ? c.sections.join(', ') : `${c.sections.slice(0, 3).join(', ')} and ${c.sections.length - 3} more`)
  if (c.claims > 0) parts.push(`${c.claims} claim${c.claims === 1 ? '' : 's'}`)
  if (c.sources > 0) parts.push(`${c.sources} source${c.sources === 1 ? '' : 's'}`)
  return parts.join(' · ')
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
  const [articles, setArticles] = useState<ArticleItem[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [bundle, setBundle] = useState<ArticleBundle | undefined>()
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<Tab>(() => (isWide() ? 'outline' : 'text'))
  // Desktop: the side panel opens when a rail button is clicked and closes when it is clicked again.
  const [railOpen, setRailOpen] = useState<boolean>(() => isWide())
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [working, setWorking] = useState<ChangeSummary | undefined>(undefined)
  const [linkFrom, setLinkFrom] = useState('')
  const [linkTo, setLinkTo] = useState('')
  const [linkKind, setLinkKind] = useState<DependencyKind>('rests_on')
  const [viewing, setViewing] = useState<{ mode: 'view' | 'compare'; markdown: string; diff?: VersionComparison } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [chatInput, setChatInput] = useState('')
  const [askForEdits, setAskForEdits] = useState(false)
  // Where the cursor or selection is in the text: the sources dock shows the sources for that text.
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [, setModelTick] = useState(0)
  const chatModel = services.models.chat()
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
    await run('Renaming', async () => {
      await service.rename(activeId, name)
      await refreshList()
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
    if (!activeId) { setVersions([]); setWorking(undefined); return }
    void service.history(activeId).then((v) => setVersions(v as VersionRow[]), () => undefined)
    void service.changeSinceLastVersion(activeId).then(setWorking, () => undefined)
    setViewing(null)
  }, [service, activeId, bundle?.snapshots.length, bundle?.markdown])

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

  async function findLinks(): Promise<void> {
    if (!activeId) return
    await run('Looking for links between sections', async () => {
      await flushDraft()
      const r = await service.findDependencies(activeId)
      await reload(activeId)
      setNotice(r.status === 'failed' ? 'The search for links could not run. Nothing was changed.' : r.added.length === 0 ? 'No new links found.' : `Found ${r.added.length} possible link${r.added.length === 1 ? '' : 's'}. Confirm the ones that are right.`)
    })
  }

  async function addLink(): Promise<void> {
    if (!activeId) return
    await run('Adding the link', async () => {
      const r = await service.addDependency(activeId, linkFrom, linkTo, linkKind)
      if (!r.ok) setNotice(r.reason)
      else { setLinkFrom(''); setLinkTo('') }
      await reload(activeId)
    })
  }

  async function removeLinkById(linkId: string, origin: string): Promise<void> {
    if (!activeId) return
    if (origin !== 'proposed' && !window.confirm('Remove this link? You confirmed or drew it yourself.')) return
    await run('Removing the link', async () => { await service.removeDependency(activeId, linkId); await reload(activeId) })
  }

  /** A check started from the chat, with the model chosen there. The result is said in the chat, with the model's name. */
  async function checkFromChat(): Promise<void> {
    if (!activeId) return
    const used = services.models.chat()
    setChat((c) => [...c, { id: ++lineId, from: 'you', text: 'Check the article' }])
    await run(`Checking with ${used}`, async () => {
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
        const look = statuses.length - supported - unsourced
        const flagged = full.resolution?.flagged.length ?? 0
        text = `I found ${factual.length} factual claim${factual.length === 1 ? '' : 's'}: ${supported} supported, ${unsourced} without a checked source, ${look} to look at.${flagged > 0 ? ` ${flagged} other section${flagged === 1 ? '' : 's'} may need a look because of what changed.` : ''} Details are in Issues.`
      }
      setChat((c) => [...c, { id: ++lineId, from: 'aielia', text, model: used }])
    })
  }

  const isTextFile = (f: File): boolean => f.type.startsWith('text/') || ['.txt', '.md', '.csv', '.tsv', '.json', '.log'].some((ext) => f.name.toLowerCase().endsWith(ext))

  /** Stores a source and either attaches it to the text under the cursor or asks the assistant where it belongs. */
  async function addSourceAndPlace(src: NewSource, attachHere: boolean): Promise<string | undefined> {
    if (!activeId) return undefined
    await flushDraft()
    const sid = await service.addSource(activeId, src)
    if (attachHere && selection) {
      const r = await service.attachSourceToText(activeId, selection, sid)
      if (!r.ok) setNotice(r.reason)
    } else {
      const r = await service.proposeLinksForSource(activeId, sid, services.models.chat())
      setNotice(r.status === 'failed' ? 'Source stored. Finding where it belongs could not run.' : r.added.length === 0 ? 'Source stored. I did not find a claim it bears on.' : `Source stored. It may back ${r.added.length} claim${r.added.length === 1 ? '' : 's'}: click in the text to confirm.`)
    }
    return sid
  }

  async function dropFiles(files: File[], attachHere: boolean, say = false): Promise<void> {
    if (!activeId) return
    await run('Adding the files', async () => {
      const lines: string[] = []
      for (const f of files) {
        if (!isTextFile(f)) { lines.push(`${f.name}: only text files can be read for now.`); continue }
        await addSourceAndPlace({ kind: 'upload', address: f.name, passage: await f.text() }, attachHere)
        lines.push(`${f.name}: added.`)
      }
      await reload(activeId)
      if (say) setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: `${lines.join('\n')}\nI stored ${files.length === 1 ? 'it' : 'them'} and looked for the claims they bear on. Click in the text to see and confirm them under it.`, model: services.models.chat() }])
      else setNotice(lines.join(' '))
    })
  }

  async function addIdeaText(text: string, sectionId: string | undefined): Promise<void> {
    if (!activeId) return
    await run('Adding the idea', async () => {
      const r = await service.addIdea(activeId, { text, sectionId })
      if (!r.ok) setNotice(r.reason)
      await reload(activeId)
    })
  }

  async function suggestIdeasNow(request: string): Promise<void> {
    if (!activeId) return
    const used = services.models.chat()
    await run(`Finding ideas with ${used}`, async () => {
      await flushDraft()
      const r = await service.suggestIdeas(activeId, request, used)
      await reload(activeId)
      setNotice(r.status === 'failed' ? 'The search for ideas could not run.' : r.added.length === 0 ? 'I had nothing new to add.' : `Added ${r.added.length} idea${r.added.length === 1 ? '' : 's'} (${used}).`)
    })
  }

  async function writeIdeasNow(ids: string[], how: string): Promise<void> {
    if (!activeId) return
    const used = services.models.chat()
    await run(`Writing the ideas in with ${used}`, async () => {
      await flushDraft()
      const r = await service.writeIdeasIn(activeId, ids, how, used)
      await reload(activeId)
      setNotice(r.status === 'failed' ? 'I could not turn the ideas into edits.' : r.added.length === 0 ? 'I found no place in the text for those ideas.' : `I added ${r.added.length} suggested change${r.added.length === 1 ? '' : 's'} from your ideas (${used}). Accept them in Issues.`)
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

  /** One chat message, the same path whether typed or composed by the Adjust control. `edits` overrides the "ask for edits" box for this message. */
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
  const sectionName = (sid: string): string => meta?.sections.find((x) => x.id === sid)?.heading || '(opening)'
  const readiness = meta ? computeReadiness(meta) : undefined

  return (
    <div className="write">
      <header className="write__bar">
        <h1 className="write__title">Aielia Write</h1>
        <ArticleSwitcher articles={articles} activeId={activeId} onSelect={(id) => void select(id)} onRename={() => void renameArticle()} />
        <div className="write__actions">
          <button type="button" onClick={() => void createArticle()}>New</button>
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
                <p className="write__muted">The headings of your text. A sub-heading (###) is indented under the section it belongs to. Click one to go there.</p>
                <ul className="write__list write__outline">
                {meta.sections.map((sec) => {
                  const isTitle = sec.level === 1
                  const base = Math.min(...meta.sections.filter((x) => x.level > 1).map((x) => x.level), 2)
                  const depth = isTitle ? 0 : Math.max(0, sec.level - base)
                  return (
                    <li key={sec.id} className={`${isTitle ? 'write__outline-title' : ''} ${depth > 0 ? 'is-nested' : ''}`} style={{ marginLeft: `${depth * 16}px` }}>
                      <button type="button" className="write__link" onClick={() => jumpTo(sec.span.start)}>{sec.heading || '(opening)'}</button>
                      {sec.review.state !== 'clean' && (
                        <span className={`write__badge write__badge--${sec.review.state}`}>
                          {sec.review.state === 'needs_review' ? 'needs review' : sec.review.state.replace('_', ' ')}
                        </span>
                      )}
                      {(() => {
                        const d = dependenciesOf(meta, sec.id)
                        const parts = [
                          ...d.uses.map((l) => `${DEPENDENCY_LABEL[l.kind as DependencyKind]} ${sectionName(l.to.id)}${l.origin === 'proposed' ? ' (suggested)' : ''}`),
                          ...(d.usedBy.length > 0 ? [`used by ${d.usedBy.map((l) => sectionName(l.from.id)).join(', ')}`] : []),
                        ]
                        return parts.length > 0 ? <p className="write__reason write__deps">{parts.join(' · ')}</p> : null
                      })()}
                      {sec.review.reason && <p className="write__reason">{sec.review.reason}</p>}
                      {sec.review.state === 'needs_review' && <button type="button" onClick={() => void run('Saving', async () => { await service.setReview(activeId, sec.id, 'clean'); await reload(activeId) })}>Mark clean</button>}
                    </li>
                  )
                })}
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
              <section className={`write__pane write__panel-pane ${tab === 'ideas' ? 'is-shown' : ''}`} aria-label="Ideas">
                <IdeasPanel meta={meta} busy={busy !== null} model={chatModel} onAdd={(t, sec) => void addIdeaText(t, sec)} onSuggest={(r) => void suggestIdeasNow(r)} onWrite={(ids, how) => void writeIdeasNow(ids, how)} onState={(id, st) => void run('Saving', async () => { await service.updateIdea(activeId, id, { state: st }); await reload(activeId) })} onRemove={(id) => void run('Saving', async () => { await service.deleteIdea(activeId, id); await reload(activeId) })} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'links' ? 'is-shown' : ''}`} aria-label="Links">
                <h2 className="write__panehead">Links between sections</h2>
                <p className="write__muted">Record where one section depends on another. When you change the second, the first is flagged for review.</p>
                <ul className="write__legend" aria-label="Kinds of link">
                  <li><strong>rests on</strong> builds on it, like an argument on its evidence</li>
                  <li><strong>repeats</strong> restates it, like an opening or a conclusion repeating a finding</li>
                </ul>
                <button type="button" onClick={() => void findLinks()} disabled={busy !== null || meta.sections.length < 2}>Find links</button>
                <ul className="write__list">
                  {meta.links.filter((l) => (DEPENDENCY_KINDS as readonly string[]).includes(l.kind) && l.from.type === 'section' && l.to.type === 'section').map((l) => (
                    <li key={l.id}>
                      <p><strong>{sectionName(l.from.id)}</strong> {DEPENDENCY_LABEL[l.kind as DependencyKind]} <strong>{sectionName(l.to.id)}</strong></p>
                      <span className="write__badge">{l.origin === 'proposed' ? `suggested${l.confidence !== undefined ? ` ${Math.round(l.confidence * 100)}%` : ''}` : l.origin === 'confirmed' ? 'confirmed' : 'drawn by you'}</span>
                      {l.reason && <p className="write__reason">{l.reason}</p>}
                      {l.origin === 'proposed' && <button type="button" onClick={() => void run('Saving', async () => { await service.confirmDependency(activeId, l.id); await reload(activeId) })}>Confirm</button>}
                      <button type="button" onClick={() => void removeLinkById(l.id, l.origin)}>{l.origin === 'proposed' ? 'Dismiss' : 'Remove'}</button>
                    </li>
                  ))}
                  {!meta.links.some((l) => (DEPENDENCY_KINDS as readonly string[]).includes(l.kind)) && <li className="write__muted">No links yet. Press Find links, or add one below.</li>}
                </ul>
                <form className="write__form" onSubmit={(e) => { e.preventDefault(); void addLink() }}>
                  <h3>Add a link yourself</h3>
                  <select aria-label="Section that depends" value={linkFrom} onChange={(e) => setLinkFrom(e.target.value)}>
                    <option value="">This section…</option>
                    {meta.sections.map((x) => <option key={x.id} value={x.id}>{x.heading || '(opening)'}</option>)}
                  </select>
                  <select aria-label="Kind of link" value={linkKind} onChange={(e) => setLinkKind(e.target.value as DependencyKind)}>
                    {DEPENDENCY_KINDS.map((k) => <option key={k} value={k}>{DEPENDENCY_LABEL[k]}</option>)}
                  </select>
                  <select aria-label="Section it depends on" value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
                    <option value="">…this section</option>
                    {meta.sections.filter((x) => x.id !== linkFrom).map((x) => <option key={x.id} value={x.id}>{x.heading || '(opening)'}</option>)}
                  </select>
                  <button type="submit" disabled={!linkFrom || !linkTo || linkFrom === linkTo}>Add link</button>
                </form>
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'history' ? 'is-shown' : ''}`} aria-label="History">
                <h2 className="write__panehead">History</h2>
                <ul className="write__legend" aria-label="What the icons do">
                  <li><Icon d={ICON_PATHS.view} /> View the text</li>
                  <li><Icon d={ICON_PATHS.compare} /> Compare with now</li>
                  <li><Icon d={ICON_PATHS.restore} /> Restore</li>
                </ul>
                <div className="write__working">
                  <div>
                    <strong>Now</strong>
                    <div className="write__hchange">{working ? (working.added === 0 && working.removed === 0 ? 'No text changes since the last version' : `${describeChange(working)} since the last version`) : 'Nothing saved yet'}</div>
                  </div>
                  <button type="button" onClick={() => void saveVersion()} disabled={busy !== null}><Icon d={ICON_PATHS.save} /> Save version</button>
                </div>
                <ul className="write__history">
                  {versions.map((v) => (
                    <li key={v.index}>
                      <span className="write__hkind" title={v.kind === 'published' ? 'Published (frozen)' : 'Saved'}><Icon d={v.kind === 'published' ? ICON_PATHS.published : ICON_PATHS.saved} /></span>
                      <div className="write__hmain">
                        <div className="write__hline"><strong>{v.label ?? (v.kind === 'published' ? 'Published' : 'Saved')}</strong><time dateTime={v.at}>{new Date(v.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>
                        <div className="write__hchange">{describeChange(v.change)}</div>
                      </div>
                      <div className="write__hactions">
                        <button type="button" className="write__iconbtn" aria-label="View" title="View the text" onClick={() => void openVersion(v.index, 'view')}><Icon d={ICON_PATHS.view} /></button>
                        <button type="button" className="write__iconbtn" aria-label="Compare with now" title="Compare with now" onClick={() => void openVersion(v.index, 'compare')}><Icon d={ICON_PATHS.compare} /></button>
                        <button type="button" className="write__iconbtn" aria-label="Restore" title="Restore" onClick={() => void restoreVersion(v.index)}><Icon d={ICON_PATHS.restore} /></button>
                      </div>
                    </li>
                  ))}
                  {versions.length === 0 && <li className="write__muted">No saved versions yet. Published versions are frozen; the others are saved before a large change or a suggestion you accept, and when you press Save version.</li>}
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
            <SettingsPane perms={perms} spent={services.spentUsd()} autoModel={services.models.auto()} chatModel={chatModel} suggestions={services.models.suggestions} onAutoModel={(m) => void services.models.setAuto(m).then(() => setModelTick((t) => t + 1))} onSave={(p) => run('Saving', async () => { await services.permissions.set(p); permsRef.current = p; setPerms(p) })} />
          </section>
        </aside>
        {!activeId || !bundle || !meta ? (
          <p className="write__empty">Create an article, or import one, to begin.</p>
        ) : (
          <section className={`write__pane write__pane--text ${tab === 'text' ? 'is-shown' : ''}`} aria-label="Text">
            <textarea ref={textRef} aria-label="Article text" value={draft} onChange={(e) => onType(e.target.value)} onSelect={(e) => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} onClick={(e) => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} spellCheck />
            <SourceDock
              meta={meta}
              markdown={draft}
              selection={selection}
              busy={busy !== null}
              model={chatModel}
              onAdd={(src, here) => void run('Adding the source', async () => { await addSourceAndPlace(src, here); await reload(activeId) })}
              onDropFiles={(files, here) => void dropFiles(files, here)}
              onDetach={(claimId, sourceId) => void run('Saving', async () => { await service.detachSource(activeId, claimId, sourceId); await reload(activeId) })}
              onConfirm={(claimId, sourceId) => void run('Saving', async () => { const link = meta.links.find((l) => l.kind === 'supported_by' && l.from.id === claimId && l.to.id === sourceId); if (link) await service.confirmDependency(activeId, link.id); await reload(activeId) })}
              onCheck={(claimId) => void run(`Checking with ${chatModel}`, async () => { const r = await service.checkClaim(activeId, claimId, chatModel); await reload(activeId); setNotice(r.status === 'checked' ? `Checked with ${chatModel}: ${r.verdict.replace('_', ' ')}. ${r.reason}` : r.status === 'no_sources' ? 'There is no stored passage to check against.' : r.reason) })}
            />
          </section>
        )}
        <section className={`write__pane write__pane--chat ${tab === 'chat' ? 'is-shown' : ''}`} aria-label="Chat"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const files = Array.from(e.dataTransfer.files); if (files.length > 0) void dropFiles(files, false, true) }}>
          <header className="write__chathead">
            <h2 className="write__panehead">Chat</h2>
            <ModelPicker label="Model for the chat" value={chatModel} suggestions={services.models.suggestions} onChange={(m) => void services.models.setChat(m).then(() => setModelTick((t) => t + 1))} />
          </header>
          <ul className="write__chat" aria-live="polite">
            {chat.map((l) => (
              <li key={l.id} className={`write__line write__line--${l.from}`}>
                <div>{l.text}</div>
                {l.from === 'aielia' && l.model && (
                  <div className="write__linemeta">
                    <span className="write__linemodel" title="The model that wrote this">{l.model}</span>
                    {activeId && <button type="button" className="write__link" onClick={() => void run('Saving', async () => { const r = await service.addIdea(activeId, { text: l.text, origin: 'assistant', model: l.model }); if (!r.ok) setNotice(r.reason); await reload(activeId) })}>Save to ideas</button>}
                  </div>
                )}
              </li>
            ))}
            {chat.length === 0 && <li className="write__muted">Talk to Aielia about the article, paste reviewer comments, or drop a file here to use it as a source.</li>}
          </ul>
          <AdjustBar disabled={busy !== null || !activeId} onSend={(m) => { setAskForEdits(true); void sendChat(m, true) }} />
          <label className="write__toggle"><input type="checkbox" checked={askForEdits} onChange={(e) => setAskForEdits(e.target.checked)} /> Ask for edits (they arrive as suggestions)</label>
          <div className="write__compose">
            <textarea aria-label="Message" value={chatInput} onChange={(e) => setChatInput(e.target.value)} rows={3} />
            <div className="write__composebar">
              <button type="button" onClick={() => void checkFromChat()} disabled={!activeId || busy !== null} title={`Find the claims and check them against their sources, with ${chatModel}`}>Check article with {chatModel}</button>
              <button type="button" onClick={() => void sendChat()} disabled={busy !== null || !chatInput.trim()}>Send</button>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

function SettingsPane({ perms, spent, autoModel, chatModel, suggestions, onAutoModel, onSave }: { perms: WritePermissions | undefined; spent: number; autoModel: string; chatModel: string; suggestions: string[]; onAutoModel: (model: string) => void; onSave: (p: WritePermissions) => Promise<void> }): React.JSX.Element {
  const [cap, setCap] = useState<string>('')
  useEffect(() => setCap(perms?.spendCapUsd !== undefined ? String(perms.spendCapUsd) : ''), [perms])
  if (!perms) return <p className="write__muted">Loading…</p>
  const save = (next: Partial<WritePermissions>): Promise<void> => onSave({ ...perms, ...next })
  return (
    <div className="write__form">
      <p>Aielia only ever changes your text as suggestions you accept. These are the other things it may do on its own.</p>
      <label><input type="checkbox" checked={perms.captureChat} onChange={(e) => void save({ captureChat: e.target.checked })} /> Remember reviewer comments, decisions and corrections I mention in chat</label>
      <label><input type="checkbox" checked={perms.autoCheck} onChange={(e) => void save({ autoCheck: e.target.checked })} /> Check claims and effects by itself when I stop typing (uses your key)</label>
      <label>Model for the automatic checks
        <ModelPicker label="Model for the automatic checks" value={autoModel} suggestions={suggestions} onChange={onAutoModel} />
      </label>
      {autoModel === chatModel && <p className="write__warn">The automatic checks use the same model as the chat. A different, smaller model gives you a second opinion and costs less.</p>}
      <label>Stop using my key after this much, in US dollars (blank for no limit)
        <input aria-label="Spending cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => { const n = Number(cap); void save({ spendCapUsd: cap.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined }) }} />
      </label>
      <p className="write__muted">Spent so far in this browser: ${spent.toFixed(2)}</p>
    </div>
  )
}
