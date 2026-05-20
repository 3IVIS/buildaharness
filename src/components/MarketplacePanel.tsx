/**
 * MarketplacePanel — community component gallery embedded in the Sidebar.
 *
 * Shows a searchable, filterable grid of community components.  Each card has:
 *   - emoji icon + name + verified badge
 *   - one-line description
 *   - npm ref pill + install count
 *   - Install button → POST /marketplace/{slug}/install
 *
 * On install the component's node_spec is dropped onto the canvas at a
 * sensible default position, and its tool_def (if present) is auto-registered
 * in the flow's tools registry under tool_id so tool_invoke nodes can
 * reference it immediately without opening Flow Settings.
 *
 * Design constraints:
 *   - Must fit inside the 200px sidebar without horizontal scroll
 *   - Follows the existing sidebar colour tokens (var(--bg-overlay) etc.)
 *   - Loading / error / empty states all accounted for
 */
import { useState, useEffect, useCallback } from 'react'
import { Store, Search, CheckCircle, Download, AlertCircle, RefreshCw } from 'lucide-react'
import { api, type MarketplaceComponent } from '../services/api'
import { useCanvasStore } from '../store'
import type { ToolDef, NodeType } from '../spec/schema'

// Valid node types that can be safely dropped onto the canvas
const VALID_NODE_TYPES = new Set<string>([
  'input', 'output', 'llm_call', 'tool_invoke', 'condition',
  'parallel_fork', 'parallel_join', 'hitl_breakpoint',
  'memory_read', 'memory_write', 'subgraph', 'transform',
  'agent_role', 'agent_debate',
])

// ── Category pill options ─────────────────────────────────────────────────────

const CATEGORIES = [
  { value: '',       label: 'All'     },
  { value: 'tool',   label: 'Tools'   },
  { value: 'memory', label: 'Memory'  },
  { value: 'agent',  label: 'Agents'  },
  { value: 'control', label: 'Control' },
] as const

// ── Default canvas drop position (centre-ish, avoids 0,0) ─────────────────────

const DROP_POSITION = { x: 300, y: 200 }

// ── MarketplacePanel ──────────────────────────────────────────────────────────

