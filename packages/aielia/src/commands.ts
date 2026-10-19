/**
 * The one list of slash commands, and which surface handles each. The CLI's /help is projected from it
 * (cli-session.ts), and two parity tests fail when a surface and this list disagree: cli.test.ts
 * (the dispatch table) and chat-ui's composer-commands.test.ts (the commands the composer intercepts).
 * Pure data: no node:* and no DOM imports, so the browser build can read it.
 */

export type CommandSurfaces = 'both' | 'cli-only' | 'gui-only'

export interface CommandSpec {
  /** The command and any fixed subcommand words, no arguments: '/memory export'. The first word is the dispatch key. */
  name: string
  /** What /help prints for it, arguments included. */
  usage: string
  description: string
  surfaces: CommandSurfaces
  /** Required unless surfaces is 'both': why the other surface does not have it. 'planned: <phase>' marks a gap the surface-unification plan closes. */
  reason?: string
  /** Other dispatch keys that run the same command ('/new' for '/clear'). */
  aliases?: string[]
}

const APP_CONTROL = 'the apps use a UI control instead of a composer command'

export const COMMAND_REGISTRY: CommandSpec[] = [
  { name: '/help', usage: '/help', description: 'Show this list', surfaces: 'cli-only', reason: 'the apps have no command list yet' },
  { name: '/exit', usage: '/exit (/quit, exit, quit)', description: 'End the session', surfaces: 'cli-only', reason: 'an app window is closed, not exited', aliases: ['/quit'] },
  { name: '/clear', usage: '/clear (/new)', description: 'Start a fresh conversation', surfaces: 'cli-only', reason: `${APP_CONTROL} (New chat)`, aliases: ['/new'] },
  { name: '/status', usage: '/status', description: 'Show current model, backend, workspace, and enabled capabilities', surfaces: 'cli-only', reason: `${APP_CONTROL} (Settings)` },
  { name: '/export', usage: '/export [file]', description: "Save this session's transcript to a markdown file", surfaces: 'cli-only', reason: `${APP_CONTROL} (transcript export)` },
  { name: '/undo', usage: '/undo', description: 'Remove the last exchange from conversation history — never reverses a real write_file/run_shell_command effect (see /undo-action)', surfaces: 'cli-only', reason: `${APP_CONTROL} (Undo)` },
  { name: '/undo-action', usage: '/undo-action [id]', description: 'List revertible filesystem effects from approved actions, or stage a revert of one for approval', surfaces: 'both' },
  { name: '/memory', usage: '/memory', description: 'Show learned facts, reminders, pending-confirmation guesses, and experience-store content', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory export', usage: '/memory export [file]', description: 'Save the full, unbounded learned-experience contents (plus facts/reminders/pending) to a JSON file', surfaces: 'cli-only', reason: 'apps export from the Memory panel' },
  { name: '/memory confirm', usage: '/memory confirm <n|category>', description: 'Promote a pending-confirmation guess (or a whole category of them) to durable memory', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory reject', usage: '/memory reject <n|category>', description: 'Discard a pending-confirmation guess (or a whole category of them)', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory forget', usage: '/memory forget <n> [erase]', description: 'Remove an already-learned fact by its number in the "Facts I know" listing; `erase` also scrubs its text from the audit log (otherwise /memory undo can restore it)', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory forget digest', usage: '/memory forget digest [id]', description: 'Erase one stored session digest (or, with no id, all of them)', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory history', usage: '/memory history [events [fact]]', description: 'Show recent memory changes (needs AUDIT_MEMORY_AUDIT_LOG), with the number /memory undo takes; `events` shows each transition with its reason and sources', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory undo', usage: '/memory undo <seq>', description: 'Restore the pre-image of one memory change (a whole consolidation at once)', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory status', usage: '/memory status', description: 'Memory store size vs budget, pending count, write mode, last consolidation', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory archive', usage: '/memory archive [restore <n> | forget <n>]', description: 'List facts set aside (staged forgetting) or replaced by a newer statement; "restore" brings a set-aside one back, "forget" erases one for good', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory consolidate', usage: '/memory consolidate [accept|dismiss <n>]', description: 'Propose merging/tightening overlapping facts and retiring stale ones (staged: nothing changes until you accept); needs AUDIT_MEMORY_CONSOLIDATION', surfaces: 'cli-only', reason: `${APP_CONTROL} (Memory panel)` },
  { name: '/memory off', usage: '/memory off | on', description: 'Stop (or resume) all memory writes for this install; existing facts stay readable and removable', surfaces: 'cli-only', reason: `${APP_CONTROL} (Settings)` },
  { name: '/search', usage: '/search <query>', description: 'Search past messages by content — ranked, not just exact-match', surfaces: 'cli-only', reason: `${APP_CONTROL} (search box)` },
  { name: '/model', usage: '/model [name]', description: 'Show or switch the active model', surfaces: 'cli-only', reason: `${APP_CONTROL} (Settings)` },
  { name: '/project', usage: '/project [name]', description: 'Show or switch which project new project-scoped facts are tagged with (/project clear reverts to the workspace default)', surfaces: 'both' },
  { name: '/cost', usage: '/cost', description: 'Show token usage for the last turn and this session', surfaces: 'cli-only', reason: `${APP_CONTROL} (cost line under each reply)` },
  { name: '/doctor', usage: '/doctor', description: 'Check proxy/claude-cli/workspace/data-dir health', surfaces: 'cli-only', reason: `${APP_CONTROL} (Settings diagnostics)` },
  { name: '/why', usage: '/why', description: 'Explain the last turn: how confident it was, whether it was checked against what was read, and which layers fired', surfaces: 'both' },
  { name: '/layers', usage: '/layers', description: 'Show all 11 harness layers — fired/skipped and why, for the last turn', surfaces: 'both' },
  { name: '/sources', usage: '/sources', description: 'List files/URLs the last turn actually consulted', surfaces: 'both' },
  { name: '/steps', usage: '/steps', description: 'List the tool calls the last turn made, in order', surfaces: 'both' },
  { name: '/plan', usage: '/plan', description: "Show the active structured plan's task status", surfaces: 'both' },
  { name: '/plan graph', usage: '/plan graph [thread-id]', description: 'Draw the active plan as a dependency graph (needs planGraphMode enabled)', surfaces: 'cli-only', reason: `${APP_CONTROL} (plan graph panel)` },
  { name: '/plan sketch', usage: '/plan sketch <request>', description: 'One-shot, advisory plan sketch — no PlanRecord, nothing staged, cannot execute', surfaces: 'cli-only', reason: 'the apps have no plan-sketch entry point yet' },
  { name: '/goals', usage: '/goals', description: 'Review every known goal thread this session — status, tasks, and visibility (freshly computed / carried over / done / suggested)', surfaces: 'cli-only', reason: `${APP_CONTROL} (Goals panel)` },
  { name: '/config', usage: '/config ...', description: 'View or change persisted settings', surfaces: 'cli-only', reason: `${APP_CONTROL} (Settings)` },
  { name: '/layers settings', usage: '/layers settings', description: 'List reasoning layers with cost/evidence; /layers on|off|reset <id> to change', surfaces: 'cli-only', reason: `${APP_CONTROL} (Settings)` },
  { name: '/checkpoint', usage: '/checkpoint [clear]', description: 'Inspect, or clear, a stuck in-progress harness checkpoint', surfaces: 'cli-only', reason: 'the apps have no checkpoint inspector yet' },
]

/**
 * Capabilities that are CLI-only on purpose and are not slash commands, so they have no registry entry above.
 * Each is a decision of the owner (D5) and carries the reason.
 */
export const CLI_ONLY_FEATURES: { name: string; reason: string }[] = [
  { name: 'email', reason: 'sending needs credentials a browser or webview cannot hold safely' },
]

/** First word of a command name: the key the CLI dispatch table and the composer match on. */
export function commandKey(name: string): string {
  return name.split(' ')[0]
}

/** Every dispatch key a surface must handle: the command keys plus their aliases, for the commands that include that surface. */
export function dispatchKeysFor(surface: 'cli' | 'gui'): string[] {
  const keys = new Set<string>()
  for (const spec of COMMAND_REGISTRY) {
    const included = spec.surfaces === 'both' || spec.surfaces === (surface === 'cli' ? 'cli-only' : 'gui-only')
    if (!included) continue
    keys.add(commandKey(spec.name))
    for (const alias of spec.aliases ?? []) keys.add(alias)
  }
  return [...keys]
}
