import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { EmailLayout } from './EmailLayout'
import { layoutFor, readerPlacement, clampChat, CHAT_DEFAULT } from './email-layout'

afterEach(() => { cleanup() })

const parts = { folders: <p>FOLDERS</p>, list: <p>LIST</p>, reader: <p>READER</p>, aielia: <p>CHAT</p> }
const hiddenOf = (el: HTMLElement): boolean => !!el.closest('[hidden]')

describe('layout modes', () => {
  it('uses Write breakpoints', () => {
    expect(layoutFor(639)).toBe('phone')
    expect(layoutFor(640)).toBe('tablet')
    expect(layoutFor(959)).toBe('tablet')
    expect(layoutFor(960)).toBe('desktop')
  })
  it('puts the reader beside the list when there is room, below it when narrow, in place of it on a phone', () => {
    expect(readerPlacement('desktop', 1600, CHAT_DEFAULT, false)).toBe('beside')
    expect(readerPlacement('desktop', 1000, CHAT_DEFAULT, false)).toBe('below')
    expect(readerPlacement('desktop', 1250, CHAT_DEFAULT, true)).toBe('below')
    expect(readerPlacement('tablet', 800, CHAT_DEFAULT, false)).toBe('beside')
    expect(readerPlacement('tablet', 700, CHAT_DEFAULT, false)).toBe('below')
    expect(readerPlacement('phone', 400, CHAT_DEFAULT, false)).toBe('replace')
  })
  it('keeps the column width in its limits', () => {
    expect(clampChat(100)).toBe(260)
    expect(clampChat(9000)).toBe(640)
    expect(clampChat(500, 400)).toBe(400)
  })
})

describe('desktop', () => {
  it('shows a collapsed folder rail, the list, reader and the always-on Aielia column', () => {
    render(<EmailLayout mode="desktop" {...parts} />)
    expect(screen.getByRole('main').parentElement?.parentElement?.getAttribute('data-layout')).toBe('desktop')
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(true)
    expect(hiddenOf(screen.getByText('LIST'))).toBe(false)
    expect(hiddenOf(screen.getByText('READER'))).toBe(false)
    expect(hiddenOf(screen.getByText('CHAT'))).toBe(false)
    expect(screen.getByRole('separator', { name: 'Aielia column width' })).toBeTruthy()
  })
  it('opens the folder tree on hover or click and pins it', () => {
    render(<EmailLayout mode="desktop" {...parts} />)
    const rail = screen.getAllByLabelText('Folders').find((e) => e.tagName === 'ASIDE')!
    fireEvent.mouseEnter(rail)
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(false)
    fireEvent.click(screen.getByLabelText('Pin folders open'))
    fireEvent.mouseLeave(rail)
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(false)
    expect(rail.getAttribute('data-pinned')).toBe('true')
    fireEvent.click(screen.getByLabelText('Unpin folders'))
    expect(rail.getAttribute('data-pinned')).toBe('false')
    fireEvent.click(screen.getByLabelText('Open folders'))
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(false)
  })
  it('resizes the Aielia column with the keyboard', () => {
    render(<EmailLayout mode="desktop" {...parts} />)
    const col = screen.getByLabelText('Aielia', { selector: 'aside' })
    expect(col.style.width).toBe('340px')
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    expect(col.style.width).toBe('356px')
    fireEvent.doubleClick(screen.getByRole('separator'))
    expect(col.style.width).toBe('340px')
  })
})

describe('tablet', () => {
  it('has no column; folders and Aielia are slide-overs', () => {
    render(<EmailLayout mode="tablet" {...parts} />)
    expect(hiddenOf(screen.getByText('CHAT'))).toBe(true)
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(true)
    expect(hiddenOf(screen.getByText('LIST'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Aielia' }))
    expect(hiddenOf(screen.getByText('CHAT'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(false)
    fireEvent.click(screen.getByLabelText('Close folders'))
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(true)
  })
})

describe('phone', () => {
  it('shows the Inbox first, with a bottom bar of Email, To do and Aielia', () => {
    render(<EmailLayout mode="phone" {...parts} />)
    const bar = screen.getByRole('navigation', { name: 'Email panels' })
    expect(Array.from(bar.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(['Email', 'To do', 'Aielia'])
    expect(hiddenOf(screen.getByText('LIST'))).toBe(false)
    expect(hiddenOf(screen.getByText('CHAT'))).toBe(true)
  })
  it('switches panels and keeps the others mounted', () => {
    render(<EmailLayout mode="phone" {...parts} todo={<p>TODO</p>} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aielia' }))
    expect(hiddenOf(screen.getByText('CHAT'))).toBe(false)
    expect(hiddenOf(screen.getByText('LIST'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'To do' }))
    expect(screen.getByText('TODO')).toBeTruthy()
  })
  it('opens folders in a drawer that closes on the scrim', () => {
    render(<EmailLayout mode="phone" {...parts} />)
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(true)
    fireEvent.click(screen.getByLabelText('Open folders'))
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(false)
    fireEvent.click(screen.getByTestId('scrim'))
    expect(hiddenOf(screen.getByText('FOLDERS'))).toBe(true)
  })
  it('replaces the list with the reader when a message is open', () => {
    render(<EmailLayout mode="phone" {...parts} readerOpen />)
    expect(hiddenOf(screen.getByText('LIST'))).toBe(true)
    expect(hiddenOf(screen.getByText('READER'))).toBe(false)
  })
  it('reads the mode from matchMedia and a missing matchMedia is a phone', () => {
    const original = window.matchMedia
    render(<EmailLayout {...parts} />)
    expect(document.querySelector('.email')?.getAttribute('data-layout')).toBe('phone')
    cleanup()
    window.matchMedia = ((q: string) => ({ matches: Number(/min-width: (\d+)px/.exec(q)?.[1] ?? Infinity) <= 960, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    try {
      render(<EmailLayout {...parts} />)
      expect(document.querySelector('.email')?.getAttribute('data-layout')).toBe('desktop')
    } finally { window.matchMedia = original }
  })
})

describe('To do entry in the rail', () => {
  it('desktop: the rail has a To do entry with the open count; it swaps the middle for the list and a folder brings the mail back', () => {
    render(<EmailLayout mode="desktop" {...parts} todo={<p>TODO LIST</p>} todoCount={3} />)
    const entry = screen.getByRole('button', { name: 'To do, 3 open' })
    expect(screen.queryByText('TODO LIST')).toBeNull()
    fireEvent.click(entry)
    expect(screen.getByText('TODO LIST')).toBeTruthy()
    expect(hiddenOf(screen.getByText('LIST'))).toBe(true)
    fireEvent.click(entry)
    expect(screen.queryByText('TODO LIST')).toBeNull()
  })
  it('desktop: no count shown when nothing is open, and the label stays plain', () => {
    render(<EmailLayout mode="desktop" {...parts} todo={<p>TODO LIST</p>} />)
    expect(screen.getByRole('button', { name: 'To do' })).toBeTruthy()
  })
  it('tablet: the entry is in the folder drawer', () => {
    render(<EmailLayout mode="tablet" {...parts} todo={<p>TODO LIST</p>} todoCount={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
    fireEvent.click(screen.getByRole('button', { name: 'To do, 2 open' }))
    expect(screen.getByText('TODO LIST')).toBeTruthy()
  })
  it('phone: the bottom tab carries the count', () => {
    render(<EmailLayout mode="phone" {...parts} todo={<p>TODO LIST</p>} todoCount={4} />)
    expect(screen.getByRole('button', { name: /To do \(4\)/ })).toBeTruthy()
  })
})
