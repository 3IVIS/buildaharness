import { useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RiskLevel, AssistantTurnResult } from '@buildaharness/aielia'

// A <table> laid out at its natural (often wider-than-bubble) width needs its own scroll
// container — putting overflow-x directly on the <table> element instead breaks browsers'
// table column-width algorithm (columns render collapsed/skewed rather than content-sized).
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  // react-markdown renders a fenced block as <pre><code class="language-x">; the label comes from that class.
  const codeChild = Array.isArray(children) ? children[0] : children
  const className = (codeChild as { props?: { className?: string } } | null)?.props?.className ?? ''
  const language = /language-(\S+)/.exec(className)?.[1]

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(preRef.current?.textContent ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="bubble__code">
      <div className="bubble__code-bar">
        <span className="bubble__code-lang">{language ?? 'code'}</span>
        <button type="button" className="bubble__code-copy" onClick={handleCopy} aria-label="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  table: ({ children }) => <div className="bubble__table-scroll"><table>{children}</table></div>,
  // Assistant replies can echo attacker-controlled text from fetched pages/files. An auto-loading
  // <img> would let injected markdown exfiltrate conversation data through its URL query string with
  // no click, so images are never fetched — shown as inert text instead.
  img: ({ src, alt }) => <span className="bubble__blocked-image">[image not loaded{alt ? `: ${alt}` : ''}{typeof src === 'string' && src ? ` (${src})` : ''}]</span>,
  // Never navigate the app window itself (desktop webview) away from the app.
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
}

interface Props {
  role: 'user' | 'assistant' | 'error'
  content: string
  riskLevel?: RiskLevel
  /**
   * Which proposer drove this turn (see AssistantTurnResult.proposerKind). Rendered only as a
   * hidden `data-testid="proposer-kind"` element, and only in a dev/E2E build — a test affordance
   * for the internal plan phase B1's flag-OFF-vs-ON parity assertions, never a
   * user-facing or documented public surface.
   */
  proposerKind?: AssistantTurnResult['proposerKind']
  onRetry?: () => void
}

/** True in `vite dev`, an explicit `VITE_E2E=1` preview build, or under the test runner — never a production bundle. */
const SHOW_E2E_AFFORDANCES = import.meta.env.DEV || import.meta.env.MODE === 'test' || import.meta.env.VITE_E2E === '1'

// A bubble is just the message. The explanation of a turn (/why, /layers, /sources, /steps, /plan) is
// shown only when the user asks for it, the same as in the CLI — see ExplainBubble and run-explain.ts.
export function ChatMessageBubble({ role, content, riskLevel, proposerKind, onRetry }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`bubble bubble--${role}`}>
      {SHOW_E2E_AFFORDANCES && proposerKind && (
        <span data-testid="proposer-kind" hidden>{proposerKind}</span>
      )}
      <button type="button" className="bubble__copy" onClick={handleCopy} aria-label="Copy message">
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="bubble__role">
        {role === 'user' ? 'You' : role === 'assistant' ? 'Aielia' : 'Error'}
        {/* LOW is the common case — rendering nothing for it keeps the badge meaningful when it appears. */}
        {riskLevel && riskLevel !== 'LOW' && (
          <span className={`risk-badge risk-badge--${riskLevel.toLowerCase()}`}>{riskLevel}</span>
        )}
      </div>
      {/* Only assistant replies are markdown — a user's own typed text and our own fixed error copy are shown verbatim. */}
      {role === 'assistant' ? (
        <div className="bubble__content bubble__content--markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="bubble__content">{content}</div>
      )}
      {onRetry && (
        <button type="button" className="bubble__retry" onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}

/** The answer to /why, /layers, /sources, /steps or /plan: the same lines the CLI prints (run-explain.ts), as plain text under the command that asked for them. */
export function ExplainBubble({ command, lines }: { command: string; lines: string[] }): React.JSX.Element {
  return (
    <div className="bubble bubble--assistant bubble--explain" data-testid="explain-bubble">
      <div className="bubble__role">{command}</div>
      <pre className="bubble__explain">{lines.join('\n')}</pre>
    </div>
  )
}
