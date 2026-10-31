/**
 * Recognizes one line of `diff-format.ts`'s output by shape: `DIFF_INDENT` followed by a
 * right-aligned line number and a unified-diff sign character. That combination — a fixed
 * two-space indent no ordinary assistant prose produces, paired with a line-number gutter no
 * markdown construct produces — doesn't occur in natural writing (a markdown bullet is always
 * `- text`, dash *then* a space with no number in front, which `CHECKBOX_RE`/plain rendering
 * already own), so this can't misfire on a real bullet list. Context lines (sign is a plain
 * space) are recognized too, with `color: undefined` — they still need to short-circuit
 * `renderMarkdownLine`'s plain-text fallback below (which would otherwise prepend `ASSISTANT_BULLET`
 * to them as if they were ordinary prose), they just aren't colored the way a real diff tool
 * doesn't color its context lines either.
 */
export declare function matchDiffLine(text: string): {
    content: string;
    color: 'green' | 'red' | undefined;
} | undefined;
/**
 * Renders one line as colored diff content if `matchDiffLine` recognizes it, otherwise
 * `undefined` so the caller falls back to its own plain/markdown rendering. Used by
 * `renderMarkdownLine` below (the `'assistant'`-kind, post-write confirmation) and by
 * `tui-app.tsx`'s `'system'`-kind branch (the pre-approval preview) — the two `LogLine` kinds a
 * `formatWriteDiff()` string actually reaches, per `classifyLineKind`.
 */
export declare function renderDiffLine(text: string, key: React.Key): React.JSX.Element | undefined;
/**
 * Colors the `[needs approval — write/shell command/…]`/`[needs approval — HIGH/…]` tag
 * `cli.ts` prints ahead of every approval prompt (see its own `console.log` call sites) yellow —
 * the same "worth your attention" color `StatusLine`'s own `⚠`-prefixed indicators already use —
 * leaving the reason text after it in the default color. This line is `'system'`-classified (see
 * `classifyLineKind`), not `'assistant'`, so it's checked from `tui-app.tsx`'s own `'system'`
 * branch rather than from `renderMarkdownLine`.
 */
export declare function renderNeedsApprovalLine(text: string, key: React.Key): React.JSX.Element | undefined;
/**
 * Renders one committed line of assistant/system text, recognizing a leading `#`/`##`/… header or
 * `- [ ]`/`- [x]` checkbox before falling back to plain inline-styled text. `key` is the React key
 * for the returned element (the caller already has a per-line index from `<Static>`'s own render
 * prop — see `tui-app.tsx`'s `LogLineText`). `continuation` is `LogLine.continuation` — true for
 * every line of a multi-line reply after the first, which suppresses `ASSISTANT_BULLET` (the
 * marker belongs once at the front of the whole message, not on every wrapped line).
 */
export declare function renderMarkdownLine(text: string, key: React.Key, continuation?: boolean): React.JSX.Element;
