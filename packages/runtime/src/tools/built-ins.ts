import type { ToolDef } from './registry'

const fetchTool: ToolDef = {
  name: 'fetch',
  description: 'Make an HTTP request. Returns { status, data } where data is parsed JSON or raw text.',
  async execute(args: Record<string, unknown>): Promise<unknown> {
    const url = args['url'] as string
    const method = (args['method'] as string | undefined) ?? 'GET'
    const headers = (args['headers'] as Record<string, string> | undefined) ?? {}
    const body = args['body']

    const init: RequestInit = { method, headers }
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
    }

    const response = await fetch(url, init)
    const text = await response.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: response.status, data }
  },
}

const searchTool: ToolDef = {
  name: 'search',
  description: 'Stub search tool. Override via registry.register("search", customDef) in your host app.',
  async execute(_args: Record<string, unknown>): Promise<unknown> {
    return []
  },
}

export const BUILT_IN_TOOLS: ToolDef[] = [fetchTool, searchTool]
