import { useEffect, useMemo, useRef, useState } from 'react'
import { InMemoryEmailCache, searchMail, type CatchUpView, type Message, type ScoredTodo, type SendersView, type SpamView, type WorkbenchEvent } from '@buildaharness/aielia'
import type { SampleMailbox } from './sample-mode'
import { EmailLayout } from './EmailLayout'
import { MessageList } from './MessageList'
import { MailReader } from './MailReader'
import { ReaderEmpty } from './ReaderEmpty'
import { AielaChat, type AielaChatLine } from './AielaChat'
import { TodoView } from './TodoView'
import { ProbablySpam } from './ProbablySpam'
import { WorkbenchPanel, type RulesView } from './WorkbenchPanel'
import { FolderList, MailIcon } from './mail-ui'
import { AppSwitcher } from '../components/AppSwitcher'
import type { AppId } from '../app-switch'

const SUGGESTIONS = ['Summarise my unread mail', 'What needs a reply this week?', 'Find the receipts']

/** The height of an element, kept up to date, so the windowed message list fills the pane it is in. */
function useHeight(fallback: number): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setH(Math.max(120, Math.floor(el.clientHeight))))
    ro.observe(el)
    setH(Math.max(120, Math.floor(el.clientHeight)))
    return () => ro.disconnect()
  }, [])
  return [ref, h]
}

const matches = (m: Message, q: string): boolean => {
  const t = q.trim().toLowerCase()
  return !t || `${m.from.name ?? ''} ${m.from.address} ${m.subject} ${m.textBody}`.toLowerCase().includes(t)
}

/**
 * The sample mailbox: the Inbox of the invented mailbox, and a chat box whose every answer says this is a sample. It uses the same page shell as Write
 * (a title bar with the app switcher, the sample notice) around the three-column mail layout. No model is ever called.
 */
