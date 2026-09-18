import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { TuiApp, EventLogBridge, PromptBridge, StatusBridge } from './tui-app.js'
import { PLAN_LINE_PREFIX } from './cli-icons.js'

// Full-mount smoke tests for the composed Ink shell (Phase 3). Excluded from root's blanket
// `npm test` in vite.config.ts for the exact same reason tui-input.test.tsx already is — see
// that file's exclude comment and ink-test-render.ts's header comment: mounting a real `ink`
// component means React elements created against this package's nested React 19 hit ink's own
// React-19 reconciler, which root's shared jsdom/React-18 environment can't satisfy.

const ENTER = '\r'
const CTRL_C = ''
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

function strip(frame: string | undefined): string {
  return (frame ?? '').replace(ANSI, '')
}

function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Same one-write-per-keystroke pacing tui-input.test.tsx uses — a real terminal never delivers
// several characters in one stdin `data` event for ordinary typing.
async function type(instance: TestInkInstance, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch)
    await sleep()
  }
}

async function key(instance: TestInkInstance, sequence: string): Promise<void> {
  instance.stdin.write(sequence)
  await sleep()
}

const instances: TestInkInstance[] = []

function render(tree: Parameters<typeof renderInk>[0]): TestInkInstance {
  const instance = renderInk(tree)
  instances.push(instance)
  return instance
}

afterEach(() => {
  instances.forEach((i) => i.unmount())
  instances.length = 0
})

function setup(overrides: { onSubmitChat?: (line: string) => void; onExit?: () => void } = {}) {
  const eventLog = new EventLogBridge()
  const prompt = new PromptBridge()
  const status = new StatusBridge()
  const onSubmitChat = overrides.onSubmitChat ?? vi.fn()
  const onExit = overrides.onExit ?? vi.fn()
  const instance = render(
    <TuiApp eventLog={eventLog} prompt={prompt} status={status} onSubmitChat={onSubmitChat} onExit={onExit} columns={40} />,
  )
  return { eventLog, prompt, status, onSubmitChat, onExit, instance }
}

