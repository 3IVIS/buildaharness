import { useEffect, useRef, useState } from 'react'
import { RailNav, type RailTab } from '../shared-ui/RailNav'
import { Splitter } from '../shared-ui/Splitter'
import { CHAT_DEFAULT, clampChat, layoutNow, readerPlacement, type LayoutMode, type PhonePanel } from './email-layout'
import { MailIcon, MAIL_ICONS } from './mail-ui'
import { EmptyState } from './ReaderEmpty'
import './email.css'





interface Props {
  /** The folder tree. It is the same node in the rail, the tablet slide-over and the phone drawer. */
  folders: React.ReactNode
  list: React.ReactNode
  reader: React.ReactNode
  /** The Aielia column: chat and the sample or error notices. */
  aielia: React.ReactNode
  todo?: React.ReactNode
  /** How many to-do items are open; shown as a count on the To do entry. */
  todoCount?: number
  /** Shown above everything (the sample notice). */
  banner?: React.ReactNode
  /** Overrides the mode read from matchMedia (tests, previews). */
  mode?: LayoutMode
  /** Whether a message is open: on a phone the reader replaces the list. */
  readerOpen?: boolean
  /** The folder icons shown in the collapsed rail. */
  railIcons?: React.ReactNode
  /** The open folder's name, shown in the phone's header row. */
  title?: string
  /** Closes the open message (the phone's back arrow). */
  onBack?: () => void
}

const SIZES_KEY = 'aielia-email-layout'
interface Sizes { chat?: number; list?: number; rail?: number }
/** The sizes the person dragged panes to, kept between sessions (nothing here is private). A browser without storage just starts from the defaults. */
function loadSizes(): Sizes {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SIZES_KEY)
    const p = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 4000 ? v : undefined)
    return { ...(n(p.chat) ? { chat: n(p.chat)! } : {}), ...(n(p.list) ? { list: n(p.list)! } : {}), ...(n(p.rail) ? { rail: n(p.rail)! } : {}) }
  } catch { return {} }
}
function saveSizes(s: Sizes): void { try { localStorage.setItem(SIZES_KEY, JSON.stringify(s)) } catch { /* no storage: sizes last for this session */ } }

const RAIL_WIDTH_DEFAULT = 232

/** The To do entry of the rail and the tablet drawer: one line with a check icon and the open count. */
function TodoEntry({ on, count, compact, onPick }: { on: boolean; count: number; compact?: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`email__todoentry${on ? ' is-on' : ''}`} aria-label={count > 0 ? `To do, ${count} open` : 'To do'} aria-pressed={on} title="To do" onClick={onPick}>
      <MailIcon name="todo" />
      {!compact && <span className="email__todolabel">To do</span>}
      {count > 0 && <span className="email__todocount" aria-hidden="true">{count}</span>}
    </button>
  )
}

/**
 * The Email page shell. Desktop: a folder rail (collapsed, opens on hover or click, can be pinned), the message list, the reader (beside or below the
 * list by room) and an always-on Aielia column on the right. Tablet: the same without the column, which is a slide-over, and folders as a slide-over.
 * Phone: one panel at a time (Email, To do, Aielia) with a bottom bar and a drawer for folders. Every panel stays mounted and is only hidden, so
 * the chat keeps its text when the user switches panels.
 */
