import { useState, useEffect, useRef } from 'react'
import { Activity } from 'lucide-react'

// Thresholds from the harness architecture
const CRITICAL_THRESHOLD = 0.3
const CAUTION_THRESHOLD = 0.6

export interface DiagnosticsState {
  generation_id?: number
  belief_health?: {
    freshness?: number
    consistency?: number
    support?: number
  }
  coverage_health?: {
    symptom_coverage?: number
    explanation_coverage?: number
  }
  verification_health?: {
    strength?: number
    feasibility?: number
  }
  execution_health?: {
    progress_rate?: number
    failure_recurrence?: number
    oscillation_score?: number
  }
  dep_class_gap_annotation?: string
}

interface SubDimension {
  key: string
  label: string
  value: number | undefined
}

interface HealthSection {
  title: string
  dims: SubDimension[]
}

function buildSections(s: DiagnosticsState): HealthSection[] {
  return [
    {
      title: 'Belief Health',
      dims: [
        { key: 'freshness', label: 'freshness', value: s.belief_health?.freshness },
        { key: 'consistency', label: 'consistency', value: s.belief_health?.consistency },
        { key: 'support', label: 'support', value: s.belief_health?.support },
      ],
    },
    {
      title: 'Coverage Health',
      dims: [
        { key: 'symptom_coverage', label: 'symptom_coverage', value: s.coverage_health?.symptom_coverage },
        { key: 'explanation_coverage', label: 'explanation_coverage', value: s.coverage_health?.explanation_coverage },
      ],
    },
    {
      title: 'Verification Health',
      dims: [
        { key: 'strength', label: 'strength', value: s.verification_health?.strength },
        { key: 'feasibility', label: 'feasibility', value: s.verification_health?.feasibility },
      ],
    },
    {
      title: 'Execution Health',
      dims: [
        { key: 'progress_rate', label: 'progress_rate', value: s.execution_health?.progress_rate },
        { key: 'failure_recurrence', label: 'failure_recurrence', value: s.execution_health?.failure_recurrence },
        { key: 'oscillation_score', label: 'oscillation_score', value: s.execution_health?.oscillation_score },
      ],
    },
  ]
}

function barColor(value: number): string {
  if (value < CRITICAL_THRESHOLD) return '#f87171'
  if (value < CAUTION_THRESHOLD) return '#fbbf24'
  return '#4ade80'
}

function DimBar({ dim, highlighted }: { dim: SubDimension; highlighted: boolean }) {
  const v = dim.value ?? 0
  const color = dim.value != null ? barColor(v) : '#334155'
  return (
    <div style={{
      marginBottom: 6,
      background: highlighted ? 'rgba(255,255,255,0.03)' : 'transparent',
      borderRadius: 3, padding: '2px 4px',
      transition: 'background 0.4s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <span style={{
          fontSize: 10, fontFamily: 'monospace', color: '#94a3b8',
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {dim.label}
        </span>
        <span style={{
          fontSize: 10, fontFamily: 'monospace', color,
          flexShrink: 0, minWidth: 28, textAlign: 'right',
        }}>
          {dim.value != null ? v.toFixed(2) : '—'}
        </span>
      </div>
      <div style={{
        height: 5, background: 'rgba(255,255,255,0.07)',
        borderRadius: 3, overflow: 'hidden',
      }}>
        <div style={{
          width: `${v * 100}%`, height: '100%',
          background: color, borderRadius: 3,
          transition: 'width 0.4s, background 0.4s',
        }} />
      </div>
    </div>
  )
}

interface DiagnosticsPanelProps {
  state?: DiagnosticsState
  onClose?: () => void
}

export function DiagnosticsPanel({ state, onClose }: DiagnosticsPanelProps) {
  const s = state ?? {}
  const sections = buildSections(s)

  // Track which dims changed since the last render for highlight animation
  const prevStateRef = useRef<DiagnosticsState>({})
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!state) return
    const changed = new Set<string>()
    if (state.generation_id !== prevStateRef.current.generation_id) {
      sections.forEach((sec) => sec.dims.forEach((d) => changed.add(d.key)))
    }
    if (changed.size > 0) {
      setHighlighted(changed)
      const t = setTimeout(() => setHighlighted(new Set()), 800)
      prevStateRef.current = state
      return () => clearTimeout(t)
    }
    prevStateRef.current = state
  }, [state?.generation_id])

  const anyCritical = sections.some((sec) =>
    sec.dims.some((d) => d.value != null && d.value < CRITICAL_THRESHOLD),
  )

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0,
      width: 260,
      background: '#161b27',
      borderLeft: '0.5px solid rgba(255,255,255,0.07)',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'var(--font-ui, sans-serif)',
      zIndex: 100,
      boxShadow: '-4px 0 20px rgba(0,0,0,0.4)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '0.5px solid rgba(255,255,255,0.07)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Activity size={13} style={{ color: anyCritical ? '#f87171' : '#94a3b8' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>
            Diagnostic Health
          </span>
          {anyCritical && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#f87171', flexShrink: 0,
            }} />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {s.generation_id != null && (
            <span style={{ fontSize: 9, color: '#475569', fontFamily: 'monospace' }}>
              gen:{s.generation_id}
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', color: '#64748b',
                cursor: 'pointer', padding: '2px 4px', fontSize: 14, lineHeight: 1,
              }}
              title="Close"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Bar charts */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
        {sections.map((section) => (
          <div key={section.title} style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: '#475569', marginBottom: 5,
            }}>
              {section.title}
            </div>
            {section.dims.map((dim) => (
              <DimBar key={dim.key} dim={dim} highlighted={highlighted.has(dim.key)} />
            ))}
          </div>
        ))}

        {/* dep_class_gap — displayed as text annotation, NOT a chart bar (INV-07) */}
        <div style={{
          marginTop: 8,
          borderTop: '0.5px solid rgba(255,255,255,0.07)',
          paddingTop: 8,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.1em', color: '#475569', marginBottom: 5,
          }}>
            Advisory Annotations
          </div>
          <div style={{
            padding: '6px 10px',
            background: 'rgba(251,191,36,0.04)',
            borderLeft: '2px solid rgba(251,191,36,0.4)',
            borderRadius: '0 4px 4px 0',
          }}>
            <div style={{ fontSize: 9, color: '#fbbf24', fontWeight: 600, marginBottom: 3 }}>
              dep_class_gap (advisory — not a control input)
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
              {s.dep_class_gap_annotation ?? 'No annotation available.'}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { color: '#f87171', label: `< ${CRITICAL_THRESHOLD} critical` },
            { color: '#fbbf24', label: `< ${CAUTION_THRESHOLD} caution` },
            { color: '#4ade80', label: 'healthy' },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 9, color: '#475569' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Toolbar toggle button ────────────────────────────────────────────────────

interface DiagnosticsButtonProps {
  open: boolean
  anyCritical?: boolean
  onClick: () => void
}

export function DiagnosticsButton({ open, anyCritical, onClick }: DiagnosticsButtonProps) {
  return (
    <button
      className={`canvas-toolbar__btn${open ? ' canvas-toolbar__btn--active' : ''}`}
      onClick={onClick}
      title="Diagnostic health (harness)"
      style={{ position: 'relative' }}
    >
      <Activity size={13} />
      {anyCritical && (
        <span style={{
          position: 'absolute', top: 2, right: 2,
          width: 5, height: 5, borderRadius: '50%',
          background: '#f87171',
        }} />
      )}
    </button>
  )
}
