import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProxyNotice } from './ProxyNotice'

const env = (backend?: string): ImportMetaEnv => ({ VITE_ASSISTANT_WEB_BACKEND: backend }) as unknown as ImportMetaEnv

describe('ProxyNotice', () => {
  it('says what the proxy logs and links the terms on proxy builds', () => {
    render(<ProxyNotice env={env('proxy')} />)
    expect(screen.getByText(/never your IP or what you searched/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeTruthy()
  })
  it('renders nothing on builds that do not use the proxy', () => {
    const { container } = render(<ProxyNotice env={env('direct')} />)
    expect(container.textContent).toBe('')
  })
})
