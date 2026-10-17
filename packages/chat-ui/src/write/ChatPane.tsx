import { AdjustBar, type ChatAction } from './AdjustBar'
import { ModelPicker } from './ModelPicker'
import { ICON_PATHS, Icon, IconButton } from './icons'

export interface ChatLine {
  id: number
  from: 'you' | 'aielia'
  text: string
  model?: string
}

interface Props {
  lines: ChatLine[]
  model: string
  suggestions: string[]
  onModel: (model: string) => void
  input: string
  onInput: (value: string) => void
  edits: boolean
  onEdits: (value: boolean) => void
  busy: boolean
  canAct: boolean
  shown: boolean
  onSend: () => void
  onAdjust: (message: string) => void
  onAction: (action: ChatAction) => void
  onSaveIdea: (line: ChatLine) => void
  /** Repositories handed to the open article, and what the chat menu does with them: run the check against a typed address or the attached ones. */
  repos: string[]
  onRepoVerify: (address: string) => void
  onPickRepoFolder?: () => void
  onRemoveRepo: (name: string) => void
  onDropFiles: (files: File[]) => void
  /** Closes the chat sheet on a phone. */
  onClose: () => void
}

/** The chat: always visible on a wide screen. The model is picked next to the title; every answer says which model wrote it. */
export function ChatPane(p: Props): React.JSX.Element {
  return (
    <section
      className={`write__pane write__pane--chat ${p.shown ? 'is-shown' : ''}`}
      aria-label="Chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const files = Array.from(e.dataTransfer.files); if (files.length > 0) p.onDropFiles(files) }}
    >
      <header className="write__chathead">
        <h2 className="write__panehead">Chat</h2>
        <ModelPicker label="Model for the chat" value={p.model} suggestions={p.suggestions} onChange={p.onModel} />
        <IconButton label="Close the chat" icon="close" className="write__chatclose" onClick={p.onClose} />
      </header>
      <ul className="write__chat" aria-live="polite">
        {p.lines.map((l) => (
          <li key={l.id} className={`write__line write__line--${l.from}`}>
            <div>{l.text}</div>
            {l.from === 'aielia' && l.model && (
              <div className="write__linemeta">
                <span className="write__linemodel" title="The model that wrote this">{l.model}</span>
                {p.canAct && <button type="button" className="write__link" onClick={() => p.onSaveIdea(l)}>Save to ideas</button>}
              </div>
            )}
          </li>
        ))}
        {p.lines.length === 0 && <li className="write__muted">Talk to Aielia about the article, paste reviewer comments, or drop a file here to use it as a source.</li>}
      </ul>
      <AdjustBar disabled={p.busy || !p.canAct} checkLabel={`Check the article with ${p.model}`} verifyLabel="Verify the claims and look for sources" repos={p.repos} onRepoVerify={p.onRepoVerify} onPickRepoFolder={p.onPickRepoFolder} onRemoveRepo={p.onRemoveRepo} onSend={p.onAdjust} onAction={p.onAction} />
      <div className="write__compose">
        <textarea
          aria-label="Message"
          value={p.input}
          rows={3}
          onChange={(e) => p.onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!p.busy && p.input.trim()) p.onSend() } }}
          placeholder="Message Aielia. Enter sends, Shift+Enter starts a new line."
        />
        <div className="write__composebar">
          <label className="write__switch2" title="Turn what you ask for into suggested changes to the text">
            <input type="checkbox" checked={p.edits} onChange={(e) => p.onEdits(e.target.checked)} aria-label="Suggest edits" /> Suggest edits
          </label>
          <button type="button" className="write__iconbtn write__send" aria-label="Send" title="Send" onClick={p.onSend} disabled={p.busy || !p.input.trim()}><Icon d={ICON_PATHS.write} /></button>
        </div>
      </div>
    </section>
  )
}
