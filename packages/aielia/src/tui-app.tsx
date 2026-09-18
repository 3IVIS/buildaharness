import { Readable, Writable } from 'node:stream'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Box, Static, Text, render as inkRender, useInput, useWindowSize } from 'ink'
import { runCli, type CliInstance, type RunCliOptions, type SelectOption } from './cli.js'
import { startCapture, type CaptureEvent } from './tui-output-capture.js'
import { TuiInput } from './tui-input.js'
import { SelectPrompt } from './ink-select-prompt.js'
import { ICONS, PLAN_LINE_PREFIX } from './cli-icons.js'
import { renderMarkdownLine } from './markdown-line.js'

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

/**
 * Which visual style a committed scrollback line gets (this task's ask: "different formats for
 * user text vs aielia response vs tool call details"). `'margin'` is a blank spacer line between
 * turns, not a real writer's output — kept as its own kind rather than reusing `'system'` so
 * rendering never has to guess a blank line's intent from empty text alone.
 */
export type LineKind = 'user' | 'assistant' | 'tool' | 'error' | 'system' | 'margin' | 'plan'

export interface LogLine {
  text: string
  kind: LineKind
}

export interface TuiLogState {
  /** Every permanently-committed scrollback line, oldest first — fed straight into `<Static>`. */
  lines: LogLine[]
  /** `writeProgress`'s current `\r`-overwritten line — shown in the transient region, never committed. */
  progressText: string
  /** `writeToken`'s not-yet-newline-terminated streamed reply text — shown in the transient region until the next committed-line event closes it out. */
  transientText: string
  /**
   * True from `beginTurn()` (called right after a chat line or a resolved approval/clarification
   * prompt is submitted) until the first `CaptureEvent` of that turn actually lands. Covers the
   * gap the comparison report flagged — "nothing shows between hitting enter and the first
   * output" — that neither `progressText` nor `transientText` can, since both start empty and
   * only a genuine harness event ever populates them.
   */
  waitingForOutput: boolean
}

const EMPTY_LOG: TuiLogState = { lines: [], progressText: '', transientText: '', waitingForOutput: false }

/** `writeToolStep`'s own indent+glyph (see cli.ts's `toolStepIcon`/cli-icons.ts) — matched after trimming so a `'line'` event's kind survives cli.ts adding/removing leading whitespace. Three possible glyphs since cli-icons.ts distinguishes a routine tool step, one that's itself proposing a state-changing action, and one `tool-policy.ts` denied before it executed — all three still classify as the same `'tool'` LineKind here, just with a different leading icon. */
const TOOL_STEP_PREFIXES = [ICONS.toolStep, ICONS.proposalStep, ICONS.deniedStep]
/** cli.ts hardcodes this literal label for every assistant-reply write, streamed or not (`writeToken`'s opening write and the non-streaming `console.log` fallback both start with it) — see this class's `handleEvent` doc comment for why streaming state alone isn't a reliable-enough signal on its own. */
const ASSISTANT_REPLY_PREFIX = 'Aielia>'

/** Classifies one already-merged, already-stream-tagged committed block into a `LineKind` — shared by every resulting split line, since a multi-line reply/tool/system block reads as one unit, not a mix of styles line to line. */
function classifyLineKind(mergedText: string, streamedReplyWasOpen: boolean, stream: 'stdout' | 'stderr'): LineKind {
  if (stream === 'stderr') return 'error'
  if (mergedText.trimStart().startsWith(PLAN_LINE_PREFIX)) return 'plan'
  // Streaming state alone would miss the non-streaming `console.log('\nAielia>…')` fallback path
  // (harness_d2's non-one-loop path) that never opens a `'token'` stream at all — checked first
  // since it's the more specific, unambiguous signal when it does apply.
  if (streamedReplyWasOpen || mergedText.trimStart().startsWith(ASSISTANT_REPLY_PREFIX)) return 'assistant'
  if (TOOL_STEP_PREFIXES.some((prefix) => mergedText.trimStart().startsWith(prefix))) return 'tool'
  return 'system'
}

/** Strips {@link PLAN_LINE_PREFIX} the same way `stripAssistantLabel` strips `ASSISTANT_REPLY_PREFIX` — the marker exists only for `classifyLineKind` to match on, never shown. */
function stripPlanLabel(text: string): string {
  return text.replace(new RegExp(`^\\s*${PLAN_LINE_PREFIX}\\s*`), '')
}

