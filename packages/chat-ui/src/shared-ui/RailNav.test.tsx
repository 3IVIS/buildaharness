import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RailNav } from './RailNav'

const tabs = [
  { id: 'inbox', label: 'Inbox', icon: 'M5 5h14', badge: 3, badgeLabel: '3 unread' },
  { id: 'rules', label: 'Rules', icon: 'M5 9h14' },
]

describe('RailNav', () => {
  it('shows the host tabs, marks the open one and a badge only when above zero', () => {
    render(<RailNav tabs={tabs} isOn={(id) => id === 'inbox'} onPick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Rules' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
  })
  it('reports the picked tab', () => {
    const onPick = vi.fn()
    render(<RailNav tabs={tabs} isOn={() => false} onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }))
    expect(onPick).toHaveBeenCalledWith('rules')
  })
})