export function SampleMailboxView({ sample, onConnect, appSwitch, activity = [] }: { sample: SampleMailbox; onConnect: () => void; /** The way to the other screens (the desktop app, or the hosted pages that name them). */ appSwitch?: (target: AppId) => void; /** What the capabilities are doing, newest last (live mailboxes with a model). */ activity?: readonly WorkbenchEvent[] }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<AielaChatLine[]>([])
  const [openId, setOpenId] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [threaded, setThreaded] = useState(true)
  const [serverHits, setServerHits] = useState<{ query: string; messages: Message[]; error?: string } | undefined>()
  const [serverBusy, setServerBusy] = useState(false)
  const [spamHidden, setSpamHidden] = useState<ReadonlySet<string>>(new Set()) // sample only: nothing is stored
  const [spamKept, setSpamKept] = useState<ReadonlySet<string>>(new Set())
  // Live mailbox with a model: the capabilities, run on request, read-only.
  const wb = sample.workbench
  const [running, setRunning] = useState<string | undefined>()
  const [wbError, setWbError] = useState<string | undefined>()
  const [catchUp, setCatchUp] = useState<CatchUpView | undefined>()
  const [rules, setRules] = useState<RulesView | undefined>()
  const [liveTodo, setLiveTodo] = useState<ScoredTodo[] | undefined>()
  const [liveSpam, setLiveSpam] = useState<SpamView | undefined>()
  const [liveSenders, setLiveSenders] = useState<SendersView | undefined>()
  const runWb = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (running) return
    setRunning(what); setWbError(undefined)
    try { await fn() } catch (e) { setWbError(`${what} failed: ${e instanceof Error ? e.message : String(e)}`) } finally { setRunning(undefined) }
  }
  const refreshTodo = async (): Promise<void> => { if (wb) setLiveTodo(await wb.todo()) }
  const todoItems = liveTodo ?? sample.todo
  const spamItems = liveSpam ? liveSpam.rows.map((r) => ({ threadId: r.threadId, subject: r.subject, sender: r.sender, reason: r.reason })) : sample.spam.filter((s) => !spamHidden.has(s.threadId) && !spamKept.has(s.threadId))
  const inbox = sample.folders.find((f) => f.kind === 'inbox')
  const [folderId, setFolderId] = useState<string | undefined>(inbox?.id)
  const folder = sample.folders.find((f) => f.id === folderId) ?? inbox
  // A real mailbox loads each folder's messages on demand; the sample only has its Inbox.
  const [loaded, setLoaded] = useState<Message[] | undefined>()
  useEffect(() => {
    if (!sample.loadFolder || !folder) return undefined
    let alive = true
    setLoaded(undefined)
    void sample.loadFolder(folder.id).then((m) => { if (alive) setLoaded(m) })
    return () => { alive = false }
  }, [sample, folder?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const inFolder = useMemo(() => (sample.loadFolder ? (loaded ?? []) : folder?.kind === 'inbox' ? sample.inbox.filter((m) => !spamHidden.has(m.threadId)) : []), [sample, loaded, folder?.kind, spamHidden])
  const local = useMemo(() => inFolder.filter((m) => matches(m, query)), [inFolder, query])
  // Hits from the mail server for this very query, added after the local ones (nothing already shown is repeated).
  const extra = useMemo(() => (serverHits && serverHits.query === query.trim() ? serverHits.messages.filter((m) => !local.some((l) => l.id === m.id)) : []), [serverHits, query, local])
  const shown = useMemo(() => [...local, ...extra], [local, extra])
  const searchServer = async (): Promise<void> => {
    const q = query.trim()
    if (!q || serverBusy) return
    setServerBusy(true)
    try {
      const r = await searchMail({ text: q }, 'server', { account: sample.provider.account, cache: new InMemoryEmailCache(), provider: sample.provider, limit: 30 })
      setServerHits({ query: q, messages: r.hits.map((h) => h.message), ...(r.serverError ? { error: r.serverError.message } : {}) })
    } finally { setServerBusy(false) }
  }
  const open = (sample.loadFolder ? inFolder : sample.inbox).find((m) => m.id === openId)
  const unread = inFolder.filter((m) => !m.flags.read).length
  const [listBox, listHeight] = useHeight(480)
  const next = useRef(1)

  const send = async (override?: string): Promise<void> => {
    const t = (override ?? text).trim()
    if (!t || busy) return
    setText('')
    setBusy(true)
    const mine: AielaChatLine = { id: next.current++, from: 'you', text: t }
    setLines((l) => [...l, mine])
    try {
      const r = await sample.ask(t)
      setLines((l) => [...l, { id: next.current++, from: 'aielia', text: r.reply }])
    } finally { setBusy(false) }
  }

  const folderTitle = folder?.name ?? 'Inbox'
  return (
    <div className="write email-sample">
      <header className="write__bar email-top">
        <h1 className="write__title">
          <a className="brand-link" href="https://myaielia.com" target="_blank" rel="noopener noreferrer" title="Go to myaielia.com">Aielia</a>{' '}
          {appSwitch ? <AppSwitcher current="email" onSelect={appSwitch} /> : 'Email'}
        </h1>
        <label className="email-search">
          <MailIcon name="search" size={16} />
          <input type="search" aria-label="Search mail" placeholder="Search mail" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </header>
      <EmailLayout
        readerOpen={!!open}
        todoCount={todoItems.filter((t) => t.status === 'open').length}
        todo={<TodoView items={todoItems.filter((t) => t.status === 'open')} onOpenThread={(tid) => setOpenId(sample.inbox.find((m) => m.threadId === tid)?.id)} />}
        title={folderTitle}
        onBack={() => setOpenId(undefined)}
        banner={
          sample.live ? (
            <div className="write__sample" role="note">
              <span className="write__sample-text"><strong>{sample.live.label}</strong> Read-only: Aielia shows the mail Apple Mail already downloaded. Nothing is sent or changed.</span>
              <button type="button" className="write__sample-add" onClick={onConnect}>Connect another way</button>
            </div>
          ) : (
          <div className="write__sample" role="note">
            <span className="write__sample-text"><strong>Sample.</strong> These messages are invented. Connect your mail and your AI to use Aielia on your own.</span>
            <button type="button" className="write__sample-add" onClick={onConnect}>Connect</button>
          </div>
          )
        }
        railIcons={<FolderList folders={sample.folders} activeId={folder?.id} onSelect={setFolderId} compact />}
        folders={<FolderList folders={sample.folders} activeId={folder?.id} onSelect={setFolderId} />}
        list={
          <div className="mailpane">
            <div className="mailpane__head">
              <h2>{folderTitle}</h2>
              <span className="mailpane__meta">{query.trim() ? `${shown.length} found${extra.length ? ` (${extra.length} from the server)` : ''}` : unread > 0 ? `${unread} unread` : `${inFolder.length} messages`}</span>
              <button type="button" className="email__iconbtn mailpane__threads" aria-pressed={threaded} aria-label="Group into conversations" title={threaded ? 'Showing conversations: click for single messages' : 'Showing single messages: click to group into conversations'} onClick={() => setThreaded((v) => !v)}>
                <MailIcon name="chat" size={16} />
              </button>
            </div>
            {wb && (
              <WorkbenchPanel
                running={running} events={activity} {...(catchUp ? { catchUp } : {})} {...(liveSpam ? { spam: liveSpam } : {})} {...(liveSenders ? { senders: liveSenders } : {})} {...(rules ? { rules } : {})} {...(wbError ? { error: wbError } : {})}
                onCatchUp={(days) => void runWb('catch-up', async () => { setCatchUp(await wb.catchUp(days)); await refreshTodo() })}
                onSpam={(days) => void runWb('spam check', async () => { setLiveSpam(await wb.spam(days)); await refreshTodo() })}
                onSenders={(days) => void runWb('sorting senders', async () => { setLiveSenders(await wb.senders(days)) })}
                onRules={() => void runWb('rule proposals', async () => { setRules(await wb.ruleProposals()); await refreshTodo() })}
                onTodo={() => void runWb('to do', refreshTodo)}
                onOpenThread={(tid) => { const at = wb.locate(tid); if (at) { setFolderId(at.folderId); setOpenId(at.messageId) } }}
              />
            )}
            {query.trim() && (sample.live?.serverSearch ?? true) && serverHits?.query !== query.trim() && <button type="button" className="mailpane__server" disabled={serverBusy} onClick={() => void searchServer()}>{serverBusy ? 'Searching the server…' : 'Search the whole mailbox on the server too'}</button>}
            {serverHits?.error && serverHits.query === query.trim() && <p role="status" className="mailpane__none">The server could not be searched: {serverHits.error}</p>}
            {folder?.kind === 'inbox' && <ProbablySpam items={spamItems} {...(wb ? { readOnlyNote: 'Read-only: nothing is moved' } : {})} onMoveAll={() => setSpamHidden(new Set([...spamHidden, ...spamItems.map((s) => s.threadId)]))} onNotSpam={(id) => setSpamKept(new Set([...spamKept, id]))} />}
            <div className="mailpane__body" ref={listBox}>
              {shown.length > 0
                ? <MessageList messages={shown} threaded={threaded} height={listHeight} activeId={openId} onOpen={setOpenId} />
                : <p className="mailpane__none">{query.trim() ? 'No message matches your search.' : `Nothing in ${folderTitle} in this sample.`}</p>}
            </div>
          </div>
        }
        reader={open ? <MailReader message={open} /> : <ReaderEmpty unread={unread} />}
        aielia={<AielaChat lines={lines} input={text} onInput={setText} onSend={(t) => void send(t)} busy={busy} suggestions={SUGGESTIONS} subtitle={sample.live ? sample.live.label.replace(/\.$/, '') : 'Sample mailbox'} />}
      />
    </div>
  )
}
