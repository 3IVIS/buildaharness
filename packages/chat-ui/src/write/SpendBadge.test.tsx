import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SpendBadge } from './SpendBadge'

describe('SpendBadge', () => {
  it('shows the total in the header, and where it went by kind of call when opened', async () => {
    const { rerender } = render(<SpendBadge usd={0.42} byType={[]} />)
    expect(screen.getByLabelText('Spent so far in this browser: $0.42')).toBeInTheDocument()
    rerender(<SpendBadge usd={0.42} byType={[{ id: 'chat', usd: 0.3, calls: 7 }, { id: 'support', usd: 0.12, calls: 1 }]} />)
    await userEvent.click(screen.getByLabelText(/Spent so far/))
    const list = screen.getByRole('list', { name: 'Spending by kind of call' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Chat$0.30 · 7 calls', 'Checking claims against sources$0.12 · 1 call'])
  })
  it('says app, not browser, on the desktop host', () => {
    render(<SpendBadge usd={0.42} byType={[]} hostName="app" />)
    expect(screen.getByLabelText('Spent so far in this app: $0.42')).toBeInTheDocument()
  })
})
