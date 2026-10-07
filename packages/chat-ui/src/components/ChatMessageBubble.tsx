import { useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  buildWhyChain,
  summarizeSettledToolStep,
  lowerConfidenceSourceLines,
  LAYER_ORDER,
  LAYER_SHORT_CODE,
  LAYER_DISPLAY_NAME,
  type RiskLevel,
  type AssistantTrace,
  type AssistantSource,
  type AssistantToolStep,
  type AssistantTurnResult,
  type AnswerClaim,
  type MemoryInjection,
  formatMemoryInjection,
} from '@buildaharness/aielia'

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

// The harness often loops the same few layers (HY > DG > EX, HY > DG > EX, ...). Folds immediately
// repeated runs of 1–4 layers into one entry with a count, keeping the first occurrence's reasons.
type WhyItem = ReturnType<typeof buildWhyChain>[number]

function collapseWhyChain(chain: WhyItem[]): Array<{ items: WhyItem[]; count: number }> {
  const out: Array<{ items: WhyItem[]; count: number }> = []
  let i = 0
  while (i < chain.length) {
    let folded = false
    for (let len = 1; len <= 4 && !folded; len++) {
      let reps = 1
      while (
        i + (reps + 1) * len <= chain.length &&
        chain.slice(i, i + len).every((item, k) => item.layer === chain[i + reps * len + k]?.layer)
      ) reps++
      if (reps > 1) {
        out.push({ items: chain.slice(i, i + len), count: reps })
        i += reps * len
        folded = true
      }
    }
    if (!folded) { out.push({ items: [chain[i]!], count: 1 }); i++ }
  }
  return out
}

