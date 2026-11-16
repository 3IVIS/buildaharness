/**
 * Network port for mail code (section 5). Hosts supply it: the page's own `fetch` in the browser, a Rust-backed one on
 * desktop. All provider code takes a `NetworkPort` as a parameter and never calls `fetch` directly. No `node:*` and no
 * DOM imports: the types below are structural, so no DOM lib types are needed.
 */

export interface NetworkRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Optional cancellation signal (the Stop button). */
  signal?: { aborted: boolean }
}

export interface NetworkResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
}

export type NetworkPort = (request: NetworkRequest) => Promise<NetworkResponse>

/** The part of the standard `fetch` that `networkFromFetch` relies on. */
export type FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: never },
) => Promise<{ status: number; headers: { forEach(cb: (value: string, key: string) => void): void }; text(): Promise<string> }>

/** Wrap a `fetch`-shaped function (the browser's `fetch.bind(globalThis)`) as a `NetworkPort`. */
export function networkFromFetch(fetchFn: FetchLike): NetworkPort {
  return async (req) => {
    if (req.signal?.aborted) throw new Error('request aborted')
    const res = await fetchFn(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: req.signal as never,
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    return { status: res.status, headers, text: () => res.text() }
  }
}
