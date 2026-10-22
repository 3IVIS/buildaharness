import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPane } from './SettingsPane'
import { activityLog } from './activity-test-log'

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

describe('SettingsPane: how Write has been used', () => {
  it('shows the figures kept on this device, and nothing when no log is given', async () => {
    const log = await activityLog([{ at: '2026-10-22T10:00:00.000Z', kind: 'edit', outcome: 'done', ms: 5000, usd: 0.02, calls: 2 }])
    const { rerender } = render(<SettingsPane perms={{ captureChat: true, recheckBeforePublish: true, autoCheck: false }} autoModel="a" chatModel="b" suggestions={[]} onAutoModel={() => undefined} onSave={async () => undefined} activity={log} />)
    expect((await screen.findByLabelText('Your use of Write')).textContent).toContain('edit: 1 run (1 finished, 0 stopped, 0 failed)')
    rerender(<SettingsPane perms={{ captureChat: true, recheckBeforePublish: true, autoCheck: false }} autoModel="a" chatModel="b" suggestions={[]} onAutoModel={() => undefined} onSave={async () => undefined} />)
    expect(screen.queryByLabelText('Your use of Write')).toBeNull()
  })
})
