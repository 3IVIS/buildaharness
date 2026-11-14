import { AdjustBar, type ChatAction } from './AdjustBar'
import { ChatPane as SharedChatPane, type ChatLine as SharedChatLine } from '../shared-ui/ChatPane'

export { RECORD_HINT, type WorkProgress } from '../shared-ui/ChatPane'

export type ChatMode = 'auto' | 'answer' | 'suggest' | 'edit'

/** The reply changed the article: the version saved just before (by its label) and a fingerprint of the text after, so a resend can put the article back unless the writer has changed it since. */
export type ChatLine = SharedChatLine<{ articleId: string; label: string; after: string }>

/** What hovering the mode box says: what the mode does, and that picking anything but Auto turns the automatic reading of messages off. */
const MODE_HINT: Record<ChatMode, string> = {
  auto: 'Auto: Aielia reads each message and decides whether to edit the text, suggest changes or just answer. Choosing any other mode turns this automatic detection off until you change it back to Auto.',
  answer: 'Automatic detection is off: every message is only answered, and the text is never changed. Choose Auto to let Aielia decide from each message.',
  suggest: 'Automatic detection is off: every request for a change becomes suggestions to accept or reject. Choose Auto to let Aielia decide from each message.',
  edit: 'Automatic detection is off: every request for a change is made in the text, after saving a version first so it can be undone from History. Choose Auto to let Aielia decide from each message.',
}

type SharedProps = Parameters<typeof SharedChatPane>[0]

interface Props extends Omit<SharedProps, 'mode' | 'toolbar' | 'lines'> {
  lines: ChatLine[]
  /** What a request for a change does: only answers, suggests changes to accept, or makes the edit (after saving a version). */
  mode: ChatMode
  onMode: (mode: ChatMode) => void
  /** What "edit" edits where the writer is now: the article, or its outline. */
  editLabel: string
  canAct: boolean
  onAdjust: (message: string) => void
  onAction: (action: ChatAction) => void
  /** Repositories handed to the open article, and what the chat menu does with them: run the check against a typed address or the attached ones. */
  repos: string[]
  onRepoVerify: (address: string) => void
  onPickRepoFolder?: () => void
  onRemoveRepo: (name: string) => void
}

/** The chat of the Write app: the shared chat pane with Write's modes, adjust bar and empty-chat line. */
export function ChatPane({ mode, onMode, editLabel, canAct, onAdjust, onAction, repos, onRepoVerify, onPickRepoFolder, onRemoveRepo, ...rest }: Props): React.JSX.Element {
  return (
    <SharedChatPane
      {...rest}
      emptyText="Talk to Aielia about the article, paste reviewer comments, or drop a file here to use it as a source."
      mode={{
        value: mode,
        hints: MODE_HINT,
        onChange: (v) => onMode(v as ChatMode),
        options: [
          { value: 'auto', label: 'Auto (from your message)' },
          { value: 'answer', label: 'Just answer' },
          { value: 'suggest', label: 'Suggest edits' },
          { value: 'edit', label: editLabel },
        ],
      }}
      toolbar={<AdjustBar disabled={rest.busy || !canAct} checkLabel="Find the factual claims and check them against their sources" verifyLabel="Search the web for sources and verify the claims" repos={repos} onRepoVerify={onRepoVerify} onPickRepoFolder={onPickRepoFolder} onRemoveRepo={onRemoveRepo} onSend={onAdjust} onAction={onAction} />}
    />
  )
}
