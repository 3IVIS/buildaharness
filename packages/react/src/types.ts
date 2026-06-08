import type { ILLMClient, ToolDef, FlowFunction, MemoryAdapter, EventBus } from '@itsharness/runtime'

export type HarnessStatus = 'idle' | 'running' | 'paused' | 'complete' | 'error'

/** Compatible with canvas NodeExecStat — passes straight through to execStats prop. */
export interface NodeExecStat {
  status: 'pending' | 'running' | 'paused' | 'done' | 'error'
  tokens?: number
  ms?: number
  score?: number
}

export interface HarnessOptions {
  proxyUrl?: string
  authToken?: string
  /** Override the LLM client entirely (useful for testing). Takes precedence over proxyUrl/authToken. */
  llmClient?: ILLMClient
  tools?: ToolDef[]
  memoryAdapters?: Map<string, MemoryAdapter>
  functions?: Map<string, FlowFunction>
}

export interface HarnessHandle {
  /** Start a new run. Aborts any in-progress run first. */
  run: (triggerData?: Record<string, unknown>) => Promise<void>
  /** Resolve a HITL breakpoint. Validates payload against hitlResumeSchema first. */
  resume: (nodeId: string, payload: unknown) => void
  /** Abort the current run. Sets status to 'error'. */
  abort: () => void
  /** Reset all state back to idle. Aborts any in-progress run. */
  reset: () => void
  status: HarnessStatus
  /** Final (or latest intermediate) flow state. */
  state: Record<string, unknown>
  /** Per-node execution stats. Compatible with ItsHarnessCanvas execStats prop. */
  nodeStats: Record<string, NodeExecStat>
  /** Live streaming token accumulator per nodeId. Cleared on node complete. */
  streamingTokens: Record<string, string>
  hitlPrompt: string | null
  hitlResumeSchema: object | null
  error: unknown
  /** Raw EventBus for the current (or most recent) run. Null before first run. */
  events: EventBus | null
}
