import type { ILLMClient } from './llm-client'
import type { FlowState } from './state'
import { EventBus } from './events'
import { UnknownToolError } from './errors'

export interface ToolDef {
  name: string
  description?: string
  execute(args: Record<string, unknown>): Promise<unknown>
}

export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map()

  register(name: string, def: ToolDef): void {
    this.tools.set(name, def)
  }

  async invoke(nodeId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new UnknownToolError({ nodeId, toolName: name })
    return tool.execute(args)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }
}

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

export interface MemoryAdapter {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, mode?: string): Promise<void>
  search(query: string, topK?: number, minScore?: number): Promise<{ key: string; value: unknown; score: number }[]>
  delete(key: string): Promise<void>
}

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
  return {
    llmClient: opts.llmClient,
    toolRegistry: opts.toolRegistry ?? new ToolRegistry(),
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
