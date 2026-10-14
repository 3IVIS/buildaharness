/** A URL with any user:password, and every query-string value, masked, so a credential embedded in proxyUrl is never printed. Text that is not a URL is returned unchanged. */
export function redactUrlCredentials(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return text
  }
  if (!url.username && !url.password && !url.search) return text
  if (url.username) url.username = '***'
  if (url.password) url.password = '***'
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '***')
  return url.toString().split('%2A%2A%2A').join('***')
}
