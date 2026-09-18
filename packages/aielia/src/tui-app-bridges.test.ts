import { describe, it, expect, vi } from 'vitest'
import { EventLogBridge, PromptBridge, StatusBridge } from './tui-app.js'
import { PLAN_LINE_PREFIX } from './cli-icons.js'

// These exercise only the plain classes (no JSX ever evaluated, no Ink mounted) — like
// tui-input-layout.test.ts, importing them from a module that also imports 'ink' at the top is
// safe under root's blanket `npm test` because nothing here calls React.createElement or ink's
// render(); the React-19-vs-18 reconciler conflict Phase 2 hit only happens once a component is
// actually mounted (see tui-app.test.tsx, which is excluded from root's run for that reason).

describe('EventLogBridge', () => {
  it('starts with an empty snapshot', () => {
    const bridge = new EventLogBridge()
    expect(bridge.getSnapshot()).toEqual({ lines: [], progressText: '', transientText: '', waitingForOutput: false })
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
    expect(bridge.getSnapshot()).toEqual({ lines: [], progressText: '', transientText: '\nAielia> Hi there', waitingForOutput: false })
  })

  it('a line event with no pending transientText commits its lines directly, classified "tool" from the ⚙ prefix', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['  ⚙ Listing .'], stream: 'stdout' })
    expect(bridge.getSnapshot().lines).toEqual([{ text: '  ⚙ Listing .', kind: 'tool' }])
  })

  it('also classifies a ⚠-prefixed tool-step line (cli-icons.ts\'s toolStepIcon for a proposing tool like write_file/run_shell_command) as "tool", not "system"', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['  ⚠ Proposing to run: rm -rf /tmp/x'], stream: 'stdout' })
    expect(bridge.getSnapshot().lines).toEqual([{ text: '  ⚠ Proposing to run: rm -rf /tmp/x', kind: 'tool' }])
  })

  // Phase 6 of the CLI formatting plan ("distinct plan-mode UI") — cli.ts's printPlan() commits
  // one PLAN_LINE_PREFIX-marked block; unlike every other kind, it must survive as a single
  // un-split LogLine (marker stripped) so tui-app.tsx's PlanBox can wrap the whole multi-line
  // status in one bordered widget instead of one row at a time.
  it('a PLAN_LINE_PREFIX-marked line event commits as a single un-split "plan"-kind LogLine with the marker stripped', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({
      type: 'line',
      lines: [PLAN_LINE_PREFIX, 'Plan: project_planning (50.0% complete)', '  ✓ [COMPLETE] scope_definition — Define scope', 'Success criteria: Launch shipped'],
      stream: 'stdout',
    })
    expect(bridge.getSnapshot().lines).toEqual([
      {
        text: 'Plan: project_planning (50.0% complete)\n  ✓ [COMPLETE] scope_definition — Define scope\nSuccess criteria: Launch shipped',
        kind: 'plan',
      },
    ])
  })

  it('beginTurn() sets waitingForOutput, and the next handled event (of any type) clears it', () => {
    const bridge = new EventLogBridge()
    bridge.beginTurn()
    expect(bridge.getSnapshot().waitingForOutput).toBe(true)
    bridge.handleEvent({ type: 'progress', text: '[step 1/5] Gathering evidence…' })
    expect(bridge.getSnapshot().waitingForOutput).toBe(false)
  })

  it('merges pending transientText with a closing line event into committed lines, matching cli.ts\'s streamed-reply sequence, classified "assistant", with the "Aielia>" label (and its leading blank-line artifact) stripped from the displayed text', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'token', text: '\nAielia> ' })
    bridge.handleEvent({ type: 'token', text: 'Hi' })
    bridge.handleEvent({ type: 'line', lines: [' there!', ''], stream: 'stdout' })
    expect(bridge.getSnapshot()).toEqual({
      lines: [
        { text: 'Hi there!', kind: 'assistant' },
        { text: '', kind: 'assistant' },
        { text: '', kind: 'margin' },
      ],
      progressText: '',
      transientText: '',
      waitingForOutput: false,
    })
  })

  it('classifies a non-streaming "Aielia>"-prefixed console.log as "assistant" and strips the label, even with no pending transientText', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['', 'Aielia> Hello there', ''], stream: 'stdout' })
    expect(bridge.getSnapshot().lines).toEqual([
      { text: 'Hello there', kind: 'assistant' },
      { text: '', kind: 'assistant' },
      { text: '', kind: 'margin' },
    ])
  })

  it('an assistant reply gets a trailing blank margin line, and clears any stale progressText from before it finished', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'progress', text: '[step 3/5] Verification…' })
    bridge.handleEvent({ type: 'line', lines: ['Aielia> Done.'], stream: 'stdout' })
    expect(bridge.getSnapshot()).toEqual({
      lines: [
        { text: 'Done.', kind: 'assistant' },
        { text: '', kind: 'margin' },
      ],
      progressText: '',
      transientText: '',
      waitingForOutput: false,
    })
  })

  it('a tool-step line does not get a trailing margin (only a finished assistant reply does)', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['  ⚙ Listing .'], stream: 'stdout' })
    expect(bridge.getSnapshot().lines).toEqual([{ text: '  ⚙ Listing .', kind: 'tool' }])
  })

  it('classifies a stream: "stderr" line as "error" regardless of content', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['boom'], stream: 'stderr' })
    expect(bridge.getSnapshot().lines).toEqual([{ text: 'boom', kind: 'error' }])
  })

  it('classifies ordinary output (e.g. /help, banners) as "system"', () => {
    const bridge = new EventLogBridge()
    bridge.handleEvent({ type: 'line', lines: ['Type /help to see all commands.'], stream: 'stdout' })
    expect(bridge.getSnapshot().lines).toEqual([{ text: 'Type /help to see all commands.', kind: 'system' }])
  })

  it('pushEchoLine with an empty prefix (ordinary chat mode) appends the bare text, classified "user"', () => {
    const bridge = new EventLogBridge()
    bridge.pushEchoLine('', 'hello there')
    expect(bridge.getSnapshot().lines).toEqual([{ text: 'hello there', kind: 'user' }])
  })

  it('pushEchoLine with a "> " prefix (a resolved prompt answer) keeps that prefix', () => {
    const bridge = new EventLogBridge()
    bridge.pushEchoLine('> ', 'y')
    expect(bridge.getSnapshot().lines).toEqual([{ text: '> y', kind: 'user' }])
  })

  it('pushTurnMargin appends one blank "margin" line, is a no-op on an empty log, and never stacks two in a row', () => {
    const bridge = new EventLogBridge()
    bridge.pushTurnMargin()
    expect(bridge.getSnapshot().lines).toEqual([])
    bridge.pushEchoLine('', 'first')
    bridge.pushTurnMargin()
    bridge.pushTurnMargin()
    expect(bridge.getSnapshot().lines).toEqual([
      { text: 'first', kind: 'user' },
      { text: '', kind: 'margin' },
    ])
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

  it('askSelect parks a pending question alongside its option list, and resolves with whatever key submit() is called with (Phase 7)', async () => {
    const bridge = new PromptBridge()
    const options = [
      { key: 'y', label: 'Yes' },
      { key: 'a', label: "Yes, don't ask again this session" },
      { key: 'n', label: 'No' },
    ]
    const pending = bridge.askSelect('Proceed?', options)
    expect(bridge.getSnapshot()).toEqual({ question: 'Proceed?', options })
    bridge.submit('a')
    await expect(pending).resolves.toBe('a')
    expect(bridge.getSnapshot()).toBeUndefined()
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
