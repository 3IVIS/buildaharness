import { useState } from 'react'
import type { WriteConnection } from './write-config'

interface Props {
  value: WriteConnection
  onSave: (c: WriteConnection) => void
  /** Absent on the first visit, when there is nothing to forget. */
  onForget?: () => void
  /** The optional page-reading and search fields. Left out on the first visit, which asks only how to reach a model; they are in Settings. */
  showWeb?: boolean
}

/** The few things this page needs to reach a model and the web. Stored in this browser only, apart from the /try page's settings. */
export function ConnectionSettings({ value, onSave, onForget, showWeb = true }: Props): React.JSX.Element {
  const [draft, setDraft] = useState<WriteConnection>(value)
  const set = (patch: Partial<WriteConnection>): void => setDraft((d) => ({ ...d, ...patch }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(value)
  return (
    <fieldset className="write__form write__connection">
      <legend className="write__panehead">Connection</legend>
      <p className="write__muted">Kept in this browser only, and separate from the /try page. Aielia has no account of its own.</p>
      <label>Model provider
        <select aria-label="Provider" value={draft.provider} onChange={(e) => set({ provider: e.target.value as WriteConnection['provider'] })}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
          <option value="proxy">A proxy I run (self-hosted)</option>
        </select>
      </label>
      {draft.provider === 'proxy' ? (
        <>
          <p className="write__muted">Model calls go to a proxy you run, for example one on this computer. Your key, or your Claude login, stays on that machine and never reaches this page.</p>
          <label>Proxy address for the model
            <input aria-label="Model proxy address" inputMode="url" placeholder="http://localhost:8787" value={draft.modelUrl ?? ''} onChange={(e) => set({ modelUrl: e.target.value })} />
          </label>
          <label>Access token for that proxy
            <input aria-label="API key" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
          </label>
        </>
      ) : (
        <label>Your key for that provider
          <input aria-label="API key" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </label>
      )}
      {showWeb && <details className="write__allsrc" open={Boolean(draft.pagesUrl || draft.searchKey)}>
        <summary>Reading web pages and finding sources (optional)</summary>
        <p className="write__muted">Browsers cannot read most web pages directly. This page uses the Aielia proxy for it unless you give your own address. If none works, links stay links and you paste the passage.</p>
        <label>Proxy address
          <input aria-label="Proxy address" inputMode="url" placeholder="https://" value={draft.pagesUrl ?? ''} onChange={(e) => set({ pagesUrl: e.target.value })} />
        </label>
        <label>Proxy access token
          <input aria-label="Proxy access token" type="password" autoComplete="off" value={draft.pagesToken ?? ''} onChange={(e) => set({ pagesToken: e.target.value })} />
        </label>
        <label>Brave Search key (for finding sources)
          <input aria-label="Search key" type="password" autoComplete="off" value={draft.searchKey ?? ''} onChange={(e) => set({ searchKey: e.target.value })} />
        </label>
      </details>}
      <div className="write__rowacts">
        <button type="button" className="write__primary" disabled={!dirty || (draft.provider === 'proxy' ? !draft.modelUrl?.trim() : !draft.apiKey.trim())} onClick={() => onSave(draft)}>Save connection</button>
        {onForget && <button type="button" className="write__link" onClick={() => { if (window.confirm('Forget the key and the other connection settings from this browser? Your articles stay.')) onForget() }}>Forget these</button>}
      </div>
      <p className="write__muted">Saving reconnects the page. Your articles are not touched.</p>
    </fieldset>
  )
}
