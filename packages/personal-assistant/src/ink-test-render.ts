import { EventEmitter } from 'node:events'
import { render as inkRender, type Instance as InkAppInstance } from 'ink'
import type { ReactElement } from 'react'

/**
 * Test-only render harness for Ink components, used by `tui-input.test.tsx`. Functionally the
 * same technique as the `ink-testing-library` package (synthetic EventEmitter-backed
 * stdin/stdout fed straight to `ink`'s own `render()`), reimplemented locally rather than taken
 * as a dependency: `ink-testing-library` declares no real dependency on `ink`/`react` at all (it
 * expects them resolvable from its own install location), which in this monorepo doesn't hold —
 * `ink`/`react` are deliberately nested under this package only (see this package's own
 * `package.json`; the rest of the repo pins React 18, `ink` needs React >=19.2), so a hoisted
 * `ink-testing-library` at the workspace root fails to resolve its `import ... from 'ink'` at
 * runtime (`ERR_MODULE_NOT_FOUND`). Since `ink` itself lives right here, importing it directly —
 * as this file does — has no such problem.
 */

// Matches a bare ANSI CSI control sequence (cursor show/hide, bracketed-paste-mode toggle, ...).
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g

class TestStdout extends EventEmitter {
  columns = 100
  // Ink's resolveInteractiveOption() falls back to `Boolean(stdout.isTTY)` when no explicit
  // `interactive` option is passed; without this, ink treats the render as non-interactive,
  // which skips real input wiring and overwrites the last frame with a bare '\n' on unmount.
  isTTY = true
  frames: string[] = []
  private lastFrameValue: string | undefined
  write = (frame: string): void => {
    this.frames.push(frame)
    // ink also writes standalone control sequences outside the render path — e.g. the
    // bracketed-paste-mode toggle when usePaste mounts, or cli-cursor's show-cursor escape on
    // unmount. Those aren't a rendered frame; skip them so lastFrame() keeps the last real one.
    if (frame.replace(ANSI_CSI, '') === '') return
    this.lastFrameValue = frame
  }
  lastFrame = (): string | undefined => this.lastFrameValue
}

class TestStderr extends EventEmitter {
  write = (): void => {}
}

class TestStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write = (chunk: string): void => {
    this.data = chunk
    this.emit('readable')
    this.emit('data', chunk)
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const value = this.data
    this.data = null
    return value
  }
}

export interface TestInkInstance {
  stdin: TestStdin
  lastFrame: () => string | undefined
  rerender: (tree: ReactElement) => void
  unmount: () => void
}

export function renderInk(tree: ReactElement): TestInkInstance {
  const stdout = new TestStdout()
  const stderr = new TestStderr()
  const stdin = new TestStdin()
  const instance: InkAppInstance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    stdin,
    lastFrame: stdout.lastFrame,
    rerender: instance.rerender,
    unmount: instance.unmount,
  }
}
