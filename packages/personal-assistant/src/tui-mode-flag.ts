/**
 * Pure logic backing PersonalAssistant's ASSISTANT_TUI handling — split out so it's
 * unit-testable in isolation, mirroring one-loop-flag.ts/ask-mode-flag.ts/plan-mode-flag.ts's
 * exact shape (module-level default, an injectable resolver so tests never touch real
 * process.env).
 *
 * Phase 4 of plans/personal_assistant_cli_pinned_input_plan.html — the rollout flag gating
 * whether `cli.ts`'s `main()` launches the Phase 3 Ink shell (`runTuiApp()`) instead of
 * today's plain `readline`-based `runCli()` loop. 'disabled' (the default, for this plan's
 * whole rollout window, per `DEFAULT_TUI_MODE`) means `main()` behaves exactly as it does
 * today, byte-for-byte — the Ink shell is never constructed. 'enabled' only takes effect when
 * `main()` also confirms a real interactive TTY on both stdio streams (see cli.ts); it never
 * affects `runCli()` when called directly with test-only options, since that call site is
 * `cli.test.ts`/`non-interactive-mode.ts`'s own, not `main()`'s.
 */
export type TuiMode = 'enabled' | 'disabled'

export const DEFAULT_TUI_MODE: TuiMode = 'disabled'

/**
 * Value-level resolver: `resolveTuiMode` (CLI, reads `process.env.ASSISTANT_TUI`). Unlike
 * `oneLoopMode`/`askMode`/`planMode`, this flag has no browser-facing analog (chat-ui/desktop
 * have no terminal to pin input to), so there's no `envOverridesFromImportMetaEnv` counterpart.
 * An unset or empty value falls back to the default silently; an unrecognized non-empty value
 * falls back with a startup warning naming `varName` — same typo-tolerance-with-a-warning
 * convention `normalizeOneLoopMode`/`normalizeAskMode`/`normalizePlanMode` use.
 */
export function normalizeTuiMode(raw: string | undefined, varName = 'ASSISTANT_TUI'): TuiMode {
  if (raw === undefined || raw === '') return DEFAULT_TUI_MODE
  if (raw === 'enabled' || raw === 'disabled') return raw
  console.error(`[warning] ${varName}="${raw}" is not "enabled" or "disabled" — using the default (${DEFAULT_TUI_MODE}).`)
  return DEFAULT_TUI_MODE
}

export function resolveTuiMode(env: NodeJS.ProcessEnv): TuiMode {
  return normalizeTuiMode(env.ASSISTANT_TUI)
}

/**
 * The full gate `cli.ts`'s `main()` applies before ever constructing the Ink shell — split out
 * as a pure function so the decision is unit-testable without a real pty. `tuiMode === 'enabled'`
 * alone isn't sufficient: a piped/scripted invocation (`printf 'msg\nexit\n' | node dist/cli.js`,
 * this repo's own documented headless workflow, or a real CI/non-interactive shell) must always
 * fall through to the plain `readline` loop regardless of the flag, since Ink's raw-mode input
 * has nothing to attach to without a real TTY on both streams.
 */
export function shouldLaunchTuiApp(tuiMode: TuiMode, stdoutIsTty: boolean, stdinIsTty: boolean): boolean {
  return tuiMode === 'enabled' && stdoutIsTty && stdinIsTty
}
