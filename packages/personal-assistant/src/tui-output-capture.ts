import { format } from 'node:util'

/**
 * One classified write, mirroring the three writer patterns `cli.ts` already uses (see that
 * file's `writeProgress`/`clearProgress`, `writeToolStep`, `writeToken`) — not a new convention,
 * just naming what's already there so Phase 3's Ink shell can route each kind to the right
 * region (transient status line, transient streamed-reply buffer, permanent scrollback).
 */
export type CaptureEvent =
  | {
      /** `writeProgress`'s `\r`-overwritten step counter, or `clearProgress`'s blank-out of it. */
      type: 'progress'
      /** The current progress text with the `\r` control character and `padEnd` filler removed — `''` once cleared. */
      text: string
    }
  | {
      /** `writeToken`'s raw incremental streamed characters — no trailing newline until the turn ends. */
      type: 'token'
      text: string
    }
  | {
      /** A `console.log`/`console.error` call, or any write that completes with a trailing newline — one or more committed, permanently-scrolled lines. */
      type: 'line'
      lines: string[]
    }

/**
 * Classifies a single already-formatted write exactly the way the three writer patterns in
 * `cli.ts` are told apart from each other (see this file's `CaptureEvent` doc comment): a
 * leading `\r` means progress, a trailing `\n` means one or more committed lines, and everything
 * else (streamed reply tokens — the only writer left that produces neither) is a token.
 */
function classify(raw: string): CaptureEvent {
  if (raw.startsWith('\r')) {
    // `padEnd`'s filler spaces exist only to overwrite a longer previous line on a real
    // terminal — Ink re-renders the whole frame every time, so that artifact would just show up
    // as trailing whitespace with no purpose. `clearProgress`'s `\r${spaces}\r` collapses to ''.
    return { type: 'progress', text: raw.replace(/\r/g, '').trimEnd() }
  }
  if (raw.endsWith('\n')) {
    // Drop only the one trailing empty element `split` produces because the string itself ends
    // in '\n' — any other blank lines in the middle (e.g. a call site's own leading/trailing
    // '\n' for spacing) are real committed blank lines, not a split artifact.
    return { type: 'line', lines: raw.slice(0, -1).split('\n') }
  }
  return { type: 'token', text: raw }
}

type StdoutWrite = typeof process.stdout.write

/**
 * Monkey-patches `console.log`, `console.error`, and `process.stdout.write` for the duration of
 * the interactive Ink session, classifying every write via {@link classify} and routing it to
 * `onEvent` instead of the real terminal — Ink owns the frame once this is active (Decision 1:
 * every command handler still calls the same global functions unmodified). Returns a restore
 * function that puts the originals back; call it on exit and in every test's `afterEach`.
 */
export function startCapture(onEvent: (event: CaptureEvent) => void): () => void {
  const originalLog = console.log
  const originalError = console.error
  const originalWrite = process.stdout.write

  const captureConsole = (...args: unknown[]): void => {
    onEvent(classify(`${format(...(args as [unknown, ...unknown[]]))}\n`))
  }
  console.log = captureConsole
  console.error = captureConsole

  const captureWrite: StdoutWrite = ((chunk: unknown, ...rest: unknown[]): boolean => {
    onEvent(classify(typeof chunk === 'string' ? chunk : String(chunk)))
    // Honor process.stdout.write's real contract (an optional trailing callback) even though no
    // call site in cli.ts currently passes one — costs nothing and avoids a silent hang for any
    // future one that does.
    const callback = rest.find((arg): arg is () => void => typeof arg === 'function')
    callback?.()
    return true
  }) as StdoutWrite
  process.stdout.write = captureWrite

  return () => {
    console.log = originalLog
    console.error = originalError
    process.stdout.write = originalWrite
  }
}
