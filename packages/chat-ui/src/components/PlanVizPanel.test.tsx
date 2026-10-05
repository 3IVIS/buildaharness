import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanVizPanel } from './PlanVizPanel'
import { PlanApprovalCard } from './PlanApprovalCard'
import { appendixCPlan } from '../plan-viz/plan-viz-fixture'

const noop = (): void => undefined

async function mountPanel(snapshot = appendixCPlan().snapshot) {
  const utils = render(<PlanVizPanel snapshot={snapshot} fullscreen={false} onToggleFullscreen={noop} onClose={noop} />)
  const frame = (await waitFor(() => {
    const el = utils.container.querySelector('iframe')
    if (!el) throw new Error('iframe not mounted yet')
    return el
  })) as HTMLIFrameElement
  const posted = vi.fn()
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: posted }, configurable: true })
  return { ...utils, frame, posted }
}

afterEach(() => { vi.restoreAllMocks() })

describe('PlanVizPanel', () => {
  it('sandboxes the iframe with allow-scripts only and a self-contained srcdoc', async () => {
    const { frame } = await mountPanel()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    const doc = frame.getAttribute('srcdoc') ?? ''
    expect(doc).not.toMatch(/<script[^>]*\ssrc=/i)
    expect(doc).not.toContain('<!--PLAN_VIZ_D3-->')
    expect(doc).not.toContain('<!--PLAN_VIZ_DAGRE-->')
  })

  it('posts the snapshot on ready and on every prop change', async () => {
    const first = appendixCPlan().snapshot
    const { frame, posted, rerender } = await mountPanel(first)
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: frame.contentWindow })) })
    expect(posted).toHaveBeenCalledWith(first, '*')
    posted.mockClear()
    const next = { ...first, activity: 'Executing: T4' }
    rerender(<PlanVizPanel snapshot={next} fullscreen={false} onToggleFullscreen={noop} onClose={noop} />)
    expect(posted).toHaveBeenCalledWith(next, '*')
  })

  it('ignores messages from any other source', async () => {
    const { posted } = await mountPanel()
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: window })) })
    expect(posted).not.toHaveBeenCalled()
  })

  it('shows an empty state and disables export without a plan', async () => {
    render(<PlanVizPanel snapshot={null} fullscreen={false} onToggleFullscreen={noop} onClose={noop} />)
    expect(screen.getByText('No plan yet.')).toBeTruthy()
    expect((screen.getByText('Export HTML snapshot') as HTMLButtonElement).disabled).toBe(true)
  })

  it('export triggers a download with a Windows-safe filename', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    let name = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download })
    await mountPanel()
    fireEvent.click(screen.getByText('Export HTML snapshot'))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(name).toMatch(/^aielia-plan-[\dT-]+\.html$/)
    expect(name).not.toContain(':')
  })
})

describe('PlanApprovalCard graph preview link', () => {
  const planApproval = { templateName: 'T', successCriteria: 'ok', rationale: '', tasks: [{ id: 'a', description: 'Do a' }] }
  const handlers = { onApprove: vi.fn(), onApproveTrusted: vi.fn(), onApproveWithEdits: vi.fn(), onDecline: vi.fn() }

  it('renders no link unless onViewGraph is given (flag off)', () => {
    render(<PlanApprovalCard planApproval={planApproval} {...handlers} />)
    expect(screen.queryByText('View as graph')).toBeNull()
  })

  it('the link calls onViewGraph and leaves the approval controls alone', () => {
    const onViewGraph = vi.fn()
    render(<PlanApprovalCard planApproval={planApproval} {...handlers} onViewGraph={onViewGraph} />)
    fireEvent.click(screen.getByText('View as graph'))
    expect(onViewGraph).toHaveBeenCalledOnce()
    expect(handlers.onApprove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Approve'))
    expect(handlers.onApprove).toHaveBeenCalledOnce()
  })
})
