/**
 * A2ADeploymentPanel — appears when an A2A-enabled flow is deployed.
 *
 * Triggered by the Deploy button in Toolbar.  Shows:
 *  - Live endpoint URL with copy button
 *  - curl snippet for task submission
 *  - Undeploy button
 *  - Link to /.well-known/agent.json (AgentCard discovery)
 *
 * Panel closes when the user clicks the × or undeploys.
 * Follows the same aside layout pattern as HitlResumePanel.
 */
import { useState } from 'react'
import { Share2, Copy, Check, Trash2, ExternalLink, X } from 'lucide-react'
import { useCanvasStore } from '../store'
import { api } from '../services/api'

export function A2ADeploymentPanel() {
  const a2aDeployment   = useCanvasStore((s) => s.a2aDeployment)
  const setA2ADeployment = useCanvasStore((s) => s.setA2ADeployment)
  const flowMeta        = useCanvasStore((s) => s.flowMeta)

  const [copied,      setCopied]      = useState(false)
  const [curlCopied,  setCurlCopied]  = useState(false)
  const [undeploying, setUndeploying] = useState(false)
  const [undepError,  setUndepError]  = useState<string | null>(null)

  if (!a2aDeployment) return null

  const { endpoint_url, agent_card, deployed_at, flow_id } = a2aDeployment
  const discoveryUrl = endpoint_url.replace('/tasks/send', '').replace('/a2a/', '/.well-known/agent/') + '.json'

  const curlSnippet = `curl -X POST "${endpoint_url}" \\
  -H "Authorization: Bearer <YOUR_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "task-$(uuidgen | tr -d -)",
    "message": {
      "role": "user",
      "parts": [{"type": "text", "text": "Hello agent"}]
    }
  }'`

  async function handleCopyUrl() {
    await navigator.clipboard.writeText(endpoint_url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleCopyCurl() {
    await navigator.clipboard.writeText(curlSnippet).catch(() => {})
    setCurlCopied(true)
    setTimeout(() => setCurlCopied(false), 2000)
  }

  async function handleUndeploy() {
    setUndeploying(true)
    setUndepError(null)
    try {
      await api.a2a.undeploy(flow_id)
      setA2ADeployment(null)
    } catch (err) {
      setUndepError(err instanceof Error ? err.message : 'Undeploy failed')
    } finally {
      setUndeploying(false)
    }
  }

  const deployedAt = new Date(deployed_at).toLocaleString()

  const panelStyle: React.CSSProperties = {
    // §3 overlay treatment — floating, anchored to workspace right edge.
    position: 'absolute',
    top: 0, right: 0, bottom: 0,
    zIndex: 11,
    width: 320,
    borderLeft: '0.5px solid var(--border-mid)',
    boxShadow: '-8px 0 24px rgba(0,0,0,0.25), -1px 0 0 var(--border)',
    background: 'var(--bg-base)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    animation: 'panelSlideIn 0.15s ease',
  }

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: '0.5px solid var(--border)',
    flexShrink: 0,
  }

  const bodyStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    marginBottom: 4,
  }

  const urlBoxStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'var(--bg-overlay)',
    border: '0.5px solid var(--border)',
    borderRadius: 5,
    padding: '6px 8px',
    fontSize: 11,
    fontFamily: 'monospace',
    color: 'var(--text-primary)',
    wordBreak: 'break-all',
  }

  const codeBlockStyle: React.CSSProperties = {
    background: 'var(--bg-overlay)',
    border: '0.5px solid var(--border)',
    borderRadius: 5,
    padding: '8px 10px',
    fontSize: 10,
    fontFamily: 'monospace',
    color: 'var(--text-secondary)',
    whiteSpace: 'pre',
    overflowX: 'auto',
    lineHeight: 1.6,
  }

  const pillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 10,
    fontWeight: 600,
    background: 'rgba(74,222,128,0.1)',
    border: '0.5px solid rgba(74,222,128,0.3)',
    color: 'var(--rt-full)',
  }

  const iconBtn = (active = false): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    borderRadius: 4,
    color: active ? 'var(--rt-full)' : 'var(--text-tertiary)',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  })

  return (
    <aside style={panelStyle} aria-label="A2A Deployment">
      {/* Header */}
      <div style={headerStyle}>
        <Share2 size={14} strokeWidth={1.75} style={{ color: '#3b82f6', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, color: 'var(--text-primary)' }}>
          A2A Deployment
        </span>
        <span style={pillStyle}>● live</span>
        <button
          style={iconBtn()}
          onClick={() => setA2ADeployment(null)}
          title="Close panel"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div style={bodyStyle}>

        {/* Agent name */}
        <div>
          <div style={labelStyle}>Agent</div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {(agent_card as Record<string, unknown>)?.['name'] as string ?? flowMeta.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
            Deployed {deployedAt}
          </div>
        </div>

        {/* Endpoint URL */}
        <div>
          <div style={labelStyle}>Task endpoint</div>
          <div style={urlBoxStyle}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{endpoint_url}</span>
            <button style={iconBtn(copied)} onClick={handleCopyUrl} title="Copy URL">
              {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
            </button>
          </div>
        </div>

        {/* Discovery link */}
        <div>
          <div style={labelStyle}>AgentCard discovery</div>
          <a
            href={discoveryUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, color: '#3b82f6', textDecoration: 'none',
            }}
          >
            <ExternalLink size={10} strokeWidth={2} />
            {discoveryUrl}
          </a>
        </div>

        {/* curl snippet */}
        <div>
          <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>curl example</span>
            <button
              style={{ ...iconBtn(curlCopied), fontSize: 10, gap: 3, padding: '2px 6px',
                border: '0.5px solid var(--border)', borderRadius: 4 }}
              onClick={handleCopyCurl}
            >
              {curlCopied ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={2} />}
              {curlCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={codeBlockStyle}>{curlSnippet}</div>
        </div>

        {/* Error */}
        {undepError && (
          <div style={{ fontSize: 11, color: '#ef4444', padding: '6px 8px',
            background: 'rgba(239,68,68,0.08)', borderRadius: 4, border: '0.5px solid rgba(239,68,68,0.2)' }}>
            {undepError}
          </div>
        )}

        {/* Undeploy */}
        <button
          onClick={handleUndeploy}
          disabled={undeploying}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '7px 12px', borderRadius: 5, cursor: undeploying ? 'default' : 'pointer',
            fontSize: 12, fontWeight: 500,
            background: 'rgba(239,68,68,0.08)',
            border: '0.5px solid rgba(239,68,68,0.25)',
            color: '#ef4444',
            opacity: undeploying ? 0.6 : 1,
            marginTop: 4,
          }}
        >
          <Trash2 size={12} strokeWidth={2} />
          {undeploying ? 'Undeploying…' : 'Undeploy agent'}
        </button>
      </div>
    </aside>
  )
}
