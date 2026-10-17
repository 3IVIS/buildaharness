import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionSettings } from './ConnectionSettings'

describe('connection settings', () => {
  it('saves only when something changed and a key is present, and offers the optional page-reading fields', async () => {
    const onSave = vi.fn()
    render(<ConnectionSettings value={{ provider: 'anthropic', apiKey: 'k1' }} onSave={onSave} />)
    const save = screen.getByRole('button', { name: 'Save connection' })
    expect(save).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'openai')
    await userEvent.click(screen.getByText(/Reading web pages and finding sources/))
    await userEvent.type(screen.getByLabelText('Proxy address'), 'https://p.test')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    expect(onSave).toHaveBeenCalledWith({ provider: 'openai', apiKey: 'k1', pagesUrl: 'https://p.test' })
    expect(screen.queryByRole('button', { name: 'Forget these' })).toBeNull()
  })
  it('cannot save an empty key, and forgetting asks first', async () => {
    const onForget = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<ConnectionSettings value={{ provider: 'anthropic', apiKey: 'k1' }} onSave={vi.fn()} onForget={onForget} />)
    await userEvent.clear(screen.getByLabelText('API key'))
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Forget these' }))
    expect(onForget).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Forget these' }))
    expect(onForget).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })
})
