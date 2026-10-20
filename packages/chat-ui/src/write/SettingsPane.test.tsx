import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPane } from './SettingsPane'

const base = { perms: { captureChat: true, autoCheck: false, recheckBeforePublish: true }, spent: 0.42, autoModel: 'small', chatModel: 'big', suggestions: [], onAutoModel: () => undefined, onSave: async () => undefined }

describe('SettingsPane spending', () => {
  it('shows the total, and where it went by kind of call once there is something to show', async () => {
    const { rerender } = render(<SettingsPane {...base} spentByType={[]} />)
    expect(screen.getByText(/Spent so far in this browser: \$0\.42/)).toBeInTheDocument()
    expect(screen.queryByText('Where it went')).toBeNull()
    rerender(<SettingsPane {...base} spentByType={[{ id: 'chat', usd: 0.3, calls: 7 }, { id: 'support', usd: 0.12, calls: 1 }]} />)
    await userEvent.click(screen.getByText('Where it went'))
    const list = screen.getByRole('list', { name: 'Spending by kind of call' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Chat$0.30 · 7 calls', 'Checking claims against sources$0.12 · 1 call'])
  })

  it('says app, not browser, on the desktop host', () => {
    render(<SettingsPane {...base} spentByType={[]} hostName="app" />)
    expect(screen.getByText(/Spent so far in this app: \$0\.42/)).toBeInTheDocument()
  })
  it('shows a GitHub token field only where Write keeps the token, and saves it when the field is left', async () => {
    const saved: (string | undefined)[] = []
    const { rerender } = render(<SettingsPane {...base} spentByType={[]} />)
    expect(screen.queryByLabelText('GitHub token')).toBeNull()
    rerender(<SettingsPane {...base} spentByType={[]} github={{ token: undefined, onSave: async (t) => { saved.push(t) } }} />)
    await userEvent.type(screen.getByLabelText('GitHub token'), 'ghp_abc')
    await userEvent.tab()
    expect(saved).toEqual(['ghp_abc'])
  })
})
