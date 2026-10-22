import type { ResultLine } from '@buildaharness/aielia'

/** Thrown at a step boundary once the writer has pressed Stop: the work so far stays, nothing after it runs. */
export class StoppedError extends Error {
  constructor() {
    super('Stopped')
    this.name = 'StoppedError'
  }
}

/** A stop of either kind: the writer pressed Stop at a step boundary, or a model call was cut off by it (the service throws TurnAbortedError). */
export const isStopped = (e: unknown): boolean => e instanceof StoppedError || (e instanceof Error && e.name === 'TurnAbortedError')

/**
 * What an action's work gets to report with. Calling it moves the checklist to `stage`, sets the finer step under it and, with `count`, a
 * "done of total" bar; it throws StoppedError if the writer has pressed Stop, so the work ends at the boundary. `quiet` reports the same
 * without that throw (for a callback inside a loop that would swallow it), and `stopped()` / `signal` let such a loop check for itself.
 */
export interface Step {
  (text: string, stage?: number, count?: readonly [number, number]): void
  quiet(text: string, stage?: number, count?: readonly [number, number]): void
  /** Adds a finished piece of the job (a claim checked) under the bar, as it settles. */
  note(line: ResultLine): void
  stopped(): boolean
  readonly signal: AbortSignal
}
