import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TaskGraph, type Task } from '../state/task-graph.js'
import { applyTaskOutcome } from './apply-task-outcome.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    description: 'task',
    status: 'PENDING',
    risk_level: 'LOW',
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 0,
    assigned_strategy: null,
    ...overrides,
  }
}

describe('applyTaskOutcome (Phase H, ADR-003 F-2)', () => {
  it('transitions status through the wrapped TaskGraph.setStatus', () => {
    const tg = new TaskGraph({ tasks: [makeTask({ status: 'PENDING' })] })
    applyTaskOutcome(tg, 't1', { status: 'RUNNING' })
    expect(tg.getTask('t1')?.status).toBe('RUNNING')
  })

  it('rejects FAILED without fromExecutionLayer, same as setStatus', () => {
    const tg = new TaskGraph({ tasks: [makeTask({ status: 'RUNNING' })] })
    expect(() => applyTaskOutcome(tg, 't1', { status: 'FAILED' })).toThrow()
    expect(() => applyTaskOutcome(tg, 't1', { status: 'FAILED', fromExecutionLayer: true })).not.toThrow()
  })

  it('COMPLETE is terminal, same as setStatus', () => {
    const tg = new TaskGraph({ tasks: [makeTask({ status: 'COMPLETE' })] })
    expect(() => applyTaskOutcome(tg, 't1', { status: 'RUNNING' })).toThrow()
  })
})

describe('INV-17 — single task-status writer', () => {
  it('no production file outside state/task-graph.ts and nodes/apply-task-outcome.ts calls TaskGraph.setStatus(...) directly', () => {
    const srcDir = join(__dirname, '..')
    const offenders: string[] = []
    const allowed = new Set(['task-graph.ts', 'apply-task-outcome.ts'])

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !allowed.has(entry)) {
          const content = readFileSync(full, 'utf-8')
          if (/\.setStatus\(/.test(content)) {
            offenders.push(full)
          }
        }
      }
    }

    walk(srcDir)
    expect(offenders).toEqual([])
  })
})