/**
 * Strips cli.ts's hardcoded "Aielia>" reply label (plus a leading blank-line artifact — the
 * streaming path's opening write is literally `'\nAielia> '`, and `\s*` below eats that leading
 * `\n` along with the label) so the assistant's reply displays as just its own text, no label —
 * explicit feedback that spelling out "you"/"Aielia" wasn't wanted (see `LogLineText`'s doc
 * comment for the full styling rationale). Applied to already-classified `'assistant'` text only;
 * never called on anything else, so it can't accidentally eat real reply content that happens to
 * start the same way.
 */
function stripAssistantLabel(text: string): string {
  return text.replace(/^\s*Aielia>\s?/, '')
}

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
  private lines: LogLine[] = []
  private progressText = ''
  private transientText = ''
  private waitingForOutput = false
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
    this.snapshot = { lines: this.lines, progressText: this.progressText, transientText: this.transientText, waitingForOutput: this.waitingForOutput }
    for (const listener of this.listeners) listener()
  }

  /** Marks the start of a turn's wait for its first output (see `TuiLogState.waitingForOutput`'s doc comment) — called by `TuiApp` right after a chat line or resolved prompt answer is submitted. */
  beginTurn(): void {
    this.waitingForOutput = true
    this.commit()
  }

  /**
   * A blank spacer line ("some margins between different conversations", later extended to "at
   * least one line spacing between the user and system messages") — called from three places in
   * `handleSubmitChat` (never from a resolved approval/clarification prompt answer, which stays
   * visually grouped with the turn it belongs to): once before a new turn's echo (separating it
   * from the previous turn's reply) and once right after it (separating the echo from whatever
   * system/tool/assistant output follows). A no-op on an empty log or if the last line is already
   * a margin, so calling it from both of those spots back-to-back across turns can't stack blank
   * lines — the "before next turn" and "after this turn" calls collapse into the same one line.
   */
  pushTurnMargin(): void {
    const last = this.lines[this.lines.length - 1]
    if (!last || last.kind === 'margin') return
    this.lines = [...this.lines, { text: '', kind: 'margin' }]
    this.commit()
  }

  /** Records a line the user just submitted (chat or a resolved prompt answer) into permanent scrollback — mirrors a real terminal's own line-echo, which the inert (non-TTY) input stream this shell uses never produces on its own. `prefix` is `''` for an ordinary chat line (no "you>" label — see `LogLineText`'s doc comment) and `'> '` for a resolved prompt answer, which keeps its prefix since it's answering a question printed just above it, not identifying whose turn it is. */
  pushEchoLine(prefix: string, text: string): void {
    this.lines = [...this.lines, { text: `${prefix}${text}`, kind: 'user' }]
    this.commit()
  }

  handleEvent(event: CaptureEvent): void {
    // Any real event closes the "waiting for first output" gap — a spinner covering it makes no
    // sense once the turn has actually started producing something.
    this.waitingForOutput = false
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
    const streamedReplyWasOpen = this.transientText.length > 0
    const merged = this.transientText + event.lines.join('\n')
    const kind = classifyLineKind(merged, streamedReplyWasOpen, event.stream)
    const displayText = kind === 'assistant' ? stripAssistantLabel(merged) : kind === 'plan' ? stripPlanLabel(merged) : merged
    // 'plan' stays one un-split LogLine (see PlanBox's doc comment) — every other kind splits
    // per-line since their own rendering (plain/dim/red text, or per-line markdown) doesn't need
    // the whole block intact the way a single bordered box does.
    this.lines = kind === 'plan' ? [...this.lines, { text: displayText, kind }] : [...this.lines, ...displayText.split('\n').map((text) => ({ text, kind }))]
    this.transientText = ''
    // Any committed line means the progress indicator that was describing the still-in-flight
    // turn is now stale — cli.ts's own clearProgress() deliberately skips itself once a reply has
    // streamed (real-terminal reasoning: clearing would \r back onto the tail of the just-printed
    // reply and blank it — see handleTurn's `if (!streamedAnyTokens) clearProgress()` comment).
    // That reasoning doesn't apply here: the TUI's progress line lives in its own state-driven
    // transient region, decoupled from real cursor position, so nothing needs to "not corrupt" —
    // it just needs to stop displaying a step counter for a turn that has already finished.
    // Clearing on every commit is safe even when cli.ts's own clearProgress() *did* already fire
    // (writeToolStep's case): progressText is already '' then, so this is a no-op.
    this.progressText = ''
    this.commit()
    // A blank line after the assistant's own reply, mirroring the one already pushed after the
    // user's echo (pushTurnMargin's own no-op-on-consecutive-margin guard means this and the next
    // turn's pre-echo pushTurnMargin() call collapse into the same single line, never stacking).
    if (kind === 'assistant') this.pushTurnMargin()
  }
}

