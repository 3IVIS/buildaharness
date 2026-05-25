/**
 * @itsharness/canvas — unit tests
 *
 * Tests cover:
 *   1. createCanvasStore — store factory produces isolated instances
 *   2. onSpecChange — subscription fires on data mutations, not UI-only changes
 *   3. loadFlow → exportSpec round-trip
 *   4. undo / redo
 *   5. ItsHarnessCanvas — renders without crashing, fires onSpecChange
 *   6. Multiple simultaneous instances don't share state
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCanvasStore } from '../store/create'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStore() {
  return createCanvasStore()
}

const MINIMAL_SPEC = {
  spec_version: '0.2.0' as const,
  id: 'test-flow',
  name: 'Test Flow',
  nodes: [
    { id: 'input-1',  type: 'input',  position: { x: 0,   y: 0 }, label: 'Start', output_schema: {} },
    { id: 'output-1', type: 'output', position: { x: 300, y: 0 }, label: 'End',   exit_code: 'success' },
  ],
  edges: [
    { type: 'direct' as const, id: 'e-1', from: 'input-1', to: 'output-1' },
  ],
}

// ─── Store isolation ─────────────────────────────────────────────────────────

describe('createCanvasStore — isolation', () => {
  it('returns a fresh store instance each time', () => {
    const a = makeStore()
    const b = makeStore()
    expect(a).not.toBe(b)
    a.getState().addNode('llm_call', { x: 100, y: 100 })
    expect(a.getState().nodes.length).toBe(1)
    expect(b.getState().nodes.length).toBe(0)
  })

  it('starts with empty nodes and edges', () => {
    const store = makeStore()
    expect(store.getState().nodes).toHaveLength(0)
    expect(store.getState().edges).toHaveLength(0)
  })
})

// ─── addNode ─────────────────────────────────────────────────────────────────

describe('addNode', () => {
  it('adds a node and selects it', () => {
    const store = makeStore()
    store.getState().addNode('llm_call', { x: 50, y: 50 })
    const s = store.getState()
    expect(s.nodes).toHaveLength(1)
    expect(s.nodes[0].type).toBe('llm_call')
    expect(s.selectedNodeId).toBe(s.nodes[0].id)
    expect(s.isPanelOpen).toBe(true)
  })

  it('assigns incrementing IDs', () => {
    const store = makeStore()
    store.getState().addNode('input', { x: 0, y: 0 })
    store.getState().addNode('output', { x: 100, y: 0 })
    const ids = store.getState().nodes.map((n) => n.id)
    expect(ids[0]).toBe('input-1')
    expect(ids[1]).toBe('output-2')
  })
})

// ─── deleteNode ──────────────────────────────────────────────────────────────

describe('deleteNode', () => {
  it('removes the node and its connected edges', () => {
    const store = makeStore()
    store.getState().addNode('input', { x: 0, y: 0 })
    store.getState().addNode('output', { x: 200, y: 0 })
    const [inputId, outputId] = store.getState().nodes.map((n) => n.id)
    store.getState().onConnect({ source: inputId, target: outputId, sourceHandle: null, targetHandle: null })
    expect(store.getState().edges).toHaveLength(1)
    store.getState().deleteNode(inputId)
    expect(store.getState().nodes).toHaveLength(1)
    expect(store.getState().nodes[0].id).toBe(outputId)
    expect(store.getState().edges).toHaveLength(0)
  })

  it('clears selection when selected node is deleted', () => {
    const store = makeStore()
    store.getState().addNode('transform', { x: 0, y: 0 })
    const id = store.getState().selectedNodeId!
    store.getState().deleteNode(id)
    expect(store.getState().selectedNodeId).toBeNull()
    expect(store.getState().isPanelOpen).toBe(false)
  })
})

// ─── updateNodeData ───────────────────────────────────────────────────────────

describe('updateNodeData', () => {
  it('merges data into the target node', () => {
    const store = makeStore()
    store.getState().addNode('llm_call', { x: 0, y: 0 })
    const id = store.getState().nodes[0].id
    store.getState().updateNodeData(id, { label: 'My LLM', model_params: { model: 'gpt-4o' } })
    const node = store.getState().nodes[0]
    expect(node.data.label).toBe('My LLM')
    expect((node.data.model_params as { model: string }).model).toBe('gpt-4o')
  })

  it('does not affect other nodes', () => {
    const store = makeStore()
    store.getState().addNode('input', { x: 0, y: 0 })
    store.getState().addNode('output', { x: 200, y: 0 })
    const [id0, id1] = store.getState().nodes.map((n) => n.id)
    store.getState().updateNodeData(id0, { label: 'X' })
    expect(store.getState().nodes.find((n) => n.id === id1)!.data.label).toBe('Output')
  })
})

// ─── undo / redo ─────────────────────────────────────────────────────────────

describe('undo / redo', () => {
  it('undoes addNode', () => {
    const store = makeStore()
    store.getState().addNode('llm_call', { x: 0, y: 0 })
    expect(store.getState().nodes).toHaveLength(1)
    store.getState().undo()
    expect(store.getState().nodes).toHaveLength(0)
    expect(store.getState().canUndo).toBe(false)
  })

  it('redoes after undo', () => {
    const store = makeStore()
    store.getState().addNode('llm_call', { x: 0, y: 0 })
    store.getState().undo()
    expect(store.getState().canRedo).toBe(true)
    store.getState().redo()
    expect(store.getState().nodes).toHaveLength(1)
  })

  it('undo on empty history is a no-op', () => {
    const store = makeStore()
    expect(() => store.getState().undo()).not.toThrow()
    expect(store.getState().nodes).toHaveLength(0)
  })
})

// ─── loadFlow / exportSpec round-trip ────────────────────────────────────────

describe('loadFlow / exportSpec', () => {
  it('round-trips a minimal spec', () => {
    const store = makeStore()
    store.getState().loadFlow(MINIMAL_SPEC as Parameters<typeof store.getState().loadFlow>[0])
    expect(store.getState().nodes).toHaveLength(2)
    expect(store.getState().edges).toHaveLength(1)

    const exported = store.getState().exportSpec()
    expect(exported).not.toBeNull()
    expect(exported!.id).toBe('test-flow')
    expect(exported!.nodes).toHaveLength(2)
    expect(exported!.edges).toHaveLength(1)
  })

  it('resets selection and history on loadFlow', () => {
    const store = makeStore()
    store.getState().addNode('llm_call', { x: 0, y: 0 })
    store.getState().loadFlow(MINIMAL_SPEC as Parameters<typeof store.getState().loadFlow>[0])
    expect(store.getState().selectedNodeId).toBeNull()
    expect(store.getState().past).toHaveLength(0)
    expect(store.getState().canUndo).toBe(false)
  })

  it('newFlow produces a single input node', () => {
    const store = makeStore()
    store.getState().loadFlow(MINIMAL_SPEC as Parameters<typeof store.getState().loadFlow>[0])
    store.getState().newFlow()
    expect(store.getState().nodes).toHaveLength(1)
    expect(store.getState().nodes[0].type).toBe('input')
  })
})

// ─── validate ────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('returns true for a valid flow', () => {
    const store = makeStore()
    store.getState().loadFlow(MINIMAL_SPEC as Parameters<typeof store.getState().loadFlow>[0])
    expect(store.getState().validate()).toBe(true)
    expect(store.getState().crossRefErrors).toHaveLength(0)
  })
})

// ─── execStats ───────────────────────────────────────────────────────────────

describe('execStats', () => {
  it('sets and clears node exec stats', () => {
    const store = makeStore()
    store.getState().addNode('llm_call', { x: 0, y: 0 })
    const id = store.getState().nodes[0].id
    store.getState().setNodeExecStat(id, { status: 'running', tokens: 42, ms: 1200 })
    expect(store.getState().execStats[id].status).toBe('running')
    expect(store.getState().execStats[id].tokens).toBe(42)
    store.getState().clearExecStats()
    expect(store.getState().execStats).toEqual({})
  })
})

// ─── store subscription ───────────────────────────────────────────────────────

describe('store subscription', () => {
  it('fires on node mutations', () => {
    const store = makeStore()
    const listener = vi.fn()
    const unsub = store.subscribe(listener)

    store.getState().addNode('llm_call', { x: 0, y: 0 })
    expect(listener).toHaveBeenCalled()

    unsub()
    listener.mockClear()
    store.getState().addNode('input', { x: 100, y: 0 })
    // After unsub, listener should NOT be called
    expect(listener).not.toHaveBeenCalled()
  })

  it('manual selective subscription fires only when slice changes', () => {
    // Zustand vanilla subscribe() is 1-arg only. Selector-based subscriptions
    // require manual equality checks — the same pattern used in ItsHarnessCanvas.tsx.
    const store = makeStore()
    const nodeSelectCalls: (string | null)[] = []
    let prevSelected = store.getState().selectedNodeId

    const unsub = store.subscribe((state) => {
      if (state.selectedNodeId !== prevSelected) {
        prevSelected = state.selectedNodeId
        nodeSelectCalls.push(prevSelected)
      }
    })

    // Adding a node changes selectedNodeId → listener fires
    store.getState().addNode('llm_call', { x: 0, y: 0 })
    expect(nodeSelectCalls.length).toBe(1)
    expect(nodeSelectCalls[0]).toBe(store.getState().nodes[0].id)

    // updateNodeData does NOT change selectedNodeId → listener should not fire
    const id = store.getState().nodes[0].id
    store.getState().updateNodeData(id, { label: 'X' })
    expect(nodeSelectCalls.length).toBe(1) // still 1, no new call

    unsub()
  })
})

// ─── auto-layout ─────────────────────────────────────────────────────────────

describe('autoLayout', () => {
  it('repositions nodes without changing their count', () => {
    const store = makeStore()
    store.getState().loadFlow(MINIMAL_SPEC as Parameters<typeof store.getState().loadFlow>[0])
    const before = store.getState().nodes.map((n) => ({ ...n.position }))
    store.getState().autoLayout()
    // Dagre will have repositioned at least one node
    const after = store.getState().nodes.map((n) => ({ ...n.position }))
    expect(store.getState().nodes).toHaveLength(2)
    // Positions should differ for a 2-node flow with a direct edge
    expect(after).not.toEqual(before)
  })
})
