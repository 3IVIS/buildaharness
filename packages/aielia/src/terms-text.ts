/**
 * The wording and version of the first-run terms notice, shared by the CLI (terms-notice.ts) and
 * chat-ui's desktop gate. Browser-safe: no Node imports. Bump TERMS_VERSION whenever the Terms or
 * Privacy Policy change in a way people must re-acknowledge; every surface then asks again once.
 */
export const TERMS_VERSION = '2026-10-31'
export const TERMS_URL = 'https://myaielia.com/terms.html'
export const PRIVACY_URL = 'https://myaielia.com/privacy.html'

/** Printed by the CLI before the provider setup. */
export const CLI_TERMS_LINES: readonly string[] = [
  'Before you start',
  '  Aielia runs on your computer. Your conversations and files stay here, except what is sent to the',
  '  AI provider you choose (using your own API key).',
  '  Aielia also checks myaielia.com once a day for a new version (a plain request; no account, no',
  '  identifiers). Turn it off any time: /config set updateCheck disabled',
  `  Terms:   ${TERMS_URL}`,
  `  Privacy: ${PRIVACY_URL}`,
]

export const CLI_TERMS_PROMPT = 'Press Enter to accept the Terms and continue, or Ctrl+C to quit. '

/** Shown in the desktop app's first-launch dialog. */
export const DESKTOP_TERMS_BODY =
  'Aielia runs on your computer. What you type and the files you let it read go to the AI provider you choose, using your own API key, and nowhere else. Web search and page fetches go straight from this app to the services you configure.'
