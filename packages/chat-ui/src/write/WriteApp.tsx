import { useCallback, useEffect, useRef, useState } from 'react'
import { githubRepoReader, parseGithubRepoAddress, type FolderReader, expandSelection, summarizeVerify, type VerifyReport, textPieces, collectIssues, parseLineRange, sourceKindForFile, computeReadiness, effectiveSourceStatus, issueCount, textUnitAt, autosaveStep, outlineOf, issuesInRange, unitOfSelection, shouldDeriveStyle, type ArticleBundle, type ChangeSummary, type DependencyKind, type IssueCategory, type Section, type WritePermissions } from '@buildaharness/aielia'
import type { ChatAction } from './AdjustBar'
import { ArticleSwitcher, type ArticleItem } from './ArticleSwitcher'
import { ChatPane, type ChatLine, type ChatMode } from './ChatPane'
import { HistoryPanel, type VersionRow } from './HistoryPanel'
import { VersionOutline, VersionView, type Viewing } from './VersionView'
import { TextHistory } from './TextHistory'
import { IdeasPanel } from './IdeasPanel'
import { StylePanel } from './StylePanel'
import { MarkedText } from './MarkedText'
import { IssuesPanel, type ResolveNote } from './IssuesPanel'
import { LinksPanel } from './LinksPanel'
import { SourcesPanel } from './SourcesPanel'
import { OutlinePanel } from './OutlinePanel'
import { SettingsPane } from './SettingsPane'
import { Splitter } from './Splitter'
import type { WriteConnection } from './write-config'
import { TextNotes, looksLikeLink, type NoteKind } from './TextNotes'
import { Icon } from './icons'
import { DialogProvider, useDialogs } from './dialogs'
import type { WriteServices } from './write-services'
import './write.css'

type Tab = 'text' | 'style' | 'ideas' | 'issues' | 'sources' | 'history' | 'chat' | 'settings'

/** What the text pane shows: the article, or its outline. */
type TextView = 'text' | 'outline'

const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'style', label: 'Style' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'issues', label: 'Issues' },
  { id: 'sources', label: 'Sources' },
  { id: 'history', label: 'History' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
]

const RAIL_ICONS: Record<Tab, string> = {
  text: 'M5 5h14M5 9h14M5 13h14M5 17h9',
  style: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  ideas: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  issues: 'M12 3 2.5 20h19L12 3zM12 10v4M12 17h.01',
  sources: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  chat: 'M4 5h16v11H9l-5 4z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
}

/** The desktop layout starts at 960 px (see write.css). jsdom has no matchMedia, which reads as a phone. */
/** The side rail layout (tablet and desktop) starts at 640 px; below that the rail is a bottom bar and the chat is a sheet. See write.css. */
/** How far down the box the line holding `at` starts, counting wrapped lines: the text before it is laid out in a hidden copy of the box. */
function topOfPosition(ta: HTMLTextAreaElement, at: number): number {
  const cs = getComputedStyle(ta)
  const mirror = document.createElement('div')
  for (const prop of ['font', 'letterSpacing', 'lineHeight', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'tabSize'] as const) mirror.style[prop] = cs[prop]
  mirror.style.width = `${ta.clientWidth + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)}px`
  mirror.style.cssText += ';position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;top:0;left:-9999px;'
  mirror.textContent = ta.value.slice(0, at)
  const mark = document.createElement('span')
  mark.textContent = '\u200b'
  mirror.appendChild(mark)
  document.body.appendChild(mirror)
  const top = mark.offsetTop
  document.body.removeChild(mirror)
  return top
}

/** What the chat says when a model call fails: the reason, and what to try. Never an empty answer. */
export const failureText = (what: string, err: unknown): string => `${what}: ${err instanceof Error ? err.message : String(err)}. Check your key and the model in Settings, or pick another model next to the chat, then try again.`

const isDesktop = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 960px)').matches === true
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


/** The saved section that holds the cursor, found through the headings of the text as it is now (so it is right while typing). */
function sectionAt(sections: Section[], markdown: string, selection: { start: number } | null): Section | undefined {
  if (!selection) return undefined
  const heading = outlineOf(markdown).filter((e) => e.start <= selection.start).at(-1)
  return heading ? sections.find((x) => x.heading === heading.heading && x.level === heading.level) : sections.find((x) => x.level === 0)
}

let lineId = 0

/** Where the chat lines are kept, so a reload does not erase the conversation. */
const CHAT_LINES_KEY = 'chat-lines'
const MAX_SAVED_LINES = 200
/** Sizes the writer dragged the panes to, in pixels; a missing one is the pane's normal size. */
interface Layout { panel?: number; chat?: number; dock?: number }
const LAYOUT_KEY = 'aielia-write.layout'
function loadLayout(): Layout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
    const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return { panel: n(o.panel), chat: n(o.chat), dock: n(o.dock) }
  } catch { return {} }
}
/** The room the text keeps for itself when a side pane is dragged wider. */
const MIN_TEXT = 300
const RAIL_WIDTH = 76

/** What the page keeps in the browser's own storage besides the articles. */
const LOCAL_KEYS = ['aielia-write.dock', LAYOUT_KEY]
const isChatLine = (x: unknown): x is ChatLine => typeof x === 'object' && x !== null && typeof (x as ChatLine).id === 'number' && ((x as ChatLine).from === 'you' || (x as ChatLine).from === 'aielia') && typeof (x as ChatLine).text === 'string'

type WriteAppProps = {
  services: WriteServices
  connection?: { value: WriteConnection; onSave: (c: WriteConnection) => void; onForget: () => void }
  /** Called when the writer deleted all their data, so the host can start the page afresh (its models and spending were reset). */
  onDeleted?: () => void
}

export function WriteApp(props: WriteAppProps): React.JSX.Element {
  return <DialogProvider><WriteAppBody {...props} /></DialogProvider>
}

