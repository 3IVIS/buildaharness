import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '@buildaharness/harness'
import { planToSnapshot } from './plan-snapshot.js'
import { migratePlanRecord, type PlanRecord, type PlanTaskRecord } from '../plan-store.js'
import type { GoalGraphRecord, GoalThread } from '../goal-graph-store.js'
import { checkNormalized, isConnected, NAMED_PLANS, randomPlan, templatePlans } from './testkit/generators.js'
import type { VizNode } from './types.js'

const T = (id: string, status: TaskStatus, depends_on: string[] = [], extra: Partial<PlanTaskRecord> = {}): PlanTaskRecord => ({ id, description: `Task ${id}`, depends_on, status, ...extra })
const plan = (tasks: PlanTaskRecord[]): PlanRecord => ({ templateName: null, successCriteria: 'Ship it', rationale: 'because', tasks, mode: 'active', executingOnPlan: true, createdAt: 'x', updatedAt: 'x' })
const thread = (id: string, tasks: PlanTaskRecord[], extra: Partial<GoalThread> = {}): GoalThread => ({ ...plan(tasks), id, status: 'ACTIVE', ...extra }) as GoalThread
const graph = (threads: GoalThread[], activeThreadId: string | null = threads[0]?.id ?? null): GoalGraphRecord => ({ threads, activeThreadId, createdAt: 'x', updatedAt: 'x' })

const STATUSES: TaskStatus[] = ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'BLOCKED', 'HUMAN_REQUIRED']
const SNAP: Record<TaskStatus, string> = { PENDING: 'pending', RUNNING: 'running', COMPLETE: 'done', FAILED: 'failed', BLOCKED: 'awaiting_input', HUMAN_REQUIRED: 'awaiting_user' }

