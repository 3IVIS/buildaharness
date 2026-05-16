/**
 * Typed API client for the itsharness adapter backend.
 * Reads VITE_API_URL (defaults to http://localhost:8000).
 */

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('itsharness:token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }))
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

export interface RunJobResponse {
  job_id:      string
  status:      'queued' | 'running' | 'done' | 'error'
  runtime:     string
  started_at:  string
  ended_at:    string | null
  result:      string | null
  error:       string | null
  node_events: Array<{
    node_id: string
    status:  'pending' | 'running' | 'done' | 'error'
    ts:      string
    ms:      number | null
  }>
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
    list: ()           => request<FlowSummary[]>('/flows'),
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
    start: (spec: unknown, runtime?: string) =>
      request<{ job_id: string; status: string; runtime: string }>(
        `/run${runtime ? `?runtime=${runtime}` : ''}`,
        { method: 'POST', body: JSON.stringify({ spec }) },
      ),

    status: (jobId: string) => request<RunJobResponse>(`/run/${jobId}`),
  },
}
