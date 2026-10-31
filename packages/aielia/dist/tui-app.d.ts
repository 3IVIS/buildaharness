import { RunCliOptions, SelectOption } from './cli.js';
import { CaptureEvent } from './tui-output-capture.js';
import { VizNode } from './plan-viz/types.js';
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
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => T;
}
/**
 * Which visual style a committed scrollback line gets (this task's ask: "different formats for
 * user text vs aielia response vs tool call details"). `'margin'` is a blank spacer line between
 * turns, not a real writer's output — kept as its own kind rather than reusing `'system'` so
 * rendering never has to guess a blank line's intent from empty text alone.
 */
export type LineKind = 'user' | 'assistant' | 'tool' | 'error' | 'system' | 'margin' | 'plan' | 'approval';
export interface LogLine {
    text: string;
    kind: LineKind;
    /**
     * True for every split line of a multi-line assistant reply after the first one (see
     * `handleEvent`'s own `displayText.split('\n')`) — `markdown-line.tsx`'s `ASSISTANT_BULLET`
     * belongs once at the front of the whole message, not on every wrapped line (found live: a
     * two-line write confirmation, "Wrote X."/"apple", rendered as two separate bulleted lines
     * instead of one statement). Unset (falsy) for a single-line reply or any other kind, so the
     * bullet still shows by default wherever this flag isn't threaded through.
     */
    continuation?: boolean;
}
export interface TuiLogState {
    /** Every permanently-committed scrollback line, oldest first — fed straight into `<Static>`. */
    lines: LogLine[];
    /** `writeProgress`'s current `\r`-overwritten line — shown in the transient region, never committed. */
    progressText: string;
    /** `writeToken`'s not-yet-newline-terminated streamed reply text — shown in the transient region until the next committed-line event closes it out. */
    transientText: string;
    /**
     * True from `beginTurn()` (called right after a chat line or a resolved approval/clarification
     * prompt is submitted) until the first `CaptureEvent` of that turn actually lands. Covers the
     * gap the comparison report flagged — "nothing shows between hitting enter and the first
     * output" — that neither `progressText` nor `transientText` can, since both start empty and
     * only a genuine harness event ever populates them.
     */
    waitingForOutput: boolean;
    /**
     * True from `beginTurn()` until `endTurn()` — the whole time `dispatchLine()` is working on a turn,
     * including the long silent stretches while a model call is in flight (after a tool read, the only
     * thing on screen used to be a frozen `[step 1/15] Execution…` line, indistinguishable from a hang).
     * The liveness line is driven by this, not by `waitingForOutput`, which clears on the first event.
     */
    turnInFlight: boolean;
    /** `Date.now()` of the turn's latest sign of life (`beginTurn()` or any handled event) — what the liveness line's elapsed counter counts from. Absent outside a turn. */
    lastActivityAt?: number;
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
export declare class EventLogBridge implements Store<TuiLogState> {
    private lines;
    private progressText;
    private transientText;
    private waitingForOutput;
    private turnInFlight;
    private lastActivityAt;
    private snapshot;
    private listeners;
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => TuiLogState;
    private commit;
    /** Marks the start of a turn's wait for its first output (see `TuiLogState.waitingForOutput`'s doc comment) — called by `TuiApp` right after a chat line or resolved prompt answer is submitted. */
    beginTurn(): void;
    /** A resolved approval/clarification answer: output is expected again, but it says nothing about whether a turn is in flight — `TurnActivityTracker` owns that, so a prompt answer can never leave the indicator stuck on. */
    expectOutput(): void;
    /** Marks a turn in flight (idempotent); the elapsed counter counts from the first call. */
    markBusy(): void;
    /** Marks the turn finished (its `dispatchLine()` settled) — the liveness line stops. Safe to call when no turn is in flight. */
    endTurn(): void;
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
    pushTurnMargin(): void;
    /** Records a line the user just submitted (chat or a resolved prompt answer) into permanent scrollback — mirrors a real terminal's own line-echo, which the inert (non-TTY) input stream this shell uses never produces on its own. `prefix` is `''` for an ordinary chat line (no "you>" label — see `LogLineText`'s doc comment, kind `'user'`) and `'> '` for a resolved prompt answer (kind `'approval'`, its own box color — see `LogLineText` — distinct from a real chat message even though both are the user's own input), which keeps its prefix since it's answering a question printed just above it, not identifying whose turn it is. */
    pushEchoLine(prefix: string, text: string): void;
    handleEvent(event: CaptureEvent): void;
}
/**
 * The one place that decides whether the liveness indicator is on. A turn is in flight while any submitted
 * `dispatchLine()` is unsettled OR the CLI reports a turn running (covering a message that was queued mid-turn
 * — its own dispatch resolves at once — and deferred follow-up turns, which no dispatch promise covers).
 * Every exit funnels through `settle()`, called from `finally`s, so no completion path can leave it on.
 */
export declare class TurnActivityTracker {
    private readonly eventLog;
    private dispatches;
    private cliBusy;
    constructor(eventLog: EventLogBridge);
    /** Wraps one `dispatchLine()` call. Always settles, whether it resolves or throws. */
    track<T>(run: () => Promise<T>): Promise<T>;
    setCliBusy(busy: boolean): void;
    private settle;
}
export type PendingPrompt = {
    question: string;
    options?: SelectOption[];
} | undefined;
/**
 * Bridges `runCli()`'s `askYesNo`/`askLine`/`askSelect` override seam (Decision 1, extended by
 * Phase 7 for the structured selector) to Ink: each call parks a resolver and exposes the pending
 * question (and, for `askSelect`, its option list) to the component tree via `getSnapshot()`,
 * instead of the original `rl.question`-based implementation. `TuiInput`'s own `promptLabel` prop
 * (Phase 2) renders a plain-text pending question; `TuiApp` (below) renders `SelectPrompt` instead
 * whenever `pending.options` is set — this class only needs to supply the question (and options)
 * and resolve the answer, the same way for either shape.
 */
export declare class PromptBridge implements Store<PendingPrompt> {
    private pending;
    private resolve;
    private listeners;
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => PendingPrompt;
    private ask;
    /** Matches `RunCliOptions.askYesNo`'s exact parsing convention (`answer.trim().toLowerCase().startsWith('y')`) — same fail-closed shape, just answered via the Ink prompt instead of `rl.question`. */
    askYesNo: (question: string) => Promise<boolean>;
    askLine: (question: string) => Promise<string>;
    /** Matches `RunCliOptions.askSelect`'s contract exactly — resolves with the chosen `SelectOption.key`, answered via `SelectPrompt` instead of `rl.question`. */
    askSelect: (question: string, options: SelectOption[]) => Promise<string>;
    submit(answer: string): void;
}
/** The status line's short indicator list (Phase 3 step 5) — polled from `CliInstance.getStatusIndicators()` after every dispatched line, since plan/spend-cap state only changes as a side effect of a turn. */
export declare class StatusBridge implements Store<string[]> {
    private indicators;
    private listeners;
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => string[];
    set(indicators: string[]): void;
}
export interface PlanGraphView {
    /** 'chat': normal UI. 'blank': the empty frame bracketing a screen switch. 'pane': the full-screen plan graph. */
    mode: 'chat' | 'blank' | 'pane';
    nodes: VizNode[];
}
/**
 * State for the full-screen plan graph pane (read-only; plans/plan_visualization_plan.html, R2). Same pub/sub shape as
 * `StatusBridge`. `writeRaw` must be the UNPATCHED stdout write so `startCapture` never turns the screen-switch escape
 * sequences into log lines. Opening/closing brackets the switch with an empty Ink frame: empty frame, wait, switch, pane.
 */
export declare class PlanGraphBridge implements Store<PlanGraphView> {
    private readonly writeRaw;
    private readonly settleMs;
    private readonly minRenderMs;
    private view;
    private listeners;
    private timer;
    private pendingNodes;
    private transition;
    constructor(writeRaw: (chunk: string) => void, settleMs?: number, minRenderMs?: number);
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => PlanGraphView;
    isOpen(): boolean;
    private set;
    private sleep;
    open(nodes: VizNode[]): Promise<void>;
    close(): Promise<void>;
    /** Synchronous leave for process exit: restores the main screen without waiting. */
    restore(): void;
    /** Throttled node update: the first goes through at once, later ones coalesce to the newest within `minRenderMs`. Identical content is ignored. */
    update(nodes: VizNode[]): void;
    private apply;
    private flush;
    private clearTimer;
}
export interface TuiAppProps {
    eventLog: EventLogBridge;
    prompt: PromptBridge;
    status: StatusBridge;
    /** Optional: absent means the plan graph pane can never open (flag-off wiring). */
    planGraph?: PlanGraphBridge;
    onSubmitChat: (line: string) => void;
    onExit: () => void;
    /** Overrides the live terminal width for tests — same seam `TuiInput` already accepts. */
    columns?: number;
}
/** "Thinking…" at first; once the wait is long enough to be worth noticing, "Working… 42s" — time since the turn's last sign of life. */
export declare function formatLivenessLabel(elapsedMs: number, hasProgress: boolean): string;
/**
 * The top-level Ink app (Phase 3): a `<Static>` scrollback of every committed line, a transient
 * region for the in-progress progress line/streamed reply, a one-row separator, the Phase 2
 * multiline input box pinned to the bottom, and a reserved status line under that. Composition
 * only — command parsing/dispatch stays entirely inside `cli.ts`'s `dispatchLine()` (Decision 1),
 * and this component never re-implements it.
 */
export declare function TuiApp(props: TuiAppProps): React.JSX.Element;
export type RunTuiAppOptions = Omit<RunCliOptions, 'askYesNo' | 'askLine' | 'askSelect'>;
/**
 * Constructs `runCli()` wired to this file's Ink shell (Phase 4 calls this once, behind the
 * `tuiMode` rollout flag) and renders it. Resolves once the user exits (Ctrl+C — see `TuiApp`'s
 * `onExit`), after the same graceful-exit steps `cli.ts`'s own `rl.on('SIGINT', ...)` handler
 * performs: restore the captured `console`/`process.stdout`, close the underlying `CliInstance`,
 * then exit the process.
 */
export declare function runTuiApp(options?: RunTuiAppOptions): Promise<void>;
export {};