export type PendingPrompt = { question: string; options?: SelectOption[] } | undefined

/**
 * Bridges `runCli()`'s `askYesNo`/`askLine`/`askSelect` override seam (Decision 1, extended by
 * Phase 7 for the structured selector) to Ink: each call parks a resolver and exposes the pending
 * question (and, for `askSelect`, its option list) to the component tree via `getSnapshot()`,
 * instead of the original `rl.question`-based implementation. `TuiInput`'s own `promptLabel` prop
 * (Phase 2) renders a plain-text pending question; `TuiApp` (below) renders `SelectPrompt` instead
 * whenever `pending.options` is set — this class only needs to supply the question (and options)
 * and resolve the answer, the same way for either shape.
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

  private ask(question: string, options?: SelectOption[]): Promise<string> {
    return new Promise((resolve) => {
      this.pending = { question, options }
      this.resolve = resolve
      for (const listener of this.listeners) listener()
    })
  }

  /** Matches `RunCliOptions.askYesNo`'s exact parsing convention (`answer.trim().toLowerCase().startsWith('y')`) — same fail-closed shape, just answered via the Ink prompt instead of `rl.question`. */
  askYesNo = (question: string): Promise<boolean> => this.ask(question).then((answer) => answer.trim().toLowerCase().startsWith('y'))

  askLine = (question: string): Promise<string> => this.ask(question)

  /** Matches `RunCliOptions.askSelect`'s contract exactly — resolves with the chosen `SelectOption.key`, answered via `SelectPrompt` instead of `rl.question`. */
  askSelect = (question: string, options: SelectOption[]): Promise<string> => this.ask(question, options)

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
 * One committed scrollback line, styled by `LineKind` (this task's ask: "different formats for
 * user text vs aielia response vs tool call details"). Several earlier versions are worth
 * recording since they were each explicit feedback, not guesses: (1) colored 'user'/'assistant'
 * cyan/green — rejected as arbitrary; (2) dropped color for bold-only-on-the-label-line —
 * rejected in favor of dropping the "you>"/"Aielia>" labels themselves entirely (see
 * `stripAssistantLabel` — the label text no longer exists in `'assistant'`-kind text at all, and
 * `'user'`-kind text is pushed with no prefix in chat mode — `EventLogBridge.pushEchoLine`'s doc
 * comment); (3) a dark gray foreground, then (4) a dark gray *background* highlight band instead
 * (through three shades — plain 'gray', then near-black, then a midpoint — before the whole
 * background-band approach was set aside); (5) **current**: a bordered `<Box>` around the user's
 * own text, echoing `TuiInput`'s own box chrome (round border, `paddingX={1}`) but in a muted gray
 * border instead of the live input box's cyan, so a past message reads as "the same kind of
 * thing, already said" rather than "still being typed." Ink's `Box` fills the parent's width by
 * default (no explicit `width` set, same as `TuiInput`'s own box), so this box's border
 * automatically spans the same width as the live input box below it with no manual padding
 * needed. Position — the old label used to carry — is now conveyed by `pushTurnMargin`'s
 * blank-line spacing instead. `'tool'`/`'error'` still use dim/red respectively — not what the
 * feedback was about (a functional error signal, not a stylistic user/assistant split). A
 * `'margin'` line renders a bare blank row (a real space, not empty — Ink/terminal rows with
 * truly empty text can collapse to zero width, the same reasoning `TuiInput` already applies to
 * its own empty draft rows).
 */
/**
 * `width` is passed explicitly (from `TuiApp`'s own `columns ?? windowSize.columns`, the same
 * value the separator and `TuiInput`'s box use) rather than relying on `Box`'s usual
 * fill-parent-width default — confirmed live that a `<Static>` item's `Box` sizes to its content
 * instead of stretching, unlike a `Box` in the main persistent tree (`TuiInput`'s own), so without
 * this every message box shrink-wrapped to its own text length instead of matching the input box.
 */
function UserMessageBox({ text, width }: { text: string; width: number }): React.JSX.Element {
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} width={width}>
      {text.split('\n').map((line, i) => (
        <Text key={i}>{line.length > 0 ? line : ' '}</Text>
      ))}
    </Box>
  )
}

