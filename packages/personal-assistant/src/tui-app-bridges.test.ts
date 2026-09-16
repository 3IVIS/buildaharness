import { describe, it, expect, vi } from 'vitest'
import { EventLogBridge, PromptBridge, StatusBridge } from './tui-app.js'

// These exercise only the plain classes (no JSX ever evaluated, no Ink mounted) — like
// tui-input-layout.test.ts, importing them from a module that also imports 'ink' at the top is
// safe under root's blanket `npm test` because nothing here calls React.createElement or ink's
// render(); the React-19-vs-18 reconciler conflict Phase 2 hit only happens once a component is
// actually mounted (see tui-app.test.tsx, which is excluded from root's run for that reason).

describe('EventLogBridge', () => {
  it('starts with an empty snapshot', () => {
    const bridge = new EventLogBridge()
    expect(bridge.getSnapshot()).toEqual({ lines: [], progressText: '', transientText: '' })
  })

  it('notifies subscribers and updates progressText on a progress event', () => {
    const bridge = new EventLogBridge()
    const listener = vi.fn()
    bridge.subscribe(listener)
    bridge.handleEvent({ type: 'progress', text: '[step 1/5] Gathering evidence…' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(bridge.getSnapshot().progressText).toBe('[step 1/5] Gathering evidence…')
  })

  it('clears progressText on the empty progress event clearProgress() produces', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'progress', text: 'working…' })
    bridge.handleEvent({ type: 'progress', text: '' })
    expect(bridge.getSnapshot().progressText).toBe('')
  })

  it('accumulates token events into transientText without touching lines', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'token', text: '\nAielia> ' })
    bridge.handleEvent({ type: 'token', text: 'Hi' })
    bridge.handleEvent({ type: 'token', text: ' there' })
    expect(bridge.getSnapshot()).toEqual({ lines: [], progressText: '', transientText: '\nAielia> Hi there' })
  })

  it('a line event with no pending transientText commits its lines directly', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['  ⚙ Listing .'] })
    expect(bridge.getSnapshot().lines).toEqual(['  ⚙ Listing .'])
  })

  it('merges pending transientText with a closing line event into committed lines, matching cli.ts\'s streamed-reply sequence', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'token', text: '\nAielia> ' })
    bridge.handleEvent({ type: 'token', text: 'Hi' })
    bridge.handleEvent({ type: 'line', lines: [' there!', ''] })
    expect(bridge.getSnapshot()).toEqual({ lines: ['', 'Aielia> Hi there!', ''], progressText: '', transientText: '' })
  })

  it('pushEchoLine appends a prefixed line to permanent scrollback', () => {
    const bridge = new EventLogBridge()
    bridge.pushEchoLine('you> ', 'hello there')
    expect(bridge.getSnapshot().lines).toEqual(['you> hello there'])
  })

  it('unsubscribe stops further notifications', () => {
    const bridge = new EventLogBridge()
    const listener = vi.fn()
    const unsubscribe = bridge.subscribe(listener)
    unsubscribe()
    bridge.handleEvent({ type: 'progress', text: 'x' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('PromptBridge', () => {
  it('askYesNo parks a pending question and resolves true for a "y"-prefixed answer', async () => {
    const bridge = new PromptBridge()
    const pending = bridge.askYesNo('Proceed? (y/N) ')
    expect(bridge.getSnapshot()).toEqual({ question: 'Proceed? (y/N) ' })
    bridge.submit('yes')
    await expect(pending).resolves.toBe(true)
    expect(bridge.getSnapshot()).toBeUndefined()
  })

  it('askYesNo resolves false for anything not starting with y (case-insensitive, trimmed)', async () => {
    const bridge = new PromptBridge()
    const pending = bridge.askYesNo('Proceed? (y/N) ')
    bridge.submit('  No  ')
    await expect(pending).resolves.toBe(false)
  })

  it('askLine resolves with the trimmed-by-caller answer verbatim (no y/n parsing)', async () => {
    const bridge = new PromptBridge()
    const pending = bridge.askLine('clarify> ')
    bridge.submit('option 2')
    await expect(pending).resolves.toBe('option 2')
  })

  it('notifies subscribers on both ask and submit', () => {
    const bridge = new PromptBridge()
    const listener = vi.fn()
    bridge.subscribe(listener)
    void bridge.askLine('Note: ')
    expect(listener).toHaveBeenCalledTimes(1)
    bridge.submit('a note')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('StatusBridge', () => {
  it('starts empty', () => {
    expect(new StatusBridge().getSnapshot()).toEqual([])
  })

  it('set() replaces the indicator list and notifies subscribers', () => {
    const bridge = new StatusBridge()
    const listener = vi.fn()
    bridge.subscribe(listener)
    bridge.set(['Plan mode: active', 'session: $0.42 / $5.00'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(bridge.getSnapshot()).toEqual(['Plan mode: active', 'session: $0.42 / $5.00'])
  })
})