export function MarketplacePanel() {
  const { addNode, setTools, tools } = useCanvasStore()

  const [items,    setItems]    = useState<MarketplaceComponent[]>([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [query,    setQuery]    = useState('')
  const [category, setCategory] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)  // slug being installed
  const [installed,  setInstalled]  = useState<Set<string>>(new Set())

  const load = useCallback(async (q: string, cat: string) => {
    setLoading(true)
    setError(null)
    try {
      const results = await api.marketplace.list({
        q:        q || undefined,
        category: cat || undefined,
        limit:    50,
      })
      setItems(results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load marketplace')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + re-load on filter change (debounced for search)
  useEffect(() => {
    const t = setTimeout(() => load(query, category), query ? 300 : 0)
    return () => clearTimeout(t)
  }, [query, category, load])

  async function handleInstall(slug: string) {
    if (installing) return
    setInstalling(slug)
    try {
      const result = await api.marketplace.install(slug)

      // 1. Add the node to the canvas — default to tool_invoke for unknown types
      const rawType = (result.node_spec?.type as string) ?? 'tool_invoke'
      const nodeType = (VALID_NODE_TYPES.has(rawType) ? rawType : 'tool_invoke') as NodeType
      addNode(nodeType, DROP_POSITION)

      // 2. Auto-register the tool_def in the flow's tools registry
      if (result.tool_def && result.tool_id) {
        const newTools: Record<string, ToolDef> = {
          ...tools,
          [result.tool_id]: result.tool_def as unknown as ToolDef,
        }
        setTools(newTools)
      }

      // 3. Mark as installed (green ✓ for this session)
      setInstalled((prev) => new Set(prev).add(slug))

      // 4. Update local install_count optimistically
      setItems((prev) =>
        prev.map((item) =>
          item.slug === slug
            ? { ...item, install_count: item.install_count + 1 }
            : item,
        ),
      )
    } catch (err) {
      alert(`Install failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 10px 4px',
        borderBottom: '0.5px solid var(--border)',
        flexShrink: 0,
      }}>
        <Store size={12} strokeWidth={2} style={{ color: '#8b5cf6', flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
          Community
        </span>
        <button
          onClick={() => load(query, category)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 2,
            color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center',
          }}
          title="Refresh"
        >
          <RefreshCw size={10} strokeWidth={2} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 10px 4px', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <Search size={10} strokeWidth={2} style={{
            position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-tertiary)', pointerEvents: 'none',
          }} />
          <input
            className="sidebar-search"
            style={{ paddingLeft: 24 }}
            placeholder="Search components…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', color: 'var(--text-tertiary)',
                cursor: 'pointer', fontSize: 12, padding: 0,
              }}
            >×</button>
          )}
        </div>
      </div>

      {/* Category pills */}
      <div style={{
        display: 'flex', gap: 4, padding: '2px 10px 6px',
        flexShrink: 0, flexWrap: 'wrap',
      }}>
        {CATEGORIES.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setCategory(value)}
            style={{
              padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 500,
              cursor: 'pointer', border: '0.5px solid',
              background: category === value ? 'rgba(139,92,246,0.15)' : 'transparent',
              borderColor: category === value ? 'rgba(139,92,246,0.5)' : 'var(--border)',
              color: category === value ? '#8b5cf6' : 'var(--text-tertiary)',
              transition: 'all 0.1s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 10px' }}>

        {/* Loading */}
        {loading && items.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', paddingTop: 20 }}>
            Loading…
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            fontSize: 11, color: '#ef4444', padding: '8px 10px', marginTop: 6,
            background: 'rgba(239,68,68,0.08)', border: '0.5px solid rgba(239,68,68,0.2)',
            borderRadius: 5, display: 'flex', alignItems: 'flex-start', gap: 6,
          }}>
            <AlertCircle size={11} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && items.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', paddingTop: 20 }}>
            No components found{query ? ` for "${query}"` : ''}.
          </div>
        )}

        {/* Component cards */}
        {items.map((item) => (
          <ComponentCard
            key={item.slug}
            item={item}
            installing={installing === item.slug}
            installed={installed.has(item.slug)}
            onInstall={() => handleInstall(item.slug)}
          />
        ))}
      </div>
    </div>
  )
}

// ── ComponentCard ──────────────────────────────────────────────────────────────

interface CardProps {
  item:       MarketplaceComponent
  installing: boolean
  installed:  boolean
  onInstall:  () => void
}

function ComponentCard({ item, installing, installed, onInstall }: CardProps) {
  return (
    <div style={{
      marginTop: 6,
      background: 'var(--bg-overlay)',
      border: `0.5px solid ${installed ? 'rgba(74,222,128,0.3)' : 'var(--border)'}`,
      borderRadius: 6,
      padding: '8px 9px',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      transition: 'border-color 0.15s',
    }}>

      {/* Top row: icon + name + verified badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>{item.icon_emoji}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.name}
        </span>
        {item.verified && (
          <CheckCircle
            size={11} strokeWidth={2}
            style={{ color: '#4ade80', flexShrink: 0 }}
            title="Verified @itsharness package"
          />
        )}
      </div>

      {/* Description */}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        {item.description}
      </div>

      {/* Bottom row: npm ref pill + install count + button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-tertiary)',
          background: 'var(--bg-panel)', border: '0.5px solid var(--border)',
          borderRadius: 3, padding: '1px 5px', flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={item.npm_ref}>
          {item.npm_ref}
        </span>

        <span style={{ fontSize: 9, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {item.install_count > 0 ? `↓${item.install_count}` : ''}
        </span>

        <button
          onClick={onInstall}
          disabled={installing}
          title={installed ? 'Installed (click to install again)' : `Install ${item.name}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 500,
            cursor: installing ? 'default' : 'pointer',
            border: '0.5px solid',
            background: installed
              ? 'rgba(74,222,128,0.1)'
              : 'rgba(139,92,246,0.12)',
            borderColor: installed
              ? 'rgba(74,222,128,0.35)'
              : 'rgba(139,92,246,0.35)',
            color: installed ? '#4ade80' : '#a78bfa',
            opacity: installing ? 0.5 : 1,
            flexShrink: 0,
            transition: 'all 0.1s',
          }}
        >
          <Download size={9} strokeWidth={2.5} />
          {installing ? '…' : installed ? 'Done' : 'Install'}
        </button>
      </div>

      {/* Tags (shown only when non-empty) */}
      {item.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: -1 }}>
          {item.tags.slice(0, 4).map((tag) => (
            <span key={tag} style={{
              fontSize: 9, color: 'var(--text-tertiary)',
              background: 'var(--bg-panel)', border: '0.5px solid var(--border)',
              borderRadius: 3, padding: '0px 4px',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
