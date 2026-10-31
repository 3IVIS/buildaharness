import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryArticleStore, resolveConfig } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'

const platform = vi.fn()
vi.mock('./desktop-platform', () => ({ desktopWritePlatform: (...a: unknown[]) => platform(...a) }))

const config = resolveConfig({ llmBackend: 'anthropic', apiKey: 'k' }).config
const llm = { callChatStructured: async () => ({ content: '' }), callChatSync: async () => '', callChat: async function* () { /* none */ } } as unknown as ILLMClient

afterEach(() => { cleanup(); platform.mockReset() })

describe('Write opened from the desktop app', () => {
  it('builds Write from the desktop platform with the app config, shows the page, and goes back to the chat', async () => {
    platform.mockResolvedValue({ store: createMemoryArticleStore(), llm, hostName: 'app' })
    const { default: WriteHost } = await import('./WriteHost')
    const onClose = vi.fn()
    render(<WriteHost config={config} onClose={onClose} />)
    expect(await screen.findByRole('heading', { name: 'Aielia Write' })).toBeInTheDocument()
    expect(platform).toHaveBeenCalledWith(config)
    // Once Write is open, the way back is the Chat/Write drop-down in its title.
    expect(screen.queryByRole('button', { name: '← Back to chat' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Write/ }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Aielia Chat/ }))
    expect(onClose).toHaveBeenCalled()
  })
  it('says why when the desktop platform cannot start, and still offers the way back', async () => {
    platform.mockRejectedValue(new Error('no plugin'))
    const { default: WriteHost } = await import('./WriteHost')
    render(<WriteHost config={config} onClose={() => undefined} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Write could not start: no plugin')
    expect(screen.getByRole('button', { name: '← Back to chat' })).toBeInTheDocument()
  })
})
