import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderInk, type TestInkInstance } from './ink-test-render.js'
import { TuiInput } from './tui-input.js'

const UP = '[A'
const DOWN = '[B'
const LEFT = '[D'
const RIGHT = '[C'
const HOME = '[H'
const END = '[F'
const BACKSPACE = ''
const ENTER = '\r'
const PASTE_START = '[200~'
const PASTE_END = '[201~'
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

function strip(frame: string | undefined): string {
  return (frame ?? '').replace(ANSI, '')
}

function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Real terminal input arrives as one small stdin `data` event per keystroke, never a whole
 * string in one chunk — sending multiple characters in a single `stdin.write()` call would
 * exercise ink's own paste-ambiguity buffering path (see `hasPendingEscape`/
 * `schedulePendingInputFlush` in ink's `App.js`) instead of ordinary typing. This mirrors real
 * pacing: one `write()` per character, yielding a macrotask between each so ink's internal
 * readable-stream handling (and the `useEffect` that attaches it) has settled before the next
 * keystroke arrives — the same reason two back-to-back synchronous `write()` calls with no
 * yield are unreliable here even for plain single-char keys.
 */
async function type(instance: TestInkInstance, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch)
    await sleep()
  }
}

/** One control sequence (arrow key, Enter, a complete bracketed paste, ...) as a single stdin write, then a tick to let it land. */
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

describe('TuiInput — chat mode basics', () => {
  it('renders the default chat label and an empty box', () => {
    const instance = render(<TuiInput onSubmitChat={vi.fn()} onSubmitPrompt={vi.fn()} columns={40} />)
    const frame = strip(instance.lastFrame())
    expect(frame).toContain('you')
  })

  it('typed characters are inserted at the cursor and appear in the frame', async () => {
    const instance = render(<TuiInput onSubmitChat={vi.fn()} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'hi')
    expect(strip(instance.lastFrame())).toContain('hi')
  })

  it('Enter submits a non-empty draft via onSubmitChat and clears the box', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'hello')
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledOnce()
    expect(onSubmitChat).toHaveBeenCalledWith('hello')
    expect(strip(instance.lastFrame())).not.toContain('hello')
  })

  it('Enter on an empty draft does not submit', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await key(instance, ENTER)
    expect(onSubmitChat).not.toHaveBeenCalled()
  })

  it('a trailing backslash before Enter inserts a literal newline instead of submitting', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'line1\\')
    await key(instance, ENTER)
    await type(instance, 'line2')
    expect(onSubmitChat).not.toHaveBeenCalled()
    const frame = strip(instance.lastFrame())
    expect(frame).toContain('line1')
    expect(frame).toContain('line2')
    // Now a real Enter (no trailing backslash) submits the whole multi-line draft as one call.
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledOnce()
    expect(onSubmitChat).toHaveBeenCalledWith('line1\nline2')
  })

  it('backspace removes the character before the cursor', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'hix')
    await key(instance, BACKSPACE)
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledOnce()
    expect(onSubmitChat).toHaveBeenCalledWith('hi')
  })

  it('left/right arrows move the cursor so a mid-string insert lands in the right place', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'ac')
    await key(instance, LEFT)
    await type(instance, 'b')
    await key(instance, RIGHT)
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledOnce()
    expect(onSubmitChat).toHaveBeenCalledWith('abc')
  })

  it('Home/End jump to the start/end of the current logical line', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'bcd')
    await key(instance, HOME)
    await type(instance, 'a')
    await key(instance, END)
    await type(instance, 'e')
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledOnce()
    expect(onSubmitChat).toHaveBeenCalledWith('abcde')
  })
})

describe('TuiInput — paste', () => {
  it('a multi-line bracketed paste inserts literal newlines without submitting', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await key(instance, `${PASTE_START}pasted one\npasted two${PASTE_END}`)
    expect(onSubmitChat).not.toHaveBeenCalled()
    const frame = strip(instance.lastFrame())
    expect(frame).toContain('pasted one')
    expect(frame).toContain('pasted two')
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledOnce()
    expect(onSubmitChat).toHaveBeenCalledWith('pasted one\npasted two')
  })
})

