import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NextStepChips } from './NextStepChips'

const steps = [
  { description: 'add tests for the login page', rationale: 'tests were named as pending', confidence: 'high' as const },
  { description: 'wire it into the router', rationale: 'a common follow-up', confidence: 'medium' as const },
]

describe('NextStepChips', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<NextStepChips steps={[]} onPick={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one chip per option and says typing your own message also works', () => {
    render(<NextStepChips steps={steps} onPick={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'add tests for the login page' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'wire it into the router' })).toBeInTheDocument()
    expect(screen.getByText(/or just type your own/)).toBeInTheDocument()
  })

  it('picking a chip reports its text (the parent decides what to do — it never sends from here)', async () => {
    const onPick = vi.fn()
    render(<NextStepChips steps={steps} onPick={onPick} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'wire it into the router' }))
    expect(onPick).toHaveBeenCalledWith('wire it into the router')
  })
})
