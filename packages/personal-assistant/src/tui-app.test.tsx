import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { TuiApp, EventLogBridge, PromptBridge, StatusBridge } from './tui-app.js'

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
    eventLog.handleEvent({ type: 'line', lines: ['backend: claude-cli (your Claude Code default)'] })
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

  it('Enter in chat mode echoes the line to scrollback and calls onSubmitChat', async () => {
    const onSubmitChat = vi.fn()
    const { instance } = setup({ onSubmitChat })
    await type(instance, 'hello')
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledWith('hello')
    expect(strip(instance.lastFrame())).toContain('you> hello')
  })

  it('a pending prompt switches the input to prompt mode and Enter resolves it via PromptBridge, echoing "> <answer>"', async () => {
    const { prompt, instance } = setup()
    const pending = prompt.askYesNo('Proceed? (y/N) ')
    await sleep()
    expect(strip(instance.lastFrame())).toContain('Proceed? (y/N)')
    await type(instance, 'y')
    await key(instance, ENTER)
    await expect(pending).resolves.toBe(true)
    expect(strip(instance.lastFrame())).toContain('> y')
  })

  it('Ctrl+C calls onExit', async () => {
    const onExit = vi.fn()
    const { instance } = setup({ onExit })
    await key(instance, CTRL_C)
    expect(onExit).toHaveBeenCalledOnce()
  })
})
