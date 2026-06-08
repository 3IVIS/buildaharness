import type { ILLMClient } from './llm-client'
import type { FlowState } from './state'  // used in branchResults map type
import { EventBus } from './events'
import { ToolDef, ToolRegistry } from './tools/registry'
import { BUILT_IN_TOOLS } from './tools/built-ins'

export { ToolDef, ToolRegistry }

export interface RetryConfig {
  maxRetries: number
  retryOn: string[]
  delayBaseMs: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  retryOn: ['network', '429'],
  delayBaseMs: 100,
}

export type FlowFunction = (state: Record<string, unknown>) => Record<string, unknown>
export type FunctionRegistry = Map<string, FlowFunction>

export type { MemoryAdapter } from './memory/adapter'
import type { MemoryAdapter } from './memory/adapter'

export interface ExecutionContext {
  readonly llmClient: ILLMClient
  readonly toolRegistry: ToolRegistry
  readonly memoryAdapters: Map<string, MemoryAdapter>
  readonly eventBus: EventBus
  readonly signal: AbortSignal
  readonly functions: FunctionRegistry
  readonly hitlResolvers: Map<string, (payload: unknown) => void>
  readonly branchResults: Map<string, FlowState[]>
  readonly retryConfig: RetryConfig
}

export function createExecutionContext(opts: {
  llmClient: ILLMClient
  toolRegistry?: ToolRegistry
  memoryAdapters?: Map<string, MemoryAdapter>
  eventBus?: EventBus
  abortController?: AbortController
  functions?: FunctionRegistry
  retryConfig?: Partial<RetryConfig>
}): ExecutionContext & { abortController: AbortController } {
  const abortController = opts.abortController ?? new AbortController()
  const retryConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...opts.retryConfig,
  }
  const toolRegistry = opts.toolRegistry ?? new ToolRegistry()
  // Register built-in tools if not already registered by the caller
  for (const tool of BUILT_IN_TOOLS) {
    if (!toolRegistry.get(tool.name)) {
      toolRegistry.register(tool.name, tool)
    }
  }
  return {
    llmClient: opts.llmClient,
    toolRegistry,
    memoryAdapters: opts.memoryAdapters ?? new Map(),
    eventBus: opts.eventBus ?? new EventBus(),
    signal: abortController.signal,
    functions: opts.functions ?? new Map(),
    hitlResolvers: new Map(),
    branchResults: new Map(),
    retryConfig,
    abortController,
  }
}