interface Props {
  role: 'user' | 'assistant' | 'error'
  content: string
  riskLevel?: RiskLevel
  trace?: AssistantTrace
  harnessSkipped?: boolean
  sources?: AssistantSource[]
  toolSteps?: AssistantToolStep[]
  planStatus?: AssistantTurnResult['planStatus']
  /** Set only when planGraphMode is enabled: renders a "View as graph" link under the plan checklist. */
  onViewPlanGraph?: () => void
  answerClaim?: AnswerClaim
  /** M6: which stored facts were in this turn's prompt, and how many were not shown — rendered in the "Why?" panel via the same formatter the CLI's /why uses. */
  memoryInjection?: MemoryInjection
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

// Same icon convention plan-store.ts's STATUS_ICON / cli.ts's PLAN_TASK_STATUS_ICON already
// use — kept in sync by hand rather than importing a string-keyed const across the package
// boundary just for four glyphs.
const PLAN_TASK_STATUS_ICON: Record<string, string> = {
  PENDING: '○', RUNNING: '▶', COMPLETE: '✓', FAILED: '✗', BLOCKED: '✗', HUMAN_REQUIRED: '~',
}

// Buckets the harness's 0–1 verification scores into plain language rather than
// surfacing raw floats — this is a confidence readout, not a debug metric.
function verificationHealthLabel({ strength, feasibility }: AssistantTrace['verificationHealth']): string {
  const confidence = Math.min(strength, feasibility)
  if (confidence >= 0.7) return 'High confidence'
  if (confidence >= 0.4) return 'Reasonably confident'
  return 'Worth double-checking'
}

// Phase 6 of the harness/assistant remediation plan: the one place that turns AnswerClaim's
// mechanically-derived verification_status into the actual "this is true" vs "I found X but
// couldn't independently verify it" text distinction — kept as one pure, directly-testable
// function (see ChatMessageBubble.test.tsx's golden-output test) so a future change can't
// silently collapse the four branches back into one generic phrasing.
export function answerClaimLabel(claim: AnswerClaim): string {
  switch (claim.verification_status) {
    case 'verified':
      return 'Checked against the source material I read — the reply matches it.'
    case 'unverified_attempted':
      if (claim.grounding_note) return `I found evidence for this, but the reply doesn't fully match it: ${claim.grounding_note}`
      return "I found evidence for this, but couldn't independently verify it."
    case 'contradicted':
      return 'This conflicts with something I already believe — worth double-checking.'
    case 'no_evidence':
      return "This is my own reasoning, not backed by anything I looked up."
  }
}

// Present only on a batch-research turn (see AssistantTrace.batchBudget's doc comment in
// assistant.ts) — every other turn's trace has no batchBudget to summarize.
type BatchBudget = NonNullable<AssistantTrace['batchBudget']>

function batchOutcomeCounts(batchBudget: BatchBudget): { found: number; notFound: number; truncated: number } {
  return {
    found: batchBudget.perItemOutcomes.filter((o) => o.status === 'found').length,
    notFound: batchBudget.perItemOutcomes.filter((o) => o.status === 'not_found').length,
    truncated: batchBudget.perItemOutcomes.filter((o) => o.status === 'truncated_while_productive').length,
  }
}

// Same icon convention as PLAN_TASK_STATUS_ICON above / cli.ts's mirrored STATUS_MARK.
const BATCH_STATUS_ICON: Record<BatchBudget['perItemOutcomes'][number]['status'], string> = {
  found: '✓', not_found: '✗', truncated_while_productive: '~',
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

export function ChatMessageBubble({ role, content, riskLevel, trace, harnessSkipped, sources, toolSteps, planStatus, onViewPlanGraph, answerClaim, memoryInjection, proposerKind, onRetry }: Props): React.JSX.Element {
  const [showWhy, setShowWhy] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [showSteps, setShowSteps] = useState(false)
  const [showRunDetail, setShowRunDetail] = useState(false)
  const [copied, setCopied] = useState(false)

  // The same file/URL read twice in one turn is still one cited source.
  const uniqueSources = (sources ?? []).filter(
    (source, i, all) => all.findIndex((o) => o.tool === source.tool && o.path === source.path) === i,
  )
  const hasDetails = uniqueSources.length > 0 || (toolSteps?.length ?? 0) > 0 || !!trace || !!planStatus

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
      {hasDetails && (
        <div className="bubble__details" role="group" aria-label="Details">
          <span className="bubble__details-label">Details</span>
          {uniqueSources.length > 0 && (
            <button type="button" className="bubble__why-toggle" aria-pressed={showSources} onClick={() => setShowSources((v) => !v)}>
              {showSources ? 'Hide sources' : `Sources (${uniqueSources.length})`}
            </button>
          )}
          {toolSteps && toolSteps.length > 0 && (
            <button type="button" className="bubble__why-toggle" aria-pressed={showSteps} onClick={() => setShowSteps((v) => !v)}>
              {showSteps ? 'Hide steps' : `Steps (${toolSteps.length})`}
            </button>
          )}
          {trace && (
            <button type="button" className="bubble__why-toggle" aria-pressed={showWhy} onClick={() => setShowWhy((v) => !v)}>
              {showWhy ? 'Hide why' : 'Why?'}
            </button>
          )}
          {(trace || planStatus) && (
            <button type="button" className="bubble__why-toggle" aria-pressed={showRunDetail} onClick={() => setShowRunDetail((v) => !v)}>
              {showRunDetail ? 'Hide run detail' : 'Run detail ▾'}
            </button>
          )}
        </div>
      )}
      {uniqueSources.length > 0 && (
        <div className="bubble__why">
          {showSources && (
            <div className="bubble__why-detail">
              <ul className="bubble__why-steps">
                {uniqueSources.map((source, i) => (
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
          {showSteps && (
            <div className="bubble__why-detail">
              <ol className="bubble__why-steps">
                {toolSteps.map((step, i) => (
                  <li key={i}>{step.deniedReason ? step.summary : summarizeSettledToolStep(step.tool, step.input)}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
      {trace && (
        <div className="bubble__why">
          {showWhy && (
            <div className="bubble__why-detail">
              {memoryInjection && <pre className="bubble__why-memory" data-testid="why-memory">{formatMemoryInjection(memoryInjection)}</pre>}
              {harnessSkipped ? (
                <div className="bubble__why-confidence">
                  This looked like a simple, self-contained question, so it was answered directly
                  without activating the harness — no evidence gathering, verification, or review
                  pass ran for this turn.
                </div>
              ) : (
                <>
                  <div className="bubble__why-confidence">{verificationHealthLabel(trace.verificationHealth)}</div>
                  {answerClaim && <div className="bubble__why-confidence">{answerClaimLabel(answerClaim)}</div>}
                  {answerClaim && lowerConfidenceSourceLines(answerClaim).map((line) => (
                    <div key={line} className="bubble__why-confidence">{line}</div>
                  ))}
                  {/* Only layers that actually fired, chained in the order they fired — quiet
                      otherwise (Phase 3.1 of the harness layer activation plan: the common,
                      unremarkable turn stays quiet, matching the "don't badge LOW risk"
                      convention above). The full fired/skipped picture for all 11 is one toggle
                      down, in "Run detail". */}
                  {(() => {
                    const chain = collapseWhyChain(buildWhyChain(trace.layerActivity))
                    return chain.length > 0 ? (
                      <>
                        <div className="bubble__why-chain">
                          {chain.map((group, i) => (
                            <span key={`${group.items[0]!.layer}-${i}`} className="bubble__why-chain-item">
                              {i > 0 && <span className="bubble__why-chain-arrow"> {'>'} </span>}
                              {group.count > 1 && <span className="bubble__why-chain-count">(</span>}
                              {group.items.map((item, k) => (
                                <span key={`${item.layer}-${k}`}>
                                  {k > 0 && <span className="bubble__why-chain-arrow"> {'>'} </span>}
                                  <span className="bubble__why-chain-code" title={LAYER_DISPLAY_NAME[item.layer]}>
                                    {LAYER_SHORT_CODE[item.layer]}
                                  </span>
                                  <span className="bubble__why-chain-reason"> ({item.reason})</span>
                                </span>
                              ))}
                              {group.count > 1 && <span className="bubble__why-chain-count">) ×{group.count}</span>}
                            </span>
                          ))}
                        </div>
                        <div className="bubble__why-legend">
                          {[...new Set(chain.flatMap((g) => g.items.map((item) => item.layer)))]
                            .map((layer) => `${LAYER_SHORT_CODE[layer]} = ${LAYER_DISPLAY_NAME[layer]}`)
                            .join(' · ')}
                        </div>
                      </>
                    ) : null
                  })()}
                  {trace.batchBudget && (() => {
                    const { found, notFound, truncated } = batchOutcomeCounts(trace.batchBudget)
                    return (
                      <div className="bubble__batch-summary">
                        Batch: {trace.batchBudget.itemCount} items — {found} found, {notFound} not found, {truncated} truncated
                        {' '}({trace.batchBudget.totalCallsUsed} calls used, projected ~{Math.ceil(trace.batchBudget.projectedTotal)})
                      </div>
                    )
                  })()}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {(trace || planStatus) && (
        <div className="bubble__why">
          {showRunDetail && (
            <div className="bubble__why-detail">
              {trace && (
                <div className="bubble__layer-grid">
                  {LAYER_ORDER.map((layer) => {
                    const event = trace.layerActivity.find((e) => e.layer === layer)
                    const fired = event?.fired ?? false
                    return (
                      <div
                        key={layer}
                        className={`bubble__layer-cell ${fired ? 'bubble__layer-cell--fired' : 'bubble__layer-cell--disabled'}`}
                        title={`${LAYER_DISPLAY_NAME[layer]}: ${event?.reason ?? 'not evaluated this turn'}`}
                        tabIndex={0}
                      >
                        {LAYER_SHORT_CODE[layer]}
                        {/* A visible, immediate tooltip — the native `title` attribute above is
                            kept for accessibility, but its browser-default hover delay makes the
                            layer name easy to miss at a glance. */}
                        <span className="bubble__layer-tooltip">
                          <strong>{LAYER_DISPLAY_NAME[layer]}</strong>
                          <br />
                          {event?.reason ?? 'not evaluated this turn'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              {trace?.batchBudget && (
                <ul className="bubble__why-steps bubble__batch-item-list">
                  {trace.batchBudget.perItemOutcomes.map((o) => (
                    <li key={o.item} className={`bubble__batch-item--${o.status}`}>
                      {BATCH_STATUS_ICON[o.status]} {o.item} — {o.status.replace(/_/g, ' ')} ({o.callsUsed} calls)
                    </li>
                  ))}
                </ul>
              )}
              {planStatus && (
                <>
                <ul className="bubble__why-steps bubble__plan-checklist">
                  {planStatus.tasks.map((t) => (
                    <li key={t.id} className={t.status === 'RUNNING' ? 'bubble__plan-checklist-item--active' : undefined}>
                      {PLAN_TASK_STATUS_ICON[t.status] ?? '?'} {t.description}
                      {t.note && <span className="bubble__plan-checklist-note"> — not accepted as done: {t.note}</span>}
                    </li>
                  ))}
                </ul>
                {onViewPlanGraph && (
                  <button type="button" className="bubble__plan-graph-link" onClick={onViewPlanGraph}>View as graph</button>
                )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
