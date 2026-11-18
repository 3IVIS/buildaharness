/**
 * `/email <review|catchup|spam|todo|reply|file|rules|undo> [args]` for every surface. Pure: parses the line and words the result; the surface
 * prints or renders it and, when an account is connected, runs the action through the shared mail code. Slash text is the user's
 * own typing: it is matched against the fixed subcommand list only, never against mail text. No `node:*` and no DOM imports.
 */
export const EMAIL_SUBCOMMANDS = ['review', 'catchup', 'spam', 'todo', 'reply', 'file', 'rules', 'undo'] as const
export type EmailSubcommand = (typeof EMAIL_SUBCOMMANDS)[number]

const SUMMARY: Record<EmailSubcommand, string> = {
  review: 'go through new mail with you, one thread at a time',
  catchup: 'review the mail of a time window (7, 30, 90, 365 days or all) and say what needs a response',
  spam: 'list mail that is probably spam and propose moving it to Junk (nothing is deleted; you accept the preview)',
  todo: 'show your to-do list: do now, schedule, quick answers, can wait',
  reply: 'draft a reply to a thread (it is staged; sending needs your approval)',
  file: 'propose folders or labels for mail (nothing moves until you accept)',
  rules: 'show or change your filing and triage rules',
  undo: 'undo the last mail change Aielia made',
}

export type EmailCommand =
  | { kind: 'help'; message: string }
  | { kind: 'unknown'; word: string; message: string }
  | { kind: 'run'; sub: EmailSubcommand; args: string[]; message: string }

export function emailUsageLines(): string[] {
  return ['/email <subcommand>:', ...EMAIL_SUBCOMMANDS.map((s) => `  /email ${s}${s === 'reply' || s === 'file' ? ' [thread]' : s === 'catchup' ? ' [7|30|90|365|all]' : s === 'spam' ? ' [move]' : ''} — ${SUMMARY[s]}`)]
}

export function parseEmailCommand(args: readonly string[]): EmailCommand {
  const first = args[0]
  if (!first) return { kind: 'help', message: emailUsageLines().join('\n') }
  const word = first.toLowerCase()
  const sub = EMAIL_SUBCOMMANDS.find((s) => s === word)
  if (!sub) return { kind: 'unknown', word: first, message: `Unknown /email subcommand "${first}".\n${emailUsageLines().join('\n')}` }
  return { kind: 'run', sub, args: args.slice(1), message: `/email ${sub}: ${SUMMARY[sub]}` }
}

/** What a surface says for a parsed command. `connected` is whether a mail account is set up; the action itself runs through the shared mail code the surface supplies. */
export function formatEmailCommand(command: EmailCommand, connected: boolean): string[] {
  if (command.kind !== 'run') return command.message.split('\n')
  if (!connected) return [command.message, 'No mail account is connected yet. Connect one first, then try again.']
  return [command.message]
}
