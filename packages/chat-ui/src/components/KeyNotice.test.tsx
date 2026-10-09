import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeyNotice } from './KeyNotice'

describe('KeyNotice', () => {
  it('says a key is needed and names the providers', () => {
    render(<KeyNotice onAddKey={() => {}} />)
    expect(screen.getByText(/Bring your own AI key to chat/i)).toBeTruthy()
    expect(screen.getByText(/Anthropic, OpenAI or OpenRouter/)).toBeTruthy()
  })
  it('opens key setup when the button is pressed', () => {
    const onAddKey = vi.fn()
    render(<KeyNotice onAddKey={onAddKey} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add your key' }))
    expect(onAddKey).toHaveBeenCalledTimes(1)
  })
})
