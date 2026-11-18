import { Icon } from '../shared-ui/icons'
import type { Folder, Message } from '@buildaharness/aielia'

/** Icon paths for the mail screens, in the same 24-px outline style as the shared icons. */
export const MAIL_ICONS = {
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  sent: 'M21 4L3 11l7 3 3 7zM10 14l11-10',
  drafts: 'M5 3h10l4 4v14H5zM14 3v5h5M8 13h8M8 17h5',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  custom: 'M3 6h6l2 2h10v11H3z',
  todo: 'M5 12l4 4 10-10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  chat: 'M4 5h16v11H9l-5 4z',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z',
  send: 'M5 12h14M13 6l6 6-6 6',
  attach: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7',
  back: 'M15 5l-7 7 7 7',
} as const

export function MailIcon({ name, size = 18 }: { name: keyof typeof MAIL_ICONS; size?: number }): React.JSX.Element {
  return <Icon d={MAIL_ICONS[name]} size={size} />
}

/** A round initial for the sender; the colour comes from the address, so one sender always looks the same. */
export function Avatar({ name, address, size = 36 }: { name?: string; address: string; size?: number }): React.JSX.Element {
  const label = (name?.trim() || address).replace(/^[^\p{L}\p{N}]+/u, '')
  const initial = (label[0] ?? '?').toUpperCase()
  let h = 0
  for (const c of address.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.42, ['--avatar-hue' as string]: h }}>{initial}</span>
  )
}

/** Today: the time. This year: day and month. Older: with the year. */
export function mailTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The first words of the plain-text body, on one line, for the second line of a row. */
export function mailSnippet(m: Pick<Message, 'textBody'>, max = 110): string {
  const t = m.textBody.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The folders as a list: an icon, the name and the unread count. */
export function FolderList({ folders, activeId, onSelect, compact }: { folders: readonly Folder[]; activeId?: string; onSelect?: (id: string) => void; /** Icons only (the collapsed rail). */ compact?: boolean }): React.JSX.Element {
  const order = ['inbox', 'drafts', 'sent', 'archive', 'trash', 'custom']
  const sorted = [...folders].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  return (
    <nav aria-label={compact ? 'Folder icons' : 'Folder list'} className={`folders${compact ? ' folders--compact' : ''}`}>
      <ul>
        {sorted.map((f) => (
          <li key={f.id}>
            <button type="button" className={`folders__item${f.id === activeId ? ' is-on' : ''}`} aria-current={f.id === activeId ? 'true' : undefined} title={f.name} onClick={() => onSelect?.(f.id)}>
              <MailIcon name={f.kind} />
              <span className="folders__name">{f.name}</span>
              {f.unreadCount > 0 && <span className="folders__count">{f.unreadCount}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
