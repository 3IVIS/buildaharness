import { useEffect, useState } from 'react'
import {
  PROVIDER_SETUP,
  checkApiKeyFormat,
  cleanApiKey,
  testApiKey,
  type AssistantConfig,
  type KeyTestResult,
  type KeyedBackend,
} from '@buildaharness/aielia'

interface Props {
  /** True on the Tauri desktop build — the only place a local `claude` login can be used. */
  isDesktop: boolean
  /** Desktop only: resolves true when an authenticated `claude` CLI is on the machine (the check_claude_available command). */
  detectClaude?: () => Promise<boolean>
  /** Persists the choice and starts the assistant. Rejections are shown inline. */
  onComplete: (patch: Partial<AssistantConfig>) => Promise<void>
  /** "Set up later" — leaves config untouched; the wizard returns on next launch. */
  onSkip: () => void
  /** Test seam — defaults to the real provider check. */
  testKey?: (backend: KeyedBackend, key: string) => Promise<KeyTestResult>
}

type Step = { kind: 'choose' } | { kind: 'key'; backend: KeyedBackend }

/**
 * First-launch setup for the desktop app and the web build: the GUI counterpart of the CLI's
 * first-run.ts, sharing its provider names, key-format checks and live key test through
 * @buildaharness/aielia's provider-setup.ts. Written for someone who has never heard of an API key.
 */
function ExternalLink({ url, label, isDesktop, copied, onCopy }: { url: string; label: string; isDesktop: boolean; copied: boolean; onCopy: (url: string) => Promise<void> }): React.JSX.Element {
  // Desktop's webview has no way to open the system browser, so offer the address to copy instead.
  return isDesktop ? (
    <p className="setup__hint">
      Open <code>{label}</code> in your web browser{' '}
      <button type="button" className="setup__link-button" onClick={() => void onCopy(url)}>Copy link</button>
      {copied ? ' — copied!' : ''}
    </p>
  ) : (
    <p className="setup__hint">
      <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
    </p>
  )
}

export function SetupWizard({ isDesktop, detectClaude, onComplete, onSkip, testKey = testApiKey }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  // undefined = still checking; only ever checked on desktop.
  const [claudeFound, setClaudeFound] = useState<boolean | undefined>(isDesktop && detectClaude ? undefined : false)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isDesktop || !detectClaude) return
    let cancelled = false
    detectClaude().then(
      (found) => { if (!cancelled) setClaudeFound(found) },
      () => { if (!cancelled) setClaudeFound(false) },
    )
    return () => { cancelled = true }
  }, [isDesktop, detectClaude])

  async function finish(patch: Partial<AssistantConfig>): Promise<void> {
    setBusy(true)
    try {
      await onComplete(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong saving your settings. Please try again.')
      setBusy(false)
    }
  }

  async function handleSubmitKey(backend: KeyedBackend, ignoreUnverified: boolean): Promise<void> {
    setError(null)
    if (!ignoreUnverified) setWarning(null)
    const cleaned = cleanApiKey(key)
    const formatProblem = checkApiKeyFormat(backend, cleaned)
    if (formatProblem) {
      setError(formatProblem)
      return
    }
    if (!ignoreUnverified) {
      setBusy(true)
      const result = await testKey(backend, cleaned)
      setBusy(false)
      if (result.status === 'invalid') {
        setError(result.message)
        return
      }
      if (result.status === 'unverified') {
        // Let the user decide rather than silently saving a key that might be wrong.
        setWarning(result.message)
        return
      }
    }
    await finish({ llmBackend: backend, apiKey: cleaned })
  }

  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (step.kind === 'key') {
    const info = PROVIDER_SETUP.find((p) => p.backend === step.backend)!
    return (
      <div className="setup" role="main">
        <div className="setup__card">
          <button type="button" className="setup__back" onClick={() => { setStep({ kind: 'choose' }); setError(null); setWarning(null) }}>
            ← Back
          </button>
          <h1>Connect {info.name}</h1>
          <p>Don’t have an account yet? No problem — here’s how to get a key:</p>
          <ol className="setup__steps">
            {info.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <ExternalLink url={info.keyUrl} label={info.keyUrlLabel} isDesktop={isDesktop} copied={copied} onCopy={copyLink} />
          {info.safety && (
            <details className="setup__safety" open>
              <summary>🛡️ {info.safety.title}</summary>
              <ol className="setup__steps">
                {info.safety.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <ExternalLink url={info.safety.url} label={info.safety.urlLabel} isDesktop={isDesktop} copied={copied} onCopy={copyLink} />
            </details>
          )}
          <p className="setup__hint">
            An API key is like a password that lets Aielia use your {info.name} account. It is stored{' '}
            {isDesktop ? 'in your computer’s secure keychain' : 'only in this browser, on this device'} and is only ever sent to {info.name}.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSubmitKey(step.backend, warning !== null)
            }}
          >
            <label className="setup__label" htmlFor="setup-api-key">API key</label>
            <div className="setup__key-row">
              <input
                id="setup-api-key"
                type={showKey ? 'text' : 'password'}
                value={key}
                onChange={(e) => { setKey(e.target.value); setError(null); setWarning(null) }}
                placeholder={`${info.keyPrefix}…`}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                disabled={busy}
              />
              <button type="button" onClick={() => setShowKey((s) => !s)}>{showKey ? 'Hide' : 'Show'}</button>
            </div>
            {error && <p className="setup__error" role="alert">{error}</p>}
            {warning && <p className="setup__warning" role="status">{warning}</p>}
            <button type="submit" className="setup__primary" disabled={busy || key.trim() === ''}>
              {busy ? 'Checking…' : warning ? 'Continue anyway' : 'Check and start'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="setup" role="main">
      <div className="setup__card">
        <h1>Welcome to Aielia 👋</h1>
        <p>Aielia needs an AI model to think with. Let’s connect one — it takes about a minute.</p>

        {isDesktop && claudeFound === undefined && <p className="setup__hint">Checking whether Claude is already set up on this computer…</p>}

        {isDesktop && claudeFound === true && (
          <button type="button" className="setup__option setup__option--recommended" disabled={busy} onClick={() => void finish({ llmBackend: 'claude-cli' })}>
            <span className="setup__option-title">Use my Claude login <span className="setup__badge">Recommended</span></span>
            <span className="setup__option-desc">
              ✓ Claude is already running on this computer. You can start right now — no API key, nothing to paste.
            </span>
          </button>
        )}

        {isDesktop && claudeFound === false && (
          <p className="setup__hint">
            Already use Claude Code? Install it and sign in (run <code>claude</code> once), then reopen Aielia — you’ll be able to
            start with no API key. Otherwise, pick a provider below.
          </p>
        )}

        {!isDesktop && (
          <p className="setup__hint">
            Tip: the Aielia desktop app and command-line version can use your existing Claude Code login, with no API key at all.
          </p>
        )}

        <h2 className="setup__subhead">{claudeFound ? 'Or use your own API key' : 'Choose a provider'}</h2>
        {PROVIDER_SETUP.map((p) => (
          <button key={p.backend} type="button" className="setup__option" disabled={busy} onClick={() => setStep({ kind: 'key', backend: p.backend })}>
            <span className="setup__option-title">{p.name}{p.backend === 'openrouter' && !claudeFound && <span className="setup__badge">Easiest start</span>}</span>
            <span className="setup__option-desc">{p.blurb}</span>
          </button>
        ))}

        {error && <p className="setup__error" role="alert">{error}</p>}
        <button type="button" className="setup__skip" onClick={onSkip}>Set up later</button>
      </div>
    </div>
  )
}
