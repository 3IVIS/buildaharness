import { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { nodeDisplayName, type RiskLevel, type AssistantTrace, type AssistantSource, type AssistantToolStep } from '@buildaharness/personal-assistant'

// A <table> laid out at its natural (often wider-than-bubble) width needs its own scroll
// container — putting overflow-x directly on the <table> element instead breaks browsers'
// table column-width algorithm (columns render collapsed/skewed rather than content-sized).
const MARKDOWN_COMPONENTS: Components = {
  table: ({ children }) => <div className="bubble__table-scroll"><table>{children}</table></div>,
}

interface Props {
  role: 'user' | 'assistant' | 'error'
  content: string
  riskLevel?: RiskLevel
  trace?: AssistantTrace
  sources?: AssistantSource[]
  toolSteps?: AssistantToolStep[]
  onRetry?: () => void
}

// Buckets the harness's 0–1 verification scores into plain language rather than
// surfacing raw floats — this is a confidence readout, not a debug metric.
function verificationHealthLabel({ strength, feasibility }: AssistantTrace['verificationHealth']): string {
  const confidence = Math.min(strength, feasibility)
  if (confidence >= 0.7) return 'High confidence'
  if (confidence >= 0.4) return 'Reasonably confident'
  return 'Worth double-checking'
}

const SOURCE_TOOL_LABEL: Record<AssistantSource['tool'], string> = {
  read_file: 'Read',
  list_directory: 'Listed',
  web_search: 'Searched',
  fetch_url: 'Fetched',
}

// web_search/fetch_url pull in untrusted external content (see trust-tagging.ts) —
// flagged distinctly so a reply's sources make clear which ones the assistant
// doesn't vouch for the same way it does its own workspace files.
const EXTERNAL_SOURCE_TOOLS: ReadonlySet<AssistantSource['tool']> = new Set(['web_search', 'fetch_url'])

export function ChatMessageBubble({ role, content, riskLevel, trace, sources, toolSteps, onRetry }: Props): React.JSX.Element {
  const [showWhy, setShowWhy] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [showSteps, setShowSteps] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`bubble bubble--${role}`}>
      <button type="button" className="bubble__copy" onClick={handleCopy} aria-label="Copy message">
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="bubble__role">
        {role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'Error'}
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
      {sources && sources.length > 0 && (
        <div className="bubble__why">
          <button type="button" className="bubble__why-toggle" onClick={() => setShowSources((v) => !v)}>
            {showSources ? 'Hide sources' : `Sources (${sources.length})`}
          </button>
          {showSources && (
            <div className="bubble__why-detail">
              <ul className="bubble__why-steps">
                {sources.map((source, i) => (
                  <li key={`${source.tool}-${source.path}-${i}`}>
                    {SOURCE_TOOL_LABEL[source.tool]} <code>{source.path}</code>
                    {EXTERNAL_SOURCE_TOOLS.has(source.tool) && <span className="bubble__source-external"> (external)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {toolSteps && toolSteps.length > 0 && (
        <div className="bubble__why">
          <button type="button" className="bubble__why-toggle" onClick={() => setShowSteps((v) => !v)}>
            {showSteps ? 'Hide steps' : `Steps (${toolSteps.length})`}
          </button>
          {showSteps && (
            <div className="bubble__why-detail">
              <ol className="bubble__why-steps">
                {toolSteps.map((step, i) => (
                  <li key={i}>{step.summary}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
      {trace && (
        <div className="bubble__why">
          <button type="button" className="bubble__why-toggle" onClick={() => setShowWhy((v) => !v)}>
            {showWhy ? 'Hide why' : 'Why?'}
          </button>
          {showWhy && (
            <div className="bubble__why-detail">
              <div className="bubble__why-confidence">{verificationHealthLabel(trace.verificationHealth)}</div>
              <ol className="bubble__why-steps">
                {trace.nodeExecutionOrder.map((node, i) => (
                  <li key={`${node}-${i}`}>{nodeDisplayName(node)}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