describe('planToSnapshot status mapping', () => {
  for (const status of STATUSES) {
    for (const depState of ['none', 'done', 'unmet'] as const) {
      for (const cancelled of [false, true]) {
        it(`${status} / deps ${depState} / cancelled ${cancelled}`, () => {
          const deps = depState === 'none' ? [] : ['D']
          const p = plan([T('D', depState === 'done' ? 'COMPLETE' : 'PENDING'), T('X', status, deps, { cancelled })])
          const { snapshot, nodes } = planToSnapshot(p)
          const isCancelled = cancelled && status === 'COMPLETE'
          let expected = SNAP[status]
          if (status === 'PENDING' && depState !== 'unmet') expected = 'ready'
          expect(snapshot.nodes.X.status).toBe(isCancelled ? 'done' : expected)
          expect(nodes.find((n) => n.id === 'X')!.status).toBe(isCancelled ? 'cancelled' : expected)
          if (isCancelled) {
            expect(snapshot.nodes.X.metadata.description.startsWith('⊘ ')).toBe(true)
            expect(snapshot.nodes.X.result).toBe('(cancelled by you)')
          }
        })
      }
    }
  }

  it('FAILED sets result and verification_failure from statusNote', () => {
    const { snapshot } = planToSnapshot(plan([T('A', 'FAILED', [], { statusNote: 'wrong total' })]))
    expect(snapshot.nodes.A.result).toBe('wrong total')
    expect(snapshot.nodes.A.metadata.verification_failure).toBe('wrong total')
  })

  it('goal depends on exactly the terminal tasks and the dependency edges are mirrored as children', () => {
    const { snapshot } = planToSnapshot(plan([T('A', 'COMPLETE'), T('B', 'PENDING', ['A']), T('C', 'PENDING', ['A'])]))
    expect(snapshot.nodes.plan.node_type).toBe('goal')
    expect(snapshot.nodes.plan.dependencies.sort()).toEqual(['B', 'C'])
    expect(snapshot.nodes.A.children.sort()).toEqual(['B', 'C'])
    expect(snapshot.nodes.plan.metadata.description).toBe('Ship it')
    expect(snapshot.status.total).toBe(4)
  })

  it('a plan with no depends_on converts to all roots feeding the goal; every task appears once', () => {
    const { snapshot, nodes } = planToSnapshot(plan([T('A', 'PENDING'), T('B', 'PENDING'), T('C', 'PENDING')]))
    expect(Object.values(snapshot.nodes).filter((n) => n.node_type === 'task' && n.dependencies.length === 0)).toHaveLength(3)
    expect(nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', 'plan'])
  })

  it('an empty plan yields only a goal; a goal id never collides with a task id', () => {
    expect(Object.keys(planToSnapshot(plan([])).snapshot.nodes)).toEqual(['plan'])
    const { nodes } = planToSnapshot(plan([T('plan', 'PENDING')]))
    expect(new Set(nodes.map((n) => n.id)).size).toBe(2)
  })

  it('converts a legacy persisted record via migratePlanRecord', () => {
    const legacy = migratePlanRecord({ templateName: 't', successCriteria: 'goal', tasks: [T('A', 'COMPLETE')], status: 'active', createdAt: 'x', updatedAt: 'x' } as never)
    const { snapshot } = planToSnapshot(legacy)
    expect(snapshot.nodes.A.status).toBe('done')
    expect(snapshot.nodes.plan.status).toBe('done')
  })

  it('repairs malformed dependencies instead of throwing', () => {
    const { nodes, warnings } = planToSnapshot(plan([T('A', 'PENDING', ['B', 'ghost', 'A']), T('B', 'PENDING', ['A']), T('A', 'DONE' as never)]))
    expect(checkNormalized(nodes)).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('planToSnapshot threads', () => {
  it('namespaces task ids so identical ids in two threads do not collide', () => {
    const g = graph([thread('t1', [T('A', 'COMPLETE'), T('B', 'PENDING', ['A'])]), thread('t2', [T('A', 'RUNNING'), T('B', 'PENDING', ['A'])], { relationToSiblings: 'alternative' })])
    const { snapshot, nodes } = planToSnapshot(g)
    expect(Object.keys(snapshot.nodes).sort()).toEqual(['t1', 't1__A', 't1__B', 't2', 't2__A', 't2__B'])
    expect(snapshot.nodes.t1__B.dependencies).toEqual(['t1__A'])
    expect(snapshot.nodes.t2.dependencies).toEqual(['t2__B'])
    expect(snapshot.nodes.t2.metadata.description).toContain('alternative')
    expect(checkNormalized(nodes)).toEqual([])
    expect(isConnected(nodes)).toBe(false)
  })

  it('live overlay: un-namespaced ids hit only the active thread, namespaced ids anywhere', () => {
    const g = graph([thread('t1', [T('A', 'PENDING')]), thread('t2', [T('A', 'PENDING')])], 't2')
    const a = planToSnapshot(g, [{ id: 'A', status: 'RUNNING' }]).snapshot
    expect(a.nodes.t2__A.status).toBe('running')
    expect(a.nodes.t1__A.status).toBe('ready')
    expect(planToSnapshot(g, [{ id: 't1__A', status: 'COMPLETE' }]).snapshot.nodes.t1__A.status).toBe('done')
  })
})

describe('planToSnapshot live progress', () => {
  it('overlay statuses and activity come from the running task', () => {
    const p = plan([T('A', 'PENDING'), T('B', 'PENDING', ['A'])])
    const { snapshot } = planToSnapshot(p, [{ id: 'A', status: 'COMPLETE' }, { id: 'B', status: 'RUNNING' }])
    expect(snapshot.nodes.A.status).toBe('done')
    expect(snapshot.nodes.B.status).toBe('running')
    expect(snapshot.activity).toBe('Executing: B')
    expect(snapshot.status.running_nodes).toEqual(['B'])
    expect(planToSnapshot(p, [], { currentNode: 'A' }).snapshot.activity).toBe('Executing: A')
    expect(planToSnapshot(p).snapshot.activity).toBeNull()
  })

  it('does not mutate the source record', () => {
    const p = plan([T('A', 'PENDING')])
    const before = JSON.stringify(p)
    planToSnapshot(p, [{ id: 'A', status: 'COMPLETE' }])
    expect(JSON.stringify(p)).toBe(before)
  })
})

describe('planToSnapshot over the test kit', () => {
  const fromViz = (nodes: VizNode[]): PlanRecord => {
    const rev: Record<string, TaskStatus> = { pending: 'PENDING', ready: 'PENDING', running: 'RUNNING', done: 'COMPLETE', failed: 'FAILED', awaiting_user: 'HUMAN_REQUIRED', awaiting_input: 'BLOCKED', cancelled: 'COMPLETE' }
    return plan(nodes.map((n) => T(n.id, rev[n.status], n.deps, { cancelled: n.status === 'cancelled' })))
  }
  const check = (name: string, nodes: VizNode[]): void => {
    const { nodes: out, snapshot } = planToSnapshot(fromViz(nodes))
    expect(checkNormalized(out), name).toEqual([])
    expect(isConnected(out), name).toBe(true)
    expect(out.length, name).toBe(nodes.length + 1)
    expect(Object.keys(snapshot.nodes).length, name).toBe(nodes.length + 1)
  }
  it('named plans', () => {
    for (const [name, p] of Object.entries(NAMED_PLANS)) {
      if (name === 'twoThreads') continue
      check(name, p.nodes)
    }
  })
  it('seeded random plans', () => {
    for (let seed = 0; seed < 150; seed++) check(`seed ${seed}`, randomPlan(seed, { goal: false }))
  })
  it('the seven real templates', () => {
    for (const [name, p] of Object.entries(templatePlans())) check(name, p)
  })
})