/**
 * Phase 6 of the CLI formatting plan ("distinct plan-mode UI") — a dedicated bordered widget for
 * `cli.ts`'s `printPlan()` status block, the same "one box around the whole multi-line text"
 * pattern {@link UserMessageBox} already uses (see `EventLogBridge.handleEvent`'s `kind === 'plan'`
 * branch, which — unlike every other kind — pushes the whole block as one un-split `LogLine` so
 * this component receives it intact instead of one already-split line at a time). Cyan border
 * distinguishes it from the user box's gray without introducing a new color for its own sake — cyan
 * is `TuiInput`'s own live-input border color, so a plan box reads as "structured, awaiting your
 * attention" the same way the input box does. The header line (`Plan: … % complete`, always first —
 * see `formatPlanProgress`/`printPlan`) is bolded for a lightweight title, without the separate
 * "Updated Plan" banner line Codex uses, since `formatPlanProgress`'s own first line already serves
 * that purpose and a second title would be redundant.
 */
function PlanBox({ text, width }: { text: string; width: number }): React.JSX.Element {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} width={width}>
      {text.split('\n').map((line, i) => (
        <Text key={i} bold={i === 0}>{line.length > 0 ? line : ' '}</Text>
      ))}
    </Box>
  )
}

function LogLineText({ line, width }: { line: LogLine; width: number }): React.JSX.Element {
  switch (line.kind) {
    case 'user':
      return <UserMessageBox text={line.text} width={width} />
    // Basic markdown (headers, `- [ ]`/`- [x]` checkboxes, **bold**, `code`) rendered for the
    // assistant's own reply text only (see markdown-line.tsx) — system output (banner, /help,
    // /status, etc.) is left as plain text since it's already deterministic, controlled prose
    // with no markdown of its own to render.
    case 'assistant':
      return renderMarkdownLine(line.text, 0)
    case 'plan':
      return <PlanBox text={line.text} width={width} />
    case 'system':
      return <Text>{line.text}</Text>
    case 'tool':
      return <Text dimColor>{line.text}</Text>
    case 'error':
      return <Text color="red">{line.text}</Text>
    case 'margin':
      return <Text> </Text>
  }
}

/** Braille frames for {@link Spinner} — the same cycle `cli-spinner`/`ora`'s default `dots` style uses, hand-rolled here since no spinner dependency exists in this package (Ink-native, no new dependency, matching this phase's other items). */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** How often the spinner advances a frame — fast enough to read as "alive," slow enough not to flood a redraw-on-every-frame terminal. */
const SPINNER_INTERVAL_MS = 80

/**
 * A minimal thinking/loading indicator for the gap between hitting Enter and the first real
 * output (report finding: "nothing shows... no spinner, no status line, unlike Pi/Codex") — shown
 * only while `TuiLogState.waitingForOutput` is true and cleared automatically the instant any real
 * `CaptureEvent` lands (see `EventLogBridge.handleEvent`), so it can never linger over genuine
 * progress/streamed output.
 */
function Spinner(): React.JSX.Element {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  return (
    <Text dimColor>
      {SPINNER_FRAMES[frame]} Thinking…
    </Text>
  )
}

