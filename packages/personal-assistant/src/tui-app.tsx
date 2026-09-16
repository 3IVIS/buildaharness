import { Readable, Writable } from 'node:stream'
import { useCallback, useSyncExternalStore } from 'react'
import { Box, Static, Text, render as inkRender, useInput, useWindowSize } from 'ink'
import { runCli, type CliInstance, type RunCliOptions } from './cli.js'
import { startCapture, type CaptureEvent } from './tui-output-capture.js'
import { TuiInput } from './tui-input.js'

/**
 * A minimal pub/sub store, one per piece of state the Ink tree needs — deliberately not React
 * state, because the values that drive it arrive from outside React entirely: `startCapture`
 * (Phase 1) calls its `onEvent` callback synchronously from a monkey-patched `console.log`/
 * `process.stdout.write`, and `askYesNo`/`askLine` (Decision 1's override seam) are plain
 * functions handed to `runCli()` before any component has mounted. `useSyncExternalStore` is the
 * React-correct way to subscribe a component to state that's mutated from outside React's own
 * render cycle, without the chicken-and-egg problem of needing a `setState` that only exists
 * after the first render.
 */
interface Store<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}

function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export interface TuiLogState {
  /** Every permanently-committed scrollback line, oldest first — fed straight into `<Static>`. */
  lines: string[]
  /** `writeProgress`'s current `\r`-overwritten line — shown in the transient region, never committed. */
  progressText: string
  /** `writeToken`'s not-yet-newline-terminated streamed reply text — shown in the transient region until the next committed-line event closes it out. */
  transientText: string
}

const EMPTY_LOG: TuiLogState = { lines: [], progressText: '', transientText: '' }

/**
 * Classifies and accumulates `CaptureEvent`s (Phase 1) into the three regions Phase 3's layout
 * needs: permanent scrollback, the transient progress line, and the transient in-progress
 * streamed reply. A `'line'` event closes out whatever streamed-token text is currently pending
 * (see `cli.ts`'s `writeToken`/`handleTurn`: a streamed reply is one or more raw `'token'` writes
 * followed by exactly one final `'line'` write for the trailing hint text) — merging the two
 * before committing is what turns "Hi the|re!\n\n" (streamed "Hi the" + committed "re!\n\n") into
 * one correct committed line instead of two garbled ones.
 */
export class EventLogBridge implements Store<TuiLogState> {
  private lines: string[] = []
  private progressText = ''
  private transientText = ''
  private snapshot: TuiLogState = EMPTY_LOG
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): TuiLogState => this.snapshot

  private commit(): void {
    this.snapshot = { lines: this.lines, progressText: this.progressText, transientText: this.transientText }
    for (const listener of this.listeners) listener()
  }

  /** Records a line the user just submitted (chat or a resolved prompt answer) into permanent scrollback — mirrors a real terminal's own line-echo, which the inert (non-TTY) input stream this shell uses never produces on its own. */
  pushEchoLine(prefix: string, text: string): void {
    this.lines = [...this.lines, `${prefix}${text}`]
    this.commit()
  }

  handleEvent(event: CaptureEvent): void {
    if (event.type === 'progress') {
      this.progressText = event.text
      this.commit()
      return
    }
    if (event.type === 'token') {
      this.transientText += event.text
      this.commit()
      return
    }
    const merged = this.transientText + event.lines.join('\n')
    this.lines = [...this.lines, ...merged.split('\n')]
    this.transientText = ''
    this.commit()
  }
}

export type PendingPrompt = { question: string } | undefined

/**
 * Bridges `runCli()`'s `askYesNo`/`askLine` override seam (Decision 1) to Ink: each call parks
 * a resolver and exposes the pending question to the component tree via `getSnapshot()`, instead
 * of the original `rl.question`-based implementation. `TuiInput`'s own `promptLabel` prop
 * (Phase 2) already knows how to render this state and route Enter to `onSubmitPrompt` instead
 * of `onSubmitChat` — this class only needs to supply the question text and resolve the answer.
 */
export class PromptBridge implements Store<PendingPrompt> {
  private pending: PendingPrompt
  private resolve: ((answer: string) => void) | undefined
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PendingPrompt => this.pending

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.pending = { question }
      this.resolve = resolve
      for (const listener of this.listeners) listener()
    })
  }

  /** Matches `RunCliOptions.askYesNo`'s exact parsing convention (`answer.trim().toLowerCase().startsWith('y')`) — same fail-closed shape, just answered via the Ink prompt instead of `rl.question`. */
  askYesNo = (question: string): Promise<boolean> => this.ask(question).then((answer) => answer.trim().toLowerCase().startsWith('y'))

  askLine = (question: string): Promise<string> => this.ask(question)

  submit(answer: string): void {
    const resolve = this.resolve
    this.pending = undefined
    this.resolve = undefined
    for (const listener of this.listeners) listener()
    resolve?.(answer)
  }
}

/** The status line's short indicator list (Phase 3 step 5) — polled from `CliInstance.getStatusIndicators()` after every dispatched line, since plan/spend-cap state only changes as a side effect of a turn. */
export class StatusBridge implements Store<string[]> {
  private indicators: string[] = []
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): string[] => this.indicators

  set(indicators: string[]): void {
    this.indicators = indicators
    for (const listener of this.listeners) listener()
  }
}

export interface TuiAppProps {
  eventLog: EventLogBridge
  prompt: PromptBridge
  status: StatusBridge
  onSubmitChat: (line: string) => void
  onExit: () => void
  /** Overrides the live terminal width for tests — same seam `TuiInput` already accepts. */
  columns?: number
}

