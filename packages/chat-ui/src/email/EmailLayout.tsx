import { useEffect, useState } from 'react'
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

/**
 * The Email page shell. Desktop: a folder rail (collapsed, opens on hover or click, can be pinned), the message list, the reader (beside or below the
 * list by room) and an always-on Aielia column on the right. Tablet: the same without the column, which is a slide-over, and folders as a slide-over.
 * Phone: one panel at a time (Email, To do, Aielia) with a bottom bar and a drawer for folders. Every panel stays mounted and is only hidden, so
 * the chat keeps its text when the user switches panels.
 */
export function EmailLayout({ folders, list, reader, aielia, todo, banner, mode: forced, readerOpen = false, railIcons, title, onBack }: Props): React.JSX.Element {
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
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT)

  const railOpen = mode === 'desktop' && (pinned || railHover || railClicked)
  const placement = readerPlacement(mode, width, chatWidth, pinned)
  const phone = mode === 'phone'
  const tablet = mode === 'tablet'
  const showEmail = !phone || panel === 'email'
  const showTodo = phone && panel === 'todo'
  const chatShown = mode === 'desktop' || (tablet && chatOpen) || (phone && panel === 'aielia')
  const foldersShown = mode === 'desktop' || drawer

  const tabs: RailTab[] = [
    { id: 'email', label: 'Email', icon: MAIL_ICONS.mail },
    { id: 'todo', label: 'To do', icon: MAIL_ICONS.todo },
    { id: 'aielia', label: 'Aielia', icon: MAIL_ICONS.chat },
  ]

  return (
    <div className={`email email--${mode}`} data-layout={mode} data-reader={placement} data-open={readerOpen}>
      {banner}
      {tablet && (
        <div className="email__bar">
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
            onMouseEnter={() => setRailHover(true)}
            onMouseLeave={() => { setRailHover(false); setRailClicked(false) }}
          >
            <div className="email__railbar">
              <button type="button" className="email__iconbtn" aria-label={railOpen ? 'Collapse folders' : 'Open folders'} title="Folders" aria-expanded={railOpen} onClick={() => setRailClicked((v) => !v)}><MailIcon name="menu" /></button>
              {railOpen && <button type="button" className="email__iconbtn" aria-label={pinned ? 'Unpin folders' : 'Pin folders open'} title={pinned ? 'Unpin folders' : 'Pin folders open'} aria-pressed={pinned} onClick={() => setPinned((v) => !v)}><MailIcon name="pin" /></button>}
            </div>
            {!railOpen && railIcons && <div className="email__railicons">{railIcons}</div>}
            <div className="email__tree" hidden={!railOpen}>{folders}</div>
          </aside>
        )}

        {phone && drawer && <div className="email__scrim" data-testid="scrim" onClick={() => setDrawer(false)} />}
        {mode !== 'desktop' && (
          <aside className="email__drawer" aria-label="Folders" data-open={drawer} hidden={!foldersShown}>
            <button type="button" className="email__iconbtn" aria-label="Close folders" onClick={() => setDrawer(false)}><MailIcon name="back" /></button>
            <div onClick={() => setDrawer(false)}>{folders}</div>
          </aside>
        )}

        <main className="email__mail" hidden={!showEmail} aria-label="Mail">
          {phone && (
            <div className="email__phonebar">
              {readerOpen
                ? <button type="button" className="email__iconbtn" aria-label="Back to the list" title="Back" onClick={onBack}><MailIcon name="back" /></button>
                : <button type="button" className="email__iconbtn email__foldersbtn" aria-label="Open folders" title="Folders" onClick={() => setDrawer(true)}><MailIcon name="menu" /></button>}
              <span className="email__bartitle" />
            </div>
          )}
          <div className="email__list" hidden={phone && readerOpen}>{list}</div>
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
