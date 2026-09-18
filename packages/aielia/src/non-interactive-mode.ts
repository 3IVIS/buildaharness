export type NonInteractiveApprovalMode = 'decline' | 'require-tty'

/**
 * Pure logic backing cli.ts's ASSISTANT_NON_INTERACTIVE_APPROVAL handling — split out so it's
 * unit-testable in isolation, the same way error-classifier.ts and node-display-names.ts are
 * split out of cli.ts for the same reason (cli.ts runs `main()` at import time, so it can't be
 * imported directly by a test).
 *
 * Turns the piped/scripted-stdin approval-gate behavior into an explicit, documented choice
 * instead of an incidental side effect of readline hitting closed stdin (see cli.ts's askYesNo,
 * whose fail-closed catch stays the unset-env-var default and is unaffected by this — nothing
 * changes for an interactive TTY session either way). 'decline': every approval gate
 * auto-declines immediately, without ever touching stdin — the right choice for a scripted/CI
 * caller that expects every HIGH-risk/staged action to be rejected outright, no exceptions.
 * 'require-tty': cli.ts fails fast at startup with a clear, actionable error if stdin isn't a
 * real TTY, instead of running an entire session that can only surface the problem deep in, at
 * the first approval prompt, as a generic "[could not read a response]". An unrecognized value is
 * ignored (falls back to unset) with a startup warning, so a typo can't silently produce
 * different behavior than intended — mirrors ASSISTANT_LLM_BACKEND's own typo-tolerance in
 * cli-config.ts, but warns here since a silently-ignored approval-mode typo is safety-relevant in
 * a way a silently-ignored backend typo (which still resolves to a working default) isn't.
 */
export function resolveNonInteractiveApprovalMode(env: NodeJS.ProcessEnv): NonInteractiveApprovalMode | undefined {
  const raw = env.ASSISTANT_NON_INTERACTIVE_APPROVAL
  if (raw === undefined) return undefined
  if (raw === 'decline' || raw === 'require-tty') return raw
  console.error(`[warning] ASSISTANT_NON_INTERACTIVE_APPROVAL="${raw}" is not "decline" or "require-tty" — ignoring.`)
  return undefined
}
