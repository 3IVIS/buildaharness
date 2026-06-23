/**
 * Typed API client for the buildaharness adapter backend.
 * Reads VITE_API_URL (defaults to http://localhost:8000).
 */
import { getAuthToken } from '../store/auth'

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'

function authHeaders(): Record<string, string> {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...(init?.headers as Record<string, string> | undefined),
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }))
    console.error('[api] error', res.status, body)
    throw new Error((body as { detail?: string }).detail ?? 'Request failed')
  }

  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

// ── Response types ────────────────────────────────────────────────────────────

export interface TokenResponse {
  token:      string
  token_type: string
  user_id:    string
  email:      string
}

export interface FlowSummary {
  id:         string
  name:       string
  updated_at: string
  created_at: string
}

export interface VersionSummary {
  id:          string
  version_num: number
  label:       string | null
  created_at:  string
}

export interface SaveFlowResponse {
  id:          string
  version_num: number
}

export interface HitlState {
  node_id:              string
  prompt:               string
  resume_schema_fields: string[]
}

export interface RunJobResponse {
  job_id:      string
  status:      'queued' | 'running' | 'paused' | 'done' | 'error'
  runtime:     string
  started_at:  string
  ended_at:    string | null
  result:      string | null
  error:       string | null
  node_events: Array<{
    node_id:       string
    status:        'pending' | 'running' | 'paused' | 'done' | 'error'
    ts:            string
    ms:            number | null
    tokens:        number | null
    error_message: string | null
  }>
  hitl_state:  HitlState | null
  trace_id:    string | null
  trace_url:   string | null
}

/** A single LLM-as-judge or user-feedback score from Langfuse. */
export interface EvalScore {
  id:             string
  traceId:        string
  name:           string
  value:          number
  observationId?: string | null
  comment?:       string | null
}

/** A registered LLM-as-judge evaluator config from Langfuse. */
export interface EvalTemplate {
  id:   string
  name: string
}

/** A prompt registered in Langfuse Prompt Management. */
export interface PromptSummary {
  name:    string
  version: number
  labels:  string[]
}

/** Full detail for a single Langfuse prompt (for the config panel preview). */
export interface PromptDetail {
  name:     string
  version:  number
  prompt:   string    // raw template text, truncated to 2000 chars
  labels:   string[]
  versions: number[]  // all available version numbers
}

/** Response from POST /deploy/a2a/{flow_id} */
export interface A2ADeployResponse {
  flow_id:      string
  endpoint_url: string
  agent_card:   Record<string, unknown>
  deployed_at:  string
}

/** Response from POST /deploy/{flow_id} — unified one-click deploy */
export interface UnifiedDeployResponse {
  flow_id:       string
  rest_url:      string
  mcp_url:       string
  a2a_url:       string | null
  shareable_url: string
  mcp_manifest:  Record<string, unknown>
  deployed_at:   string
}

/** Public metadata returned by GET /share/{flow_id} */
export interface ShareResponse {
  flow_id:       string
  flow_name:     string
  rest_url:      string
  mcp_url:       string
  a2a_url:       string | null
  shareable_url: string
  deployed_at:   string
}

/** Response from POST /flows/{flow_id}/invoke */
export interface InvokeResponse {
  job_id:  string
  output:  unknown
  runtime: string
}

/** A community component from the marketplace */
export interface MarketplaceComponent {
  slug:          string
  name:          string
  description:   string
  category:      'tool' | 'memory' | 'agent' | 'control'
  icon_emoji:    string
  npm_ref:       string
  source:        string
  tags:          string[]
  verified:      boolean
  author:        string
  install_count: number
}

