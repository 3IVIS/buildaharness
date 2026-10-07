# Plan visualization

A read-only dependency graph of the active plan, on both surfaces. Nothing in it changes a plan: plans change only through the approval gate and `PlanService`.

## Enabling

Off by default (`planGraphMode`, presentation only, not a layer setting). With it off there is no button, no pane, no asset loaded, and `/plan graph` behaves as plain `/plan`.

| Where | How |
|---|---|
| Env | `ASSISTANT_PLAN_GRAPH=enabled` (browser build: `VITE_ASSISTANT_PLAN_GRAPH=enabled`) |
| CLI | `/config set planGraphMode enabled` |
| Config file | `"planGraphMode": "enabled"` |

## Opening it

- **CLI / terminal UI:** `/plan graph [thread-id]`. In the Ink shell this opens a full-screen pane on the alternate screen; closing it returns to the chat with scrollback untouched. In the plain REPL or with piped input it prints one static render at `process.stdout.columns` (default 80), or a dependency list when the graph cannot fit. Over 150 nodes, or on a layout failure, it prints the existing `/plan` checklist with a one-line reason. `thread-id` narrows to one goal thread.
- **chat-ui / desktop:** a "Plan graph" header button (shown only when a plan exists), a "View as graph" link under a message's plan checklist, and a "View as graph" link on the plan approval card. The graph opens in a docked right-hand drawer with a full-screen toggle (open state is remembered in `localStorage`). "Export HTML snapshot" downloads a self-contained offline page.

## Status mapping

| Plan task state | Shown as | CLI glyph (ASCII) |
|---|---|---|
| `PENDING`, some dependency not complete | pending | `○` (`o`) |
| `PENDING`, every dependency `COMPLETE` | ready | `◔` (`*`) |
| `RUNNING` | running | `▶` (`>`) |
| `COMPLETE` | done | `✓` (`+`) |
| `COMPLETE` + cancelled | cancelled (web viewer: done, description prefixed `⊘`, result "(cancelled by you)") | `⊘` (`/`) |
| `FAILED` | failed (the status note is the failure reason) | `✗` (`x`) |
| `BLOCKED` | awaiting input | `⏸` (`=`) |
| `HUMAN_REQUIRED` | awaiting user | `~` (`~`) |

A synthesized goal node (`plan`, or the thread id) depends on the plan's terminal tasks. Tasks from goal threads are namespaced `<threadId>__<taskId>`. The ASCII set is used when the terminal is not UTF-8; colour is off under `NO_COLOR` or a non-TTY. `⏸ ▶ ⊘ ◔` have ambiguous width on some terminals; the ASCII set is the fallback.

Live statuses come from harness checkpoints (per checkpoint, not per token).

## Navigation (CLI pane)

| Key | Action |
|---|---|
| `↑` or `[` | Select the nearest dependency; press again to cycle the other dependencies |
| `↓` or `]` | Select the nearest dependent; press again to cycle the other dependents |
| `←` / `→` | Neighbour in the same rank, wrapping |
| `Tab` / `Shift+Tab` | Next / previous node in task order (reaches any node, including other threads) |
| `Enter` or `d` | Toggle the detail drawer (docked automatically at 120+ columns) |
| `j` / `k`, `PgDn` / `PgUp` | Scroll the detail drawer by a line / a page (while it is showing; it starts at the top for each selected node) |
| `q` or `Esc` | Close |
| `Ctrl+C` | Exit, as everywhere |

The selected node's incoming and outgoing edges are highlighted exactly (routes are generated, not traced). The viewport pans to keep the selection visible. An approval prompt that arrives while the pane is open takes the keyboard; the pane stays drawn above it. No key edits anything.

## Third-party code

The web viewer is adapted from cuddlytoddly (MIT) and uses d3 (ISC) and dagre (MIT); see `THIRD_PARTY_NOTICES`.

## Not built (follow-ups)

- Replay (needs an append-only plan-history log).
- Edit-in-graph (must route through `PlanService` and the approval gate).
- A native save dialog, if the browser-style download proves unreliable in a desktop webview.
- A pinned one-line live strip in the TUI.
- An elkjs swap behind the layout interface if dagre routing proves inadequate on dense plans.
- An optional coverage provider (`@vitest/coverage-v8` is not installed).
- tmux integration tests for the alternate-screen pane (open/close three times, 40x10, piped output, `startCapture` interplay); not yet written.
