/**
 * One-time terms notice for the CLI. Printed before the first-run setup, and acknowledged by pressing
 * Enter. The acknowledgement (the terms version) is stored beside the update-check cache, so a new
 * TERMS_VERSION asks once more. Scripted/piped runs (no TTY) skip it entirely — there is nobody to ask.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLI_TERMS_LINES, CLI_TERMS_PROMPT, TERMS_VERSION } from './terms-text.js'

const defaultDataDir = (): string => join(homedir(), '.buildaharness', 'personal-assistant')
const ackPath = (dataDir: string): string => join(dataDir, 'terms-accepted.json')

export function hasAcceptedTerms(dataDir: string = defaultDataDir()): boolean {
  try {
    const parsed = JSON.parse(readFileSync(ackPath(dataDir), 'utf8')) as { version?: unknown }
    return parsed.version === TERMS_VERSION
  } catch {
    return false
  }
}

export interface TermsNoticeDeps {
  isInteractive: boolean
  ask: (question: string) => Promise<string>
  log: (line: string) => void
  dataDir?: string
  now?: () => Date
}

/** Shows the notice if this terms version hasn't been acknowledged yet. Returns true when it was shown and accepted. */
export async function maybeShowTermsNotice(deps: TermsNoticeDeps): Promise<boolean> {
  const dataDir = deps.dataDir ?? defaultDataDir()
  if (!deps.isInteractive || hasAcceptedTerms(dataDir)) return false
  deps.log('')
  for (const line of CLI_TERMS_LINES) deps.log(line)
  deps.log('')
  await deps.ask(CLI_TERMS_PROMPT)
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(ackPath(dataDir), JSON.stringify({ version: TERMS_VERSION, acceptedAt: (deps.now?.() ?? new Date()).toISOString() }))
  } catch {
    // An unwritable data dir only means we ask again next launch.
  }
  return true
}
