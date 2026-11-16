import { useState } from 'react'
import { PRIVACY_URL, TERMS_URL } from '@buildaharness/aielia'
import { ConnectionSettings } from '../write/ConnectionSettings'
import { DialogProvider } from '../shared-ui/dialogs'
import { ProxyNotice } from '../components/ProxyNotice'
import { nextFirstRunStep, type EmailConnection, type FirstRunState } from './email-config'

export type MailKind = 'gmail' | 'graph'

interface Props {
  state: FirstRunState
  /** Starts the sign-in for a mail provider. Absent while sign-in is not wired in this build: the buttons then say so instead of doing nothing. */
  onConnectAccount?: (kind: MailKind) => void
  onSaveConnection: (c: EmailConnection) => void
  /** Leave first run and look around the sample mailbox. */
  onSample: () => void
}

/**
 * First run, in order: connect a mail account, then connect an AI (OpenRouter first; the key is entered here because Email is its own origin).
 * Nobody has to finish either to look around: the sample mailbox is one click away at every step.
 */
export function FirstRun({ state, onConnectAccount, onSaveConnection, onSample }: Props): React.JSX.Element {
  const step = nextFirstRunStep(state)
  const [draft] = useState<EmailConnection>({ provider: 'openrouter', apiKey: '' })
  return (
    <div className="write write--setup email-firstrun">
      <header className="write__bar">
        <h1 className="write__title"><a className="brand-link" href="https://myaielia.com" target="_blank" rel="noopener noreferrer" title="Go to myaielia.com">Aielia</a> Email</h1>
        <span className="write__badge" title="Early-stage alpha software — expect rough edges and breaking changes.">Alpha</span>
      </header>
      <main className="write__setup">
        <div className="write__setupcard">
          <p className="write__muted" aria-label="Step">Step {step === 'account' ? 1 : 2} of 2</p>
          {step === 'account' && (
            <section aria-label="Connect your mail">
              <h2>Connect your mail</h2>
              <p className="write__muted">Aielia reads and sorts your mail only after you sign in, and only while its switch for this account is on. Your mail stays in this browser.</p>
              <div className="email-firstrun__providers">
                <button type="button" onClick={() => onConnectAccount?.('gmail')} disabled={!onConnectAccount}>Connect Gmail</button>
                <button type="button" onClick={() => onConnectAccount?.('graph')} disabled={!onConnectAccount}>Connect Outlook</button>
              </div>
              {!onConnectAccount && <p className="write__muted" role="note">Signing in to a mail account is not available in this build yet. You can look around the sample mailbox meanwhile.</p>}
            </section>
          )}
          {step === 'ai' && (
            <section aria-label="Connect your AI">
              <h2>Connect your AI</h2>
              <p className="write__muted">Aielia has no account of its own. Add a key from a model provider; the key stays in this browser and is separate from Chat and Write.</p>
              <DialogProvider><ConnectionSettings value={draft} onSave={onSaveConnection} showWeb={false} /></DialogProvider>
            </section>
          )}
          <button type="button" className="write__link" onClick={onSample}>Look around a sample mailbox first</button>
        </div>
        <div className="write__setupfoot">
          <ProxyNotice bare />
          <p>By using Aielia you agree to the <a href={TERMS_URL} target="_blank" rel="noreferrer">Terms</a> and acknowledge the <a href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy Policy</a>.</p>
        </div>
      </main>
    </div>
  )
}
