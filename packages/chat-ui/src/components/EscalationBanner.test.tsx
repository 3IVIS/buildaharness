import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EscalationBanner } from './EscalationBanner'

describe('EscalationBanner', () => {
  it('renders no retry button when onRetry is omitted', () => {
    render(<EscalationBanner reason="risk classification failed" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('calls onRetry when the retry button is clicked', async () => {
    const onRetry = vi.fn()
    render(<EscalationBanner reason="risk classification failed" onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
