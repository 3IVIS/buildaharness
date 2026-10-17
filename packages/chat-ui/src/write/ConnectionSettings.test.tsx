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
    await userEvent.click(screen.getByText(/Web pages and sources/))
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
  it('offers a self-hosted proxy: it needs an address, not a key', async () => {
    const onSave = vi.fn()
    render(<ConnectionSettings value={{ provider: 'anthropic', apiKey: 'k1' }} onSave={onSave} />)
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'proxy')
    const save = screen.getByRole('button', { name: 'Save connection' })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Model proxy address'), 'http://localhost:8787')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    expect(onSave).toHaveBeenCalledWith({ provider: 'proxy', apiKey: 'k1', modelUrl: 'http://localhost:8787' })
  })
  it('leaves out the page-reading and search fields on the first visit', () => {
    render(<ConnectionSettings value={{ provider: 'anthropic', apiKey: '' }} onSave={vi.fn()} showWeb={false} />)
    expect(screen.queryByText(/Web pages and sources/)).toBeNull()
    expect(screen.queryByLabelText('Proxy address')).toBeNull()
  })
})
