import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { SelectPrompt } from './ink-select-prompt.js'

// Same isolation reason as tui-input.test.tsx — see vite.config.ts's exclude comment for this file.

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

function strip(frame: string | undefined): string {
  return (frame ?? '').replace(ANSI, '')
}

function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

const OPTIONS = [
  { key: 'y', label: 'Yes' },
  { key: 'a', label: "Yes, don't ask again this session" },
  { key: 'n', label: 'No' },
]

describe('SelectPrompt', () => {
  it('renders the question and every option with its shortcut key, first option highlighted by default', async () => {
    const instance = render(<SelectPrompt question="Proceed?" options={OPTIONS} onSubmit={vi.fn()} />)
    await sleep()
    const frame = strip(instance.lastFrame())
    expect(frame).toContain('Proceed?')
    expect(frame).toContain('[y] Yes')
    expect(frame).toContain("[a] Yes, don't ask again this session")
    expect(frame).toContain('[n] No')
  })

  it('Enter submits the highlighted (first, by default) option', async () => {
    const onSubmit = vi.fn()
    render(<SelectPrompt question="Proceed?" options={OPTIONS} onSubmit={onSubmit} />)
    await sleep()
    const instance = instances[0]!
    await key(instance, ENTER)
    expect(onSubmit).toHaveBeenCalledWith('y')
  })

  it('down-arrow moves the highlight, and Enter then submits the newly-highlighted option', async () => {
    const onSubmit = vi.fn()
    const instance = render(<SelectPrompt question="Proceed?" options={OPTIONS} onSubmit={onSubmit} />)
    await sleep()
    await key(instance, DOWN)
    await key(instance, ENTER)
    expect(onSubmit).toHaveBeenCalledWith('a')
  })

  it('up-arrow from the first option wraps around to the last', async () => {
    const onSubmit = vi.fn()
    const instance = render(<SelectPrompt question="Proceed?" options={OPTIONS} onSubmit={onSubmit} />)
    await sleep()
    await key(instance, UP)
    await key(instance, ENTER)
    expect(onSubmit).toHaveBeenCalledWith('n')
  })

  it('a direct shortcut keystroke submits that option immediately, with no Enter needed', async () => {
    const onSubmit = vi.fn()
    const instance = render(<SelectPrompt question="Proceed?" options={OPTIONS} onSubmit={onSubmit} />)
    await sleep()
    await key(instance, 'n')
    expect(onSubmit).toHaveBeenCalledWith('n')
  })

  it('an unrecognized keystroke is ignored — no submit, no crash', async () => {
    const onSubmit = vi.fn()
    const instance = render(<SelectPrompt question="Proceed?" options={OPTIONS} onSubmit={onSubmit} />)
    await sleep()
    await key(instance, 'z')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
