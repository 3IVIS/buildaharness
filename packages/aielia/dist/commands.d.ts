/**
 * The one list of slash commands, and which surface handles each. The CLI's /help is projected from it
 * (cli-session.ts), and two parity tests fail when a surface and this list disagree: cli.test.ts
 * (the dispatch table) and chat-ui's composer-commands.test.ts (the commands the composer intercepts).
 * Pure data: no node:* and no DOM imports, so the browser build can read it.
 */
export type CommandSurfaces = 'both' | 'cli-only' | 'gui-only';
export interface CommandSpec {
    /** The command and any fixed subcommand words, no arguments: '/memory export'. The first word is the dispatch key. */
    name: string;
    /** What /help prints for it, arguments included. */
    usage: string;
    description: string;
    surfaces: CommandSurfaces;
    /** Required unless surfaces is 'both': why the other surface does not have it. 'planned: <phase>' marks a gap the surface-unification plan closes. */
    reason?: string;
    /** Other dispatch keys that run the same command ('/new' for '/clear'). */
    aliases?: string[];
}
export declare const COMMAND_REGISTRY: CommandSpec[];
/**
 * Capabilities that are CLI-only on purpose and are not slash commands, so they have no registry entry above.
 * Each is a decision of the owner (D5) and carries the reason.
 */
export declare const CLI_ONLY_FEATURES: {
    name: string;
    reason: string;
}[];
/** First word of a command name: the key the CLI dispatch table and the composer match on. */
export declare function commandKey(name: string): string;
/** Every dispatch key a surface must handle: the command keys plus their aliases, for the commands that include that surface. */
export declare function dispatchKeysFor(surface: 'cli' | 'gui'): string[];
