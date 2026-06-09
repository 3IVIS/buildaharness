import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

type TaskStatus = 'pending' | 'active' | 'verifying' | 'complete' | 'failed' | 'blocked'

interface LiveTask {
  id: string
  description: string
  status: TaskStatus
  risk_level?: string
  depends_on?: string[]
  parallel_write_domains?: string[]
  abstraction_level?: string
  assigned_strategy?: string
  block_reason?: string
}

interface LiveTaskGraph {
  tasks?: LiveTask[]
  total?: number
  complete_count?: number
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: '#94a3b8',
  active: '#60a5fa',
  verifying: '#fbbf24',
  complete: '#4ade80',
  failed: '#f87171',
  blocked: '#dc2626',
}

export function TaskGraphNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveTaskGraph) ?? {}
  const showWriteDomains = (cfg.show_write_domains as boolean) ?? false
  const showAbstractionLevel = (cfg.show_abstraction_level as boolean) ?? false
  const maxTasks = (cfg.max_tasks_shown as number) ?? 20

  const tasks = (live.tasks ?? []).slice(0, maxTasks)
  const totalCount = live.total ?? tasks.length
  const completeCount = live.complete_count ?? tasks.filter((t) => t.status === 'complete').length
  const progress = totalCount > 0 ? completeCount / totalCount : 0

  const statusCounts = tasks.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1
    return acc
  }, {} as Record<TaskStatus, number>)

  return (
    <BaseNode id={id} type="task_graph_node" selected={selected} data={data}>
      <div style={{ marginTop: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
          <div style={{
            flex: 1, height: 5, background: 'rgba(255,255,255,0.07)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            <div style={{
              width: `${progress * 100}%`, height: '100%',
              background: '#4ade80', borderRadius: 3, transition: 'width 0.3s',
            }} />
          </div>
          <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>
            {completeCount}/{totalCount}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {(Object.entries(statusCounts) as [TaskStatus, number][]).map(([status, count]) => (
            <span key={status} style={{
              fontSize: 9, fontFamily: 'monospace', padding: '0 4px', borderRadius: 3,
              background: `${STATUS_COLORS[status]}15`,
              border: `0.5px solid ${STATUS_COLORS[status]}40`,
              color: STATUS_COLORS[status],
            }}>
              {count} {status}
            </span>
          ))}
        </div>
      </div>

      {tasks.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 5 }}>
          {tasks.map((task) => (
            <div key={task.id} style={{ marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{
                  fontSize: 9, fontWeight: 600, padding: '0 4px', borderRadius: 3,
                  background: `${STATUS_COLORS[task.status] ?? '#94a3b8'}15`,
                  border: `0.5px solid ${STATUS_COLORS[task.status] ?? '#94a3b8'}40`,
                  color: STATUS_COLORS[task.status] ?? '#94a3b8',
                  flexShrink: 0,
                }}>
                  {task.status.toUpperCase()}
                </span>
                <span style={{ fontSize: 11, color: '#e2e8f0' }}>
                  {task.description.length > 50 ? task.description.slice(0, 50) + '…' : task.description}
                </span>
              </div>
              {task.block_reason && task.status === 'blocked' && (
                <div style={{ fontSize: 10, color: '#dc2626', marginTop: 1, paddingLeft: 4 }}>
                  {task.block_reason}
                </div>
              )}
              {showWriteDomains && task.parallel_write_domains && task.parallel_write_domains.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginTop: 2, paddingLeft: 4 }}>
                  {task.parallel_write_domains.map((d) => (
                    <span key={d} style={{
                      fontSize: 9, fontFamily: 'monospace', color: '#94a3b8',
                      background: 'rgba(255,255,255,0.04)', padding: '0 3px', borderRadius: 2,
                    }}>
                      {d}
                    </span>
                  ))}
                </div>
              )}
              {showAbstractionLevel && task.abstraction_level && (
                <div style={{ fontSize: 9, color: '#64748b', paddingLeft: 4, marginTop: 1 }}>
                  level: {task.abstraction_level}
                </div>
              )}
              {task.depends_on && task.depends_on.length > 0 && (
                <div style={{ fontSize: 9, color: '#475569', paddingLeft: 4, marginTop: 1 }}>
                  ← {task.depends_on.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </BaseNode>
  )
}
