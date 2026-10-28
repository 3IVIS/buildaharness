import { useCallback, useEffect, useRef, useState } from 'react'
import { SpendBadge } from './SpendBadge'
import { type WorkKind, workPlan, litRange, modelFailureHint, modelLabel, githubRepoReader, parseGithubRepoAddress, type FolderReader, expandSelection, summarizeVerify, summarizeArticleSources, type VerifyReport, textPieces, collectIssues, parseLineRange, sourceKindForFile, computeReadiness, effectiveSourceStatus, issueCount, textUnitAt, autosaveStep, outlineOf, issuesInRange, unitOfSelection, shouldDeriveStyle, type ArticleBundle, type ChangeSummary, type DependencyKind, type IssueCategory, type Section, type WritePermissions, type JobOutcome, type ResultLine, type ChatStageListener, claimResultLine, recentResults, typicalMs, usuallyText } from '@buildaharness/aielia'
import type { ChatAction } from './AdjustBar'
import { ArticleSwitcher, type ArticleItem } from './ArticleSwitcher'
import { readFileText } from './file-text'
import { StoppedError, isStopped, type Step } from './work-step'
import { ChatPane, type ChatLine, type ChatMode, type WorkProgress } from './ChatPane'
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
import { SiteNav } from '../components/SiteNav'
import './write.css'

/** The kinds of job that can change the article's text, so that what they changed is lit afterwards. */
/** The kinds of job that call the model; they leave a trace in the chat. Any other job does so only if it turns out to have made a call. */
const MODEL_KINDS = new Set<WorkKind>(['edit', 'draft', 'suggest', 'answer', 'verify', 'check', 'resolve', 'prepare', 'style'])
const CHANGES_TEXT = new Set<WorkKind>(['edit', 'draft', 'change', 'resolve', 'files', 'import', 'page'])
/** How long a banner message stays before it clears itself. */
const BANNER_MS = 10_000

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
/** What one request used, for the small line after its last message. */
export const usageText = (ms: number, d: { usd: number; inputTokens: number; outputTokens: number; calls: number }): string => {
  const time = ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
  if (d.calls === 0) return `no model call · ${time}`
  const total = d.inputTokens + d.outputTokens
  return `${total.toLocaleString('en-US')} tokens (${d.inputTokens.toLocaleString('en-US')} in, ${d.outputTokens.toLocaleString('en-US')} out) · ${d.calls} call${d.calls === 1 ? '' : 's'} · ${time} · $${d.usd < 0.01 ? d.usd.toFixed(4) : d.usd.toFixed(2)}`
}
/** One lookup the repository search makes, in words. */
export const stepText = (step: { tool: string; input: Record<string, unknown> }): string => {
  const arg = (k: string): string => (typeof step.input[k] === 'string' ? (step.input[k] as string) : '')
  const what = step.tool === 'search' ? `searching for “${arg('pattern') || arg('query')}”` : step.tool === 'read' ? `reading ${arg('path') || arg('file')}` : step.tool === 'list' ? 'listing files' : `using ${step.tool}`
  return what
}
export const failureText = (what: string, err: unknown, backend?: string): string => `${what}: ${err instanceof Error ? err.message : String(err)}. ${modelFailureHint(backend)}`

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
/** Everything the chat shows is stored; the cap only keeps a years-long chat from growing without end. */
const MAX_SAVED_LINES = 5000
/** The action running now, stored so that a page closed in the middle of it is told about it on the next start. */
const PENDING_KEY = 'chat-pending'
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
  /** The Publish button is hidden for now; the publish flow itself is kept (and tested) for when it comes back. */
  showPublish?: boolean
}

export function WriteApp(props: WriteAppProps): React.JSX.Element {
  return <DialogProvider><WriteAppBody {...props} /></DialogProvider>
}

