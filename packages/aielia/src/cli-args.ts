/**
 * Argv parsing for the `aielia` CLI. Pure — no process access — so it is unit-testable.
 *
 * Before this existed `main()` ignored argv entirely, so recognizing a few explicit cases is
 * strictly additive: anything unrecognized (including no args at all) resolves to `'repl'`,
 * exactly today's behavior.
 */
export type CliCommand =
  | { command: 'repl' }
  | { command: 'version' }
  | { command: 'help' }
  | { command: 'update'; dryRun: boolean }

/** `argv` is the user-supplied arguments only, i.e. `process.argv.slice(2)`. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const first = argv[0]
  if (first === '--version' || first === '-v' || first === 'version') return { command: 'version' }
  if (first === '--help' || first === '-h' || first === 'help') return { command: 'help' }
  if (first === 'update') return { command: 'update', dryRun: argv.slice(1).includes('--dry-run') }
  return { command: 'repl' }
}

export function cliHelpText(version: string): string {
  return [
    `aielia ${version} — an agent you can hand real work to, held in bounds by a harness.`,
    '',
    'Usage:',
    '  aielia                 start the interactive assistant',
    '  aielia update          update to the latest release (standalone binary installs)',
    '  aielia update --dry-run  check for an update without installing it',
    '  aielia --version       print the version',
    '  aielia --help          show this help',
    '',
    'https://myaielia.com',
  ].join('\n')
}
