/**
 * Argv parsing for the `aielia` CLI. Pure — no process access — so it is unit-testable.
 *
 * Before this existed `main()` ignored argv entirely, so recognizing a few explicit cases is
 * strictly additive: anything unrecognized (including no args at all) resolves to `'repl'`,
 * exactly today's behavior.
 */
export type CliCommand = {
    command: 'repl';
} | {
    command: 'version';
} | {
    command: 'help';
} | {
    command: 'update';
    dryRun: boolean;
};
/** `argv` is the user-supplied arguments only, i.e. `process.argv.slice(2)`. */
export declare function parseCliArgs(argv: readonly string[]): CliCommand;
export declare function cliHelpText(version: string): string;
