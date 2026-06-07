import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

type LensStatus = 'PASS' | 'FAIL' | 'PENDING'

interface ReviewFinding {
  lens: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  message: string
}

interface AdversarialBelief {
  statement: string
  causal_proximity: number
  seeded_from?: string
}

interface ReopenedTask {
  task_id: string
  description?: string
  invalidated_beliefs: string[]
}

interface LiveReviewerPass {
  implementer_status?: LensStatus
  reviewer_status?: LensStatus
  adversarial_status?: LensStatus
  findings?: ReviewFinding[]
  adversarial_prior?: AdversarialBelief[]
  reopened_tasks?: ReopenedTask[]
}

const LENS_COLORS: Record<LensStatus, string> = {
  PASS: '#4ade80',
  FAIL: '#f87171',
  PENDING: '#fbbf24',
}

export function ReviewerPassNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveReviewerPass) ?? {}

  const showAdversarialPrior = (cfg.show_adversarial_prior as boolean) ?? true
  const showFindingsDetail = (cfg.show_findings_detail as boolean) ?? true
  const showReopenedTasks = (cfg.show_reopened_tasks as boolean) ?? true

  const implementerStatus: LensStatus = live.implementer_status ?? 'PENDING'
  const reviewerStatus: LensStatus = live.reviewer_status ?? 'PENDING'
  const adversarialStatus: LensStatus = live.adversarial_status ?? 'PENDING'

  const findings = live.findings ?? []
  const highFindings = findings.filter((f) => f.severity === 'HIGH')
  const totalFindings = findings.length

  const adversarialPrior = (live.adversarial_prior ?? [])
    .sort((a, b) => b.causal_proximity - a.causal_proximity)

  const reopenedTasks = live.reopened_tasks ?? []

  function LensChip({ label, status }: { label: string; status: LensStatus }) {
    const color = LENS_COLORS[status]
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 8, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
          {label}
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
          background: `${color}12`, border: `0.5px solid ${color}40`,
          color, fontFamily: 'monospace',
        }}>
          {status}
        </span>
      </div>
    )
  }

  return (
    <BaseNode id={id} type="reviewer_pass" selected={selected} data={data}>
      <div style={{ marginTop: 3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
          <LensChip label="Implementer" status={implementerStatus} />
          <LensChip label="Reviewer" status={reviewerStatus} />
          <LensChip label="Adversarial" status={adversarialStatus} />
        </div>

        {totalFindings > 0 && (
          <div style={{
            fontSize: 10, color: '#94a3b8', marginBottom: 4,
            fontFamily: 'monospace',
          }}>
            {totalFindings} finding{totalFindings !== 1 ? 's' : ''}
            {totalFindings > 0 && ` (${highFindings.length} HIGH)`}
          </div>
        )}

        {showFindingsDetail && highFindings.length > 0 && (
          <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4, marginTop: 3 }}>
            {highFindings.map((f, i) => (
              <div key={i} style={{ fontSize: 10, color: '#f87171', marginBottom: 2 }}>
                [{f.lens}] {f.message.length > 60 ? f.message.slice(0, 60) + '…' : f.message}
              </div>
            ))}
          </div>
        )}

        {showAdversarialPrior && adversarialPrior.length > 0 && (
          <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              Adversarial Prior — ephemeral, discarded after pass
            </div>
            {adversarialPrior.map((b, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: '#e2e8f0', marginBottom: 2 }}>
                  {b.statement.length > 70 ? b.statement.slice(0, 70) + '…' : b.statement}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 50, height: 3, background: 'rgba(255,255,255,0.07)',
                    borderRadius: 2, overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${b.causal_proximity * 100}%`, height: '100%',
                      background: '#fb7185', borderRadius: 2,
                    }} />
                  </div>
                  <span style={{ fontSize: 9, color: '#fb7185', fontFamily: 'monospace' }}>
                    {(b.causal_proximity * 100).toFixed(0)}%
                  </span>
                  {b.seeded_from && (
                    <span style={{ fontSize: 9, color: '#64748b' }}>
                      from {b.seeded_from}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {showReopenedTasks && (
          <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              reopened tasks
            </div>
            {reopenedTasks.length === 0 ? (
              <div style={{ fontSize: 10, color: '#475569' }}>
                No tasks reopened — reviewer pass concluded cleanly.
              </div>
            ) : (
              reopenedTasks.map((t, i) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 10, color: '#e2e8f0' }}>
                    {t.description ?? t.task_id}
                  </div>
                  <div style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>
                    beliefs: {t.invalidated_beliefs.join(', ')}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </BaseNode>
  )
}
