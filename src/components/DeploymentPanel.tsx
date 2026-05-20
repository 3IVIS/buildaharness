/**
 * DeploymentPanel — appears after a successful one-click deploy.
 *
 * Triggered by the Deploy button in Toolbar once POST /deploy/{flow_id}
 * returns.  Shows all three deployment targets in one panel:
 *
 *   REST endpoint   — POST /flows/{id}/invoke  (synchronous execution)
 *   MCP tool        — /.well-known/mcp/{id}.json  (Claude Desktop / agents)
 *   A2A agent       — /a2a/{id}/tasks/send  (only when A2A enabled)
 *
 * Each section has a copy button and a collapsible curl/config snippet.
 * The shareable URL is displayed at the top for quick sharing.
 *
 * Panel closes on × click or Escape (wired in App.tsx).
 * Follows the same aside layout pattern as HitlResumePanel.
 */
import { useState } from 'react'
import {
  Rocket, Copy, Check, Trash2, ExternalLink, X,
  Globe, Wrench, Share2, ChevronDown, ChevronRight,
} from 'lucide-react'
import { useCanvasStore } from '../store'
import { api } from '../services/api'

// ── Sub-component: URL row with copy button ────────────────────────────────

function UrlRow({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--bg-overlay)',
      border: '0.5px solid var(--border)',
      borderRadius: 5,
      padding: '6px 8px',
      fontSize: 11,
      fontFamily: 'monospace',
      color: 'var(--text-primary)',
    }}>
      <span title={label} style={{ flex: 1, wordBreak: 'break-all' }}>{url}</span>
      <button
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 4,
          borderRadius: 4, flexShrink: 0,
          color: copied ? 'var(--rt-full)' : 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center',
        }}
        onClick={handleCopy}
        title={`Copy ${label}`}
      >
        {copied
          ? <Check size={12} strokeWidth={2.5} />
          : <Copy size={12} strokeWidth={2} />
        }
      </button>
    </div>
  )
}

// ── Sub-component: collapsible code snippet ────────────────────────────────