function WriteAppBody({ services, connection, onDeleted }: WriteAppProps): React.JSX.Element {
  const { service, port } = services
  const dialogs = useDialogs()
  const [articles, setArticles] = useState<ArticleItem[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [bundle, setBundle] = useState<ArticleBundle | undefined>()
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<Tab>(() => (isWide() ? 'style' : 'text'))
  const [view, setView] = useState<TextView>('text')
  // Where to put the cursor once the text is on screen again (a section picked in the outline).
  const pendingJump = useRef<number | null>(null)
  // Desktop: the side panel opens when a rail button is clicked and closes when it is clicked again.
  // On a tablet the panel floats over the text, so it starts closed there; on a desktop it has its own column and starts open.
  const [railOpen, setRailOpen] = useState<boolean>(() => isDesktop())
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [working, setWorking] = useState<ChangeSummary | undefined>(undefined)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  /** Which text the main window shows when a version is open: the article now, or that version. */
  const [showHistory, setShowHistory] = useState(false)
  // Saving the text and saving a version both read and write the stored article, so they run one after the other.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = (work: () => Promise<unknown>): void => { queue.current = queue.current.then(work, work).catch((err) => setNotice(String(err))) }
  const draftRef = useRef('')
  /** Where the sentence being edited starts, for deciding when the writer has moved on to another one. */
  const sentenceRef = useRef<number | null>(null)
  const [versionsTick, setVersionsTick] = useState(0)
  /** The box under the text (comments, sources, issues, links, history of the selected text) can be hidden to give the text the whole page. */
  const [dockOn, setDockOn] = useState<boolean>(() => { try { return localStorage.getItem('aielia-write.dock') !== 'off' } catch { return true } })
  const toggleDock = (): void => { const next = !dockOn; setDockOn(next); try { localStorage.setItem('aielia-write.dock', next ? 'on' : 'off') } catch { /* the choice just is not remembered */ } }
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const mainRef = useRef<HTMLElement | null>(null)
  const resize = (key: keyof Layout, px: number | undefined): void => setLayout((l) => {
    const next = { ...l, [key]: px }
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)) } catch { /* the sizes just are not remembered */ }
    return next
  })
  const widthOf = (selector: string, fallback: number): number => mainRef.current?.querySelector(selector)?.getBoundingClientRect().width || fallback
  const roomFor = (other: number): number => Math.max(0, (mainRef.current?.clientWidth ?? 1200) - RAIL_WIDTH - other - MIN_TEXT)
  /** On a tablet the side panel floats over the text, so it takes no room from it (and the chat may use all but the text's minimum). */
  const panelTakesRoom = (): boolean => railOpen && isDesktop()
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatMode, setChatMode] = useState<ChatMode>('answer')
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
      draftRef.current = b.markdown
      sentenceRef.current = null
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

  // The chat comes back after a reload. It is saved only once the saved one has been read, so the empty start never overwrites it.
  const chatRead = useRef(false)
  useEffect(() => {
    let live = true
    void services.store.getSetting(CHAT_LINES_KEY).then((raw) => {
      if (!live) return
      const saved = Array.isArray(raw) ? raw.filter(isChatLine) : []
      lineId = Math.max(lineId, ...saved.map((l) => l.id))
      setChat((now) => [...saved, ...now])
    }, () => undefined).finally(() => { if (live) chatRead.current = true })
    return () => { live = false }
  }, [services.store])
  useEffect(() => {
    if (!chatRead.current) return
    void services.store.setSetting(CHAT_LINES_KEY, chat.slice(-MAX_SAVED_LINES)).catch(() => undefined)
  }, [chat, services.store])

  useEffect(() => {
    if (!activeId) { setVersions([]); setWorking(undefined); return }
    void service.history(activeId).then((v) => setVersions(v as VersionRow[]), () => undefined)
    void service.changeSinceLastVersion(activeId).then(setWorking, () => undefined)
    setViewing(null)
  }, [service, activeId, bundle, versionsTick])

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
  // Growing the selection by sentence, paragraph, section: the earlier selections are kept so it can shrink back.
  const growth = useRef<{ range: { start: number; end: number }; unit: string }[]>([])
  const [grownUnit, setGrownUnit] = useState<string | undefined>()
  const grownTo = useRef<{ start: number; end: number } | undefined>()
  const applySelection = (range: { start: number; end: number }): void => {
    const t = textRef.current
    if (!t) return
    t.focus({ preventScroll: true })
    t.setSelectionRange(range.start, range.end)
    grownTo.current = range
    setSelection(range)
  }
  const growSelection = (): void => {
    const t = textRef.current
    if (!t) return
    const now = { start: t.selectionStart, end: t.selectionEnd }
    const next = expandSelection(t.value, now)
    if (!next) { setNotice('The whole article is already selected.'); return }
    growth.current.push({ range: now, unit: next.unit })
    setGrownUnit(next.unit)
    applySelection(next.range)
  }
  const shrinkSelection = (): void => {
    const back = growth.current.pop()
    if (!back) { const t = textRef.current; if (t) applySelection({ start: t.selectionStart, end: t.selectionStart }); setGrownUnit(undefined); return }
    setGrownUnit(growth.current.at(-1)?.unit)
    applySelection(back.range)
  }
  // Double-click: the sentence, then each larger unit, up to the one just below the whole article, then the sentence again.
  const pressedFrom = useRef<{ start: number; end: number } | undefined>()
  const pressText = (): void => { pressedFrom.current = grownTo.current }
  const doubleClickText = (at: number): void => {
    const t = textRef.current
    if (!t) return
    const prev = pressedFrom.current
    pressedFrom.current = undefined
    const inside = prev !== undefined && at >= prev.start && at <= prev.end
    let from = inside ? prev : { start: at, end: at }
    let next = expandSelection(t.value, from, { wholeArticle: false })
    if (!next && inside) { from = { start: at, end: at }; next = expandSelection(t.value, from, { wholeArticle: false }); growth.current = [] }
    if (!next) return
    if (!inside) growth.current = []
    growth.current.push({ range: from, unit: next.unit })
    setGrownUnit(next.unit)
    applySelection(next.range)
  }
  const [repoTick, setRepoTick] = useState(0)
  const [folder, setFolder] = useState<{ reader: FolderReader; files: string[] } | undefined>()
  const folderRef = useRef(folder)
  folderRef.current = folder
  const [candidates, setCandidates] = useState<Record<string, { title: string; url: string; snippet: string }[]>>({})

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
    const title = (await dialogs.ask('Name of the new article?'))?.trim()
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
    const name = (await dialogs.ask('New name for this article?', { initial: current?.name ?? current?.title ?? '' }))?.trim()
    if (!name) return
    await run('Renaming', async () => { await service.rename(activeId, name); await refreshList() })
  }

  function onType(value: string): void {
    const prev = draftRef.current
    draftRef.current = value
    setDraft(value)
    // A version is saved by itself when a sentence is finished, a section started, or the writer moves on to change another sentence.
    const step = autosaveStep(prev, value, sentenceRef.current)
    sentenceRef.current = step.sentenceStart
    if (activeId && step.moment) {
      const id = activeId
      const text = step.moment === 'before' ? prev : value
      enqueue(async () => { if (await service.autosave(id, text)) setVersionsTick((t) => t + 1) })
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (!activeId) return
      // Structure only (no model call) unless the writer allowed automatic checks: sections re-anchor, suggestions refresh.
      enqueue(() => service.updateText(activeId, value, { analyze: permsRef.current?.autoCheck === true }).then((o) => { setBundle(o.bundle); void refreshList() }))
    }, 800)
  }

  /** Puts the cursor at a place in the text and scrolls to it. */
  function jumpTo(start: number): void {
    if (view !== 'text') { pendingJump.current = start; setView('text'); return }
    const ta = textRef.current
    if (!ta) return
    const at = Math.min(start, ta.value.length)
    ta.focus()
    ta.setSelectionRange(at, at)
    setSelection({ start: at, end: at })
    ta.scrollTop = Math.max(0, topOfPosition(ta, at))
    if (!isWide()) setTab('text')
  }

  // A section picked in the outline: the outline gives way to the text, at that section.
  useEffect(() => {
    if (view === 'text' && pendingJump.current !== null) { const at = pendingJump.current; pendingJump.current = null; jumpTo(at) }
  })

  function pickTab(id: Tab): void {
    if (isWide() && tab === id && railOpen) setRailOpen(false)
    else { setTab(id); setRailOpen(true) }
  }
  const isOn = (id: Tab): boolean => tab === id && (railOpen || id === 'text' || id === 'chat')

  // ---- delete all data
  async function deleteAllData(): Promise<void> {
    if (!(await dialogs.confirm('Delete everything stored in this page? Every article with its versions, comments and sources, the chat, your settings and the spending record are removed. This cannot be undone. Export an article first if you want to keep it.', { yes: 'Delete everything' }))) return
    await run('Deleting', async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      await queue.current.catch(() => undefined)
      await services.deleteAllData()
      for (const key of LOCAL_KEYS) { try { localStorage.removeItem(key) } catch { /* nothing was stored */ } }
      chatRead.current = false
      setArticles([]); setActiveId(undefined); setBundle(undefined); setDraft(''); draftRef.current = ''
      setChat([]); setChatInput(''); setNotes([]); setSelection(null); setViewing(null); setVersions([]); setWorking(undefined)
      setPerms(await services.permissions.get()); permsRef.current = undefined
      chatRead.current = true
      setModelTick((n) => n + 1)
      setNotice('All your data was deleted.')
      onDeleted?.()
    })
  }

  // ---- publish, export, import
  async function publish(): Promise<void> {
    if (!activeId) return
    const label = await dialogs.ask('Label for this published version (optional)?')
    await run('Publishing', async () => {
      await flushDraft()
      const recheck = (permsRef.current ?? perms)?.recheckBeforePublish !== false ? await service.recheckSources(activeId, services.models.auto()) : undefined
      const folderReport = folderRef.current && (permsRef.current ?? perms)?.recheckBeforePublish !== false ? await service.recheckFolder(activeId, folderRef.current.reader, services.models.auto()) : undefined
      const b = await service.publish(activeId, label?.trim() || undefined)
      setBundle(b)
      const r = computeReadiness(b.meta)
      const open = r.unsourcedFactualClaims + r.staleOrUnsupportedClaims + r.openComments + r.sectionsNeedingReview
      const sources = recheck ? [recheck.changed.length > 0 ? `${recheck.changed.length} web source${recheck.changed.length === 1 ? ' has' : 's have'} changed since you read ${recheck.changed.length === 1 ? 'it' : 'them'}` : '', recheck.unreachable.length > 0 ? `${recheck.unreachable.length} could not be reached` : ''].filter(Boolean).join(' and ') : ''
      const files = folderReport && (folderReport.changed.length > 0 || folderReport.missing.length > 0) ? [folderReport.changed.length > 0 ? `${folderReport.changed.length} file${folderReport.changed.length === 1 ? '' : 's'} from the folder ${folderReport.changed.length === 1 ? 'has' : 'have'} changed` : '', folderReport.missing.length > 0 ? `${folderReport.missing.length} could not be found` : ''].filter(Boolean).join(' and ') : ''
      setNotice(`Published as a frozen snapshot.${open > 0 ? ` ${open} item${open === 1 ? ' was' : 's were'} still open; ${open === 1 ? 'it is' : 'they are'} recorded with it.` : ''}${sources ? ` ${sources}: see Issues.` : ''}${files ? ` ${files} since you read them: see the sources.` : ''}`)
    })
  }

  async function exportArticle(): Promise<void> {
    if (!activeId) return
    const folder = await service.exportArticle(activeId)
    const fileName = `${bundle?.meta.name ?? bundle?.meta.title ?? 'article'}.aielia-article.json`
    const text = JSON.stringify(folder, null, 2)
    // A host with its own way to save a file (a save dialog) is used; a browser tab gets a download link.
    if (services.saveFile) { await run('Saving the file', async () => { await services.saveFile?.(fileName, text) }); return }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = fileName
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function importArticle(file: File): Promise<void> {
    await run('Importing', async () => {
      if (!file.name.toLowerCase().endsWith('.json')) {
        const r = await service.importTextFile(file.name, await file.text())
        if (!r.ok) throw new Error(r.reason)
        await refreshList()
        await select(r.id)
        setNotice(`This is a copy of the file. Editing it does not change the original. ${await prepareFromText(r.id)}`)
        return
      }
      let folder: Record<string, string>
      try { folder = JSON.parse(await file.text()) as Record<string, string> } catch { throw new Error('That file is not an exported article.') }
      const r = await service.importArticle(folder)
      if (!r.ok) throw new Error(r.reason)
      await refreshList()
      await select(r.id)
    })
  }

  async function openPage(): Promise<void> {
    const address = await dialogs.ask('Address of the web page to bring in and edit (http:// or https://)?')
    if (!address?.trim()) return
    await run('Reading the page', async () => {
      const r = await service.importPage(address)
      if (!r.ok) throw new Error(r.reason)
      await refreshList()
      await select(r.id)
      setNotice(`This is a copy of the page as it reads now. Editing it does not change the original, and the page is kept as a source. ${await prepareFromText(r.id)}`)
    })
  }

  // ---- history
  const saveVersion = async (): Promise<void> => {
    const label = await dialogs.ask('Name this version (optional)?')
    change('Saving the version', async (id) => { await service.saveVersion(id, label) })
  }
  const openVersion = (index: number, mode: 'view' | 'compare'): void => {
    if (!activeId) return
    void run('Opening the version', async () => {
      if (mode === 'compare') await flushDraft()
      const snap = await service.getVersion(activeId, index)
      setViewing(mode === 'view' ? { mode, index, markdown: snap.markdown } : { mode, index, markdown: snap.markdown, diff: await service.compareWithCurrent(activeId, index) })
      setShowHistory(true)
      if (!isWide()) setTab('text')
    })
  }
  const restoreVersion = async (index: number): Promise<void> => {
    if (!(await dialogs.confirm('Restore this version as your working article? The article as it is now is saved first, so nothing is lost.', { yes: 'Restore' }))) return
    change('Restoring', async (id) => { await service.restore(id, index); setNotice('Restored. The article as it was before is in History.') })
  }

  // ---- style sheet and links drawn from the text
  /** A first style sheet and the links between sections, drawn from the article's own text with the model for automatic checks; says in one sentence what it found. */
  async function prepareFromText(id: string, model: string = services.models.auto()): Promise<string> {
    const before = await service.get(id)
    const style = await service.deriveStyleFromText(id, model)
    const links = await service.findDependencies(id, model)
    setBundle(await service.get(id))
    const hadBrief = Object.values(before.meta.brief ?? {}).some((v) => typeof v === 'string' && v.trim())
    const hadLinks = before.meta.links.filter((x) => x.kind === 'rests_on' || x.kind === 'repeats').length
    const s = style.filled.length > 0 ? `drafted the style sheet (${style.filled.join(', ')})` : style.reason ? `could not read a style from the text (${style.reason})` : hadBrief ? 'left the style sheet as it is, since it is already filled in' : 'found nothing to add to the style sheet'
    const l = links.status === 'failed' ? `the search for links could not run${links.reason ? ` (${links.reason})` : ''}` : links.added.length > 0 ? `found ${links.added.length} possible link${links.added.length === 1 ? '' : 's'} between sections to confirm` : hadLinks > 0 ? `found no new links between sections (${hadLinks} already ${hadLinks === 1 ? 'is' : 'are'} listed in the Links tab)` : 'found no links between sections'
    const failed = Boolean(style.reason) || links.status === 'failed'
    return `I ${s} and ${l}. ${failed ? 'Check your key and the model in Settings, or pick another model next to the chat, then try again.' : 'Edit anything that is off.'}`
  }
  const prepareFromChat = (): void => {
    if (!activeId) return
    const id = activeId
    const used = services.models.chat() // started from the chat, so it runs on the model chosen there
    setChat((c) => [...c, { id: ++lineId, from: 'you', text: 'Fill in the style and links from the article' }])
    void run('Filling in the style and links', async () => {
      try {
        await flushDraft()
        const text = await prepareFromText(id, used)
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text, model: used }])
      } catch (e) {
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: failureText('I could not do that', e) }])
      }
    })
  }

  /** Reads the style from the text, filling only the empty lines. */
  const deriveStyle = (): void => {
    if (!activeId) return
    const id = activeId
    void run('Reading the style from the text', async () => {
      await flushDraft()
      const r = await service.deriveStyleFromText(id, services.models.auto())
      setStyleReading({ id, state: r.reason ? 'failed' : 'idle', error: r.reason })
      setBundle(await service.get(id))
      setNotice(r.filled.length > 0 ? `Filled in: ${r.filled.join(', ')}. Edit anything that is off.` : 'I found nothing to add to the style.')
    })
  }
  // The style fills in by itself once there is about a page of text (typed, pasted or imported), once for each article.
  const styleTried = useRef<Set<string>>(new Set())
  const [styleReading, setStyleReading] = useState<{ id: string; state: 'reading' | 'failed' | 'idle'; error?: string } | null>(null)
  useEffect(() => {
    if (!activeId || !bundle || styleTried.current.has(activeId) || !shouldDeriveStyle(bundle.meta, bundle.markdown)) return
    styleTried.current.add(activeId)
    const id = activeId
    setStyleReading({ id, state: 'reading' })
    void service.deriveStyleFromText(id, services.models.auto()).then(async (r) => {
      setStyleReading({ id, state: r.reason ? 'failed' : 'idle', error: r.reason })
      if (id === activeIdRef.current) setBundle(await service.get(id))
    }, (e) => setStyleReading({ id, state: 'failed', error: e instanceof Error ? e.message : String(e) }))
  }, [service, services.models, activeId, bundle])
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  /** The scratchpad is saved quietly as the writer types, without the busy line. */
  const saveScratchpad = (text: string): void => {
    if (!activeId) return
    const id = activeId
    void service.setScratchpad(id, text).then(async () => { if (id === activeIdRef.current) setBundle(await service.get(id)) }, (err) => setNotice(String(err)))
  }

  // ---- links
  const removeLink = async (linkId: string, origin: string): Promise<void> => {
    if (origin !== 'proposed' && !(await dialogs.confirm('Remove this link? You confirmed or drew it yourself.', { yes: 'Remove' }))) return
    change('Removing the link', async (id) => { await service.removeDependency(id, linkId) })
  }

  // ---- comments and sources under the text
  async function addSourceAndPlace(src: { kind: 'web' | 'upload' | 'code' | 'say_so'; address?: string; passage?: string; note?: string }, attach: boolean): Promise<void> {
    if (!activeId) return
    const sid = await service.addSource(activeId, src)
    if (src.kind === 'web' || (src.kind === 'code' && src.address && /^https?:/.test(src.address))) {
      const read = await service.readSource(activeId, sid)
      if (read.status === 'read') setNotice('I read the page and stored its text.')
      else if (read.reason) setNotice(`Link stored. ${read.reason}${read.status === 'unreachable' ? ' Paste the passage instead.' : ''}`)
    }
    await placeSource(sid, attach)
  }

  async function placeSource(sid: string, attach: boolean): Promise<void> {
    if (!activeId) return
    if (attach && selection) {
      const r = await service.attachSourceToText(activeId, selection, sid)
      if (!r.ok) setNotice(r.reason)
    } else {
      const r = await service.proposeLinksForSource(activeId, sid, chatModel)
      setNotice(r.status === 'failed' ? 'Source stored. Finding where it belongs could not run.' : r.added.length === 0 ? 'Source stored. I did not find a claim it bears on.' : `Source stored. It may back ${r.added.length} claim${r.added.length === 1 ? '' : 's'}: click in the text to confirm.`)
    }
  }

  /**
   * The repository action of the chat menu. A typed GitHub address is listed once now (so a wrong or private address is told at once) and
   * attached; with nothing typed, the repositories already attached are used. Then the claims are checked against them, and only them.
   */
  const verifyInRepo = (address: string): void => {
    const say = (text: string): void => setChat((c) => [...c, { id: ++lineId, from: 'aielia', text }])
    setChat((c) => [...c, { id: ++lineId, from: 'you', text: address.trim() ? `Verify the claims against ${address.trim()}` : 'Verify the claims against the attached repositories' }])
    if (!activeId) { say('Open or create an article first, then choose the repository.'); return }
    const id = activeId
    const typed = address.trim()
    if (!typed && service.attachedRepos(id).length === 0) { say('Type a GitHub address like github.com/owner/repo, or choose a folder.'); return }
    const spec = typed ? parseGithubRepoAddress(typed) : undefined
    if (typed && !spec) { say(`"${typed}" is not a GitHub address I can read. Use something like github.com/owner/repo.`); return }
    void (async () => {
      if (spec) {
        let listed = false
        setBusy('Listing the repository')
        setNotice(null)
        try {
          const reader = githubRepoReader(spec, { token: services.githubToken, fetchImpl: services.githubFetch })
          await reader.files()
          service.attachRepo(id, reader)
          setRepoTick((n) => n + 1)
          listed = true
        } catch (e) {
          say(`I could not list ${typed}: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          setBusy(null)
        }
        if (!listed) return
      }
      verifyFromChat(true, null)
    })()
  }
  /** Chooses a repository folder on this computer, attaches it and checks the claims against it. */
  const pickRepoFolderAndVerify = (): void => {
    if (!activeId) return
    setChat((c) => [...c, { id: ++lineId, from: 'you', text: 'Verify the claims against a folder on this computer' }])
    const id = activeId
    void (async () => {
      try {
        const reader = await services.pickFolder?.()
        if (!reader) return
        setBusy('Listing the folder')
        await reader.files()
        service.attachRepo(id, reader)
        setRepoTick((n) => n + 1)
      } catch (e) {
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: `I could not use that folder: ${e instanceof Error ? e.message : String(e)}` }])
        return
      } finally {
        setBusy(null)
      }
      verifyFromChat(true, null)
    })()
  }
  const removeRepo = (name: string): void => {
    if (!activeId) return
    service.detachRepo(activeId, name)
    setRepoTick((n) => n + 1)
  }

  const pickFolder = (): void => {
    void (async () => {
      try {
        const reader = await services.pickFolder?.()
        if (!reader) return
        setBusy('Listing the folder')
        setFolder({ reader, files: await reader.files() })
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    })()
  }
  const useFolderFile = (path: string): void => {
    const f = folder
    if (!f) return
    change('Adding the file', async (id) => {
      const r = await service.addFolderFile(id, f.reader, path, services.models.auto())
      if (r.status === 'missing') setNotice(`${path} could not be read. Choose the folder again if it moved.`)
      else if (r.status === 'unsupported') setNotice(`${path}: only text and code files can be read for now.`)
      else if (r.status === 'added' && r.sourceId) await placeSource(r.sourceId, true)
      else if (r.status === 'changed') setNotice(`${path} has changed since you read it. ${r.impacts.length === 0 ? 'No claim looks affected.' : `${r.impacts.length} claim${r.impacts.length === 1 ? '' : 's'} may be affected.`} Use the new text from the source row when you are ready.`)
      else setNotice(`${path} is already a source and is unchanged.`)
    })
  }

  const readSourceNow = (sourceId: string): void => change('Reading the page', async (id) => {
    const r = await service.readSource(id, sourceId, services.models.auto())
    setNotice(r.status === 'read' ? 'I read the page and stored its text.' : r.status === 'unchanged' ? 'The page has not changed.' : r.status === 'changed' ? `The page has changed. ${r.impacts.filter((i) => i.impact !== 'none').length} claim${r.impacts.filter((i) => i.impact !== 'none').length === 1 ? '' : 's'} may be affected. Accept the new text to use it.` : r.reason ?? 'The page could not be read.')
  })

  const addNote = (kind: NoteKind, text: string): void => {
    if (!selection) return
    change(kind === 'comment' ? 'Adding the comment' : 'Adding the source', async (id) => {
      if (kind === 'comment') {
        const r = await service.addComment(id, selection, text)
        if (!r.ok) setNotice(r.reason)
      } else await addSourceAndPlace(looksLikeLink(text) ? { kind: 'web', address: text } : { kind: 'upload', passage: text }, true)
    })
  }

  const dropFiles = (files: File[], attach: boolean, say = false): void => {
    change('Adding the files', async () => {
      const lines: string[] = []
      for (const f of files) {
        const kind = sourceKindForFile(f)
        if (!kind) { lines.push(`${f.name}: only text and code files can be read for now.`); continue }
        const text = await f.text()
        const again = await service.offerFileVersion(activeId as string, f.name, text, services.models.auto())
        if (again.status !== 'no_match') {
          lines.push(`${f.name}: ${again.status === 'unchanged' ? 'the same as the stored copy.' : again.status === 'changed' ? `changed. ${again.impacts.length === 0 ? 'No claim looks affected.' : `${again.impacts.length} claim${again.impacts.length === 1 ? '' : 's'} may be affected.`} Use the new text from the source row when you are ready.` : 'stored.'}`)
          continue
        }
        await addSourceAndPlace({ kind, address: f.name, passage: text }, attach)
        lines.push(`${f.name}: added${kind === 'code' ? ' as code' : ''}.`)
      }
      if (say) setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: `${lines.join('\n')}\nI stored ${files.length === 1 ? 'it' : 'them'} and looked for the claims they bear on. Click in the text to see and confirm them under it.`, model: chatModel }])
      else setNotice(lines.join(' '))
    })
  }

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
  const verifyText = (r: VerifyReport): string => {
    const lines = r.entries.filter((e) => e.outcome === 'no_source_found' || e.outcome === 'contradicted').map((e) => `• ${e.outcome === 'contradicted' ? 'Contradicted' : 'No source found'}: ${e.quote.slice(0, 100)}`)
    return [summarizeVerify(r), ...lines, r.entries.some((e) => e.found.length > 0) ? 'Pages that were found are kept as suggested sources under the text: confirm the ones that are right.' : ''].filter(Boolean).join('\n')
  }
  const verifyFromChat = (repoOnly = false, said?: string | null): void => {
    if (!activeId) return
    const used = services.models.chat()
    if (said !== null) setChat((c) => [...c, { id: ++lineId, from: 'you', text: said ?? (repoOnly ? 'Verify the claims against the repository' : 'Search the web for sources and verify the claims') }])
    void run(`Verifying with ${used}`, async () => {
      try {
        await flushDraft()
        const r = await service.verifyClaims(activeId, { model: used, repoOnly })
        setBundle(await service.get(activeId))
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: verifyText(r), model: used }])
      } catch (e) {
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: failureText('The check could not finish', e) }])
      }
    })
  }
  /** A check started from the chat, with the model chosen there. The result is said in the chat, with the model's name. */
  const checkFromChat = (): void => {
    if (!activeId) return
    const used = services.models.chat()
    setChat((c) => [...c, { id: ++lineId, from: 'you', text: 'Find the factual claims and check them against their sources' }])
    void run(`Checking with ${used}`, async () => {
      try {
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
      } catch (e) {
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: failureText('The check could not finish', e) }])
      }
    })
  }

  /** One chat message, the same path whether typed or composed by the Adjust control. `mode` overrides the chat's mode for this message. */
  async function sendChat(override?: string, mode?: ChatMode): Promise<void> {
    const text = (override ?? chatInput).trim()
    if (!text) return
    const how = mode ?? chatMode
    const wantEdits = how === 'suggest'
    if (override === undefined) setChatInput('')
    setChat((c) => [...c, { id: ++lineId, from: 'you', text }])
    await run(how === 'edit' ? 'Editing' : wantEdits ? 'Asking for edits' : 'Thinking', async () => {
     try {
      if (activeId) await service.updateText(activeId, draft, { analyze: false })
      if (how === 'edit' && activeId) {
        // The writer's words are recorded as in any chat turn. Then the version is saved, the edit is made, and the edited article is what is shown.
        const id = activeId
        const { reply, model: said } = await services.chat(text, id)
        const outline = view === 'outline'
        const r = outline ? await service.editOutlineFromChat(id, text, said) : await service.editFromChat(id, text, said)
        await reload(id)
        setViewing(null)
        setShowHistory(false)
        setVersionsTick((t) => t + 1)
        void refreshList()
        const saved = `I saved a version first (“${r.savedAs}”).`
        const short = (t: string): string => (t.length > 140 ? `${t.slice(0, 140)}…` : t)
        let body: string
        if (r.status === 'failed') body = `${reply}\n\n${saved} I could not make that edit${'reason' in r && r.reason ? `: ${r.reason}` : ''}, so the ${outline ? 'outline' : 'article'} is unchanged.`
        else if (r.status === 'nothing') body = `${saved} I found nothing to change in the ${outline ? 'outline' : 'text'} for that, so it is unchanged.`
        else if ('applied' in r) body = `${saved} Then I made ${r.applied.length} change${r.applied.length === 1 ? '' : 's'}${r.skipped > 0 ? ` (${r.skipped} no longer fitted)` : ''}, and the article now shows the edited text. To go back, restore that version in History.\n${r.applied.slice(0, 4).map((x) => `• “${short(x.quote)}” → “${short(x.replacement)}”`).join('\n')}${r.applied.length > 4 ? `\n…and ${r.applied.length - 4} more.` : ''}`
        else body = `${saved} Then I reworked the outline, and the article now shows it. To go back, restore that version in History.\nThe outline is now:\n${(r.after ?? '').split('\n').slice(0, 20).join('\n')}`
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: body, model: said }])
      } else if (wantEdits && activeId) {
        // Record what the writer said (comments, corrections) the same way a chat turn does, then turn the request into suggestions.
        const { reply, model: said } = await services.chat(text, activeId)
        const r = await service.suggest(activeId, text, said)
        const now = await service.get(activeId)
        setBundle(now)
        const added = now.meta.suggestions.filter((x) => r.added.includes(x.id))
        const short = (t: string): string => (t.length > 140 ? `${t.slice(0, 140)}…` : t)
        // The reply is a separate model answer and can word an edit differently from the suggestion that was stored, so when suggestions were
        // made the chat states what was stored, and not the reply.
        const body = r.status === 'failed' ? `${reply}\n\nI could not turn that into edits.`
          : added.length === 0 ? `${reply}\n\nI found nothing to change in the text for that.`
          : `I added ${added.length} suggested change${added.length === 1 ? '' : 's'}. Open Issues to accept or reject ${added.length === 1 ? 'it' : 'them'}:\n${added.slice(0, 4).map((x) => `• “${short(x.span.quote)}” → “${short(x.replacement)}”`).join('\n')}${added.length > 4 ? `\n…and ${added.length - 4} more.` : ''}`
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: body, model: said }])
      } else {
        const { reply, model: said } = await services.chat(text, activeId)
        if (activeId) setBundle(await service.get(activeId))
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: reply, model: said }])
      }
     } catch (e) {
      setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: failureText('The model call failed', e) }])
     }
    })
  }

  const meta = bundle?.meta
  const readiness = meta ? computeReadiness(meta) : undefined
  const issues = meta ? issueCount(collectIssues(meta)) : 0
  const ready = Boolean(activeId && bundle && meta)
  // The box under the text lists the issues of the selected text only; the side panel lists the whole article.
  const unit = selection ? unitOfSelection(draft, selection) : undefined
  const unitMeta = meta && unit ? issuesInRange(meta, unit.range) : meta
  const unitIssues = unitMeta && unit ? issueCount(collectIssues(unitMeta)) : 0

  const issuesNode = (m: typeof meta & object, scope?: string): React.JSX.Element => <IssuesPanel
                scope={scope}
                meta={m}
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
  return (
    <div className="write">
      <header className="write__bar">
        <h1 className="write__title">Aielia Write</h1>
        <ArticleSwitcher articles={articles} activeId={activeId} onSelect={(id) => void select(id)} onRename={() => void renameArticle()} onNew={() => void createArticle()} onExport={() => void exportArticle()} onImport={(f) => void importArticle(f)} onOpenPage={services.canReadPages ? () => void openPage() : undefined} />
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

      <main ref={mainRef} className="write__main" data-open={railOpen ? 'true' : 'false'} data-tab={tab} style={{ ...(layout.panel ? { '--panel-size': `${layout.panel}px` } : {}), ...(layout.chat ? { '--chat-size': `${layout.chat}px` } : {}) } as React.CSSProperties}>
        <nav className="write__rail" aria-label="Panels">
          {TABS.map((t) => (
            <button key={t.id} type="button" data-tab={t.id} className={isOn(t.id) ? 'is-on' : ''} aria-pressed={isOn(t.id)} aria-label={t.label} onClick={() => pickTab(t.id)}>
              <Icon d={RAIL_ICONS[t.id]} size={22} />
              <span>{t.label}</span>
              {t.id === 'issues' && issues > 0 && <span className="write__railbadge" aria-label={`${issues} issues`}>{issues}</span>}
            </button>
          ))}
        </nav>
        {railOpen && <Splitter label="Side panel width" axis="x" grow={1} className="write__split--panel" measure={() => widthOf('.write__panel', 340)} limits={() => ({ min: 260, max: isDesktop() ? Math.min(640, roomFor(widthOf('.write__pane--chat', 320))) : Math.min(640, Math.round(window.innerWidth * 0.6)) })} onSize={(px) => resize('panel', px)} onReset={() => resize('panel', undefined)} />}
        <Splitter label="Chat width" axis="x" grow={-1} className="write__split--chat" measure={() => widthOf('.write__pane--chat', 320)} limits={() => ({ min: 260, max: Math.min(720, roomFor(panelTakesRoom() ? widthOf('.write__panel', 340) : 0)) })} onSize={(px) => resize('chat', px)} onReset={() => resize('chat', undefined)} />
        <aside className="write__panel" aria-label="Side panel">
          {ready && meta ? (
            <>
              <section className={`write__pane write__panel-pane ${tab === 'style' ? 'is-shown' : ''}`} aria-label="Style">
                <StylePanel meta={meta} hasText={bundle.markdown.trim().length > 0} reading={styleReading && styleReading.id === activeId ? styleReading : undefined} busy={busy !== null} onBrief={(b) => change('Saving the brief', async (id) => { await service.setBrief(id, b) })} onDerive={deriveStyle} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'ideas' ? 'is-shown' : ''}`} aria-label="Ideas">
                <IdeasPanel meta={meta} onSave={saveScratchpad} />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'issues' ? 'is-shown' : ''}`} aria-label="Issues">
                <h2 className="write__panehead">Issues</h2>
                {issuesNode(meta)}
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'sources' ? 'is-shown' : ''}`} aria-label="Sources">
                <h2 className="write__panehead">Sources</h2>
                <SourcesPanel
                  meta={meta}
                  busy={busy !== null}
                  onJump={jumpTo}
                  onRead={(sourceId) => readSourceNow(sourceId)}
                  onAcceptNew={(sourceId) => change('Saving', async (id) => { const r = await service.acceptSourceChange(id, sourceId); if (!r.ok && r.reason) setNotice(r.reason) })}
                />
              </section>
              <section className={`write__pane write__panel-pane ${tab === 'history' ? 'is-shown' : ''}`} aria-label="History">
                <HistoryPanel versions={versions} working={working} busy={busy !== null} onSave={saveVersion} onView={(i) => openVersion(i, 'view')} onCompare={(i) => openVersion(i, 'compare')} onRestore={restoreVersion} onRename={(i, l) => change('Saving', async (id) => { await service.renameVersion(id, i, l) })} />
              </section>
            </>
          ) : (
            <p className="write__muted">Create or import an article to use the panels.</p>
          )}
          <section className={`write__pane write__panel-pane ${tab === 'settings' ? 'is-shown' : ''}`} aria-label="Settings">
            <SettingsPane hostName={services.hostName} connection={connection} github={services.setGithubToken ? { token: services.githubToken, onSave: async (t) => { await services.setGithubToken?.(t); setModelTick((n) => n + 1) } } : undefined} perms={perms} busy={busy !== null} onDeleteAll={() => void deleteAllData()} spent={services.spentUsd()} spentByType={services.spendByType()} autoModel={services.models.auto()} chatModel={chatModel} suggestions={services.models.suggestions} onAutoModel={(m) => void services.models.setAuto(m).then(() => setModelTick((t) => t + 1))} onSave={(p) => run('Saving', async () => { await services.permissions.set(p); permsRef.current = p; setPerms(p) })} />
          </section>
        </aside>
        {ready && meta ? (
          <section className={`write__pane write__pane--text ${tab === 'text' || tab === 'chat' ? 'is-shown' : ''}`} aria-label="Text">
            {viewing && (
              <div className="write__seg write__viewtoggle" role="group" aria-label="Which text">
                <button type="button" aria-pressed={!showHistory} className={!showHistory ? 'is-on' : ''} onClick={() => { setShowHistory(false); setViewing(null) }}>Current</button>
                <button type="button" aria-pressed={showHistory} className={showHistory ? 'is-on' : ''} onClick={() => setShowHistory(true)}>History</button>
              </div>
            )}
            <div className="write__seg write__viewtoggle" role="group" aria-label="Show">
              <button type="button" aria-label="Article view" aria-pressed={view === 'text'} className={view === 'text' ? 'is-on' : ''} onClick={() => setView('text')}>Article</button>
              <button type="button" aria-label="Outline view" aria-pressed={view === 'outline'} className={view === 'outline' ? 'is-on' : ''} onClick={() => setView('outline')}>Outline</button>
            </div>
            {viewing && showHistory && (view === 'outline' ? <VersionOutline viewing={viewing} onRestore={(i) => void restoreVersion(i)} /> : <VersionView viewing={viewing} statusLabel={STATUS_LABEL} onRestore={(i) => void restoreVersion(i)} />)}
            {view === 'outline' && !(viewing && showHistory) && (
              <div className="write__outlineview">
                <OutlinePanel markdown={draft} onOpen={jumpTo} onChange={onType} onSelect={(start) => { setSelection({ start, end: start }); growth.current = []; grownTo.current = undefined; setGrownUnit(undefined) }} />
              </div>
            )}
            <div className={`write__textview ${view === 'outline' || (viewing && showHistory) ? 'is-hidden' : ''}`}>
            <MarkedText textRef={textRef} value={draft} pieces={textPieces(meta, draft)} onChange={onType} onSelection={(r) => { setSelection(r); const g = grownTo.current; if (!g || g.start !== r.start || g.end !== r.end) { growth.current = []; grownTo.current = undefined; setGrownUnit(undefined) } }} onGrow={growSelection} onShrink={shrinkSelection} onPress={pressText} onDoubleClick={doubleClickText} selection={selection} />
            </div>
            {!dockOn && <button type="button" className="write__dockchev write__dockchev--show" aria-label="Show the box under the text" title="Show the box under the text" onClick={toggleDock}>⌃</button>}
            {dockOn && <TextNotes
              issues={unit && unitMeta ? issuesNode(unitMeta, selection ? textUnitAt(draft, selection.start, selection.end)?.quote : undefined) : <p className="write__muted">Click in the text, or highlight some, to see the issues in it. The Issues button at the side lists the whole article.</p>}
              issuesCount={unitIssues}
              links={<LinksPanel meta={meta} sectionId={sectionAt(meta.sections, draft, selection)?.id} onConfirm={(lid) => change('Saving', async (id) => { await service.confirmDependency(id, lid) })} onRemove={removeLink} onAdd={(f, t, k: DependencyKind) => change('Adding the link', async (id) => { const r = await service.addDependency(id, f, t, k); if (!r.ok) setNotice(r.reason) })} />}
              history={<TextHistory markdown={draft} selection={selection} versions={bundle.snapshots.map((x, index) => ({ index, kind: x.kind, label: x.label, at: x.at, markdown: x.markdown }))} />}
              meta={meta}
              markdown={draft}
              selection={selection}
              grownUnit={grownUnit}
              busy={busy !== null}
              model={chatModel}
              onHide={toggleDock}
              height={layout.dock}
              onHeight={(px) => resize('dock', px)}
              onAdd={addNote}
              onFiles={(files) => dropFiles(files, selection !== null)}
              onSaveComments={(c) => change('Saving', async (id) => {
                for (const e of c.edit) await service.editComment(id, e.id, { text: e.text })
                for (const t of c.add) { if (!selection) break; const r = await service.addComment(id, selection, t); if (!r.ok) setNotice(r.reason) }
                for (const rid of c.remove) await service.deleteComment(id, rid)
              })}
              onDetach={(claimId, sourceId) => change('Saving', async (id) => { await service.detachSource(id, claimId, sourceId) })}
              onConfirm={(claimId, sourceId) => change('Saving', async (id) => { const link = meta.links.find((l) => l.kind === 'supported_by' && l.from.id === claimId && l.to.id === sourceId); if (link) await service.confirmDependency(id, link.id) })}
              onRead={readSourceNow}
              canSearch={services.canSearch}
              candidates={candidates}
              onFindSources={(claimId) => change('Searching the web', async (id) => {
                const r = await service.findSourceCandidates(id, claimId)
                if (r.status === 'found') setCandidates((c) => ({ ...c, [claimId]: r.results }))
                else setNotice(r.reason ?? 'The search could not run.')
              })}
              onUseCandidate={(claimId, url) => change('Reading the page', async (id) => {
                const r = await service.useSourceCandidate(id, claimId, url)
                setCandidates((c) => { const { [claimId]: _gone, ...rest } = c; void _gone; return rest })
                setNotice(!r.ok ? r.reason ?? 'That page could not be used.' : r.read === 'read' || r.read === 'unchanged' ? 'Source added and read. Check the claim against it when you like.' : 'Source added, but the page could not be read here. Paste the passage to check against it.')
              })}
              onDismissCandidates={(claimId) => setCandidates((c) => { const { [claimId]: _gone, ...rest } = c; void _gone; return rest })}
              folder={folder ? { name: folder.reader.name, files: folder.files } : undefined}
              onPickFolder={services.pickFolder ? pickFolder : undefined}
              onUseFolderFile={useFolderFile}
              onCloseFolder={() => setFolder(undefined)}
              onLines={async (sourceId) => {
                const answer = await dialogs.ask('Keep only these lines of the file (for example 40-60). Leave empty to keep all of it.')
                if (answer === undefined) return
                const range = answer.trim() ? parseLineRange(answer) : undefined
                if (answer.trim() && !range) { setNotice('I could not read that as lines. Type a start and an end, like 40-60.'); return }
                change('Keeping those lines', async (id) => { const r = await service.setSourceLines(id, sourceId, range); setNotice(r.ok ? (range ? `Keeping lines ${range.from}–${range.to}. Claims checked on the old text need checking again.` : 'Keeping all of it.') : (r.reason ?? 'That did not work.')) })
              }}
              onAcceptNew={(sourceId) => change('Saving', async (id) => { const r = await service.acceptSourceChange(id, sourceId); if (!r.ok && r.reason) setNotice(r.reason) })}
              onVerify={(claimId) => change(`Looking for a source with ${chatModel}`, async (id) => { const r = await service.verifyClaims(id, { claimIds: [claimId], model: chatModel }); setNotice(verifyText(r)) })}
              onCheck={(claimId) => change(`Checking with ${chatModel}`, async (id) => { const r = await service.checkClaim(id, claimId, chatModel); setNotice(r.status === 'checked' ? `Checked with ${chatModel}: ${r.verdict.replace('_', ' ')}. ${r.reason}` : r.status === 'no_sources' ? 'There is no stored passage to check against.' : r.reason) })}
            />}
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
          mode={chatMode}
          onMode={setChatMode}
          editLabel={view === 'outline' ? 'Edit the outline' : 'Edit the article'}
          busy={busy !== null}
          canAct={Boolean(activeId)}
          shown={tab === 'chat'}
          onSend={() => void sendChat()}
          onAdjust={(m) => { const mode = chatMode === 'answer' ? 'suggest' : chatMode; setChatMode(mode); void sendChat(m, mode) }}
          onAction={(a: ChatAction) => { if (a === 'check') checkFromChat(); else if (a === 'prepare') prepareFromChat(); else verifyFromChat() }}
          repos={activeId ? (void repoTick, service.attachedRepos(activeId)) : []}
          onRepoVerify={verifyInRepo}
          onPickRepoFolder={services.pickFolder ? pickRepoFolderAndVerify : undefined}
          onRemoveRepo={removeRepo}
          onDropFiles={(files) => dropFiles(files, false, true)}
        />
      </main>
    </div>
  )
}