/** The reserved status line (Phase 3 step 5) — each indicator its own `<Text>` so a `⚠`-prefixed warning (currently only the dangerouslySkipPermissions notice) can stand out in yellow while the rest stay dim, without string-parsing a single joined line. */
function StatusLine({ indicators }: { indicators: string[] }): React.JSX.Element {
  return (
    <Text>
      {indicators.map((indicator, index) => (
        <Text key={indicator}>
          {index > 0 ? '   ' : ''}
          <Text color={indicator.startsWith('⚠') ? 'yellow' : undefined} dimColor={!indicator.startsWith('⚠')}>
            {indicator}
          </Text>
        </Text>
      ))}
    </Text>
  )
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
      // Only a genuine new chat turn gets blank margins around it — a resolved
      // approval/clarification prompt answer (handleSubmitPrompt below) stays visually grouped
      // with the turn it belongs to, not treated as a turn of its own. No "you>" prefix (see
      // `LogLineText`'s doc comment) — the gray shading plus these margins on both sides do the
      // job the label used to.
      eventLog.pushTurnMargin()
      eventLog.pushEchoLine('', line)
      eventLog.pushTurnMargin()
      eventLog.beginTurn()
      onSubmitChat(line)
    },
    [eventLog, onSubmitChat],
  )

  const handleSubmitPrompt = useCallback(
    (line: string) => {
      // Commit the question alongside its answer (Phase 2) — `pending.question` only lives in
      // `PromptBridge` state and disappears the instant `prompt.submit()` clears it below, so
      // without this the resolved prompt (e.g. "Run this command? (y/N)") would vanish from
      // scrollback entirely, leaving only the bare answer echo with no context for what it
      // answered. Falls back to the bare answer if `pending` is somehow already cleared (Enter
      // fired with no promptLabel), which shouldn't happen since `TuiInput` only calls
      // `onSubmitPrompt` when `promptLabel` is set.
      // `.trimEnd()` — every real `askYesNo`/`askLine` question text ends with a trailing space
      // (e.g. `'Proceed? (y/N) '`), a holdover from the old `rl.question()` flow where the answer
      // was typed inline right after it; here it'd otherwise double up with the arrow's own
      // leading space.
      // For an `askSelect` answer, `line` is the chosen option's raw `key` (e.g. `'a'`) — look up
      // its `label` so the persistent record reads "Proceed? → Yes, don't ask again this session"
      // rather than the bare, less legible key.
      const displayAnswer = pending?.options?.find((option) => option.key === line)?.label ?? line
      eventLog.pushEchoLine('> ', pending?.question !== undefined ? `${pending.question.trimEnd()} → ${displayAnswer}` : line)
      eventLog.beginTurn()
      prompt.submit(line)
    },
    [eventLog, prompt, pending],
  )

  const hasTransient = log.progressText.length > 0 || log.transientText.length > 0
  const showSpinner = log.waitingForOutput && !hasTransient

  return (
    <Box flexDirection="column">
      <Static items={log.lines}>{(line, index) => <LogLineText key={index} line={line} width={width} />}</Static>
      {showSpinner && <Spinner />}
      {hasTransient && (
        <Box flexDirection="column">
          {log.progressText.length > 0 && <Text dimColor>{log.progressText}</Text>}
          {log.transientText.length > 0 && <Text>{stripAssistantLabel(log.transientText)}</Text>}
        </Box>
      )}
      <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
      {pending?.options ? (
        <SelectPrompt question={pending.question} options={pending.options} onSubmit={handleSubmitPrompt} />
      ) : (
        <TuiInput
          promptLabel={pending?.question}
          onSubmitChat={handleSubmitChat}
          onSubmitPrompt={handleSubmitPrompt}
          columns={columns}
        />
      )}
      <StatusLine indicators={statusIndicators} />
    </Box>
  )
}

/**
 * `startCapture` (Phase 1) monkey-patches the *global* `process.stdout.write` so it can intercept
 * `cli.ts`'s ~108 existing call sites without touching each one (Decision 1) — but Ink itself also
 * paints every frame through that same global `process.stdout.write` by default. Left unpatched,
 * Ink's own frame writes would loop back through `startCapture`'s `onEvent` into
 * `EventLogBridge.handleEvent`/`commit()`, which notifies the very `TuiApp` subscribers that
 * caused the frame in the first place — triggering another render, another write, another event,
 * forever, until React's update-depth guard throws `Maximum update depth exceeded`. This wraps the
 * *real* `process.stdout` in a `Proxy` that resolves every property normally (so `columns`,
 * `isTTY`, `on('resize', …)` etc. all still hit the genuine stream, preserving correct `this`
 * binding for its internal EventEmitter state) except `write`, which is pinned to the pristine
 * function captured *before* `startCapture` ran — so Ink paints the real terminal directly and
 * never re-enters the capture/bridge loop.
 */
function createUnpatchedStdout(originalWrite: NodeJS.WriteStream['write']): NodeJS.WriteStream {
  return new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'write') return originalWrite.bind(target)
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
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

export type RunTuiAppOptions = Omit<RunCliOptions, 'askYesNo' | 'askLine' | 'askSelect'>

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

  // Captured before startCapture patches process.stdout.write — this is the pristine function
  // Ink itself will paint frames through (see createUnpatchedStdout's doc comment above).
  const originalWrite = process.stdout.write.bind(process.stdout)

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
      askSelect: prompt.askSelect,
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
    // Bypass startCapture's patched process.stdout.write for Ink's own frame painting — see
    // createUnpatchedStdout's doc comment for why leaving this as the default (real
    // process.stdout, whose .write is the patched one) causes an infinite render loop.
    stdout: createUnpatchedStdout(originalWrite),
  })

  await app.waitUntilExit()
}
