import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GoalGraphState } from '@buildaharness/aielia'
import { GoalsPanel } from './GoalsPanel'

describe('GoalsPanel', () => {
  it("lists a DONE thread's suggested next steps under it, with their confidence", () => {
    const state: GoalGraphState = {
      activeThreadId: null,
      threads: [
        {
          id: 't1',
          status: 'DONE',
          visibility: 'done',
          successCriteria: 'Ship the launch.',
          tasks: { total: 2, complete: 2, failed: 0, pending: 0 },
          isActive: false,
          suggestions: [{ description: 'announce it to the team', rationale: 'launch is done', confidence: 'high' }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    }
    render(<GoalsPanel state={state} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('Suggested next steps')).toHaveTextContent('announce it to the team')
    expect(screen.getByText('high')).toBeInTheDocument()
  })

  it('shows a loading state while state is null', () => {
    render(<GoalsPanel state={null} onCancel={vi.fn()} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows an explicit empty state for a loaded graph with no threads', () => {
    const state: GoalGraphState = { activeThreadId: null, threads: [] }
    render(<GoalsPanel state={state} onCancel={vi.fn()} />)
    expect(screen.getByText('No goal threads yet.')).toBeInTheDocument()
  })

  it('renders each thread with status, success criteria, visibility label, and task counts', () => {
    const state: GoalGraphState = {
      activeThreadId: 't1',
      threads: [
        {
          id: 't1',
          status: 'ACTIVE',
          visibility: 'carried_over',
          successCriteria: 'Ship the launch.',
          tasks: { total: 3, complete: 1, failed: 0, pending: 2 },
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    }
    render(<GoalsPanel state={state} onCancel={vi.fn()} />)
    expect(screen.getByText('ACTIVE', { selector: '.goals-panel__status' })).toBeInTheDocument()
    expect(screen.getByText('ACTIVE', { selector: '.goals-panel__active-badge' })).toBeInTheDocument()
    expect(screen.getByText('Ship the launch.')).toBeInTheDocument()
    expect(screen.getByText('Carried over')).toBeInTheDocument()
    expect(screen.getByText(/1\/3 complete/)).toBeInTheDocument()
  })

  it('distinguishes all four R5 visibility buckets in the rendered output', () => {
    const base = { tasks: { total: 0, complete: 0, failed: 0, pending: 0 }, isActive: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const state: GoalGraphState = {
      activeThreadId: null,
      threads: [
        { id: 't-fresh', status: 'READY', visibility: 'freshly_computed', successCriteria: 'Fresh', ...base },
        { id: 't-carried', status: 'READY', visibility: 'carried_over', successCriteria: 'Carried', ...base },
        { id: 't-done', status: 'DONE', visibility: 'done', successCriteria: 'Done goal', ...base },
        { id: 't-suggested', status: 'READY', visibility: 'suggested_not_committed', successCriteria: 'Suggested', ...base },
      ],
    }
    render(<GoalsPanel state={state} onCancel={vi.fn()} />)
    expect(screen.getByText('Freshly computed')).toBeInTheDocument()
    expect(screen.getByText('Carried over')).toBeInTheDocument()
    expect(screen.getByText('Done', { selector: '.goals-panel__visibility' })).toBeInTheDocument()
    expect(screen.getByText('Suggested, not committed')).toBeInTheDocument()
  })

  it('clicking Back invokes onCancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<GoalsPanel state={{ activeThreadId: null, threads: [] }} onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