describe('TuiApp', () => {
  it('renders committed scrollback lines pushed to the event log', async () => {
    const { eventLog, instance } = setup()
    eventLog.handleEvent({ type: 'line', lines: ['backend: claude-cli (your Claude Code default)'], stream: 'stdout' })
    await sleep()
    // <Static> content is written once, incrementally, and never appears in a later lastFrame()
    // (the redrawn dynamic region only) — see fullOutput()'s doc comment in ink-test-render.ts.
    expect(strip(instance.fullOutput())).toContain('backend: claude-cli')
  })

  it('renders the transient progress line and streamed token text below the scrollback', async () => {
    const { eventLog, instance } = setup()
    eventLog.handleEvent({ type: 'progress', text: '[step 1/5] Gathering evidence…' })
    eventLog.handleEvent({ type: 'token', text: '\nAielia> partial reply' })
    await sleep()
    const frame = strip(instance.lastFrame())
    expect(frame).toContain('[step 1/5] Gathering evidence…')
    expect(frame).toContain('partial reply')
  })

  it('renders a full-width separator row above the input box', () => {
    const { instance } = setup()
    expect(strip(instance.lastFrame())).toContain('─'.repeat(40))
  })

  it('renders the status line with indicators from the status bridge', async () => {
    const { status, instance } = setup()
    status.set(['Plan mode: active'])
    await sleep()
    expect(strip(instance.lastFrame())).toContain('Plan mode: active')
  })

  it('Enter in chat mode echoes the line to scrollback (no "you>" label) and calls onSubmitChat', async () => {
    const onSubmitChat = vi.fn()
    const { eventLog, instance } = setup({ onSubmitChat })
    await type(instance, 'hello')
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledWith('hello')
    expect(strip(instance.fullOutput())).toContain('hello')
    expect(eventLog.getSnapshot().lines.some((l) => l.kind === 'user' && l.text === 'hello')).toBe(true)
  })

  it('a pending prompt switches the input to prompt mode and Enter resolves it via PromptBridge, echoing "> <question> → <answer>" (Phase 2 persistent approval record)', async () => {
    const { prompt, instance } = setup()
    const pending = prompt.askYesNo('Proceed? (y/N) ')
    await sleep()
    expect(strip(instance.lastFrame())).toContain('Proceed? (y/N)')
    await type(instance, 'y')
    await key(instance, ENTER)
    await expect(pending).resolves.toBe(true)
    expect(strip(instance.lastFrame())).toContain('> Proceed? (y/N) → y')
  })

  it('a pending askSelect prompt (Phase 7) switches the input to the SelectPrompt selector instead of TuiInput, and a shortcut keystroke resolves it, echoing the chosen option\'s label', async () => {
    const { prompt, instance } = setup()
    const options = [
      { key: 'y', label: 'Yes' },
      { key: 'a', label: "Yes, don't ask again this session" },
      { key: 'n', label: 'No' },
    ]
    const pending = prompt.askSelect('Proceed?', options)
    await sleep()
    const frame = strip(instance.lastFrame())
    expect(frame).toContain('Proceed?')
    expect(frame).toContain('[y] Yes')
    expect(frame).toContain("[a] Yes, don't ask again this session")
    expect(frame).toContain('[n] No')
    await key(instance, 'a')
    await expect(pending).resolves.toBe('a')
    // The echoed answer is the option's label, not its raw key ("a") — but at columns=40 the
    // combined "> Proceed? → Yes, don't ask again this session" line word-wraps inside its
    // bordered box, so check the un-wrapped prefix and the label's own text rather than the
    // full line as one unbroken substring.
    const echoed = strip(instance.lastFrame())
    expect(echoed).toContain('> Proceed? → Yes')
    expect(echoed).toContain("don't ask again")
    expect(echoed).toContain('this session')
  })

  it('Ctrl+C calls onExit', async () => {
    const onExit = vi.fn()
    const { instance } = setup({ onExit })
    await key(instance, CTRL_C)
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('a chat turn gets blank margins on both sides of its echo, but a resolved prompt answer does not', async () => {
    const { eventLog, prompt, instance } = setup()
    await type(instance, 'first')
    await key(instance, ENTER)
    const pending = prompt.askYesNo('Proceed? (y/N) ')
    await sleep()
    await type(instance, 'y')
    await key(instance, ENTER)
    await pending
    await type(instance, 'second')
    await key(instance, ENTER)
    await sleep()
    const lines = eventLog.getSnapshot().lines
    // 'first' (margin after), '> Proceed? (y/N) → y' (no margins — grouped with the chat turn
    // above it, and now carries the question text too — Phase 2), then 'second's own
    // margin-before collapses into the same one (pushTurnMargin is a no-op when the last line is
    // already a margin), margin after.
    expect(lines.map((l) => l.text)).toEqual(['first', '', '> Proceed? (y/N) → y', '', 'second', ''])
    // The resolved prompt answer is 'approval', not 'user' — its own box color (see tui-app.tsx's
    // LogLineText), distinct from the two real chat lines around it.
    expect(lines.map((l) => l.kind)).toEqual(['user', 'margin', 'approval', 'margin', 'user', 'margin'])
  })

  it('renders both a stderr line and an ordinary stdout line into scrollback (kind-to-color mapping itself is unit-tested in tui-app-bridges.test.ts\'s classifyLineKind coverage; this fake TestStdout reports no color support, so ANSI codes aren\'t observable here)', async () => {
    const { eventLog, instance } = setup()
    eventLog.handleEvent({ type: 'line', lines: ['a normal banner line'], stream: 'stdout' })
    eventLog.handleEvent({ type: 'line', lines: ['something went wrong'], stream: 'stderr' })
    await sleep()
    const raw = strip(instance.fullOutput())
    expect(raw).toContain('a normal banner line')
    expect(raw).toContain('something went wrong')
  })

  it('renders basic markdown in assistant reply lines — headers, checkboxes, bold — instead of the literal source characters (report finding: "## Checklist" and "- [ ]" printed literally)', async () => {
    const { eventLog, instance } = setup()
    eventLog.handleEvent({ type: 'token', text: '\nAielia> ' })
    eventLog.handleEvent({
      type: 'line',
      lines: ['## Checklist', '- [ ] Buy milk', '- [x] Done thing', '**important**'],
      stream: 'stdout',
    })
    await sleep()
    const raw = strip(instance.fullOutput())
    expect(raw).not.toContain('## Checklist')
    expect(raw).toContain('Checklist')
    expect(raw).not.toContain('- [ ] Buy milk')
    expect(raw).toContain('☐ Buy milk')
    expect(raw).toContain('☑ Done thing')
    expect(raw).not.toContain('**important**')
    expect(raw).toContain('important')
  })

  it('renders a PLAN_LINE_PREFIX-marked block as a bordered PlanBox with the marker stripped (Phase 6, "distinct plan-mode UI")', async () => {
    const { eventLog, instance } = setup()
    eventLog.handleEvent({
      type: 'line',
      lines: [PLAN_LINE_PREFIX, 'Plan: project_planning (50.0% complete)', '  ✓ [COMPLETE] scope_definition — Define scope'],
      stream: 'stdout',
    })
    await sleep()
    const raw = strip(instance.fullOutput())
    expect(raw).not.toContain(PLAN_LINE_PREFIX)
    expect(raw).toContain('Plan: project_planning')
    expect(raw).toContain('scope_definition')
    // A bordered Box renders round-corner border characters — confirms this went through
    // PlanBox, not plain <Text>, the same way UserMessageBox's own border is the observable
    // signal that a line got boxed rather than printed flat.
    expect(raw).toContain('╭')
  })

  it('shows a "Thinking…" spinner between submitting a chat line and the first output event, and hides it once output arrives (report finding: nothing shows in that gap today)', async () => {
    const { eventLog, instance } = setup()
    await type(instance, 'hi')
    await key(instance, ENTER)
    await sleep()
    expect(strip(instance.lastFrame())).toContain('Thinking…')
    eventLog.handleEvent({ type: 'progress', text: '[step 1/5] Gathering evidence…' })
    await sleep()
    expect(strip(instance.lastFrame())).not.toContain('Thinking…')
  })
})
