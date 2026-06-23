import { useReducer, useRef, useCallback } from 'react'
import {
  FlowRuntime,
  LLMClient,
  ToolRegistry,
  createExecutionContext,
  EventBus,
} from '@buildaharness/runtime'
import type {
  NodeStartEvent,
  NodeCompleteEvent,
  NodeErrorEvent,
  TokenChunkEvent,
  FlowPausedEvent,
} from '@buildaharness/runtime'
import type { HarnessOptions, HarnessHandle, HarnessStatus, NodeExecStat } from './types'

// ─── Reducer ─────────────────────────────────────────────────────────────────

interface HookState {
  status: HarnessStatus
  flowState: Record<string, unknown>
  nodeStats: Record<string, NodeExecStat>
  streamingTokens: Record<string, string>
  hitlPrompt: string | null
  hitlResumeSchema: object | null
  error: unknown
}

const INITIAL_STATE: HookState = {
  status: 'idle',
  flowState: {},
  nodeStats: {},
  streamingTokens: {},
  hitlPrompt: null,
  hitlResumeSchema: null,
  error: null,
}

type Action =
  | { type: 'RUN_START' }
  | { type: 'NODE_START'; nodeId: string }
  | { type: 'NODE_COMPLETE'; nodeId: string; durationMs: number; tokenCount?: number }
  | { type: 'NODE_ERROR'; nodeId: string }
  | { type: 'TOKEN_CHUNK'; nodeId: string; token: string }
  | { type: 'FLOW_PAUSED'; prompt: string; resumeSchema: object }
  | { type: 'RESUME_STARTED' }
  | { type: 'FLOW_COMPLETE'; finalState: Record<string, unknown> }
  | { type: 'FLOW_ERROR'; error: unknown }
  | { type: 'RESET' }

function reducer(state: HookState, action: Action): HookState {
  switch (action.type) {
    case 'RUN_START':
      return { ...INITIAL_STATE, status: 'running' }

    case 'NODE_START':
      return {
        ...state,
        nodeStats: { ...state.nodeStats, [action.nodeId]: { status: 'running' } },
      }

    case 'NODE_COMPLETE': {
      const { [action.nodeId]: _removed, ...restTokens } = state.streamingTokens
      return {
        ...state,
        nodeStats: {
          ...state.nodeStats,
          [action.nodeId]: {
            status: 'done',
            ms: action.durationMs,
            ...(action.tokenCount !== undefined ? { tokens: action.tokenCount } : {}),
          },
        },
        streamingTokens: restTokens,
      }
    }

    case 'NODE_ERROR':
      return {
        ...state,
        nodeStats: {
          ...state.nodeStats,
          [action.nodeId]: {
            ...(state.nodeStats[action.nodeId] ?? {}),
            status: 'error',
          },
        },
      }

    case 'TOKEN_CHUNK':
      return {
        ...state,
        streamingTokens: {
          ...state.streamingTokens,
          [action.nodeId]: (state.streamingTokens[action.nodeId] ?? '') + action.token,
        },
      }

    case 'FLOW_PAUSED':
      return {
        ...state,
        status: 'paused',
        hitlPrompt: action.prompt,
        hitlResumeSchema: action.resumeSchema,
      }

    case 'RESUME_STARTED':
      return { ...state, status: 'running', hitlPrompt: null, hitlResumeSchema: null }

    case 'FLOW_COMPLETE':
      return {
        ...state,
        status: 'complete',
        flowState: action.finalState,
        hitlPrompt: null,
        hitlResumeSchema: null,
        error: null,
      }

    case 'FLOW_ERROR':
      return {
        ...state,
        status: 'error',
        error: action.error,
        hitlPrompt: null,
        hitlResumeSchema: null,
      }

    case 'RESET':
      return { ...INITIAL_STATE }

    default:
      return state
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useHarness(flowSpec: unknown, options: HarnessOptions): HarnessHandle {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)

  const runtimeRef = useRef<FlowRuntime | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  // Keep resume schema in a ref so the resume() callback can read it without being a dependency
  const resumeSchemaRef = useRef<object | null>(null)

  const run = useCallback(
    async (triggerData: Record<string, unknown> = {}) => {
      // Abort any in-progress run before starting a new one
      abortControllerRef.current?.abort()

      dispatch({ type: 'RUN_START' })

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      const eventBus = new EventBus()
      eventBusRef.current = eventBus

      const llmClient = options.llmClient ?? new LLMClient({
        proxyUrl: options.proxyUrl ?? '',
        authToken: options.authToken ?? '',
      })

      const toolRegistry = new ToolRegistry()
      for (const tool of options.tools ?? []) {
        toolRegistry.register(tool.name, tool)
      }

      const context = createExecutionContext({
        llmClient,
        toolRegistry,
        eventBus,
        abortController,
        memoryAdapters: options.memoryAdapters,
        functions: options.functions,
      })

      const unsubscribes = [
        eventBus.subscribe('node:start', (e: NodeStartEvent) =>
          dispatch({ type: 'NODE_START', nodeId: e.nodeId }),
        ),
        eventBus.subscribe('node:complete', (e: NodeCompleteEvent) =>
          dispatch({ type: 'NODE_COMPLETE', nodeId: e.nodeId, durationMs: e.durationMs, tokenCount: e.tokenCount }),
        ),
        eventBus.subscribe('node:error', (e: NodeErrorEvent) =>
          dispatch({ type: 'NODE_ERROR', nodeId: e.nodeId }),
        ),
        eventBus.subscribe('token:chunk', (e: TokenChunkEvent) =>
          dispatch({ type: 'TOKEN_CHUNK', nodeId: e.nodeId, token: e.token }),
        ),
        eventBus.subscribe('flow:paused', (e: FlowPausedEvent) => {
          resumeSchemaRef.current = e.resumeSchema
          dispatch({ type: 'FLOW_PAUSED', prompt: e.prompt, resumeSchema: e.resumeSchema })
        }),
      ]

      const runtime = new FlowRuntime()
      runtimeRef.current = runtime

      try {
        const finalState = await runtime.execute(flowSpec, triggerData, context)
        dispatch({ type: 'FLOW_COMPLETE', finalState: finalState.toJSON() })
      } catch (err) {
        dispatch({ type: 'FLOW_ERROR', error: err })
      } finally {
        for (const unsub of unsubscribes) unsub()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flowSpec, options],
  )

  const resume = useCallback((nodeId: string, payload: unknown) => {
    // Fast-fail validation: check required fields from stored resume schema
    const schema = resumeSchemaRef.current
    if (schema && typeof payload === 'object' && payload !== null) {
      const required = (schema as { required?: string[] }).required ?? []
      for (const field of required) {
        if (!(field in (payload as Record<string, unknown>))) {
          throw new Error(`useHarness resume: missing required field "${field}"`)
        }
      }
    }
    dispatch({ type: 'RESUME_STARTED' })
    runtimeRef.current?.resume(nodeId, payload)
  }, [])

  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
    // The FLOW_ERROR dispatch happens naturally when execute() throws AbortedError
  }, [])

  const reset = useCallback(() => {
    abortControllerRef.current?.abort()
    resumeSchemaRef.current = null
    dispatch({ type: 'RESET' })
  }, [])

  return {
    run,
    resume,
    abort,
    reset,
    status: state.status,
    state: state.flowState,
    nodeStats: state.nodeStats,
    streamingTokens: state.streamingTokens,
    hitlPrompt: state.hitlPrompt,
    hitlResumeSchema: state.hitlResumeSchema,
    error: state.error,
    events: eventBusRef.current,
  }
}