/** Full component detail including node_spec and tool_def */
export interface MarketplaceComponentDetail extends MarketplaceComponent {
  node_spec:  Record<string, unknown>
  tool_def:   Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/** Response from POST /marketplace/{slug}/install */
export interface MarketplaceInstallResponse {
  slug:      string
  name:      string
  node_spec: Record<string, unknown>
  tool_def:  Record<string, unknown> | null
  tool_id:   string
}

/** A2A Task object returned by /tasks/send and /tasks/{id} */
export interface A2ATaskResponse {
  id:      string
  flow_id: string
  status:  { state: 'submitted' | 'working' | 'completed' | 'failed' | 'input-required' }
  result:  string | null
  error:   string | null
}

// ── API surface ───────────────────────────────────────────────────────────────

export const api = {
  auth: {
    register: (email: string, password: string) =>
      request<TokenResponse>('/auth/register', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }),

    login: (email: string, password: string) =>
      request<TokenResponse>('/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }),

    me: () => request<{ user_id: string; email: string }>('/auth/me'),
  },

  flows: {
    list: ()              => request<FlowSummary[]>('/flows'),
    save: (spec: unknown) => request<SaveFlowResponse>('/flows', {
      method: 'POST', body: JSON.stringify({ spec }),
    }),
    get:    (id: string) => request<unknown>(`/flows/${id}`),
    delete: (id: string) => request<void>(`/flows/${id}`, { method: 'DELETE' }),

    versions: {
      list: (flowId: string) =>
        request<VersionSummary[]>(`/flows/${flowId}/versions`),
      get: (flowId: string, versionId: string) =>
        request<unknown>(`/flows/${flowId}/versions/${versionId}`),
      restore: (flowId: string, versionId: string) =>
        request<SaveFlowResponse>(`/flows/${flowId}/versions/${versionId}/restore`, {
          method: 'POST',
        }),
    },
  },

  run: {
    start: (spec: unknown, inputs: Record<string, unknown>, runtime?: string) =>
      request<{ job_id: string; status: string; runtime: string }>(
        `/run${runtime ? `?runtime=${runtime}` : ''}`,
        { method: 'POST', body: JSON.stringify({ spec, inputs }) },
      ),

    status: (jobId: string) => request<RunJobResponse>(`/run/${jobId}`),

    resume: (jobId: string, payload: Record<string, unknown>) =>
      request<{ job_id: string; status: string }>(`/run/${jobId}/resume`, {
        method: 'POST', body: JSON.stringify({ payload }),
      }),
  },

  eval: {
    /** Submit user thumbs-up (+1), thumbs-down (-1), or neutral (0) for a completed job. */
    feedback: (jobId: string, value: 1 | -1 | 0, comment?: string) =>
      request<void>('/eval/feedback', {
        method: 'POST',
        body: JSON.stringify({ job_id: jobId, value, ...(comment ? { comment } : {}) }),
      }),

    /** List active LLM-as-judge evaluator configs registered in Langfuse. */
    templates: () =>
      request<{ data: EvalTemplate[] }>('/eval/templates'),

    /** Fetch all scores attached to a Langfuse trace (for canvas quality badges). */
    scores: (traceId: string) =>
      request<{ data: EvalScore[] }>(`/eval/scores?trace_id=${encodeURIComponent(traceId)}`),
  },

  prompts: {
    /** List all Langfuse-managed prompts.  Used to populate the PromptPicker dropdown. */
    list: (limit = 50) =>
      request<PromptSummary[]>(`/prompts?limit=${limit}`),

    /** Fetch a specific prompt with version list + content preview. */
    get: (name: string) =>
      request<PromptDetail>(`/prompts/${encodeURIComponent(name)}`),
  },

  a2a: {
    /** Deploy a flow as an A2A agent.  Upserts the deployment record and
     *  returns the stable endpoint URL + AgentCard snapshot. */
    deploy: (flowId: string) =>
      request<A2ADeployResponse>(`/deploy/a2a/${encodeURIComponent(flowId)}`, {
        method: 'POST',
      }),

    /** Remove the A2A deployment for a flow. Idempotent. */
    undeploy: (flowId: string) =>
      request<void>(`/deploy/a2a/${encodeURIComponent(flowId)}`, {
        method: 'DELETE',
      }),

    /** Fetch the AgentCard for a deployed flow (public — no auth needed,
     *  but we still pass auth so it works behind API gateways). */
    agentCard: (flowId: string) =>
      request<Record<string, unknown>>(
        `/.well-known/agent/${encodeURIComponent(flowId)}.json`
      ),

    /** Send an A2A task to a flow. */
    sendTask: (flowId: string, taskId: string, text: string) =>
      request<A2ATaskResponse>(`/a2a/${encodeURIComponent(flowId)}/tasks/send`, {
        method: 'POST',
        body: JSON.stringify({
          id: taskId,
          message: { role: 'user', parts: [{ type: 'text', text }] },
        }),
      }),

    /** Poll task status. */
    getTask: (flowId: string, taskId: string) =>
      request<A2ATaskResponse>(
        `/a2a/${encodeURIComponent(flowId)}/tasks/${encodeURIComponent(taskId)}`
      ),
  },

  deploy: {
    /** One-click unified deploy: REST endpoint + MCP tool + A2A agent (when enabled).
     *  Idempotent — re-deploying updates the snapshot to the current spec. */
    unified: (flowId: string) =>
      request<UnifiedDeployResponse>(`/deploy/${encodeURIComponent(flowId)}`, {
        method: 'POST',
      }),

    /** Remove the unified deployment (and A2A deployment) for a flow. Idempotent. */
    undeployAll: (flowId: string) =>
      request<void>(`/deploy/${encodeURIComponent(flowId)}`, {
        method: 'DELETE',
      }),

    /** Fetch public share metadata for a deployed flow (no auth required). */
    share: (flowId: string) =>
      request<ShareResponse>(`/share/${encodeURIComponent(flowId)}`),

    /** Synchronously invoke a deployed flow and return the result.
     *  Blocks until the flow completes or the server times out (default 120s). */
    invoke: (flowId: string, input: Record<string, unknown> = {}) =>
      request<InvokeResponse>(`/flows/${encodeURIComponent(flowId)}/invoke`, {
        method: 'POST',
        body: JSON.stringify({ input }),
      }),
  },

  marketplace: {
    /** List components; supports q, category, verified, limit, offset */
    list: (params: { q?: string; category?: string; verified?: boolean; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams()
      if (params.q        !== undefined) qs.set('q',        params.q)
      if (params.category !== undefined) qs.set('category', params.category)
      if (params.verified !== undefined) qs.set('verified', String(params.verified))
      if (params.limit    !== undefined) qs.set('limit',    String(params.limit))
      if (params.offset   !== undefined) qs.set('offset',   String(params.offset))
      const suffix = qs.toString() ? `?${qs}` : ''
      return request<MarketplaceComponent[]>(`/marketplace${suffix}`)
    },

    /** Full component detail including node_spec and tool_def */
    get: (slug: string) =>
      request<MarketplaceComponentDetail>(`/marketplace/${encodeURIComponent(slug)}`),

    /** Publish a new component (auth required) */
    publish: (payload: {
      slug: string; name: string; description: string; category: string
      icon_emoji?: string; npm_ref: string; source?: string
      node_spec?: Record<string, unknown>; tool_def?: Record<string, unknown> | null
      tags?: string[]
    }) =>
      request<MarketplaceComponentDetail>('/marketplace', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    /** Install — records the install and returns node_spec + tool_def ready to drop on canvas */
    install: (slug: string) =>
      request<MarketplaceInstallResponse>(`/marketplace/${encodeURIComponent(slug)}/install`, {
        method: 'POST',
      }),
  },
}