export function EmailLayout({ folders, list, reader, aielia, todo, todoCount = 0, banner, mode: forced, readerOpen = false, railIcons, title, onBack }: Props): React.JSX.Element {
  const [detected, setDetected] = useState<LayoutMode>(() => layoutNow())
  const mode = forced ?? detected
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth))
  useEffect(() => {
    const on = (): void => { setDetected(layoutNow()); setWidth(window.innerWidth) }
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  const [pinned, setPinned] = useState(false)
  const [railHover, setRailHover] = useState(false)
  const [railClicked, setRailClicked] = useState(false)
  const [drawer, setDrawer] = useState(false) // folders drawer (phone) / slide-over (tablet)
  const [chatOpen, setChatOpen] = useState(false) // Aielia slide-over (tablet)
  const [panel, setPanel] = useState<PhonePanel>('email')
  const [view, setView] = useState<'mail' | 'todo'>('mail') // desktop and tablet: the middle shows mail or the To do list
  const [sizes, setSizes] = useState<Sizes>(loadSizes)
  const setSize = (k: keyof Sizes, v: number | undefined): void => setSizes((cur) => { const next = { ...cur }; if (v === undefined) delete next[k]; else next[k] = Math.round(v); saveSizes(next); return next })
  const chatWidth = sizes.chat ?? CHAT_DEFAULT
  const setChatWidth = (v: number): void => setSize('chat', v)
  const mailRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)

  // Opening a message (from the To do list, say) brings the mail view back.
  useEffect(() => { if (readerOpen) setView('mail') }, [readerOpen])

  const railOpen = mode === 'desktop' && (pinned || railHover || railClicked)
  const placement = readerPlacement(mode, width, chatWidth, pinned)
  const phone = mode === 'phone'
  const tablet = mode === 'tablet'
  const showEmail = phone ? panel === 'email' : view === 'mail'
  const showTodo = phone ? panel === 'todo' : view === 'todo'
  const chatShown = mode === 'desktop' || (tablet && chatOpen) || (phone && panel === 'aielia')
  const foldersShown = mode === 'desktop' || drawer

  const tabs: RailTab[] = [
    { id: 'email', label: 'Email', icon: MAIL_ICONS.mail },
    { id: 'todo', label: todoCount > 0 ? `To do (${todoCount})` : 'To do', icon: MAIL_ICONS.todo },
    { id: 'aielia', label: 'Aielia', icon: MAIL_ICONS.chat },
  ]

  return (
    <div className={`email email--${mode}`} data-layout={mode} data-reader={placement} data-open={readerOpen}>
      {banner}
      {tablet && (
        <div className="email__bar">
          {readerOpen && placement === 'below' && <button type="button" className="email__iconbtn email__backbtn" aria-label="Back to the list" title="Back" onClick={onBack}><MailIcon name="back" /></button>}
          <button type="button" className="email__iconbtn" aria-label="Folders" title="Folders" aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}><MailIcon name="menu" /></button>
          <span className="email__bartitle">{title}</span>
          <button type="button" className="email__iconbtn" aria-label="Aielia" title="Aielia" aria-expanded={chatOpen} onClick={() => setChatOpen((v) => !v)}><MailIcon name="chat" /></button>
        </div>
      )}
      <div className="email__body">
        {mode === 'desktop' && (
          <aside
            className={`email__rail${railOpen ? ' is-open' : ''}`}
            aria-label="Folders"
            data-open={railOpen}
            data-pinned={pinned}
            ref={railRef}
            style={railOpen ? { width: sizes.rail ?? RAIL_WIDTH_DEFAULT } : undefined}
            onMouseEnter={() => setRailHover(true)}
            onMouseLeave={() => { setRailHover(false); setRailClicked(false) }}
          >
            <div className="email__railbar">
              <button type="button" className="email__iconbtn" aria-label={railOpen ? 'Collapse folders' : 'Open folders'} title="Folders" aria-expanded={railOpen} onClick={() => setRailClicked((v) => !v)}><MailIcon name="menu" /></button>
              {railOpen && <button type="button" className="email__iconbtn" aria-label={pinned ? 'Unpin folders' : 'Pin folders open'} title={pinned ? 'Unpin folders' : 'Pin folders open'} aria-pressed={pinned} onClick={() => setPinned((v) => !v)}><MailIcon name="pin" /></button>}
            </div>
            <div className="email__railtodo"><TodoEntry on={view === 'todo'} count={todoCount} compact={!railOpen} onPick={() => setView((v) => (v === 'todo' ? 'mail' : 'todo'))} /></div>
            {!railOpen && railIcons && <div className="email__railicons" onClick={() => setView('mail')}>{railIcons}</div>}
            <div className="email__tree" hidden={!railOpen} onClick={() => setView('mail')}>{folders}</div>
          </aside>
        )}
        {mode === 'desktop' && pinned && (
          <Splitter
            label="Folder list width"
            axis="x"
            grow={1}
            className="email__split"
            measure={() => railRef.current?.getBoundingClientRect().width ?? sizes.rail ?? RAIL_WIDTH_DEFAULT}
            limits={() => ({ min: 170, max: Math.min(420, Math.max(170, width - chatWidth - 420)) })}
            onSize={(px) => setSize('rail', px)}
            onReset={() => setSize('rail', undefined)}
          />
        )}

        {phone && drawer && <div className="email__scrim" data-testid="scrim" onClick={() => setDrawer(false)} />}
        {mode !== 'desktop' && (
          <aside className="email__drawer" aria-label="Folders" data-open={drawer} hidden={!foldersShown}>
            <button type="button" className="email__iconbtn" aria-label="Close folders" onClick={() => setDrawer(false)}><MailIcon name="back" /></button>
            {!phone && <TodoEntry on={view === 'todo'} count={todoCount} onPick={() => { setView((v) => (v === 'todo' ? 'mail' : 'todo')); setDrawer(false) }} />}
            <div onClick={() => { setDrawer(false); setView('mail') }}>{folders}</div>
          </aside>
        )}

        <main className="email__mail" hidden={!showEmail} aria-label="Mail" ref={mailRef}>
          {phone && (
            <div className="email__phonebar">
              {readerOpen
                ? <button type="button" className="email__iconbtn" aria-label="Back to the list" title="Back" onClick={onBack}><MailIcon name="back" /></button>
                : <button type="button" className="email__iconbtn email__foldersbtn" aria-label="Open folders" title="Folders" onClick={() => setDrawer(true)}><MailIcon name="menu" /></button>}
              <span className="email__bartitle" />
            </div>
          )}
          <div
            className="email__list"
            hidden={phone && readerOpen}
            ref={listRef}
            style={placement === 'beside' && sizes.list ? { width: sizes.list } : placement === 'below' && readerOpen && sizes.list ? { height: sizes.list, minHeight: 0 } : undefined}
          >{list}</div>
          {!phone && (placement === 'beside' || (placement === 'below' && readerOpen)) && (
            <Splitter
              label={placement === 'beside' ? 'Message list width' : 'Message list height'}
              axis={placement === 'beside' ? 'x' : 'y'}
              grow={1}
              className={placement === 'beside' ? 'email__split email__split--list' : 'email__split email__split--listy'}
              measure={() => (placement === 'beside' ? listRef.current?.getBoundingClientRect().width : listRef.current?.getBoundingClientRect().height) ?? sizes.list ?? 360}
              limits={() => {
                const box = mailRef.current?.getBoundingClientRect()
                return placement === 'beside' ? { min: 240, max: Math.max(240, (box?.width ?? 900) - 320) } : { min: 120, max: Math.max(120, (box?.height ?? 700) - 180) }
              }}
              onSize={(px) => setSize('list', px)}
              onReset={() => setSize('list', undefined)}
            />
          )}
          <div className="email__reader" hidden={phone && !readerOpen}>{reader}</div>
        </main>

        {showTodo && <section className="email__todo" aria-label="To do">{todo ?? <EmptyState icon="todo" title="Nothing to do yet" text="Once Aielia has sorted your mail, the messages that need you show up here, with the reason for each." />}</section>}

        {mode === 'desktop' && (
          <Splitter
            label="Aielia column width"
            axis="x"
            grow={-1}
            className="email__split"
            measure={() => chatWidth}
            limits={() => ({ min: 260, max: Math.min(640, Math.max(260, width - 480)) })}
            onSize={(px) => setChatWidth(clampChat(px, width - 480))}
            onReset={() => setChatWidth(CHAT_DEFAULT)}
          />
        )}
        <aside
          className={`email__aielia${tablet ? ' is-slide' : ''}`}
          aria-label="Aielia"
          data-open={chatShown}
          hidden={!chatShown}
          style={mode === 'desktop' ? { width: chatWidth } : undefined}
        >
          {aielia}
        </aside>
      </div>
      {phone && <RailNav tabs={tabs} isOn={(id) => id === panel} onPick={(id) => setPanel(id as PhonePanel)} label="Email panels" className="email__tabs" />}
    </div>
  )
}
