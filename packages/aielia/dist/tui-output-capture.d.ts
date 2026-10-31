/**
 * One classified write, mirroring the three writer patterns `cli.ts` already uses (see that
 * file's `writeProgress`/`clearProgress`, `writeToolStep`, `writeToken`) — not a new convention,
 * just naming what's already there so Phase 3's Ink shell can route each kind to the right
 * region (transient status line, transient streamed-reply buffer, permanent scrollback).
 */
export type CaptureEvent = {
    /** `writeProgress`'s `\r`-overwritten step counter, or `clearProgress`'s blank-out of it. */
    type: 'progress';
    /** The current progress text with the `\r` control character and `padEnd` filler removed — `''` once cleared. */
    text: string;
} | {
    /** `writeToken`'s raw incremental streamed characters — no trailing newline until the turn ends. */
    type: 'token';
    text: string;
} | {
    /** A `console.log`/`console.error` call, or any write that completes with a trailing newline — one or more committed, permanently-scrolled lines. */
    type: 'line';
    lines: string[];
    /** Which global function produced this — `'stderr'` only for `console.error`, everything else (`console.log`, raw `process.stdout.write`) is `'stdout'`. Lets a consumer (Phase 3's `EventLogBridge`) style error output distinctly without guessing from content. */
    stream: 'stdout' | 'stderr';
};
/**
 * Monkey-patches `console.log`, `console.error`, and `process.stdout.write` for the duration of
 * the interactive Ink session, classifying every write via {@link classify} and routing it to
 * `onEvent` instead of the real terminal — Ink owns the frame once this is active (Decision 1:
 * every command handler still calls the same global functions unmodified). Returns a restore
 * function that puts the originals back; call it on exit and in every test's `afterEach`.
 */
export declare function startCapture(onEvent: (event: CaptureEvent) => void): () => void;
