import { useEffect, useState } from 'react'
import { RailNav, type RailTab } from '../shared-ui/RailNav'
import { Splitter } from '../shared-ui/Splitter'
import { CHAT_DEFAULT, clampChat, layoutNow, readerPlacement, type LayoutMode, type PhonePanel } from './email-layout'
import './email.css'

const MAIL = 'M3 6h18v12H3zM3 7l9 7 9-7'
const TODO = 'M5 12l4 4 10-10M5 5h4'
const CHAT = 'M4 5h16v11H9l-5 4z'

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
}

/**
 * The Email page shell. Desktop: a folder rail (collapsed, opens on hover or click, can be pinned), the message list, the reader (beside or below the
 * list by room) and an always-on Aielia column on the right. Tablet: the same without the column, which is a slide-over, and folders as a slide-over.
 * Phone: one panel at a time (Email, To do, Aielia) with a bottom bar and a drawer for folders. Every panel stays mounted and is only hidden, so
 * the chat keeps its text when the user switches panels.
 */
export function EmailLayout({ folders, list, reader, aielia, todo, banner, mode: forced, readerOpen = false }: Props): React.JSX.Element {
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
    { id: 'email', label: 'Email', icon: MAIL },
    { id: 'todo', label: 'To do', icon: TODO },
    { id: 'aielia', label: 'Aielia', icon: CHAT },
  ]

  return (
    <div className={`email email--${mode}`} data-layout={mode} data-reader={placement}>
      {banner}
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
              <button type="button" aria-label={railOpen ? 'Collapse folders' : 'Open folders'} aria-expanded={railOpen} onClick={() => setRailClicked((v) => !v)}>Folders</button>
              {railOpen && <button type="button" aria-label={pinned ? 'Unpin folders' : 'Pin folders open'} aria-pressed={pinned} onClick={() => setPinned((v) => !v)}>{pinned ? 'Unpin' : 'Pin'}</button>}
            </div>
            <div className="email__tree" hidden={!railOpen}>{folders}</div>
          </aside>
        )}

        {!phone && !(mode === 'desktop') && (
          <div className="email__bar">
            <button type="button" aria-label="Folders" aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}>Folders</button>
            <button type="button" aria-label="Aielia" aria-expanded={chatOpen} onClick={() => setChatOpen((v) => !v)}>Aielia</button>
          </div>
        )}
        {phone && drawer && <div className="email__scrim" data-testid="scrim" onClick={() => setDrawer(false)} />}
        {mode !== 'desktop' && (
          <aside className="email__drawer" aria-label="Folders" data-open={drawer} hidden={!foldersShown}>
            <button type="button" aria-label="Close folders" onClick={() => setDrawer(false)}>Close</button>
            <div onClick={() => setDrawer(false)}>{folders}</div>
          </aside>
        )}

        <main className="email__mail" hidden={!showEmail} aria-label="Mail">
          {phone && <button type="button" className="email__foldersbtn" aria-label="Open folders" onClick={() => setDrawer(true)}>Folders</button>}
          <div className="email__list" hidden={phone && readerOpen}>{list}</div>
          <div className="email__reader" hidden={phone && !readerOpen}>{reader}</div>
        </main>

        {showTodo && <section className="email__todo" aria-label="To do">{todo ?? <p>Nothing to do yet.</p>}</section>}

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