function WriteAppBody({ services, connection, onDeleted, showPublish = false }: WriteAppProps): React.JSX.Element {
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
  // Every message the app has for the writer goes into the chat; the banner only repeats the latest one where the chat is not on screen.
  const [banner, setBannerText] = useState<{ text: string; inChat: boolean } | null>(null)
  // The banner goes away on its own; a newer message is a new object, so it restarts the timer.
  useEffect(() => {
    if (!banner) return
    const timer = setTimeout(() => setBannerText(null), BANNER_MS)
    return () => clearTimeout(timer)
  }, [banner])
  /**
   * Only an action that calls the model leaves a trace in the chat. An action that does not (opening, renaming, saving a setting)
   * reports in the banner. A job that might call the model holds its lines until it has finished and drops them if no call was made.
   */
  const jobTrace = useRef<{ mode: 'chat' | 'held'; held: ChatLine[] } | null>(null)
  const trace = useCallback((from: 'you' | 'aielia', text: string): void => {
    const line: ChatLine = { id: ++lineId, record: true, from, text }
    const job = jobTrace.current
    // Outside a job, a line comes from a flow that goes on to call the model (a verify or prepare request), so it belongs in the chat.
    if (!job || job.mode === 'chat') { setChat((c) => [...c, line]); return }
    job.held.push(line)
    if (from === 'aielia') setBannerText({ text, inChat: false })
  }, [])
  /** A message from the interface itself: a trace in the chat only while a model job is running, otherwise the banner. */
  const sayInChat = useCallback((text: string): void => {
    if (jobTrace.current) trace('aielia', text)
    else setBannerText({ text, inChat: false })
  }, [trace])
  const setNotice = useCallback((text: string | null): void => {
    if (!text) { setBannerText(null); return }
    sayInChat(text)
    if (jobTrace.current?.mode === 'chat') setBannerText({ text, inChat: true })
  }, [sayInChat])
  /** What a command sent through the chat is doing right now, shown as the last line of the chat until the result or the error replaces it. */
  const [progress, setProgress] = useState<WorkProgress | null>(null)
  const stopRef = useRef<AbortController | null>(null)
  /** The text as it was when a job that changes the article began; when the article changes under it, the passage that changed is lit for a moment. */
  const flashFrom = useRef<string | null>(null)
  const lastTyped = useRef(0)
  const [flash, setFlash] = useState<{ start: number; end: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // What has been spent follows every model call, so the header is right while a command is still running.
  const [spendTick, setSpendTick] = useState(0)
  // A file dragged over anywhere in the window is added to the sources when dropped.
  const [dropping, setDropping] = useState(false)
  useEffect(() => services.spend.subscribe(() => setSpendTick((n) => n + 1)), [services.spend])
  const [chat, setChat] = useState<ChatLine[]>([])
  const [activityTick, setActivityTick] = useState(0)
  const [chatInput, setChatInput] = useState('')
  const [chatMode, setChatMode] = useState<ChatMode>('answer')
  // Until the writer picks a mode, a chat with no article, or an empty one, writes the article; otherwise it answers.
  const [modePicked, setModePicked] = useState(false)
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
  }, [service, port, refreshList, reload, services.permissions, setNotice])

  // The chat comes back after a reload. It is saved only once the saved one has been read, so the empty start never overwrites it.
  const chatRead = useRef(false)
  const saveFailed = useRef(false)
  useEffect(() => {
    let live = true
    void services.store.getSetting(CHAT_LINES_KEY).then((raw) => {
      if (!live) return
      const saved = Array.isArray(raw) ? raw.filter(isChatLine) : []
      lineId = Math.max(lineId, ...saved.map((l) => l.id))
      setChat((now) => [...saved, ...now])
      return services.store.getSetting(PENDING_KEY).then((p) => {
        if (live && typeof p === 'string' && p) setChat((now) => [...now, { id: ++lineId, from: 'aielia', text: `“${p}” was still running when this page was closed, so it may not have finished. Check the article and run it again if needed.` }])
      })
    }).catch(() => { if (live) setChat((now) => [...now, { id: ++lineId, from: 'aielia', text: 'The earlier chat could not be read from storage, so it is not shown here.' }]) }).finally(() => { if (live) chatRead.current = true })
    return () => { live = false }
  }, [services.store])
  useEffect(() => {
    if (!chatRead.current) return
    void services.store.setSetting(CHAT_LINES_KEY, chat.slice(-MAX_SAVED_LINES)).then(() => { saveFailed.current = false }, (e) => {
      // Said once, in the chat itself; the failing save is not retried by this line, or it would loop.
      if (saveFailed.current) return
      saveFailed.current = true
      trace('aielia', `The chat could not be stored, so it will not be here next time: ${e instanceof Error ? e.message : String(e)}`)
    })
  }, [chat, services.store, trace])

  useEffect(() => {
    if (!activeId) { setVersions([]); setWorking(undefined); return }
    void service.history(activeId).then((v) => setVersions(v as VersionRow[]), () => undefined)
    void service.changeSinceLastVersion(activeId).then(setWorking, () => undefined)
  }, [service, activeId, bundle, versionsTick])
  // An earlier version stays on screen while the article is saved underneath it; only opening another article ends the view.
  useEffect(() => { setViewing(null); setShowHistory(false) }, [activeId])

  /**
   * Every action is a short conversation in the chat: the writer's action as a line, the progress as the last line while it runs, then
   * what came of it, or what went wrong. `announce` is false when the writer's own words already opened the exchange (a typed message).
   */
  async function run(label: string, work: (step: Step) => Promise<void>, announce = true, doneNote = '', kind: WorkKind = 'other'): Promise<void> {
    jobTrace.current = { mode: MODEL_KINDS.has(kind) ? 'chat' : 'held', held: [] }
    if (announce) trace('you', label)
    const mark = lineId
    const before = services.spend.snapshot()
    const started = Date.now()
    const ctl = new AbortController()
    stopRef.current = ctl
    setBusy(label)
    setBannerText(null)
    setProgress({ kind, label, stage: 0, startedAt: started })
    // How long this kind of job usually takes for this writer, once there is enough history to say.
    void services.activity.read().then((r) => { const usually = usuallyText(typicalMs(r, kind)); if (usually) setProgress((p) => (p && p.startedAt === started ? { ...p, usually } : p)) }, () => undefined)
    if (CHANGES_TEXT.has(kind)) flashFrom.current = draftRef.current
    void services.store.setSetting(PENDING_KEY, label).catch(() => undefined)
    const quiet = (text: string, stage?: number, count?: readonly [number, number]): void => setProgress((p) => (p ? { ...p, detail: text || undefined, stage: stage ?? p.stage, count } : p))
    const step = Object.assign(
      (text: string, stage?: number, count?: readonly [number, number]): void => { if (ctl.signal.aborted) throw new StoppedError(); quiet(text, stage, count) },
      { quiet, note: (line: ResultLine): void => setProgress((p) => (p ? { ...p, results: recentResults(p.results ?? [], line) } : p)), stopped: () => ctl.signal.aborted, signal: ctl.signal },
    ) as Step
    let ok = false
    let outcome: JobOutcome = 'done'
    try {
      await work(step)
      ok = true
      // An action that had nothing to say still says it is done.
      if (lineId === mark) sayInChat(`${label}: done.${doneNote}`)
      // Stop was pressed while the last step was already running (a model call cannot be taken back), so the work finished: say so, so it does not look ignored.
      if (ctl.signal.aborted) sayInChat('Stop came while the last step was already running, so it finished. If you did not want its result, the version saved before it is in History.')
    } catch (err) {
      outcome = isStopped(err) ? 'stopped' : 'failed'
      if (isStopped(err)) {
        sayInChat(`${label}: stopped. What was done before that stays; nothing after it ran.`)
        // The work may have changed the article before it stopped, so the page shows it as it is now.
        const id = activeIdRef.current
        if (id) { try { await reload(id) } catch { /* the page keeps what it shows */ } }
      } else sayInChat(`${label} did not finish: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // The last thing said in this turn carries what the whole request used, in small type.
      const after = services.spend.snapshot()
      const job = jobTrace.current
      jobTrace.current = null
      // A job that held its lines shows them in the chat only if it called the model after all.
      if (job?.mode === 'held' && after.calls > before.calls) { setChat((c) => [...c, ...job.held]); setBannerText(null) }
      const usage = usageText(Date.now() - started, { usd: after.usd - before.usd, inputTokens: after.inputTokens - before.inputTokens, outputTokens: after.outputTokens - before.outputTokens, calls: after.calls - before.calls })
      void services.activity.record({ at: new Date(started).toISOString(), kind, outcome, ms: Date.now() - started, usd: Math.max(0, after.usd - before.usd), calls: after.calls - before.calls }).then(() => setActivityTick((t) => t + 1))
      setChat((c) => { let i = -1; c.forEach((l, k) => { if (l.from === 'aielia' && l.id > mark) i = k }); return i < 0 ? c : c.map((l, k) => (k === i ? { ...l, usage } : l)) })
      if (stopRef.current === ctl) stopRef.current = null
      setBusy(null)
      // A finished job ticks its last step and holds for a moment before it goes, so the end is seen; a stopped or failed one goes at once.
      if (ok) {
        setProgress((p) => (p ? { ...p, finishing: true, detail: undefined, count: undefined, streamed: undefined } : p))
        setTimeout(() => setProgress((p) => (p && p.startedAt === started ? null : p)), 700)
      } else setProgress(null)
      setTimeout(() => { flashFrom.current = null }, 800)
      void services.store.setSetting(PENDING_KEY, '').catch(() => undefined)
    }
  }
  /** Stop was pressed: the work ends at its next step boundary, and the chat turn itself is cancelled. */
  const stopWork = (): void => {
    if (!stopRef.current || stopRef.current.signal.aborted) return
    stopRef.current.abort()
    setProgress((p) => (p ? { ...p, stopping: true } : p))
  }
  /** A command the writer sent through the chat: the writer's line is already there, so it is not repeated. */
  const chatRun = (label: string, work: (step: Step) => Promise<void>, kind: WorkKind = 'other'): Promise<void> => run(label, work, false, '', kind)

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

  const change = (label: string, work: (id: string, step: Step) => Promise<void>, kind: WorkKind = 'change'): void => {
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    const last = workPlan(kind, label).steps.length - 1
    void run(label, async (step) => { step('', 0); await flushDraft(); step('', 1); await work(activeId, step); step.quiet('', last); await reload(activeId) }, true, ' The article is updated.', kind)
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
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    const current = articles.find((a) => a.id === activeId)
    const name = (await dialogs.ask('New name for this article?', { initial: current?.name ?? current?.title ?? '' }))?.trim()
    if (!name) return
    await run('Renaming', async () => { await service.rename(activeId, name); await refreshList() }, true, ' The article has its new name.')
  }

  function onType(value: string): void {
    const prev = draftRef.current
    draftRef.current = value
    lastTyped.current = Date.now()
    if (flash) setFlash(null)
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
      setChat([{ id: ++lineId, from: 'aielia', text: 'All your data was deleted.' }])
      onDeleted?.()
    })
  }

  // ---- publish, export, import
  async function publish(): Promise<void> {
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    const label = await dialogs.ask('Label for this published version (optional)?')
    await run('Publishing', async (step) => {
      await flushDraft()
      step('', 1)
      const recheck = (permsRef.current ?? perms)?.recheckBeforePublish !== false ? await service.recheckSources(activeId, services.models.auto()) : undefined
      const folderReport = folderRef.current && (permsRef.current ?? perms)?.recheckBeforePublish !== false ? await service.recheckFolder(activeId, folderRef.current.reader, services.models.auto()) : undefined
      step('', 2)
      const b = await service.publish(activeId, label?.trim() || undefined)
      setBundle(b)
      const r = computeReadiness(b.meta)
      const open = r.unsourcedFactualClaims + r.staleOrUnsupportedClaims + r.openComments + r.sectionsNeedingReview
      const sources = recheck ? [recheck.changed.length > 0 ? `${recheck.changed.length} web source${recheck.changed.length === 1 ? ' has' : 's have'} changed since you read ${recheck.changed.length === 1 ? 'it' : 'them'}` : '', recheck.unreachable.length > 0 ? `${recheck.unreachable.length} could not be reached` : ''].filter(Boolean).join(' and ') : ''
      const files = folderReport && (folderReport.changed.length > 0 || folderReport.missing.length > 0) ? [folderReport.changed.length > 0 ? `${folderReport.changed.length} file${folderReport.changed.length === 1 ? '' : 's'} from the folder ${folderReport.changed.length === 1 ? 'has' : 'have'} changed` : '', folderReport.missing.length > 0 ? `${folderReport.missing.length} could not be found` : ''].filter(Boolean).join(' and ') : ''
      setNotice(`Published as a frozen snapshot.${open > 0 ? ` ${open} item${open === 1 ? ' was' : 's were'} still open; ${open === 1 ? 'it is' : 'they are'} recorded with it.` : ''}${sources ? ` ${sources}: see Issues.` : ''}${files ? ` ${files} since you read them: see the sources.` : ''}`)
    }, true, '', 'publish')
  }

  async function exportArticle(): Promise<void> {
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    const id = activeId
    await run('Exporting the article', async () => {
      const folder = await service.exportArticle(id)
      const fileName = `${bundle?.meta.name ?? bundle?.meta.title ?? 'article'}.aielia-article.json`
      const text = JSON.stringify(folder, null, 2)
      // A host with its own way to save a file (a save dialog) is used; a browser tab gets a download link.
      if (services.saveFile) { await services.saveFile(fileName, text); sayInChat(`The article was saved as ${fileName}.`); return }
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      a.download = fileName
      a.click()
      URL.revokeObjectURL(a.href)
      sayInChat(`The article was exported as ${fileName}. Your browser has put it in your downloads.`)
    })
  }

  async function importArticle(file: File): Promise<void> {
    await run('Importing', async (step) => {
      if (!file.name.toLowerCase().endsWith('.json')) {
        const r = await service.importTextFile(file.name, await file.text())
        if (!r.ok) throw new Error(r.reason)
        step('', 1)
        await refreshList()
        await select(r.id)
        setNotice(`This is a copy of the file. Editing it does not change the original. ${await prepareFromText(r.id, undefined, step, 2)}`)
        return
      }
      let folder: Record<string, string>
      try { folder = JSON.parse(await file.text()) as Record<string, string> } catch { throw new Error('That file is not an exported article.') }
      step('', 1)
      const r = await service.importArticle(folder)
      if (!r.ok) throw new Error(r.reason)
      await refreshList()
      await select(r.id)
    }, true, '', 'import')
  }

  async function openPage(): Promise<void> {
    const address = await dialogs.ask('Address of the web page to bring in and edit (http:// or https://)?')
    if (!address?.trim()) return
    await run('Reading the page', async (step) => {
      const r = await service.importPage(address)
      if (!r.ok) throw new Error(r.reason)
      step('', 1)
      await refreshList()
      await select(r.id)
      setNotice(`This is a copy of the page as it reads now. Editing it does not change the original, and the page is kept as a source. ${await prepareFromText(r.id, undefined, step, 2)}`)
    }, true, '', 'page')
  }

  // ---- history
  const saveVersion = async (): Promise<void> => {
    const label = await dialogs.ask('Name this version (optional)?')
    change('Saving the version', async (id) => { await service.saveVersion(id, label) })
  }
  const openVersion = (index: number, mode: 'view' | 'compare'): void => {
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    void run('Opening the version', async () => {
      if (mode === 'compare') await flushDraft()
      const snap = await service.getVersion(activeId, index)
      setViewing(mode === 'view' ? { mode, index, markdown: snap.markdown } : { mode, index, markdown: snap.markdown, diff: await service.compareWithCurrent(activeId, index) })
      setShowHistory(true)
      if (!isWide()) setTab('text')
      sayInChat(mode === 'view' ? 'That version is shown in the main window. Switch back with “Current”.' : 'That version is compared with the article as it is now in the main window.')
    })
  }
  const restoreVersion = async (index: number): Promise<void> => {
    if (!(await dialogs.confirm('Restore this version as your working article? The article as it is now is saved first, so nothing is lost.', { yes: 'Restore' }))) return
    change('Restoring', async (id) => { await service.restore(id, index); setNotice('Restored. The article as it was before is in History.') })
  }

  // ---- style sheet and links drawn from the text
  /** A first style sheet and the links between sections, drawn from the article's own text with the model for automatic checks; says in one sentence what it found. */
  async function prepareFromText(id: string, model: string = services.models.auto(), step?: Step, at = 1): Promise<string> {
    const before = await service.get(id)
    step?.('', at)
    const style = await service.deriveStyleFromText(id, model)
    step?.('', at + 1)
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
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    const id = activeId
    const used = services.models.chat() // started from the chat, so it runs on the model chosen there
    trace('you', 'Fill in the style and links from the article')
    void chatRun('Filling in the style and links', async (step) => {
      try {
        await flushDraft()
        const text = await prepareFromText(id, used, step)
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text, model: used }])
      } catch (e) {
        if (isStopped(e)) throw e
        trace('aielia', failureText('I could not do that', e, services.backend))
      }
    }, 'prepare')
  }

  /** Reads the style from the text, filling only the empty lines. */
  const deriveStyle = (): void => {
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    const id = activeId
    void run('Reading the style from the text', async (step) => {
      await flushDraft()
      step('', 1)
      const r = await service.deriveStyleFromText(id, services.models.auto())
      setStyleReading({ id, state: r.reason ? 'failed' : 'idle', error: r.reason })
      setBundle(await service.get(id))
      setNotice(r.filled.length > 0 ? `Filled in: ${r.filled.join(', ')}. Edit anything that is off.` : 'I found nothing to add to the style.')
    }, true, '', 'style')
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
  // When a job has changed the article, the passage that changed is lit for a moment (not when the writer is the one typing).
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const from = flashFrom.current
    if (from === null || from === draft || Date.now() - lastTyped.current < 1500) return
    flashFrom.current = null
    const r = litRange(from, draft)
    if (!r) return
    setFlash(r)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2800)
  }, [draft])

  // The tab title says when work is going on and, if the writer has looked away, when it is done.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const base = document.title.replace(/^(Working… · |✓ Done · )/, '')
    if (busy) { document.title = `Working… · ${base}`; return () => { document.title = base } }
    return undefined
  }, [busy])
  const wasBusy = useRef(false)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (busy) { wasBusy.current = true; return }
    if (!wasBusy.current) return
    wasBusy.current = false
    if (!document.hidden) return
    const base = document.title.replace(/^(Working… · |✓ Done · )/, '')
    document.title = `✓ Done · ${base}`
    const back = (): void => { if (!document.hidden) { document.title = base; document.removeEventListener('visibilitychange', back) } }
    document.addEventListener('visibilitychange', back)
  }, [busy])

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
    const say = (text: string): void => trace('aielia', text)
    trace('you', address.trim() ? `Verify the claims against ${address.trim()}` : 'Verify the claims against the attached repositories')
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
        setProgress({ kind: 'other', label: `Listing ${typed}`, stage: 0, startedAt: Date.now() })
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
          setProgress(null)
        }
        if (!listed) return
      }
      verifyFromChat(true, null)
    })()
  }
  /** Chooses a repository folder on this computer, attaches it and checks the claims against it. */
  const pickRepoFolderAndVerify = (): void => {
    trace('you', 'Verify the claims against a folder on this computer')
    if (!activeId) { sayInChat('Open or create an article first, then choose the folder.'); return }
    const id = activeId
    void (async () => {
      try {
        const reader = await services.pickFolder?.()
        if (!reader) { sayInChat('No folder was chosen, so nothing was checked.'); return }
        setBusy('Listing the folder')
        setProgress({ kind: 'other', label: 'Listing the folder', stage: 0, startedAt: Date.now() })
        await reader.files()
        service.attachRepo(id, reader)
        setRepoTick((n) => n + 1)
      } catch (e) {
        trace('aielia', `I could not use that folder: ${e instanceof Error ? e.message : String(e)}`)
        return
      } finally {
        setBusy(null)
        setProgress(null)
      }
      verifyFromChat(true, null)
    })()
  }
  const removeRepo = (name: string): void => {
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    service.detachRepo(activeId, name)
    setRepoTick((n) => n + 1)
    sayInChat(`${name} is no longer used for checking claims.`)
  }

  const pickFolder = (): void => {
    void run('Choosing a folder', async () => {
      const reader = await services.pickFolder?.()
      if (!reader) { sayInChat('No folder was chosen.'); return }
      const files = await reader.files()
      setFolder({ reader, files })
      sayInChat(`Read ${files.length} file${files.length === 1 ? '' : 's'} from ${reader.name}. Pick one in the Sources box to add it as a source.`)
    })
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
    if (!selection) { sayInChat('Select some text in the article first, then add it.'); return }
    change(kind === 'comment' ? 'Adding the comment' : 'Adding the source', async (id) => {
      if (kind === 'comment') {
        const r = await service.addComment(id, selection, text)
        if (!r.ok) setNotice(r.reason)
      } else await addSourceAndPlace(looksLikeLink(text) ? { kind: 'web', address: text } : { kind: 'upload', passage: text }, true)
    })
  }

  // Files dropped with no article open: the article is made first, named after the first file, and the files are added once it is open.
  const pendingDrop = useRef<{ files: File[]; say: boolean } | null>(null)
  const dropFiles = (files: File[], attach: boolean, say = false): void => {
    if (!activeId) {
      if (files.length === 0) return
      pendingDrop.current = { files, say }
      const name = files[0].name.replace(/\.[^.]+$/, '').trim() || 'New article'
      void run('Creating', async () => {
        const id = await service.create(name, `# ${name}\n\n`)
        await refreshList()
        await select(id)
      })
      return
    }
    change('Adding the files', async (_id, step) => {
      const lines: string[] = []
      for (const f of files) {
        step(`${f.name}`, 1)
        const kind = sourceKindForFile(f)
        if (!kind) { lines.push(`${f.name}: only text, code, PDF and Word (.docx) files can be read.`); continue }
        let text: string
        try { text = await readFileText(f) } catch (e) { lines.push(`${f.name}: could not be read (${e instanceof Error ? e.message : String(e)}).`); continue }
        if (!text.trim()) { lines.push(`${f.name}: has no text I can read${/\.pdf$/i.test(f.name) ? ' (a scanned PDF is a picture of text)' : ''}.`); continue }
        step(f.name, 2)
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
    }, 'files')
  }

  useEffect(() => {
    if (!activeId || !pendingDrop.current) return
    const { files, say } = pendingDrop.current
    pendingDrop.current = null
    dropFiles(files, false, say)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when an article opens; dropFiles is the current render's
  }, [activeId])

  // ---- issues in batches
  const resolveCategory = (category: IssueCategory): void => change('Working on it', async (id) => {
    const r = await service.resolveCategory(id, category, { model: chatModel })
    setNotes([{ category, done: r.done, note: r.note }])
  }, 'resolve')
  const resolveAll = (): void => change(`Resolving with ${modelLabel(chatModel)}`, async (id, step) => {
    const reports = await service.resolveAll(id, { model: chatModel, onProgress: (done, total, category) => step.quiet(`${category}`, 1, [done, total]), shouldStop: step.stopped })
    setNotes(reports.filter((r) => r.done > 0 || r.note).map((r) => ({ category: r.category, done: r.done, note: r.note })))
  }, 'resolve')

  // ---- chat
  const verifyText = (r: VerifyReport, meta?: Parameters<typeof summarizeArticleSources>[0]): string => {
    const label = (o: string): string => (o === 'contradicted' ? 'Contradicted' : o === 'no_source_found' ? 'No source found' : o === 'search_failed' ? 'Search failed' : 'Could not check')
    const lines = r.entries.filter((e) => ['no_source_found', 'contradicted', 'could_not_check', 'search_failed'].includes(e.outcome)).slice(0, 12).map((e) => `• ${label(e.outcome)}: ${e.quote.slice(0, 100)}${e.outcome !== 'no_source_found' && e.reason ? ` (${e.reason.slice(0, 160)})` : ''}`)
    return [summarizeVerify(r), ...lines, meta ? summarizeArticleSources(meta) : '', r.entries.some((e) => e.found.length > 0) ? 'Pages that were found are kept as suggested sources under the text: confirm the ones that are right.' : ''].filter(Boolean).join('\n')
  }
  const verifyFromChat = (repoOnly = false, said?: string | null): void => {
    const used = services.models.chat()
    if (said !== null) trace('you', said ?? (repoOnly ? 'Verify the claims against the repository' : 'Search the web for sources and verify the claims'))
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    void chatRun(`Verifying with ${modelLabel(used)}`, async (step) => {
      try {
        await flushDraft()
        step('', 1)
        let calls = 0
        let detail = ''
        let latest: readonly [number, number] | undefined
        const r = await service.verifyClaims(activeId, {
          model: used,
          repoOnly,
          onStep: (st) => { detail = `${stepText(st)} (lookup ${++calls})`; step.quiet(detail, 2, latest) },
          onProgress: (done, total) => { latest = [done, total]; step.quiet(detail, 2, latest) },
          onEntry: (e) => step.note(claimResultLine(e.outcome, e.quote)),
          shouldStop: step.stopped,
        })
        step.quiet('', 3)
        const fresh = await service.get(activeId)
        setBundle(fresh)
        const early = r.stopped ? `Stopped early: ${r.entries.length} claim${r.entries.length === 1 ? ' was' : 's were'} checked and ${r.leftOver} ${r.leftOver === 1 ? 'is' : 'are'} left for another run.\n` : ''
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: early + verifyText(r.stopped ? { ...r, leftOver: 0 } : r, fresh.meta), model: used }])
      } catch (e) {
        if (isStopped(e)) throw e
        trace('aielia', failureText('The check could not finish', e, services.backend))
      }
    }, 'verify')
  }
  /** A check started from the chat, with the model chosen there. The result is said in the chat, with the model's name. */
  const checkFromChat = (): void => {
    const used = services.models.chat()
    trace('you', 'Find the factual claims and check them against their sources')
    if (!activeId) { sayInChat('Open or create an article first.'); return }
    void chatRun(`Checking with ${modelLabel(used)}`, async (step) => {
      try {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const o = await service.updateText(activeId, draft, { model: used })
      const full = o.changedSectionIds.length === 0 ? await service.analyze(activeId, used) : o
      step('', 1)
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
        if (isStopped(e)) throw e
        trace('aielia', failureText('The check could not finish', e, services.backend))
      }
    }, 'check')
  }

  /** Collects the words of a streaming answer and shows them a few times a second, not once for every word. */
  const streamInto = (): { push: (token: string) => void; end: () => void } => {
    let text = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (): void => { timer = undefined; setProgress((p) => (p ? { ...p, streamed: text } : p)) }
    return {
      push: (token) => { text += token; if (!timer) timer = setTimeout(show, 80) },
      end: () => { if (timer) clearTimeout(timer); timer = undefined },
    }
  }

  /** Shows text as it arrives in the article's own box (not stored: the finished text is stored and reloaded when the job ends). */
  const typeInto = (): { push: (text: string) => void; end: () => void } => {
    let latest = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (): void => { timer = undefined; setDraft(latest) }
    return {
      push: (text) => { latest = text; if (!timer) timer = setTimeout(show, 80) },
      end: () => { if (timer) clearTimeout(timer); timer = undefined },
    }
  }

  /** One chat message, the same path whether typed or composed by the Adjust control. `mode` overrides the chat's mode for this message. */
  async function sendChat(override?: string, mode?: ChatMode): Promise<void> {
    const text = (override ?? chatInput).trim()
    if (!text) return
    const how = mode ?? effectiveMode
    const wantEdits = how === 'suggest'
    if (override === undefined) setChatInput('')
    setChat((c) => [...c, { id: ++lineId, from: 'you', text }])
    const drafting = how === 'edit' && view !== 'outline' && (!activeId || !draft.trim())
    const kind: WorkKind = how === 'edit' ? (drafting ? 'draft' : 'edit') : wantEdits ? 'suggest' : 'answer'
    await chatRun(how === 'edit' ? 'Editing' : wantEdits ? 'Asking for edits' : 'Thinking', async (step) => {
     // The words of a plain answer appear as they are written; an edit or a suggestion shows its steps instead, since the reply is not what is shown.
     const live = kind === 'answer' ? streamInto() : undefined
     const talk = async (id: string | undefined): Promise<{ reply: string; model: string }> => {
       const r = await services.chat(text, id, { signal: step.signal, onToken: live?.push })
       live?.end()
       if (r.stopped) throw new StoppedError()
       return r
     }
     // An edit, a draft or suggestions need only what the writer said kept in the article's record (one call), not a written reply (the rest of a turn).
     const noteIt = async (id: string | undefined): Promise<{ model: string; tail: string }> => {
       const r = await services.record(text, id, { signal: step.signal })
       if (r.stopped) throw new StoppedError()
       return { model: r.model, tail: r.recorded ? '' : '\n\nAny comments or corrections in your message were not added to the article\'s notes.' }
     }
     try {
      step('', 0)
      if (activeId) await service.updateText(activeId, draft, { analyze: false })
      step('', 1)
      if (how === 'edit' && (activeId || view !== 'outline')) {
        // The writer's words are recorded as in any chat turn. Then the version is saved, the edit is made, and the edited article is what is shown.
        // With no article open, the chat makes one first; it is named from the draft below.
        const fresh = !activeId
        let id = activeId
        if (!id) {
          id = await service.create('New article', '')
          await refreshList()
          await select(id)
        }
        const { model: said, tail } = await noteIt(id)
        step('', 2)
        // After the version is saved, the service says when it is asking the model and when it is applying the result.
        const chatStage: ChatStageListener = (stage, detail) => step.quiet(detail ?? '', stage === 'asking' ? 3 : 4)
        const outline = view === 'outline'
        if (!outline && (fresh || !draft.trim())) {
          // An empty article has no text to quote, so the chat writes the first draft instead of editing.
          // The draft is typed into the article as the model writes it; if it ends any other way than a finished draft, the stored text comes back below.
          const typed = typeInto()
          let d: Awaited<ReturnType<typeof service.draftFromChat>>
          try { d = await service.draftFromChat(id, text, said, fresh, step.signal, typed.push, chatStage) } catch (e) { typed.end(); await reload(id); throw e } finally { typed.end() }
          await reload(id)
          setViewing(null)
          setShowHistory(false)
          setVersionsTick((t) => t + 1)
          void refreshList()
          setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: (d.status === 'drafted' ? `I wrote the first draft${d.name ? ` and named the article “${d.name}”` : ''}, and the article now shows it. To go back, restore the earlier version in History.` : `I could not write the draft${d.reason ? `: ${d.reason}` : ''}, so the article is unchanged.`) + tail, model: said }])
          return
        }
        const r = outline ? await service.editOutlineFromChat(id, text, said, step.signal, chatStage) : await service.editFromChat(id, text, said, step.signal, chatStage)
        await reload(id)
        setViewing(null)
        setShowHistory(false)
        setVersionsTick((t) => t + 1)
        void refreshList()
        const saved = `I saved a version first (“${r.savedAs}”).`
        const short = (t: string): string => (t.length > 140 ? `${t.slice(0, 140)}…` : t)
        let body: string
        if (r.status === 'failed') body = `${saved} I could not make that edit${'reason' in r && r.reason ? `: ${r.reason}` : ''}, so the ${outline ? 'outline' : 'article'} is unchanged.`
        else if (r.status === 'nothing') body = `${saved} I found nothing to change in the ${outline ? 'outline' : 'text'} for that, so it is unchanged.`
        else if ('applied' in r) body = `${saved} Then I made ${r.applied.length} change${r.applied.length === 1 ? '' : 's'}${r.skipped > 0 ? ` (${r.skipped} no longer fitted)` : ''}, and the article now shows the edited text. To go back, restore that version in History.\n${r.applied.slice(0, 4).map((x) => `• “${short(x.quote)}” → “${short(x.replacement)}”`).join('\n')}${r.applied.length > 4 ? `\n…and ${r.applied.length - 4} more.` : ''}`
        else body = `${saved} Then I reworked the outline, and the article now shows it. To go back, restore that version in History.\nThe outline is now:\n${(r.after ?? '').split('\n').slice(0, 20).join('\n')}`
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: body + tail, model: said }])
      } else if (wantEdits && activeId) {
        // Record what the writer said (comments, corrections) the same way a chat turn does, then turn the request into suggestions.
        const { model: said, tail } = await noteIt(activeId)
        step('', 2)
        const r = await service.suggest(activeId, text, said, {}, step.signal)
        const now = await service.get(activeId)
        setBundle(now)
        const added = now.meta.suggestions.filter((x) => r.added.includes(x.id))
        const short = (t: string): string => (t.length > 140 ? `${t.slice(0, 140)}…` : t)
        // The reply is a separate model answer and can word an edit differently from the suggestion that was stored, so when suggestions were
        // made the chat states what was stored, and not the reply.
        const body = r.status === 'failed' ? 'I could not turn that into edits.'
          : added.length === 0 ? 'I found nothing to change in the text for that.'
          : `I added ${added.length} suggested change${added.length === 1 ? '' : 's'}. Open Issues to accept or reject ${added.length === 1 ? 'it' : 'them'}:\n${added.slice(0, 4).map((x) => `• “${short(x.span.quote)}” → “${short(x.replacement)}”`).join('\n')}${added.length > 4 ? `\n…and ${added.length - 4} more.` : ''}`
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: body + tail, model: said }])
      } else {
        const { reply, model: said } = await talk(activeId)
        if (activeId) setBundle(await service.get(activeId))
        setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: reply, model: said }])
      }
     } catch (e) {
      if (isStopped(e)) throw e
      setChat((c) => [...c, { id: ++lineId, from: 'aielia', text: failureText('The model call failed', e, services.backend) }])
     }
    }, kind)
  }

  const effectiveMode: ChatMode = modePicked || (activeId && draft.trim()) ? chatMode : 'edit'
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
    <div
      className={`write${dropping ? ' is-dropping' : ''}${progress && !progress.finishing ? ' is-working' : ''}`}
      onDragOver={(e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); setDropping(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false) }}
      onDrop={(e) => { setDropping(false); const files = Array.from(e.dataTransfer.files); if (files.length === 0) return; e.preventDefault(); dropFiles(files, false) }}
    >
      <header className="write__bar">
        <h1 className="write__title">Aielia Write</h1>
        <span className="write__badge" title="Early-stage alpha software — expect rough edges and breaking changes.">Alpha</span>
        <ArticleSwitcher articles={articles} activeId={activeId} onSelect={(id) => void run('Opening the article', async () => { await select(id) }, true, ' It is open.')} onRename={() => void renameArticle()} onNew={() => void createArticle()} onExport={() => void exportArticle()} onImport={(f) => void importArticle(f)} onOpenPage={services.canReadPages ? () => void openPage() : undefined} />
        {showPublish && <button type="button" className="write__primary" onClick={() => void publish()} disabled={!activeId || busy !== null}>Publish</button>}
        <SiteNav />
      </header>
      {((busy && !(isWide() || tab === 'chat')) || (banner && (!banner.inChat || !(isWide() || tab === 'chat')))) && <p className="write__notice" role="status">{busy && !(isWide() || tab === 'chat') ? `${busy}…` : banner?.text}</p>}

      <div className="write__status" role="group" aria-label="How close the article is to publishable, and what has been spent">
        <span>{readiness && `${readiness.unsourcedFactualClaims} unsourced · ${readiness.staleOrUnsupportedClaims} stale or unsupported · ${readiness.openComments} open comment${readiness.openComments === 1 ? '' : 's'} · ${readiness.sectionsNeedingReview} section${readiness.sectionsNeedingReview === 1 ? '' : 's'} to review`}</span>
        <SpendBadge usd={(void spendTick, services.spentUsd())} tokens={(void spendTick, services.spend.snapshot().inputTokens + services.spend.snapshot().outputTokens)} byType={(void spendTick, services.spendByType())} hostName={services.hostName} />
      </div>

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
            <SettingsPane activity={services.activity} activityTick={activityTick} hostName={services.hostName} connection={connection && { value: connection.value, onSave: (c) => { try { connection.onSave(c); sayInChat('The connection is saved.') } catch (e) { sayInChat(`The connection could not be saved: ${e instanceof Error ? e.message : String(e)}`) } }, onForget: () => { try { connection.onForget(); sayInChat('The connection was forgotten.') } catch (e) { sayInChat(`The connection could not be forgotten: ${e instanceof Error ? e.message : String(e)}`) } } }} github={services.setGithubToken ? { token: services.githubToken, onSave: (t) => run('Saving the GitHub token', async () => { await services.setGithubToken?.(t); setModelTick((n) => n + 1); sayInChat(t?.trim() ? 'The GitHub token is saved.' : 'The GitHub token is removed.') }) } : undefined} perms={perms} busy={busy !== null} onDeleteAll={() => void deleteAllData()} autoModel={services.models.auto()} chatModel={chatModel} suggestions={services.models.suggestions} onAutoModel={(m) => void run(`Switching the automatic checks to ${m}`, async () => { await services.models.setAuto(m); setModelTick((t) => t + 1); sayInChat(`Automatic checks now use ${m}.`) })} onSave={(p) => run('Saving the settings', async () => { await services.permissions.set(p); permsRef.current = p; setPerms(p); sayInChat('Settings saved.') })} />
          </section>
        </aside>
        {ready && meta ? (
          <section className={`write__pane write__pane--text ${tab === 'text' || tab === 'chat' ? 'is-shown' : ''}`} aria-label="Text">
            <div className="write__viewbar">
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
            </div>
            {viewing && showHistory && (view === 'outline' ? <VersionOutline viewing={viewing} onRestore={(i) => void restoreVersion(i)} /> : <VersionView viewing={viewing} statusLabel={STATUS_LABEL} onRestore={(i) => void restoreVersion(i)} />)}
            {view === 'outline' && !(viewing && showHistory) && (
              <div className="write__outlineview">
                <OutlinePanel markdown={draft} onOpen={jumpTo} onChange={onType} onSelect={(start) => { setSelection({ start, end: start }); growth.current = []; grownTo.current = undefined; setGrownUnit(undefined) }} />
              </div>
            )}
            <div className={`write__textview ${view === 'outline' || (viewing && showHistory) ? 'is-hidden' : ''}`}>
            <MarkedText flash={flash} textRef={textRef} value={draft} pieces={textPieces(meta, draft)} onChange={onType} onSelection={(r) => { setSelection(r); const g = grownTo.current; if (!g || g.start !== r.start || g.end !== r.end) { growth.current = []; grownTo.current = undefined; setGrownUnit(undefined) } }} onGrow={growSelection} onShrink={shrinkSelection} onPress={pressText} onDoubleClick={doubleClickText} selection={selection} />
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
                for (const t of c.add) { if (!selection) { setNotice('Select some text in the article to attach a new comment to it.'); break } const r = await service.addComment(id, selection, t); if (!r.ok) setNotice(r.reason) }
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
              onVerify={(claimId) => change(`Looking for a source with ${modelLabel(chatModel)}`, async (id) => { const r = await service.verifyClaims(id, { claimIds: [claimId], model: chatModel }); setNotice(verifyText(r)) })}
              onCheck={(claimId) => change(`Checking with ${modelLabel(chatModel)}`, async (id) => { const r = await service.checkClaim(id, claimId, chatModel); setNotice(r.status === 'checked' ? `Checked with ${chatModel}: ${r.verdict.replace('_', ' ')}. ${r.reason}` : r.status === 'no_sources' ? 'There is no stored passage to check against.' : r.reason) })}
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
          onModel={(m) => void run(`Switching the chat model to ${m}`, async () => { await services.models.setChat(m); setModelTick((t) => t + 1); sayInChat(`The chat now uses ${m}.`) })}
          input={chatInput}
          onInput={setChatInput}
          mode={effectiveMode}
          onMode={(m) => { setModePicked(true); setChatMode(m) }}
          editLabel={view === 'outline' ? 'Edit the outline' : 'Edit the article'}
          busy={busy !== null}
          canAct={Boolean(activeId)}
          shown={tab === 'chat'}
          onSend={() => void sendChat()} onStop={stopWork}
          onAdjust={(m) => { const mode = effectiveMode === 'answer' ? 'suggest' : effectiveMode; setChatMode(mode); setModePicked(true); void sendChat(m, mode) }}
          onAction={(a: ChatAction) => { if (a === 'check') checkFromChat(); else if (a === 'prepare') prepareFromChat(); else verifyFromChat() }}
          repos={activeId ? (void repoTick, service.attachedRepos(activeId)) : []}
          progress={progress}
          onRepoVerify={verifyInRepo}
          onPickRepoFolder={services.pickFolder ? pickRepoFolderAndVerify : undefined}
          onRemoveRepo={removeRepo}
          onDropFiles={(files) => dropFiles(files, false, true)}
        />
      </main>
    </div>
  )
}

