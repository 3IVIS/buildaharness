import { useState } from 'react'
import { useDialogs } from './dialogs'
import { Hint } from './Hint'
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
  const dialogs = useDialogs()
  const [draft, setDraft] = useState<WriteConnection>(value)
  const set = (patch: Partial<WriteConnection>): void => setDraft((d) => ({ ...d, ...patch }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(value)
  return (
    <fieldset className="write__form write__connection">
      <legend className="write__panehead">Connection<Hint text="Kept in this browser only, separate from the /try page. Aielia has no account of its own." /></legend>
      <label>Provider
        <select aria-label="Provider" value={draft.provider} onChange={(e) => set({ provider: e.target.value as WriteConnection['provider'] })}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
          <option value="proxy">A proxy I run (self-hosted)</option>
        </select>
      </label>
      {draft.provider === 'proxy' ? (
        <>
          <label>Model proxy<Hint text="Model calls go to a proxy you run, for example one on this computer. Your key, or your Claude login, stays on that machine and never reaches this page." />
            <input aria-label="Model proxy address" inputMode="url" placeholder="http://localhost:8787" value={draft.modelUrl ?? ''} onChange={(e) => set({ modelUrl: e.target.value })} />
          </label>
          <label>Token
            <input aria-label="API key" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
          </label>
        </>
      ) : (
        <label>API key
          <input aria-label="API key" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </label>
      )}
      {showWeb && <details className="write__allsrc" open={Boolean(draft.pagesUrl || draft.searchKey || draft.githubToken)}>
        <summary>Web pages and sources (optional)</summary>
        <label>Page proxy<Hint text="Browsers cannot read most web pages directly, so this page uses the Aielia proxy unless you give your own address. If none works, links stay links and you paste the passage." />
          <input aria-label="Proxy address" inputMode="url" placeholder="https://" value={draft.pagesUrl ?? ''} onChange={(e) => set({ pagesUrl: e.target.value })} />
        </label>
        <label>Page proxy token
          <input aria-label="Proxy access token" type="password" autoComplete="off" value={draft.pagesToken ?? ''} onChange={(e) => set({ pagesToken: e.target.value })} />
        </label>
        <label>GitHub token<Hint text="Only needed to read a private repository, or to avoid GitHub's request limit. Sent only to GitHub." />
          <input aria-label="GitHub token" type="password" autoComplete="off" value={draft.githubToken ?? ''} onChange={(e) => set({ githubToken: e.target.value })} />
        </label>
        <label>Search key<Hint text="A Brave Search key, used to look for sources for a claim. Kept only in this browser." />
          <input aria-label="Search key" type="password" autoComplete="off" value={draft.searchKey ?? ''} onChange={(e) => set({ searchKey: e.target.value })} />
        </label>
      </details>}
      <div className="write__rowacts">
        <button type="button" className="write__primary" disabled={!dirty || (draft.provider === 'proxy' ? !draft.modelUrl?.trim() : !draft.apiKey.trim())} onClick={() => onSave(draft)}>Save connection</button>
        {onForget && <button type="button" className="write__link" onClick={() => { void dialogs.confirm('Forget the key and the other connection settings from this browser? Your articles stay.', { yes: 'Forget' }).then((ok) => { if (ok) onForget() }) }}>Forget these</button>}
      </div>
    </fieldset>
  )
}
