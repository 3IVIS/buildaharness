import { FsBackend } from '@buildaharness/runtime';
import { PersonalAssistant } from './assistant.js';
import { AssistantConfig, ConfigStore } from './config.js';
import { NonInteractiveApprovalMode } from './non-interactive-mode.js';
import { VizNode } from './plan-viz/types.js';
import { TaskStatus } from '@buildaharness/harness';
import { KeyedBackend, KeyTestResult } from './provider-setup.js';
/**
 * One choice in a structured multi-option prompt (Phase 7 of the internal plan
 * — the numbered/arrow-key approval selector). `key` is both the single-character shortcut shown
 * inline next to the option and the value `askSelect` resolves with; callers order options with
 * the safe/fail-closed choice last, matching `askYesNo`'s own "no real answer → treat as declined"
 * convention (see `askSelect`'s default implementation below, and `ink-select-prompt.tsx`'s
 * `SelectPrompt`, which renders this same list with arrow-key highlight + per-key shortcuts).
 */
export interface SelectOption {
    key: string;
    label: string;
}
export interface RunCliOptions {
    /**
     * The Ink shell's seam for `/plan graph` (planGraphMode enabled): called with the drawable nodes to open the
     * full-screen pane. Without it (plain REPL, piped input) `/plan graph` prints one static render instead.
     */
    openPlanGraph?: (nodes: VizNode[]) => void;
    /** Live per-task statuses from a running turn, forwarded for the open plan graph pane. */
    onPlanProgress?: (tasks: {
        id: string;
        status: TaskStatus;
    }[]) => void;
    /**
     * Called with true when a conversational turn starts being worked on and false when it has finished (in a
     * `finally`, so also after an error) — including turns run as deferred follow-ups, which no `dispatchLine()`
     * promise covers. The TUI's liveness indicator follows this rather than guessing from output events.
     */
    onTurnBusyChange?: (busy: boolean) => void;
    dataDir?: string;
    configStore?: ConfigStore;
    backend?: FsBackend;
    remindersFile?: string;
    envOverrides?: Partial<AssistantConfig>;
    nonInteractiveApprovalMode?: NonInteractiveApprovalMode;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /**
     * Bypasses buildAssistant()'s config-driven backend selection entirely — the seam tests use
     * to hand runCli a PersonalAssistant wired to a scripted ILLMClient (same pattern as
     * assistant.test.ts) for deterministic command-dispatch/approval-flow coverage. When set, a
     * /config change that would otherwise rebuild the assistant leaves this instance in place.
     */
    assistant?: PersonalAssistant;
    /** Overrides the rl.question-based approval prompt — lets tests script approve/decline answers without faking stdin/a real TTY. */
    askYesNo?: (question: string) => Promise<boolean>;
    /** Overrides the rl.question-based free-text prompt the clarification sub-loop uses for option numbers, edit notes, and "Other" free text — lets tests script a multi-step answer without faking stdin/a real TTY. */
    askLine?: (question: string) => Promise<string>;
    /** Overrides the rl.question-based structured multi-option prompt (Phase 7's approval selector) — lets tests script a selection by key without faking stdin/a real TTY. Resolves with the chosen `SelectOption.key`. */
    askSelect?: (question: string, options: SelectOption[]) => Promise<string>;
    /** Test seam: skip the interactive first-run setup regardless of TTY state (also implied when `assistant` is passed). */
    skipFirstRunSetup?: boolean;
    /** Test seam: script the first-run setup's line reads. */
    firstRunAsk?: (question: string) => Promise<string>;
    /** Test seam: stub the live API-key check in the first-run setup (defaults to a real call to the provider). */
    firstRunTestKey?: (backend: KeyedBackend, key: string) => Promise<KeyTestResult>;
}
export interface CliInstance {
    /** Parses and dispatches one line of input exactly as the REPL's 'line' handler does (same dispatchQueue serialization) — the seam cli.test.ts drives command dispatch through without a live TTY. */
    dispatchLine(line: string): Promise<void>;
    /** Keys of the slash-command dispatch table; the parity test compares them with COMMAND_REGISTRY. */
    commandNames: string[];
    close(): void;
    /**
     * Additive, read-only accessor for the pinned-input TUI shell's status line
     * (the internal plan Phase 3) — the same two signals
     * printStatus() already renders as part of `/status` (lastPlanStatus !== undefined,
     * spendCapStatusLine()), just exposed here instead of only printed. Returns short indicator
     * strings in priority order; empty when there's nothing to report. Not used by the ordinary
     * readline REPL or by non-interactive/piped mode — only the TUI shell polls this.
     */
    getStatusIndicators(): Promise<string[]>;
    /** Read-only: the plan graph's drawable nodes (with `live` statuses overlaid), or undefined when planGraphMode is disabled or there is no plan. Feeds the TUI's open plan graph pane. */
    getPlanGraphNodes(live?: {
        id: string;
        status: TaskStatus;
    }[]): Promise<VizNode[] | undefined>;
}
/**
 * The CLI's REPL, parameterized so cli.test.ts can import and drive it directly instead of only
 * through a live process (see non-interactive-mode.ts's doc comment for why that mattered before
 * this export existed — this is T1's answer to it). `main()` below calls this with no options,
 * getting exactly today's behavior; every option here has a real-filesystem/real-stdio default.
 */
export declare function runCli(options?: RunCliOptions): Promise<CliInstance>;
/**
 * Phase 4 of the internal plan: `tuiMode` is resolved from the
 * same persisted-config + env-override chain every other config key uses (not just the env var
 * alone), so `/config set tuiMode enabled` works exactly like `/config set oneLoopMode enabled`
 * already does. This is a second, separate `configStore.load()` from the one `runCli()` performs
 * internally — an accepted duplication (one extra small JSON read at startup) rather than
 * threading a pre-resolved config through `runCli()`'s options, since `runCli()` must remain
 * callable on its own (tests, `non-interactive-mode.ts`) with no knowledge of this gate.
 *
 * `shouldLaunchTuiApp` (tui-mode-flag.ts) additionally requires both stdio streams to be a real
 * TTY — this repo's documented piped/scripted workflow (`printf 'msg\nexit\n' | node dist/cli.js`)
 * and every non-interactive shell always take the `runCli()` branch below regardless of the flag.
 * `runTuiApp` is imported dynamically so a disabled (the default) or non-TTY run never loads Ink
 * at all — `main()` behaves byte-for-byte as it does today in both those cases.
 */
/** A reason the assistant refuses to start (invalid configuration, unusable environment): shown to the user verbatim, exit code 1. */
export declare class StartupError extends Error {
}
export declare function main(argv?: readonly string[]): Promise<void>;
/**
 * True when `entryArg` (a `process.argv[1]` value) refers to the same file as
 * `moduleHref` (an `import.meta.url`).
 *
 * The naive check — `moduleHref === pathToFileURL(entryArg).href` — breaks
 * whenever the script is launched through the npm bin: `npx
 * @buildaharness/aielia`, a global install, or any
 * `node_modules/.bin` shim all pass a **symlink** to this file as
 * `process.argv[1]`, while Node reports `import.meta.url` as the resolved real
 * path. So resolve `entryArg` to its real path before comparing. `resolveReal`
 * is injected for tests; it defaults to `fs.realpathSync`.
 */
export declare function entryArgMatchesModule(entryArg: string | undefined, moduleHref: string, resolveReal?: (p: string) => string): boolean;