describe('TuiInput — 5-row overflow', () => {
  it('caps the rendered box at 5 rows and scrolls to keep the cursor visible', async () => {
    const instance = render(<TuiInput onSubmitChat={vi.fn()} onSubmitPrompt={vi.fn()} columns={40} />)
    const lines = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG']
    for (let i = 0; i < lines.length; i++) {
      await type(instance, lines[i]!)
      if (i < lines.length - 1) {
        await type(instance, '\\')
        await key(instance, ENTER)
      }
    }
    const frame = strip(instance.lastFrame())
    // Scrolled past the top: the first two lines are out of the 5-row viewport.
    expect(frame).not.toContain('AAA')
    expect(frame).not.toContain('BBB')
    // The cursor's line (the last one typed) stays visible, along with the rest of the window.
    expect(frame).toContain('CCC')
    expect(frame).toContain('GGG')
  })
})

describe('TuiInput — command history recall', () => {
  it('Up/Down cycle through previously submitted lines when the cursor is on the first/last row', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'first message')
    await key(instance, ENTER)
    await type(instance, 'second message')
    await key(instance, ENTER)

    await key(instance, UP)
    expect(strip(instance.lastFrame())).toContain('second message')

    await key(instance, UP)
    expect(strip(instance.lastFrame())).toContain('first message')

    await key(instance, DOWN)
    expect(strip(instance.lastFrame())).toContain('second message')

    await key(instance, DOWN)
    expect(strip(instance.lastFrame())).not.toContain('second message')
  })

  it('falls through to in-draft cursor movement instead of history recall when the cursor is mid-draft', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'older message')
    await key(instance, ENTER)

    await type(instance, 'line1\\')
    await key(instance, ENTER)
    await type(instance, 'line2')
    // Cursor is on the second (last) visual row — Up should move within the draft, not recall.
    await key(instance, UP)
    expect(strip(instance.lastFrame())).not.toContain('older message')
    expect(strip(instance.lastFrame())).toContain('line1')
    expect(strip(instance.lastFrame())).toContain('line2')

    // Move back down and submit — confirms the draft survived the Up/Down round-trip intact.
    await key(instance, DOWN)
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenCalledWith('line1\nline2')
  })

  it('editing a recalled entry and submitting appends a new history entry rather than mutating the recalled one', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'original')
    await key(instance, ENTER)

    await key(instance, UP)
    await type(instance, '!')
    await key(instance, ENTER)
    expect(onSubmitChat).toHaveBeenNthCalledWith(2, 'original!')

    // The original entry is unchanged in history — recalling it again shows 'original', not 'original!'.
    await key(instance, UP)
    await key(instance, UP)
    expect(strip(instance.lastFrame())).toContain('original')
    expect(strip(instance.lastFrame())).not.toContain('original!')
  })
})

describe('TuiInput — prompt mode', () => {
  it('switches the label to the question text and resolves via onSubmitPrompt instead of dispatching a chat line', async () => {
    const onSubmitChat = vi.fn()
    const onSubmitPrompt = vi.fn()
    const instance = render(
      <TuiInput promptLabel="Proceed? (y/N)" onSubmitChat={onSubmitChat} onSubmitPrompt={onSubmitPrompt} columns={40} />,
    )
    expect(strip(instance.lastFrame())).toContain('Proceed? (y/N)')
    await type(instance, 'y')
    await key(instance, ENTER)
    expect(onSubmitPrompt).toHaveBeenCalledOnce()
    expect(onSubmitPrompt).toHaveBeenCalledWith('y')
    expect(onSubmitChat).not.toHaveBeenCalled()
  })

  it('does not add prompt-mode answers to chat history, even once back in chat mode', async () => {
    const onSubmitChat = vi.fn()
    const instance = render(<TuiInput promptLabel="Confirm?" onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'yes')
    await key(instance, ENTER)

    // Back to chat mode (e.g. the prompt this answer resolved has been dismissed).
    instance.rerender(<TuiInput onSubmitChat={onSubmitChat} onSubmitPrompt={vi.fn()} columns={40} />)
    await type(instance, 'hello')
    await key(instance, ENTER)

    await key(instance, UP)
    expect(strip(instance.lastFrame())).toContain('hello')
    await key(instance, UP)
    expect(strip(instance.lastFrame())).not.toContain('yes')
  })
})
