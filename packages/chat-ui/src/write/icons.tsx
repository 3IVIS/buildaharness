export const ICON_PATHS = {
  view: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  compare: 'M7 7h11l-3-3M17 17H6l3 3',
  restore: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  published: 'M5 21V4M5 4h12l-2 4 2 4H5',
  saved: 'M6 3h12v18l-6-4-6 4z',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7M8 21v-6h8',
  check: 'M5 12l5 5L20 7',
  close: 'M6 6l12 12M18 6L6 18',
  folder: 'M3 6h6l2 2h10v11H3z',
  grow: 'M12 4v16M12 4l-4 4M12 4l4 4M12 20l-4-4M12 20l4-4',
  shrink: 'M12 9v6M12 9L8 5M12 9l4-4M12 15l-4 4M12 15l4 4',
  lines: 'M4 7h16M4 12h9M4 17h16',
  write: 'M5 12h14M13 6l6 6-6 6',
  attach: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7',
  comment: 'M4 5h16v11H9l-5 4z',
  source: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6',
  check2: 'M4 12l4 4 6-8M12 16l2 2 6-9',
}

export function Icon({ d, size = 18 }: { d: string; size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A small icon-only button. The label is what a screen reader says and what the tooltip shows. */
export function IconButton({ label, icon, onClick, disabled, className }: { label: string; icon: keyof typeof ICON_PATHS; onClick: () => void; disabled?: boolean; className?: string }): React.JSX.Element {
  return (
    <button type="button" className={`write__iconbtn${className ? ` ${className}` : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon d={ICON_PATHS[icon]} />
    </button>
  )
}
