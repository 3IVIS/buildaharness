import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AssistantTrace, AssistantTurnResult } from '@buildaharness/personal-assistant'
import { ChatMessageBubble } from './ChatMessageBubble'

function makeTrace(overrides: Partial<AssistantTrace> = {}): AssistantTrace {
  return {
    nodeExecutionOrder: ['select_task', 'execute', 'verify'],
    verificationHealth: { strength: 0.9, feasibility: 0.9 },
    layerActivity: [],
    ...overrides,
  }
}

describe('ChatMessageBubble', () => {
  it('shows a short-code chain of only the layers that fired, inside Why?', async () => {
    const trace = makeTrace({
      layerActivity: [
        { layer: 'world_model', fired: true, reason: 'Remembered: user prefers dark mode' },
        { layer: 'hypothesis', fired: false, reason: 'single clear LOW-risk task — no competing explanation worth surfacing' },
        { layer: 'contradiction', fired: false, reason: 'fewer than 2 beliefs — nothing to compare' },
      ],
    })
    render(<ChatMessageBubble role="assistant" content="Done." trace={trace} />)

    await userEvent.click(screen.getByRole('button', { name: 'Why?' }))

    expect(screen.getByText('WM')).toBeInTheDocument()
    expect(screen.getByText('WM').closest('span')).toHaveAttribute('title', 'World Model')
    expect(screen.getByText(/Remembered: user prefers dark mode/)).toBeInTheDocument()
    // A skipped layer must not appear in the chain at all — only fired ones.
    expect(screen.queryByText('HY')).not.toBeInTheDocument()
    expect(screen.queryByText('CT')).not.toBeInTheDocument()
  })

  it('collapses the same layer firing on back-to-back loop iterations into one chain link', async () => {
    const trace = makeTrace({
      layerActivity: [
        { layer: 'evidence_reasoning', fired: true, reason: 'gathered file contents' },
        { layer: 'evidence_reasoning', fired: true, reason: 'gathered web result' },
        { layer: 'verification', fired: true, reason: 'checks passed' },
      ],
    })
    render(<ChatMessageBubble role="assistant" content="Done." trace={trace} />)

    await userEvent.click(screen.getByRole('button', { name: 'Why?' }))

    expect(screen.getAllByText('EV')).toHaveLength(1)
    expect(screen.getByText(/gathered file contents/)).toBeInTheDocument()
    expect(screen.queryByText(/gathered web result/)).not.toBeInTheDocument()
    expect(screen.getByText('VF')).toBeInTheDocument()
  })

  it('shows no chain when nothing fired', async () => {
    const trace = makeTrace({
      layerActivity: [
        { layer: 'hypothesis', fired: false, reason: 'single clear LOW-risk task' },
      ],
    })
    render(<ChatMessageBubble role="assistant" content="Done." trace={trace} />)

    await userEvent.click(screen.getByRole('button', { name: 'Why?' }))

    expect(screen.queryByText('HY')).not.toBeInTheDocument()
  })

  it('Run detail shows all 11 layers, fired ones distinguished from skipped ones', async () => {
    const trace = makeTrace({
      layerActivity: [
        { layer: 'world_model', fired: true, reason: 'Remembered a fact' },
        { layer: 'control_state', fired: false, reason: 'NORMAL' },
      ],
    })
    render(<ChatMessageBubble role="assistant" content="Done." trace={trace} />)

    await userEvent.click(screen.getByRole('button', { name: 'Run detail ▾' }))

    // 11 short-code cells, one per harness layer.
    expect(screen.getByTitle(/World Model: Remembered a fact/)).toHaveClass('bubble__layer-cell--fired')
    expect(screen.getByTitle(/Control State: NORMAL/)).toHaveClass('bubble__layer-cell--disabled')
    expect(screen.getByTitle(/Reviewer Pass: not evaluated this turn/)).toHaveClass('bubble__layer-cell--disabled')
  })

  it('Run detail renders the plan checklist with the active step visually distinct', async () => {
    const planStatus: AssistantTurnResult['planStatus'] = {
      templateName: 'project_planning',
      successCriteria: 'Ship it',
      completionPct: 33.3,
      tasks: [
        { id: 't1', description: 'Gather requirements', status: 'COMPLETE' },
        { id: 't2', description: 'Build the thing', status: 'RUNNING' },
        { id: 't3', description: 'Ship it', status: 'PENDING' },
      ],
    }
    render(<ChatMessageBubble role="assistant" content="Working on it." planStatus={planStatus} />)

    await userEvent.click(screen.getByRole('button', { name: 'Run detail ▾' }))

    const activeItem = screen.getByText(/Build the thing/)
    expect(activeItem.closest('li')).toHaveClass('bubble__plan-checklist-item--active')
    expect(screen.getByText(/Gather requirements/).closest('li')).not.toHaveClass('bubble__plan-checklist-item--active')
  })

  it('renders no Run detail toggle when there is neither a trace nor a plan', () => {
    render(<ChatMessageBubble role="assistant" content="Hi." />)
    expect(screen.queryByRole('button', { name: /Run detail/ })).not.toBeInTheDocument()
  })
})
