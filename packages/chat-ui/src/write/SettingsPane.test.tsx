import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPane } from './SettingsPane'

const base = { perms: { captureChat: true, autoCheck: false, recheckBeforePublish: true }, autoModel: 'small', chatModel: 'big', suggestions: [], onAutoModel: () => undefined, onSave: async () => undefined }

describe('SettingsPane', () => {
  it('shows a GitHub token field only where Write keeps the token, and saves it when the field is left', async () => {
    const saved: (string | undefined)[] = []
    const { rerender } = render(<SettingsPane {...base} />)
    expect(screen.queryByLabelText('GitHub token')).toBeNull()
    rerender(<SettingsPane {...base} github={{ token: undefined, onSave: async (t) => { saved.push(t) } }} />)
    await userEvent.type(screen.getByLabelText('GitHub token'), 'ghp_abc')
    await userEvent.tab()
    expect(saved).toEqual(['ghp_abc'])
  })
})
