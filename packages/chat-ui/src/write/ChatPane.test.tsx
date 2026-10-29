import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NAME_CLOSE, NAME_OPEN } from '@buildaharness/aielia'
import { ChatPane, RECORD_HINT, type WorkProgress } from './ChatPane'

const base = { lines: [], model: 'm', suggestions: [], onModel: () => undefined, input: '', onInput: () => undefined, mode: 'edit' as const, onMode: () => undefined, editLabel: 'Edit', busy: true, canAct: true, shown: true, onSend: () => undefined, onAdjust: () => undefined, onAction: () => undefined, repos: [], onRepoVerify: () => undefined, onRemoveRepo: () => undefined, onDropFiles: () => undefined, onClose: () => undefined }

describe('ChatPane work ticker', () => {
  const progress: WorkProgress = { kind: 'edit', label: 'Editing', stage: 1, detail: 'one more moment', startedAt: Date.now() }
  it('says the stage, the finer step and a checklist with the earlier steps done', () => {
    render(<ChatPane {...base} progress={progress} />)
    expect(screen.getByText('Noting what you said…')).toBeInTheDocument()
    expect(screen.getByText('one more moment')).toBeInTheDocument()
    const steps = screen.getByLabelText('Steps').querySelectorAll('li')
    expect([...steps].map((l) => l.className)).toEqual(['is-done', 'is-current', 'is-waiting', 'is-waiting', 'is-waiting'])
  })
  it('is gone when the work is over', () => {
    render(<ChatPane {...base} progress={null} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByLabelText('Steps')).toBeNull()
  })
  it('shows the count, the words of an answer as they come, and Stop; and a finished job shows Done', async () => {
    let stopped = 0
    const { rerender } = render(<ChatPane {...base} onStop={() => { stopped++ }} progress={{ ...progress, kind: 'verify', stage: 2, count: [4, 11], streamed: 'The answer so f' }} />)
    expect(screen.getByText('4 of 11 done')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4')
    expect(screen.getByText('The answer so f')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Stop' }).click()
    expect(stopped).toBe(1)
    rerender(<ChatPane {...base} onStop={() => undefined} progress={{ ...progress, kind: 'verify', finishing: true }} />)
    expect(screen.getByText('Done.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect([...screen.getByLabelText('Steps').querySelectorAll('li')].every((l) => l.className === 'is-done')).toBe(true)
  })
})

describe('ChatPane: records of interface actions', () => {
  it('draws a record apart from a chat message and says on hover what it is', () => {
    render(<ChatPane {...base} lines={[{ id: 1, from: 'you', text: 'Check the claims', record: true }, { id: 2, from: 'aielia', text: 'Check: done.', record: true }, { id: 3, from: 'you', text: 'Is it clear?' }, { id: 4, from: 'aielia', text: 'Yes.', model: 'm' }]} progress={null} />)
    for (const t of ['Check the claims', 'Check: done.']) {
      const li = screen.getByText(t).closest('li')!
      expect(li).toHaveClass('write__line--record')
      expect(li).toHaveAttribute('title', RECORD_HINT)
    }
    for (const t of ['Is it clear?', 'Yes.']) {
      const li = screen.getByText(t).closest('li')!
      expect(li).not.toHaveClass('write__line--record')
      expect(li).not.toHaveAttribute('title')
    }
  })
})

describe('ChatPane: claims settling during a check', () => {
  it('lists the newest results under the bar', () => {
    render(<ChatPane {...base} progress={{ kind: 'verify', label: 'Verifying', stage: 2, startedAt: Date.now(), count: [2, 5], results: [{ text: 'Backed: The p99 was 18 ms.', tone: 'good' }, { text: 'No source found: Latency halved.', tone: 'warn' }] }} />)
    const list = screen.getByLabelText('Checked so far')
    expect([...list.querySelectorAll('li')].map((l) => [l.textContent, l.className])).toEqual([['Backed: The p99 was 18 ms.', 'is-good'], ['No source found: Latency halved.', 'is-warn']])
  })
})

describe('ChatPane: the usual time', () => {
  it('says how long this kind of job usually takes, and not once it is finishing', () => {
    const p = { kind: 'edit' as const, label: 'Editing', stage: 2, startedAt: Date.now(), usually: 'Usually about 20 s' }
    const { rerender } = render(<ChatPane {...base} progress={p} />)
    expect(screen.getByText('Usually about 20 s')).toBeInTheDocument()
    rerender(<ChatPane {...base} progress={{ ...p, finishing: true }} />)
    expect(screen.queryByText('Usually about 20 s')).toBeNull()
  })
})

describe('the mode box hint', () => {
  it('says that choosing another mode turns automatic detection off, and in a manual mode that it is off', () => {
    const { rerender } = render(<ChatPane {...base} mode="auto" progress={null} />)
    expect(screen.getByLabelText('When I ask for a change')).toHaveAttribute('title', expect.stringMatching(/Choosing any other mode turns this automatic detection off until you change it back to Auto/))
    rerender(<ChatPane {...base} mode="answer" progress={null} />)
    expect(screen.getByLabelText('When I ask for a change')).toHaveAttribute('title', expect.stringMatching(/Automatic detection is off.*Choose Auto/))
  })
})

describe('chat lines', () => {
  it('shows section names in their own element, with a label on summary lines, and no quotation marks', () => {
    const text = `Made 2 changes.\n• Outline: added ${NAME_OPEN}Story${NAME_CLOSE}; removed ${NAME_OPEN}Close${NAME_CLOSE}.\n• Reworded: ${NAME_OPEN}Intro${NAME_CLOSE}.\nUndo from History.`
    const { container } = render(<ChatPane {...base} lines={[{ id: 1, from: 'aielia', text, model: 'm' }]} progress={null} />)
    expect([...container.querySelectorAll('.write__name')].map((n) => n.textContent)).toEqual(['Story', 'Close', 'Intro'])
    expect([...container.querySelectorAll('.write__lab')].map((n) => n.textContent)).toEqual(['Outline:', 'Reworded:'])
    expect(container.querySelectorAll('.write__ln')).toHaveLength(4)
    expect(container.textContent).not.toMatch(/[“”]/)
    expect(container.textContent).not.toContain(NAME_OPEN)
  })
})

describe('usage line', () => {
  it('says how much of the input came from the cache, only when that is known', async () => {
    const { usageText } = await import('./WriteApp')
    expect(usageText(2000, { usd: 0.01, inputTokens: 1000, outputTokens: 50, calls: 2, cachedTokens: 600 })).toContain('1,000 in, 60% of it cached, 50 out')
    expect(usageText(2000, { usd: 0.01, inputTokens: 1000, outputTokens: 50, calls: 2 })).toContain('1,000 in, 50 out')
  })
})
