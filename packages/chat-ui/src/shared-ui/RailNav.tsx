import { Icon } from './icons'

export interface RailTab {
  id: string
  label: string
  /** Path data for the icon. */
  icon: string
  /** A count shown on the tab when above zero (Write's open issues, Email's unread). */
  badge?: number
  badgeLabel?: string
}

interface Props {
  tabs: readonly RailTab[]
  isOn: (id: string) => boolean
  onPick: (id: string) => void
  /** What a screen reader calls the bar. */
  label?: string
  /** The class of the nav element; the stylesheet of the host draws it as a side rail or a phone's bottom bar. */
  className?: string
  badgeClassName?: string
}

/** The row of panel tabs: a side rail on a wide screen and a bottom bar on a phone. The tabs, icons and badges come from the host. */
export function RailNav({ tabs, isOn, onPick, label = 'Panels', className = 'write__rail', badgeClassName = 'write__railbadge' }: Props): React.JSX.Element {
  return (
    <nav className={className} aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" data-tab={t.id} className={isOn(t.id) ? 'is-on' : ''} aria-pressed={isOn(t.id)} aria-label={t.label} onClick={() => onPick(t.id)}>
          <Icon d={t.icon} size={22} />
          <span>{t.label}</span>
          {t.badge !== undefined && t.badge > 0 && <span className={badgeClassName} aria-label={t.badgeLabel ?? `${t.badge}`}>{t.badge}</span>}
        </button>
      ))}
    </nav>
  )
}
