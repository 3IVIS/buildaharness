import { SelectOption } from './cli.js';
export interface SelectPromptProps {
    /** The question text, rendered the same bold-yellow way `TuiInput`'s own `promptLabel` renders a pending askYesNo/askLine question. */
    question: string;
    /** Rendered in order, top to bottom — the highlighted (arrow-key-selected) option starts at index 0. Each option's `key` also doubles as its single-keystroke shortcut. */
    options: SelectOption[];
    /** Called once, with the chosen option's `key` — either Enter on the highlighted row, or a direct keystroke matching an option's `key`. */
    onSubmit: (key: string) => void;
    isActive?: boolean;
    /** Keys arriving within this many ms of the prompt appearing are ignored: a key typed ahead for the previous turn (an Enter, a 'y') must not answer a question the user has not seen yet. Default 0 (no guard). */
    armDelayMs?: number;
}
/**
 * Phase 7 of the internal plan: an arrow-key + numbered/shortcut-key
 * selector, replacing free-text `y`/`N` typed into the same box used for chat (the report's
 * finding — Codex/Claude Code both use a dedicated selector for this). Deliberately a standalone
 * component rather than a mode bolted onto `TuiInput`: `TuiInput` is a general-purpose free-text
 * editor (word-wrap, cursor movement, history recall) that has no notion of a fixed option list,
 * and grafting one on would tangle two unrelated input models together for no shared benefit — the
 * two components share only the surrounding visual grammar (bold label above a round-bordered
 * box), which each renders independently.
 */
export declare function SelectPrompt(props: SelectPromptProps): React.JSX.Element;
