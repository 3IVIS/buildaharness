/**
 * URLs the user typed themselves. In `webBackend: 'proxy'` mode only these (plus URLs the proxy
 * returned from /web/search) may be turned into a fetch capability via /web/grant: the proxy's
 * signed-tag scheme exists so the model cannot fetch a URL it invented or lifted from untrusted
 * page text, and granting every URL the model asks for would void it.
 */
const MAX_REMEMBERED = 500
const userUrls = new Set<string>()

function normalize(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Records every http(s) URL found in a message the user typed. */
export function rememberUserUrls(text: string): void {
  for (const match of text.match(/https?:\/\/[^\s<>"'`)\]]+/gi) ?? []) {
    const normalized = normalize(match.replace(/[.,;:!?]+$/, ''))
    if (!normalized) continue
    if (userUrls.size >= MAX_REMEMBERED) userUrls.delete(userUrls.values().next().value as string)
    userUrls.add(normalized)
  }
}

export function isUserAuthoredUrl(url: string): boolean {
  const normalized = normalize(url)
  return normalized !== null && userUrls.has(normalized)
}

/** Test-only. */
export function resetUserUrls(): void {
  userUrls.clear()
}
