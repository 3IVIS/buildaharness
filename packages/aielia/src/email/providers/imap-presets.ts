/**
 * Host and port presets for common IMAP providers (Email, phase H6a). Plain data. Every entry is marked `untested`
 * until phase H6b runs it against the real service; nothing here has been tried against a real server. Ports are the
 * implicit-TLS ones only (993 for IMAP, 465 for SMTP): the desktop transport refuses any other port.
 */
export interface ImapPreset {
  id: string
  label: string
  imapHost: string
  imapPort: 993
  smtpHost: string
  smtpPort: 465
  /** True when the server files its own copy of a sent message, so the client must not append one. */
  savesSentCopy: boolean
  /** The sign-in this service takes for IMAP. */
  auth: 'app-password' | 'oauth'
  status: 'untested' | 'tested'
}

export const IMAP_PRESETS: readonly ImapPreset[] = [
  { id: 'fastmail', label: 'Fastmail', imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465, savesSentCopy: false, auth: 'app-password', status: 'untested' },
  { id: 'icloud', label: 'iCloud Mail', imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 465, savesSentCopy: false, auth: 'app-password', status: 'untested' },
  { id: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, savesSentCopy: true, auth: 'app-password', status: 'untested' },
  { id: 'gmx', label: 'GMX', imapHost: 'imap.gmx.net', imapPort: 993, smtpHost: 'mail.gmx.net', smtpPort: 465, savesSentCopy: false, auth: 'app-password', status: 'untested' },
  { id: 'posteo', label: 'Posteo', imapHost: 'posteo.de', imapPort: 993, smtpHost: 'posteo.de', smtpPort: 465, savesSentCopy: false, auth: 'app-password', status: 'untested' },
]

export function imapPreset(id: string): ImapPreset | undefined {
  return IMAP_PRESETS.find((p) => p.id === id)
}