/**
 * The top-level Ink app (Phase 3): a `<Static>` scrollback of every committed line, a transient
 * region for the in-progress progress line/streamed reply, a one-row separator, the Phase 2
 * multiline input box pinned to the bottom, and a reserved status line under that. Composition
 * only — command parsing/dispatch stays entirely inside `cli.ts`'s `dispatchLine()` (Decision 1),
 * and this component never re-implements it.
 */
export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { eventLog, prompt, status, onSubmitChat, onExit, columns } = props
  const log = useStore(eventLog)
  const pending = useStore(prompt)
  const statusIndicators = useStore(status)
  const windowSize = useWindowSize()
  const width = columns ?? windowSize.columns

  // Always active, regardless of chat-vs-prompt mode — Ctrl+C must exit either way, unlike
  // TuiInput's own useInput, which deliberately ignores every ctrl/meta/tab/escape key (its
  // job is draft editing, not process control).
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onExit()
  })

  const handleSubmitChat = useCallback(
    (line: string) => {
      eventLog.pushEchoLine('you> ', line)
      onSubmitChat(line)
    },
    [eventLog, onSubmitChat],
  )

  const handleSubmitPrompt = useCallback(
    (line: string) => {
      eventLog.pushEchoLine('> ', line)
      prompt.submit(line)
    },
    [eventLog, prompt],
  )

  const hasTransient = log.progressText.length > 0 || log.transientText.length > 0

  return (
    <Box flexDirection="column">
      <Static items={log.lines}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      {hasTransient && (
        <Box flexDirection="column">
          {log.progressText.length > 0 && <Text dimColor>{log.progressText}</Text>}
          {log.transientText.length > 0 && <Text>{log.transientText}</Text>}
        </Box>
      )}
      <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
      <TuiInput
        promptLabel={pending?.question}
        onSubmitChat={handleSubmitChat}
        onSubmitPrompt={handleSubmitPrompt}
        columns={columns}
      />
      <Text dimColor>{statusIndicators.join('   ')}</Text>
    </Box>
  )
}

/**
 * Inert stand-ins for `RunCliOptions.input`/`.output`: the Ink shell drives every chat line
 * through `CliInstance.dispatchLine()` and every approval/clarification prompt through
 * `PromptBridge` (Decision 1's override seam), so `runCli()`'s own internal `readline` interface
 * never needs to read real keystrokes or write real prompts — Ink owns the real terminal
 * exclusively (raw mode for keystrokes, direct ANSI writes for frames). Leaving `runCli()`'s
 * `createInterface({ input: process.stdin, output: process.stdout })` default in place here
 * would fight Ink for both: `readline` auto-enables terminal/raw mode whenever its `output` is a
 * TTY, which would race Ink's own `setRawMode` calls on the same `stdin`. Neither stream declares
 * `isTTY`, so `createInterface`'s terminal-mode auto-detection (`Boolean(output.isTTY)`) comes
 * out false and it never tries.
 */
function createInertStreams(): { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } {
  const input = new Readable({ read: () => {} })
  const output = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  })
  return { input, output }
}

export type RunTuiAppOptions = Omit<RunCliOptions, 'askYesNo' | 'askLine'>

/**
 * Constructs `runCli()` wired to this file's Ink shell (Phase 4 calls this once, behind the
 * `tuiMode` rollout flag) and renders it. Resolves once the user exits (Ctrl+C — see `TuiApp`'s
 * `onExit`), after the same graceful-exit steps `cli.ts`'s own `rl.on('SIGINT', ...)` handler
 * performs: restore the captured `console`/`process.stdout`, close the underlying `CliInstance`,
 * then exit the process.
 */
export async function runTuiApp(options: RunTuiAppOptions = {}): Promise<void> {
  const eventLog = new EventLogBridge()
  const prompt = new PromptBridge()
  const status = new StatusBridge()

  // Started before runCli() is ever called — runCli() itself prints the startup banner
  // (backend, capabilities, undo-log carryover) via plain console.log, which must land in the
  // Static scrollback like everything else, not leak to the real terminal underneath Ink's frame.
  const restoreCapture = startCapture((event) => eventLog.handleEvent(event))

  let instance: CliInstance
  try {
    const inert = createInertStreams()
    instance = await runCli({
      ...options,
      input: options.input ?? inert.input,
      output: options.output ?? inert.output,
      askYesNo: prompt.askYesNo,
      askLine: prompt.askLine,
    })
  } catch (err) {
    restoreCapture()
    throw err
  }

  const refreshStatus = async (): Promise<void> => {
    status.set(await instance.getStatusIndicators())
  }
  await refreshStatus()

  const handleSubmitChat = (line: string): void => {
    void instance.dispatchLine(line).then(refreshStatus)
  }

  let exiting = false
  const exit = (): void => {
    if (exiting) return
    exiting = true
    restoreCapture()
    instance.close()
    app.unmount()
    process.exit(0)
  }

  const app = inkRender(<TuiApp eventLog={eventLog} prompt={prompt} status={status} onSubmitChat={handleSubmitChat} onExit={exit} />, {
    // Phase 1's startCapture already routes every console.log/process.stdout.write call into
    // eventLog — ink's own patchConsole would double-intercept the same calls with a competing
    // mechanism (writing them above its own Static area independently), not compose with it.
    patchConsole: false,
    exitOnCtrlC: false,
  })

  await app.waitUntilExit()
}