function Snippet({ title, code }: { title: string; code: string }) {
  const [open,   setOpen]   = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, width: '100%',
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--text-tertiary)',
          marginBottom: open ? 6 : 0,
        }}
      >
        {open
          ? <ChevronDown  size={10} strokeWidth={2} />
          : <ChevronRight size={10} strokeWidth={2} />
        }
        {title}
      </button>

      {open && (
        <div style={{ position: 'relative' }}>
          <pre style={{
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
            margin: 0,
          }}>{code}</pre>
          <button
            onClick={handleCopy}
            style={{
              position: 'absolute', top: 6, right: 6,
              background: 'var(--bg-panel)', border: '0.5px solid var(--border)',
              borderRadius: 4, cursor: 'pointer', padding: '2px 6px',
              fontSize: 10, display: 'flex', alignItems: 'center', gap: 3,
              color: copied ? 'var(--rt-full)' : 'var(--text-tertiary)',
            }}
          >
            {copied ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={2} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────

export function DeploymentPanel() {
  const unifiedDeployment    = useCanvasStore((s) => s.unifiedDeployment)
  const setUnifiedDeployment = useCanvasStore((s) => s.setUnifiedDeployment)
  const setA2ADeployment     = useCanvasStore((s) => s.setA2ADeployment)
  const flowMeta             = useCanvasStore((s) => s.flowMeta)

  const [undeploying, setUndeploying] = useState(false)
  const [undepError,  setUndepError]  = useState<string | null>(null)

  if (!unifiedDeployment) return null

  const { flow_id, rest_url, mcp_url, a2a_url, shareable_url, deployed_at } = unifiedDeployment
  // Derive the adapter base URL from mcp_url (e.g. http://localhost:8000/.well-known/mcp/...)
  const adapterBase = mcp_url.replace(/\/\.well-known\/.*$/, '')
  const agentCardUrl = `${adapterBase}/.well-known/agent/${flow_id}.json`
  const deployedAt = new Date(deployed_at).toLocaleString()

  // ── curl snippets ──────────────────────────────────────────────────────────

  const restCurl = `curl -X POST "${rest_url}" \\
  -H "Authorization: Bearer <YOUR_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"query": "Hello!"}}'`

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        [flowMeta.name.toLowerCase().replace(/\s+/g, '_')]: {
          command: "npx",
          args: ["-y", "@itsharness/mcp-proxy"],
          env: {
            MCP_MANIFEST_URL: mcp_url,
            ITSHARNESS_TOKEN: "<YOUR_TOKEN>",
          },
        },
      },
    },
    null,
    2,
  )

  const a2aCurl = a2a_url
    ? `curl -X POST "${a2a_url}" \\
  -H "Authorization: Bearer <YOUR_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "task-$(uuidgen | tr -d -)",
    "message": {
      "role": "user",
      "parts": [{"type": "text", "text": "Hello agent"}]
    }
  }'`
    : ''

  // ── handlers ───────────────────────────────────────────────────────────────

  async function handleUndeploy() {
    setUndeploying(true)
    setUndepError(null)
    try {
      await api.deploy.undeployAll(flow_id)
      setUnifiedDeployment(null)
      setA2ADeployment(null)   // clear legacy state too
    } catch (err) {
      setUndepError(err instanceof Error ? err.message : 'Undeploy failed')
    } finally {
      setUndeploying(false)
    }
  }

  // ── styles ─────────────────────────────────────────────────────────────────

  const panelStyle: React.CSSProperties = {
    width: 340,
    flexShrink: 0,
    borderLeft: '0.5px solid var(--border)',
    background: 'var(--bg-panel)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }

  const headerStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px',
    borderBottom: '0.5px solid var(--border)',
    flexShrink: 0,
  }

  const bodyStyle: React.CSSProperties = {
    flex: 1, overflowY: 'auto',
    padding: '14px',
    display: 'flex', flexDirection: 'column', gap: 16,
  }

  const sectionStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 6,
    paddingBottom: 14,
    borderBottom: '0.5px solid var(--border)',
  }

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
    marginBottom: 2,
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
    textTransform: 'uppercase', color: 'var(--text-tertiary)',
    marginBottom: 4,
  }

  const pillStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 12,
    fontSize: 10, fontWeight: 600,
    background: 'rgba(74,222,128,0.1)',
    border: '0.5px solid rgba(74,222,128,0.3)',
    color: 'var(--rt-full)',
  }

  return (
    <aside style={panelStyle} aria-label="Deployment">
      {/* Header */}
      <div style={headerStyle}>
        <Rocket size={14} strokeWidth={1.75} style={{ color: '#3b82f6', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, color: 'var(--text-primary)' }}>
          Deployment
        </span>
        <span style={pillStyle}>● live</span>
        <button
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            borderRadius: 4, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center',
          }}
          onClick={() => setUnifiedDeployment(null)}
          title="Close panel"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div style={bodyStyle}>

        {/* Meta */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {flowMeta.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
            Deployed {deployedAt}
          </div>
        </div>

        {/* Shareable URL */}
        <div>
          <div style={labelStyle}>Share link</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <UrlRow url={shareable_url} label="Share link" />
            <a
              href={shareable_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open share page"
              style={{
                display: 'flex', alignItems: 'center',
                color: '#3b82f6', flexShrink: 0,
              }}
            >
              <ExternalLink size={13} strokeWidth={2} />
            </a>
          </div>
        </div>

        {/* ── REST Endpoint ─────────────────────────────────────────────── */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <Globe size={13} strokeWidth={2} style={{ color: '#10b981' }} />
            REST endpoint
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
            Synchronous invocation. Runs the flow and returns the result (max 120 s).
          </div>
          <UrlRow url={rest_url} label="REST URL" />
          <Snippet title="curl example" code={restCurl} />
        </div>

        {/* ── MCP Tool ──────────────────────────────────────────────────── */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <Wrench size={13} strokeWidth={2} style={{ color: '#8b5cf6' }} />
            MCP tool
            <a
              href={mcp_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', marginLeft: 'auto' }}
              title="View manifest"
            >
              <ExternalLink size={11} strokeWidth={2} />
            </a>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
            Tool manifest for Claude Desktop and other MCP clients.
          </div>
          <UrlRow url={mcp_url} label="MCP manifest URL" />
          <Snippet title="claude_desktop_config.json snippet" code={mcpConfig} />
        </div>

        {/* ── A2A Agent (conditional) ───────────────────────────────────── */}
        {a2a_url ? (
          <div style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <Share2 size={13} strokeWidth={2} style={{ color: '#3b82f6' }} />
              A2A agent
              <a
                href={agentCardUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', marginLeft: 'auto' }}
                title="View AgentCard"
              >
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
              Agent-to-Agent protocol endpoint for multi-agent systems.
            </div>
            <UrlRow url={a2a_url} label="A2A task endpoint" />
            <Snippet title="curl example" code={a2aCurl} />
          </div>
        ) : (
          <div style={{
            padding: '8px 10px', borderRadius: 5, fontSize: 11,
            background: 'var(--bg-overlay)', border: '0.5px solid var(--border)',
            color: 'var(--text-tertiary)',
          }}>
            <strong style={{ color: 'var(--text-secondary)' }}>A2A not enabled.</strong>{' '}
            Set <code>flow_config.a2a_config.enabled = true</code> in Flow Settings → Config
            and re-deploy to add an A2A agent endpoint.
          </div>
        )}

        {/* Error */}
        {undepError && (
          <div style={{
            fontSize: 11, color: '#ef4444', padding: '6px 8px',
            background: 'rgba(239,68,68,0.08)', borderRadius: 4,
            border: '0.5px solid rgba(239,68,68,0.2)',
          }}>
            {undepError}
          </div>
        )}

        {/* Undeploy */}
        <button
          onClick={handleUndeploy}
          disabled={undeploying}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '7px 12px', borderRadius: 5,
            cursor: undeploying ? 'default' : 'pointer',
            fontSize: 12, fontWeight: 500,
            background: 'rgba(239,68,68,0.08)',
            border: '0.5px solid rgba(239,68,68,0.25)',
            color: '#ef4444',
            opacity: undeploying ? 0.6 : 1,
          }}
        >
          <Trash2 size={12} strokeWidth={2} />
          {undeploying ? 'Undeploying…' : 'Undeploy all'}
        </button>

      </div>
    </aside>
  )
}
